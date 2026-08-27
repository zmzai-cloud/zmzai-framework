import type { AgentTool } from "@earendil-works/pi-agent-core";
import { z } from "zod";

import type { ToolContext } from "../tools/context.js";
import type { AnyToolDef, ExternalToolDef, ToolDef } from "../tools/def.js";
import { isExternalToolDef } from "../tools/def.js";
import { trimFailureOutput } from "../tools/trim.js";

const maxOutputBytes = 48 * 1024;
/** 超限后保留头部 70% + 尾部 25% 预算（尾部常带报错/退出信息，
 *  硬截断会把它切掉）。借鉴 dsh compaction-tool-result-pruner：确定性、零 LLM 成本。 */
const headRatio = 0.7;
const tailRatio = 0.25;

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Completes only a structurally unfinished JSON object/array. We deliberately
 * refuse unterminated strings: guessing user-facing content or commands would
 * turn a transport fault into an unintended side effect. */
function closeJsonContainers(value: string): string | null {
  const text = value.trim();
  if (!text || (text[0] !== "{" && text[0] !== "[")) return null;
  const closers: string[] = [];
  let quoted = false;
  let escaped = false;
  for (const character of text) {
    if (quoted) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') quoted = false;
      continue;
    }
    if (character === '"') quoted = true;
    else if (character === "{") closers.push("}");
    else if (character === "[") closers.push("]");
    else if (character === "}" || character === "]") {
      if (closers.pop() !== character) return null;
    }
  }
  return quoted || escaped || closers.length === 0 ? null : text + closers.reverse().join("");
}

/** Repairs common OpenAI-compatible tool-argument transport defects without
 * inventing values: JSON encoded once/twice as a string, markdown fences, and
 * missing container closers after a stream cut. */
export function repairToolArguments(raw: unknown): unknown {
  if (isRecord(raw)) return raw;
  if (typeof raw !== "string") return raw;

  let candidate = raw.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const parsed: unknown = JSON.parse(candidate);
      if (isRecord(parsed)) return parsed;
      if (typeof parsed !== "string") return raw;
      candidate = parsed.trim();
      continue;
    } catch {
      const completed = closeJsonContainers(candidate);
      if (!completed) return raw;
      try {
        const parsed: unknown = JSON.parse(completed);
        return isRecord(parsed) ? parsed : raw;
      } catch {
        return raw;
      }
    }
  }
  return raw;
}

/** 按全文平均字节/字符估算预算字符数，再微调对齐——避免超长文本逐字符削的 O(n²)。 */
function byteFitHead(text: string, budgetBytes: number): string {
  const avg = Buffer.byteLength(text, "utf8") / Math.max(text.length, 1);
  let cut = text.slice(0, Math.floor(budgetBytes / avg));
  while (Buffer.byteLength(cut, "utf8") > budgetBytes) cut = cut.slice(0, -1);
  return cut;
}

/** 从头部削到字节预算内，保留文末（尾部窗口专用）。 */
function byteFitTail(text: string, budgetBytes: number): string {
  const avg = Buffer.byteLength(text, "utf8") / Math.max(text.length, 1);
  let cut = text.slice(-Math.floor(budgetBytes / avg));
  while (Buffer.byteLength(cut, "utf8") > budgetBytes) cut = cut.slice(1);
  return cut;
}

/** 超限时保留 head + tail，中间换成裁剪标记（带省略字节/行数）；
 *  按字节预算裁到字符边界，不会切碎多字节字符。 */
export function pruneOutput(text: string): { text: string; truncated: boolean; omittedBytes: number } {
  const bytes = Buffer.byteLength(text, "utf8");
  if (bytes <= maxOutputBytes) return { text, truncated: false, omittedBytes: 0 };
  const head = byteFitHead(text, Math.floor(maxOutputBytes * headRatio));
  const fittedTail = byteFitTail(text, Math.floor(maxOutputBytes * tailRatio));
  const tailStart = text.length - fittedTail.length;
  const tail = text.slice(Math.max(tailStart, head.length));
  const omitted = text.slice(head.length, Math.max(tailStart, head.length));
  const marker = `\n\n…[输出过长已裁剪：省略 ${Buffer.byteLength(omitted, "utf8")} 字节 / ${omitted.split("\n").length} 行，保留头尾]…\n\n`;
  return { text: head + marker + tail, truncated: true, omittedBytes: Buffer.byteLength(omitted, "utf8") };
}

/** Adapts a framework ToolDef into a PI AgentTool (spec §7.1):
 *  - zod parameters are bridged to JSON Schema (typebox-compatible) via
 *    zod's built-in toJSONSchema; args are re-validated with zod inside
 *    execute so friendly parse errors feed back to the model
 *  - output is truncated and the truncation recorded in details
 *  - thrown errors propagate (PI converts them to error tool results)
 *
 *  Permission checks are NOT done here — the runner evaluates
 *  `def.permission(args)` in beforeToolCall so every tool call passes the
 *  single choke point before execute() runs. */
export function adaptTool<TSchema extends z.ZodType>(def: ToolDef<TSchema>, ctx: ToolContext): AgentTool {
  const jsonSchema = z.toJSONSchema(def.parameters) as Record<string, unknown>;
  return {
    name: def.id,
    label: def.label,
    description: def.description,
    parameters: jsonSchema as never,
    ...(def.executionMode ? { executionMode: def.executionMode } : {}),
    prepareArguments: (rawParams) => repairToolArguments(rawParams) as never,
    async execute(toolCallId, rawParams) {
      const parsed = def.parameters.safeParse(repairToolArguments(rawParams));
      if (!parsed.success) {
        const issue = parsed.error.issues[0];
        throw new Error(`参数无效：${issue ? `${issue.path.join(".")} ${issue.message}` : "不符合 schema"}，请修正后重新调用`);
      }
      let result;
      try {
        result = await def.execute(parsed.data, { ...ctx, toolCallId });
      } catch (error) {
        // 失败日志按行剪裁（01-trim）：抛错消息超预算时只留错误行 + 上下文，
        // 模型看到的是错误现场而不是几千行 pass 噪音
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(message.length > 8_000 ? trimFailureOutput(message).text : message);
      }
      // 策略分流（01-trim）：failed 结果走失败日志剪裁，其余走 head+tail。
      // 两条链路的返回形状不同（trimmed/truncated），在这里归一化。
      const outcome = (result.metadata as Record<string, unknown> | undefined)?.outcome;
      const failedTrim = outcome === "failed" ? trimFailureOutput(result.output) : null;
      const pruned = failedTrim
        ? { text: failedTrim.text, truncated: failedTrim.trimmed, omittedBytes: failedTrim.omittedBytes }
        : pruneOutput(result.output);
      return {
        content: [{ type: "text" as const, text: pruned.text }],
        details: {
          title: result.title,
          ...(result.metadata ?? {}),
          ...(pruned.truncated ? { truncated: true, omittedBytes: pruned.omittedBytes } : {}),
        },
      };
    },
  };
}

/** External (JSON Schema) tools reuse the same prune/wrap pipeline; args pass
 *  through unvalidated — the remote tool owns its schema contract. */
export function adaptExternalTool(def: ExternalToolDef, ctx: ToolContext): AgentTool {
  return {
    name: def.id,
    label: def.label,
    description: def.description,
    parameters: structuredClone(def.parametersJsonSchema) as never,
    ...(def.executionMode ? { executionMode: def.executionMode } : {}),
    prepareArguments: (rawParams) => repairToolArguments(rawParams) as never,
    async execute(toolCallId, rawParams) {
      const args = repairToolArguments(rawParams);
      if (!isRecord(args)) throw new Error("参数无效：必须是 JSON 对象，请修正后重新调用");
      let result;
      try {
        result = await def.execute(args as Record<string, unknown>, { ...ctx, toolCallId });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(message.length > 8_000 ? trimFailureOutput(message).text : message);
      }
      const outcome = (result.metadata as Record<string, unknown> | undefined)?.outcome;
      const failedTrim = outcome === "failed" ? trimFailureOutput(result.output) : null;
      const pruned = failedTrim
        ? { text: failedTrim.text, truncated: failedTrim.trimmed, omittedBytes: failedTrim.omittedBytes }
        : pruneOutput(result.output);
      return {
        content: [{ type: "text" as const, text: pruned.text }],
        details: {
          title: result.title,
          ...(result.metadata ?? {}),
          ...(pruned.truncated ? { truncated: true, omittedBytes: pruned.omittedBytes } : {}),
        },
      };
    },
  };
}

/** Adapts either tool flavor into a PI AgentTool. */
export function adaptAnyTool(def: AnyToolDef, ctx: ToolContext): AgentTool {
  return isExternalToolDef(def) ? adaptExternalTool(def, ctx) : adaptTool(def, ctx);
}

/** Maps a tool call to its permission request — used by the runner's
 *  beforeToolCall hook. */
export function permissionForCall(defs: Map<string, AnyToolDef>, toolName: string, args: unknown) {
  const def = defs.get(toolName);
  if (!def) return null;
  if (isExternalToolDef(def)) {
    return isRecord(args) ? def.permission(args as Record<string, unknown>) : null;
  }
  const parsed = def.parameters.safeParse(args);
  if (!parsed.success) return null; // invalid args fail in execute() with a clear message
  return def.permission(parsed.data);
}

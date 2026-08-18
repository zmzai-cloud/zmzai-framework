import type { AgentTool } from "@earendil-works/pi-agent-core";
import { z } from "zod";

import type { ToolContext } from "../tools/context.js";
import type { ToolDef } from "../tools/def.js";

const maxOutputBytes = 48 * 1024;
/** 超限后保留头部 70% + 尾部 25% 预算（尾部常带报错/退出信息，
 *  硬截断会把它切掉）。借鉴 dsh compaction-tool-result-pruner：确定性、零 LLM 成本。 */
const headRatio = 0.7;
const tailRatio = 0.25;

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

/** @deprecated 兼容名，实现已换为 head+tail 裁剪。 */
export const truncateOutput = pruneOutput;

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
    async execute(toolCallId, rawParams) {
      const parsed = def.parameters.safeParse(rawParams);
      if (!parsed.success) {
        const issue = parsed.error.issues[0];
        throw new Error(`参数无效：${issue ? `${issue.path.join(".")} ${issue.message}` : "不符合 schema"}，请修正后重新调用`);
      }
      const result = await def.execute(parsed.data, ctx);
      const truncated = pruneOutput(result.output);
      return {
        content: [{ type: "text" as const, text: truncated.text }],
        details: {
          title: result.title,
          ...(result.metadata ?? {}),
          ...(truncated.truncated ? { truncated: true, omittedBytes: truncated.omittedBytes } : {}),
        },
      };
    },
  };
}

/** Maps a tool call to its permission request — used by the runner's
 *  beforeToolCall hook. */
export function permissionForCall(defs: Map<string, ToolDef>, toolName: string, args: unknown) {
  const def = defs.get(toolName);
  if (!def) return null;
  const parsed = def.parameters.safeParse(args);
  if (!parsed.success) return null; // invalid args fail in execute() with a clear message
  return def.permission(parsed.data);
}

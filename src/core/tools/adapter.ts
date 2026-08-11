import type { AgentTool } from "@earendil-works/pi-agent-core";
import { z } from "zod";

import type { ToolContext } from "../tools/context.js";
import type { ToolDef } from "../tools/def.js";

const maxOutputBytes = 48 * 1024;

function truncateOutput(text: string): { text: string; truncated: boolean; omittedBytes: number } {
  const bytes = Buffer.byteLength(text, "utf8");
  if (bytes <= maxOutputBytes) return { text, truncated: false, omittedBytes: 0 };
  let cut = text;
  while (Buffer.byteLength(cut, "utf8") > maxOutputBytes) cut = cut.slice(0, -1);
  return { text: cut, truncated: true, omittedBytes: bytes - Buffer.byteLength(cut, "utf8") };
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
    async execute(toolCallId, rawParams) {
      const parsed = def.parameters.safeParse(rawParams);
      if (!parsed.success) {
        const issue = parsed.error.issues[0];
        throw new Error(`参数无效：${issue ? `${issue.path.join(".")} ${issue.message}` : "不符合 schema"}，请修正后重新调用`);
      }
      const result = await def.execute(parsed.data, ctx);
      const truncated = truncateOutput(result.output);
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

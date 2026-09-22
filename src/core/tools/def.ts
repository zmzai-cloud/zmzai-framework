import type { z } from "zod";

import type { ToolContext } from "../tools/context.js";

/** W8 工具执行契约（spec §9.3 的声明子集）。
 *
 *  【声明 ≠ 执行】effect/retrySafety/concurrency 是工具作者的审计声明；
 *  W8 只落地声明本身与 toolCallId 去重。写权/资源 admission 的强制执行
 *  归 M2/M3（WorkspaceAccessCoordinator / ToolExecutor）——executionMode
 *  仍只是 PI 的调度偏好，不足以证明无副作用。缺失声明一律按保守语义
 *  处理（可能变更外部状态、不可安全重试）。 */
export type ToolEffect = "workspace" | "git" | "network" | "system";
export type RetrySafety = "read_only" | "idempotent_with_key" | "never";
export type ToolConcurrency = { mode: "parallel_read" | "workspace_exclusive" | "serialized"; key?: string };
export type ToolContract = {
  /** 副作用域（可多选）；空数组 = 显式声明无副作用。 */
  effect?: ToolEffect[];
  /** 重试安全性；缺失视为 never。 */
  retrySafety?: RetrySafety;
  /** 调度并发偏好（声明性）。 */
  concurrency?: ToolConcurrency;
};

/** Framework tool definition (spec §7.1). The permission mapping is
 *  declarative: the runner evaluates it in beforeToolCall (the single choke
 *  point, spec §5.4) before execute() ever runs. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type ToolDef<TSchema extends z.ZodType = z.ZodType<any>> = {
  id: string;
  label: string;
  description: string;
  parameters: TSchema;
  /** Maps validated args to the permission request. Return null to skip the
   *  permission check entirely (e.g. todo, which is always safe). */
  permission: (args: z.output<TSchema>) => { permission: string; patterns: string[]; always?: string[]; metadata?: unknown } | null;
  execute(args: z.output<TSchema>, ctx: ToolContext): Promise<{ title: string; output: string; metadata?: Record<string, unknown> }>;
  /** Sequential tools never run concurrently with other calls (PI executionMode). */
  executionMode?: "sequential" | "parallel";
  /** W8 执行契约（见 ToolContract）。 */
  contract?: ToolContract;
};

/** Tool whose parameters arrive as a ready-made JSON Schema (MCP tools, relay
 *  delivered tools) instead of a zod schema. Args are passed through as a
 *  plain record — validation is the remote tool's contract, permission
 *  mapping still runs through the same beforeToolCall choke point. */
export type ExternalToolDef = {
  id: string;
  label: string;
  description: string;
  parametersJsonSchema: Record<string, unknown>;
  permission: (args: Record<string, unknown>) => { permission: string; patterns: string[]; always?: string[]; metadata?: unknown } | null;
  execute(args: Record<string, unknown>, ctx: ToolContext): Promise<{ title: string; output: string; metadata?: Record<string, unknown> }>;
  executionMode?: "sequential" | "parallel";
  /** W8 执行契约（见 ToolContract）。外部工具未声明时按保守语义处理。 */
  contract?: ToolContract;
};

/** Union accepted by the runner's injected tool lists (deps.tools / deps.localTools / agent.tools). */
export type AnyToolDef = ToolDef | ExternalToolDef;

export function isExternalToolDef(def: AnyToolDef): def is ExternalToolDef {
  return "parametersJsonSchema" in def;
}

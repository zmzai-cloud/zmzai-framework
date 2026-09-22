import { z } from "zod";
import type { ToolDef } from "../tools/def.js";
import type { SubagentCoordinator } from "./coordinator.js";
import { isSubagentTerminal } from "./types.js";

/** agent_* 工具族（spec §8.1，M3-S20）：经 SubagentCoordinator 的持久协调，
 *  不在工具实现里另建调度器。ToolContext.subagents 由 runner 注入——
 *  宿主未启用（无 store.subagents）时五工具不可见（execute 抛
 *  SUBAGENTS_UNSUPPORTED），旧 task 工具保持兼容。
 *
 *  read_only 子代理的工具白名单在 spawn 侧（coordinator 依赖的
 *  createChildSession）实施——工具层不重复判定。 */

export type SubagentToolContext = { subagents?: { coordinator: SubagentCoordinator; rootTaskId: string; parentTaskId: string } };

const base = {
  contract: { effect: [], retrySafety: "idempotent_with_key" as const },
  executionMode: "sequential" as const,
};

function requireCoordinator(ctx: unknown): { coordinator: SubagentCoordinator; rootTaskId: string; parentTaskId: string } {
  const c = (ctx as SubagentToolContext).subagents;
  if (!c) throw new Error("SUBAGENTS_UNSUPPORTED：当前环境未启用子代理协调（store 缺 subagents 面）");
  return c;
}

export const agentSpawnTool: ToolDef = {
  ...base,
  id: "agent_spawn",
  label: "派出子代理",
  description:
    "派一个有界子目标给子代理立即返回 childId（不等待完成）。用 agent_wait 等待、agent_list 查看、agent_send 补充、agent_cancel 取消。子代理有自己的上下文与工具白名单（read_only 模式无写工具）。",
  parameters: z.object({
    description: z.string().min(3).max(120),
    prompt: z.string().min(1).max(16 * 1024),
    agent_type: z.string().min(1).max(64),
    mode: z.enum(["read_only", "workspace_write"]).default("read_only"),
    spawn_request_id: z.string().min(1).max(120).optional(),
  }),
  permission: (args) => ({ permission: "task", patterns: [args.agent_type], metadata: { subagent: args.agent_type, description: args.description, mode: args.mode } }),
  async execute(args, ctx) {
    const { coordinator, rootTaskId, parentTaskId } = requireCoordinator(ctx);
    const session = { id: (ctx as { sessionId: string }).sessionId } as never;
    const record = await coordinator.spawn(session, parentTaskId, rootTaskId, {
      description: args.description,
      prompt: args.prompt,
      subagentType: args.agent_type,
      mode: args.mode,
      ...(args.spawn_request_id ? { spawnRequestId: args.spawn_request_id } : {}),
    });
    return {
      title: `子代理 ${args.agent_type}：${args.description}`,
      output: `已派出（childId=${record.childId}，状态=${record.status}）。用 agent_wait 等待结果。`,
      metadata: { childId: record.childId, status: record.status, mode: args.mode },
    };
  },
};

export const agentListTool: ToolDef = {
  ...base,
  id: "agent_list",
  label: "子代理列表",
  description: "查看当前任务树内全部子代理的状态、目标、模式与最近进度。",
  parameters: z.object({}),
  permission: () => null,
  async execute(_args, ctx) {
    const { coordinator, rootTaskId } = requireCoordinator(ctx);
    const list = await coordinator.list(rootTaskId);
    if (list.length === 0) return { title: "子代理列表", output: "（无子代理）" };
    const lines = list.map((r) => `- ${r.childId} [${r.status}] ${r.agentType}(${r.mode})：${r.goal}${r.result ? ` → ${r.result.outcome}: ${r.result.summary.slice(0, 80)}` : ""}`);
    return { title: `子代理 ×${list.length}`, output: lines.join("\n"), metadata: { count: list.length } };
  },
};

export const agentSendTool: ToolDef = {
  ...base,
  id: "agent_send",
  label: "给子代理发消息",
  description: "向子代理幂等投递约束或补充信息（终态子代理返回 CHILD_TERMINAL，重新执行须显式 agent_spawn）。",
  parameters: z.object({
    child_id: z.string().min(1),
    message: z.string().min(1).max(16 * 1024),
    kind: z.enum(["constraint", "user_input"]).default("constraint"),
    message_id: z.string().min(1).max(120).optional(),
  }),
  permission: () => null,
  async execute(args, ctx) {
    const { coordinator } = requireCoordinator(ctx);
    const result = await coordinator.send(args.child_id, args.message, args.kind, args.message_id);
    if (!result.delivered) {
      return { title: "投递失败", output: `未投递：${result.reason}`, metadata: { delivered: false, reason: result.reason } };
    }
    return { title: "已投递", output: `消息已入 ${args.child_id} 的邮箱（kind=${args.kind}）`, metadata: { delivered: true } };
  },
};

export const agentWaitTool: ToolDef = {
  ...base,
  id: "agent_wait",
  label: "等待子代理",
  description: "等待子代理首个终态或需处理状态（最多 30 秒）。无变化返回仍在运行——继续做自己的工作，稍后再等；不要空转轮询。",
  parameters: z.object({
    child_ids: z.array(z.string().min(1)).min(1).max(16),
    timeout_seconds: z.number().int().min(1).max(30).default(30),
  }),
  permission: () => null,
  async execute(args, ctx) {
    const { coordinator } = requireCoordinator(ctx);
    const { changed, anyTerminal } = await coordinator.wait(args.child_ids, args.timeout_seconds * 1_000);
    const lines = changed.map((r) => `- ${r.childId}: ${r.status}${r.result ? `（${r.result.outcome}: ${r.result.summary.slice(0, 120)}）` : ""}`);
    return {
      title: anyTerminal ? "有终态" : "仍在运行",
      output: (anyTerminal ? "已有终态/需处理：\n" : "超时无变化（仍在运行，可继续自己的工作）：\n") + lines.join("\n"),
      metadata: { anyTerminal, statuses: changed.map((r) => ({ id: r.childId, status: r.status })) },
    };
  },
};

export const agentCancelTool: ToolDef = {
  ...base,
  id: "agent_cancel",
  label: "取消子代理",
  description: "幂等取消目标子代理及其后代。取消登记立即返回；完成停止通过状态确认（agent_list/agent_wait）。",
  parameters: z.object({ child_id: z.string().min(1) }),
  permission: () => null,
  async execute(args, ctx) {
    const { coordinator } = requireCoordinator(ctx);
    const result = await coordinator.cancel(args.child_id);
    const terminal = result.reason?.startsWith("CHILD_TERMINAL");
    return {
      title: terminal ? "已是终态" : "取消已登记",
      output: result.cancelling ? `取消已登记（${args.child_id}），停止经状态确认。` : `未取消：${result.reason}`,
      metadata: { cancelling: result.cancelling, reason: result.reason },
    };
  },
};

export const subagentTools: ToolDef[] = [agentSpawnTool, agentListTool, agentSendTool, agentWaitTool, agentCancelTool];

/** 旧 task 工具的兼容封装（spec §8.1：spawn+wait 保留原返回形态）。 */
export function makeLegacyTaskTool(coordinatorGetter: (ctx: unknown) => { coordinator: SubagentCoordinator; rootTaskId: string; parentTaskId: string } | undefined): ToolDef {
  return {
    id: "task",
    contract: { effect: ["workspace"], retrySafety: "never" },
    label: "派生子代理（同步）",
    description: "把一个独立子任务交给子代理并等待完成（旧接口；新代码用 agent_spawn + agent_wait）。串行等待行为保持兼容。",
    parameters: z.object({
      description: z.string().min(3).max(60),
      prompt: z.string().min(1).max(8 * 1024),
      subagent_type: z.string().min(1).max(64),
    }),
    permission: (args) => ({ permission: "task", patterns: [args.subagent_type], always: ["*"], metadata: { subagent: args.subagent_type, description: args.description } }),
    executionMode: "sequential",
    async execute(args, ctx) {
      const c = coordinatorGetter(ctx);
      if (!c) throw new Error("当前环境不支持子代理");
      const session = { id: (ctx as { sessionId: string }).sessionId } as never;
      const record = await c.coordinator.spawn(session, c.parentTaskId, c.rootTaskId, { description: args.description, prompt: args.prompt, subagentType: args.subagent_type });
      const { changed } = await c.coordinator.wait([record.childId], 120_000);
      const final = changed.find((r) => r.childId === record.childId) ?? record;
      const state = isSubagentTerminal(final.status) && final.status === "completed" ? "completed" : final.status === "cancelled" ? "error" : final.result?.outcome === "failed" || final.status === "failed" ? "error" : "completed";
      return {
        title: `子代理 ${args.subagent_type}：${args.description}`,
        output: final.result?.summary ?? `（状态 ${final.status}，无文本结果）`,
        metadata: { childSessionId: final.childId, subagent: args.subagent_type, state: state === "completed" ? "completed" : "error" },
      };
    },
  };
}

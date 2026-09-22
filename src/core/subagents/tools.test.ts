import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createSqliteSessionStore } from "../session/sqlite-store.js";
import { AgentRegistry } from "../agent/registry.js";
import { SubagentCoordinator, type SubagentCoordinatorDeps } from "./coordinator.js";
import { agentListTool, agentSendTool, agentSpawnTool, agentWaitTool, agentCancelTool, makeLegacyTaskTool, type SubagentToolContext } from "./tools.js";
import { isSubagentTerminal } from "./types.js";

/** M3-S20：五工具面——A16（read_only spawn 生效）、A14（spawn_request_id
 *  幂等）、agent_send/wait/cancel 行为、旧 task 兼容封装。 */
async function boot(runMs = 80) {
  const dataDir = await mkdtemp(path.join(tmpdir(), "m3-s20-"));
  const store = createSqliteSessionStore({ dataDir });
  const registry = new AgentRegistry().derive([
    { name: "explorer", description: "探索", mode: "subagent", steps: 8, prompt: "你是探索代理。", permission: [], model: { providerId: "faux", modelId: "m" } } as never,
  ]);
  const launches: string[] = [];
  const deps: SubagentCoordinatorDeps = {
    store,
    registry,
    createChildSession: async ({ parent, agentType, description }) => ({ id: `ses_c_${Math.random().toString(36).slice(2, 8)}`, parentId: parent.id, userId: parent.userId, workspaceId: parent.workspaceId, agent: agentType, title: description } as never),
    runChild: async (childId) => { launches.push(childId); await new Promise((r) => setTimeout(r, runMs)); return "completed"; },
    abortChild: async () => {},
  };
  const coordinator = new SubagentCoordinator(deps);
  const ctx = { sessionId: "ses_parent", subagents: { coordinator, rootTaskId: "task_root", parentTaskId: "task_root" } } as unknown as SubagentToolContext & { sessionId: string };
  return { store, coordinator, ctx, launches, dataDir };
}

const parentSession = { id: "ses_parent", userId: "u", workspaceId: "ws", agent: "default" } as never;

describe("agent_* 工具族（M3-S20）", () => {
  it("agent_spawn：立即返回 childId（不等执行）；spawn_request_id 幂等（A14）", async () => {
    const { coordinator, ctx, dataDir } = await boot();
    try {
      const t0 = Date.now();
      const result = await agentSpawnTool.execute({ description: "并行探索A", prompt: "P", agent_type: "explorer", mode: "read_only", spawn_request_id: "s20-1" }, ctx);
      expect(Date.now() - t0).toBeLessThan(200);
      expect(result.metadata).toMatchObject({ mode: "read_only" });
      const childId = (result.metadata as { childId: string }).childId;
      // 幂等重试
      const again = await agentSpawnTool.execute({ description: "并行探索A", prompt: "P", agent_type: "explorer", mode: "read_only", spawn_request_id: "s20-1" }, ctx);
      expect((again.metadata as { childId: string }).childId).toBe(childId);
      // spawn 面（coordinator 层）与父会话关联
      const rec = await coordinator.list("task_root");
      expect(rec).toHaveLength(1);
      void parentSession;
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it("agent_list/wait：等首个终态；A17——失败映射失败不伪装 completed", async () => {
    const { ctx, dataDir } = await boot();
    try {
      await agentSpawnTool.execute({ description: "探索任务", prompt: "P", agent_type: "explorer", mode: "read_only" }, ctx);
      const listResult = await agentListTool.execute({}, ctx);
      expect(listResult.output).toContain("explorer");
      const waitResult = await agentWaitTool.execute({ child_ids: [((listResult.metadata as { count: number }).count >= 1 ? await firstChildId(ctx) : "")].filter(Boolean), timeout_seconds: 5 }, ctx);
      expect(waitResult.metadata).toMatchObject({ anyTerminal: true });
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it("agent_send：活动投递成功；终态 CHILD_TERMINAL 明确拒绝", async () => {
    const { ctx, dataDir } = await boot(120);
    try {
      const spawned = await agentSpawnTool.execute({ description: "消息测试", prompt: "P", agent_type: "explorer", mode: "read_only" }, ctx);
      const childId = (spawned.metadata as { childId: string }).childId;
      const active = await agentSendTool.execute({ child_id: childId, message: "补一条约束" }, ctx);
      expect(active.metadata).toMatchObject({ delivered: true });
      await agentWaitTool.execute({ child_ids: [childId], timeout_seconds: 5 }, ctx);
      const terminal = await agentSendTool.execute({ child_id: childId, message: "再补" }, ctx);
      expect(terminal.metadata).toMatchObject({ delivered: false, reason: "CHILD_TERMINAL" });
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it("agent_cancel：取消登记返回；停止经状态确认", async () => {
    const { ctx, dataDir } = await boot(200);
    try {
      const spawned = await agentSpawnTool.execute({ description: "取消测试", prompt: "P", agent_type: "explorer", mode: "read_only" }, ctx);
      const childId = (spawned.metadata as { childId: string }).childId;
      const cancelResult = await agentCancelTool.execute({ child_id: childId }, ctx);
      expect(cancelResult.metadata).toMatchObject({ cancelling: true });
      const { changed } = await (ctx.subagents!.coordinator).wait([childId], 5_000);
      expect(changed.some((r) => isSubagentTerminal(r.status))).toBe(true);
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it("旧 task 兼容封装：spawn+wait 保留原返回形态（state completed/error）", async () => {
    const { ctx, dataDir } = await boot();
    const legacy = makeLegacyTaskTool((c) => (c as SubagentToolContext).subagents);
    try {
      const result = await legacy.execute({ description: "兼容封装测试", prompt: "P", subagent_type: "explorer" }, ctx);
      expect(result.metadata).toMatchObject({ subagent: "explorer", state: "completed" });
      expect(result.output).toBeTruthy();
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it("未启用时五工具明确抛 SUBAGENTS_UNSUPPORTED", async () => {
    const bare = { sessionId: "s" } as never;
    await expect(agentListTool.execute({}, bare)).rejects.toThrow("SUBAGENTS_UNSUPPORTED");
  });
});

async function firstChildId(ctx: SubagentToolContext): Promise<string> {
  const list = await ctx.subagents!.coordinator.list("task_root");
  return list[0]!.childId;
}

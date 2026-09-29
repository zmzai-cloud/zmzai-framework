import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createFauxCore, fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { createSqliteSessionStore } from "../core/session/sqlite-store.js";
import { AgentRegistry } from "../core/agent/registry.js";
import { createFrameworkSession, SessionRunner } from "../core/runtime/runner.js";
import { SubagentCoordinator } from "../core/subagents/coordinator.js";
import { subagentTools } from "../core/subagents/tools.js";
import { createMemoryEventLog } from "../core/events/bus.js";
import { createAgentRuntime } from "./create-agent-runtime.js";
import type { Part } from "../core/session/types.js";

/** T01→T02 / F01 复现与修复验收（production-chain-closure）。
 *
 *  缺陷链（spec 2026-09-28 §F01，T00 源码核对深化；T01 时以红测试钉住）：
 *  1. 宿主把 subagentCoordinator 传给 createAgentRuntime；
 *  2. createAgentRuntime 用条件 spread 把它并入 createServer({...}) 的入参——
 *     spread 不触发 TS 的 excess property 检查；
 *  3. FrameworkDeps 没有 subagentCoordinator 字段，createServer 构造
 *     SessionRunner 时静默丢弃；
 *  4. attempt-executor 的 this.deps.subagentCoordinator 恒 undefined →
 *     ctx.subagents 永不注入；
 *  5. agent_spawn 已注册（createAgentRuntime 在协调器存在时自动拼 subagentTools），
 *     模型调用 → requireCoordinator(ctx) 抛 SUBAGENTS_UNSUPPORTED。
 *
 *  T02 修复：FrameworkDeps 增加显式 subagentCoordinator 字段并透传给
 *  SessionRunner（消灭静默丢弃）；createAgentRuntime 改显式字段传递。本文件的
 *  生产装配用例翻绿（PC01：真实 createAgentRuntime 触发 agent_spawn，正常建立
 *  子会话，不注入替代协调器）；直连 SessionRunner 对照组保持不变（同一协调器
 *  经两条装配路径行为一致）。 */

function toolPartsOf(parts: Part[]): Part[] {
  return parts.filter((p) => p.type === "tool");
}

/** prompt() 是提交收据语义（异步经 workflow 驱动链推进），不等待运行完成；
 *  轮询直到出现 agent_spawn 工具 part 或超时。 */
type ToolPart = Extract<Part, { type: "tool" }>;
async function waitForSpawnPart(
  store: ReturnType<typeof createSqliteSessionStore>,
  sessionId: string,
  timeoutMs = 10_000,
): Promise<ToolPart[]> {
  const start = Date.now();
  for (;;) {
    const snapshot = await store.getMessageSnapshot!(sessionId, { limit: 50 });
    const spawnParts = toolPartsOf(snapshot.messages.flatMap((m) => m.parts)).filter((p): p is Extract<Part, { type: "tool" }> => p.type === "tool" && p.tool === "agent_spawn");
    // 工具 part 需落到终态（error/completed）才算可断言
    const settled = spawnParts.filter((p) => p.state.status === "error" || p.state.status === "completed");
    if (settled.length > 0) return settled;
    if (Date.now() - start > timeoutMs) return spawnParts;
    await new Promise((r) => setTimeout(r, 50));
  }
}

describe("T02/PC01：subagentCoordinator 经 createAgentRuntime→createServer 抵达 runner", () => {
  it("生产装配路径：agent_spawn 正常建立子会话（协调器不再被 createServer 边界丢弃）", async () => {
    const dataDir = await mkdtemp(path.join(tmpdir(), "t02-pc01-"));
    try {
      const store = createSqliteSessionStore({ dataDir });
      const launches: string[] = [];
      const coordinator = new SubagentCoordinator({
        store,
        createChildSession: async ({ parent, agentType, description }) =>
          createFrameworkSession({ store, userId: parent.userId, workspaceId: parent.workspaceId, agent: agentType, model: { providerId: "faux", modelId: "test-model" }, prompt: description, parentId: parent.id, title: description }),
        runChild: async (childId) => { launches.push(childId); return { state: "completed", summary: "子代理结论" }; },
        abortChild: async () => {},
      });
      const faux = createFauxCore({ models: [{ id: "test-model" }] });
      faux.setResponses([
        fauxAssistantMessage([fauxToolCall("agent_spawn", { description: "并行探索A", prompt: "P", agent_type: "explore", mode: "read_only" })]),
        fauxAssistantMessage("已派出子代理"),
      ]);
      // 生产装配路径：与 Lectern lib/runtime.ts 相同的 createAgentRuntime 调用形态
      const runtime = createAgentRuntime({
        store,
        workspace: { kind: "fs", root: dataDir },
        runnerOptions: {
          streamFnFor: () => faux.streamSimple as never,
          modelFor: () => faux.getModel() as never,
        },
        subagentCoordinator: coordinator,
        capabilities: { subagents: 1 },
      });
      // 修复直接证据：协调器抵达 runner（deps 显式字段，不再静默丢弃）
      expect((runtime.runner as unknown as { deps: { subagentCoordinator?: unknown } }).deps.subagentCoordinator).toBe(coordinator);
      const session = await createFrameworkSession({
        store,
        userId: "u",
        workspaceId: "ws",
        model: { providerId: "faux", modelId: "test-model" },
        prompt: "派一个子代理去探索",
        // 预盖 task 权限：本用例考的是装配链路，不是权限门
        permission: [{ permission: "task", pattern: "*", action: "allow" }],
      });
      await runtime.runner.prompt(session.id, { requestId: "req_pc01", text: "派一个子代理去探索" });

      const spawnParts = await waitForSpawnPart(store, session.id);
      expect(spawnParts).toHaveLength(1);
      expect(spawnParts[0]!.state.status).toBe("completed");
      // 子会话经协调器登记（真实 SubagentRecord，非替代协调器）并真正执行
      const records = await store.subagents!.listSubagents({ parentSessionId: session.id });
      expect(records).toHaveLength(1);
      expect(records[0]!.agentType).toBe("explore");
      expect(records[0]!.childSessionId).not.toBe(session.id);
      expect(launches).toHaveLength(1);
      const childSession = await store.getSession(records[0]!.childSessionId);
      expect(childSession?.parentId).toBe(session.id);
      expect(childSession?.userId).toBe("u");
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it("对照：同一协调器直连 SessionRunner 时 agent_spawn 成功（两条装配路径行为一致）", async () => {
    const dataDir = await mkdtemp(path.join(tmpdir(), "t02-pc01-ctrl-"));
    try {
      const store = createSqliteSessionStore({ dataDir });
      const registry = new AgentRegistry().derive([
        { name: "explorer", description: "探索", mode: "subagent", steps: 8, prompt: "你是探索代理。", permission: [], model: { providerId: "faux", modelId: "test-model" } } as never,
      ]);
      const launches: string[] = [];
      const coordinator = new SubagentCoordinator({
        store,
        registry,
        // T02 后父身份由协调器从 store 解析（工具层只传 { id }），
        // 工厂拿到的是完整父会话——不再需要常量身份兜底。
        createChildSession: async ({ parent, agentType, description }) =>
          createFrameworkSession({ store, userId: parent.userId, workspaceId: parent.workspaceId, agent: agentType, model: { providerId: "faux", modelId: "test-model" }, prompt: description, parentId: parent.id, title: description }),
        runChild: async (childId) => { launches.push(childId); return { state: "completed", summary: "子代理结论" }; },
        abortChild: async () => {},
      });
      const faux = createFauxCore({ models: [{ id: "test-model" }] });
      faux.setResponses([
        fauxAssistantMessage([fauxToolCall("agent_spawn", { description: "并行探索A", prompt: "P", agent_type: "explorer", mode: "read_only" })]),
        fauxAssistantMessage("已派出"),
      ]);
      const eventLog = createMemoryEventLog();
      const runner = new SessionRunner({
        store,
        registry,
        eventLog,
        streamFnFor: () => faux.streamSimple as never,
        modelFor: () => faux.getModel() as never,
        workspaceFor: () => ({
          list: async () => [],
          read: async () => null,
          write: async () => ({ revisionId: "r", diff: "" }),
          edit: async () => ({ revisionId: "r", diff: "" }),
        }),
        sandbox: { buildSnapshot: async () => ({ revisionId: null, files: [] }), run: async () => ({ ok: true, exitCode: 0, outputText: "", durationMs: 1, artifacts: [] }) },
        localTools: [...subagentTools],
        subagentDepth: 1,
        subagentCoordinator: coordinator,
      });
      const session = await createFrameworkSession({
        store,
        userId: "u",
        workspaceId: "ws",
        model: { providerId: "faux", modelId: "test-model" },
        prompt: "派一个子代理去探索",
        permission: [{ permission: "task", pattern: "*", action: "allow" }],
      });
      await runner.prompt(session.id, { requestId: "req_f01_ctrl", text: "派一个子代理去探索" });

      const spawnParts = await waitForSpawnPart(store, session.id);
      expect(spawnParts).toHaveLength(1);
      const state = spawnParts[0]!.state;
      expect(state.status).toBe("completed");
      // 子代理经协调器登记并真正执行
      const records = await store.subagents!.listSubagents({ parentSessionId: session.id });
      expect(records).toHaveLength(1);
      expect(records[0]!.agentType).toBe("explorer");
      expect(launches).toHaveLength(1);
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  });
});

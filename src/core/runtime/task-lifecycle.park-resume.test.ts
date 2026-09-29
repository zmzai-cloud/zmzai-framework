import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createSqliteSessionStore } from "../session/sqlite-store.js";
import { createSqliteEventLog } from "../events/sqlite-event-log.js";
import { createFauxCore } from "@earendil-works/pi-ai/providers/faux";
import { AgentRegistry } from "../agent/registry.js";
import { SessionRunner, createFrameworkSession } from "../runtime/runner.js";
import { TaskLifecycle, type RunOutcome } from "../runtime/task-lifecycle.js";
import { SubagentCoordinator, type ChildRunOutcome, type SubagentCoordinatorDeps } from "../subagents/coordinator.js";

/** T05（production-chain-closure）：父生命周期 park/唤醒/续跑/交付闭环
 *  （PC05）与结果验收服务（PC08/§9.4）。
 *
 *  链路：Attempt 1（模型派生子代理 + 自称完成）→ Completion Gate 因必要子代理
 *  未收尾拒绝交付 → park（running + parkedReason=children，不烧轮次）→
 *  子终态（同事务结算 + 结果邮件）→ 唤醒 → 续跑 drain 邮箱（结果并入
 *  advisory，不落用户消息）→ Attempt 2 交付。 */

function settledOutcome(): RunOutcome {
  return {
    state: "completed", settled: true, aborted: false, unknownSideEffect: false, sideEffectDetail: null,
    filesEdited: [], toolCalls: 1, durationMs: 10, toolErrors: [], finalText: "已完成并核对。",
    todos: null, taskBlock: null, delivery: null, evidenceCandidates: [], errorMessage: null,
  };
}

function registryWith(): AgentRegistry {
  return new AgentRegistry().derive([
    { name: "explorer", description: "探索", mode: "subagent", steps: 8, prompt: "你是探索代理。", permission: [], model: { providerId: "faux", modelId: "m" } } as never,
  ]);
}

describe("T05/PC05：父 park → 子终态 → 唤醒 → 续跑 drain → 交付", () => {
  it("全链：park 不交付不烧轮次；子终态唤醒后续跑注入子结果（无用户消息）并交付", async () => {
    const dataDir = await mkdtemp(path.join(tmpdir(), "t05-pc05-"));
    try {
      const store = createSqliteSessionStore({ dataDir });
      const session = await createFrameworkSession({ store, userId: "u", workspaceId: "ws", model: { providerId: "faux", modelId: "m" }, prompt: "根任务" });
      let task = await store.task!.createTask({
        sessionId: session.id, rootRequestId: "req_pc05", rootUserMessageId: "m0", goal: "汇总探索结果",
        acceptanceCriteria: [{ id: "crit_1", description: "拿到探索结论", required: true, status: "passed", evidenceIds: ["evd_1"] }],
        steps: [{ id: "step_1", title: "派生并汇总", status: "completed", order: 0, evidenceIds: ["evd_1"] }],
      });
      task = await store.task!.updateTask(task.id, task.revision, {
        evidence: [{ id: "evd_1", kind: "model_observation", summary: "子代理结果已核对", createdAt: new Date().toISOString() }],
        result: { outcome: "探索结论已汇总", changes: [], verification: ["子结果核对"], remaining: [] },
      });

      // 协调器：子 run 由测试脚本驱动（首轮挂起等待测试放行）
      let releaseChild: (() => void) | null = null;
      const childGate = new Promise<void>((resolve) => { releaseChild = resolve; });
      const wakeRequests: string[] = [];
      const deps: SubagentCoordinatorDeps = {
        store,
        registry: registryWith(),
        createChildSession: async ({ parent, agentType, description, spawnRequestId }) => ({
          id: `ses_sub_${spawnRequestId.slice(-8)}`, parentId: parent.id, userId: parent.userId, workspaceId: parent.workspaceId, agent: agentType, title: description,
        } as never),
        runChild: async (): Promise<ChildRunOutcome> => {
          await childGate;
          return { state: "completed", summary: "探索完成：A→B 依赖链" };
        },
        abortChild: async () => {},
        onChildTerminal: (_child, parentSessionId) => wakeRequests.push(parentSessionId),
      };
      const coordinator = new SubagentCoordinator(deps);

      // Attempt 记录：第 1 轮模拟「模型派生子代理并自称完成」；第 2 轮收尾
      const attemptContexts: (string | undefined)[] = [];
      let attempt = 0;
      const lifecycle = new TaskLifecycle({
        store,
        publish: async () => {},
        attemptRunner: async (_session, _input, _userId, taskContext) => {
          attempt += 1;
          attemptContexts.push(taskContext?.advisory);
          if (attempt === 1) {
            // 模型在第一轮调 agent_spawn（经协调器登记子代理）
            await coordinator.spawn({ id: session.id }, task.id, task.rootRequestId, {
              description: "探索依赖链", prompt: "P", subagentType: "explorer", mode: "read_only", spawnRequestId: "pc05-spawn-1",
            });
          }
          return settledOutcome();
        },
      });

      // 第 1 轮：交付被拒（子代理 running）→ park
      const first = await lifecycle.runTask(session, { requestId: "req_pc05", text: "开始" });
      expect(first).toBe("running");
      let parked = await store.task!.getTask(task.id);
      expect(parked!.status).toBe("running");
      expect((parked as unknown as { parkedReason?: string }).parkedReason).toBe("children");
      expect(parked!.attemptCount).toBe(1);
      const messagesBefore = await store.getMessages(session.id);

      // 子代理终态：settleSubagent（终态+结果邮件同事务）+ 唤醒登记
      releaseChild!();
      await new Promise((resolve) => setTimeout(resolve, 200));
      const children = await coordinator.list(task.rootRequestId);
      expect(children).toHaveLength(1);
      expect(children[0]!.status).toBe("completed");
      expect(wakeRequests).toEqual([session.id]);

      // 唤醒 → driveResumedTask 等价物：resume 续跑
      const resumed = await lifecycle.runTask(session, { requestId: "req_pc05", text: "", taskId: task.id, resume: true });
      expect(resumed).toBe("completed");
      const final = await store.task!.getTask(task.id);
      expect(final!.status).toBe("delivered");

      // 续跑轮的 advisory 注入了子结果（系统指令，不落用户消息）
      expect(attempt).toBe(2);
      expect(attemptContexts[1]).toContain("子代理结果");
      expect(attemptContexts[1]).toContain("探索完成：A→B 依赖链");
      const messagesAfter = await store.getMessages(session.id);
      expect(messagesAfter.length).toBe(messagesBefore.length); // 无伪用户消息
      // 水位已推进：结果邮件标记 consumedByParent
      const mailbox = await store.subagents!.listMessages(children[0]!.childId);
      expect(mailbox.every((m) => m.consumedByParent !== false || m.direction === "to_child")).toBe(true);
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  }, 15_000);
});

describe("T05/PC09：根取消——先落终态截止 admission，再递归收尾任务树；子终态不复活", () => {
  it("runner.abort：任务 cancelled + 活跃子 abort 落 cancelled + 排队子出队 cancelled；取消后子终态唤醒不复活", async () => {
    const dataDir = await mkdtemp(path.join(tmpdir(), "t05-pc09-"));
    try {
      const store = createSqliteSessionStore({ dataDir });
      const eventLog = createSqliteEventLog({ dataDir });
      const session = await createFrameworkSession({ store, userId: "u", workspaceId: "ws", model: { providerId: "faux", modelId: "m" }, prompt: "根任务" });
      const task = await store.task!.createTask({ sessionId: session.id, rootRequestId: "req_pc09", rootUserMessageId: "m0", goal: "G" });

      // 活跃子挂门：abort 释放并落 cancelled
      let releaseChild: ((outcome: ChildRunOutcome) => void) | null = null;
      const childGate = new Promise<ChildRunOutcome>((resolve) => { releaseChild = resolve; });
      const wakeRequests: string[] = [];
      const deps: SubagentCoordinatorDeps = {
        store,
        registry: registryWith(),
        createChildSession: async ({ parent, agentType, description, spawnRequestId }) => ({
          id: `ses_sub_${spawnRequestId.slice(-8)}`, parentId: parent.id, userId: parent.userId, workspaceId: parent.workspaceId, agent: agentType, title: description,
        } as never),
        runChild: async () => childGate,
        abortChild: async () => { releaseChild?.({ state: "cancelled", summary: "根任务已取消" }); },
        limits: { perRoot: 1, global: 1 }, // 第二个子保持排队
        onChildTerminal: (_child, parentSessionId) => wakeRequests.push(parentSessionId),
      };
      const coordinator = new SubagentCoordinator(deps);
      const faux = createFauxCore({ models: [{ id: "m" }] });
      const runner = new SessionRunner({
        store,
        registry: registryWith(),
        eventLog,
        streamFnFor: () => faux.streamSimple as never,
        modelFor: () => faux.getModel() as never,
        workspaceFor: () => ({ list: async () => [], read: async () => null, write: async () => ({ revisionId: "r", diff: "" }), edit: async () => ({ revisionId: "r", diff: "" }) }),
        sandbox: { buildSnapshot: async () => ({ revisionId: null, files: [] }), run: async () => ({ ok: true, exitCode: 0, outputText: "", durationMs: 1, artifacts: [] }) },
        subagentDepth: 1,
        subagentCoordinator: coordinator,
      });

      // 活跃子 + 排队子
      const active = await coordinator.spawn({ id: session.id }, task.id, task.rootRequestId, { description: "执行中", prompt: "P1", subagentType: "explorer", spawnRequestId: "pc09-a" });
      const queued = await coordinator.spawn({ id: session.id }, task.id, task.rootRequestId, { description: "排队中", prompt: "P2", subagentType: "explorer", spawnRequestId: "pc09-q" });
      await new Promise((resolve) => setTimeout(resolve, 150)); // 第一个进入 running
      expect((await store.subagents!.getSubagent(active.childId))!.status).toBe("running");

      // 根取消：任务先落 cancelled（admission 截止），再递归收尾子代理
      await runner.abort(session.id);
      const cancelledTask = await store.task!.getTask(task.id);
      expect(cancelledTask!.status).toBe("cancelled");
      await new Promise((resolve) => setTimeout(resolve, 200));
      expect((await store.subagents!.getSubagent(active.childId))!.status).toBe("cancelled");
      expect((await store.subagents!.getSubagent(queued.childId))!.status).toBe("cancelled");
      // 子终态触发了唤醒登记，但任务已终态——不复活（attemptCount 不变）
      expect(wakeRequests).toEqual([session.id]);
      const after = await store.task!.getTask(task.id);
      expect(after!.status).toBe("cancelled");
      expect(after!.attemptCount).toBe(cancelledTask!.attemptCount);
      // 排队子没有被 pump 再启动（无孤儿执行者）
      const messages = await store.subagents!.listMessages(queued.childId);
      expect(messages.filter((m) => m.direction === "to_parent")).toHaveLength(0);
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  }, 15_000);
});

describe("T05/PC08：结果验收服务（消费 ≠ 接受；返工替代解阻塞）", () => {
  async function bootWithTerminalChild() {
    const dataDir = await mkdtemp(path.join(tmpdir(), "t05-pc08-"));
    const store = createSqliteSessionStore({ dataDir });
    const session = await createFrameworkSession({ store, userId: "u", workspaceId: "ws", model: { providerId: "faux", modelId: "m" } });
    const task = await store.task!.createTask({ sessionId: session.id, rootRequestId: "req_pc08", rootUserMessageId: "m0", goal: "G" });
    const deps: SubagentCoordinatorDeps = {
      store,
      registry: registryWith(),
      createChildSession: async ({ parent, agentType, description, spawnRequestId }) => ({
        id: `ses_sub_${spawnRequestId.slice(-8)}`, parentId: parent.id, userId: parent.userId, workspaceId: parent.workspaceId, agent: agentType, title: description,
      } as never),
      runChild: async () => ({ state: "completed", summary: "初版结论" }),
      abortChild: async () => {},
    };
    const coordinator = new SubagentCoordinator(deps);
    const child = await coordinator.spawn({ id: session.id }, task.id, task.rootRequestId, {
      description: "探索", prompt: "P", subagentType: "explorer", spawnRequestId: "pc08-a",
    });
    // 等终态 + 结果邮件落库
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
      const rec = await store.subagents!.getSubagent(child.childId);
      if (rec?.status === "completed") break;
      await new Promise((r) => setTimeout(r, 30));
    }
    // 父消费结果（推水位）
    const messages = await store.subagents!.listMessages(child.childId);
    await store.subagents!.markMessagesConsumedByParent(child.childId, new Date().toISOString());
    void messages;
    return { store, session, task, coordinator, child, dataDir };
  }

  it("reviewChild：accepted 落 consumeState+review（绑定子结果版本）；非终态拒绝验收", async () => {
    const ctx = await bootWithTerminalChild();
    try {
      const accepted = await ctx.coordinator.reviewChild(ctx.child.childId, "accepted", { note: "结论与文件核对一致" }, { rootTaskId: ctx.task.rootRequestId });
      expect(accepted.consumeState).toBe("accepted");
      expect(accepted.review).toMatchObject({ decision: "accepted", note: "结论与文件核对一致", childRevision: expect.any(Number) });
      // 非终态拒绝：再派一个 queued 子直接验收
      const queued = await ctx.coordinator.spawn({ id: ctx.session.id }, ctx.task.id, ctx.task.rootRequestId, {
        description: "排队中", prompt: "P", subagentType: "explorer", spawnRequestId: "pc08-q",
      });
      await expect(ctx.coordinator.reviewChild(queued.childId, "accepted", {}, { rootTaskId: ctx.task.rootRequestId })).rejects.toThrow("尚未终态");
      // 树外验收拒绝
      await expect(ctx.coordinator.reviewChild(ctx.child.childId, "accepted", {}, { rootTaskId: "other_root" })).rejects.toThrow("SCOPE_VIOLATION");
    } finally {
      await rm(ctx.dataDir, { recursive: true, force: true });
    }
  });

  it("needs_revision 阻塞交付；返工 spawn（replacesChildId）终态且消费后解除", async () => {
    const ctx = await bootWithTerminalChild();
    try {
      await ctx.coordinator.reviewChild(ctx.child.childId, "needs_revision", { note: "漏了 B 分支" }, { rootTaskId: ctx.task.rootRequestId });
      // 门禁：needs_revision 未替代 → pending
      const lifecycle = new TaskLifecycle({ store: ctx.store, publish: async () => {}, attemptRunner: async () => settledOutcome() });
      let task = await ctx.store.task!.getTask(ctx.task.id);
      await ctx.store.task!.updateTask(task!.id, task!.revision, {
        acceptanceCriteria: [{ id: "crit_1", description: "覆盖全部分支", required: true, status: "passed", evidenceIds: ["evd_1"] }],
        evidence: [{ id: "evd_1", kind: "model_observation", summary: "核对", createdAt: new Date().toISOString() }],
        result: { outcome: "完成", changes: [], verification: [], remaining: [] },
      });
      task = await ctx.store.task!.getTask(ctx.task.id);
      const blocked = await lifecycle.runTask(ctx.session, { requestId: "req_pc08", text: "开始", taskId: task!.id });
      expect(blocked).toBe("running"); // 仍 park（needs_revision 待替代）

      // 返工：显式 spawn 替代 + 终态 + 父消费
      const replacement = await ctx.coordinator.spawn({ id: ctx.session.id }, task!.id, task!.rootRequestId, {
        description: "补 B 分支", prompt: "P2", subagentType: "explorer", spawnRequestId: "pc08-b", replacesChildId: ctx.child.childId,
      });
      const deadline = Date.now() + 5_000;
      while (Date.now() < deadline) {
        const rec = await ctx.store.subagents!.getSubagent(replacement.childId);
        if (rec?.status === "completed") break;
        await new Promise((r) => setTimeout(r, 30));
      }
      await ctx.store.subagents!.markMessagesConsumedByParent(replacement.childId, new Date().toISOString());
      expect(replacement.replacesChildId).toBe(ctx.child.childId);

      // 替代完成且消费 → 交付可达
      const done = await lifecycle.runTask(ctx.session, { requestId: "req_pc08", text: "", taskId: task!.id, resume: true });
      expect(done).toBe("completed");
      const final = await ctx.store.task!.getTask(task!.id);
      expect(final!.status).toBe("delivered");
    } finally {
      await rm(ctx.dataDir, { recursive: true, force: true });
    }
  }, 15_000);
});

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createSqliteSessionStore } from "../session/sqlite-store.js";
import { createFrameworkSession } from "../runtime/runner.js";
import { TaskLifecycle, type RunOutcome } from "../runtime/task-lifecycle.js";
import type { SubagentRecord } from "../subagents/types.js";

/** T01→T05 / F03 复现与修复验收（production-chain-closure）。
 *
 *  缺陷（spec 2026-09-28 §F03，源码 task-lifecycle.ts:224）：completionStateOf
 *  把 subagentPending 硬编码为 null——Completion Gate 的子代理门禁（M3-S22）
 *  在真实运行链路上永远不生效：根 Task 下挂 running 子代理时照样 delivered。
 *
 *  T05 修复：completionStateOf 查询真实子记录（subagentPendingOf），并真正
 *  接线 park——必要子代理未收尾时根 Task 保持 running + parkedReason=children
 *  （调度状态），交付被 Completion Gate 拒绝。本文件三条用例：
 *  ① running 子代理 → park 不交付（翻转原缺陷断言）；
 *  ② 终态且结果已消费 → 交付可达（完成条件可被满足，不是只会拒绝）；
 *  ③ 终态但结果未消费（drain 水位未推进）→ 仍 park。 */

function settledOutcome(): RunOutcome {
  return {
    state: "completed",
    settled: true,
    aborted: false,
    unknownSideEffect: false,
    sideEffectDetail: null,
    filesEdited: [],
    toolCalls: 1,
    durationMs: 10,
    toolErrors: [],
    finalText: "已按验收条件完成并核对。",
    todos: null,
    taskBlock: null,
    delivery: null,
    evidenceCandidates: [],
    errorMessage: null,
  };
}

async function boot() {
  const dataDir = await mkdtemp(path.join(tmpdir(), "t05-f03-"));
  const store = createSqliteSessionStore({ dataDir });
  const session = await createFrameworkSession({
    store, userId: "u", workspaceId: "ws", model: { providerId: "faux", modelId: "m" }, prompt: "根任务",
  });
  let task = await store.task!.createTask({
    sessionId: session.id,
    rootRequestId: "req_f03",
    rootUserMessageId: "msg_f03",
    goal: "把 PDF 内容铺到网页",
    acceptanceCriteria: [{ id: "crit_1", description: "网页能展示 PDF 全部内容", required: true, status: "passed", evidenceIds: ["evd_1"] }],
    steps: [{ id: "step_1", title: "铺内容", status: "completed", order: 0, evidenceIds: ["evd_1"] }],
  });
  task = await store.task!.updateTask(task.id, task.revision, {
    evidence: [{ id: "evd_1", kind: "model_observation", summary: "浏览器打开确认内容齐全", createdAt: new Date().toISOString() }],
    result: { outcome: "PDF 内容已铺到网页", changes: ["index.html"], verification: ["浏览器打开核对"], remaining: [] },
  });
  return { store, session, task, dataDir };
}

function childRecord(task: { id: string; rootRequestId: string }, sessionId: string, status: SubagentRecord["status"]): SubagentRecord {
  // 与 coordinator.spawn 的落库形状一致：rootTaskId = activeTask.rootRequestId ?? id
  return {
    childId: "ses_child_f03",
    childSessionId: "ses_child_f03",
    parentSessionId: sessionId,
    rootTaskId: task.rootRequestId,
    parentTaskId: task.id,
    spawnRequestId: "sr_f03_1",
    agentType: "explorer",
    goal: "核对 PDF 页数",
    mode: "read_only",
    workspaceId: "ws",
    status,
    revision: 1,
    traceId: "trace_f03_1",
    times: { spawnedAt: new Date().toISOString() },
  };
}

describe("T05/F03：必要子代理的交付门禁（真实子记录查询 + park）", () => {
  it("running 子代理 → 交付被拒，根 Task park（running + parkedReason=children），不空转轮次", async () => {
    const ctx = await boot();
    try {
      await ctx.store.subagents!.createSubagent(childRecord(ctx.task, ctx.session.id, "running"));
      const attempts: number[] = [];
      const lifecycle = new TaskLifecycle({
        store: ctx.store,
        publish: async () => {},
        attemptRunner: async (_session, input) => { attempts.push((input as { continuation?: { attempt: number } }).continuation?.attempt ?? 1); return settledOutcome(); },
      });
      const state = await lifecycle.runTask(ctx.session, { requestId: "req_f03", text: "开始" });

      // ---- T05 修复后的期望行为（原缺陷断言 delivered 已翻转）----
      expect(state).toBe("running");
      const final = await ctx.store.task!.getTask(ctx.task.id);
      expect(final!.status).toBe("running");
      expect((final as unknown as { parkedReason?: string }).parkedReason).toBe("children");
      expect(final!.attemptCount).toBe(1); // park 而不是继续烧轮次
      const childAfter = await ctx.store.subagents!.getSubagent("ses_child_f03");
      expect(childAfter!.status).toBe("running");
    } finally {
      await rm(ctx.dataDir, { recursive: true, force: true });
    }
  });

  it("终态且结果已被父消费（drain 水位推进）→ 交付可达", async () => {
    const ctx = await boot();
    try {
      const child = await ctx.store.subagents!.createSubagent(childRecord(ctx.task, ctx.session.id, "completed"));
      // 终态结算的结果邮件已被父消费（markMessagesConsumedByParent 已推进）
      await ctx.store.subagents!.appendMessage({
        messageId: "result_ses_child_f03_2", childId: child.childId, direction: "to_parent", kind: "result",
        payload: JSON.stringify({ outcome: "completed", summary: "页数核对完成", childId: child.childId }),
        createdAt: new Date().toISOString(),
      });
      await ctx.store.subagents!.markMessagesConsumedByParent(child.childId, new Date().toISOString());
      const lifecycle = new TaskLifecycle({ store: ctx.store, publish: async () => {}, attemptRunner: async () => settledOutcome() });
      const state = await lifecycle.runTask(ctx.session, { requestId: "req_f03", text: "开始" });
      expect(state).toBe("completed");
      const final = await ctx.store.task!.getTask(ctx.task.id);
      expect(final!.status).toBe("delivered");
    } finally {
      await rm(ctx.dataDir, { recursive: true, force: true });
    }
  });

  it("终态但结果未消费（邮箱水位未推进）→ 仍 park，不许无视子结果交付", async () => {
    const ctx = await boot();
    try {
      await ctx.store.subagents!.createSubagent(childRecord(ctx.task, ctx.session.id, "completed"));
      // 结果邮件存在但 consumedByParent 未推进
      await ctx.store.subagents!.appendMessage({
        messageId: "result_ses_child_f03_2", childId: "ses_child_f03", direction: "to_parent", kind: "result",
        payload: JSON.stringify({ outcome: "completed", summary: "页数核对完成", childId: "ses_child_f03" }),
        createdAt: new Date().toISOString(),
      });
      const lifecycle = new TaskLifecycle({ store: ctx.store, publish: async () => {}, attemptRunner: async () => settledOutcome() });
      const state = await lifecycle.runTask(ctx.session, { requestId: "req_f03", text: "开始" });
      expect(state).toBe("running");
      const final = await ctx.store.task!.getTask(ctx.task.id);
      expect(final!.status).toBe("running");
      expect((final as unknown as { parkedReason?: string }).parkedReason).toBe("children");
    } finally {
      await rm(ctx.dataDir, { recursive: true, force: true });
    }
  });
});

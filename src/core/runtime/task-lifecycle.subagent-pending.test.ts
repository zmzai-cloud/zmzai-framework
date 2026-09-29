import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createSqliteSessionStore } from "../session/sqlite-store.js";
import { createFrameworkSession } from "../runtime/runner.js";
import { TaskLifecycle, type RunOutcome } from "../runtime/task-lifecycle.js";
import type { SubagentRecord } from "../subagents/types.js";

/** T01 / F03 复现（production-chain-closure）。
 *
 *  缺陷（spec 2026-09-28 §F03，源码 task-lifecycle.ts:224）：
 *  completionStateOf 把 subagentPending 硬编码为 null——Completion Gate 的
 *  M3-S22 子代理门禁（A36，「必要子结果已被接受才可交付；消费 ≠ 接受」）
 *  在真实运行链路上永远不生效。根 Task 下挂着 running 状态的必要子代理时，
 *  交付判定照样放行 delivered。
 *
 *  本用例驱动**真实** TaskLifecycle.runTask（真实 sqlite store + 真实 CAS +
 *  真实 evaluateTaskCompletion），attemptRunner 返回一次「一切就绪」的收尾
 *  Attempt：步骤全完成、required 条件 passed 且证据齐、显式交付声明在案。
 *  唯一的异常事实是：任务树下有一个 running 的子代理记录。
 *
 *  【断言语义】当前断言 delivered 即**复现缺陷**（不是期望行为）。T05 修复
 *  （completionStateOf 查询真实子记录）后，本用例翻转为 expect continue /
 *  blocked，并在 T06 升级为全链路验收。 */

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

describe("T01/F03：subagentPending 恒 null——必要子代理未收尾时任务照样交付", () => {
  it("真实交付路径：running 子代理 + 全条件通过 → 当前缺陷行为 delivered", async () => {
    const dataDir = await mkdtemp(path.join(tmpdir(), "t01-f03-"));
    try {
      const store = createSqliteSessionStore({ dataDir });
      const session = await createFrameworkSession({
        store,
        userId: "u",
        workspaceId: "ws",
        model: { providerId: "faux", modelId: "m" },
        prompt: "根任务",
      });

      // 根任务契约：一条 required 条件、已 passed、证据在案、交付声明在案
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

      // 任务树下挂一个 running 的必要子代理（与 coordinator.spawn 落库形状一致）
      const child: SubagentRecord = {
        childId: "ses_child_f03",
        childSessionId: "ses_child_f03",
        parentSessionId: session.id,
        rootTaskId: task.id,
        parentTaskId: task.id,
        spawnRequestId: "sr_f03_1",
        agentType: "explorer",
        goal: "核对 PDF 页数",
        mode: "read_only",
        workspaceId: "ws",
        status: "running",
        revision: 1,
        traceId: "trace_f03_1",
        times: { spawnedAt: new Date().toISOString() },
      };
      await store.subagents!.createSubagent(child);

      // 真实生命周期驱动：attemptRunner 给出「一切就绪」的收尾 Attempt
      const lifecycle = new TaskLifecycle({
        store,
        publish: async () => {},
        attemptRunner: async () => settledOutcome(),
      });
      const state = await lifecycle.runTask(session, { requestId: "req_f03", text: "开始" });

      const final = await store.task!.getTask(task.id);
      // ---- F03 复现断言（缺陷行为）----
      // Completion Gate 条件 7（M3-S22）本应给出：
      //   reasons = [「子代理未收尾或结果未通过验证：ses_child_f03」] → continue
      // 但 completionStateOf 的 subagentPending 恒 null → delivered 放行。
      expect(state).toBe("completed");
      expect(final!.status).toBe("delivered");
      // 子代理事实仍在 running（没有任何东西等它）
      const childAfter = await store.subagents!.getSubagent("ses_child_f03");
      expect(childAfter!.status).toBe("running");
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  });
});

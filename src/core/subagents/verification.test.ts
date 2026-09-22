import { describe, expect, it } from "vitest";
import { evaluateTaskCompletion } from "../task/completion.js";
import { newSubagentRecord } from "./types.js";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createSqliteSessionStore } from "../session/sqlite-store.js";

/** M3-S22：父验证门禁——A36（子自称成功但父未验证 → 拒绝交付）+ consumeState。 */
function baseState() {
  return {
    attemptSettled: true,
    fatalError: null,
    lastError: null,
    unknownSideEffect: null,
    pendingPermissions: 0,
    unsafeReplay: null,
    subagentPending: null,
    budgetExhausted: null,
    externalAuthRequired: null,
    inputRequired: null,
    choiceRequired: null,
    unresolvedToolErrors: [],
    finalTextPresent: true,
    cancelled: false,
  };
}

function taskWith(overrides: Record<string, unknown>) {
  return {
    id: "task_t", sessionId: "ses_s", status: "running", revision: 1,
    rootRequestId: "r", rootUserMessageId: "m", goal: "目标",
    steps: [], evidence: [], acceptanceCriteria: [], constraints: [],
    attemptCount: 1, noProgressCount: 0, createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z",
    result: { outcome: "completed" as const, changes: [], verification: ["v"], remaining: [] },
    ...overrides,
  } as never;
}

describe("父验证门禁（M3-S22 / A36）", () => {
  it("subagentPending 非空 → 不交付（消费 ≠ 接受），无子代理字段时零影响", () => {
    const clean = evaluateTaskCompletion(taskWith({}), baseState());
    expect(clean.status).toBe("delivered");

    const gated = evaluateTaskCompletion(taskWith({}), { ...baseState(), subagentPending: ["child_1（结果 pending_review）"] });
    expect(gated.status).not.toBe("delivered");
    if (gated.status === "continue") expect(gated.reason).toContain("子代理未收尾或结果未通过验证");
  });

  it("SubagentRecord consumeState 流转：pending_review → accepted（CAS）；终态子代理的状态面", async () => {
    const dataDir = await mkdtemp(path.join(tmpdir(), "m3-s22-"));
    const store = createSqliteSessionStore({ dataDir });
    try {
      const rec = await store.subagents!.createSubagent(newSubagentRecord({ childSessionId: "ses_ca", parentSessionId: "ses_p", rootTaskId: "task_r", parentTaskId: "task_r", spawnRequestId: "rq", agentType: "explorer", goal: "验证A", mode: "read_only", workspaceId: "ws", traceId: "t" }));
      const run = await store.subagents!.updateSubagent(rec.childId, rec.revision, { status: "running" });
      const done = await store.subagents!.updateSubagent(run.childId, run.revision, { status: "completed", result: { outcome: "completed", summary: "子任务完成" } });
      // 父验证：pending_review → accepted（consumeState 是 record 上的 CAS 字段）
      const accepted = await store.subagents!.updateSubagent(done.childId, done.revision, { consumeState: "accepted" });
      expect(accepted.consumeState).toBe("accepted");
      // rejected 同理（不复活子代理——状态仍 completed）
      const rej = await store.subagents!.createSubagent(newSubagentRecord({ childSessionId: "ses_cb", parentSessionId: "ses_p", rootTaskId: "task_r", parentTaskId: "task_r", spawnRequestId: "rq2", agentType: "explorer", goal: "验证B", mode: "read_only", workspaceId: "ws", traceId: "t" }));
      const rejected = await store.subagents!.updateSubagent(rej.childId, rej.revision, { consumeState: "rejected" });
      expect(rejected.consumeState).toBe("rejected");
      expect(rejected.status).toBe("queued"); // 验证状态不改变执行状态
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  });
});

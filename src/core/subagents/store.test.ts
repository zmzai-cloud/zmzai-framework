import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createSqliteSessionStore } from "../session/sqlite-store.js";
import { assertSubagentTransition, isSubagentTerminal, newSubagentRecord } from "./types.js";

/** M3-S17：SubagentRecord 双表——spawn 幂等、CAS 冲突、非法迁移拒绝、mailbox 去重。 */
function seed(overrides: Partial<Parameters<typeof newSubagentRecord>[0]> = {}) {
  return newSubagentRecord({
    childSessionId: "ses_child_1",
    parentSessionId: "ses_parent",
    rootTaskId: "task_root",
    parentTaskId: "task_root",
    spawnRequestId: "req_spawn_1",
    agentType: "explorer",
    goal: "并行探索",
    mode: "read_only",
    workspaceId: "ws_1",
    traceId: "trace_1",
    ...overrides,
  });
}

async function store() {
  const dataDir = await mkdtemp(path.join(tmpdir(), "m3-s17-"));
  return { store: createSqliteSessionStore({ dataDir }), dataDir };
}

describe("SubagentStore（M3-S17）", () => {
  it("spawn 幂等：同 parentSession+spawnRequestId 返回同一 child（A14）", async () => {
    const { store: s, dataDir } = await store();
    try {
      const first = await s.subagents!.createSubagent(seed());
      const again = await s.subagents!.createSubagent(seed({ childSessionId: "ses_child_other" }));
      expect(again.childId).toBe(first.childId);
      expect((await s.subagents!.findSubagentBySpawnRequest("ses_parent", "req_spawn_1"))!.childId).toBe(first.childId);
      // 不同 parent 同 requestId = 独立命令
      const other = await s.subagents!.createSubagent(seed({ parentSessionId: "ses_p2", childSessionId: "ses_c2" }));
      expect(other.childId).toBe("ses_c2");
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it("CAS：revision 不符抛 SUBAGENT_REVISION_CONFLICT", async () => {
    const { store: s, dataDir } = await store();
    try {
      const rec = await s.subagents!.createSubagent(seed());
      await s.subagents!.updateSubagent(rec.childId, rec.revision, { status: "running" });
      // 旧 revision 再写 → 冲突
      await expect(s.subagents!.updateSubagent(rec.childId, rec.revision, { status: "waiting_input" })).rejects.toThrow("SUBAGENT_REVISION_CONFLICT");
      const now = await s.subagents!.getSubagent(rec.childId);
      expect(now!.status).toBe("running");
      expect(now!.revision).toBe(2);
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it("状态机：终态不可迁移（completed→running 拒绝）；合法路径放行", async () => {
    const { store: s, dataDir } = await store();
    try {
      const rec = await s.subagents!.createSubagent(seed());
      const run = await s.subagents!.updateSubagent(rec.childId, rec.revision, { status: "running" });
      const done = await s.subagents!.updateSubagent(run.childId, run.revision, { status: "completed", result: { outcome: "completed", summary: "ok" } });
      await expect(s.subagents!.updateSubagent(done.childId, done.revision, { status: "running" })).rejects.toThrow("SUBAGENT_INVALID_TRANSITION");
      // 纯函数面
      expect(() => assertSubagentTransition("failed", "running")).toThrow();
      expect(() => assertSubagentTransition("queued", "running")).not.toThrow();
      expect(isSubagentTerminal("completed")).toBe(true);
      expect(isSubagentTerminal("blocked")).toBe(false);
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it("mailbox：messageId 去重（重复投递 no-op）；父水位标记幂等", async () => {
    const { store: s, dataDir } = await store();
    try {
      const rec = await s.subagents!.createSubagent(seed());
      const msg = { messageId: "msg_1", childId: rec.childId, direction: "to_child" as const, kind: "constraint" as const, payload: "补一条约束", createdAt: "2026-09-22T10:00:00Z" };
      await s.subagents!.appendMessage(msg);
      await s.subagents!.appendMessage({ ...msg, payload: "重复投递应被忽略" });
      const list = await s.subagents!.listMessages(rec.childId);
      expect(list).toHaveLength(1);
      expect(list[0]!.payload).toBe("补一条约束");
      // 水位标记：consumedByParent 置位；重复标记幂等
      await s.subagents!.markMessagesConsumedByParent(rec.childId, "2026-09-22T10:00:00Z");
      await s.subagents!.markMessagesConsumedByParent(rec.childId, "2026-09-22T10:00:00Z");
      expect((await s.subagents!.listMessages(rec.childId))[0]!.consumedByParent).toBe(true);
      // sinceCreatedAt 过滤
      await s.subagents!.appendMessage({ ...msg, messageId: "msg_2", createdAt: "2026-09-22T11:00:00Z" });
      expect(await s.subagents!.listMessages(rec.childId, { sinceCreatedAt: "2026-09-22T10:00:00Z" })).toHaveLength(1);
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  });
});

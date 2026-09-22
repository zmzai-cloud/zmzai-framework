import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createSqliteSessionStore } from "../session/sqlite-store.js";
import { newSubagentRecord } from "./types.js";
import { canAutoResume, drainParentMailbox, onChildTerminal, shouldPark, parkParent, type ParkControllerDeps } from "./parked.js";

/** M3-S19：parked/mailbox/父唤醒——A28（父先停→子完成→自动续跑唤醒恰一次）、
 *  A29（终态父不复活/结果不重复追加）。 */
async function boot() {
  const dataDir = await mkdtemp(path.join(tmpdir(), "m3-s19-"));
  const store = createSqliteSessionStore({ dataDir });
  // 根会话 + 根任务（TaskRecord 走真实 store）
  const session = await (await import("../runtime/runner.js")).createFrameworkSession({
    store, userId: "u", workspaceId: "ws", model: { providerId: "faux", modelId: "m" }, prompt: "S19 根",
  });
  const task = await store.task!.createTask({ sessionId: session.id, rootRequestId: "req_s19", rootUserMessageId: "m0", goal: "S19 根任务" });
  const resumeCalls: string[] = [];
  const deps: ParkControllerDeps = {
    subagents: store.subagents!,
    casTask: (taskId, rev, patch) => store.task!.updateTask(taskId, rev, patch as never),
    getTask: (taskId) => store.task!.getTask(taskId) as never,
    requestInternalResume: (sid) => resumeCalls.push(sid),
  };
  return { store, session, task, deps, resumeCalls, dataDir };
}

describe("parked/mailbox/父唤醒（M3-S19）", () => {
  it("A28：父先停（parked）→ 子随后完成 → 唤醒登记；drain 结果仅纳入一次", async () => {
    const { store, session, task, deps, resumeCalls, dataDir } = await boot();
    try {
      // 两个子代理：一个终态一个运行中 → 应 park
      const c1 = await store.subagents!.createSubagent(newSubagentRecord({ childSessionId: "ses_c1", parentSessionId: session.id, rootTaskId: task.id, parentTaskId: task.id, spawnRequestId: "r1", agentType: "explorer", goal: "探索A", mode: "read_only", workspaceId: "ws", traceId: "t" }));
      const c2 = await store.subagents!.createSubagent(newSubagentRecord({ childSessionId: "ses_c2", parentSessionId: session.id, rootTaskId: task.id, parentTaskId: task.id, spawnRequestId: "r2", agentType: "explorer", goal: "探索B", mode: "read_only", workspaceId: "ws", traceId: "t" }));
      expect(await shouldPark(deps, task.id)).toBe(true);

      // park 父：先置 running（真实时序里 runner 认领时已置位），park 后保持
      await store.task!.updateTask(task.id, task.revision, { status: "running" });
      await parkParent(deps, task.id);
      const parked = await store.task!.getTask(task.id);
      expect(parked!.status).toBe("running");
      expect((parked as unknown as { parkedReason?: string }).parkedReason).toBe("children");

      // 子 1 完成 → 结果入邮箱 + 唤醒意图（幂等：Set 语义，重复 add 合并）
      const running = await store.subagents!.updateSubagent(c1.childId, c1.revision, { status: "running" });
      const done = await store.subagents!.updateSubagent(running.childId, running.revision, { status: "completed", result: { outcome: "completed", summary: "探索A完成" } });
      await onChildTerminal(deps, done, session.id);
      await onChildTerminal(deps, done, session.id); // 重放（崩溃后）——同 messageId 不重复
      expect(resumeCalls.length).toBeGreaterThanOrEqual(1);

      // 父唤醒 drain：结果恰一份
      const first = await drainParentMailbox(deps, task.id);
      expect(first.results).toHaveLength(1);
      expect(first.results[0]!.summary).toBe("探索A完成");
      expect(first.clearedPark).toBe(false); // c2 仍 running

      // 再次 drain：已消费不再追加
      const again = await drainParentMailbox(deps, task.id);
      expect(again.results).toHaveLength(0);

      // 子 2 也终态 → 下次 drain 清 parked
      const r2 = await store.subagents!.updateSubagent(c2.childId, c2.revision, { status: "running" });
      await store.subagents!.updateSubagent(r2.childId, r2.revision, { status: "completed", result: { outcome: "completed", summary: "探索B完成" } });
      const done2 = await store.subagents!.getSubagent(c2.childId);
      await onChildTerminal(deps, done2!, session.id);
      const final = await drainParentMailbox(deps, task.id);
      expect(final.results).toHaveLength(1); // 只有 B 的新结果
      expect(final.clearedPark).toBe(true);
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it("A29：终态/等待态父拒绝自动唤醒；取消与迟到子结果不复活", async () => {
    expect(canAutoResume("running")).toBe(true);
    expect(canAutoResume("delivered")).toBe(false);
    expect(canAutoResume("cancelled")).toBe(false);
    expect(canAutoResume("failed")).toBe(false);
    expect(canAutoResume("waiting_input")).toBe(false);
  });

  it("全部终态时不应 park（无 pending 子代理）", async () => {
    const { store, session, task, deps, dataDir } = await boot();
    try {
      const c = await store.subagents!.createSubagent(newSubagentRecord({ childSessionId: "ses_c3", parentSessionId: session.id, rootTaskId: task.id, parentTaskId: task.id, spawnRequestId: "r3", agentType: "explorer", goal: "探索C", mode: "read_only", workspaceId: "ws", traceId: "t" }));
      const running = await store.subagents!.updateSubagent(c.childId, c.revision, { status: "running" });
      await store.subagents!.updateSubagent(running.childId, running.revision, { status: "completed", result: { outcome: "completed", summary: "done" } });
      expect(await shouldPark(deps, task.id)).toBe(false);
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  });
});

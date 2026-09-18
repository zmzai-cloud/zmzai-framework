import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { createSqliteSessionStore } from "./sqlite-store.js";
import { applyTaskPatch, createMemoryTaskStore, TASK_REVISION_CONFLICT, type TaskStore } from "../task/store.js";
import type { CreateTaskInput, TaskRecord } from "../task/types.js";

/** TaskStore 契约测试：内存实现与 SQLite 实现跑**同一份断言**。
 *
 *  这不是重复劳动。两者的差异恰恰在契约最要紧的地方——CAS 在内存里靠
 *  对象比较、在 SQLite 里靠 `UPDATE ... WHERE revision=?`；「同 session 一个
 *  活跃任务」在内存里是遍历、在库里是 WHERE 子句。只测其中一个，另一个的
 *  边界行为就没人知道。 */

const baseInput = (sessionId: string, requestId: string, goal = "把 PDF 内容铺到网页"): CreateTaskInput => ({
  sessionId,
  rootRequestId: requestId,
  rootUserMessageId: `msg_${requestId}`,
  goal,
});

function contract(name: string, setup: () => Promise<{ store: TaskStore; cleanup?: () => Promise<void> }>): void {
  describe(`${name} task store contract`, () => {
    const cleanups: Array<() => Promise<void>> = [];
    afterEach(async () => {
      while (cleanups.length) await cleanups.pop()!();
    });
    const open = async (): Promise<TaskStore> => {
      const { store, cleanup } = await setup();
      if (cleanup) cleanups.push(cleanup);
      return store;
    };

    it("创建任务：queued 起步，带一条隐式验收条件", async () => {
      const store = await open();
      const task = await store.createTask(baseInput("ses_1", "req_1"));
      expect(task.status).toBe("queued");
      expect(task.revision).toBe(1);
      expect(task.goal).toBe("把 PDF 内容铺到网页");
      expect(task.acceptanceCriteria).toHaveLength(1);
      expect(task.acceptanceCriteria[0]!.required).toBe(true);
      expect(task.steps).toEqual([]);
      expect(task.attemptCount).toBe(0);
    });

    // §13.1 / §17.1.11：重复 requestId 不创建第二个任务
    it("同一 requestId 重复创建返回同一个任务", async () => {
      const store = await open();
      const first = await store.createTask(baseInput("ses_1", "req_dup"));
      const second = await store.createTask(baseInput("ses_1", "req_dup"));
      expect(second.id).toBe(first.id);
      expect(second.revision).toBe(first.revision);
      expect(await store.listTasks("ses_1")).toHaveLength(1);
    });

    // §18.9：同 session 不会有两个 active root task 并发改工作区
    it("同 session 已有活跃任务时拒绝创建第二个", async () => {
      const store = await open();
      await store.createTask(baseInput("ses_1", "req_a"));
      await expect(store.createTask(baseInput("ses_1", "req_b"))).rejects.toThrow("TASK_ALREADY_ACTIVE");
    });

    it("前一个任务进入终态后允许开新任务", async () => {
      const store = await open();
      const first = await store.createTask(baseInput("ses_1", "req_a"));
      await store.updateTask(first.id, first.revision, { status: "delivered" });
      const second = await store.createTask(baseInput("ses_1", "req_b"));
      expect(second.id).not.toBe(first.id);
    });

    it("不同 session 之间互不影响", async () => {
      const store = await open();
      await store.createTask(baseInput("ses_1", "req_a"));
      const other = await store.createTask(baseInput("ses_2", "req_b"));
      expect(await store.getActiveTask("ses_1")).not.toBeNull();
      expect(await store.getActiveTask("ses_2")).toMatchObject({ id: other.id });
    });

    // §6：CAS 防止两个 runner 同时推进同一任务
    it("revision 不匹配时拒绝更新", async () => {
      const store = await open();
      const task = await store.createTask(baseInput("ses_1", "req_a"));
      await store.updateTask(task.id, task.revision, { status: "running" });
      await expect(store.updateTask(task.id, task.revision, { status: "verifying" })).rejects.toThrow(TASK_REVISION_CONFLICT);
    });

    it("成功更新后 revision 递增，且返回新记录", async () => {
      const store = await open();
      const task = await store.createTask(baseInput("ses_1", "req_a"));
      const updated = await store.updateTask(task.id, task.revision, { status: "running", attemptCount: 1 });
      expect(updated.revision).toBe(task.revision + 1);
      expect(updated.status).toBe("running");
      expect(updated.attemptCount).toBe(1);
      expect(await store.getTask(task.id)).toMatchObject({ revision: updated.revision, status: "running" });
    });

    it("更新不存在的任务报错", async () => {
      const store = await open();
      await expect(store.updateTask("task_missing", 1, { status: "running" })).rejects.toThrow("TASK_NOT_FOUND");
    });

    it("getActiveTask 在终态后返回 null，getLatestTask 接手", async () => {
      const store = await open();
      const task = await store.createTask(baseInput("ses_1", "req_a"));
      await store.updateTask(task.id, task.revision, { status: "delivered", deliveredAt: new Date().toISOString() });
      expect(await store.getActiveTask("ses_1")).toBeNull();
      expect(await store.getLatestTask("ses_1")).toMatchObject({ id: task.id, status: "delivered" });
    });

    it("blocked / waiting_* 仍算活跃任务（它还没结束）", async () => {
      const store = await open();
      const task = await store.createTask(baseInput("ses_1", "req_a"));
      await store.updateTask(task.id, task.revision, {
        status: "waiting_permission",
        blocker: { kind: "permission", message: "等待授权", requiredAction: "处理卡片", resumable: true },
      });
      expect(await store.getActiveTask("ses_1")).toMatchObject({ id: task.id });
      expect((await store.getActiveTask("ses_1"))!.blocker!.kind).toBe("permission");
    });

    it("findTaskByRequestId 能查到历史任务", async () => {
      const store = await open();
      const task = await store.createTask(baseInput("ses_1", "req_lookup"));
      expect(await store.findTaskByRequestId("ses_1", "req_lookup")).toMatchObject({ id: task.id });
      expect(await store.findTaskByRequestId("ses_1", "req_other")).toBeNull();
    });

    it("listTasks 按创建顺序返回全部任务", async () => {
      const store = await open();
      const first = await store.createTask(baseInput("ses_1", "req_a"));
      await store.updateTask(first.id, first.revision, { status: "failed" });
      const second = await store.createTask(baseInput("ses_1", "req_b"));
      const tasks = await store.listTasks("ses_1");
      expect(tasks.map((task) => task.id)).toEqual([first.id, second.id]);
    });

    it("返回的是副本：调用方改动不会污染 store 内部状态", async () => {
      const store = await open();
      const task = await store.createTask(baseInput("ses_1", "req_a"));
      task.constraints.push("外部改的");
      const reloaded = await store.getTask(task.id);
      expect(reloaded!.constraints).toEqual([]);
    });
  });
}

contract("memory", async () => ({ store: createMemoryTaskStore() }));

const sqliteDirs: string[] = [];
contract("sqlite", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "fw-task-"));
  sqliteDirs.push(dir);
  const store = createSqliteSessionStore({ dataDir: dir });
  return {
    store: store.task!,
    cleanup: async () => {
      await rm(dir, { recursive: true, force: true });
    },
  };
});

describe("sqlite task store 持久化", () => {
  let dir = "";
  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
    dir = "";
  });

  // §13.4：迁移必须支持已有数据库启动，不删历史
  it("重开数据库后任务仍在（含步骤与证据）", async () => {
    dir = await mkdtemp(path.join(tmpdir(), "fw-task-persist-"));
    const first = createSqliteSessionStore({ dataDir: dir });
    const task = await first.task!.createTask(baseInput("ses_1", "req_a"));
    await first.task!.updateTask(task.id, task.revision, {
      status: "running",
      steps: [{ id: "step_1", title: "解析 PDF", status: "completed", order: 0, evidenceIds: ["evd_1"] }],
      evidence: [{ id: "evd_1", kind: "command", summary: "pnpm build 通过", createdAt: new Date().toISOString() }],
    });

    const reopened = createSqliteSessionStore({ dataDir: dir });
    const loaded = await reopened.task!.getTask(task.id);
    expect(loaded).toMatchObject({ status: "running", goal: "把 PDF 内容铺到网页" });
    expect(loaded!.steps).toHaveLength(1);
    expect(loaded!.evidence[0]!.summary).toBe("pnpm build 通过");
  });

  it("旧数据库（无 tasks 表）能直接启动并建表", async () => {
    dir = await mkdtemp(path.join(tmpdir(), "fw-task-legacy-"));
    // 先建一个只有 sessions 表的「老」库
    const { DatabaseSync } = await import("node:sqlite");
    const legacy = new DatabaseSync(path.join(dir, "zmzai.db"));
    legacy.exec("CREATE TABLE sessions (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, workspace_id TEXT NOT NULL, updated TEXT NOT NULL, json TEXT NOT NULL)");
    legacy.close();

    const store = createSqliteSessionStore({ dataDir: dir });
    const task = await store.task!.createTask(baseInput("ses_1", "req_a"));
    expect(task.status).toBe("queued");
  });

  it("并发 CAS：后到者失败而不是覆盖", async () => {
    dir = await mkdtemp(path.join(tmpdir(), "fw-task-cas-"));
    const store = createSqliteSessionStore({ dataDir: dir });
    const task = await store.task!.createTask(baseInput("ses_1", "req_a"));
    const [a, b] = await Promise.allSettled([
      store.task!.updateTask(task.id, task.revision, { status: "running" }),
      store.task!.updateTask(task.id, task.revision, { status: "verifying" }),
    ]);
    const fulfilled = [a, b].filter((result) => result.status === "fulfilled");
    expect(fulfilled).toHaveLength(1);
    const finalRevision = (await store.task!.getTask(task.id))!.revision;
    expect(finalRevision).toBe(task.revision + 1);
  });

  it("删除会话时级联删除任务", async () => {
    dir = await mkdtemp(path.join(tmpdir(), "fw-task-cascade-"));
    const store = createSqliteSessionStore({ dataDir: dir });
    await store.createSession({
      id: "ses_1", workspaceId: "ws", userId: "u", title: "t", agent: "default",
      model: { providerId: "p", modelId: "m" }, permission: [], queuedPrompts: [],
      time: { created: new Date().toISOString(), updated: new Date().toISOString() },
    });
    const task = await store.task!.createTask(baseInput("ses_1", "req_a"));
    await store.deleteSession!("ses_1");
    expect(await store.task!.getTask(task.id)).toBeNull();
  });

  it("会话快照带出当前任务（规格 §13.3 断线重连恢复任务进度）", async () => {
    dir = await mkdtemp(path.join(tmpdir(), "fw-task-snapshot-"));
    const store = createSqliteSessionStore({ dataDir: dir });
    await store.createSession({
      id: "ses_1", workspaceId: "ws", userId: "u", title: "t", agent: "default",
      model: { providerId: "p", modelId: "m" }, permission: [], queuedPrompts: [],
      time: { created: new Date().toISOString(), updated: new Date().toISOString() },
    });
    const task = await store.task!.createTask(baseInput("ses_1", "req_a"));
    await store.task!.updateTask(task.id, task.revision, { status: "running" });
    const snapshot = await store.getMessageSnapshot!("ses_1", { limit: 20 });
    expect(snapshot.task).toMatchObject({ id: task.id, status: "running" });
  });
});

describe("applyTaskPatch", () => {
  const base: TaskRecord = {
    id: "task_1", sessionId: "ses_1", rootRequestId: "req_1", rootUserMessageId: "msg_1",
    goal: "目标", status: "running", acceptanceCriteria: [], steps: [], evidence: [],
    revision: 4, attemptCount: 1, noProgressCount: 0, constraints: [],
    createdAt: "2026-09-18T00:00:00.000Z", updatedAt: "2026-09-18T00:00:00.000Z",
  };

  it("递增 revision 并刷新 updatedAt，但不许改身份字段", () => {
    // 身份字段不在 TaskPatch 类型里；这里刻意绕过类型塞进去，验证运行时也挡得住
    const forged = { goal: "新目标", id: "task_hacked", sessionId: "ses_hacked" };
    const next = applyTaskPatch(base, forged, "2026-09-18T01:00:00.000Z");
    expect(next.id).toBe("task_1");
    expect(next.sessionId).toBe("ses_1");
    expect(next.goal).toBe("新目标");
    expect(next.revision).toBe(5);
    expect(next.updatedAt).toBe("2026-09-18T01:00:00.000Z");
    expect(next.createdAt).toBe(base.createdAt);
  });

  it("显式传 undefined 清掉 blocker，而不是留下一个空字段", () => {
    const withBlocker: TaskRecord = { ...base, blocker: { kind: "permission", message: "等授权", requiredAction: "处理卡片", resumable: true } };
    const cleared = applyTaskPatch(withBlocker, { blocker: undefined }, "2026-09-18T01:00:00.000Z");
    expect("blocker" in cleared).toBe(false);
  });
});

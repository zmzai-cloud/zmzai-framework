import { describe, expect, it, vi } from "vitest";

import { createMemoryEventLog } from "../events/bus.js";
import type { Part, ToolState } from "../session/types.js";
import type { SessionStore } from "../session/store.js";
import { createMemoryTaskStore } from "../task/store.js";
import type { TaskStore } from "../task/store.js";
import type { TaskRecord } from "../task/types.js";
import { finalizeInterruptedRun, reclaimExpiredLeases, startLeaseRecovery } from "./lease-recovery.js";

/** Minimal in-memory store: only the parts surface finalization touches. */
function memoryStore() {
  const parts = new Map<string, Part>();
  const tasks: TaskStore = createMemoryTaskStore();
  const store: SessionStore = {
    task: tasks,
    async createSession() {},
    async getSession() {
      return null;
    },
    async updateSession() {},
    async listSessions() {
      return [];
    },
    async appendMessage() {},
    async updateMessage() {},
    async appendPart(part) {
      parts.set(part.id, structuredClone(part));
    },
    async updatePart(part) {
      parts.set(part.id, structuredClone(part));
    },
    async getMessages() {
      return [];
    },
    async enqueuePrompt() {
      return 0;
    },
    async dequeuePrompt() {
      return null;
    },
    async clearQueuedPrompts() {},
  };
  return { store, parts, tasks };
}

/** 造一个「崩溃时正在跑」的任务。 */
async function runningTask(tasks: TaskStore, status: TaskRecord["status"] = "running"): Promise<TaskRecord> {
  const created = await tasks.createTask({ sessionId, rootRequestId: "req_crash", rootUserMessageId: "msg_crash", goal: "生成并校验产物" });
  return await tasks.updateTask(created.id, created.revision, { status });
}

const sessionId = "ses_test";

function toolPart(id: string, state: ToolState): Part {
  return { id, sessionId, messageId: "msg_test", type: "tool", callId: `call_${id}`, tool: "bash", state };
}

/** Seeds a leftover event stream as it would look right after a crash:
 *  a pending permission, a tool stuck running, todos in flight. */
async function seedLeftovers() {
  const log = createMemoryEventLog();
  const now = new Date().toISOString();
  await log.append({
    sessionId,
    type: "session.status",
    data: { status: "running" },
  });
  await log.append({
    sessionId,
    type: "permission.asked",
    data: {
      request: { id: "per_pending", sessionId, permission: "bash", patterns: ["exec *"], always: [], metadata: { command: "python3 gen_ppt.py" } },
    },
  });
  await log.append({
    sessionId,
    type: "message.part.updated",
    data: { part: toolPart("prt_running", { status: "running", input: { command: "python3 gen_ppt.py" }, time: { start: now } }) },
  });
  await log.append({
    sessionId,
    type: "todo.updated",
    data: { todos: [{ content: "生成脚本", status: "in_progress" }, { content: "校验产物", status: "pending" }] },
  });
  return { log };
}

describe("finalizeInterruptedRun", () => {
  it("recovers leftovers after the first thousand events and remains idempotent", async () => {
    const log = createMemoryEventLog();
    for (let i = 0; i < 1005; i++) await log.append({ sessionId, type: "session.status", data: { status: "running" } });
    await log.append({ sessionId, type: "permission.asked", data: { request: { id: "late", sessionId, permission: "bash", patterns: [], always: [] } } });
    await log.append({ sessionId, type: "todo.updated", data: { todos: [{ content: "late", status: "in_progress" }] } });
    const { store } = memoryStore();
    await finalizeInterruptedRun({ sessionId, log, store });
    const count = await log.count(sessionId);
    expect((await log.read(sessionId, 1007, 10)).map(event => event.type)).toEqual(["permission.replied", "todo.updated"]);
    await finalizeInterruptedRun({ sessionId, log, store });
    expect(await log.count(sessionId)).toBe(count);
  });

  it("folds pending permission, running tool parts and in-flight todos to terminal states", async () => {
    const { log } = await seedLeftovers();
    const { store, parts } = memoryStore();
    // The crash left the running part in the store too.
    await store.appendPart(toolPart("prt_running", { status: "running", input: { command: "python3 gen_ppt.py" }, time: { start: new Date().toISOString() } }));

    await finalizeInterruptedRun({ sessionId, log, store });

    const events = await log.read(sessionId, 0, 100);
    const replied = events.filter((event) => event.type === "permission.replied");
    expect(replied).toHaveLength(1);
    expect(replied[0]!.data).toMatchObject({ id: "per_pending", reply: "reject" });

    const toolUpdates = events.filter((event) => event.type === "message.part.updated");
    const lastTool = toolUpdates[toolUpdates.length - 1]!.data.part as Extract<Part, { type: "tool" }>;
    expect(lastTool.state.status).toBe("error");
    expect(lastTool.state.status === "error" ? lastTool.state.error : "").toContain("服务重启中断");
    // Store was updated to the terminal state as well.
    expect(parts.get("prt_running")?.type).toBe("tool");
    const stored = parts.get("prt_running") as Extract<Part, { type: "tool" }>;
    expect(stored.state.status).toBe("error");

    const lastTodo = [...events].reverse().find((event) => event.type === "todo.updated")!;
    expect(lastTodo.data.todos.map((item) => item.status)).toEqual(["cancelled", "cancelled"]);
  });

  it("is idempotent: a second pass appends nothing new", async () => {
    const { log } = await seedLeftovers();
    const { store } = memoryStore();
    await finalizeInterruptedRun({ sessionId, log, store });
    const countAfterFirst = (await log.read(sessionId, 0, 100)).length;
    await finalizeInterruptedRun({ sessionId, log, store });
    const countAfterSecond = (await log.read(sessionId, 0, 100)).length;
    expect(countAfterSecond).toBe(countAfterFirst);
  });

  it("leaves a cleanly settled session untouched", async () => {
    const log = createMemoryEventLog();
    await log.append({ sessionId, type: "session.status", data: { status: "running" } });
    await log.append({ sessionId, type: "message.part.updated", data: { part: toolPart("prt_done", { status: "completed", input: {}, output: "ok", title: "完成", time: { start: new Date().toISOString(), end: new Date().toISOString() } }) } });
    await log.append({ sessionId, type: "todo.updated", data: { todos: [{ content: "生成脚本", status: "completed" }] } });
    await log.append({ sessionId, type: "session.status", data: { status: "idle" } });

    const { store } = memoryStore();
    await finalizeInterruptedRun({ sessionId, log, store });
    const events = await log.read(sessionId, 0, 100);
    expect(events).toHaveLength(4); // nothing appended
    expect(events.some((event) => event.type === "permission.replied")).toBe(false);
    const todo = events.find((event) => event.type === "todo.updated")!;
    expect(todo.data.todos.map((item) => item.status)).toEqual(["completed"]);
  });
});

describe("finalizeInterruptedRun：任务层对账（规格 3 §11 / §16 阶段 D）", () => {
  // §17.1.13：有执行过却没收尾的工具调用 → unsafe_replay。
  it("崩溃时有工具在执行中，任务落 blocked(unsafe_replay) 并要求先核对", async () => {
    const { log } = await seedLeftovers();
    const { store, tasks } = memoryStore();
    const task = await runningTask(tasks);

    await finalizeInterruptedRun({ sessionId, log, store });

    const updated = (await tasks.getTask(task.id))!;
    expect(updated.status).toBe("blocked");
    expect(updated.blocker).toMatchObject({ kind: "unsafe_replay", resumable: true });
    // 「先核对外部状态」必须写清楚，不能只说「请继续」（§14.4）
    expect(updated.blocker!.requiredAction).toContain("核对");
    const blocked = (await log.read(sessionId, 0, 200)).find((event) => event.type === "task.blocked")!;
    expect((blocked.data as { blocker: { kind: string } }).blocker.kind).toBe("unsafe_replay");
    expect((blocked.data as { taskId: string }).taskId).toBe(task.id);
  });

  // 等待授权时被杀掉的那次工具调用**从未执行**。把它算成「可能有副作用」会让用户
  // 去核对一个根本没发生的变化——这是反向误报，同样是错误诊断。
  it("只是卡在等待授权上时，任务落 waiting_input 而不是 unsafe_replay", async () => {
    const log = createMemoryEventLog();
    const now = new Date().toISOString();
    await log.append({
      sessionId,
      type: "permission.asked",
      data: {
        request: {
          id: "per_pending",
          sessionId,
          permission: "bash",
          patterns: ["exec *"],
          always: [],
          tool: { messageId: "msg_test", callId: "call_prt_pending" },
        },
      },
    });
    await log.append({
      sessionId,
      type: "message.part.updated",
      data: { part: toolPart("prt_pending", { status: "pending", input: { command: "python3 gen_ppt.py" } }) },
    });
    const { store, tasks } = memoryStore();
    const task = await runningTask(tasks);

    await finalizeInterruptedRun({ sessionId, log, store });

    const updated = (await tasks.getTask(task.id))!;
    expect(updated.status).toBe("waiting_input");
    expect(updated.blocker).toMatchObject({ kind: "input", resumable: true });
    expect(updated.blocker!.requiredAction).toContain("继续");
  });

  it("已交付的任务不被重启对账改动", async () => {
    const { log } = await seedLeftovers();
    const { store, tasks } = memoryStore();
    const task = await runningTask(tasks, "delivered");

    await finalizeInterruptedRun({ sessionId, log, store });

    expect((await tasks.getTask(task.id))!.status).toBe("delivered");
    expect((await log.read(sessionId, 0, 200)).some((event) => event.type === "task.blocked")).toBe(false);
  });

  // 幂等：第二次扫描不能把已经 blocked 的任务再改一遍（也不能重复发事件）。
  it("第二次对账不再改动任务", async () => {
    const { log } = await seedLeftovers();
    const { store, tasks } = memoryStore();
    const task = await runningTask(tasks);
    await finalizeInterruptedRun({ sessionId, log, store });
    const afterFirst = (await tasks.getTask(task.id))!.revision;

    await finalizeInterruptedRun({ sessionId, log, store });

    expect((await tasks.getTask(task.id))!.revision).toBe(afterFirst);
  });
});

describe("reclaimExpiredLeases", () => {
  it("publishes the lease failure before the legacy idle settle event", async () => {
    const events: Array<{ type: string }> = [];
    const log = {
      async append(event: { type: string }) {
        events.push(event);
        return { ...event, id: `evt_${events.length}`, sessionId: "ses_expired", seq: events.length, at: new Date().toISOString() } as never;
      },
      async read() { return []; },
      async count() { return 0; },
    };
    await reclaimExpiredLeases({
      store: {
        async listExpiredLeases() { return [{ sessionId: "ses_expired" }]; },
        async clearLeaseIfExpired() { return true; },
      },
      log,
    });
    expect(events.map((event) => event.type)).toEqual(["session.error", "session.status"]);
  });

  it("scans immediately on process startup instead of waiting for the first interval", async () => {
    const recovery = globalThis as typeof globalThis & { __zmzaiFrameworkLeaseTimer?: ReturnType<typeof setInterval> };
    if (recovery.__zmzaiFrameworkLeaseTimer) clearInterval(recovery.__zmzaiFrameworkLeaseTimer);
    recovery.__zmzaiFrameworkLeaseTimer = undefined;
    const events: string[] = [];
    try {
      startLeaseRecovery({
        store: {
          async listExpiredLeases() { return [{ sessionId: "ses_startup_expired" }]; },
          async clearLeaseIfExpired() { return true; },
        },
        log: {
          async append(event: { type: string }) {
            events.push(event.type);
            return { ...event, id: `evt_${events.length}`, sessionId: "ses_startup_expired", seq: events.length, at: new Date().toISOString() } as never;
          },
          async read() { return []; },
          async count() { return 0; },
        },
      });
      await vi.waitFor(() => expect(events).toEqual(["session.error", "session.status"]));
    } finally {
      if (recovery.__zmzaiFrameworkLeaseTimer) clearInterval(recovery.__zmzaiFrameworkLeaseTimer);
      recovery.__zmzaiFrameworkLeaseTimer = undefined;
    }
  });
});

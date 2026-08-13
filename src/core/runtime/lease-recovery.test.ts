import { describe, expect, it } from "vitest";

import { createMemoryEventLog } from "../events/bus.js";
import type { Part, SessionInfo, ToolState } from "../session/types.js";
import type { SessionStore } from "../session/store.js";
import { finalizeInterruptedRun } from "./lease-recovery.js";

/** Minimal in-memory store: only the parts surface finalization touches. */
function memoryStore() {
  const parts = new Map<string, Part>();
  const store: SessionStore = {
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
  return { store, parts };
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

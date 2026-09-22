import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { existsSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createSqliteEventLog } from "../events/sqlite-event-log.js";
import { createSqliteSessionStore } from "./sqlite-store.js";
import type { MessageInfo, Part, SessionInfo } from "./types.js";

const model = { providerId: "test", modelId: "model" };
const session = (id = "ses_workflow"): SessionInfo => ({
  id, workspaceId: "ws", userId: "user", title: "workflow", agent: "default",
  model, permission: [], queuedPrompts: [],
  time: { created: "2026-09-08T00:00:00.000Z", updated: "2026-09-08T00:00:00.000Z" },
});
function accepted(sessionId: string, id: string, text: string) {
  const message: MessageInfo = { id, sessionId, role: "user", agent: "default", model, time: { created: new Date().toISOString() } };
  const parts: Part[] = [{ id: `part_${id}`, sessionId, messageId: id, type: "text", text }];
  return { message, parts };
}

describe("sqlite workflow contract", () => {
  let dataDir: string;
  beforeEach(async () => { dataDir = await mkdtemp(path.join(tmpdir(), "fw-workflow-")); });
  afterEach(async () => { await rm(dataDir, { recursive: true, force: true }); });

  it("persists monotonic read cursors, counts visible assistants once, and rejects old rewind revisions", async () => {
    const store = createSqliteSessionStore({ dataDir });
    await store.createSession(session());
    for (let n = 1; n <= 5; n++) {
      const item = accepted(session().id, `read_${n}`, String(n));
      if (n > 1) item.message = { ...item.message, role: "assistant", parentId: "read_1" } as unknown as typeof item.message;
      await store.appendMessage(item.message);
      if (n !== 3) await store.appendPart(item.parts[0]!);
    }
    await store.appendPart({ id: "thought", sessionId: session().id, messageId: "read_3", type: "reasoning", text: "private thought" });
    expect(await store.getReadState!(session().id)).toEqual({ lastReadMessageSeq: 0, unreadCount: 3, latestMessageSeq: 5, historyRevision: 1 });
    await store.markRead!(session().id, 4, 1);
    await store.markRead!(session().id, 2, 1);
    const reopened = createSqliteSessionStore({ dataDir });
    expect(await reopened.getReadState!(session().id)).toMatchObject({ lastReadMessageSeq: 4, unreadCount: 1 });
    await expect(store.markRead!(session().id, 6, 1)).rejects.toThrow("INVALID_READ_SEQUENCE");
    await store.markRead!(session().id, 5, 1);
    await store.rewind!(session().id, "read_4");
    expect(await store.getReadState!(session().id)).toEqual({ lastReadMessageSeq: 3, unreadCount: 0, latestMessageSeq: 3, historyRevision: 2 });
    const item = accepted(session().id, "new_branch", "new");
    await store.appendMessage({ ...item.message, role: "assistant", parentId: "read_1" });
    await store.appendPart(item.parts[0]!);
    await expect(store.markRead!(session().id, 5, 1)).rejects.toThrow("HISTORY_REVISION_CONFLICT");
    expect((await store.getReadState!(session().id)).unreadCount).toBe(1);
    expect((await store.getMessageSnapshot!(session().id, { limit: 50 })).readState.unreadCount).toBe(1);
    expect((await store.getReadState!("other")).unreadCount).toBe(0);
  });

  it("atomically deduplicates concurrent registration and persists one transcript/event set", async () => {
    const first = createSqliteSessionStore({ dataDir });
    const second = createSqliteSessionStore({ dataDir });
    await first.createSession(session());
    const input = { requestId: "request_0001", text: "hello", model };
    const payload = accepted(session().id, "msg_one", "hello");
    const [a,b] = await Promise.all([
      first.workflow!.acceptPrompt(session().id,input,payload),
      second.workflow!.acceptPrompt(session().id,input,payload),
    ]);
    expect(a.receipt).toEqual(b.receipt);
    expect((await first.getMessages(session().id)).map(item => item.info.id)).toEqual(["msg_one"]);
    expect(await createSqliteEventLog({ dataDir }).count(session().id)).toBe(2);
    expect(a.events.length + b.events.length).toBe(2);
  });

  it("deduplicates session creation and rejects the same request with changed parameters", async () => {
    const store = createSqliteSessionStore({ dataDir });
    const original = { ...session(),creationRequestId: "create_0001",creationPayloadHash: "hash-one" };
    await store.createSession(original);
    await store.createSession({ ...original,title: "ignored retry title" });
    expect((await store.getSession(original.id))?.title).toBe("workflow");
    await expect(store.createSession({ ...original,creationPayloadHash: "hash-two" })).rejects.toThrow("REQUEST_ID_REUSED");
  });

  it("rejects request id reuse with a different payload", async () => {
    const store = createSqliteSessionStore({ dataDir });
    await store.createSession(session());
    await store.workflow!.acceptPrompt(session().id,{ requestId: "request_0002", text: "one", model },accepted(session().id,"msg_one","one"));
    await expect(store.workflow!.acceptPrompt(session().id,{ requestId: "request_0002", text: "two", model },accepted(session().id,"msg_two","two"))).rejects.toThrow("REQUEST_ID_REUSED");
    expect(await createSqliteEventLog({ dataDir }).count(session().id)).toBe(2);
  });

  it("claims FIFO, advances revisions, and blocks automatic replay after recovery", async () => {
    const store = createSqliteSessionStore({ dataDir });
    await store.createSession(session());
    const one = await store.workflow!.acceptPrompt(session().id,{ requestId: "request_0003", text: "one", model },accepted(session().id,"msg_one","one"));
    await store.workflow!.acceptPrompt(session().id,{ requestId: "request_0004", text: "two", model },accepted(session().id,"msg_two","two"));
    const claimed = await store.workflow!.claimPrompt(session().id,"owner");
    expect(claimed?.receipt.runId).toBe(one.receipt.runId);
    expect(claimed?.revision).toBe(2);
    await store.workflow!.recoverInterrupted(session().id);
    expect(await store.workflow!.claimPrompt(session().id,"owner-2")).toBeNull();
    expect((await store.workflow!.workflowRuns(session().id))[0]?.status).toBe("recovery_required");
    await store.clearQueuedPrompts(session().id);
    expect((await store.workflow!.workflowRuns(session().id)).every(run => run.status === "cancelled")).toBe(true);
  });

  it("returns a consistent window watermark and invalidates cursors after rewind", async () => {
    const store = createSqliteSessionStore({ dataDir });
    await store.createSession(session());
    for (let n = 1; n <= 3; n += 1) {
      const item = accepted(session().id,`msg_${n}`,String(n));
      await store.appendMessage(item.message);
      await store.appendPart(item.parts[0]!);
    }
    const first = await store.getMessageSnapshot!(session().id,{ limit: 2 });
    expect(first.messages.map(item => item.messageSeq)).toEqual([2,3]);
    expect(first.hasMore).toBe(true);
    expect(first.nextBefore).toBe(2);
    await store.truncateFrom!(session().id,"msg_3");
    await expect(store.getMessageSnapshot!(session().id,{ limit: 2, before: first.nextBefore!, revision: first.revision })).rejects.toThrow("HISTORY_REVISION_CONFLICT");
  });

  it("pauses queued work after failure and clears the claimed lease", async () => {
    const store = createSqliteSessionStore({ dataDir });
    await store.createSession(session());
    for (const n of [1, 2]) await store.workflow!.acceptPrompt(session().id, { requestId: `failure_${n}`, text: String(n), model }, accepted(session().id, `failure_msg_${n}`, String(n)));
    const run = await store.workflow!.claimPrompt(session().id, "test");
    await store.workflow!.finishPrompt(session().id, run!.receipt.runId, run!.revision, "failed");
    expect((await store.workflow!.workflowRuns(session().id)).map(run => run.status)).toEqual(["failed", "recovery_required"]);
    expect(await store.workflow!.claimPrompt(session().id, "test")).toBeNull();
    expect((await store.getSession(session().id))?.leaseOwner).toBeUndefined();
  });

  it("restores independent state at the transcript watermark without replaying old permissions", async () => {
    const store = createSqliteSessionStore({ dataDir });
    await store.createSession(session());
    const log = createSqliteEventLog({ dataDir });
    for (const id of ["old", "pending"]) await log.append({ sessionId: session().id, type: "permission.asked", data: { request: { id, sessionId: session().id, permission: "bash", patterns: [], always: [] } } });
    await log.append({ sessionId: session().id, type: "permission.replied", data: { id: "old", reply: "once" } });
    await log.append({ sessionId: session().id, type: "todo.updated", data: { todos: [{ content: "work", status: "in_progress" }] } });
    for (const n of [1, 2, 3]) {
      await log.append({ sessionId: session().id, type: "artifact.created", data: { artifactId: String(n), path: "result.txt", bytes: n, contentType: "text/plain", downloadUrl: "/result" } });
      if (n < 3) await log.append({ sessionId: session().id, type: "session.summary", data: { text: String(n), kind: "completed" } });
    }
    const snapshot = await store.getMessageSnapshot!(session().id, { limit: 1 });
    expect(snapshot.snapshotSeq).toBe(await log.count(session().id));
    expect(snapshot.stateEvents.filter(e => e.type === "permission.asked").map(e => e.data.request.id)).toEqual(["pending"]);
    expect(snapshot.stateEvents.filter(e => e.type === "artifact.created").map(e => e.data.artifactId)).toEqual(["2", "3"]);
    expect(snapshot.stateEvents.filter(e => e.type === "session.summary").map(e => e.data.text)).toEqual(["2"]);
    expect(snapshot.stateEvents.some(e => e.type === "todo.updated")).toBe(true);
    expect(snapshot.stateEvents.every(e => e.seq <= snapshot.snapshotSeq)).toBe(true);
  });

  it("searches normalized parts, isolates sessions, and navigates first/middle/last windows", async () => {
    const store = createSqliteSessionStore({ dataDir });
    await store.createSession(session());
    for (let n = 1; n <= 120; n++) {
      const item = accepted(session().id, `search_${n}`, `Needle ${n}`);
      await store.appendMessage(item.message);
      await store.appendPart(item.parts[0]!);
    }
    await store.appendPart({ id: "attachment", sessionId: session().id, messageId: "search_60", type: "file", filename: "Needle.txt", mime: "text/plain", url: "data:text/plain;base64,c2VjcmV0LWJvZHk=" });
    await store.appendPart({ id: "reasoning", sessionId: session().id, messageId: "search_60", type: "reasoning", text: "private-reasoning" });
    await store.appendPart({ id: "tool", sessionId: session().id, messageId: "search_60", type: "tool", tool: "needle_tool", callId: "call", state: { status: "completed", input: { token: "private-input" }, title: "Useful summary", output: "private-output", time: { start: "now", end: "now" } } });
    await store.appendPart({ id: "credential", sessionId: session().id, messageId: "search_60", type: "text", text: "API_KEY=private-credential" });
    for (const query of ["private-reasoning", "private-input", "private-output", "private-credential", "secret-body", "data:text"]) expect((await store.searchMessages!(session().id, { query, limit: 30 })).results).toEqual([]);
    expect((await store.searchMessages!("other", { query: "Needle", limit: 30 })).results).toEqual([]);
    expect((await store.searchMessages!(session().id, { query: "needle.txt", limit: 30 })).results[0]?.kind).toBe("attachment_name");
    expect((await store.searchMessages!(session().id, { query: "useful summary", limit: 30 })).results[0]?.kind).toBe("tool");
    const first = await store.searchMessages!(session().id, { query: "needle", limit: 30 });
    const last = first.results.at(-1)!;
    const next = await store.searchMessages!(session().id, { query: "needle", limit: 30, after: { messageSeq: last.messageSeq, partId: last.partId }, revision: first.revision });
    expect(new Set([...first.results, ...next.results].map(hit => hit.partId)).size).toBe(60);
    for (const n of [1, 60, 120]) {
      const page = await store.getMessageSnapshot!(session().id, { around: `search_${n}`, limit: 50 });
      expect(page.messages.length).toBeLessThanOrEqual(50);
      expect(page.messages.some(message => message.info.id === `search_${n}`)).toBe(true);
    }
    const middle = await store.getMessageSnapshot!(session().id, { around: "search_60", limit: 50 });
    const newer = await store.getMessageSnapshot!(session().id, { after: middle.nextAfter!, limit: 50 });
    expect(newer.messages.at(-1)?.info.id).toBe("search_120");
    await store.rewind!(session().id, "search_60");
    await expect(store.searchMessages!(session().id, { query: "needle", limit: 30, revision: first.revision })).rejects.toThrow("HISTORY_REVISION_CONFLICT");
    expect((await store.searchMessages!(session().id, { query: "needle.txt", limit: 30 })).results).toEqual([]);
  });

  it("backs up and deterministically migrates legacy messages with equal timestamps", async () => {
    const dbPath = path.join(dataDir,"zmzai.db");
    const legacy = new DatabaseSync(dbPath);
    legacy.exec("CREATE TABLE sessions(id TEXT PRIMARY KEY,user_id TEXT NOT NULL,workspace_id TEXT NOT NULL,updated TEXT NOT NULL,json TEXT NOT NULL); CREATE TABLE messages(id TEXT PRIMARY KEY,session_id TEXT NOT NULL,created TEXT NOT NULL,json TEXT NOT NULL); CREATE TABLE parts(id TEXT PRIMARY KEY,session_id TEXT NOT NULL,message_id TEXT NOT NULL,json TEXT NOT NULL)");
    const info = session();
    legacy.prepare("INSERT INTO sessions VALUES (?,?,?,?,?)").run(info.id,info.userId,info.workspaceId,info.time.updated,JSON.stringify(info));
    for (const id of ["msg_b","msg_a"]) {
      const message = accepted(info.id,id,id).message;
      message.time.created = "2026-09-08T00:00:01.000Z";
      legacy.prepare("INSERT INTO messages VALUES (?,?,?,?)").run(id,info.id,message.time.created,JSON.stringify(message));
    }
    legacy.close();
    const store = createSqliteSessionStore({ dataDir,importJsonl: false });
    expect(existsSync(`${dbPath}.pre-f0-v2.bak`)).toBe(true);
    expect((await store.getMessages(info.id)).map(item => [item.info.id,item.messageSeq])).toEqual([["msg_a",1],["msg_b",2]]);
  });
});

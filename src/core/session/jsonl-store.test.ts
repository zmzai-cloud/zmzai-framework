import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createJsonlSessionStore } from "../session/jsonl-store.js";
import type { SessionInfo } from "../session/types.js";

function sessionInfo(overrides: Partial<SessionInfo> = {}): SessionInfo {
  return {
    id: "ses_1",
    workspaceId: "ws_1",
    userId: "user_1",
    title: "本地会话",
    agent: "default",
    model: { providerId: "relay", modelId: "m" },
    permission: [],
    queuedPrompts: [],
    time: { created: "2026-08-11T00:00:00.000Z", updated: "2026-08-11T00:00:00.000Z" },
    ...overrides,
  };
}

let dataDir = "";

beforeEach(async () => {
  dataDir = await mkdtemp(path.join(tmpdir(), "fw-jsonl-"));
});

afterEach(async () => {
  await rm(dataDir, { recursive: true, force: true });
});

describe("jsonl SessionStore", () => {
  it("persists sessions across store instances (reload from disk)", async () => {
    const first = createJsonlSessionStore({ dataDir });
    await first.createSession(sessionInfo());
    const second = createJsonlSessionStore({ dataDir });
    const loaded = await second.getSession("ses_1");
    expect(loaded?.title).toBe("本地会话");
  });

  it("lists sessions filtered by user/workspace, sorted by updated desc", async () => {
    const store = createJsonlSessionStore({ dataDir });
    await store.createSession(sessionInfo({ id: "ses_a", time: { created: "t", updated: "2026-08-11T01:00:00Z" } }));
    await store.createSession(sessionInfo({ id: "ses_b", workspaceId: "ws_2", time: { created: "t", updated: "2026-08-11T02:00:00Z" } }));
    const all = await store.listSessions({ userId: "user_1" });
    expect(all.map((s) => s.id)).toEqual(["ses_b", "ses_a"]);
    const filtered = await store.listSessions({ userId: "user_1", workspaceId: "ws_2" });
    expect(filtered.map((s) => s.id)).toEqual(["ses_b"]);
  });

  it("appends and groups messages + parts", async () => {
    const store = createJsonlSessionStore({ dataDir });
    await store.createSession(sessionInfo());
    await store.appendMessage({ id: "msg_1", sessionId: "ses_1", role: "user", agent: "default", model: { providerId: "r", modelId: "m" }, time: { created: "2026-08-11T00:00:01Z" } });
    await store.appendPart({ id: "prt_1", sessionId: "ses_1", messageId: "msg_1", type: "text", text: "你好" });
    const messages = await store.getMessages("ses_1");
    expect(messages).toHaveLength(1);
    expect(messages[0]!.parts[0]).toMatchObject({ type: "text", text: "你好" });
  });

  it("updates a message and a part", async () => {
    const store = createJsonlSessionStore({ dataDir });
    await store.createSession(sessionInfo());
    await store.appendMessage({ id: "msg_1", sessionId: "ses_1", role: "assistant", parentId: "msg_0", agent: "d", model: { providerId: "r", modelId: "m" }, time: { created: "t" } });
    await store.updateMessage("msg_1", { tokens: { input: 1, output: 2 } } as never);
    const messages = await store.getMessages("ses_1");
    expect((messages[0]!.info as { tokens?: { input: number } }).tokens?.input).toBe(1);
  });

  it("FIFO queue", async () => {
    const store = createJsonlSessionStore({ dataDir });
    await store.createSession(sessionInfo());
    expect(await store.enqueuePrompt("ses_1", { text: "一", enqueuedAt: "t1" })).toBe(1);
    expect(await store.enqueuePrompt("ses_1", { text: "二", enqueuedAt: "t2" })).toBe(2);
    expect(await store.dequeuePrompt("ses_1")).toEqual({ text: "一", enqueuedAt: "t1" });
    expect(await store.dequeuePrompt("ses_1")).toEqual({ text: "二", enqueuedAt: "t2" });
    expect(await store.dequeuePrompt("ses_1")).toBeNull();
  });
});

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createJsonlSessionStore } from "./jsonl-store.js";
import { createSqliteSessionStore } from "./sqlite-store.js";
import type { MessageInfo, SessionStore } from "./store.js";
import type { Part, SessionInfo } from "./types.js";

function sessionInfo(id = "ses_1"): SessionInfo {
  return {
    id,
    workspaceId: "ws_1",
    userId: "user_1",
    title: "回溯测试",
    agent: "default",
    model: { providerId: "relay", modelId: "m" },
    permission: [],
    queuedPrompts: [],
    time: { created: "2026-09-02T00:00:00.000Z", updated: "2026-09-02T00:00:00.000Z" },
  };
}

let seq = 0;
function userMessage(sessionId: string, created: string): { info: MessageInfo; parts: Part[] } {
  seq += 1;
  const id = `msg_u_${seq}`;
  return {
    info: { id, sessionId, role: "user", agent: "default", model: { providerId: "relay", modelId: "m" }, time: { created } },
    parts: [{ id: `part_${id}`, sessionId, messageId: id, type: "text", text: `消息 ${seq}` }],
  };
}
function assistantMessage(sessionId: string, parentId: string, created: string): { info: MessageInfo; parts: Part[] } {
  seq += 1;
  const id = `msg_a_${seq}`;
  return {
    info: { id, sessionId, role: "assistant", parentId, agent: "default", model: { providerId: "relay", modelId: "m" }, time: { created } },
    parts: [{ id: `part_${id}`, sessionId, messageId: id, type: "text", text: `回复 ${seq}` }],
  };
}

/** 每次调用从 1 重新编号（模块级 seq 跨 test 累加会让固定 id 断言失配）。 */
async function seed(store: SessionStore): Promise<void> {
  seq = 0;
  await store.createSession(sessionInfo());
  const entries = [
    userMessage("ses_1", "2026-09-02T00:00:01.000Z"),
    assistantMessage("ses_1", "msg_u_1", "2026-09-02T00:00:02.000Z"),
    userMessage("ses_1", "2026-09-02T00:00:03.000Z"),
    assistantMessage("ses_1", "msg_u_3", "2026-09-02T00:00:04.000Z"),
  ];
  for (const { info, parts } of entries) {
    await store.appendMessage(info);
    for (const part of parts) await store.appendPart(part);
  }
}

describe.each([
  ["sqlite", (dataDir: string) => createSqliteSessionStore({ dataDir })],
  ["jsonl", (dataDir: string) => createJsonlSessionStore({ dataDir })],
])("truncateFrom (%s)", (_name, makeStore) => {
  let dataDir = "";

  beforeEach(async () => {
    dataDir = await mkdtemp(path.join(tmpdir(), "fw-truncate-"));
  });

  afterEach(async () => {
    await rm(dataDir, { recursive: true, force: true });
  });

  it("deletes the target message and everything after it (messages + parts)", async () => {
    const store = makeStore(dataDir);
    await seed(store);
    await store.truncateFrom!("ses_1", "msg_u_3");
    const rest = await store.getMessages("ses_1");
    expect(rest.map((entry) => entry.info.id)).toEqual(["msg_u_1", "msg_a_2"]);
    // parts 一并删除：幸存消息各 1 条 text part，无孤儿
    expect(rest.flatMap((entry) => entry.parts.map((p) => p.id))).toEqual(["part_msg_u_1", "part_msg_a_2"]);
  });

  it("truncating the first message empties the transcript", async () => {
    const store = makeStore(dataDir);
    await seed(store);
    await store.truncateFrom!("ses_1", "msg_u_1");
    expect(await store.getMessages("ses_1")).toEqual([]);
  });

  it("throws MESSAGE_NOT_FOUND for an unknown message and leaves data intact", async () => {
    const store = makeStore(dataDir);
    await seed(store);
    await expect(store.truncateFrom!("ses_1", "msg_missing")).rejects.toThrow("MESSAGE_NOT_FOUND");
    expect((await store.getMessages("ses_1")).length).toBe(4);
  });
});

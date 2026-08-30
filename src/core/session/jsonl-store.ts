import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";

import type { SessionStore } from "../session/store.js";
import type { MessageInfo, MessageWithParts, Part, SessionInfo } from "../session/types.js";

/** JSONL SessionStore (spec §3.1 / §11 M4): the zero-dependency local demo
 *  backend. Persists sessions/messages/parts as JSON files under a data dir so
 *  `FW_MODE=local` runs the full framework with no Mongo. Single-process only
 *  — it trades the cloud backend's multi-writer atomicity for zero setup.
 *
 *  Layout: <dataDir>/sessions/<id>.json, <dataDir>/messages/<id>.json,
 *  <dataDir>/parts/<id>.json — whole-document writes (sessions are small). */

type JsonlStoreOptions = { dataDir: string };

export function createJsonlSessionStore(options: JsonlStoreOptions): SessionStore {
  const { dataDir } = options;
  const sessionsDir = path.join(dataDir, "sessions");
  const messagesDir = path.join(dataDir, "messages");
  const partsDir = path.join(dataDir, "parts");

  async function ensureDirs(): Promise<void> {
    await mkdir(sessionsDir, { recursive: true });
    await mkdir(messagesDir, { recursive: true });
    await mkdir(partsDir, { recursive: true });
  }

  const sessions = new Map<string, SessionInfo>();
  const messages = new Map<string, MessageInfo>();
  const parts = new Map<string, Part>();
  let hydrated = false;

  async function hydrate(): Promise<void> {
    if (hydrated) return;
    await ensureDirs();
    const { readdir } = await import("node:fs/promises");
    for (const [dir, map] of [
      [sessionsDir, sessions],
      [messagesDir, messages],
      [partsDir, parts],
    ] as const) {
      if (!existsSync(dir)) continue;
      for (const file of await readdir(dir)) {
        if (!file.endsWith(".json")) continue;
        try {
          const record = JSON.parse(await readFile(path.join(dir, file), "utf8")) as { id?: string } & (SessionInfo | MessageInfo | Part);
          const id = ("sessionId" in record && file.startsWith("ses_")) || file.startsWith("ses_") ? (record as SessionInfo).id : (record as { id?: string }).id;
          if (id) (map as Map<string, unknown>).set(id, record);
        } catch {
          // skip corrupt files
        }
      }
    }
    hydrated = true;
  }

  async function persist<T extends { id: string }>(dir: string, record: T): Promise<void> {
    await ensureDirs();
    await writeFile(path.join(dir, `${record.id}.json`), JSON.stringify(record, null, 2), "utf8");
  }

  return {
    async createSession(info) {
      await hydrate();
      sessions.set(info.id, structuredClone(info));
      await persist(sessionsDir, info);
    },
    async getSession(id) {
      await hydrate();
      const session = sessions.get(id);
      return session ? structuredClone(session) : null;
    },
    async updateSession(id, patch) {
      await hydrate();
      const session = sessions.get(id);
      if (!session) return;
      const updated = { ...session, ...patch, time: { ...session.time, ...(patch.time ?? {}), updated: new Date().toISOString() } };
      sessions.set(id, updated);
      await persist(sessionsDir, updated);
    },
    async listSessions(filter) {
      await hydrate();
      return [...sessions.values()]
        .filter((session) => session.userId === filter.userId && (!filter.workspaceId || session.workspaceId === filter.workspaceId))
        .sort((a, b) => b.time.updated.localeCompare(a.time.updated))
        .map((session) => structuredClone(session));
    },
    async appendMessage(info) {
      await hydrate();
      messages.set(info.id, structuredClone(info));
      await persist(messagesDir, info);
    },
    async updateMessage(id, patch) {
      await hydrate();
      const message = messages.get(id);
      if (!message) return;
      const updated = { ...message, ...patch } as MessageInfo;
      messages.set(id, updated);
      await persist(messagesDir, updated);
    },
    async appendPart(part) {
      await hydrate();
      parts.set(part.id, structuredClone(part));
      await persist(partsDir, part);
    },
    async updatePart(part) {
      await hydrate();
      parts.set(part.id, structuredClone(part));
      await persist(partsDir, part);
    },
    async getMessages(sessionId) {
      await hydrate();
      const result: MessageWithParts[] = [];
      for (const message of messages.values()) {
        if (message.sessionId !== sessionId) continue;
        result.push({
          info: structuredClone(message),
          parts: [...parts.values()].filter((part) => part.messageId === message.id).map((part) => structuredClone(part)),
        });
      }
      result.sort((a, b) => a.info.time.created.localeCompare(b.info.time.created));
      return result;
    },
    async deleteSession(id) {
      await hydrate();
      const { rm } = await import("node:fs/promises");
      sessions.delete(id);
      await rm(path.join(sessionsDir, `${id}.json`), { force: true });
      for (const [map, dir] of [[messages, messagesDir], [parts, partsDir]] as const) {
        for (const [rid, rec] of map) {
          if (rec.sessionId !== id) continue;
          map.delete(rid);
          await rm(path.join(dir, `${rid}.json`), { force: true });
        }
      }
    },
    async enqueuePrompt(sessionId, prompt) {
      await hydrate();
      const session = sessions.get(sessionId);
      if (!session) return 0;
      session.queuedPrompts.push(prompt);
      await persist(sessionsDir, session);
      return session.queuedPrompts.length;
    },
    async dequeuePrompt(sessionId) {
      await hydrate();
      const session = sessions.get(sessionId);
      const next = session?.queuedPrompts.shift();
      if (session && next) await persist(sessionsDir, session);
      return next ?? null;
    },
    async clearQueuedPrompts(sessionId) {
      await hydrate();
      const session = sessions.get(sessionId);
      if (!session) return;
      session.queuedPrompts = [];
      await persist(sessionsDir, session);
    },
  };
}

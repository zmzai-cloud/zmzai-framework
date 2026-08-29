import { existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import type { SessionStore } from "./store.js";
import type { MessageInfo, MessageWithParts, Part, QueuedPrompt, SessionInfo } from "./types.js";

/** SQLite SessionStore (N4)：单文件、零依赖（Node 26 内置 node:sqlite）的本地
 *  持久化后端，替代 JSONL 的多文件整文档写。记录以 JSON 文本整行存储（schema
 *  轻量，与 SessionStore 的 document 语义对齐），排序/过滤所需的列单独提取。
 *
 *  Layout: <dataDir>/zmzai.db — sessions/messages/parts 三张表。
 *  首次初始化时若存在旧 JSONL 数据（sessions/*.json 等）且库为空，则一次性
 *  导入；JSONL 文件保留不动，删除 dataDir/zmzai.db 即可回退。
 *  并发（P0）：WAL journal 模式 + busy_timeout，允许 dev server 多 worker /
 *  CLI 与 Web 同时打开同一库文件（写写冲突由 busy_timeout 排队而非报错）。 */

type SqliteStoreOptions = {
  dataDir: string;
  /** 旧 JSONL 数据自动导入（默认开启，库非空时跳过）。 */
  importJsonl?: boolean;
};

export function createSqliteSessionStore(options: SqliteStoreOptions): SessionStore {
  const { dataDir } = options;
  mkdirSync(dataDir, { recursive: true });
  const db = new DatabaseSync(path.join(dataDir, "zmzai.db"));
  // WAL：读写互不阻塞；busy_timeout：另一进程持写锁时本连接等待而非立即 SQLITE_BUSY
  db.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000; PRAGMA synchronous = NORMAL;");
  db.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      workspace_id TEXT NOT NULL,
      updated TEXT NOT NULL,
      json TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      created TEXT NOT NULL,
      json TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS parts (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      message_id TEXT NOT NULL,
      json TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_messages_session ON messages (session_id, created);
    CREATE INDEX IF NOT EXISTS idx_parts_message ON parts (message_id);
  `);

  // ---- 旧 JSONL 一次性导入（幂等：仅当库为空且旧目录有数据） ----
  if (options.importJsonl !== false && db.prepare("SELECT COUNT(*) AS n FROM sessions").get()?.n === 0) {
    for (const [dir, table] of [
      ["sessions", "sessions"],
      ["messages", "messages"],
      ["parts", "parts"],
    ] as const) {
      const abs = path.join(dataDir, dir);
      if (!existsSync(abs)) continue;
      for (const file of readdirSync(abs)) {
        if (!file.endsWith(".json")) continue;
        try {
          const record = JSON.parse(readFileSync(path.join(abs, file), "utf8"));
          upsert(table, record);
        } catch {
          // skip corrupt files
        }
      }
    }
  }

  function upsert(table: "sessions" | "messages" | "parts", record: { id: string } & Record<string, unknown>): void {
    if (table === "sessions") {
      const s = record as unknown as SessionInfo;
      db.prepare(
        "INSERT INTO sessions (id, user_id, workspace_id, updated, json) VALUES (?, ?, ?, ?, ?) " +
          "ON CONFLICT(id) DO UPDATE SET user_id = excluded.user_id, workspace_id = excluded.workspace_id, updated = excluded.updated, json = excluded.json",
      ).run(s.id, s.userId, s.workspaceId, s.time.updated, JSON.stringify(s));
    } else if (table === "messages") {
      const m = record as unknown as MessageInfo;
      db.prepare(
        "INSERT INTO messages (id, session_id, created, json) VALUES (?, ?, ?, ?) " +
          "ON CONFLICT(id) DO UPDATE SET json = excluded.json",
      ).run(m.id, m.sessionId, m.time.created, JSON.stringify(m));
    } else {
      const p = record as unknown as Part;
      db.prepare(
        "INSERT INTO parts (id, session_id, message_id, json) VALUES (?, ?, ?, ?) " +
          "ON CONFLICT(id) DO UPDATE SET json = excluded.json",
      ).run(p.id, p.sessionId, p.messageId, JSON.stringify(p));
    }
  }

  function getSessionRow(id: string): SessionInfo | null {
    const row = db.prepare("SELECT json FROM sessions WHERE id = ?").get(id) as { json: string } | undefined;
    return row ? (JSON.parse(row.json) as SessionInfo) : null;
  }

  function persistSession(session: SessionInfo): void {
    upsert("sessions", session as unknown as { id: string });
  }

  return {
    async createSession(info) {
      persistSession(info);
    },
    async getSession(id) {
      const session = getSessionRow(id);
      return session ? structuredClone(session) : null;
    },
    async updateSession(id, patch) {
      const session = getSessionRow(id);
      if (!session) return;
      const updated = { ...session, ...patch, time: { ...session.time, ...(patch.time ?? {}), updated: new Date().toISOString() } };
      persistSession(updated);
    },
    async listSessions(filter) {
      const rows = db
        .prepare("SELECT json FROM sessions WHERE user_id = ? AND (? IS NULL OR workspace_id = ?) ORDER BY updated DESC")
        .all(filter.userId, filter.workspaceId ?? null, filter.workspaceId ?? null) as { json: string }[];
      return rows.map((row) => JSON.parse(row.json) as SessionInfo);
    },
    async appendMessage(info) {
      upsert("messages", info as unknown as { id: string });
    },
    async updateMessage(id, patch) {
      const row = db.prepare("SELECT json FROM messages WHERE id = ?").get(id) as { json: string } | undefined;
      if (!row) return;
      const updated = { ...(JSON.parse(row.json) as MessageInfo), ...patch } as MessageInfo;
      upsert("messages", updated as unknown as { id: string });
    },
    async appendPart(part) {
      upsert("parts", part as unknown as { id: string });
    },
    async updatePart(part) {
      upsert("parts", part as unknown as { id: string });
    },
    async getMessages(sessionId) {
      const messageRows = db
        .prepare("SELECT json FROM messages WHERE session_id = ? ORDER BY created ASC")
        .all(sessionId) as { json: string }[];
      const partRows = db
        .prepare("SELECT message_id, json FROM parts WHERE session_id = ?")
        .all(sessionId) as { message_id: string; json: string }[];
      const partsByMessage = new Map<string, Part[]>();
      for (const row of partRows) {
        const list = partsByMessage.get(row.message_id) ?? [];
        list.push(JSON.parse(row.json) as Part);
        partsByMessage.set(row.message_id, list);
      }
      return messageRows.map((row) => {
        const info = JSON.parse(row.json) as MessageInfo;
        return { info, parts: partsByMessage.get(info.id) ?? [] };
      });
    },
    async enqueuePrompt(sessionId, prompt: QueuedPrompt) {
      const session = getSessionRow(sessionId);
      if (!session) return 0;
      session.queuedPrompts.push(prompt);
      persistSession(session);
      return session.queuedPrompts.length;
    },
    async dequeuePrompt(sessionId) {
      const session = getSessionRow(sessionId);
      const next = session?.queuedPrompts.shift();
      if (session && next) persistSession(session);
      return next ?? null;
    },
    async clearQueuedPrompts(sessionId) {
      const session = getSessionRow(sessionId);
      if (!session) return;
      session.queuedPrompts = [];
      persistSession(session);
    },
  };
}

import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import type { EventLog } from "./bus.js";
import { frameworkEventSchemas } from "./manifest.js";
import type { FrameworkEventType, PersistedFrameworkEvent } from "./manifest.js";
import { newEventId } from "../session/ids.js";

/** SQLite EventLog：EventLog 的本地持久化实现，替代 createMemoryEventLog。
 *
 *  内存版有两个致命伤（产品 P0 排查结论）：
 *  1. 进程重启即清零 —— 运行中会话的投影永远冻结，SSE 断线后无法续传；
 *  2. 重启后 seq 从 1 重来 —— 页面未重载时 since 游标失效，实时事件被静默过滤。
 *
 *  本实现与会话库共用同一 <dataDir>/zmzai.db（events 表，(session_id, seq) 主键，
 *  WAL + busy_timeout 与 SessionStore 的多进程并发策略一致）：
 *  - 断线重连 / 页面刷新 / 服务重启后 subscribeEventLog 的 log.read catch-up
 *    都能拉到完整历史，SSE since 续传跨重启无缝；
 *  - lease recovery 收尾时 append 的 session.error / 收尾事件也持久化，
 *    客户端重启后照样能收到"运行因服务重启中断"的结算。 */

type SqliteEventLogOptions = {
  dataDir: string;
};

export function createSqliteEventLog(options: SqliteEventLogOptions): EventLog {
  const db = new DatabaseSync(path.join(options.dataDir, "zmzai.db"));
  db.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000; PRAGMA synchronous = NORMAL;");
  db.exec(`
    CREATE TABLE IF NOT EXISTS events (
      session_id TEXT NOT NULL,
      seq INTEGER NOT NULL,
      id TEXT NOT NULL,
      type TEXT NOT NULL,
      at TEXT NOT NULL,
      json TEXT NOT NULL,
      PRIMARY KEY (session_id, seq)
    );
  `);

  const nextSeq = db.prepare("SELECT COALESCE(MAX(seq), 0) + 1 AS n FROM events WHERE session_id = ?");
  const insert = db.prepare(
    "INSERT INTO events (session_id, seq, id, type, at, json) VALUES (?, ?, ?, ?, ?, ?)",
  );
  const readStmt = db.prepare(
    "SELECT json FROM events WHERE session_id = ? AND seq > ? ORDER BY seq ASC LIMIT ?",
  );
  const countStmt = db.prepare("SELECT COUNT(*) AS n FROM events WHERE session_id = ?");

  return {
    async append(event) {
      const schema = frameworkEventSchemas[event.type as FrameworkEventType];
      const parsed = schema.safeParse(event.data);
      if (!parsed.success) throw new Error(`INVALID_FRAMEWORK_EVENT: ${event.type} ${parsed.error.issues[0]?.message ?? ""}`);
      const seq = (nextSeq.get(event.sessionId) as { n: number }).n;
      const persisted: PersistedFrameworkEvent = {
        id: newEventId(),
        sessionId: event.sessionId,
        seq,
        type: event.type as FrameworkEventType,
        data: parsed.data as never,
        at: new Date().toISOString(),
      };
      insert.run(event.sessionId, seq, persisted.id, persisted.type, persisted.at, JSON.stringify(persisted));
      return persisted;
    },
    async read(sessionId, sinceSeq, limit) {
      const rows = readStmt.all(sessionId, sinceSeq, limit) as { json: string }[];
      return rows.map((row) => JSON.parse(row.json) as PersistedFrameworkEvent);
    },
    async count(sessionId) {
      return (countStmt.get(sessionId) as { n: number }).n;
    },
  };
}

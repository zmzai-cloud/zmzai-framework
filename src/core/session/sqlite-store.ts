import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { promptHash, type PromptReceipt, type WorkflowRun } from "./workflow.js";
import { frameworkEventSchemas, type FrameworkEventType, type PersistedFrameworkEvent } from "../events/manifest.js";
import { newEventId } from "./ids.js";
import { searchablePart, searchSnippet, type MessageSearchHit } from "./message-search.js";

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

/** SQLite store = SessionStore + 运行租约（spec §3.2）：stamp/clear 供 runner
 *  盖章释放；listExpiredLeases/clearLeaseIfExpired 供 lease recovery 扫描。
 *  消费方把同一实例同时传给 createServer 的 store 与 leaseStore 即完成接线。 */
export type SqliteSessionStore = SessionStore & {
  stamp(sessionId: string, owner: string, expiresAt: Date): Promise<void>;
  clear(sessionId: string): Promise<void>;
  listExpiredLeases(): Promise<{ sessionId: string }[]>;
  clearLeaseIfExpired(sessionId: string): Promise<boolean>;
  /** 把 WAL 日志刷回主库并截断（Electron 优雅退出用，P2）。WAL +
   *  synchronous=NORMAL 下已提交事务本就不丢，checkpoint 只是缩小 WAL 文件、
   *  让进程退出前数据尽量并回主库。 */
  checkpoint(): Promise<void>;
  /** 批量统计每个会话的消息数（N6 会话列表元信息用）：一条 GROUP BY 拿全量，
   *  避免逐会话 N+1 查询。 */
  countMessagesBySession(): Promise<Map<string, number>>;
};

export function createSqliteSessionStore(options: SqliteStoreOptions): SqliteSessionStore {
  const { dataDir } = options;
  mkdirSync(dataDir, { recursive: true });
  const databasePath = path.join(dataDir, "zmzai.db");
  const existed = existsSync(databasePath);
  const db = new DatabaseSync(databasePath);
  // WAL：读写互不阻塞；busy_timeout：另一进程持写锁时本连接等待而非立即 SQLITE_BUSY
  db.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000; PRAGMA synchronous = NORMAL;");
  const migrationVersion = 2;
  const migrationRecorded = !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='schema_migrations'").get()
    && !!db.prepare("SELECT 1 FROM schema_migrations WHERE version=?").get(migrationVersion);
  if (existed && !migrationRecorded) {
    const backupPath = `${databasePath}.pre-f0-v${migrationVersion}.bak`;
    if (!existsSync(backupPath)) writeFileSync(backupPath,db.serialize());
  }
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
      message_seq INTEGER,
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
    CREATE TABLE IF NOT EXISTS events (
      session_id TEXT NOT NULL, seq INTEGER NOT NULL, id TEXT NOT NULL,
      type TEXT NOT NULL, at TEXT NOT NULL, json TEXT NOT NULL,
      PRIMARY KEY (session_id, seq)
    );
    CREATE INDEX IF NOT EXISTS idx_events_type ON events(session_id,type,seq);
    CREATE TABLE IF NOT EXISTS message_search (
      part_id TEXT PRIMARY KEY, session_id TEXT NOT NULL, message_id TEXT NOT NULL,
      kind TEXT NOT NULL, content TEXT NOT NULL, normalized TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_search_session ON message_search(session_id,message_id,part_id);
    CREATE TABLE IF NOT EXISTS session_reads (session_id TEXT PRIMARY KEY, last_read_seq INTEGER NOT NULL DEFAULT 0);
  `);
  function transaction<T>(body: () => T): T {
    if (db.isTransaction) return body();
    db.exec("BEGIN IMMEDIATE");
    try { const result = body(); db.exec("COMMIT"); return result; }
    catch (error) { db.exec("ROLLBACK"); throw error; }
  }
  transaction(() => {
    const columns = db.prepare("PRAGMA table_info(messages)").all() as { name: string }[];
    if (!columns.some(column => column.name === "message_seq")) db.exec("ALTER TABLE messages ADD COLUMN message_seq INTEGER");
    db.exec(`
      CREATE TABLE IF NOT EXISTS session_history (session_id TEXT PRIMARY KEY, last_seq INTEGER NOT NULL DEFAULT 0, revision INTEGER NOT NULL DEFAULT 1);
      CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);
      INSERT INTO session_history(session_id,last_seq) SELECT session_id,COALESCE(MAX(message_seq),0) FROM messages GROUP BY session_id ON CONFLICT(session_id) DO UPDATE SET last_seq=MAX(last_seq,excluded.last_seq);
    `);
    const missing = db.prepare("SELECT id,session_id FROM messages WHERE message_seq IS NULL ORDER BY created,id").all() as { id: string; session_id: string }[];
    for (const row of missing) db.prepare("UPDATE messages SET message_seq=? WHERE id=?").run(allocateSequence(row.session_id), row.id);
    db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_message_sequence ON messages(session_id,message_seq)");
    db.exec(`CREATE TABLE IF NOT EXISTS workflow_runs (
      run_id TEXT PRIMARY KEY, session_id TEXT NOT NULL, request_id TEXT NOT NULL, payload_hash TEXT NOT NULL,
      payload TEXT NOT NULL, receipt TEXT NOT NULL, status TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 1,
      ordinal INTEGER NOT NULL, owner TEXT, UNIQUE(session_id,request_id)
    )`);
    db.prepare("INSERT OR IGNORE INTO schema_migrations(version,applied_at) VALUES (?,?)").run(migrationVersion,new Date().toISOString());
    if (!db.prepare("SELECT 1 FROM schema_migrations WHERE version=3").get()) {
      for (const row of db.prepare("SELECT json FROM parts").iterate() as Iterable<{ json: string }>) indexPart(JSON.parse(row.json) as Part);
      db.prepare("INSERT INTO schema_migrations VALUES (3,?)").run(new Date().toISOString());
    }
  });

  function indexPart(part: Part): void {
    const item = searchablePart(part);
    if (!item) { db.prepare("DELETE FROM message_search WHERE part_id=?").run(part.id); return; }
    db.prepare(`INSERT INTO message_search VALUES (?,?,?,?,?,?) ON CONFLICT(part_id) DO UPDATE SET
      kind=excluded.kind,content=excluded.content,normalized=excluded.normalized`).run(part.id,part.sessionId,part.messageId,item.kind,item.text,item.text.toLowerCase());
  }

  function allocateSequence(sessionId: string): number {
    return (db.prepare("INSERT INTO session_history(session_id,last_seq) VALUES (?,1) ON CONFLICT(session_id) DO UPDATE SET last_seq=last_seq+1 RETURNING last_seq").get(sessionId) as { last_seq: number }).last_seq;
  }

  function readState(sessionId: string) {
    const historyRevision = (db.prepare("SELECT revision FROM session_history WHERE session_id=?").get(sessionId) as { revision: number } | undefined)?.revision ?? 1;
    const latestMessageSeq = (db.prepare("SELECT COALESCE(MAX(message_seq),0) AS n FROM messages WHERE session_id=?").get(sessionId) as { n: number }).n;
    const stored = (db.prepare("SELECT last_read_seq FROM session_reads WHERE session_id=?").get(sessionId) as { last_read_seq: number } | undefined)?.last_read_seq ?? 0;
    const lastReadMessageSeq = Math.min(stored, latestMessageSeq);
    const unreadCount = (db.prepare(`SELECT COUNT(*) AS n FROM messages m WHERE m.session_id=? AND m.message_seq>? AND json_extract(m.json,'$.role')='assistant'
      AND (json_extract(m.json,'$.error') IS NOT NULL OR EXISTS (SELECT 1 FROM parts p WHERE p.message_id=m.id AND (
        (json_extract(p.json,'$.type')='text' AND length(trim(json_extract(p.json,'$.text')))>0)
        OR json_extract(p.json,'$.type') IN ('tool','file','image','subtask','compaction')
      )))`).get(sessionId,lastReadMessageSeq) as { n: number }).n;
    return { lastReadMessageSeq, unreadCount, latestMessageSeq, historyRevision };
  }

  function appendEvent(sessionId: string, event: { type: string; data: unknown }): PersistedFrameworkEvent {
    const schema = frameworkEventSchemas[event.type as FrameworkEventType];
    const parsed = schema.safeParse(event.data);
    if (!parsed.success) throw new Error(`INVALID_FRAMEWORK_EVENT: ${event.type}`);
    if (event.type === "message.updated") {
      const data = parsed.data as { message: MessageInfo & { messageSeq?: number } };
      const row = db.prepare("SELECT message_seq FROM messages WHERE session_id=? AND id=?").get(sessionId,data.message.id) as { message_seq: number } | undefined;
      if (row) data.message = { ...data.message, messageSeq: row.message_seq };
    }
    const seq = (db.prepare("SELECT COALESCE(MAX(seq),0)+1 AS n FROM events WHERE session_id=?").get(sessionId) as { n: number }).n;
    const persisted = { id: newEventId(), sessionId, seq, type: event.type as FrameworkEventType, data: parsed.data as never, at: new Date().toISOString() } satisfies PersistedFrameworkEvent;
    db.prepare("INSERT INTO events(session_id,seq,id,type,at,json) VALUES (?,?,?,?,?,?)").run(sessionId,seq,persisted.id,persisted.type,persisted.at,JSON.stringify(persisted));
    return persisted;
  }

  function readMessages(sessionId: string, before?: number, limit?: number): MessageWithParts[] {
    const messageRows = before === undefined
      ? db.prepare("SELECT message_seq,json FROM messages WHERE session_id=? ORDER BY message_seq ASC").all(sessionId)
      : db.prepare("SELECT message_seq,json FROM messages WHERE session_id=? AND message_seq<? ORDER BY message_seq DESC LIMIT ?").all(sessionId,before,limit ?? 50);
    const ordered = (messageRows as { message_seq: number; json: string }[]).sort((a,b) => a.message_seq-b.message_seq);
    if (!ordered.length) return [];
    const ids = ordered.map(row => (JSON.parse(row.json) as MessageInfo).id);
    const placeholders = ids.map(() => "?").join(",");
    const partRows = db.prepare(`SELECT message_id,json FROM parts WHERE message_id IN (${placeholders})`).all(...ids) as { message_id: string; json: string }[];
    const partsByMessage = new Map<string, Part[]>();
    for (const row of partRows) {
      const list = partsByMessage.get(row.message_id) ?? [];
      list.push(JSON.parse(row.json) as Part);
      partsByMessage.set(row.message_id,list);
    }
    return ordered.map(row => {
      const info = JSON.parse(row.json) as MessageInfo;
      return { info, parts: partsByMessage.get(info.id) ?? [], messageSeq: row.message_seq };
    });
  }

  function truncateMessages(sessionId: string, fromMessageId: string): void {
    const rows = db.prepare("SELECT id FROM messages WHERE session_id=? ORDER BY message_seq ASC").all(sessionId) as { id: string }[];
    const idx = rows.findIndex(row => row.id === fromMessageId);
    if (idx < 0) throw new Error("MESSAGE_NOT_FOUND");
    const doomed = rows.slice(idx).map(row => row.id);
    const placeholders = doomed.map(() => "?").join(",");
    db.prepare(`DELETE FROM message_search WHERE message_id IN (${placeholders})`).run(...doomed);
    db.prepare(`DELETE FROM parts WHERE message_id IN (${placeholders})`).run(...doomed);
    db.prepare(`DELETE FROM messages WHERE id IN (${placeholders})`).run(...doomed);
    db.prepare("UPDATE session_history SET revision=revision+1 WHERE session_id=?").run(sessionId);
    db.prepare("UPDATE session_reads SET last_read_seq=MIN(last_read_seq,(SELECT COALESCE(MAX(message_seq),0) FROM messages WHERE session_id=?)) WHERE session_id=?").run(sessionId,sessionId);
  }

  // ---- 旧 JSONL 一次性导入（幂等：仅当库为空且旧目录有数据） ----
  if (options.importJsonl !== false && db.prepare("SELECT COUNT(*) AS n FROM sessions").get()?.n === 0) {
    for (const [dir, table] of [
      ["sessions", "sessions"],
      ["messages", "messages"],
      ["parts", "parts"],
    ] as const) {
      const abs = path.join(dataDir, dir);
      if (!existsSync(abs)) continue;
      const records: ({ id: string } & Record<string, unknown>)[] = [];
      for (const file of readdirSync(abs)) {
        if (!file.endsWith(".json")) continue;
        try {
          records.push(JSON.parse(readFileSync(path.join(abs, file), "utf8")));
        } catch {
          // skip corrupt files
        }
      }
      if (table === "messages") records.sort((a,b) => String((a.time as { created?: unknown } | undefined)?.created ?? "").localeCompare(String((b.time as { created?: unknown } | undefined)?.created ?? "")) || a.id.localeCompare(b.id));
      for (const record of records) upsert(table,record);
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
      transaction(() => {
      const existing = db.prepare("SELECT message_seq FROM messages WHERE id = ?").get(m.id) as { message_seq: number | null } | undefined;
      const sequence = existing?.message_seq ?? allocateSequence(m.sessionId);
      db.prepare(
        "INSERT INTO messages (id, session_id, created, message_seq, json) VALUES (?, ?, ?, ?, ?) " +
          "ON CONFLICT(id) DO UPDATE SET json = excluded.json",
      ).run(m.id, m.sessionId, m.time.created, sequence, JSON.stringify(m));
      });
    } else {
      const p = record as unknown as Part;
      transaction(() => {
      db.prepare(
        "INSERT INTO parts (id, session_id, message_id, json) VALUES (?, ?, ?, ?) " +
          "ON CONFLICT(id) DO UPDATE SET json = excluded.json",
      ).run(p.id, p.sessionId, p.messageId, JSON.stringify(p));
      indexPart(p);
      });
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
    async getReadState(sessionId) { return transaction(() => readState(sessionId)); },
    async markRead(sessionId, sequence, revision) {
      return transaction(() => {
        if (!getSessionRow(sessionId)) throw new Error("SESSION_NOT_FOUND");
        const current = readState(sessionId);
        if (revision !== current.historyRevision) throw new Error("HISTORY_REVISION_CONFLICT");
        if (!Number.isSafeInteger(sequence) || sequence < 0 || sequence > current.latestMessageSeq) throw new Error("INVALID_READ_SEQUENCE");
        db.prepare("INSERT INTO session_reads VALUES (?,?) ON CONFLICT(session_id) DO UPDATE SET last_read_seq=MAX(last_read_seq,excluded.last_read_seq)").run(sessionId,sequence);
        return readState(sessionId);
      });
    },
    async persistEvent(event) {
      return transaction(() => {
        if (event.type === "message.updated") upsert("messages",event.data.message as unknown as { id: string });
        else if (event.type === "message.part.updated") upsert("parts",event.data.part as unknown as { id: string });
        else if (event.type === "session.updated") {
          const current = getSessionRow(event.data.session.id);
          if (current) persistSession({ ...current,...event.data.session,time: { ...current.time,...event.data.session.time } });
        }
        return appendEvent(event.sessionId,event);
      });
    },
    workflow: {
      async acceptPrompt(sessionId, input, events) {
        return transaction(() => {
          const hash = promptHash(input);
          const prior = db.prepare("SELECT payload_hash,receipt FROM workflow_runs WHERE session_id=? AND request_id=?").get(sessionId, input.requestId!) as { payload_hash: string; receipt: string } | undefined;
          if (prior) {
            if (prior.payload_hash !== hash) throw new Error("REQUEST_ID_REUSED");
            return { receipt: JSON.parse(prior.receipt) as PromptReceipt, events: [] };
          }
          if (!getSessionRow(sessionId)) throw new Error("SESSION_NOT_FOUND");
          if (db.prepare("SELECT 1 FROM workflow_runs WHERE session_id=? AND status='recovery_required'").get(sessionId)) throw new Error("RECOVERY_REQUIRED");
          const queued = !!db.prepare("SELECT 1 FROM workflow_runs WHERE session_id=? AND status IN ('running','queued')").get(sessionId);
          const receipt: PromptReceipt = { ok: true, queued, requestId: input.requestId!, runId: randomUUID(), userMessageId: events.message.id, disposition: queued ? "queued" : "started" };
          upsert("messages", events.message as unknown as { id: string });
          for (const part of events.parts) upsert("parts", part as unknown as { id: string });
          const persistedEvents = [
            appendEvent(sessionId,{ type: "message.updated", data: { message: events.message } }),
            ...events.parts.map(part => appendEvent(sessionId,{ type: "message.part.updated", data: { part } })),
          ];
          db.prepare("INSERT INTO workflow_runs(run_id,session_id,request_id,payload_hash,payload,receipt,status,ordinal) VALUES (?,?,?,?,?,?,'queued',?)").run(receipt.runId,sessionId,input.requestId!,hash,JSON.stringify(input),JSON.stringify(receipt),(db.prepare("SELECT COALESCE(MAX(ordinal),0)+1 AS n FROM workflow_runs WHERE session_id=?").get(sessionId) as { n: number }).n);
          return { receipt, events: persistedEvents };
        });
      },
      async claimPrompt(sessionId, owner) {
        return transaction(() => {
          // Another process or an unconfirmed previous run owns this session.
          if (db.prepare("SELECT 1 FROM workflow_runs WHERE session_id=? AND status IN ('running','recovery_required')").get(sessionId)) return null;
          const row = db.prepare("SELECT * FROM workflow_runs WHERE session_id=? AND status='queued' ORDER BY ordinal LIMIT 1").get(sessionId) as { run_id: string; payload: string; receipt: string; revision: number } | undefined;
          if (!row) return null;
          db.prepare("UPDATE workflow_runs SET status='running',owner=?,revision=revision+1 WHERE run_id=?").run(owner,row.run_id);
          const session = getSessionRow(sessionId);
          if (session) {
            session.leaseOwner = owner;
            session.leaseExpiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString();
            persistSession(session);
          }
          return { receipt: JSON.parse(row.receipt), input: JSON.parse(row.payload), status: "running", revision: row.revision+1 } as WorkflowRun;
        });
      },
      async finishPrompt(sessionId, runId, revision, state) {
        transaction(() => {
        const updated = db.prepare("UPDATE workflow_runs SET status=?,revision=revision+1 WHERE session_id=? AND run_id=? AND revision=? AND status='running'").run(state,sessionId,runId,revision);
        if (updated.changes !== 1) throw new Error("RUN_REVISION_CONFLICT");
        if (state === "failed") db.prepare("UPDATE workflow_runs SET status='recovery_required',revision=revision+1 WHERE session_id=? AND status='queued'").run(sessionId);
        const session = getSessionRow(sessionId);
        if (session) {
          delete session.leaseOwner;
          delete session.leaseExpiresAt;
          persistSession(session);
        }
        });
      },
      async recoverInterrupted(sessionId) {
        db.prepare("UPDATE workflow_runs SET status='recovery_required',revision=revision+1 WHERE session_id=? AND status='running'").run(sessionId);
      },
      async workflowRuns(sessionId) {
        return (db.prepare("SELECT payload,receipt,status,revision FROM workflow_runs WHERE session_id=? ORDER BY ordinal").all(sessionId) as { payload: string; receipt: string; status: WorkflowRun["status"]; revision: number }[]).map(row => ({ input: JSON.parse(row.payload), receipt: JSON.parse(row.receipt), status: row.status, revision: row.revision }));
      },
      async findPrompt(sessionId,requestId) {
        const row = db.prepare("SELECT payload,receipt,status,revision FROM workflow_runs WHERE session_id=? AND request_id=?").get(sessionId,requestId) as { payload: string; receipt: string; status: WorkflowRun["status"]; revision: number } | undefined;
        return row ? { input: JSON.parse(row.payload),receipt: JSON.parse(row.receipt),status: row.status,revision: row.revision } : null;
      },
    },
    async createSession(info) {
      transaction(() => {
        const existing = getSessionRow(info.id);
        if (existing?.creationRequestId && info.creationRequestId === existing.creationRequestId) {
          if (existing.creationPayloadHash !== info.creationPayloadHash) throw new Error("REQUEST_ID_REUSED");
          return;
        }
        persistSession(info);
      });
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
      return transaction(() => readMessages(sessionId));
    },
    async searchMessages(sessionId, options) {
      return transaction(() => {
        const revision = (db.prepare("SELECT revision FROM session_history WHERE session_id=?").get(sessionId) as { revision: number } | undefined)?.revision ?? 1;
        if (options.revision !== undefined && options.revision !== revision) throw new Error("HISTORY_REVISION_CONFLICT");
        const query = options.query.trim();
        if (!query) return { results: [], revision, hasMore: false };
        const limit = Math.max(1,Math.min(100,options.limit));
        const rows = db.prepare(`SELECT m.message_seq,s.message_id,s.part_id,s.kind,s.content
          FROM message_search s JOIN messages m ON m.id=s.message_id AND m.session_id=s.session_id
          WHERE s.session_id=? AND instr(s.normalized,?)>0
            AND (m.message_seq>? OR (m.message_seq=? AND s.part_id>?))
          ORDER BY m.message_seq,s.part_id LIMIT ?`).all(sessionId,query.toLowerCase(),options.after?.messageSeq ?? 0,options.after?.messageSeq ?? 0,options.after?.partId ?? "",limit+1) as { message_seq: number; message_id: string; part_id: string; kind: MessageSearchHit["kind"]; content: string }[];
        return { results: rows.slice(0,limit).map(row => ({ sessionId,messageId: row.message_id,partId: row.part_id,kind: row.kind,messageSeq: row.message_seq,...searchSnippet(row.content,query) })), revision, hasMore: rows.length>limit };
      });
    },
    async getMessageSnapshot(sessionId, options) {
      return transaction(() => {
        const history = db.prepare("SELECT last_seq,revision FROM session_history WHERE session_id=?").get(sessionId) as { last_seq: number; revision: number } | undefined;
        const revision = history?.revision ?? 1;
        if (options.revision !== undefined && options.revision !== revision) throw new Error("HISTORY_REVISION_CONFLICT");
        let before = options.before ?? (history?.last_seq ?? 0) + 1;
        if (options.around || options.after !== undefined) {
          const target = options.around ? db.prepare("SELECT message_seq FROM messages WHERE session_id=? AND id=?").get(sessionId,options.around) as { message_seq: number } | undefined : undefined;
          if (options.around && !target) throw new Error("MESSAGE_NOT_FOUND");
          const count = options.around ? Math.ceil(options.limit/2) : options.limit;
          const next = db.prepare("SELECT message_seq FROM messages WHERE session_id=? AND message_seq>? ORDER BY message_seq LIMIT ?").all(sessionId,target ? target.message_seq-1 : options.after!,count) as { message_seq: number }[];
          before = (next.at(-1)?.message_seq ?? options.after ?? target!.message_seq)+1;
        }
        const messages = readMessages(sessionId,before,Math.max(1,Math.min(200,options.limit)));
        const first = messages[0]?.messageSeq;
        const hasMore = first !== undefined && !!db.prepare("SELECT 1 FROM messages WHERE session_id=? AND message_seq<? LIMIT 1").get(sessionId,first);
        const last = messages.at(-1)?.messageSeq;
        const hasMoreAfter = last !== undefined && !!db.prepare("SELECT 1 FROM messages WHERE session_id=? AND message_seq>? LIMIT 1").get(sessionId,last);
        const snapshotSeq = (db.prepare("SELECT COALESCE(MAX(seq),0) AS n FROM events WHERE session_id=?").get(sessionId) as { n: number }).n;
        const rewoundAt = (db.prepare("SELECT COALESCE(MAX(seq),0) AS n FROM events WHERE session_id=? AND type='session.rewound'").get(sessionId) as { n: number }).n;
        // Keep the latest completed run's artifacts and the current run's artifacts.
        const previousSummary = db.prepare("SELECT seq FROM events WHERE session_id=? AND type='session.summary' AND seq>? ORDER BY seq DESC LIMIT 1 OFFSET 1").get(sessionId,rewoundAt) as { seq: number } | undefined;
        const stateRows = db.prepare(`SELECT json FROM events WHERE session_id=? AND (
          seq IN (SELECT MAX(seq) FROM events WHERE session_id=? AND seq>? AND type IN ('session.status','todo.updated','session.summary','session.checkpoint') GROUP BY type)
          OR (type='artifact.created' AND seq>?)
          OR (type='permission.asked' AND seq>? AND NOT EXISTS (
            SELECT 1 FROM events replies WHERE replies.session_id=events.session_id AND replies.type='permission.replied' AND replies.seq>events.seq
              AND json_extract(replies.json,'$.data.id')=json_extract(events.json,'$.data.request.id')
          ))
        ) ORDER BY seq`).all(sessionId,sessionId,rewoundAt,previousSummary?.seq ?? rewoundAt,rewoundAt) as { json: string }[];
        const stateEvents = stateRows.map(row => JSON.parse(row.json) as PersistedFrameworkEvent);
        const runs = db.prepare("SELECT run_id AS runId,status,revision FROM workflow_runs WHERE session_id=? ORDER BY ordinal").all(sessionId) as { runId: string; status: WorkflowRun["status"]; revision: number }[];
        return { messages,revision,snapshotSeq,stateEvents,runs,readState: readState(sessionId),hasMore,nextBefore: hasMore ? first! : null,hasMoreAfter,nextAfter: hasMoreAfter ? last! : null };
      });
    },
    async deleteSession(id) {
      transaction(() => {
      // 级联删除：parts → messages → sessions（无外键，顺序删避免孤儿）
      db.prepare("DELETE FROM parts WHERE session_id = ?").run(id);
      db.prepare("DELETE FROM messages WHERE session_id = ?").run(id);
      db.prepare("DELETE FROM sessions WHERE id = ?").run(id);
      db.prepare("DELETE FROM session_history WHERE session_id=?").run(id);
      db.prepare("DELETE FROM workflow_runs WHERE session_id=?").run(id);
      db.prepare("DELETE FROM message_search WHERE session_id=?").run(id);
      db.prepare("DELETE FROM session_reads WHERE session_id=?").run(id);
      });
    },
    async truncateFrom(sessionId, fromMessageId) {
      transaction(() => truncateMessages(sessionId,fromMessageId));
    },
    async rewind(sessionId,fromMessageId) {
      return transaction(() => {
        truncateMessages(sessionId,fromMessageId);
        return appendEvent(sessionId,{ type: "session.rewound",data: { fromMessageId } });
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
      transaction(() => {
        db.prepare("UPDATE workflow_runs SET status='cancelled',revision=revision+1 WHERE session_id=? AND status IN ('queued','recovery_required')").run(sessionId);
        const session = getSessionRow(sessionId);
        if (!session) return;
        session.queuedPrompts = [];
        persistSession(session);
      });
    },

    // ---- 运行租约（spec §3.2，产品 P0）：runner 盖章/清除，lease recovery 扫描过期 ----
    async stamp(sessionId, owner, expiresAt) {
      const session = getSessionRow(sessionId);
      if (!session) return;
      session.leaseOwner = owner;
      session.leaseExpiresAt = expiresAt.toISOString();
      persistSession(session);
    },
    async clear(sessionId) {
      const session = getSessionRow(sessionId);
      if (!session?.leaseOwner && !session?.leaseExpiresAt) return;
      delete session.leaseOwner;
      delete session.leaseExpiresAt;
      persistSession(session);
    },
    async listExpiredLeases() {
      const now = Date.now();
      const rows = db.prepare("SELECT id, json FROM sessions WHERE json LIKE '%leaseExpiresAt%'").all() as { id: string; json: string }[];
      const expired: { sessionId: string }[] = [];
      for (const row of rows) {
        try {
          const session = JSON.parse(row.json) as SessionInfo;
          if (session.leaseOwner && session.leaseExpiresAt && Date.parse(session.leaseExpiresAt) < now) {
            expired.push({ sessionId: row.id });
            if (expired.length >= 50) break; // 上限：单轮恢复最多收尾 50 个
          }
        } catch {
          // skip corrupt rows
        }
      }
      return expired;
    },
    async clearLeaseIfExpired(sessionId) {
      return transaction(() => {
      const session = getSessionRow(sessionId);
      if (!session?.leaseOwner || !session.leaseExpiresAt) return false;
      if (Date.parse(session.leaseExpiresAt) >= Date.now()) return false; // 未过期：另一个持有者赢了竞争
      delete session.leaseOwner;
      delete session.leaseExpiresAt;
      persistSession(session);
      db.prepare("UPDATE workflow_runs SET status='recovery_required',revision=revision+1 WHERE session_id=? AND status='running'").run(sessionId);
      return true;
      });
    },

    // ---- WAL 收尾（P2）：优雅退出前把日志并回主库 ----
    async checkpoint() {
      db.exec("PRAGMA wal_checkpoint(TRUNCATE);");
    },

    // ---- 消息计数（N6）：会话列表元信息，一条 GROUP BY 拿全量 ----
    async countMessagesBySession() {
      const rows = db.prepare("SELECT session_id, COUNT(*) AS n FROM messages GROUP BY session_id").all() as { session_id: string; n: number }[];
      const map = new Map<string, number>();
      for (const row of rows) map.set(row.session_id, row.n);
      return map;
    },
  };
}

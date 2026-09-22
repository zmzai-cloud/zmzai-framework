import type { CompactionRecord, MessageInfo, MessageWithParts, Part, QueuedPrompt, SessionInfo } from "../session/types.js";

/** Persistence abstraction (spec §3.1). The Mongo implementation is the cloud
 *  default; a JSONL backend (wrapping PI harness/session) provides the
 *  zero-dependency local demo mode. Implementations must be safe under the
 *  framework's lease model: exactly one writer process per session. */
export interface SessionStore {
  getReadState?(sessionId: string): Promise<{ lastReadMessageSeq: number; unreadCount: number; latestMessageSeq: number; historyRevision: number }>;
  markRead?(sessionId: string, sequence: number, revision: number): Promise<{ lastReadMessageSeq: number; unreadCount: number; latestMessageSeq: number; historyRevision: number }>;
  workflow?: import("./workflow.js").WorkflowStore;
  /** 持久任务契约（规格 3 §13.4）。缺失时 runner 退化为无任务语义的一次性
   *  运行——工具、权限、事件全部照常，「自动续跑」与「可信完成判定」不可用。 */
  task?: import("../task/store.js").TaskStore;
  /** 压缩投影的跨 Attempt 状态（W7-S8）。可选：未提供的后端（JSONL demo）
   *  保持每 Attempt 重新摘要的旧行为。 */
  compaction?: { get(sessionId: string): Promise<CompactionRecord | null>; put(sessionId: string, record: CompactionRecord): Promise<void> };
  persistEvent?(event: import("../events/manifest.js").FrameworkEvent & { sessionId: string }): Promise<import("../events/manifest.js").PersistedFrameworkEvent>;
  createSession(info: SessionInfo): Promise<void>;
  getSession(id: string): Promise<SessionInfo | null>;
  updateSession(id: string, patch: Partial<SessionInfo>): Promise<void>;
  listSessions(filter: { userId: string; workspaceId?: string }): Promise<SessionInfo[]>;

  appendMessage(info: MessageInfo): Promise<void>;
  updateMessage(id: string, patch: Partial<MessageInfo>): Promise<void>;

  appendPart(part: Part): Promise<void>;
  updatePart(part: Part): Promise<void>;

  getMessages(sessionId: string): Promise<MessageWithParts[]>;
  searchMessages?(sessionId: string, options: { query: string; limit: number; after?: { messageSeq: number; partId: string }; revision?: number }): Promise<{
    results: import("./message-search.js").MessageSearchHit[]; revision: number; hasMore: boolean;
  }>;
  getMessageSnapshot?(sessionId: string, options: { before?: number; after?: number; around?: string; limit: number; revision?: number }): Promise<{
    messages: MessageWithParts[];
    revision: number;
    snapshotSeq: number;
    readState: { lastReadMessageSeq: number; unreadCount: number; latestMessageSeq: number; historyRevision: number };
    stateEvents: import("../events/manifest.js").PersistedFrameworkEvent[];
    runs: { runId: string; status: import("./workflow.js").WorkflowState; revision: number }[];
    /** 当前任务契约（规格 3 §13.3）：活跃任务优先，无活跃则最近一个终态任务。
     *  断线重连后 UI 靠它恢复「任务做到哪了」，无需回放全部 task 事件。 */
    task?: import("../task/types.js").TaskRecord | null;
    hasMore: boolean;
    nextBefore: number | null;
    hasMoreAfter: boolean;
    nextAfter: number | null;
  }>;

  /** 截断转录（回溯重发 / rewind）：删除 fromMessageId 及其后（store 排序）
   *  的所有消息与所属 parts。用于「编辑某条用户消息并从此重跑」——模型上下文
   *  每次 run 由 rebuildMessages 从 store 现场重建，截断持久层即可生效。
   *  Optional: backends that cannot truncate may omit it — callers must
   *  feature-check (`store.truncateFrom?.(...)`). 目标消息不存在时抛错。 */
  truncateFrom?(sessionId: string, fromMessageId: string): Promise<void>;
  rewind?(sessionId: string, fromMessageId: string): Promise<import("../events/manifest.js").PersistedFrameworkEvent>;

  /** Delete a session together with all its messages/parts. Optional:
   *  backends that cannot delete may omit it — callers must feature-check
   *  (`store.deleteSession?.(id)`). */
  deleteSession?(id: string): Promise<void>;

  /** Atomically enqueue a prompt; returns the updated queue length. */
  enqueuePrompt(sessionId: string, prompt: QueuedPrompt): Promise<number>;
  /** Atomically dequeue the oldest prompt; null when empty. */
  dequeuePrompt(sessionId: string): Promise<QueuedPrompt | null>;
  clearQueuedPrompts(sessionId: string): Promise<void>;
}

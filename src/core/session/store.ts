import type { MessageInfo, MessageWithParts, Part, QueuedPrompt, SessionInfo } from "../session/types.js";

/** Persistence abstraction (spec §3.1). The Mongo implementation is the cloud
 *  default; a JSONL backend (wrapping PI harness/session) provides the
 *  zero-dependency local demo mode. Implementations must be safe under the
 *  framework's lease model: exactly one writer process per session. */
export interface SessionStore {
  getReadState?(sessionId: string): Promise<{ lastReadMessageSeq: number; unreadCount: number; latestMessageSeq: number; historyRevision: number }>;
  markRead?(sessionId: string, sequence: number, revision: number): Promise<{ lastReadMessageSeq: number; unreadCount: number; latestMessageSeq: number; historyRevision: number }>;
  workflow?: import("./workflow.js").WorkflowStore;
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

import type { MessageInfo, MessageWithParts, Part, QueuedPrompt, SessionInfo } from "../session/types.js";

/** Persistence abstraction (spec §3.1). The Mongo implementation is the cloud
 *  default; a JSONL backend (wrapping PI harness/session) provides the
 *  zero-dependency local demo mode. Implementations must be safe under the
 *  framework's lease model: exactly one writer process per session. */
export interface SessionStore {
  createSession(info: SessionInfo): Promise<void>;
  getSession(id: string): Promise<SessionInfo | null>;
  updateSession(id: string, patch: Partial<SessionInfo>): Promise<void>;
  listSessions(filter: { userId: string; workspaceId?: string }): Promise<SessionInfo[]>;

  appendMessage(info: MessageInfo): Promise<void>;
  updateMessage(id: string, patch: Partial<MessageInfo>): Promise<void>;

  appendPart(part: Part): Promise<void>;
  updatePart(part: Part): Promise<void>;

  getMessages(sessionId: string): Promise<MessageWithParts[]>;

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

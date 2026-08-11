import type { FrameworkEvent, FrameworkEventType, PersistedFrameworkEvent } from "./manifest.js";
import { frameworkEventSchemas } from "./manifest.js";
import { newEventId } from "../session/ids.js";

/** EventLog (spec §4.1 abstracted for M5): the durable per-session event log.
 *  The framework ships an in-memory implementation (below) and a JSONL one;
 *  the product supplies a Mongo implementation (see zmzai-agent's
 *  framework/core/events/mongo-event-log.ts). All methods must be safe under
 *  the single-writer-per-session lease model. */
export interface EventLog {
  /** Persists one validated event, allocating the next per-session seq. */
  append(event: FrameworkEvent & { sessionId: string }): Promise<PersistedFrameworkEvent>;
  /** Reads events with seq > sinceSeq, ascending, capped at limit. */
  read(sessionId: string, sinceSeq: number, limit: number): Promise<PersistedFrameworkEvent[]>;
  /** Raw record count (stats/audit). */
  count(sessionId: string): Promise<number>;
}

// ---- In-memory implementation (single-process demo/tests) ----

export function createMemoryEventLog(): EventLog {
  const store = new Map<string, PersistedFrameworkEvent[]>();
  return {
    async append(event) {
      const schema = frameworkEventSchemas[event.type as FrameworkEventType];
      const parsed = schema.safeParse(event.data);
      if (!parsed.success) throw new Error(`INVALID_FRAMEWORK_EVENT: ${event.type} ${parsed.error.issues[0]?.message ?? ""}`);
      const list = store.get(event.sessionId) ?? [];
      const persisted: PersistedFrameworkEvent = {
        id: newEventId(),
        sessionId: event.sessionId,
        seq: list.length + 1,
        type: event.type as FrameworkEventType,
        data: parsed.data as never,
        at: new Date().toISOString(),
      };
      list.push(persisted);
      store.set(event.sessionId, list);
      return persisted;
    },
    async read(sessionId, sinceSeq, limit) {
      const list = store.get(sessionId) ?? [];
      return list.filter((event) => event.seq > sinceSeq).slice(0, limit);
    },
    async count(sessionId) {
      return (store.get(sessionId) ?? []).length;
    },
  };
}

// ---- Shared bus helpers (live fan-out + replay-merge) ----

type LiveListener = (event: PersistedFrameworkEvent) => void;

export type SubscribeOptions = {
  sinceSeq?: number; // replay events with seq > sinceSeq before/live-merged
  pollIntervalMs?: number; // catch-up cadence for cross-process events
  signal?: AbortSignal;
};

/** Subscribes to a session's event stream: durable catch-up via log.read, then
 *  live delivery via the in-process listener registry. Cross-process delivery
 *  (product's Mongo log) works because log.read polls the durable store. */
export async function* subscribeEventLog(log: EventLog, sessionId: string, options: SubscribeOptions = {}): AsyncIterable<PersistedFrameworkEvent> {
  const pollIntervalMs = options.pollIntervalMs ?? 1_000;
  let cursor = options.sinceSeq ?? 0;
  const queue: PersistedFrameworkEvent[] = [];
  let wake: (() => void) | null = null;
  let done = false;

  const listener = (event: PersistedFrameworkEvent) => {
    if (event.seq <= cursor) return;
    queue.push(event);
    wake?.();
  };
  const registered = listeners.get(sessionId) ?? new Set<LiveListener>();
  registered.add(listener);
  listeners.set(sessionId, registered);

  const onAbort = () => {
    done = true;
    wake?.();
  };
  options.signal?.addEventListener("abort", onAbort, { once: true });

  try {
    while (!done) {
      const missed = await log.read(sessionId, cursor, 500);
      for (const record of missed) {
        if (record.seq <= cursor) continue;
        queue.push(record);
      }
      queue.sort((a, b) => a.seq - b.seq);
      while (queue.length && queue[0]!.seq > cursor) {
        const event = queue.shift()!;
        cursor = event.seq;
        yield event;
      }
      queue.length = 0;
      if (done) break;

      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          wake = null;
          resolve();
        }, pollIntervalMs);
        wake = () => {
          clearTimeout(timer);
          wake = null;
          resolve();
        };
        if (done) {
          clearTimeout(timer);
          resolve();
        }
      });
    }
  } finally {
    options.signal?.removeEventListener("abort", onAbort);
    registered.delete(listener);
    if (registered.size === 0) listeners.delete(sessionId);
  }
}

/** In-process live fan-out registry shared by subscribeEventLog consumers. */
const listeners = new Map<string, Set<LiveListener>>();

/** Notifies live subscribers (called by framework when an event is appended —
 *  the runner does this after EventLog.append). */
export function notifyEventLogListeners(event: PersistedFrameworkEvent): void {
  for (const listener of listeners.get(event.sessionId) ?? []) {
    try {
      listener(event);
    } catch {
      // A throwing subscriber must never break the publish path.
    }
  }
}

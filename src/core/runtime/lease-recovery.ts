import type { EventLog } from "../events/bus.js";
import { notifyEventLogListeners } from "../events/bus.js";
import type { FrameworkEvent, TodoItem } from "../events/manifest.js";
import type { Part } from "../session/types.js";
import type { SessionStore } from "../session/store.js";

/** Lease recovery (spec §3.2): the runner stamps a lease on the session
 *  document while it owns a run. A periodic scan reclaims sessions whose lease
 *  lapsed without a live owner (process crash/restart), emitting a settle
 *  event so clients don't sit on a stale "running" status forever.
 *
 *  Storage-agnostic (M5): the session store owns the lease fields; recovery
 *  only needs a list + clear. Implementations provide the store-specific
 *  `listExpiredLeases` / `clearLeaseIfExpired`. */

export const scanIntervalMs = 60_000;
export const leaseDurationMs = 10 * 60 * 1000;

export type LeaseRecoveryStore = {
  /** Sessions whose lease lapsed (leaseExpiresAt < now), capped. */
  listExpiredLeases(): Promise<{ sessionId: string }[]>;
  /** Clears the lease if it is still expired; false if another won the race. */
  clearLeaseIfExpired(sessionId: string): Promise<boolean>;
};

const globalRecovery = globalThis as typeof globalThis & { __zmzaiFrameworkLeaseTimer?: ReturnType<typeof setInterval> };

/** Interrupted-run finalization (product P2): when a run dies with its lease
 *  (crash/restart), the run's in-flight projections would otherwise stay
 *  frozen mid-run forever — a pending permission card, tool parts stuck
 *  "running", todos stuck "in_progress". The event log is the projection's
 *  single source of truth, so recovery derives the leftovers from it and
 *  folds each into a terminal state (replied/reject, tool error, cancelled),
 *  both in the store and as appended events. Idempotent: a second pass finds
 *  no pending leftovers. */
export async function finalizeInterruptedRun(input: { sessionId: string; log: EventLog; store: SessionStore }): Promise<void> {
  const events = await input.log.read(input.sessionId, 0, 1_000);
  const append = async (event: FrameworkEvent) => {
    const persisted = await input.log.append({ sessionId: input.sessionId, ...event }).catch(() => null);
    if (persisted) notifyEventLogListeners(persisted);
  };

  // 1. Pending permission: a `permission.asked` with no later `replied` for
  //    the same request id. Fold it to `reject` so the card clears.
  for (const asked of events) {
    if (asked.type !== "permission.asked") continue;
    const requestId = asked.data.request.id;
    const repliedAfter = events.some((event) => event.type === "permission.replied" && event.data.id === requestId);
    if (repliedAfter) continue;
    await append({ type: "permission.replied", data: { id: requestId, reply: "reject" } });
  }

  // 2. Tool parts stuck running/pending: fold each to a terminal error state
  //    (store + event). New runs use fresh part ids, so this never touches a
  //    live run's parts.
  type ToolPart = Extract<Part, { type: "tool" }>;
  const runningParts = new Map<string, ToolPart>();
  for (const event of events) {
    if (event.type !== "message.part.updated") continue;
    const part = event.data.part;
    if (part.type !== "tool") continue;
    if (part.state.status === "running" || part.state.status === "pending") runningParts.set(part.id, part);
    else runningParts.delete(part.id);
  }
  for (const part of runningParts.values()) {
    const started = part.state.status === "pending" ? new Date().toISOString() : part.state.time.start;
    const terminal: Part = {
      ...part,
      state: {
        status: "error",
        input: part.state.input,
        error: "运行因服务重启中断，可在同一会话继续。",
        time: { start: started, end: new Date().toISOString() },
      },
    } as Extract<Part, { type: "tool" }>;
    await input.store.updatePart(terminal).catch(() => undefined);
    await append({ type: "message.part.updated", data: { part: terminal } });
  }

  // 3. Todos stuck in flight: mark pending/in_progress items cancelled. Todos
  //    are event-only (no store row), so an appended event suffices.
  const lastTodo = [...events].reverse().find((event) => event.type === "todo.updated");
  if (lastTodo) {
    const todos = lastTodo.data.todos;
    if (todos.some((item) => item.status === "pending" || item.status === "in_progress")) {
      const settled = todos.map((item) => (item.status === "pending" || item.status === "in_progress" ? { ...item, status: "cancelled" as const } : item));
      await append({ type: "todo.updated", data: { todos: settled } });
    }
  }
}

export async function reclaimExpiredLeases(input: { store: LeaseRecoveryStore; log: EventLog; finalizeStore?: SessionStore }): Promise<void> {
  const expired = await input.store.listExpiredLeases();
  for (const session of expired) {
    const reclaimed = await input.store.clearLeaseIfExpired(session.sessionId);
    if (!reclaimed) continue; // another scanner won the race
    const events: Array<{ type: "session.status" | "session.error"; data: { status?: "idle"; name?: string; message?: string } }> = [
      { type: "session.status", data: { status: "idle" } },
      { type: "session.error", data: { name: "LeaseExpired", message: "运行因服务重启中断，可在同一会话继续。" } },
    ];
    for (const event of events) {
      const persisted = await input.log.append({
        sessionId: session.sessionId,
        type: event.type,
        data: event.data as never,
      }).catch(() => null);
      if (persisted) notifyEventLogListeners(persisted);
    }
    if (input.finalizeStore) {
      await finalizeInterruptedRun({ sessionId: session.sessionId, log: input.log, store: input.finalizeStore }).catch(() => undefined);
    }
  }
}

export function startLeaseRecovery(input: { store: LeaseRecoveryStore; log: EventLog; finalizeStore?: SessionStore }): void {
  if (globalRecovery.__zmzaiFrameworkLeaseTimer) return;
  globalRecovery.__zmzaiFrameworkLeaseTimer = setInterval(() => {
    void reclaimExpiredLeases(input).catch(() => undefined);
  }, scanIntervalMs);
  globalRecovery.__zmzaiFrameworkLeaseTimer.unref?.();
}

export { leaseDurationMs as fwLeaseDurationMs };

import type { EventLog } from "../events/bus.js";
import { notifyEventLogListeners } from "../events/bus.js";

/** Lease recovery (spec §3.2): the runner stamps a lease on the session
 *  document while it owns a run. A periodic scan reclaims sessions whose lease
 *  lapsed without a live owner (process crash/restart), emitting a settle
 *  event so clients don't sit on a stale "running" status forever.
 *
 *  Storage-agnostic (M5): the session store owns the lease fields; recovery
 *  only needs a list + clear. Implementations provide the store-specific
 *  `listExpiredLeases` / `clearLease`. */

export const scanIntervalMs = 60_000;
export const leaseDurationMs = 10 * 60 * 1000;

export type LeaseRecoveryStore = {
  /** Sessions whose lease lapsed (leaseExpiresAt < now), capped. */
  listExpiredLeases(): Promise<{ sessionId: string }[]>;
  /** Clears the lease if it is still expired; false if another won the race. */
  clearLeaseIfExpired(sessionId: string): Promise<boolean>;
};

const globalRecovery = globalThis as typeof globalThis & { __zmzaiFrameworkLeaseTimer?: ReturnType<typeof setInterval> };

export async function reclaimExpiredLeases(input: { store: LeaseRecoveryStore; log: EventLog }): Promise<void> {
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
  }
}

export function startLeaseRecovery(input: { store: LeaseRecoveryStore; log: EventLog }): void {
  if (globalRecovery.__zmzaiFrameworkLeaseTimer) return;
  globalRecovery.__zmzaiFrameworkLeaseTimer = setInterval(() => {
    void reclaimExpiredLeases(input).catch(() => undefined);
  }, scanIntervalMs);
  globalRecovery.__zmzaiFrameworkLeaseTimer.unref?.();
}

export { leaseDurationMs as fwLeaseDurationMs };

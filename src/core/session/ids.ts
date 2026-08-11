import { randomUUID } from "node:crypto";

/** Prefixed ascending-ish IDs, aligned with the v0 wire spec (§2). */
export function newSessionId(): string {
  return `ses_${randomUUID()}`;
}

export function newMessageId(): string {
  return `msg_${randomUUID()}`;
}

export function newPartId(): string {
  return `prt_${randomUUID()}`;
}

export function newPermissionRequestId(): string {
  return `per_${randomUUID()}`;
}

export function newEventId(): string {
  return `evt_${randomUUID()}`;
}

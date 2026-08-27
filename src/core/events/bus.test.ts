import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("node:crypto", () => {
  let counter = 0;
  return {
    randomUUID: () => `test-uuid-${++counter}`,
  };
});

import { createMemoryEventLog, notifyEventLogListeners, subscribeEventLog } from "./bus.js";
import type { FrameworkEvent, PersistedFrameworkEvent } from "./manifest.js";

beforeEach(() => {
  vi.clearAllMocks();
});

// ---- createMemoryEventLog ----

describe("createMemoryEventLog", () => {
  const statusEvent = (status: "idle" | "running") =>
    ({ type: "session.status", data: { status } }) as unknown as FrameworkEvent & { sessionId: string };

  it("appends events with sequential seq numbers per session", async () => {
    const log = createMemoryEventLog();
    const e1 = await log.append({ ...statusEvent("running"), sessionId: "ses_1" });
    const e2 = await log.append({ ...statusEvent("idle"), sessionId: "ses_1" });
    expect(e1.seq).toBe(1);
    expect(e2.seq).toBe(2);
    expect(e1.id).toMatch(/^evt_/);
    expect(e1.sessionId).toBe("ses_1");
    expect(e1.type).toBe("session.status");
  });

  it("isolates events between sessions", async () => {
    const log = createMemoryEventLog();
    await log.append({ ...statusEvent("running"), sessionId: "ses_a" });
    await log.append({ ...statusEvent("running"), sessionId: "ses_b" });
    const eA2 = await log.append({ ...statusEvent("idle"), sessionId: "ses_a" });
    expect(eA2.seq).toBe(2); // ses_a has 2 events
    const countB = await log.count("ses_b");
    expect(countB).toBe(1);
  });

  it("validates event data against schema", async () => {
    const log = createMemoryEventLog();
    const badEvent = { type: "session.status", data: { status: "invalid_status" }, sessionId: "ses_x" } as unknown as FrameworkEvent & { sessionId: string };
    await expect(log.append(badEvent)).rejects.toThrow("INVALID_FRAMEWORK_EVENT");
  });

  it("read returns events after sinceSeq, capped at limit", async () => {
    const log = createMemoryEventLog();
    await log.append({ ...statusEvent("running"), sessionId: "ses_1" });
    await log.append({ ...statusEvent("idle"), sessionId: "ses_1" });
    const e3 = await log.append({ ...statusEvent("running"), sessionId: "ses_1" });

    const result = await log.read("ses_1", 1, 10);
    expect(result).toHaveLength(2);
    expect(result[0]!.seq).toBe(2);
    expect(result[1]!.seq).toBe(3);

    const limited = await log.read("ses_1", 0, 2);
    expect(limited).toHaveLength(2);
  });

  it("read returns empty array for unknown session", async () => {
    const log = createMemoryEventLog();
    const result = await log.read("ses_unknown", 0, 100);
    expect(result).toEqual([]);
  });

  it("count returns 0 for unknown session", async () => {
    const log = createMemoryEventLog();
    expect(await log.count("ses_none")).toBe(0);
  });

  it("stores validated data (not raw input)", async () => {
    const log = createMemoryEventLog();
    const event = { type: "session.status", data: { status: "running" }, sessionId: "ses_1" } as FrameworkEvent & { sessionId: string };
    const persisted = await log.append(event);
    expect(persisted.data).toEqual({ status: "running" });
    expect(persisted.at).toBeTruthy();
  });
});

// ---- notifyEventLogListeners ----

describe("notifyEventLogListeners", () => {
  it("delivers events to subscribers of the same session", async () => {
    const log = createMemoryEventLog();
    const received: PersistedFrameworkEvent[] = [];

    const ac = new AbortController();
    const gen = subscribeEventLog(log, "ses_1", { signal: ac.signal, pollIntervalMs: 50 });
    // Start consuming in background
    const consuming = (async () => {
      for await (const event of gen) {
        received.push(event);
        if (received.length >= 1) break;
      }
    })();

    // Append and notify
    const persisted = await log.append({ type: "session.status", data: { status: "running" }, sessionId: "ses_1" } as unknown as FrameworkEvent & { sessionId: string });
    notifyEventLogListeners(persisted);

    await consuming;
    ac.abort();
    expect(received).toHaveLength(1);
    expect(received[0]!.type).toBe("session.status");
  });

  it("does not deliver events for different sessions", async () => {
    const log = createMemoryEventLog();
    const received: PersistedFrameworkEvent[] = [];

    const ac = new AbortController();
    const gen = subscribeEventLog(log, "ses_1", { signal: ac.signal, pollIntervalMs: 50 });
    const consuming = (async () => {
      const timeout = setTimeout(() => ac.abort(), 200);
      try {
        for await (const event of gen) {
          received.push(event);
        }
      } finally {
        clearTimeout(timeout);
      }
    })();

    // Append to DIFFERENT session
    const persisted = await log.append({ type: "session.status", data: { status: "running" }, sessionId: "ses_other" } as unknown as FrameworkEvent & { sessionId: string });
    notifyEventLogListeners(persisted);

    await consuming;
    expect(received).toHaveLength(0);
  });

  it("a throwing listener does not break notifyEventLogListeners", async () => {
    const log = createMemoryEventLog();
    const received: PersistedFrameworkEvent[] = [];

    const ac = new AbortController();
    // First subscriber throws
    const gen1 = subscribeEventLog(log, "ses_1", { signal: ac.signal, pollIntervalMs: 50 });
    const consuming1 = (async () => {
      try {
        for await (const event of gen1) {
          throw new Error("subscriber crash");
        }
      } catch {
        // expected
      }
    })();

    // Second subscriber collects
    const gen2 = subscribeEventLog(log, "ses_1", { signal: ac.signal, pollIntervalMs: 50 });
    const consuming2 = (async () => {
      for await (const event of gen2) {
        received.push(event);
        if (received.length >= 1) break;
      }
    })();

    const persisted = await log.append({ type: "session.status", data: { status: "running" }, sessionId: "ses_1" } as unknown as FrameworkEvent & { sessionId: string });
    notifyEventLogListeners(persisted);

    await consuming1;
    await consuming2;
    ac.abort();
    expect(received).toHaveLength(1);
  });
});

// ---- subscribeEventLog ----

describe("subscribeEventLog", () => {
  it("replays past events from the log", async () => {
    const log = createMemoryEventLog();
    await log.append({ type: "session.status", data: { status: "running" }, sessionId: "ses_1" } as unknown as FrameworkEvent & { sessionId: string });
    await log.append({ type: "session.status", data: { status: "idle" }, sessionId: "ses_1" } as unknown as FrameworkEvent & { sessionId: string });

    const ac = new AbortController();
    const received: PersistedFrameworkEvent[] = [];
    const gen = subscribeEventLog(log, "ses_1", { signal: ac.signal, pollIntervalMs: 50 });

    const consuming = (async () => {
      for await (const event of gen) {
        received.push(event);
        if (received.length >= 2) break;
      }
    })();

    await consuming;
    ac.abort();
    expect(received).toHaveLength(2);
    expect(received[0]!.seq).toBe(1);
    expect(received[1]!.seq).toBe(2);
  });

  it("respects sinceSeq option for replay", async () => {
    const log = createMemoryEventLog();
    await log.append({ type: "session.status", data: { status: "running" }, sessionId: "ses_1" } as unknown as FrameworkEvent & { sessionId: string });
    await log.append({ type: "session.status", data: { status: "idle" }, sessionId: "ses_1" } as unknown as FrameworkEvent & { sessionId: string });

    const ac = new AbortController();
    const received: PersistedFrameworkEvent[] = [];
    const gen = subscribeEventLog(log, "ses_1", { sinceSeq: 1, signal: ac.signal, pollIntervalMs: 50 });

    const consuming = (async () => {
      for await (const event of gen) {
        received.push(event);
        if (received.length >= 1) break;
      }
    })();

    await consuming;
    ac.abort();
    expect(received).toHaveLength(1);
    expect(received[0]!.seq).toBe(2);
  });

  it("stops when abort signal fires", async () => {
    const log = createMemoryEventLog();
    const ac = new AbortController();
    const gen = subscribeEventLog(log, "ses_1", { signal: ac.signal, pollIntervalMs: 50 });

    const consuming = (async () => {
      const events: PersistedFrameworkEvent[] = [];
      for await (const event of gen) {
        events.push(event);
      }
      return events;
    })();

    // Abort after a short delay
    setTimeout(() => ac.abort(), 100);
    const events = await consuming;
    expect(events).toHaveLength(0);
  });
});

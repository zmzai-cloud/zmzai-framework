import type { EventLog } from "../events/bus.js";
import { notifyEventLogListeners } from "../events/bus.js";
import type { FrameworkEvent, PersistedFrameworkEvent } from "../events/manifest.js";
import type { Part } from "../session/types.js";
import type { SessionStore } from "../session/store.js";
import { lifecycleForBlocker } from "../task/completion.js";
import { isTerminalStatus, isWaitingStatus, type TaskBlocker } from "../task/types.js";

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
  const events: PersistedFrameworkEvent[] = [];
  let cursor = 0;
  while (true) {
    const page = await input.log.read(input.sessionId, cursor, 1_000);
    events.push(...page);
    if (page.length < 1_000) break;
    cursor = page[page.length - 1]!.seq;
  }
  const append = async (event: FrameworkEvent) => {
    const payload = { sessionId: input.sessionId, ...event };
    const persisted = input.store.persistEvent
      ? await input.store.persistEvent(payload)
      : await input.log.append(payload);
    if (persisted) notifyEventLogListeners(persisted);
  };

  // 1. Pending permission: a `permission.asked` with no later `replied` for
  //    the same request id. Fold it to `reject` so the card clears.
  //
  //    被折叠的请求对应的工具调用记进 `rejectedCallIds`：这些调用**从未真正
  //    执行过**（授权卡在 beforeToolCall 上），下面判定「有没有未知副作用」时
  //    必须把它们排除，否则「等待授权时退出应用」会被误报成「可能有写操作
  //    已经落地」，让用户去核对一个根本没发生的变化（规格 §10.2 的反向误报）。
  const rejectedCallIds = new Set<string>();
  for (const asked of events) {
    if (asked.type !== "permission.asked") continue;
    const requestId = asked.data.request.id;
    const repliedAfter = events.some((event) => event.type === "permission.replied" && event.data.id === requestId);
    if (repliedAfter) continue;
    const callId = asked.data.request.tool?.callId;
    if (callId) rejectedCallIds.add(callId);
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
  // 判定「有没有未知副作用」：真正**执行过**却没收尾的工具调用。等待授权时被
  // 折叠成 reject 的那些从未开始执行，不算。这个布尔值决定任务恢复成
  // unsafe_replay（必须先核对外部状态）还是 input（确认一次即可继续）。
  const unknownSideEffect = [...runningParts.values()].some((part) => !rejectedCallIds.has(part.callId));

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
    if (!input.store.persistEvent) await input.store.updatePart(terminal);
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

  // 4. 任务层对账（规格 3 §11 / §16 阶段 D）。崩溃时正在跑的任务必须在这里
  //    落一个「说得清」的状态，否则 `TaskRecord.status` 会永远停在 `running`：
  //    界面会一直转圈，用户既看不到原因也没有可点的按钮。
  //
  //    不判 failed——一次崩溃不等于用户目标不可达（规格 §10.2 把这类归为
  //    recovering）。落成「等人拍板」：有执行过却没收尾的工具调用 → unsafe_replay，
  //    重放前必须核对外部状态（§10.2 明令不得自动重放未知副作用）；否则只是被
  //    打断 → input，用户确认一次就从中断处继续。两种都可恢复，只是要求不同。
  const taskStore = input.store.task;
  if (taskStore) {
    const task = await taskStore.getActiveTask(input.sessionId).catch(() => null);
    // 终态不用动（任务已经结束）。**已经处于 waiting_* / blocked 的也不动**：
    // 它本来就停在「等用户做点什么」，再写一遍只会白跳一次 revision 并重复发一条
    // `task.blocked`，还可能用这里较笼统的原因盖掉先前更具体的那一个。
    if (task && !isTerminalStatus(task.status) && !isWaitingStatus(task.status)) {
      const blocker: TaskBlocker = unknownSideEffect
        ? {
            kind: "unsafe_replay",
            message: "应用在任务完成前中断，有一个动作可能已经产生了副作用但没有拿到结果。",
            requiredAction: "先核对工作区与外部系统（文件、提交、远端页面）的实际状态，再决定继续或重做。",
            resumable: true,
          }
        : {
            kind: "input",
            message: "应用在任务完成前中断，任务停在了中途。",
            requiredAction: "确认工作区状态没有异常后继续，任务会从中断处接着做，不会从头重做。",
            resumable: true,
          };
      const updated = await taskStore
        .updateTask(task.id, task.revision, { status: lifecycleForBlocker(blocker.kind), blocker })
        .catch(() => null);
      if (updated) await append({ type: "task.blocked", data: { taskId: updated.id, revision: updated.revision, blocker } });
    }
  }
}

export async function reclaimExpiredLeases(input: { store: LeaseRecoveryStore; log: EventLog; finalizeStore?: SessionStore }): Promise<void> {
  const expired = await input.store.listExpiredLeases();
  for (const session of expired) {
    const reclaimed = await input.store.clearLeaseIfExpired(session.sessionId);
    if (!reclaimed) continue; // another scanner won the race
    const workflow = input.finalizeStore?.workflow;
    if (workflow) await workflow.recoverInterrupted(session.sessionId).catch(() => undefined);
    const events: Array<{ type: "session.status" | "session.error"; data: { status?: "idle"; name?: string; message?: string } }> = [
      { type: "session.error", data: { name: "LeaseExpired", message: "运行因服务重启中断，可在同一会话继续。" } },
      { type: "session.status", data: { status: "idle" } },
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
  // A process may restart immediately after a lease has expired. Do one scan
  // on startup so those sessions do not remain stale until the first interval.
  void reclaimExpiredLeases(input).catch(() => undefined);
  globalRecovery.__zmzaiFrameworkLeaseTimer = setInterval(() => {
    void reclaimExpiredLeases(input).catch(() => undefined);
  }, scanIntervalMs);
  globalRecovery.__zmzaiFrameworkLeaseTimer.unref?.();
}

export { leaseDurationMs as fwLeaseDurationMs };

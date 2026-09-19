import { describe, expect, it } from "vitest";

import { frameworkEventSchemas, parseFrameworkEvent, toPersistedEvent, type FrameworkEventType } from "./manifest.js";

/** 任务事件的线协议测试（规格 3 §7）。 */
describe("task 事件 schema", () => {
  const base = { taskId: "task_1", revision: 3 };
  const progress = { ...base, message: "正在写入第 4–8 页", completedSteps: 2, totalSteps: 6 };

  const samples: Record<string, unknown> = {
    "task.started": { ...base, goal: "铺 PDF", steps: [], acceptanceCriteria: [] },
    "task.plan.updated": { ...base, goal: "铺 PDF", steps: [{ id: "s1", title: "解析 PDF", status: "pending" }], completedSteps: 0, totalSteps: 1 },
    "task.step.started": progress,
    "task.step.progress": { ...progress, stepId: "s2", evidenceId: "evd_1" },
    "task.step.completed": progress,
    "task.attempt.finished": { ...base, attempt: 2, outcome: "completed", toolCalls: 7, filesEdited: 3, durationMs: 12_000 },
    "task.recovery.started": { ...base, message: "服务重启后继续", attempt: 3 },
    "task.blocked": { ...base, blocker: { kind: "external_auth", message: "凭据失效", requiredAction: "登录", resumable: true } },
    "task.verification.started": { ...base, message: "开始验证" },
    "task.delivered": { ...base, result: "铺好了", delivery: { outcome: "铺好了", changes: [], verification: ["pnpm build 通过"], remaining: [] }, criteria: [], evidenceCount: 1, evidenceIds: ["evd_1"], filesEdited: 3, toolCalls: 7, durationMs: 12_000 },
    "task.failed": { ...base, reason: "需求本身无法完成" },
    "task.cancelled": { ...base, reason: "用户停止" },
  };

  it("每个任务事件都在 manifest 里注册且能通过校验", () => {
    for (const [type, data] of Object.entries(samples)) {
      const schema = frameworkEventSchemas[type as FrameworkEventType];
      expect(schema, `${type} 未注册`).toBeDefined();
      expect(schema!.safeParse(data).success, `${type} 校验失败`).toBe(true);
    }
  });

  // 规格 §7：所有事件都带 taskId 和 revision
  it("缺少 taskId 或 revision 的事件被拒", () => {
    const schema = frameworkEventSchemas["task.step.progress"];
    expect(schema.safeParse({ ...progress, taskId: undefined }).success).toBe(false);
    expect(schema.safeParse({ ...progress, revision: undefined }).success).toBe(false);
    expect(schema.safeParse({ ...progress, revision: "3" }).success).toBe(false);
  });

  it("blocker kind 只接受契约里列出的七种", () => {
    const schema = frameworkEventSchemas["task.blocked"];
    const build = (kind: string) => ({ ...base, blocker: { kind, message: "m", requiredAction: "a", resumable: true } });
    for (const kind of ["permission", "input", "choice", "external_auth", "unsafe_replay", "budget", "no_progress"]) {
      expect(schema.safeParse(build(kind)).success, kind).toBe(true);
    }
    expect(schema.safeParse(build("meltdown")).success).toBe(false);
  });

  it("attempt.finished 的 outcome 只有三种，不含 delivered", () => {
    const schema = frameworkEventSchemas["task.attempt.finished"];
    const build = (outcome: string) => ({ ...base, attempt: 1, outcome, toolCalls: 0, filesEdited: 0, durationMs: 1 });
    expect(schema.safeParse(build("completed")).success).toBe(true);
    expect(schema.safeParse(build("error")).success).toBe(true);
    expect(schema.safeParse(build("aborted")).success).toBe(true);
    // 「一次 Attempt 结束」绝不能表达成「任务交付」——这是 §8.3 的核心区分
    expect(schema.safeParse(build("delivered")).success).toBe(false);
  });

  it("parseFrameworkEvent 能识别任务事件", () => {
    const parsed = parseFrameworkEvent({ type: "task.delivered", data: samples["task.delivered"] });
    expect(parsed?.type).toBe("task.delivered");
  });

  // 交付卡上「验收 x/y · 证据 n 条」这两个数字此前**无从取得**：事件流里没有任何
  // task.* 事件携带验收条件终态或证据条数，客户端只能拿 task.started 那一刻的快照
  // （恒为全 pending）去画，于是界面上永远显示 0/n——与实际相反，而那一行恰恰是
  // 规格 §18.4 给用户「不必相信这句完成」的核对依据。
  // 三个字段因此都是**必填**：缺失时宁可让帧解析失败，也不要让客户端静默退回一个
  // 恒错的默认值。
  it("task.delivered 必须带上四问、验收条件终态与证据条数", () => {
    const schema = frameworkEventSchemas["task.delivered"];
    // `samples` 是 unknown 值表，spread 前要先收窄——三个反例都是「抽掉一个字段」，
    // 直接写 `{ ...full, delivery: undefined }` 会在 tsc 层就报 TS2698。
    const full = samples["task.delivered"] as Record<string, unknown>;
    expect(schema.safeParse(full).success).toBe(true);
    expect(schema.safeParse({ ...full, delivery: undefined }).success).toBe(false);
    expect(schema.safeParse({ ...full, criteria: undefined }).success).toBe(false);
    expect(schema.safeParse({ ...full, evidenceCount: undefined }).success).toBe(false);
  });

  it("parseFrameworkEvent 对非法载荷返回 null（SSE 帧可能被截断）", () => {
    expect(parseFrameworkEvent({ type: "task.delivered", data: { taskId: "t" } })).toBeNull();
    expect(parseFrameworkEvent({ type: "task.nonexistent", data: {} })).toBeNull();
  });
});

describe("向后兼容（规格 §7 保留读取旧事件的能力）", () => {
  it("旧的 session.summary 仍能解析——历史重放不能挂", () => {
    const parsed = parseFrameworkEvent({
      type: "session.summary",
      data: { text: "本轮完成", kind: "completed", meta: { filesEdited: 1, toolCalls: 2, durationMs: 100 } },
    });
    expect(parsed?.type).toBe("session.summary");
  });

  it("旧的 todo.updated 仍能解析（迁移期双向投影）", () => {
    const parsed = parseFrameworkEvent({ type: "todo.updated", data: { todos: [{ content: "解析 PDF", status: "completed" }] } });
    expect(parsed?.type).toBe("todo.updated");
  });

  it("旧事件里没有 taskId 也不受影响", () => {
    expect(frameworkEventSchemas["session.checkpoint"].safeParse({ toolCalls: 3, elapsedMs: 1000 }).success).toBe(true);
  });
});

describe("toPersistedEvent", () => {
  it("补上 id/sessionId/seq/at 后即是持久化记录", () => {
    const persisted = toPersistedEvent({
      id: "evt_1",
      sessionId: "ses_1",
      seq: 7,
      type: "task.step.completed",
      data: { taskId: "task_1", revision: 2, message: "完成了解析", completedSteps: 1, totalSteps: 6 },
      at: "2026-09-18T00:00:00.000Z",
    });
    expect(persisted.seq).toBe(7);
    expect(persisted.type).toBe("task.step.completed");
    expect((persisted.data as { taskId: string }).taskId).toBe("task_1");
  });
});

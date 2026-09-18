import { describe, expect, it } from "vitest";

import { advanceProgress, taskFingerprint } from "./progress.js";
import type { AcceptanceCriterion, TaskEvidence, TaskRecord, TaskStep } from "./types.js";

function taskOf(overrides: Partial<TaskRecord> = {}): TaskRecord {
  return {
    id: "task_1",
    sessionId: "ses_1",
    rootRequestId: "req_1",
    rootUserMessageId: "msg_1",
    goal: "把 PDF 内容铺到网页",
    status: "running",
    acceptanceCriteria: [] as AcceptanceCriterion[],
    steps: [] as TaskStep[],
    evidence: [] as TaskEvidence[],
    revision: 1,
    attemptCount: 0,
    noProgressCount: 0,
    constraints: [],
    createdAt: "2026-09-18T00:00:00.000Z",
    updatedAt: "2026-09-18T00:00:00.000Z",
    ...overrides,
  };
}

const step = (id: string, status: TaskStep["status"]): TaskStep => ({ id, title: id, status, order: 0, evidenceIds: [] });

describe("taskFingerprint", () => {
  it("步骤状态变化会改变指纹", () => {
    const before = taskFingerprint({ task: taskOf({ steps: [step("s1", "in_progress")] }), editedFiles: [], toolCalls: 0 });
    const after = taskFingerprint({ task: taskOf({ steps: [step("s1", "completed")] }), editedFiles: [], toolCalls: 0 });
    expect(before).not.toBe(after);
  });

  it("新增文件会改变指纹", () => {
    const before = taskFingerprint({ task: taskOf(), editedFiles: [], toolCalls: 0 });
    const after = taskFingerprint({ task: taskOf(), editedFiles: ["src/a.ts"], toolCalls: 0 });
    expect(before).not.toBe(after);
  });

  it("新增证据会改变指纹", () => {
    const withEvidence = taskOf({ evidence: [{ id: "evd_1", kind: "command", summary: "build 通过", createdAt: "2026-09-18T00:00:00.000Z" }] });
    expect(taskFingerprint({ task: withEvidence, editedFiles: [], toolCalls: 0 }))
      .not.toBe(taskFingerprint({ task: taskOf(), editedFiles: [], toolCalls: 0 }));
  });

  // 证据的 id 是 uuid：按 id 取形状的话，模型每轮换句话重说一遍就会让指纹变化，
  // 「原地打转」永远被误判成进展。（实测：纯聊天可以这样刷满 Attempt 上限。）
  it("同一条命令重复跑不算进展（指纹不看证据 id，只看 kind + ref）", () => {
    const first = taskOf({ evidence: [{ id: "evd_a", kind: "command", ref: "pnpm", summary: "第 1 次", createdAt: "2026-09-18T00:00:00.000Z" }] });
    const second = taskOf({ evidence: [{ id: "evd_b", kind: "command", ref: "pnpm", summary: "第 2 次", createdAt: "2026-09-18T00:00:01.000Z" }] });
    expect(taskFingerprint({ task: first, editedFiles: [], toolCalls: 1 }))
      .toBe(taskFingerprint({ task: second, editedFiles: [], toolCalls: 9 }));
  });

  it("对不同目标取到证据算进展（ref 变了）", () => {
    const a = taskOf({ evidence: [{ id: "evd_a", kind: "file_diff", ref: "a.ts", summary: "改了 a", createdAt: "2026-09-18T00:00:00.000Z" }] });
    const b = taskOf({ evidence: [{ id: "evd_b", kind: "file_diff", ref: "b.ts", summary: "改了 b", createdAt: "2026-09-18T00:00:01.000Z" }] });
    expect(taskFingerprint({ task: a, editedFiles: [], toolCalls: 1 }))
      .not.toBe(taskFingerprint({ task: b, editedFiles: [], toolCalls: 1 }));
  });

  // model_observation 是完成判定的口子（没有工具可跑时，答复本身就是唯一可验证的
  // 东西），但它恰恰没有外部验证——让它进指纹，上面那条保护会原样失效。
  it("模型自述型证据不进指纹（换句话重说一遍不算进展）", () => {
    const a = taskOf({ evidence: [{ id: "evd_a", kind: "model_observation", summary: "我改好了", createdAt: "2026-09-18T00:00:00.000Z" }] });
    const b = taskOf({ evidence: [{ id: "evd_b", kind: "model_observation", summary: "真的改好了，我确认过", createdAt: "2026-09-18T00:00:01.000Z" }] });
    expect(taskFingerprint({ task: a, editedFiles: [], toolCalls: 1 }))
      .toBe(taskFingerprint({ task: b, editedFiles: [], toolCalls: 7 }));
  });

  // 这一条是本模块存在的理由：连续两轮做同样的事（哪怕调用了几十次工具）
  // 必须被判为「没有进展」，否则 no-progress 保护永远不触发。
  it("工具调用次数不进指纹——反复读文件刷不出进展", () => {
    const a = taskFingerprint({ task: taskOf(), editedFiles: [], toolCalls: 3 });
    const b = taskFingerprint({ task: taskOf(), editedFiles: [], toolCalls: 87 });
    expect(a).toBe(b);
  });

  it("文件顺序不影响指纹（避免同一批改动因排序不同被当成进展）", () => {
    const a = taskFingerprint({ task: taskOf(), editedFiles: ["a.ts", "b.ts"], toolCalls: 0 });
    const b = taskFingerprint({ task: taskOf(), editedFiles: ["b.ts", "a.ts"], toolCalls: 0 });
    expect(a).toBe(b);
  });

  it("步骤顺序不影响指纹（按 id 排序后比较）", () => {
    const a = taskFingerprint({ task: taskOf({ steps: [step("s1", "completed"), step("s2", "pending")] }), editedFiles: [], toolCalls: 0 });
    const b = taskFingerprint({ task: taskOf({ steps: [step("s2", "pending"), step("s1", "completed")] }), editedFiles: [], toolCalls: 0 });
    expect(a).toBe(b);
  });
});

describe("advanceProgress", () => {
  it("首次没有历史指纹时视为有进展，不把起步算成空转", () => {
    const result = advanceProgress(taskOf(), { editedFiles: [], toolCalls: 1 });
    expect(result.progressed).toBe(true);
    expect(result.noProgressCount).toBe(0);
  });

  it("指纹不变时累加 noProgressCount", () => {
    const task = taskOf({ lastFingerprint: taskFingerprint({ task: taskOf(), editedFiles: [], toolCalls: 1 }), noProgressCount: 1 });
    const result = advanceProgress(task, { editedFiles: [], toolCalls: 9 });
    expect(result.progressed).toBe(false);
    expect(result.noProgressCount).toBe(2);
  });

  it("有进展时清零", () => {
    const task = taskOf({ lastFingerprint: "stale", noProgressCount: 2 });
    const result = advanceProgress(task, { editedFiles: ["src/a.ts"], toolCalls: 4 });
    expect(result.progressed).toBe(true);
    expect(result.noProgressCount).toBe(0);
  });

  it("返回的指纹可直接作为下一轮的 lastFingerprint（自洽）", () => {
    const first = advanceProgress(taskOf(), { editedFiles: ["src/a.ts"], toolCalls: 2 });
    const second = advanceProgress(taskOf({ lastFingerprint: first.fingerprint }), { editedFiles: ["src/a.ts"], toolCalls: 5 });
    expect(second.progressed).toBe(false);
  });
});

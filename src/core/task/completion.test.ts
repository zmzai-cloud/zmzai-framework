import { describe, expect, it } from "vitest";

import {
  DEFAULT_MAX_ATTEMPTS,
  DEFAULT_MAX_DURATION_MS,
  DEFAULT_NO_PROGRESS_POLICY,
  MAX_DURATION_CEILING_MS,
  durationBudgetBlocker,
  evaluateTaskCompletion,
  lifecycleForBlocker,
  normalizeMaxDurationMs,
  normalizeNoProgressPolicy,
  type CompletionRuntimeState,
} from "./completion.js";
import type { AcceptanceCriterion, TaskEvidence, TaskRecord, TaskStep } from "./types.js";

function criterion(overrides: Partial<AcceptanceCriterion> = {}): AcceptanceCriterion {
  return { id: "crit_implicit", description: "把 PDF 内容铺到网页", required: true, status: "pending", evidenceIds: [], ...overrides };
}

function step(overrides: Partial<TaskStep> = {}): TaskStep {
  return { id: "step_1", title: "解析 PDF", status: "completed", order: 0, evidenceIds: [], ...overrides };
}

function evidence(overrides: Partial<TaskEvidence> = {}): TaskEvidence {
  return { id: "evd_1", kind: "command", summary: "pnpm build 通过", createdAt: "2026-09-18T00:00:00.000Z", ...overrides };
}

function taskOf(overrides: Partial<TaskRecord> = {}): TaskRecord {
  return {
    id: "task_1",
    sessionId: "ses_1",
    rootRequestId: "req_1",
    rootUserMessageId: "msg_1",
    goal: "把 PDF 内容铺到网页",
    status: "running",
    acceptanceCriteria: [criterion()],
    steps: [],
    evidence: [],
    revision: 3,
    attemptCount: 1,
    noProgressCount: 0,
    constraints: [],
    createdAt: "2026-09-18T00:00:00.000Z",
    updatedAt: "2026-09-18T00:00:00.000Z",
    ...overrides,
  };
}

function stateOf(overrides: Partial<CompletionRuntimeState> = {}): CompletionRuntimeState {
  return {
    attemptSettled: true,
    fatalError: null,
    lastError: null,
    unknownSideEffect: null,
    pendingPermissions: 0,
    unsafeReplay: null,
    budgetExhausted: null,
    externalAuthRequired: null,
    inputRequired: null,
    choiceRequired: null,
    unresolvedToolErrors: [],
    finalTextPresent: true,
    cancelled: false,
    ...overrides,
  };
}

describe("evaluateTaskCompletion", () => {
  // §17.1.2：全部 required 通过 + 有 evidence → delivered
  it("验收条件全部通过且留有证据时返回 delivered", () => {
    const verdict = evaluateTaskCompletion(
      taskOf({
        acceptanceCriteria: [criterion({ status: "passed", evidenceIds: ["evd_1"] })],
        evidence: [evidence()],
      }),
      stateOf(),
    );
    expect(verdict.status).toBe("delivered");
    if (verdict.status === "delivered") expect(verdict.reason).toContain("验收条件");
  });

  // §17.1.1：有 required 步骤未完成 → 不得 delivered
  it("仍有未完成步骤时不返回 delivered，而是内部续跑", () => {
    const verdict = evaluateTaskCompletion(
      taskOf({
        acceptanceCriteria: [criterion({ status: "passed", evidenceIds: ["evd_1"] })],
        steps: [step({ status: "in_progress", title: "把正文写入页面" })],
        evidence: [evidence()],
      }),
      stateOf(),
    );
    expect(verdict.status).toBe("continue");
    if (verdict.status === "continue") expect(verdict.reason).toContain("未完成的步骤");
  });

  it("验收条件未通过时不返回 delivered", () => {
    const verdict = evaluateTaskCompletion(taskOf(), stateOf());
    expect(verdict.status).toBe("continue");
    if (verdict.status === "continue") expect(verdict.reason).toContain("验收条件未通过");
  });

  // §9 条件 3
  it("验收条件通过但没有关联证据时仍不返回 delivered", () => {
    const verdict = evaluateTaskCompletion(
      taskOf({ acceptanceCriteria: [criterion({ status: "passed", evidenceIds: [] })] }),
      stateOf(),
    );
    expect(verdict.status).toBe("continue");
    if (verdict.status === "continue") expect(verdict.reason).toContain("缺少验证证据");
  });

  it("证据引用悬空（指向已淘汰的 evidence）不算有效证据", () => {
    const verdict = evaluateTaskCompletion(
      taskOf({ acceptanceCriteria: [criterion({ status: "passed", evidenceIds: ["evd_gone"] })] }),
      stateOf(),
    );
    expect(verdict.status).toBe("continue");
  });

  // §9 条件 5
  it("尚未生成最终交付说明时不返回 delivered", () => {
    const verdict = evaluateTaskCompletion(
      taskOf({
        acceptanceCriteria: [criterion({ status: "passed", evidenceIds: ["evd_1"] })],
        evidence: [evidence()],
      }),
      stateOf({ finalTextPresent: false }),
    );
    expect(verdict.status).toBe("continue");
    if (verdict.status === "continue") expect(verdict.reason).toContain("最终交付说明");
  });

  it("纯问答（无步骤）靠最终文本与隐式条件判定，不因为没拆计划而被判未完成", () => {
    const verdict = evaluateTaskCompletion(
      taskOf({
        acceptanceCriteria: [criterion({ status: "passed", evidenceIds: ["evd_1"] })],
        evidence: [evidence({ kind: "model_observation", summary: "解释已给出" })],
      }),
      stateOf(),
    );
    expect(verdict.status).toBe("delivered");
  });

  // §9 条件 4 / §19「不得把无法验证包装成已完成」
  it("有未回应的授权请求时，即使一切看起来都完成了也不返回 delivered", () => {
    const verdict = evaluateTaskCompletion(
      taskOf({
        acceptanceCriteria: [criterion({ status: "passed", evidenceIds: ["evd_1"] })],
        evidence: [evidence()],
      }),
      stateOf({ pendingPermissions: 2 }),
    );
    expect(verdict.status).toBe("blocked");
    if (verdict.status === "blocked") {
      expect(verdict.blocker.kind).toBe("permission");
      expect(verdict.blocker.requiredAction).toContain("授权");
    }
  });

  it("写操作结果未知时进入 blocked(unsafe_replay)，不自动重放", () => {
    const verdict = evaluateTaskCompletion(taskOf(), stateOf({ unknownSideEffect: "git push 未返回" }));
    expect(verdict.status).toBe("blocked");
    if (verdict.status === "blocked") {
      expect(verdict.blocker.kind).toBe("unsafe_replay");
      expect(verdict.blocker.resumable).toBe(true);
    }
  });

  it("预算耗尽进入 blocked(budget) 且标记为不可自动恢复", () => {
    const verdict = evaluateTaskCompletion(taskOf(), stateOf({ budgetExhausted: "超过 30 分钟" }));
    expect(verdict.status).toBe("blocked");
    if (verdict.status === "blocked") {
      expect(verdict.blocker.kind).toBe("budget");
      expect(verdict.blocker.resumable).toBe(false);
    }
  });

  it("外部登录失效进入 blocked(external_auth)", () => {
    const verdict = evaluateTaskCompletion(taskOf(), stateOf({ externalAuthRequired: "GitHub 凭据已失效" }));
    expect(verdict.status).toBe("blocked");
    if (verdict.status === "blocked") expect(verdict.blocker.kind).toBe("external_auth");
  });

  it("缺少只能由用户提供的信息进入 blocked(input)", () => {
    const verdict = evaluateTaskCompletion(taskOf(), stateOf({ inputRequired: "需要目标仓库地址" }));
    expect(verdict.status).toBe("blocked");
    if (verdict.status === "blocked") expect(verdict.blocker.kind).toBe("input");
  });

  it("面对不可逆的分支选择时进入 blocked(choice)", () => {
    const verdict = evaluateTaskCompletion(taskOf(), stateOf({ choiceRequired: { message: "两种迁移方案", requiredAction: "选择保留或丢弃历史" } }));
    expect(verdict.status).toBe("blocked");
    if (verdict.status === "blocked") expect(verdict.blocker.kind).toBe("choice");
  });

  it("阻塞优先级高于「看起来已完成」：先报阻塞而不是交付", () => {
    const verdict = evaluateTaskCompletion(
      taskOf({
        acceptanceCriteria: [criterion({ status: "passed", evidenceIds: ["evd_1"] })],
        evidence: [evidence()],
      }),
      stateOf({ unknownSideEffect: "推送结果未知", pendingPermissions: 1 }),
    );
    expect(verdict.status).toBe("blocked");
    // unsafe_replay 比 permission 更具体（它决定了「不能重放」这个硬约束）
    if (verdict.status === "blocked") expect(verdict.blocker.kind).toBe("unsafe_replay");
  });

  it("用户主动停止返回 cancelled 而不是 failed", () => {
    const verdict = evaluateTaskCompletion(taskOf(), stateOf({ cancelled: true }));
    expect(verdict.status).toBe("cancelled");
  });

  it("一次运行没跑完（断流/崩溃）不判死，而是续跑并提示先核对现场", () => {
    const verdict = evaluateTaskCompletion(
      taskOf({
        acceptanceCriteria: [criterion({ status: "passed", evidenceIds: ["evd_1"] })],
        evidence: [evidence()],
      }),
      stateOf({ attemptSettled: false }),
    );
    expect(verdict.status).toBe("continue");
    if (verdict.status === "continue") {
      expect(verdict.advisory).toContain("确认工作区当前的实际状态");
      expect(verdict.advisory).toContain("不要从头再做一遍");
    }
  });

  it("不可恢复的失败才返回 failed", () => {
    const verdict = evaluateTaskCompletion(
      taskOf({
        acceptanceCriteria: [criterion({ status: "passed", evidenceIds: ["evd_1"] })],
        evidence: [evidence()],
      }),
      stateOf({ fatalError: "需求本身无法实现：目标仓库不存在" }),
    );
    expect(verdict.status).toBe("failed");
    if (verdict.status === "failed") expect(verdict.reason).toContain("目标仓库不存在");
  });

  // §17.1.9：连续三次无进展 → blocked(no_progress)
  it("连续三次无进展进入 blocked(no_progress) 并说明已尝试什么", () => {
    const verdict = evaluateTaskCompletion(taskOf({ noProgressCount: 3 }), stateOf());
    expect(verdict.status).toBe("blocked");
    if (verdict.status === "blocked") {
      expect(verdict.blocker.kind).toBe("no_progress");
      expect(verdict.blocker.requiredAction).not.toBe("请继续");
      expect(verdict.blocker.resumable).toBe(true);
    }
  });

  it("第一次无进展注入恢复指令，第二次改为要求换策略", () => {
    const first = evaluateTaskCompletion(taskOf({ noProgressCount: 1 }), stateOf());
    expect(first.status).toBe("continue");
    if (first.status === "continue") {
      expect(first.advisory).toContain("重新读取现场");
    }
    const second = evaluateTaskCompletion(taskOf({ noProgressCount: 2 }), stateOf());
    expect(second.status).toBe("continue");
    if (second.status === "continue") {
      expect(second.advisory).toContain("改变策略");
    }
  });

  it("无进展保护晚于真实阻塞：在等授权不算卡住", () => {
    const verdict = evaluateTaskCompletion(taskOf({ noProgressCount: 5 }), stateOf({ pendingPermissions: 1 }));
    expect(verdict.status).toBe("blocked");
    if (verdict.status === "blocked") expect(verdict.blocker.kind).toBe("permission");
  });

  // §17.1.7 的收尾形态：可重试错误在 runLoop 内部退避重试 5 次后仍然失败，任务会
  // 因为连续无进展停下。停下时必须说出真实原因，否则用户看到的是「连续 3 轮没有
  // 实质进展」，而真正的原因（连不上 / 被限流）一个字都没提——那三轮模型什么都没做错。
  it("因上游持续失败而停止时，把真实错误写进阻塞原因", () => {
    const verdict = evaluateTaskCompletion(
      taskOf({ noProgressCount: 3 }),
      stateOf({ attemptSettled: false, lastError: "upstream connection reset" }),
    );
    expect(verdict.status).toBe("blocked");
    if (verdict.status === "blocked") {
      expect(verdict.blocker.kind).toBe("no_progress");
      expect(verdict.blocker.message).toContain("upstream connection reset");
      expect(verdict.blocker.requiredAction).toContain("上游可用");
    }
  });

  it("一次运行没跑完但还没有连续无进展时，继续续跑并带上错误原文", () => {
    const verdict = evaluateTaskCompletion(taskOf({ noProgressCount: 1 }), stateOf({ attemptSettled: false, lastError: "socket hang up" }));
    expect(verdict.status).toBe("continue");
    if (verdict.status === "continue") {
      expect(verdict.advisory).toContain("socket hang up");
      expect(verdict.advisory).toContain("不要从头再做一遍");
    }
  });

  it("无进展阈值可配置", () => {
    const verdict = evaluateTaskCompletion(taskOf({ noProgressCount: 2 }), stateOf(), { blockedAt: 2, switchStrategyAt: 1 });
    expect(verdict.status).toBe("blocked");
  });

  it("把阈值调到极大时会被夹到上限，保护不会因此失效", () => {
    const policy = normalizeNoProgressPolicy({ blockedAt: 1_000_000, switchStrategyAt: -5 });
    expect(policy.blockedAt).toBe(8);
    expect(policy.switchStrategyAt).toBe(1);
  });

  it("默认阈值有明确常量", () => {
    expect(DEFAULT_NO_PROGRESS_POLICY.blockedAt).toBe(3);
    expect(DEFAULT_MAX_ATTEMPTS).toBeGreaterThan(1);
  });

  it("未恢复的工具错误会进入续跑指令，但不单独构成阻塞", () => {
    const verdict = evaluateTaskCompletion(taskOf(), stateOf({ unresolvedToolErrors: ["bash 退出码 1"] }));
    expect(verdict.status).toBe("continue");
    if (verdict.status === "continue") expect(verdict.advisory).toContain("bash 退出码 1");
  });

  it("cancelled 的步骤不拦住交付（用户已明确放弃该步）", () => {
    const verdict = evaluateTaskCompletion(
      taskOf({
        acceptanceCriteria: [criterion({ status: "passed", evidenceIds: ["evd_1"] })],
        steps: [step({ id: "step_a", status: "completed" }), step({ id: "step_b", status: "cancelled" })],
        evidence: [evidence()],
      }),
      stateOf(),
    );
    expect(verdict.status).toBe("delivered");
  });

  it("非 required 的验收条件未通过不拦住交付", () => {
    const verdict = evaluateTaskCompletion(
      taskOf({
        acceptanceCriteria: [
          criterion({ status: "passed", evidenceIds: ["evd_1"] }),
          criterion({ id: "crit_optional", description: "顺手优化样式", required: false, status: "pending" }),
        ],
        evidence: [evidence()],
      }),
      stateOf(),
    );
    expect(verdict.status).toBe("delivered");
  });
});

describe("lifecycleForBlocker", () => {
  it("按「该谁动」把阻塞映射到生命周期状态", () => {
    expect(lifecycleForBlocker("permission")).toBe("waiting_permission");
    expect(lifecycleForBlocker("input")).toBe("waiting_input");
    expect(lifecycleForBlocker("choice")).toBe("waiting_input");
    expect(lifecycleForBlocker("external_auth")).toBe("waiting_external");
    expect(lifecycleForBlocker("unsafe_replay")).toBe("blocked");
    expect(lifecycleForBlocker("budget")).toBe("blocked");
    expect(lifecycleForBlocker("no_progress")).toBe("blocked");
  });
});

describe("时间预算（规格 §10.2 / §16 阶段 D「最长运行时间」）", () => {
  it("有余量时不拦；超了给 blocked(budget) 并说清烧了多少分钟", () => {
    expect(durationBudgetBlocker(taskOf({ activeMs: 10 * 60_000 }), 60 * 60_000)).toBeNull();
    const blocker = durationBudgetBlocker(taskOf({ activeMs: 90 * 60_000 }), 60 * 60_000);
    expect(blocker?.kind).toBe("budget");
    expect(blocker?.message).toContain("90 分钟");
    expect(blocker?.message).toContain("时间预算");
    // 每个 blocker 都必须写明用户能做什么，不能只说「请继续」（§14.4）
    expect(blocker?.requiredAction.length).toBeGreaterThan(0);
    expect(blocker?.resumable).toBe(true);
  });

  it("旧任务没有 activeMs 字段时按 0 处理，不会一上来就判超支", () => {
    const legacy = taskOf();
    delete (legacy as { activeMs?: number }).activeMs;
    expect(durationBudgetBlocker(legacy, 60_000)).toBeNull();
  });

  it("预算可配置，但被夹在 (0, 24h] 之间——宿主调不到「永不拦截」", () => {
    expect(normalizeMaxDurationMs(5 * 60_000)).toBe(5 * 60_000);
    expect(normalizeMaxDurationMs(0)).toBe(DEFAULT_MAX_DURATION_MS);
    expect(normalizeMaxDurationMs(-1)).toBe(DEFAULT_MAX_DURATION_MS);
    expect(normalizeMaxDurationMs(Number.NaN)).toBe(DEFAULT_MAX_DURATION_MS);
    expect(normalizeMaxDurationMs(Number.POSITIVE_INFINITY)).toBe(DEFAULT_MAX_DURATION_MS);
    expect(normalizeMaxDurationMs(365 * 24 * 60 * 60_000)).toBe(MAX_DURATION_CEILING_MS);
  });
});

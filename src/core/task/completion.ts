import type { TaskBlocker, TaskRecord } from "./types.js";

/** Completion Gate：可信完成判定（规格 3 §9）。
 *
 * 【为什么必须存在】规格 §3.1 的根因是「一次运行正常结束」被当成了「用户
 * 目标已经实现」。二者之间隔着：步骤是否真的做完、做的东西有没有被验证、
 * 有没有悬在半空的授权请求、有没有结果未知的写操作。这些只有对照任务契约
 * 才能回答，而 `attemptSettled` / `status === "idle"` / 模型文字里的「已完成」
 * 都回答不了（规格 §8.3 把这三条逐一列为**不能**触发的依据）。
 *
 * 本模块是纯函数：无 IO、无时钟、无全局状态。同一输入恒得同一结论，因此
 * 规格 §17.1 的 13 条单测可以逐条钉住它。
 *
 * 【2026-09-19 新增条件 6：必须提交显式交付声明】原来的条件 1（所有 required
 * 验收条件 passed）依赖 `projectImplicitCriterion` 从「模型这轮有没有输出文本」
 * 推导出条件结论。那次推导被删掉了（原因见 `plan.ts` 的 `applyDelivery` 注释），
 * 条件 1 因此需要一个**新的输入来源**：模型在 `task_deliver` 里的显式声明。
 * 它同时补上了一个此前存在的平凡漏洞——没有 required 条件的任务会让条件 1/2/3/5
 * 全部平凡通过。 */

/** 判定输入里「运行时事实」的那一半。任务契约那一半来自 TaskRecord。
 *
 *  这些字段全部由调用方（runner）在 Attempt 收尾时按**可观测事实**填写，
 *  不接受模型的自我描述——这正是它与 `session.summary.kind` 的本质区别。 */
export type CompletionRuntimeState = {
  /** 最近一次 Attempt 是否正常跑到底（未抛错、未被中断）。 */
  attemptSettled: boolean;
  /** 已确定无法通过重试恢复的失败原因（规格 §10.2 的 fatal）。
   *  与 attemptSettled 分开是刻意的：一次运行没能跑完（断流、进程被杀）
   *  属于可再来，混进这里会让一次网络抖动把整条任务判死。 */
  fatalError: string | null;
  /** 最近一次 Attempt 的错误消息，**不区分可重试与否**。
   *
   *  【为什么和 fatalError 分开】可重试错误在 `runLoop` 内部已经退避重试过 5 次，
   *  仍然失败说明上游这段时间确实不可用——它不是「永久坏掉」，但也不能一直烧下去。
   *  于是任务会在几轮无进展后停下（no_progress）。停的时候必须把这个错误说出来：
   *  否则用户看到的是「连续 3 轮没有实质进展」，而那三轮其实什么都没做错，真正
   *  的原因（连不上 / 被限流 / 超时）一个字都没提。诊断信息的价值就在这里。 */
  lastError: string | null;
  /** 有工具可能产生了副作用但结果未知（spec §10.2 的「写操作结果未知」）。 */
  unknownSideEffect: string | null;
  /** 尚未收到回复的授权请求数量。 */
  pendingPermissions: number;
  /** 已确认失败且需要外部核验才能安全重放的写操作（unsafe_replay）。 */
  unsafeReplay: string | null;
  /** M3-S22：存在未终态或未通过父验证的必要子代理（spec §9.4——必要子结果
   *  已被接受或需求已由有效证据解决才可交付；消费 ≠ 接受，A36）。 */
  subagentPending: string[] | null;
  /** 预算耗尽原因（时间/token/费用/Attempt 数）。null 表示未超。 */
  budgetExhausted: string | null;
  /** 外部状态导致必须由用户完成的事（登录失效、验证码、付款）。
   *
   *  【三个 `*Required` 为什么统一成形】`message` 回答「卡在哪」，`requiredAction`
   *  回答「你具体要做什么」。后者不能由框架代写——原来 input 那条被写死成
   *  「补充必要信息后任务会自动继续。」，那是规格 §14.4 明令禁止的模糊指示：
   *  它描述了流程，却没有告诉用户缺的是什么。这三件事的内容只有模型知道
   *  （它正是为此调用 task_block 的）。 */
  externalAuthRequired: { message: string; requiredAction: string } | null;
  /** 缺失且只能由用户提供的信息。 */
  inputRequired: { message: string; requiredAction: string } | null;
  /** 两个会产生不可逆差异的方案需要用户拍板。 */
  choiceRequired: { message: string; requiredAction: string } | null;
  /** Attempt 结束时仍处于 error 状态、且模型未给出替代方案的工具调用摘要。
   *  只用于「没做完」的判定与提示，不单独构成 blocked——工具失败后模型
   *  换条路走通是常态，把它当阻塞会误伤。 */
  unresolvedToolErrors: string[];
  /** 最终交付文本是否已经生成（§9 条件 5）。 */
  finalTextPresent: boolean;
  /** 用户主动停止。 */
  cancelled: boolean;
};

/** 判定的三种推进结论 + 三种终止结论。
 *
 *  `continue` 是内部续跑的指令，**不创建用户消息**（规格 §8.2）。它携带
 *  `advisory` 时会被拼进下一个 Attempt 的恢复上下文。 */
export type CompletionVerdict =
  | { status: "delivered"; reason: string }
  | { status: "continue"; reason: string; advisory?: string }
  | { status: "blocked"; blocker: TaskBlocker }
  | { status: "failed"; reason: string }
  | { status: "cancelled"; reason: string };

/** 无进展阈值（规格 §10.1）：默认连续三次进 blocked(no_progress)。
 *  可配置 + 有上限，避免宿主把阈值调到无穷大从而绕开保护。 */
export type NoProgressPolicy = {
  /** 第 N 次无进展时进入 blocked。默认 3。 */
  blockedAt: number;
  /** 第 N 次无进展时切换策略（诊断 / 缩小步骤）。默认 2。 */
  switchStrategyAt: number;
};

export const DEFAULT_NO_PROGRESS_POLICY: NoProgressPolicy = { blockedAt: 3, switchStrategyAt: 2 };

/** 单次 Attempt 的硬上限（规格 §10.1 / §16 阶段 D「最大 Attempt 数配置」）。 */
export const DEFAULT_MAX_ATTEMPTS = 24;

/** 单次任务的时间预算：累计执行时间的上限（规格 §10.2 / §16 阶段 D
 *  「最长运行时间」）。默认一小时。
 *
 *  【计量口径】累加各 Attempt 的 durationMs，不是 `now - createdAt`。任务阻塞
 *  期间（等授权、等用户补信息）run 已经结束，那段空白不计入——按墙钟算会让
 *  「停了一夜的任务第二天点继续立刻超时」，把恢复通路堵死。 */
export const DEFAULT_MAX_DURATION_MS = 60 * 60 * 1000;

/** 时间预算的硬上限：24 小时。宿主调不到「永不拦截」。 */
export const MAX_DURATION_CEILING_MS = 24 * 60 * 60 * 1000;

/** 归一化宿主传入的时间预算。非正数 / NaN 一律回落默认值，而不是当成
 *  「不限」——0 和负数在这里最可能的意思是配置写错了。 */
export function normalizeMaxDurationMs(value?: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.min(MAX_DURATION_CEILING_MS, Math.floor(value))
    : DEFAULT_MAX_DURATION_MS;
}

/** 时间预算判定：还有余量返回 null，超了给一个 blocked(budget) 的 blocker。
 *
 *  与 Attempt 数上限并列，两者防的是不同形态的失控：轮数上限挡「每次都有一点
 *  进展但永远做不完」，时间预算挡「单轮本身就很慢，轮数不多但总时长失控」。 */
export function durationBudgetBlocker(task: TaskRecord, maxDurationMs: number): TaskBlocker | null {
  const spent = task.activeMs ?? 0;
  if (spent <= maxDurationMs) return null;
  const minutes = (value: number) => Math.max(1, Math.round(value / 60_000));
  return {
    kind: "budget",
    message: `任务已累计执行 ${minutes(spent)} 分钟，超过了单次任务的时间预算（${minutes(maxDurationMs)} 分钟）。`,
    requiredAction: "看一眼执行轨迹，确认目标是否需要收窄或拆成几次；确认后可以继续。",
    resumable: true,
  };
}

/** 归一化宿主传入的策略：clamp 到 [1, 8]，越界一律回落默认值而不是
 *  悄悄放行——「把 blockedAt 设成 1e9 就不会被拦」正是要防的。 */
export function normalizeNoProgressPolicy(policy?: Partial<NoProgressPolicy>): NoProgressPolicy {
  const clamp = (value: number | undefined, fallback: number): number =>
    typeof value === "number" && Number.isFinite(value) ? Math.min(8, Math.max(1, Math.floor(value))) : fallback;
  return {
    blockedAt: clamp(policy?.blockedAt, DEFAULT_NO_PROGRESS_POLICY.blockedAt),
    switchStrategyAt: clamp(policy?.switchStrategyAt, DEFAULT_NO_PROGRESS_POLICY.switchStrategyAt),
  };
}

/** 阻塞类判定：这些条件一旦成立，无论任务看起来多像完成了都**不能**返回
 *  delivered（规格 §9 条件 4）。顺序即优先级——越靠前的越具体，提示越有用。 */
function firstBlocker(task: TaskRecord, state: CompletionRuntimeState): TaskBlocker | null {
  if (state.unknownSideEffect) {
    return {
      kind: "unsafe_replay",
      message: `上一个动作可能已经产生副作用，但没有拿到明确结果：${state.unknownSideEffect}`,
      // 规格 §10.2：写操作结果未知时先核验外部状态，不许自动重放
      requiredAction: "先确认外部系统的实际状态（文件、提交、远端页面等），再决定继续或重试。",
      resumable: true,
    };
  }
  if (state.unsafeReplay) {
    return {
      kind: "unsafe_replay",
      message: `有一个写操作结果不确定，重放可能造成重复提交或覆盖：${state.unsafeReplay}`,
      requiredAction: "核验该操作在外部系统里的实际结果后，再选择重试或跳过。",
      resumable: true,
    };
  }
  if (state.budgetExhausted) {
    return {
      kind: "budget",
      message: `已用尽本次任务的执行预算：${state.budgetExhausted}`,
      requiredAction: "确认是否继续投入（增加预算或缩小目标），然后重新发起。",
      resumable: false,
    };
  }
  if (state.externalAuthRequired) {
    return {
      kind: "external_auth",
      message: state.externalAuthRequired.message,
      requiredAction: state.externalAuthRequired.requiredAction,
      resumable: true,
    };
  }
  if (state.choiceRequired) {
    return {
      kind: "choice",
      message: state.choiceRequired.message,
      requiredAction: state.choiceRequired.requiredAction,
      resumable: true,
    };
  }
  if (state.inputRequired) {
    return {
      kind: "input",
      message: state.inputRequired.message,
      requiredAction: state.inputRequired.requiredAction,
      resumable: true,
    };
  }
  if (state.pendingPermissions > 0) {
    return {
      kind: "permission",
      message: `有 ${state.pendingPermissions} 个操作在等待授权。`,
      requiredAction: "处理授权卡片后任务会自动继续。",
      resumable: true,
    };
  }
  return null;
}

/** 未完成的步骤：pending / in_progress / blocked。`cancelled` 不算未完成——
 *  用户或模型明确放弃的步骤不该拦住交付（规格 §9 条件 2 说的是「必要步骤」）。 */
function openSteps(task: TaskRecord): TaskRecord["steps"] {
  return task.steps.filter((step) => step.status === "pending" || step.status === "in_progress" || step.status === "blocked");
}

/** §9 条件 1：所有 required 验收条件 passed。 */
function unmetRequiredCriteria(task: TaskRecord): { id: string; description: string; status: string }[] {
  return task.acceptanceCriteria
    .filter((criterion) => criterion.required && criterion.status !== "passed")
    .map((criterion) => ({ id: criterion.id, description: criterion.description, status: criterion.status }));
}

/** §9 条件 3：每个关键验收条件至少关联一条有效 evidence。
 *  「有效」= evidence id 能在 task.evidence 里找到——悬空引用不算数。 */
function criteriaMissingEvidence(task: TaskRecord): { id: string; description: string }[] {
  const known = new Set(task.evidence.map((item) => item.id));
  return task.acceptanceCriteria
    .filter((criterion) => criterion.required && criterion.status === "passed")
    .filter((criterion) => !criterion.evidenceIds.some((id) => known.has(id)))
    .map((criterion) => ({ id: criterion.id, description: criterion.description }));
}

/** 无进展时的恢复指令（规格 §10.1 的 1/2 档）。 */
function noProgressAdvisory(task: TaskRecord, count: number, policy: NoProgressPolicy): string | undefined {
  if (count <= 0) return undefined;
  const open = openSteps(task);
  const remaining = open.length ? open.map((step) => step.title).join("、") : "（未拆解出明确步骤）";
  if (count >= policy.switchStrategyAt) {
    return (
      `[任务未推进] 你已经连续 ${count} 轮没有让任务前进一步。换做同一件事的做法没有用。` +
      `现在改变策略：先做诊断（读取现场、复现问题、确认假设），或把「${remaining}」缩成更小的可验证一步。` +
      `不要重复上一轮的动作。`
    );
  }
  return (
    `[任务未推进] 上一轮结束时任务状态与开始时相同。先重新读取现场（文件、命令输出、外部状态），` +
    `再说清楚是什么挡住了「${remaining}」。如果前提不成立，直接说明并给出替代路径。`
  );
}

/** 交付相关的恢复指令。
 *
 *  这两条 advisory 是「显式交付」能落地的关键：门把交付打回去的时候，必须让模型
 *  知道**缺的是那一次声明**，否则它看到「验收条件未通过」只会重复做已经做完的事，
 *  一路空转到 no_progress——把一次本可以一轮解决的问题变成三倍成本。
 *
 *  【为什么不能说「输出一段总结就算交付」】那正是被删掉的那条推导。这里的措辞刻意
 *  指向工具：`task_deliver`。 */
function deliveryAdvisory(task: TaskRecord, unmetIds: readonly string[]): string | undefined {
  if (task.result === undefined) {
    return (
      "[交付未声明] 你还没有提交交付声明，所以任务不能结束——结束本轮、说一句「已完成」、把 todo 标记完成都不算。" +
      "如果目标已经达成，现在调用 `task_deliver`，按四个问题回答：做成了什么、改了哪些主要内容、怎么验证的、还有哪些没做完" +
      "（无剩余项也要显式给空数组），并逐条给出验收条件的结论。" +
      "如果还没达成，继续做，不要调用它。"
    );
  }
  if (unmetIds.length) {
    return (
      `[验收未完成] 你的交付声明里这些验收条件没有拿到通过结论：${unmetIds.join("、")}。` +
      "两种可能：工作还没做完（那就继续做，做完再交付一次）；或者你只是漏写了结论" +
      "（那就补齐 `task_deliver` 的 `criteria`，id 用任务契约里印出的那一个）。" +
      "注意 required 条件不能用 `not_applicable` 绕过。"
    );
  }
  return undefined;
}

/** 把阻塞原因映射到任务生命周期状态。
 *
 *  `waiting_*` 与 `blocked` 的分界是「谁该动」：等用户做一件明确的事 →
 *  waiting_*（界面给对应按钮）；系统自己搞不定、需要判断 → blocked。 */
export function lifecycleForBlocker(kind: TaskBlocker["kind"]): TaskRecord["status"] {
  switch (kind) {
    case "permission":
      return "waiting_permission";
    case "input":
    case "choice":
      return "waiting_input";
    case "external_auth":
      return "waiting_external";
    // unsafe_replay / budget / no_progress 都属于「不能自动继续」，需要人判断
    default:
      return "blocked";
  }
}

/**
 * 可信完成判定（规格 §9）。纯函数。
 *
 * 判定顺序是有讲究的：**先阻塞、后完成**。一个任务即使所有步骤都完成了，
 * 只要还有一个未回应的授权请求或结果未知的写操作，就不能说自己交付了。
 * 反过来先判完成，这些悬空状态就会被步骤的完成态掩盖掉——那正是规格
 * §19「不得把『无法验证』包装成『已完成但建议用户检查』」要禁止的行为。
 */
export function evaluateTaskCompletion(
  task: TaskRecord,
  state: CompletionRuntimeState,
  policyInput?: Partial<NoProgressPolicy>,
): CompletionVerdict {
  const policy = normalizeNoProgressPolicy(policyInput);

  if (state.cancelled) return { status: "cancelled", reason: "用户已停止任务。" };

  // 1) 阻塞优先（§9 条件 4）
  const blocker = firstBlocker(task, state);
  if (blocker) return { status: "blocked", blocker };

  // 2) 确定性失败先于无进展保护：no_progress 是策略性停止（可恢复），
  //    用它盖住一个「已经没救」的真实原因会误导用户去重试。
  if (state.fatalError) {
    return { status: "failed", reason: state.fatalError };
  }

  // 3) 无进展保护（§10.1）：先于完成判定，但晚于真实阻塞——
  //    权限等待会让状态停住，那是「在等」不是「卡住」。
  if (task.noProgressCount >= policy.blockedAt) {
    // 上游持续失败是最常见的「无进展」成因，那时「换个做法」是错误的建议——
    // 模型什么都没做错。把真实错误带上，用户才知道该等一会儿还是该查配置。
    const causedBy = state.lastError ? `最后一次运行失败：${state.lastError}` : null;
    return {
      status: "blocked",
      blocker: {
        kind: "no_progress",
        message: causedBy
          ? `连续 ${task.noProgressCount} 轮没有实质进展。${causedBy}`
          : `连续 ${task.noProgressCount} 轮没有实质进展，已停止自动续跑。`,
        requiredAction: causedBy
          ? "确认上游可用（网络、额度、模型配置）后继续；任务会从中断处接着做。"
          : "查看上面的执行轨迹，确认目标是否需要调整，或直接指出下一步该做什么。",
        resumable: true,
      },
    };
  }

  // 4) 一次运行没跑完（上游断流、工具崩溃、进程被杀）不等于任务失败。规格 §10.2
  // 把这类归为 recovering，只有重试耗尽才升级。这里返回 continue，由任务层
  // 按 Attempt 上限决定什么时候放弃。
  if (!state.attemptSettled) {
    return {
      status: "continue",
      reason: "上一轮运行未能正常结束。",
      advisory:
        (state.lastError ? `上一轮运行中断了：${state.lastError}\n` : "上一轮运行中断了。") +
        "先确认工作区当前的实际状态（哪些文件已经改过、外部系统处于什么状态），" +
        "再从中断的地方继续——不要从头再做一遍，那会产生重复副作用。",
    };
  }

  // 5) 完成判定（§9 五条件）
  const unmet = unmetRequiredCriteria(task);
  const open = openSteps(task);
  const missingEvidence = criteriaMissingEvidence(task);
  // 6) 显式交付声明（§9 条件 6）。交付是一次动作，不是一个可以被推断出来的语气。
  //
  //  【为什么单列一条而不是并进条件 1】任务可能一条 required 验收条件都没有
  //  （宿主显式添加的条件全为 optional 时），此时条件 1/2/3/5 会**全部平凡通过**，
  //  交付又退回到「文本非空即完成」。单列之后，「交付必须由模型明确声明」这条
  //  不变量与条件集无关地成立——它是 §3.1 那条根因（一次运行正常结束 ≠ 目标已实现）
  //  的最终落点。`task.result` 由 `applyDelivery` 写入，那是它的唯一生产者。
  const deliveryDeclared = task.result !== undefined;
  const reasons: string[] = [];
  if (unmet.length) reasons.push(`验收条件未通过：${unmet.map((item) => item.description).join("、")}`);
  if (open.length) reasons.push(`仍有未完成的步骤：${open.map((step) => step.title).join("、")}`);
  if (missingEvidence.length) reasons.push(`验收条件缺少验证证据：${missingEvidence.map((item) => item.description).join("、")}`);
  if (!state.finalTextPresent) reasons.push("尚未生成最终交付说明");
  if (!deliveryDeclared) reasons.push("尚未提交交付声明");
  // M3-S22（spec §9.4 / §8.4）：必要子代理未收尾或结果未被父验证——消费 ≠ 接受
  if (state.subagentPending && state.subagentPending.length > 0) {
    reasons.push(`子代理未收尾或结果未通过验证：${state.subagentPending.join("、")}`.slice(0, 400));
  }

  if (reasons.length === 0) {
    return { status: "delivered", reason: "全部验收条件已通过、留有条目证据，并由模型显式声明交付。" };
  }

  // 5) 未完成 → 内部续跑（不创建用户消息）
  const advisory = noProgressAdvisory(task, task.noProgressCount, policy);
  const delivery = deliveryAdvisory(task, unmet.map((item) => item.id));
  const unresolved = state.unresolvedToolErrors.length
    ? `上一轮有工具调用以失败告终（${state.unresolvedToolErrors.join("；")}），如果它们挡在路上，先换一条路。`
    : "";
  return {
    status: "continue",
    reason: reasons.join("；"),
    ...(advisory || delivery || unresolved ? { advisory: [delivery, advisory, unresolved].filter(Boolean).join("\n") } : {}),
  };
}

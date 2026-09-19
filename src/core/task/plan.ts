import { createHash } from "node:crypto";

import {
  newCriterionId,
  newEvidenceId,
  newTaskStepId,
  type AcceptanceCriterion,
  type TaskDeliveryDeclaration,
  type TaskEvidence,
  type TaskEvidenceKind,
  type TaskPatch,
  type TaskRecord,
  type TaskResult,
  type TaskStep,
  type TaskStepStatus,
} from "./types.js";

/** 运行时事实 → 任务契约的投影（规格 3 §6「`todo.updated` 可暂时作为步骤投影，
 *  但不能继续作为唯一的任务来源」）。
 *
 * 分工：
 * - 模型通过 `todo` 工具表达**计划**；这里把它投影成 `TaskRecord.steps`，
 *   但 TaskRecord 是权威——todo 事件没了、乱序了、被压缩掉了，任务仍完整。
 * - 工具调用结果由运行时（runner）观测后投影成 `TaskEvidence`。**模型不能
 *   自己声明证据**，这也是「可信完成」里「可信」二字的落点。
 *
 * 本模块同样是纯函数，便于单测。 */

/** 隐式验收条件的固定 id。简单问答不强制拆计划（规格 §4.2），它只有这
 *  一条条件：用户的目标本身。id 固定是为了让「步骤全部完成 → 目标达成」
 *  这条推导能在任意一次投影里被识别出来。 */
export const IMPLICIT_CRITERION_ID = "crit_implicit";

/** 任务没有显式验收条件时的隐式条件（规格 §6「简单问答可以只有一个隐式
 *  验收条件，不强制生成复杂计划」）。 */
export function defaultCriteriaFor(goal: string): AcceptanceCriterion[] {
  return [{ id: IMPLICIT_CRITERION_ID, description: goal, required: true, status: "pending", evidenceIds: [] }];
}

/** 步骤 id 由 (taskId, todo 内容) 决定而不是随机生成：模型每轮重发整份
 *  todo 列表是常态，随机 id 会让同一个步骤在每轮里「变成新步骤」，步骤数
 *  无限膨胀、已完成的又对不上号。 */
export function stepIdForContent(taskId: string, content: string): string {
  return `step_${createHash("sha256").update(`${taskId}\u0000${content}`).digest("hex").slice(0, 16)}`;
}

type TodoLike = { content: string; status: TaskStepStatus | "pending" | "in_progress" | "completed" | "cancelled" };

/** 把一份 todo 列表投影到步骤数组上。
 *
 * 【为什么消失的步骤标 cancelled 而不是删除】规格 §10.3 要求重启恢复时
 * 「保留 TaskRecord 和已完成步骤」。已完成的必须留（那是交付依据）；没完成
 * 但模型不再提及的，说明它被重新规划掉了——留成 pending 会让任务永远无法
 * 通过 Completion Gate 的条件 2，删掉又丢掉了「曾经计划过」的信息。
 * 标 cancelled 两者兼顾。 */
export function projectTodos(input: {
  taskId: string;
  steps: readonly TaskStep[];
  todos: readonly TodoLike[];
  now: string;
}): TaskStep[] {
  const { taskId, now } = input;
  const byId = new Map(input.steps.map((step) => [step.id, { ...step }]));
  const seen = new Set<string>();
  let nextOrder = input.steps.reduce((max, step) => Math.max(max, step.order), -1) + 1;

  for (const todo of input.todos) {
    const id = stepIdForContent(taskId, todo.content);
    seen.add(id);
    const existing = byId.get(id);
    const status = todo.status as TaskStepStatus;
    if (!existing) {
      byId.set(id, {
        id,
        title: todo.content,
        status,
        order: nextOrder++,
        evidenceIds: [],
        ...(status === "in_progress" || status === "completed" ? { startedAt: now } : {}),
        ...(status === "completed" ? { completedAt: now } : {}),
      });
      continue;
    }
    // 不做「已完成 → 待办」的回退：模型偶尔重发一份旧列表，把它照单接受
    // 会让已经交付的步骤倒退，Completion Gate 又会把任务打回续跑。
    if (existing.status === "completed" && status !== "completed") continue;
    existing.status = status;
    if (status === "in_progress" && !existing.startedAt) existing.startedAt = now;
    if (status === "completed" && !existing.completedAt) existing.completedAt = now;
  }

  for (const step of byId.values()) {
    if (seen.has(step.id)) continue;
    if (step.status === "completed" || step.status === "cancelled") continue;
    step.status = "cancelled";
  }

  return [...byId.values()].sort((a, b) => a.order - b.order);
}

/** 让隐式条件跟随步骤推进。
 *
 * 【2026-09-19 已删除】这里原来有一个 `projectImplicitCriterion`：看「本轮有没有
 * 输出文本」/「步骤是否都做完了」，据此把隐式条件判 passed。它是一条从**可观测
 * 的弱事实**到**只有当事人知道的结论**之间的跳跃，而且跳得没有依据——
 *
 * 事故：用户发「继续执行」，模型回「继续。跑自检验证前面改动的正确性：」，一句话
 * 停在冒号上、零工具调用、28 个输出 token；`answerPresent` 为真，隐式条件判 passed，
 * Completion Gate 五条件全过，`task.delivered` 照发，交付卡写着「完成了 0 个步骤、
 * 0 次工具调用」「剩余项：无」。任务进终态，用户那句「继续执行」被吞掉。
 *
 * 规格 §3.1 的根因就是「一次运行正常结束 ≠ 用户目标已实现」，而这条推导犯的是同一个
 * 错，只是把「运行结束」换成了「文本非空」。替代方案是 `applyDelivery`：验收条件的
 * 结论只有一个来源——模型在 `task_deliver` 里的**显式声明**；框架不再从任何东西推导
 * 它。这与 `task_block` 注释里那条判断（不猜最终文本，让模型显式声明）是同一条原则
 * 在交付侧的应用。 */
export type DeliveryProjection = {
  criteria: AcceptanceCriterion[];
  result: TaskResult;
  /** 声明里提到、但任务契约里不存在的条件 id（模型写错了）。 */
  unknownCriterionIds: string[];
  /** 仍没有拿到 passed 结论的 required 条件 id——门会据此打回续跑并点名。 */
  unfulfilledRequiredIds: string[];
};

/** 把一次交付声明投影进任务契约（规格 §9 条件 1/3、§14.1 四问）。
 *
 * 【为什么证据是「整份任务集合」而不是按条件挑】工具调用与验收条件之间没有可靠
 * 映射：框架不知道第 3 次 `pnpm build` 服务的是哪一条条件。后果只有两种：全都挂
 * 上，或都不挂。都不挂会让条件 3 永远不满足（每个 passed 条件至少要一条有效证据），
 * 完成判定直接失效；全都挂是保守的那一侧——它不会让**不该通过**的条件通过，只会
 * 让「有证据」这条判定比理想情况宽一点。而真正会骗人的那一步（把模型自己的话当
 * 证据）另有约束：只有任务里**一条别的证据都没有**时，才用声明本身顶上。 */
export function applyDelivery(input: {
  criteria: readonly AcceptanceCriterion[];
  delivery: TaskDeliveryDeclaration;
  evidence: readonly TaskEvidence[];
  /** 交付声明自身被记成的证据 id（仅当任务没有任何工具证据时存在）。 */
  declarationEvidenceId?: string;
  /** 本轮实际编辑过的文件。模型没给 `changes` 时用它兜底。 */
  observedChanges: readonly string[];
}): DeliveryProjection {
  const { criteria, delivery, evidence, declarationEvidenceId, observedChanges } = input;
  // 空数组按「没给」处理：`criteria: []` 与省略是同一个意思，不该因为写了对方括号
  // 就让隐式条件掉进「未声明」分支。
  const declaredList = delivery.criteria?.length ? delivery.criteria : null;
  const declared = new Map((declaredList ?? []).map((item) => [item.id, item]));
  const known = new Set(criteria.map((criterion) => criterion.id));
  const unknownCriterionIds = (declaredList ?? []).filter((item) => !known.has(item.id)).map((item) => item.id);

  // 工具证据优先；一条都没有时（纯解释 / 写作 / 问答，规格 §9 末段）才用交付
  // 声明本身。顺序不能反：反了就是「说过话」压过「做过事」。
  const toolEvidenceIds = evidence.filter((item) => item.kind !== "model_observation").map((item) => item.id);
  const attachable = toolEvidenceIds.length ? toolEvidenceIds : declarationEvidenceId ? [declarationEvidenceId] : [];

  const next = criteria.map((criterion) => {
    const item = declared.get(criterion.id);
    if (!item) {
      // 只有隐式条件、且模型没逐条写：`summary` + `verification` 已经回答了同一个
      // 问题（描述就是用户的目标），视为通过。这是「省略 = 隐式条件通过」的实现处。
      if (!declaredList && criterion.id === IMPLICIT_CRITERION_ID) {
        return { ...criterion, status: "passed" as const, evidenceIds: [...attachable] };
      }
      // 其余未覆盖的保持原状（pending）——门会以「验收条件未通过」打回续跑，
      // 并在 advisory 里点名。不在这里自动补一个结论。
      return { ...criterion };
    }
    // required 条件不接受 not_applicable：那等于用一句话把一整条验收条件抹掉，
    // 而 §9 条件 1 要的是「所有 required 条件 passed」。非 required 条件（将来由
    // 宿主显式添加）允许豁免。
    if (item.status === "not_applicable") {
      return criterion.required ? { ...criterion } : { ...criterion, status: "not_applicable" as const, evidenceIds: [] };
    }
    if (item.status === "failed") {
      // failed 不挂证据：挂上会让「这条条件有证据」与「这条条件没通过」同时为真，
      // 而 §9 条件 3 只对 passed 的条件要求证据。
      return { ...criterion, status: "failed" as const, evidenceIds: [] };
    }
    return { ...criterion, status: "passed" as const, evidenceIds: [...attachable] };
  });

  return {
    criteria: next,
    result: {
      outcome: delivery.summary,
      changes: delivery.changes?.length ? [...delivery.changes] : [...observedChanges],
      verification: [...delivery.verification],
      // §18.7：无剩余项时也要显式给空数组，"没写" 与 "没有" 不能糊在一起。
      remaining: delivery.remaining ? [...delivery.remaining] : [],
    },
    unknownCriterionIds,
    unfulfilledRequiredIds: next.filter((criterion) => criterion.required && criterion.status !== "passed").map((criterion) => criterion.id),
  };
}

/** 工具 → 证据种类。没列出的工具（读文件、搜索、列目录等）返回 null：
 *  **读取不是验证**。把 30 次 read 记成 30 条证据，会让「有证据」这个条件
 *  退化成「调过工具」，规格 §9 条件 3 的意义就没了。 */
const EVIDENCE_KIND_BY_TOOL: Record<string, TaskEvidenceKind> = {
  bash: "command",
  terminal: "command",
  edit: "file_diff",
  write: "file_diff",
  patch: "file_diff",
  webfetch: "external_check",
  websearch: "external_check",
  read_attachment: "tool_result",
  task: "tool_result",
};

export function evidenceKindForTool(tool: string): TaskEvidenceKind | null {
  return EVIDENCE_KIND_BY_TOOL[tool] ?? null;
}

/** 证据上限。超出后淘汰最老的，并同步清掉一切指向它的引用（否则
 *  Completion Gate 的条件 3 会因为悬空引用而永远不满足）。 */
export const MAX_EVIDENCE = 96;

export type EvidenceAppend = {
  evidence: TaskEvidence[];
  /** 被淘汰的证据 id，调用方需要从 criteria/steps 的 evidenceIds 里剔除。 */
  dropped: string[];
};

export function appendEvidence(input: {
  evidence: readonly TaskEvidence[];
  kind: TaskEvidenceKind;
  summary: string;
  ref?: string;
  now: string;
}): EvidenceAppend {
  const { evidence, kind, summary, ref, now } = input;
  // 去重维度 = (kind, ref ?? summary)。同一文件被改多次只保留最后一条，
  // 否则一个格式化的批量编辑能塞满整份证据表，把「有证据」稀释成噪音。
  const keyOf = (item: { kind: TaskEvidenceKind; summary: string; ref?: string }): string =>
    `${item.kind}\u0000${item.ref ?? item.summary}`;
  const key = `${kind}\u0000${ref ?? summary}`;
  const existingIndex = evidence.findIndex((item) => keyOf(item) === key);
  const item: TaskEvidence = {
    id: existingIndex >= 0 ? evidence[existingIndex]!.id : newEvidenceId(),
    kind,
    summary,
    ...(ref ? { ref } : {}),
    createdAt: now,
  };
  const next = existingIndex >= 0
    ? evidence.map((value, index) => (index === existingIndex ? item : value))
    : [...evidence, item];
  if (next.length <= MAX_EVIDENCE) return { evidence: next, dropped: [] };
  const overflow = next.length - MAX_EVIDENCE;
  return { evidence: next.slice(overflow), dropped: next.slice(0, overflow).map((value) => value.id) };
}

/** 从 evidenceIds 里剔除被淘汰的证据 id。 */
export function pruneEvidenceRefs<T extends { evidenceIds: string[] }>(items: readonly T[], dropped: readonly string[]): T[] {
  if (!dropped.length) return [...items];
  const gone = new Set(dropped);
  return items.map((item) => (item.evidenceIds.some((id) => gone.has(id))
    ? { ...item, evidenceIds: item.evidenceIds.filter((id) => !gone.has(id)) }
    : item));
}

/** 新建一个空任务。`status` 从 `queued` 起——`running` 由 runner 认领时置位，
 *  这样「任务已创建但还没被任何 runner 接管」是个可观测的中间态。 */
export function newTaskRecord(input: {
  id: string;
  sessionId: string;
  rootRequestId: string;
  rootUserMessageId: string;
  goal: string;
  now: string;
}): Omit<TaskRecord, "revision"> & { revision: number } {
  return {
    id: input.id,
    sessionId: input.sessionId,
    rootRequestId: input.rootRequestId,
    rootUserMessageId: input.rootUserMessageId,
    goal: input.goal,
    status: "queued",
    acceptanceCriteria: defaultCriteriaFor(input.goal),
    steps: [],
    evidence: [],
    revision: 1,
    attemptCount: 0,
    noProgressCount: 0,
    activeMs: 0,
    constraints: [],
    createdAt: input.now,
    updatedAt: input.now,
  };
}

/** 由目标文本推导一个后备步骤（模型没有调 todo 工具时）。
 *
 *  必要性：Completion Gate 的条件 2 在有步骤时要求全部完成。若模型从不拆解
 *  步骤，`steps` 恒为空，条件 2 自动通过——这没问题；但这样一来「任务做到
 *  哪了」在 UI 上没有任何可展示的进度。给一条与目标同名的单步，让进度条至少
 *  有一个真实的锚点。 */
export function fallbackStep(taskId: string, goal: string): TaskStep {
  return { id: stepIdForContent(taskId, goal), title: goal.slice(0, 80), status: "in_progress", order: 0, startedAt: new Date().toISOString(), evidenceIds: [] };
}

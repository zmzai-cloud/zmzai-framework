import { createHash } from "node:crypto";

import {
  newCriterionId,
  newEvidenceId,
  newTaskStepId,
  type AcceptanceCriterion,
  type TaskEvidence,
  type TaskEvidenceKind,
  type TaskPatch,
  type TaskRecord,
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
 * 为什么需要这一条：隐式条件没有模型显式声明「我达成了」，它的达成只能从
 * 「模型自己拆的步骤都做完了」推导。显式声明的条件（如果将来引入）不受影响。 */
export function projectImplicitCriterion(input: {
  criteria: readonly AcceptanceCriterion[];
  steps: readonly TaskStep[];
  evidenceIds: readonly string[];
  /** 本轮是否产出了最终答复（交付文本）。 */
  answerPresent: boolean;
}): AcceptanceCriterion[] {
  const { criteria, steps, evidenceIds, answerPresent } = input;
  if (!criteria.some((criterion) => criterion.id === IMPLICIT_CRITERION_ID)) return [...criteria];

  const hasOpenSteps = steps.some((step) => step.status === "pending" || step.status === "in_progress" || step.status === "blocked");
  // 有步骤时要求全部完成（步骤是模型的 todo 拆解，它说做完了才算做完）。
  //
  // 没有步骤时（纯解释 / 写作 / 问答，模型没拆 todo）**不能一律判未满足**：
  // 这类任务的真实完成信号就是「有没有给出答复」。曾经这里恒为 false，配合
  // Completion Gate 的条件 1（所有 required 条件必须 passed）会让每一个纯问答
  // 都永远交付不了——空转到 Attempt 上限后报一个 budget blocked。规格 §9 末段
  // 说的就是这个口子：没有工具可跑的任务，最终内容本身是唯一可验证的东西。
  const satisfied = steps.length === 0 ? answerPresent : !hasOpenSteps;

  return criteria.map((criterion) => {
    if (criterion.id !== IMPLICIT_CRITERION_ID) return criterion;
    if (satisfied) {
      return { ...criterion, status: "passed" as const, evidenceIds: [...evidenceIds] };
    }
    // 未满足时不保存证据引用，避免「没通过却有证据」的中间态被误读
    return { ...criterion, status: "pending" as const, evidenceIds: [] };
  });
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

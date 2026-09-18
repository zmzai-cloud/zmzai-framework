/** 持续任务执行（规格 3）的公开面。
 *
 * 模块划分：
 * - `types`    领域模型与状态枚举——唯一的真源
 * - `plan`     运行时事实（todo / 工具结果）→ 任务契约的投影
 * - `completion` Completion Gate：可信完成判定（纯函数）
 * - `progress` 跨 Attempt 的进度指纹与空转检测
 * - `contract` 任务契约的上下文表达与交付文本
 * - `store`    TaskStore 接口 + CAS 不变量 + 内存参考实现 */

export type {
  TaskLifecycleStatus,
  TaskStepStatus,
  AcceptanceCriterionStatus,
  AcceptanceCriterion,
  TaskStep,
  TaskEvidence,
  TaskEvidenceKind,
  TaskBlocker,
  TaskBlockerKind,
  TaskRecord,
  TaskResult,
  TaskPatch,
  CreateTaskInput,
} from "./types.js";
export {
  newTaskId,
  newTaskStepId,
  newCriterionId,
  newEvidenceId,
  isTerminalStatus,
  isWaitingStatus,
  isActiveStatus,
} from "./types.js";

export type { TaskStore } from "./store.js";
export { createMemoryTaskStore, createTaskRecord, applyTaskPatch, TASK_REVISION_CONFLICT } from "./store.js";

export {
  IMPLICIT_CRITERION_ID,
  MAX_EVIDENCE,
  defaultCriteriaFor,
  stepIdForContent,
  projectTodos,
  projectImplicitCriterion,
  evidenceKindForTool,
  appendEvidence,
  pruneEvidenceRefs,
  newTaskRecord,
  fallbackStep,
} from "./plan.js";

export type { CompletionRuntimeState, CompletionVerdict, NoProgressPolicy } from "./completion.js";
export {
  evaluateTaskCompletion,
  lifecycleForBlocker,
  normalizeNoProgressPolicy,
  DEFAULT_NO_PROGRESS_POLICY,
  DEFAULT_MAX_ATTEMPTS,
} from "./completion.js";

export type { ProgressFingerprintInput, ProgressAdvance } from "./progress.js";
export { taskFingerprint, advanceProgress } from "./progress.js";

export { taskContractText, initialTaskContract, fallbackResult, renderResult, remainingSteps } from "./contract.js";

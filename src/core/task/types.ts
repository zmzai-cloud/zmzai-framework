import { randomUUID } from "node:crypto";

/** 持续任务执行的持久化领域模型（规格 3 §6）。
 *
 * 【为什么必须持久化】规格 §19 明文禁止把 TaskRecord 放在 localStorage 或
 * React 状态里。原因不是洁癖：任务要跨越「模型一次运行结束」，要跨越「进程
 * 重启」，还要在断线重连后被另一台设备读到。任何只活在某个进程内存里的记录，
 * 在最需要它的两个时刻（崩溃后、重连后）恰好不存在。
 *
 * 【与 workflow_run 的分工】
 * - `WorkflowRun` 记录**一次内部运行**（Attempt）的入队、认领与终态。
 * - `TaskRecord` 记录**用户的一条目标**从接受到交付的全过程，可包含多次
 *   Attempt、多次工具调用、一次用户授权、一次重启恢复。
 * 前者结束不代表后者完成——这正是规格 §3.1 要修的根因。 */

/** 任务生命周期（规格 §6）。`waiting_*` 三分是有意的：权限、缺信息、
 *  外部状态（登录/验证码/付款）需要用户做的事完全不同，提示文案与按钮
 *  也不同，合并成一个 `waiting` 会让 UI 只能给出笼统的「请处理」。 */
export type TaskLifecycleStatus =
  | "queued"
  | "running"
  | "recovering"
  | "waiting_permission"
  | "waiting_input"
  | "waiting_external"
  | "verifying"
  | "delivered"
  | "blocked"
  | "failed"
  | "cancelled";

export type TaskStepStatus = "pending" | "in_progress" | "completed" | "blocked" | "cancelled";

export type AcceptanceCriterionStatus = "pending" | "passed" | "failed" | "not_applicable";

export type AcceptanceCriterion = {
  id: string;
  description: string;
  required: boolean;
  status: AcceptanceCriterionStatus;
  evidenceIds: string[];
};

export type TaskStep = {
  id: string;
  title: string;
  status: TaskStepStatus;
  order: number;
  startedAt?: string;
  completedAt?: string;
  evidenceIds: string[];
};

/** 证据种类。`model_observation` 是给纯解释/写作类任务留的口子：没有工具
 *  可跑的任务，其最终内容本身就是唯一可验证的东西（规格 §9 末段）。 */
export type TaskEvidenceKind =
  | "tool_result"
  | "file_diff"
  | "command"
  | "test"
  | "preview"
  | "external_check"
  | "model_observation";

export type TaskEvidence = {
  id: string;
  kind: TaskEvidenceKind;
  summary: string;
  ref?: string;
  createdAt: string;
};

/** 阻塞原因（规格 §6）。`resumable` 决定 UI 给「检查后重试」还是只给
 *  「停止任务」——一个不可恢复的阻塞不该摆出可点的重试按钮。 */
export type TaskBlockerKind =
  | "permission"
  | "input"
  | "choice"
  | "external_auth"
  | "unsafe_replay"
  | "budget"
  | "no_progress";

export type TaskBlocker = {
  kind: TaskBlockerKind;
  /** 卡在哪里——给用户看的。必须具体到「哪个动作需要什么」。 */
  message: string;
  /** 用户做完什么之后系统会自动继续。规格 §14.4 禁止只说「请继续」。 */
  requiredAction: string;
  resumable: boolean;
};

export type TaskRecord = {
  id: string;
  sessionId: string;
  /** 触发本任务的 requestId。同一 requestId 重复提交必须返回同一 task。 */
  rootRequestId: string;
  rootUserMessageId: string;
  /** 用户最终想得到什么。压缩上下文后必须仍在（规格 §6 要求）。 */
  goal: string;
  status: TaskLifecycleStatus;
  acceptanceCriteria: AcceptanceCriterion[];
  steps: TaskStep[];
  currentStepId?: string;
  evidence: TaskEvidence[];
  blocker?: TaskBlocker;
  /** CAS 版本号：每次更新 +1。并发 runner 靠它检测竞争（规格 §6）。 */
  revision: number;
  /** 已执行的 Attempt 次数（含 continuation）。 */
  attemptCount: number;
  /** 连续无进展的 Attempt 次数（规格 §10.1）。 */
  noProgressCount: number;
  /** 累计执行时间（毫秒）：各 Attempt 的 `durationMs` 之和。
   *
   *  【为什么不是「now - createdAt」】墙钟会把任务**停下来等用户**的空白也算
   *  进去：一个因为缺授权停了一夜的任务，第二天点「继续」时若直接拿墙钟比对
   *  预算，第一轮还没开始就超时了——那正是「继续」变死按钮的另一种写法。
   *  规格 §10.2 的时间预算要防的是「任务在烧」，不是「任务存在得久」。
   *
   *  口径说清楚：**阻塞期间**（blocked / waiting_* 到下一次放行之间）run 已经
   *  结束，那段空白天然不计；而**轮内的授权等待**是这一轮的一部分，计入。
   *  旧版本落库的任务没有这个字段，读的时候按 0 处理。 */
  activeMs?: number;
  /** 用户中途追加的约束（steering 消息累积），进 continuation 上下文。 */
  constraints: string[];
  createdAt: string;
  updatedAt: string;
  deliveredAt?: string;
  /** 最近一次 Attempt 的进度指纹，用于跨 Attempt 的 no-progress 判定。 */
  lastFingerprint?: string;
  /** 交付文本（规格 §14.1 最终交付卡的四问来源）。 */
  result?: TaskResult;
};

/** 最终交付信息（规格 §9 条件 5 / §14.1 交付卡四问 / §18.7）。 */
export type TaskResult = {
  /** 1. 做成了什么 */
  outcome: string;
  /** 2. 改了哪些主要内容 */
  changes: string[];
  /** 3. 如何验证 */
  verification: string[];
  /** 4. 还有哪些没做完。无剩余项时**必须显式为空数组**，而不是省略——
   *  规格 §18.7 要求「无剩余项时明确为『无』」，省略会让「没写」和
   *  「没有」两种含义糊在一起。 */
  remaining: string[];
};

export type CreateTaskInput = {
  sessionId: string;
  rootRequestId: string;
  rootUserMessageId: string;
  goal: string;
  /** 初始步骤（通常来自模型的 todo 拆解，可后补）。 */
  steps?: TaskStep[];
  /** 初始验收条件。省略时由 `defaultCriteriaFor(goal)` 生成一条隐式条件。 */
  acceptanceCriteria?: AcceptanceCriterion[];
};

/** TaskStore 更新补丁。不允许改 id/sessionId/revision/createdAt——
 *  这些是身份与并发控制字段，必须由 store 自己维护。 */
export type TaskPatch = Partial<Omit<TaskRecord, "id" | "sessionId" | "revision" | "createdAt">>;

export function newTaskId(): string {
  return `task_${randomUUID()}`;
}

export function newTaskStepId(): string {
  return `step_${randomUUID()}`;
}

export function newCriterionId(): string {
  return `crit_${randomUUID()}`;
}

export function newEvidenceId(): string {
  return `evd_${randomUUID()}`;
}

/** 任务是否已进入终态（不再有任何自动推进）。 */
export function isTerminalStatus(status: TaskLifecycleStatus): boolean {
  return status === "delivered" || status === "failed" || status === "cancelled";
}

/** 任务当前是否在等用户做点什么（UI 按钮由它决定）。 */
export function isWaitingStatus(status: TaskLifecycleStatus): boolean {
  return status === "waiting_permission" || status === "waiting_input" || status === "waiting_external" || status === "blocked";
}

/** 是否仍会写工作区（用于「同 session 最多一个 active root task」判定）。 */
export function isActiveStatus(status: TaskLifecycleStatus): boolean {
  return !isTerminalStatus(status);
}

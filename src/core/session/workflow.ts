import { createHash } from "node:crypto";
import type { MessageInfo, ModelRef, Part, SelectedSkill, ThinkingEffort } from "./types.js";
import type { PersistedFrameworkEvent } from "../events/manifest.js";
import type { MessageWithParts } from "./types.js";

/** 一条 prompt 提交的输入（W6 S2 自 runner.ts 原样搬移——它本来就是提交协议，
 *  放在 workflow.ts 也让命令层不必再 import runner）。 */
export type PromptInput = {
  requestId?: string;
  /** 旧契约（v1，data URL）。 */
  attachments?: readonly import("../runtime/attachments.js").InputAttachment[];
  /** 新契约（v2）：附件描述符（规格 2 §11）。与 `attachments` 可并存，便于迁移期混用。 */
  attachmentRefs?: readonly import("../runtime/attachments.js").InputAttachmentRef[];
  text: string;
  agent?: string;
  model?: ModelRef;
  images?: readonly { url: string; mediaType: string }[];
  effort?: ThinkingEffort;
  skill?: SelectedSkill;
  references?: readonly string[];
  /** 归属的持久任务（规格 3 §6）。服务端在创建/复用任务后写入。 */
  taskId?: string;
  /** 内部续跑标记（规格 3 §8.2）。
   *
   *  【为什么这个字段决定「有没有多出一条用户消息」】它存在时，本次运行是
   *  任务自动推进触发的，不是一个用户回合：runner 必须跳过用户消息的投影、
   *  跳过新建 message，只在 systemPrompt 里注入任务契约。规格 §19 禁止的
   *  「用新增一条伪用户消息作为内部 continuation」，防的就是这里做错。 */
  continuation?: { attempt: number; advisory?: string };
  /** 人工放行后的续跑标记（规格 3 §13.2 的 `resume`）。
   *
   *  【与 `continuation` 的区别，以及为什么必须是两个字段】`continuation` 是
   *  任务自己决定「我还没做完」，由 `runTask` 的循环内部产生；`resume` 是**用户
   *  按了一个按钮**。两者都不创建用户消息，但入口不同：`continuation` 永远在
   *  `runTask` 的 while 里自己接着跑，而 `resume` 时的 workflow run 早已
   *  `completed`（任务是因为预算/无进展/等待而停下的，不是排队等认领），
   *  `claimPrompt` 取不到任何东西——所以它必须由 `resumeTask` 直接驱动。
   *  混成一个字段会让「谁有权推进这个任务」变得不可判定。 */
  resume?: true;
};

/** 一条消息被提交后服务端的处置（规格 3 §12 / §13.1，取值与规格逐字一致）。
 *
 *  【`"started"` / `"queued"` 为什么还在】它们是规格 3 之前的旧值。receipt 是
 *  **持久化的 JSON**，历史 `workflow_runs` 行里存的就是它们；把它们从联合里
 *  删掉，读路径拿到旧值时会变成一个类型之外的字符串，调用方 `switch` 不穷尽
 *  也编译不过。读取路径必须容忍，写入路径只产生新值——这是规格 §7「不要直接
 *  改变旧事件结构导致历史重放失败」的同一条原则：新增语义，不推翻旧数据。
 *
 *  【`queued_new_task` 目前不会产生】规格 §12 说「明确提出无关的新目标」应排入
 *  队列等当前任务结束。判定「无关」需要语义理解，代价是一次额外模型往返，而
 *  判错的后果不对称：把无关目标误并进当前任务，用户看到自己的话被当成补充；
 *  反过来把补充说明误判成新任务，就会产生两个抢同一工作区的任务（§18.9 禁止）。
 *  所以默认并入约束（`task_steered`），并在约束文本里明确标注「这是用户在执行
 *  期间补充的」，由模型自己判断要不要改方向。该值保留在协议里以求兼容。 */
export type PromptDisposition =
  | "task_started"
  | "task_steered"
  | "task_resumed"
  | "queued_new_task"
  | "started"
  | "queued";

export type PromptReceipt = {
  ok: true;
  queued: boolean;
  requestId: string;
  runId: string;
  userMessageId: string;
  disposition: PromptDisposition;
  /** 本次消息归属的任务（规格 3 §13.1 要求 prompt 返回 taskId）。 */
  taskId?: string;
};

/** 运行种类（规格 3 §8.2）：**只有 `user_prompt` 创建用户消息**。
 *  `task_continuation` 是任务自动推进的内部续跑，`recovery` 是重启后的恢复。 */
export type WorkflowRunKind = "user_prompt" | "task_continuation" | "recovery";

export type WorkflowState = "queued" | "running" | "completed" | "failed" | "cancelled" | "recovery_required";

export type WorkflowRun = {
  receipt: PromptReceipt;
  input: PromptInput;
  status: WorkflowState;
  revision: number;
  /** 缺失视为 `user_prompt`（规格 3 之前的记录只有用户消息这一种）。 */
  kind?: WorkflowRunKind;
};
export type AcceptedPrompt = { receipt: PromptReceipt; events: PersistedFrameworkEvent[] };
export interface WorkflowStore {
  acceptPrompt(sessionId: string, input: PromptInput, events: { message: MessageInfo; parts: Part[] }): Promise<AcceptedPrompt>;
  claimPrompt(sessionId: string, owner: string): Promise<WorkflowRun | null>;
  finishPrompt(sessionId: string, runId: string, revision: number, state: WorkflowState): Promise<void>;
  recoverInterrupted(sessionId: string): Promise<void>;
  /** 清掉「上一任务的外部副作用尚未确认」这道闸（规格 3 §13.2 的 resume）。
   *
   *  【为什么不复用 clearQueuedPrompts】那个把 `queued` 和 `recovery_required`
   *  一起取消掉。用在「用户核对完，继续」上会顺手丢掉排队中的消息——而那些消息
   *  的正文只存在于 run 的 payload 里，取消就是丢内容（`constraints` 只覆盖并入
   *  当前任务的那种）。这里只放掉 `recovery_required` 的那一条。 */
  clearRecoveryRequired(sessionId: string): Promise<number>;
  workflowRuns(sessionId: string): Promise<WorkflowRun[]>;
  findPrompt(sessionId: string, requestId: string): Promise<WorkflowRun | null>;
  /** 重建输入的一致性快照（W7-S6 修 TOCTOU）：排除集与消息条目同拍读取。
   *  sqlite 实现走单 transaction；不提供的实现由 ContextBuilder 回落两拍。 */
  rebuildSnapshot?(sessionId: string): Promise<{ entries: MessageWithParts[]; excludedUserIds: Set<string> }>;
}

export function promptHash(payload: unknown): string {
  function canonical(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(canonical);
    if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, canonical(item)]));
    return value;
  }
  return createHash("sha256").update(JSON.stringify(canonical(payload))).digest("hex");
}

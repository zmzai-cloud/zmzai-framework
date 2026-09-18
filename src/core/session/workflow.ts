import { createHash } from "node:crypto";
import type { MessageInfo, Part } from "./types.js";
import type { PromptInput } from "../runtime/runner.js";
import type { PersistedFrameworkEvent } from "../events/manifest.js";

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
}

export function promptHash(payload: unknown): string {
  function canonical(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(canonical);
    if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, canonical(item)]));
    return value;
  }
  return createHash("sha256").update(JSON.stringify(canonical(payload))).digest("hex");
}

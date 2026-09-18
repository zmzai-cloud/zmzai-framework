import { z } from "zod";

import type { PermissionRequest } from "../permission/engine.js";
import type { MessageInfo, Part, SessionInfo } from "../session/types.js";

/** Framework event manifest (spec §4.2) — the frozen v0 wire contract.
 *  Every event is persisted to fw_events with a per-session ascending seq and
 *  can be replayed via subscribe(sinceSeq). */

const modelRefSchema = z.object({ providerId: z.string(), modelId: z.string() });

const rulesetSchema = z.array(z.object({ permission: z.string(), pattern: z.string(), action: z.enum(["allow", "deny", "ask"]) }));

export const sessionInfoSchema: z.ZodType<SessionInfo> = z.object({
  id: z.string(),
  workspaceId: z.string(),
  userId: z.string(),
  parentId: z.string().optional(),
  title: z.string(),
  agent: z.string(),
  model: modelRefSchema,
  permission: rulesetSchema,
  queuedPrompts: z.array(z.object({ text: z.string(), agent: z.string().optional(), enqueuedAt: z.string() })),
  lastOutcome: z.enum(["completed", "aborted", "error"]).optional(),
  pinned: z.boolean().optional(),
  archived: z.boolean().optional(),
  time: z.object({ created: z.string(), updated: z.string(), archived: z.string().optional() }),
}) as z.ZodType<SessionInfo>;

export const messageInfoSchema = z.custom<MessageInfo>(
  (value) =>
    typeof value === "object" &&
    value !== null &&
    "role" in value &&
    ((value as { role: unknown }).role === "user" || (value as { role: unknown }).role === "assistant"),
  "invalid MessageInfo",
);

export const partSchema = z.custom<Part>(
  (value) => typeof value === "object" && value !== null && "type" in value && typeof (value as { type: unknown }).type === "string",
  "invalid Part",
);

const permissionRequestSchema = z.object({
  id: z.string(),
  sessionId: z.string(),
  permission: z.string(),
  patterns: z.array(z.string()),
  metadata: z.unknown().optional(),
  always: z.array(z.string()),
  tool: z.object({ messageId: z.string(), callId: z.string() }).optional(),
}) satisfies z.ZodType<PermissionRequest>;

const todoItemSchema = z.object({
  content: z.string(),
  status: z.enum(["pending", "in_progress", "completed", "cancelled"]),
  priority: z.enum(["high", "medium", "low"]).optional(),
});

/** 任务事件（规格 3 §7）：所有事件都带 taskId + revision。
 *
 * 【为什么 revision 要进每个事件而不是只在 task.updated 里】客户端可能从任意
 * 中间位置开始重放（断线重连的 `?since=`），也可能乱序到达。带着 revision
 * 的事件可以被独立地去重、排序与丢弃旧值——规格 §13.3 要求「客户端以
 * seq + taskId + revision 去重、排序和重放」。 */
const taskEventBase = z.object({ taskId: z.string(), revision: z.number() });

const taskStepSchema = z.object({
  id: z.string(),
  title: z.string(),
  status: z.enum(["pending", "in_progress", "completed", "blocked", "cancelled"]),
});

const taskCriterionSchema = z.object({
  id: z.string(),
  description: z.string(),
  required: z.boolean(),
  status: z.enum(["pending", "passed", "failed", "not_applicable"]),
});

const taskBlockerSchema = z.object({
  kind: z.enum(["permission", "input", "choice", "external_auth", "unsafe_replay", "budget", "no_progress"]),
  message: z.string(),
  requiredAction: z.string(),
  resumable: z.boolean(),
});

/** 任务进度事件的公共载荷（规格 §7 建议形状）。 */
const taskProgressData = taskEventBase.extend({
  stepId: z.string().optional(),
  message: z.string(),
  completedSteps: z.number(),
  totalSteps: z.number(),
  evidenceId: z.string().optional(),
});

export const frameworkEventSchemas = {
  "session.updated": z.object({ session: sessionInfoSchema }),
  "session.status": z.object({ status: z.enum(["idle", "running", "waiting_permission", "waiting_input"]) }),
  "session.error": z.object({ name: z.string(), message: z.string() }),
  // 任务终态小结（N5）：run 收尾时由 summary 模型生成的一句自然语言总结，
  // 附带本轮结构化统计（编辑文件数 / 工具调用数 / 完成 todo 数 / 耗时）。
  // 前端据此渲染「任务完成卡」，让「一个 call tool 结束」有了明确收尾。
  "session.summary": z.object({
    text: z.string(),
    kind: z.enum(["completed", "aborted", "error"]),
    meta: z
      .object({
        filesEdited: z.number(),
        toolCalls: z.number(),
        durationMs: z.number(),
      })
      .optional(),
  }),
  // 长任务中途进度快照（N6）：运行超过阈值后周期性发布，记录「已完成 todo 数 /
  //  改过文件 / 最后一步工具 / 累计工具调用」，崩溃/中断后前端可据此提示
  //  「上次进行到哪」，而非只剩一句「断了」。失败/中断的收尾仍由 session.summary
  //  兜底，此事件是运行中的「中间落点」。
  "session.checkpoint": z.object({
    todosDone: z.number().optional(),
    todosTotal: z.number().optional(),
    toolCalls: z.number(),
    lastTool: z.string().optional(),
    elapsedMs: z.number(),
  }),
  "message.updated": z.object({ message: messageInfoSchema }),
  "message.part.updated": z.object({ part: partSchema }),
  "message.part.delta": z.object({ messageId: z.string(), partId: z.string(), field: z.literal("text"), delta: z.string() }),
  // 回溯重发（rewind）：宿主截断转录后发布，data 为被替换的目标用户消息 id
  // （含其自身）。订阅端（投影器/重放）据此把该消息及其后的状态裁掉——
  // 事件按 seq 重放时「旧事件 → rewound → 新 run 事件」的最终态天然正确。
  "session.rewound": z.object({ fromMessageId: z.string() }),
  "permission.asked": z.object({ request: permissionRequestSchema }),
  "permission.replied": z.object({ id: z.string(), reply: z.enum(["once", "always", "reject"]) }),
  "todo.updated": z.object({ todos: z.array(todoItemSchema) }),
  // ---- 持续任务（规格 3 §7）--------------------------------------------------
  // 任务从「用户一条指令」到「可信交付」的生命周期事件。与 session.summary
  // 的分工：summary 是**一次运行的**收尾陈述，task.* 是**用户目标的**状态。
  // UI 只允许 task.delivered 显示「任务完成」（规格 §14.3 / §18.4）。
  "task.started": taskEventBase.extend({
    goal: z.string(),
    steps: z.array(taskStepSchema),
    acceptanceCriteria: z.array(taskCriterionSchema),
  }),
  "task.plan.updated": taskEventBase.extend({
    goal: z.string(),
    steps: z.array(taskStepSchema),
    completedSteps: z.number(),
    totalSteps: z.number(),
  }),
  "task.step.started": taskProgressData,
  "task.step.progress": taskProgressData,
  "task.step.completed": taskProgressData,
  /** 一次 Attempt（内部运行）结束。**不是任务完成**——规格 §8.3 把
   *  「agent.prompt() resolve」「finish_reason: stop」「status 进 idle」
   *  逐条列为不能触发交付的依据，本事件就是那些信号的正确归处：
   *  它们只描述一次运行，UI 只能拿去画执行轨迹。 */
  "task.attempt.finished": taskEventBase.extend({
    attempt: z.number(),
    outcome: z.enum(["completed", "error", "aborted"]),
    summary: z.string().optional(),
    toolCalls: z.number(),
    filesEdited: z.number(),
    durationMs: z.number(),
  }),
  "task.recovery.started": taskEventBase.extend({ message: z.string(), attempt: z.number() }),
  "task.blocked": taskEventBase.extend({ blocker: taskBlockerSchema }),
  "task.verification.started": taskEventBase.extend({ message: z.string() }),
  "task.delivered": taskEventBase.extend({
    result: z.string(),
    evidenceIds: z.array(z.string()),
    filesEdited: z.number(),
    toolCalls: z.number(),
    durationMs: z.number(),
  }),
  "task.failed": taskEventBase.extend({ reason: z.string() }),
  "task.cancelled": taskEventBase.extend({ reason: z.string().optional() }),
  "file.edited": z.object({ path: z.string(), revisionId: z.string(), diff: z.string() }),
  "artifact.created": z.object({
    artifactId: z.string(),
    path: z.string(),
    bytes: z.number(),
    contentType: z.string(),
    downloadUrl: z.string(),
    previewUrl: z.string().optional(),
  }),
  // 子代理生命周期（R3 页面联动）：started/step 以子会话为作用域发布到父会话
  // 事件流（runner 桥接），UI 投影成可展开的子代理卡片。step 只带工具调用
  // 摘要，不含全量输出——子代理工具结果绝不进父消息流。
  "subagent.started": z.object({
    id: z.string(), // childSessionId
    agent: z.string(),
    task: z.string(),
    parentSessionId: z.string(),
  }),
  "subagent.step": z.object({
    id: z.string(),
    tool: z.string(),
    title: z.string().optional(),
    state: z.enum(["running", "completed", "error"]).optional(),
  }),
  "subagent.finished": z.object({
    id: z.string(),
    state: z.enum(["completed", "error"]),
    durationMs: z.number().optional(),
    toolCalls: z.number().optional(),
  }),
} as const;

export type FrameworkEventType = keyof typeof frameworkEventSchemas;

export type FrameworkEvent = {
  [K in FrameworkEventType]: { type: K; data: z.infer<(typeof frameworkEventSchemas)[K]> };
}[FrameworkEventType];

export type PersistedFrameworkEvent = FrameworkEvent & {
  id: string; // evt_...
  sessionId: string;
  seq: number; // per-session ascending, allocated atomically by the store
  at: string; // ISO timestamp
};

export type TodoItem = z.infer<typeof todoItemSchema>;

/** Narrows an unknown payload (e.g. from an SSE frame) to a FrameworkEvent. */
export function parseFrameworkEvent(value: unknown): FrameworkEvent | null {
  if (typeof value !== "object" || value === null) return null;
  const { type, data } = value as { type?: unknown; data?: unknown };
  if (typeof type !== "string" || !(type in frameworkEventSchemas)) return null;
  const schema = frameworkEventSchemas[type as FrameworkEventType];
  const parsed = schema.safeParse(data);
  return parsed.success ? ({ type, data: parsed.data } as FrameworkEvent) : null;
}

/** 构造一条持久化事件记录。
 *
 * 【为什么需要集中在这里】运行时的 `data` 已由上面的 schema 校验，但类型层面
 * TypeScript 无法从「宽联合的 type」反推出对应的 data——`PersistedFrameworkEvent`
 * 是 `FrameworkEvent & {...}`，其中 `FrameworkEvent` 又是一个映射联合，逐成员
 * 匹配要求 `type` 恰好是那个成员的字面量。于是各调用点只能断言。
 *
 * 断言本身不可避免，但**散落在各处会出问题**：原本三处都写 `data: parsed.data
 * as never`，而 `never` 可赋给一切，看起来永远成立——直到联合成员增减到某个
 * 规模，TypeScript 的整体赋值检查行为改变，三处同时报错（规格 3 新增 11 个
 * task 事件时就撞上了）。收敛到一个函数后，联合怎么变都只影响这里，且
 * `unknown` 而不是 `never` 如实表达了「这里放的是未定类型的载荷」。
 *
 * 调用方必须先过对应 schema 的 `safeParse`；本函数不做校验。 */
export function toPersistedEvent(input: {
  id: string;
  sessionId: string;
  seq: number;
  type: FrameworkEventType;
  data: unknown;
  at: string;
}): PersistedFrameworkEvent {
  return input as PersistedFrameworkEvent;
}

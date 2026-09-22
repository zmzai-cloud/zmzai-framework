import { randomUUID } from "node:crypto";
import { validateAttachments, validateAttachmentRefs } from "./attachments.js";
import { notifyEventLogListeners } from "../events/bus.js";
import type { FrameworkEvent } from "../events/manifest.js";
import { PartProjector } from "./pi-bridge.js";
import type { SessionStore } from "../session/store.js";
import type { Part, SessionInfo } from "../session/types.js";
import type { PromptDisposition, PromptInput, PromptReceipt } from "../session/workflow.js";
import { isWaitingStatus, type TaskPatch, type TaskRecord } from "../task/types.js";
import { defaultActiveRunRegistry } from "./active-run-registry.js";
import { RESET_GUARDS_ON_RESUME } from "./task-lifecycle.js";
import type { RunScheduler } from "./run-scheduler.js";

/** 一条新消息与任务的关系（`resolveTaskForPrompt` 的结论）。
 *
 *  `previous` 是改动前的快照：提交可能在这一步之后被 workflow 层拒掉
 *  （RECOVERY_REQUIRED 等），那时必须把任务改回去——没被接受的提交不该留下
 *  任何痕迹。新建任务时 `previous` 为 null，见 `rollbackTaskResolution`。 */
type TaskResolution = {
  task: TaskRecord;
  disposition: PromptDisposition;
  startedTask: boolean;
  previous: TaskRecord | null;
};


export type CommandDeps = {
  store: SessionStore;
  scheduler: RunScheduler;
  /** 任务层 CAS（SessionRunner 提供——任务语义在 runner，W7 归 TaskLifecycle）。 */
  casTask: (task: TaskRecord, patch: TaskPatch) => Promise<TaskRecord>;
  publish: (event: FrameworkEvent, sessionId: string) => Promise<void>;
  /** legacy 模式（无 workflow store）下直启一次 runLoop。 */
  launch: (session: SessionInfo, input: PromptInput) => void;
};

/** prompt 提交链（W6 S4 自 SessionRunner 原样搬移）：附件校验 → 投影用户消息 →
 *  任务归属判定 → acceptPrompt（幂等/409 仍在 WorkflowStore）→ task.started →
 *  触发调度。语义零变化。 */
export class CommandService {
  constructor(private readonly deps: CommandDeps) {}

  /** 为一条新消息决定它归属哪个任务，以及这次提交的处置（规格 §12 / §13.1）。
   *
   *  四种处置的判定依据是**任务当前状态**，不是模型对文本的猜测：
   *  - 无活跃任务 → 开新任务；
   *  - 任务在 waiting_permission / waiting_input / waiting_external / blocked
   *    → 这条消息就是那个「用户动作」，任务恢复；
   *  - 任务在 running → 这条消息是补充/纠正，并入约束。
   *
   *  【为什么不做「这是不是无关新目标」的语义分类】那需要模型判断，代价是一次
   *  额外的往返，而且判错的后果不对称：把无关目标误并进当前任务，用户会看到
   *  自己的话被当成补充说明；反过来把补充说明误判成新任务，则会产生两个抢同一
   *  个工作区的任务（规格 §18.9 禁止的情况）。所以默认并入，并由约束文本明确
   *  标注「这是用户在你执行期间补充的」，让模型自己决定是否改变方向。 */
  private async resolveTaskForPrompt(
    session: SessionInfo,
    input: PromptInput,
    userMessageId: string,
  ): Promise<TaskResolution | null> {
    const store = this.deps.store.task;
    if (!store) return null;
    const requestId = input.requestId!;

    // 幂等：同一 requestId 重复提交返回同一任务，不创建第二个（§13.1 / §17.1.11）
    // 重放时 disposition 描述的是「这条消息与任务的关系」，那是稳定的：
    // 一条消息一旦开启过某个任务，它永远是那个任务的开启者。
    const prior = await store.findTaskByRequestId(session.id, requestId);
    if (prior) return { task: prior, disposition: "task_started", startedTask: false, previous: null };

    const active = await store.getActiveTask(session.id);
    if (active) {
      const resuming = isWaitingStatus(active.status);
      const text = input.text.trim();
      const constraints = text ? [...active.constraints, text].slice(-8) : active.constraints;
      const task = await this.deps.casTask(active, {
        constraints,
        // 恢复：把任务放回可被认领的状态，drain 会接着推进它
        ...(resuming ? { status: "queued" as const } : {}),
        ...(resuming ? { blocker: undefined } : {}),
        ...(resuming ? RESET_GUARDS_ON_RESUME : {}),
      });
      return { task, disposition: resuming ? "task_resumed" : "task_steered", startedTask: false, previous: active };
    }

    const goal = input.text.trim().slice(0, 500) || "（未命名任务）";
    const task = await store.createTask({
      sessionId: session.id,
      rootRequestId: requestId,
      rootUserMessageId: userMessageId,
      goal,
    });
    return { task, disposition: "task_started", startedTask: true, previous: null };
  }

  /** 提交被拒时把任务改回这一步之前的样子（见 `submit` 里的调用点）。
   *
   *  新建的任务**不回滚**：它是这个 requestId 的幂等锚点，删掉会让「同一 requestId
   *  重试」失去依据。留着它没有代价——下一次同 requestId 的提交会命中
   *  `findTaskByRequestId` 拿回同一个任务，别的消息则会被 `getActiveTask` 收编成
   *  steering。 */
  private async rollbackTaskResolution(resolution: TaskResolution | null): Promise<void> {
    if (!resolution?.previous) return;
    const { previous, task } = resolution;
    await this.deps.casTask(task, {
      status: previous.status,
      constraints: previous.constraints,
      // 计数也要一起还原：恢复路径把它们清零了，而这次提交并没有发生。
      noProgressCount: previous.noProgressCount,
      attemptCount: previous.attemptCount,
      activeMs: previous.activeMs ?? 0,
      // 显式区分「清空 blocker」与「保持原样」：undefined 是清除指令
      ...(previous.blocker ? { blocker: previous.blocker } : { blocker: undefined }),
    }).catch(() => undefined);
  }

  /** 原 SessionRunner.prompt() 主体（W6 S4 搬移）。 */
  async submit(sessionId: string, input: PromptInput): Promise<{ queued: boolean } & Partial<PromptReceipt>> {
    input = { ...input, attachments: validateAttachments(input.attachments), attachmentRefs: validateAttachmentRefs(input.attachmentRefs) };
    const session = await this.deps.store.getSession(sessionId);
    if (!session) throw new Error("SESSION_NOT_FOUND");

    if (this.deps.store.workflow) {
      input = { ...input, requestId: input.requestId ?? randomUUID(), model: input.model ?? session.model };
      const projector = new PartProjector({ sessionId, agent: input.agent ?? session.agent, model: input.model! });
      const parts: Part[] = [];
      const message = projector.onUserPrompt(event => {
        if (event.type === "message.part.updated") parts.push(event.data.part);
      }, input.text,input.images,input.skill,input.references,input.attachments,input.attachmentRefs);
      // 先建消息再建任务：TaskRecord.rootUserMessageId 需要真实的消息 id，
      // 事后回填会多一次 CAS，也让「任务与首条消息同生」这条不变量出现空窗。
      const resolution = await this.resolveTaskForPrompt(session, input, message.id);
      if (resolution) input = { ...input, taskId: resolution.task.id };
      let accepted: Awaited<ReturnType<typeof this.deps.store.workflow.acceptPrompt>>;
      try {
        accepted = await this.deps.store.workflow.acceptPrompt(sessionId,input,{ message,parts });
      } catch (error) {
        // 提交被拒（最常见的是 RECOVERY_REQUIRED）。必须把任务改回原样：
        // resolveTaskForPrompt 可能已经清掉 blocker、把状态放回 queued，而这次
        // prompt 根本没被接受——没被接受就没有任何 run 会去推进它，任务会停在
        // queued 上永远等不到，而用户看到的只是一个 409。
        await this.rollbackTaskResolution(resolution);
        throw error;
      }
      for (const event of accepted.events) notifyEventLogListeners(event);
      if (resolution?.startedTask) {
        const task = resolution.task;
        await this.deps.publish(
          { type: "task.started", data: { taskId: task.id, revision: task.revision, goal: task.goal, steps: [], acceptanceCriteria: task.acceptanceCriteria.map((criterion) => ({ id: criterion.id, description: criterion.description, required: criterion.required, status: criterion.status })) } },
          sessionId,
        );
      }
      if (accepted.events.length) this.deps.scheduler.drain(sessionId);
      return {
        ...accepted.receipt,
        ...(resolution ? { disposition: resolution.disposition, taskId: resolution.task.id } : {}),
      };
    }

    if (defaultActiveRunRegistry.has(sessionId)) {
      await this.deps.store.enqueuePrompt(sessionId, {
        text: input.text,
        attachments: input.attachments,
        // 排队消息必须记住附件引用：真正执行时要按 id 重新确认附件仍存在且可读（规格 2 §11）
        ...(input.attachmentRefs?.length ? { attachmentRefs: [...input.attachmentRefs] } : {}),
        images: input.images,
        model: input.model,
        ...(input.agent ? { agent: input.agent } : {}),
        ...(input.effort ? { effort: input.effort } : {}),
        ...(input.skill ? { skill: input.skill } : {}),
        ...(input.references?.length ? { references: [...input.references] } : {}),
        enqueuedAt: new Date().toISOString(),
      });
      return { queued: true };
    }

    this.deps.launch(session, input);
    return { queued: false };
  }
}

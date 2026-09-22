import type { FrameworkEvent, TodoItem } from "../events/manifest.js";
import type { SessionStore } from "../session/store.js";
import type { SessionInfo } from "../session/types.js";
import type { PromptInput, WorkflowState } from "../session/workflow.js";
import { isSessionAwaitingPermission } from "./active-run-registry.js";
import { LoopGuard } from "./loop-guard.js";
import {
  DEFAULT_MAX_ATTEMPTS,
  durationBudgetBlocker,
  evaluateTaskCompletion,
  lifecycleForBlocker,
  normalizeMaxDurationMs,
  normalizeNoProgressPolicy,
  type CompletionRuntimeState,
  type CompletionVerdict,
  type NoProgressPolicy,
} from "../task/completion.js";
import { advanceProgress } from "../task/progress.js";
import { appendEvidence, applyDelivery, pruneEvidenceRefs, projectTodos } from "../task/plan.js";
import { fallbackResult, renderResult } from "../task/contract.js";
import { isTerminalStatus, isWaitingStatus, type TaskBlocker, type TaskEvidenceKind, type TaskPatch, type TaskRecord, type TaskStep } from "../task/types.js";

/** 单次 Attempt（内部运行）的完整结果。
 *
 * 【为什么返回值从 `WorkflowState` 变成这个】任务层需要的不只是「成功还是
 * 失败」：Completion Gate 要判断「有没有可能产生了副作用但结果未知」「哪些
 * 文件被改了」「最后有没有产出交付文本」。这些信息原本散落在 runLoop 的
 * 局部变量里，随函数返回一并丢弃——上层于是只能用 `completed` 这个笼统的
 * 状态去猜用户目标是否达成，这正是规格 §3.1 的根因。 */
export type RunOutcome = {
  state: WorkflowState;
  /** 一次尝试是否正常跑到底（未抛错、未被中断）。 */
  settled: boolean;
  aborted: boolean;
  unknownSideEffect: boolean;
  /** 结果未知的副作用描述（喂给 Completion Gate 的 unsafe_replay）。 */
  sideEffectDetail: string | null;
  filesEdited: string[];
  toolCalls: number;
  durationMs: number;
  /** 以 error 结束的工具调用摘要（只用于续跑提示，不单独构成阻塞）。 */
  toolErrors: string[];
  /** 本轮的最终 assistant 文本（交付说明的来源）。 */
  finalText: string;
  /** 本轮模型最后投递的 todo 列表（步骤投影的输入）。 */
  todos: TodoItem[] | null;
  /** 本轮模型用 `task_block` 声明的阻塞（规格 3 §11）。
   *
   *  只留**最后一次**声明：同一轮里模型可能先说「缺域名」后来又自己找到了，
   *  那就不该再停。后一次声明覆盖前一次，与 `todos` 的口径一致（都是「本轮最后
   *  的状态」，而不是「本轮发生过的事」）。 */
  taskBlock: import("../tools/task-block.js").TaskBlockInput | null;
  /** 本轮模型用 `task_deliver` 提交的交付声明（规格 3 §9 条件 6）。
   *
   *  【为什么它不是「本轮结束的原因」而是一份输入】声明的内容（每条验收条件的
   *  结论、怎么验证的、还剩什么）会由 `applyDelivery` 投影进任务契约；能不能真的
   *  交付，仍由 Completion Gate 独立判定。模型无法用一次调用换来 delivered。
   *
   *  与 `taskBlock` 同口径：只留**最后一次**声明。模型在一轮里先说「交付了」又
   *  发现自己漏了东西、再补一次，应该以最后一次为准。 */
  delivery: import("../tools/task-deliver.js").TaskDeliverInput | null;
  /** 本轮的证据候选（工具热路径上只累积内存，此处统一落库）。 */
  evidenceCandidates: { kind: TaskEvidenceKind; summary: string; ref?: string }[];
  /** 以失败告终时的错误消息（用于区分「可重试的上游抖动」与「真的没救」）。 */
  errorMessage: string | null;
};

/** 终态判定：`continue` 是「还要再跑一轮」，不该走到落终态的地方。
 *  用类型把它挡在外面，`settleTask` 里就不需要再防一次不可能的状态。 */
export type SettledVerdict = Exclude<CompletionVerdict, { status: "continue" }>;

/** 用户明确放行时重置的三个保护计数（新消息恢复、以及 `resumeTask`）。
 *
 *  【为什么必须重置】不重置的话「继续」是个死按钮：因为 no_progress 停下来的任务
 *  计数仍是 3，下一次判定立刻再停；因为轮数预算停下来的任务第 N+1 轮开头就超过
 *  上限，一步都不会跑；时间预算同理——已经烧满一小时的 `activeMs` 会让放行后的
 *  第一轮连起点都过不去。用户点「继续」就是明确授权再做一些，那一刻起保护阈值
 *  应当重新计时——由人来决定要不要继续，正是这类保护的设计前提（规格 §10.1 的
 *  三档策略本来就以「用户可以再来一轮」为前提）。
 *
 *  这不会让任务无限跑：每一次重置都需要一次显式的人工动作，不存在自触发路径。 */
export const RESET_GUARDS_ON_RESUME = { noProgressCount: 0, attemptCount: 0, activeMs: 0 } as const;

/** 上游中断类错误（F6）：模型流偶发终止/连接断开时自动重试，避免偶发中断
 *  直接结束任务（实测 relay 透传 "terminated"、上游断流
 *  "upstream_http2_stream_error" 等）。余额/鉴权等确定性错误不重试。
 *  P1 增强：限流/网关类（429/5xx）也按可重试处理——这类错误本质是上游
 *  暂时不可用，与 terminated 同属"等等就好"，自动退避重试比直接报错体验好。 */
export function isRetryableError(message: string): boolean {
  const normalized = message.toLowerCase();
  return (
    normalized.includes("terminated") ||
    normalized.includes("econnreset") ||
    normalized.includes("socket hang up") ||
    normalized.includes("etimedout") ||
    normalized.includes("api connection error") ||
    normalized.includes("overloaded") ||
    normalized.includes("timeout") ||
    normalized.includes("upstream") ||
    normalized.includes("stream failed") ||
    // 限流 / 网关类（\b 防止误匹配普通数字，如 "1429 tokens"）
    /\b429\b/.test(normalized) ||
    /\b50[234]\b/.test(normalized) ||
    normalized.includes("rate limit") ||
    normalized.includes("too many requests") ||
    normalized.includes("bad gateway") ||
    normalized.includes("service unavailable") ||
    normalized.includes("internal server error")
  );
}

/** 单次任务 Attempt 数的硬上限（规格 §10.1 的要求：宿主调不到「永不拦截」）。
 *  64 轮远超任何正常任务，同时挡住 `maxAttempts: 1e9` 这种把保护关掉的写法。 */
const MAX_ATTEMPT_CEILING = 64;

/** 任务语义的执行回调：跑一次 Attempt（S7 前由 SessionRunner.runLoop 实现）。 */
export type AttemptRunner = (
  session: SessionInfo,
  input: PromptInput,
  acceptedUserId?: string,
  taskContext?: { task: TaskRecord; advisory?: string; continuation?: boolean; loopGuard?: LoopGuard } | null,
) => Promise<RunOutcome>;

export type TaskLifecycleDeps = {
  store: SessionStore;
  publish: (event: FrameworkEvent, sessionId: string) => Promise<void>;
  attemptRunner: AttemptRunner;
  /** 保护阈值来自 RunnerDeps.taskPolicy（宿主可调，但调不到「永不拦截」）。 */
  taskPolicy?: { maxAttempts?: number; maxDurationMs?: number; noProgress?: Partial<NoProgressPolicy> };
};

/** 任务生命周期（W7 S5 自 SessionRunner 原样搬移，spec §7 TaskLifecycle）：
 *  沿用 TaskRecord、续跑、阻塞、交付条件。语义零变化。 */
export class TaskLifecycle {
  constructor(private readonly deps: TaskLifecycleDeps) {}

  async casTask(task: TaskRecord, patch: TaskPatch): Promise<TaskRecord> {
    const store = this.deps.store.task!;
    let latest = task;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        return await store.updateTask(latest.id, latest.revision, patch);
      } catch (error) {
        if (!(error instanceof Error) || error.message !== "TASK_REVISION_CONFLICT") throw error;
        const fresh = await store.getTask(latest.id);
        if (!fresh) throw error;
        latest = fresh;
      }
    }
    throw new Error("TASK_REVISION_CONFLICT");
  }

  /** 权限等待的进入 / 退出（规格 3 §11.1 / §11.2）。
   *
   *  进入时把任务置 `waiting_permission` 并挂 permission blocker；退出（授权通过
   *  或被拒）时置回 `running` 并清 blocker。
   *
   *  【为什么退出后不是 blocked/failed】这次 Attempt 根本没被中断——`engine.ask()`
   *  只是在 `beforeToolCall` 里挂住，决定一到就接着跑同一个工具循环。所以既不发
   *  `task.attempt.finished`，也不创建用户消息、不新建 workflow run（§11.2 明文）。
   *  唯一例外是被拒：拒绝结果会作为工具错误交回模型去试替代方案（§11.3）。
   *
   *  【为什么挂在引擎回调上，而不是 beforeToolCall 里】规则表已经允许的调用不会
   *  弹卡（`ask()` 在 undecided 为空时直接返回），挂在调用点会为这些「秒过」的
   *  调用也标一次等待再撤回，产生成对的假 blocker 事件。`onAsked` 只在真的抛出
   *  一张授权卡时触发。
   *
   *  【为什么按 taskId 重读而不是接一个快照】`runLoop` 会被子代理嵌套调用
   *  （`spawnSubagent`），同一个 runner 实例上同时存在两轮运行。用实例字段记
   *  「当前任务」会被嵌套那轮清掉，父轮的权限等待于是静默丢失。按 id 重读没有
   *  这个共享状态，代价是一次读，而权限询问本来就不是热路径。 */
  async markPermissionWait(taskId: string | undefined, permission: string, patterns: readonly string[], waiting: boolean): Promise<void> {
    const store = this.deps.store.task;
    if (!taskId || !store) return;
    const blocker: TaskBlocker = {
      kind: "permission",
      message: `需要你授权才能执行：${permission}${patterns.length ? `（${patterns.join("、")}）` : ""}`,
      requiredAction: "在授权卡片上选择允许或拒绝；任务会带着你的决定接着跑。",
      resumable: true,
    };
    try {
      const task = await store.getTask(taskId);
      if (!task || isTerminalStatus(task.status)) return;
      const updated = await this.casTask(task, waiting ? { status: "waiting_permission", blocker } : { status: "running", blocker: undefined });
      await this.deps.publish(
        waiting
          ? { type: "task.blocked", data: { taskId: updated.id, revision: updated.revision, blocker } }
          : // 协议里没有 task.resumed；`task.recovery.started` 是唯一表示「任务离开
            // 等待、重新开始推进」的事件，用它并让 message 说清是哪一种。
            { type: "task.recovery.started", data: { taskId: updated.id, revision: updated.revision, message: "授权已处理，继续执行。", attempt: Math.max(1, updated.attemptCount) } },
        updated.sessionId,
      );
    } catch {
      // 等待状态的记账失败不该打断一次正在跑的工具调用——权限本身已经问出去了，
      // 用户点了允许就该让工具跑。任务状态退化成「running」，是保守的那一侧。
    }
  }

  /** 完成判定用的运行时事实。全部来自本轮可观测结果，**不接受模型自述**。
   *
   *  权限等待不在此列：`beforeToolCall` 里的 `engine.ask()` 会一直挂到用户回复，
   *  所以一次 Attempt 收尾时不会有悬空请求（`engine.dispose()` 也会兜底）。
   *  这里仍读一次实际值，是为了覆盖 abort / 异常路径。
   *
   *  【`task_block` 是这条规则的例外吗】不是。它确实由模型发起，但**内容是结构化
   *  的声明**，不是自述的结论：模型说的是「我缺 X」「请你在 A 和 B 之间选」
   *  「你需要去登录」，而不是「我已完成」。前者是事实的输入（只有模型知道自己在
   *  等什么），后者才是不能采信的东西——完成与否始终由 Completion Gate 按步骤、
   *  验收条件与证据独立判定，模型无法用 task_block 换来一个 delivered。 */
  completionStateOf(outcome: RunOutcome, session: SessionInfo): CompletionRuntimeState {
    // 只有「重试已经耗尽、且错误不是上游抖动」才算真的没救（规格 §10.2）。
    // runLoop 内部已对可重试错误做过 5 次退避重试，能走到这里说明它没救回来。
    const fatal = outcome.state === "failed" && !!outcome.errorMessage && !isRetryableError(outcome.errorMessage);
    // `choice` 与 `input` 都落在 waiting_input，但文案与界面动作不同（§14.2），
    // 所以在这里分派而不是揉成一个字符串。
    const block = outcome.taskBlock;
    return {
      attemptSettled: outcome.settled,
      fatalError: fatal ? outcome.errorMessage : null,
      lastError: outcome.errorMessage,
      unknownSideEffect: outcome.unknownSideEffect ? (outcome.sideEffectDetail ?? "存在结果不确定的操作") : null,
      pendingPermissions: isSessionAwaitingPermission(session.id) ? 1 : 0,
      unsafeReplay: null,
      budgetExhausted: null,
      externalAuthRequired: block?.kind === "external_auth" ? { message: block.message, requiredAction: block.requiredAction } : null,
      inputRequired: block?.kind === "input" ? { message: block.message, requiredAction: block.requiredAction } : null,
      choiceRequired: block?.kind === "choice" ? { message: block.message, requiredAction: block.requiredAction } : null,
      unresolvedToolErrors: outcome.toolErrors,
      finalTextPresent: outcome.finalText.trim().length > 0,
      cancelled: outcome.aborted,
    };
  }

  /** 步骤变化 → 事件。粒度按「状态真的变了」算，重放时不会重复累计。 */
  private async publishStepEvents(previous: readonly TaskStep[], next: TaskRecord, sessionId: string): Promise<void> {
    const before = new Map(previous.map((step) => [step.id, step.status]));
    const completed = next.steps.filter((step) => step.status === "completed").length;
    for (const step of next.steps) {
      if (before.get(step.id) === step.status) continue;
      const type = step.status === "completed" ? "task.step.completed" : step.status === "in_progress" ? "task.step.started" : null;
      if (!type) continue;
      await this.deps.publish(
        { type, data: { taskId: next.id, revision: next.revision, stepId: step.id, message: step.title, completedSteps: completed, totalSteps: next.steps.length } },
        sessionId,
      );
    }
    if (before.size !== next.steps.length) {
      await this.deps.publish(
        {
          type: "task.plan.updated",
          data: {
            taskId: next.id,
            revision: next.revision,
            goal: next.goal,
            steps: next.steps.map((step) => ({ id: step.id, title: step.title, status: step.status })),
            completedSteps: completed,
            totalSteps: next.steps.length,
          },
        },
        sessionId,
      );
    }
  }

  /** 把本轮的可观测事实投影进任务契约：步骤、证据、隐式验收条件、进度指纹。
   *
   *  顺序不能换：证据先于验收条件（条件要引用 evidence id），而指纹最后算
   *  （它是对「投影后的完整状态」取摘要）。 */
  private async syncTaskFromAttempt(task: TaskRecord, outcome: RunOutcome, sessionId: string): Promise<TaskRecord> {
    const now = new Date().toISOString();

    // 1) 步骤（来自模型的 todo 拆解）
    const steps = outcome.todos
      ? projectTodos({ taskId: task.id, steps: task.steps, todos: outcome.todos, now })
      : task.steps;

    // 2) 证据（只收成功的写/执行/外部核对）
    let evidence = task.evidence;
    const dropped: string[] = [];
    for (const candidate of outcome.evidenceCandidates) {
      const appended = appendEvidence({ evidence, kind: candidate.kind, summary: candidate.summary, ...(candidate.ref ? { ref: candidate.ref } : {}), now });
      evidence = appended.evidence;
      dropped.push(...appended.dropped);
    }

    // 2b) 交付声明必须留下可追溯的证据（规格 §9 条件 3 的口子，§9 末段）。
    //
    // 【这里原来是「本轮只要有最终文本就记一条 model_observation」】那条规则把
    // 「文本非空」直接变成了「有证据」，而证据又是条件 3 的输入——两个弱事实串起来
    // 就凑出了一次交付。删掉它之后，纯解释 / 写作 / 问答类任务（没有工具可跑，
    // 最终内容本身是唯一可验证的东西）靠**交付声明**拿到那一条证据：声明里
    // `verification` 至少一条是 schema 强制的，也就是说模型必须先说清「怎么验证的」，
    // 才拿得到这个口子——从「说过话」变成「说清了验证方式」，这是那条放宽能成立的下限。
    //
    // 【ref 固定为 task_deliver】`appendEvidence` 的去重键是 (kind, ref)，固定 ref
    // 让重复交付**更新同一条**而不是不断新增。这不是省空间：进度指纹里
    // `criteria.evidenceIds.length` 参与计算，每次交付都新增一条会让「反复交付」
    // 看起来像在推进，no-progress 保护就失效了。
    //
    // 【只在任务没有任何工具证据时补】有工具证据的任务不该靠模型的自述通过验证，
    // 那会让「有证据」重新退化成「说过话」。
    const hasToolEvidence = evidence.some((item) => item.kind !== "model_observation");
    let declarationEvidenceId: string | undefined;
    if (outcome.delivery && !hasToolEvidence) {
      const appended = appendEvidence({
        evidence,
        kind: "model_observation",
        summary: outcome.delivery.verification.join("；").slice(0, 160),
        ref: "task_deliver",
        now,
      });
      evidence = appended.evidence;
      dropped.push(...appended.dropped);
      declarationEvidenceId = evidence.find((item) => item.kind === "model_observation" && item.ref === "task_deliver")?.id;
    }

    // 3) 引用清理 + 验收条件。淘汰证据后必须同步清引用，否则条件会因为
    //    悬空引用永远不满足（Completion Gate 的条件 3 只认能对上号的证据）。
    const prunedSteps = pruneEvidenceRefs(steps, dropped);
    const prunedCriteria = pruneEvidenceRefs(task.acceptanceCriteria, dropped);
    // 验收条件的结论只有一个来源：模型在 `task_deliver` 里的显式声明。此前这里的
    // `projectImplicitCriterion` 会从「模型这轮有没有输出文本」推导出结论——那次
    // 推导就是「一句话停在冒号上也能交付」的成因（见 `plan.ts`）。
    const projection = outcome.delivery
      ? applyDelivery({
          criteria: prunedCriteria,
          delivery: outcome.delivery,
          evidence,
          ...(declarationEvidenceId ? { declarationEvidenceId } : {}),
          observedChanges: outcome.filesEdited,
        })
      : null;
    const acceptanceCriteria = projection?.criteria ?? prunedCriteria;

    // 4) 进度指纹（含本轮的文件改动）
    const projected: TaskRecord = { ...task, steps: prunedSteps, evidence, acceptanceCriteria };
    const progress = advanceProgress(projected, { editedFiles: outcome.filesEdited, toolCalls: outcome.toolCalls });

    const updated = await this.casTask(task, {
      steps: prunedSteps,
      evidence,
      acceptanceCriteria,
      ...(projection ? { result: projection.result } : {}),
      lastFingerprint: progress.fingerprint,
      noProgressCount: progress.noProgressCount,
      // 时间预算的累计口径：这一轮实际跑了多久（见 `TaskRecord.activeMs`）。
      // 放在这里而不是 `settleTask`，是因为**每一轮**都要记账——只在结算时记，
      // 一个连跑 20 轮才停的任务会把整段时间全部漏掉，预算永远不触发。
      activeMs: (task.activeMs ?? 0) + outcome.durationMs,
    });
    await this.publishStepEvents(task.steps, updated, sessionId);
    return updated;
  }

  /** 任务进入终态（或阻塞）：落库 + 发事件，返回这次 run 的 workflow 状态。
   *
   *  blocked 返回 `"completed"` 而不是 `"failed"`：这次运行本身正常结束了，
   *  任务是在等外部动作。返回 failed 会让 workflow 层把它当成运行崩溃处理
   *  （还会触发 recovery 路径），那是错的。 */
  private async settleTask(
    task: TaskRecord,
    verdict: SettledVerdict,
    session: SessionInfo,
    stats: { filesEdited: string[]; toolCalls: number; durationMs: number },
  ): Promise<WorkflowState> {
    const now = new Date().toISOString();
    const taskId = task.id;

    if (verdict.status === "delivered") {
      const result = task.result ?? fallbackResult({ task, filesEdited: stats.filesEdited, toolCalls: stats.toolCalls });
      const updated = await this.casTask(task, { status: "delivered", deliveredAt: now, result });
      await this.deps.publish(
        {
          type: "task.delivered",
          data: {
            taskId,
            revision: updated.revision,
            // `result` 是渲染好的文本（通知、复制、旧客户端都在用它）；
            // `delivery` 是同一份信息的结构化形态，给交付卡按四问分别渲染。
            // 【为什么两份都给】把结构化数据塞进一个字符串再让客户端解析，是此前
            // 「剩余项」出现两次的原因（`lib/chat-projector.ts` 把整段文本当成
            // `outcome`，四问里剩下的位置自然全空）。发两份比让客户端做字符串解析稳。
            result: renderResult(result),
            delivery: {
              outcome: result.outcome,
              changes: [...result.changes],
              verification: [...result.verification],
              remaining: [...result.remaining],
            },
            // 交付卡上「验收 x/y · 证据 n 条」两个数字的**权威来源**。此前它们
            // 只能靠客户端从 task.started（那一刻的条件永远全是 pending）和证据
            // 数组（事件流里根本没有）拼出来，于是界面上恒显示「验收 0/1 · 证据
            // 0 条」，与实际相反——而这一行恰恰是规格 §18.4 给用户「不必相信这句
            // 完成」的核对依据，一个恒错的核对依据比没有更糟。
            criteria: updated.acceptanceCriteria.map((criterion) => ({
              id: criterion.id,
              description: criterion.description,
              required: criterion.required,
              status: criterion.status,
            })),
            evidenceCount: updated.evidence.length,
            evidenceIds: updated.evidence.map((item) => item.id),
            filesEdited: stats.filesEdited.length,
            toolCalls: stats.toolCalls,
            durationMs: stats.durationMs,
          },
        },
        session.id,
      );
      return "completed";
    }

    if (verdict.status === "failed") {
      const updated = await this.casTask(task, { status: "failed" });
      await this.deps.publish({ type: "task.failed", data: { taskId, revision: updated.revision, reason: verdict.reason } }, session.id);
      return "failed";
    }

    if (verdict.status === "cancelled") {
      const updated = await this.casTask(task, { status: "cancelled" });
      await this.deps.publish({ type: "task.cancelled", data: { taskId, revision: updated.revision, reason: verdict.reason } }, session.id);
      return "cancelled";
    }

    // blocked / waiting_*：阻塞种类决定状态，UI 据此给对应按钮（规格 §14.2）
    const status = lifecycleForBlocker(verdict.blocker.kind);
    const updated = await this.casTask(task, { status, blocker: verdict.blocker });
    await this.deps.publish({ type: "task.blocked", data: { taskId, revision: updated.revision, blocker: verdict.blocker } }, session.id);
    return "completed";
  }

  /** 一个持久任务的执行循环（规格 §8.1 总流程）。
   *
   *  【为什么续跑在同一次调用内循环，而不是每轮新建一个 workflow run】
   *  1. lease 与串行队列：任务执行期间必须持有 session 的执行权。每轮重建 run
   *     意味着每轮都要重新 claim/lease，中间会出现「谁都没持有」的窗口——那
   *     正是两个 runner 并行改同一工作区的入口。
   *  2. 规格 §8.2.5 要求「继续使用 session 级串行队列和 lease」，循环是最直接
   *     的实现。轮次计数落在 `TaskRecord.attemptCount` 上，所以进程重启后恢复
   *     扫描仍能知道跑到第几轮。
   *
   *  出口只有两个：任务进入终态，或需要用户/外部动作。单次模型停止、step 上限、
   *  本轮没有工具调用，**都不是**出口（规格 §8.3 逐条列出）。 */
  async runTask(session: SessionInfo, input: PromptInput, acceptedUserId?: string): Promise<WorkflowState> {
    const taskStore = this.deps.store.task;
    // 没有 TaskStore：退化为一次性运行。工具、权限、事件全部照常，只是没有
    // 「跨运行的目标」这层语义——这不是错误路径，而是宿主未启用该能力的降级。
    if (!taskStore) return (await this.deps.attemptRunner(session, input, acceptedUserId)).state;

    let task = input.taskId ? await taskStore.getTask(input.taskId) : await taskStore.getActiveTask(session.id);
    if (!task) return (await this.deps.attemptRunner(session, input, acceptedUserId)).state;

    // `waiting_*` / `blocked` 意味着「在等用户做一个具体动作」，唯一有权解除它的
    // 是 `resolveTaskForPrompt`——那条新消息本身就是用户动作。这里再挡一道，是因为
    // **排队中的补充消息可能在阻塞之后才被 drain 到**：用户写下它的时候还没看到
    // 阻塞原因，把它当成「已经看过并响应了」会静默清掉用户根本没读到的提示。
    // （那条消息的正文已经并进了 `constraints`，不会丢，用户真正回应时会被带上。）
    if (isWaitingStatus(task.status)) return "completed";

    const maxAttempts = Math.min(MAX_ATTEMPT_CEILING, Math.max(1, Math.floor(this.deps.taskPolicy?.maxAttempts ?? DEFAULT_MAX_ATTEMPTS)));
    const maxDurationMs = normalizeMaxDurationMs(this.deps.taskPolicy?.maxDurationMs);
    const noProgressPolicy = this.deps.taskPolicy?.noProgress;

    // 从第二轮起，驱动这台机器的是任务自己（`continuation`），不再是「用户按过
    // 按钮」那件事。把 `resume` 摘掉，否则 driveText 会一路走放行话术，掩盖了
    // 真正发生的事（系统在自动续跑）。
    const { resume: _resume, ...strippedInput } = input;
    let attemptInput: PromptInput = input;
    let advisory: string | undefined;
    let continuation = false;
    // 整个任务共用一个循环防护实例（规格 §16 阶段 D「loop-guard 扩展为跨 Attempt」）
    const loopGuard = new LoopGuard();
    let stats = { filesEdited: [] as string[], toolCalls: 0, durationMs: 0 };

    while (true) {
      const attemptNumber = task.attemptCount + 1;
      // 时间预算先于轮数预算：两者的消息都指向「看一眼轨迹、确认目标是否要收窄」，
      // 但先报出的应该是**已经烧掉多少时间**——那是用户此刻最需要知道的事实，
      // 而轮数只在所有轮都很快时才成为瓶颈。
      const overTime = durationBudgetBlocker(task, maxDurationMs);
      if (overTime) return await this.settleTask(task, { status: "blocked", blocker: overTime }, session, stats);
      if (attemptNumber > maxAttempts) {
        return await this.settleTask(task, {
          status: "blocked",
          blocker: {
            kind: "budget",
            message: `已达单次任务的最大执行轮数（${maxAttempts} 轮）。`,
            requiredAction: "看一眼执行轨迹，确认目标是否需要收窄；确认后可以继续。",
            resumable: true,
          },
        }, session, stats);
      }

      task = await this.casTask(task, { status: "running", attemptCount: attemptNumber, blocker: undefined });
      // 续跑时明确告诉用户「系统在自己接着做」，而不是又开了一轮对话
      if (continuation) {
        await this.deps.publish(
          { type: "task.recovery.started", data: { taskId: task.id, revision: task.revision, message: advisory ?? "继续推进任务", attempt: attemptNumber } },
          session.id,
        );
      }

      const outcome = await this.deps.attemptRunner(session, attemptInput, acceptedUserId, {
        task,
        loopGuard,
        ...(advisory ? { advisory } : {}),
        ...(continuation ? { continuation: true } : {}),
      });
      stats = { filesEdited: outcome.filesEdited, toolCalls: outcome.toolCalls, durationMs: outcome.durationMs };

      task = await this.syncTaskFromAttempt(task, outcome, session.id);

      // 一次 Attempt 结束——**不是**任务完成（规格 §8.3）。UI 只能拿它画轨迹。
      await this.deps.publish(
        {
          type: "task.attempt.finished",
          data: {
            taskId: task.id,
            revision: task.revision,
            attempt: attemptNumber,
            outcome: outcome.aborted ? "aborted" : outcome.state === "failed" ? "error" : "completed",
            toolCalls: outcome.toolCalls,
            filesEdited: outcome.filesEdited.length,
            durationMs: outcome.durationMs,
          },
        },
        session.id,
      );

      const verdict = evaluateTaskCompletion(task, this.completionStateOf(outcome, session), noProgressPolicy);
      if (verdict.status !== "continue") return await this.settleTask(task, verdict, session, stats);

      // ---- 内部续跑：不创建用户消息，不新建 workflow run ----
      advisory = verdict.advisory;
      continuation = true;
      attemptInput = { ...strippedInput, continuation: { attempt: attemptNumber + 1, ...(advisory ? { advisory } : {}) } };
      // 上一轮是上游抖动的话，立刻重打一次没有意义——给它一个短退避
      if (outcome.state === "failed") await new Promise((resolve) => setTimeout(resolve, 1_000));
    }
  }
}

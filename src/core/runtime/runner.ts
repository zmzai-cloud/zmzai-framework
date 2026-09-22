import { Agent, type AgentMessage } from "@earendil-works/pi-agent-core";
import {
  attachmentContent,
  attachmentRefContent,
  type AttachmentContentRef,
} from "./attachments.js";
import type { Api, Model } from "@earendil-works/pi-ai";

import { AgentRegistry, type AgentInfo } from "../agent/registry.js";
import type { AgentResolver, ResolvedAgent } from "../agent/resolver.js";
import { notifyEventLogListeners, type EventLog } from "../events/bus.js";
import type { FrameworkEvent, TodoItem } from "../events/manifest.js";
import { PermissionEngine, RejectedError, type Reply } from "../permission/engine.js";
import type { Ruleset } from "../permission/ruleset.js";
import { confineWorkspaceFiles, writePathGuardRules } from "../permission/write-path.js";
import { defaultActiveRunRegistry } from "./active-run-registry.js";
import { CommandService, RESET_GUARDS_ON_RESUME } from "./command-service.js";
import { RunScheduler } from "./run-scheduler.js";
import { PartProjector, serializeEmit } from "./pi-bridge.js";
import { LoopGuard, REPEAT_EDIT_FAILURE_THRESHOLD } from "./loop-guard.js";
import type { SessionStore } from "../session/store.js";
import { newPartId, newSessionId } from "../session/ids.js";
import type { ModelRef, Part, SelectedSkill, SessionInfo, ThinkingEffort } from "../session/types.js";
import { adaptAnyTool, permissionForCall } from "../tools/adapter.js";
import { builtinTools } from "../tools/builtins.js";
import type { ToolContext, WorkspaceFiles } from "../tools/context.js";
import type { AnyToolDef } from "../tools/def.js";
import { isExternalToolDef } from "../tools/def.js";
import { TASK_BLOCK_TOOL_ID, readTaskBlock, type TaskBlockInput } from "../tools/task-block.js";
import { TASK_DELIVER_TOOL_ID, readTaskDelivery, type TaskDeliverInput } from "../tools/task-deliver.js";
import { fireRunStart, firstToolBlock, fireAfterToolCall, fireRunEnd, type LifecycleHook } from "./lifecycle.js";
import { extractRunTranscript, RETRY_PLACEHOLDER_TEXT, type RunTranscriptMessage } from "./run-transcript.js";
import type { SandboxExecutor } from "../../adapters/index.js";
import { noopSandboxExecutor } from "../../adapters/index.js";
import type { PromptInput, PromptReceipt, WorkflowState } from "../session/workflow.js";
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
import {
  appendEvidence,
  applyDelivery,
  evidenceKindForTool,
  fallbackStep,
  projectTodos,
  pruneEvidenceRefs,
} from "../task/plan.js";
import { fallbackResult, remainingSteps, renderResult, taskContractText } from "../task/contract.js";
import { isTerminalStatus, isWaitingStatus, type TaskBlocker, type TaskEvidenceKind, type TaskPatch, type TaskRecord, type TaskStep } from "../task/types.js";

/** SessionRunner (spec §8.1): owns one session's full lifecycle — prompt →
 *  PI agent loop → persisted parts + framework events → terminal settlement
 *  → queued prompt continuation. Permission checks happen only in
 *  beforeToolCall (spec §5.4).
 *
 *  M5: fully storage/backend-agnostic. All product surfaces (model, sandbox,
 *  workspace files, event log, lease) are injected. */

export type { ThinkingEffort } from "../session/types.js";

/** 提交协议类型已移至 session/workflow.ts（W6 S2）；此处再导出保持外部导入路径不变。 */
export type { PromptInput } from "../session/workflow.js";

/** Product-owned resolver. It must be session-root aware and return trusted, bounded text. */
export type MandatorySkillResolver = (session: SessionInfo, skill: SelectedSkill) => Promise<{ context: string }>;

export type RunnerDeps = {
  store: SessionStore;
  registry: AgentRegistry;
  /** Built per run so multi-tenant deployments bind the right billing
   *  identity (relay stream is keyed by userId). */
  streamFnFor: (session: SessionInfo) => ConstructorParameters<typeof Agent>[0]["streamFn"];
  modelFor: (ref: ModelRef) => Model<Api>;
  /** Durable event log (framework events). Product supplies Mongo; package
   *  ships in-memory/JSONL. */
  eventLog: EventLog;
  /** Workspace file backend. Product supplies Mongo; package ships FS/JSONL. */
  workspaceFor: (session: SessionInfo) => WorkspaceFiles;
  /** Isolated command execution. Product supplies OpenSandbox; package ships a
   *  subprocess reference implementation. */
  sandbox?: SandboxExecutor;
  /** Lease store (runner stamps while owning a run). */
  leaseStore?: { stamp(sessionId: string, owner: string, expiresAt: Date): Promise<void>; clear(sessionId: string): Promise<void> };
  /** Product approval sessions may persist an "always" rule with a bounded
   * lifetime. The in-memory rule remains valid for the current run. */
  sessionRuleTtlMs?: number;
  tools?: AnyToolDef[];
  /** 本机工具（用户桌面机器上的 fs/shell/notify）。产品经 relay → bridge 下发
   *  到桌面客户端，客户端本地审批后执行。与 sandbox 的云端执行相互独立。
   *  MCP server 工具（ExternalToolDef）也走这里注入。 */
  localTools?: AnyToolDef[];
  buildToolContext?: (input: { session: SessionInfo; engine: PermissionEngine }) => ToolContext;
  /** Loads workspace custom agents (spec §6.3). */
  loadWorkspaceAgents?: (session: SessionInfo) => Promise<AgentInfo[]>;
  /** Optional control-plane lookup for an immutable Agent Version. */
  agentResolver?: AgentResolver;
  /** Max subagent nesting depth (spec §6.4, default 1). */
  subagentDepth: number;
  /** Auto-compaction (spec §8.3). Disabled when summaryModel is null. */
  compaction?: { enabled: boolean; contextWindow: number; summaryModel: Model<Api> | null };
  /** 生命周期钩子（P0）：observe/block。抛错只告警不中断运行。 */
  hooks?: LifecycleHook[];
  /** 长期记忆召回（spec §记忆）：run 开始时按当前 prompt 查询，返回文本
   *  则作为首条 in-memory user 消息前插（不落 store）。抛错/返回空时零影响。 */
  memoryContextFor?: (session: SessionInfo, text: string) => Promise<string | undefined>;
  resolveMandatorySkill?: MandatorySkillResolver;
  /** 附件正文读取器（规格 2 §9.2）。未注入时描述符只能渲染成清单，
   *  图片与小型文本附件也不会被内联——功能降级但不报错。 */
  attachments?: import("./attachments.js").AttachmentProvider;

  /** 持续任务执行的保护阈值（规格 3 §10.1 / §16 阶段 D）。
   *  两者都有上限（见 normalizeNoProgressPolicy），宿主调不到「永不拦截」。 */
  taskPolicy?: {
    /** 单次任务最多跑几次 Attempt（含 continuation）。 */
    maxAttempts?: number;
    /** 单次任务的时间预算：累计**实际执行**时间的上限（毫秒）。
     *  只累加各 Attempt 真正在跑的时间，等用户的时间不算（见 `activeMs`）。 */
    maxDurationMs?: number;
    noProgress?: Partial<NoProgressPolicy>;
  };
};

/** 事件的 sessionId 提取：能自带的自带（message/part/session），其余
 *  （message.part.delta 等）用发起 run 的会话 id 兜底。 */
function sessionIdOf(event: FrameworkEvent, fallbackSessionId: string): string {
  if (event.type === "message.updated") return event.data.message.sessionId;
  if (event.type === "message.part.updated") return event.data.part.sessionId;
  if (event.type === "session.updated") return event.data.session.id;
  return fallbackSessionId;
}

/** 活跃 run 表已抽离到 active-run-registry.ts（W6 S1）；这里保留同名引用，
 *  使搬移范围内的调用点 diff 最小。 */
const activeRuns = defaultActiveRunRegistry;

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

/** Default ToolContext built from injected workspace + sandbox. emitX events
 *  are routed through the runner's eventLog at call time. */
function defaultToolContext(input: { session: SessionInfo; engine: PermissionEngine; workspace: WorkspaceFiles; sandbox: SandboxExecutor; emit: (event: FrameworkEvent) => Promise<void> }): ToolContext {
  const { session, engine, workspace, sandbox, emit } = input;
  return {
    sessionId: session.id,
    userId: session.userId,
    workspaceId: session.workspaceId,
    agent: session.agent,
    abort: new AbortController().signal,
    ask: engine.ask.bind(engine),
    workspace,
    buildSnapshot: async () => sandbox.buildSnapshot({ userId: session.userId, workspaceId: session.workspaceId, runId: session.id }),
    runSandbox: async (execInput) => {
      const result = await sandbox.run({
        ...execInput,
        userId: session.userId,
        workspaceId: session.workspaceId,
        runId: session.id,
      });
      return result;
    },
    setTodos: async (todos) => {
      await emit({ type: "todo.updated", data: { todos } });
    },
    emitFileEdited: async (payload) => {
      await emit({ type: "file.edited", data: payload });
    },
    emitArtifact: async (payload) => {
      await emit({ type: "artifact.created", data: payload });
    },
  };
}

/** 单次 Attempt（内部运行）的完整结果。
 *
 * 【为什么返回值从 `WorkflowState` 变成这个】任务层需要的不只是「成功还是
 * 失败」：Completion Gate 要判断「有没有可能产生了副作用但结果未知」「哪些
 * 文件被改了」「最后有没有产出交付文本」。这些信息原本散落在 runLoop 的
 * 局部变量里，随函数返回一并丢弃——上层于是只能用 `completed` 这个笼统的
 * 状态去猜用户目标是否达成，这正是规格 §3.1 的根因。 */
type RunOutcome = {
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
  taskBlock: TaskBlockInput | null;
  /** 本轮模型用 `task_deliver` 提交的交付声明（规格 3 §9 条件 6）。
   *
   *  【为什么它不是「本轮结束的原因」而是一份输入】声明的内容（每条验收条件的
   *  结论、怎么验证的、还剩什么）会由 `applyDelivery` 投影进任务契约；能不能真的
   *  交付，仍由 Completion Gate 独立判定。模型无法用一次调用换来 delivered。
   *
   *  与 `taskBlock` 同口径：只留**最后一次**声明。模型在一轮里先说「交付了」又
   *  发现自己漏了东西、再补一次，应该以最后一次为准。 */
  delivery: TaskDeliverInput | null;
  /** 本轮的证据候选（工具热路径上只累积内存，此处统一落库）。 */
  evidenceCandidates: { kind: TaskEvidenceKind; summary: string; ref?: string }[];
  /** 以失败告终时的错误消息（用于区分「可重试的上游抖动」与「真的没救」）。 */
  errorMessage: string | null;
};

/** 终态判定：`continue` 是「还要再跑一轮」，不该走到落终态的地方。
 *  用类型把它挡在外面，`settleTask` 里就不需要再防一次不可能的状态。 */
type SettledVerdict = Exclude<CompletionVerdict, { status: "continue" }>;

/** 人工放行时喂给模型的驱动文本（与 `continuation` 那条同源但不同话术）。
 *
 *  它同样**不落库**：`resumeTask` 不经过 `prompt()`，没有 message、没有 workflow
 *  receipt，`acceptedUserId` 为 undefined——但这里必须显式跳过投影，因为
 *  `acceptedUserId` 为空正是「投影一条用户消息」的默认路径（见 runLoop）。
 *  用一个专门的标记区分，才不会把「继续」画成用户说过的话。 */
const RESUME_DRIVE_TEXT =
  "[继续执行任务] 用户已经核对过当前状态并授权继续。按上面的任务契约接着推进，不要从头再做一遍，也不要把控制权提前交回用户。";

/** 单次任务 Attempt 数的硬上限（规格 §10.1 的要求：宿主调不到「永不拦截」）。
 *  64 轮远超任何正常任务，同时挡住 `maxAttempts: 1e9` 这种把保护关掉的写法。 */
const MAX_ATTEMPT_CEILING = 64;

export class SessionRunner {
  private readonly scheduler: RunScheduler;
  private readonly commandService: CommandService;

  constructor(private readonly deps: RunnerDeps) {
    // 调度（drain 驱动链 / 放行登记 / 停止协调 / 租约）在 RunScheduler（W6 S3），
    // 提交链（投影 → 任务归属 → acceptPrompt → task.started）在 CommandService
    // （W6 S4）。runner 经回调提供执行语义；W7 换 AttemptExecutor 时改这里。
    this.scheduler = new RunScheduler({
      store: deps.store,
      executor: {
        runJob: (session, input, acceptedUserId) => this.runTask(session, input, acceptedUserId),
        driveResumed: (session) => this.driveResumedTask(session),
        cancelResidual: (sessionId) => this.cancelResidualTask(sessionId),
      },
      ...(deps.leaseStore ? { leaseStore: deps.leaseStore } : {}),
    });
    this.commandService = new CommandService({
      store: deps.store,
      scheduler: this.scheduler,
      casTask: (task, patch) => this.casTask(task, patch),
      publish: (event, sessionId) => this.publish(event, sessionId),
      launch: (session, input) => void this.runLoop(session, input),
    });
  }

  /** 推进一个「用户已放行」的任务（规格 §11.2 / §13.2）。
   *
   *  不创建用户消息、不新建 workflow run：`resumeTask` 走的是 `runTask` 的直接
   *  入口，绕过 `prompt()` 的整个提交链（投影消息 → resolveTaskForPrompt →
   *  acceptPrompt）。这条路径上没有任何东西会落成「用户说过的话」——
   *  `resume: true` 让 runLoop 连那条投影都跳过。
   *
   *  任务不处于「可推进」状态时什么都不做：用户可能连点两次，或者第二个请求
   *  到达时第一轮已经把它跑完了。 */
  private async driveResumedTask(session: SessionInfo): Promise<void> {
    const store = this.deps.store.task;
    if (!store) return;
    const task = await store.getActiveTask(session.id);
    if (!task || isTerminalStatus(task.status) || isWaitingStatus(task.status)) return;
    await this.runTask(
      session,
      // text 留空：放行话术由 runLoop 按 `resume` 补充。这里塞文本会顺着
      // `fireRunStart` 的 text 流进宿主的标题生成，把会话标题写成一句系统指令。
      { requestId: task.rootRequestId, text: "", taskId: task.id, model: session.model, resume: true },
      undefined,
    );
  }
  #hooks: LifecycleHook[] = [];
  /** 供 runLoop 取归一化钩子数组（lazy：constructor 后仍可由 deps 引用共享）。 */
  private get hooks(): LifecycleHook[] {
    if (this.#hooks.length !== (this.deps.hooks?.length ?? 0)) this.#hooks = [...(this.deps.hooks ?? [])];
    return this.#hooks;
  }

  /** fallbackSessionId 由 runLoop 闭包传入（而非实例字段）：runner 是进程级
   *  单例，两个会话并发时实例字段会互相覆盖，导致 message.part.delta 等
   *  无自带 sessionId 的事件落到错误的会话事件流里（串台）。 */
  private async persist(event: FrameworkEvent, fallbackSessionId: string): Promise<void> {
    const sessionId = sessionIdOf(event, fallbackSessionId);
    if (this.deps.store.persistEvent) {
      const persisted = await this.deps.store.persistEvent({ sessionId,...event });
      notifyEventLogListeners(persisted);
      return;
    }
    if (event.type === "message.updated") {
      const message = event.data.message;
      const exists = await this.deps.store.getMessages(message.sessionId).then((entries) => entries.some((entry) => entry.info.id === message.id));
      if (exists) await this.deps.store.updateMessage(message.id, message);
      else await this.deps.store.appendMessage(message);
    } else if (event.type === "message.part.updated") {
      await this.deps.store.appendPart(event.data.part).catch(async () => this.deps.store.updatePart(event.data.part));
    } else if (event.type === "session.updated") {
      await this.deps.store.updateSession(event.data.session.id, event.data.session);
    }
    const persisted = await this.deps.eventLog.append({ sessionId, ...event });
    notifyEventLogListeners(persisted);
  }

  private async publish(event: FrameworkEvent, sessionId: string): Promise<void> {
    const persisted = this.deps.store.persistEvent
      ? await this.deps.store.persistEvent({ sessionId,...event })
      : await this.deps.eventLog.append({ sessionId, ...event });
    notifyEventLogListeners(persisted);
  }

  /** 非 async 直通：async 方法 `return promise` 会多一拍 microtask 才让调用方
   *  的 await 恢复，实测足以翻转 prompt 提交与 drain 链之间的交错时序（FIFO
   *  用例的读偏斜）。委托层一律直通，不包 async。 */
  prompt(sessionId: string, input: PromptInput): Promise<{ queued: boolean } & Partial<PromptReceipt>> {
    return this.commandService.submit(sessionId, input);
  }

  async replyPermission(sessionId: string, requestId: string, reply: Reply, feedback?: string): Promise<boolean> {
    const active = activeRuns.get(sessionId);
    if (!active) return false;
    return active.engine.reply(requestId, reply, feedback);
  }

  /** 用户核对完之后让任务继续（规格 3 §11 / §13.2 的 `resume` 动作）。
   *
   *  【为什么必须有这条通路】每个 blocked / waiting 的 blocker 都写着一句
   *  `requiredAction`（「先核对工作区与外部系统的实际状态，再决定继续或重做」）。
   *  如果产品只能靠「再发一条消息」来继续，那句话就是在要求用户做一件系统接不住
   *  的事；而更糟的是崩溃恢复后的那种任务——会话里还有一条 `recovery_required`
   *  的 run，发消息会被 409 挡住，用户根本无路可走。
   *
   *  三步：放掉「副作用未确认」这道闸 → 任务回到 queued 并清 blocker →
   *  登记一次放行请求，交给驱动链（`drain`）推进。
   *  **不创建用户消息**（§11.2）：这是同一条指令的继续，不是新的一轮对话。
   *  返回 false 表示没什么可继续的（没有活跃任务、已终态、或本来就在正常跑，
   *  规格 §13.2：正常运行中的 task 不需要「继续」）。
   *
   *  【为什么不能靠 `drain` 自己发现这件事】`drain` 认领的是队列里的 workflow
   *  run，而这类任务停下的原因是预算/无进展/等待，它那次 run 早就 `completed`
   *  了——`claimPrompt` 取不到任何东西，任务会被放回 queued 而无人推进。所以
   *  放行动作必须留下一个显式标记（`resumeRequests`），由驱动链认领。 */
  async resumeTask(sessionId: string): Promise<boolean> {
    const store = this.deps.store.task;
    if (!store) return false;
    const task = await store.getActiveTask(sessionId);
    if (!task || !isWaitingStatus(task.status)) return false;
    // 闸先放：否则驱动链里的 claimPrompt 仍会因为 recovery_required 返回 null，
    // 任务会被放回 queued 却没有任何东西去推进它。
    await this.deps.store.workflow?.clearRecoveryRequired(sessionId).catch(() => 0);
    await this.casTask(task, { status: "queued", blocker: undefined, ...RESET_GUARDS_ON_RESUME });
    this.scheduler.requestResume(sessionId);
    return true;
  }

  /** Revokes matching session-scoped rules immediately for a live run and
   * removes their persisted continuation access. */
  async revokePermission(sessionId: string, permission: string, patterns: string[]): Promise<boolean> {
    const active = activeRuns.get(sessionId);
    const removedFromEngine = active?.engine.revoke(permission, patterns) ?? false;
    const session = await this.deps.store.getSession(sessionId);
    if (!session) return removedFromEngine;
    const next = session.permission.filter((rule) => !(rule.permission === permission && patterns.includes(rule.pattern)));
    const removedFromStore = next.length !== session.permission.length;
    if (removedFromStore) await this.deps.store.updateSession(sessionId, { permission: next });
    return removedFromEngine || removedFromStore;
  }

  abort(sessionId: string): Promise<void> {
    return this.scheduler.abort(sessionId);
  }

  /** 停止时把任务层也收干净（规格 3 §11「用户停止任务」）。
   *
   *  正在跑的 run 不用管：`RunOutcome.aborted` 会让 Completion Gate 判 `cancelled`，
   *  任务由 `settleTask` 落终态。这里处理的是**没有活 run 却仍停在非终态**的任务——
   *  上一步已经 `blocked` / `waiting_*`、用户此时点「停止」，没有任何运行在跑；
   *  不补这一刀，任务会永远停在等待里，而界面上的「停止」看起来毫无作用。
   *
   *  位置刻意放在 `draining` 之后：先让结算路径写完自己的结论，避免两边各发一次
   *  `task.cancelled`（revision 白跳两次，客户端投影也会收到重复终态）。 */
  private async cancelResidualTask(sessionId: string): Promise<void> {
    const store = this.deps.store.task;
    if (!store) return;
    const task = await store.getActiveTask(sessionId);
    if (!task || isTerminalStatus(task.status)) return;
    const updated = await this.casTask(task, { status: "cancelled", blocker: undefined });
    await this.publish({ type: "task.cancelled", data: { taskId: updated.id, revision: updated.revision, reason: "用户已停止任务。" } }, sessionId);
  }

  /** 手动触发一次上下文压缩（UI「压缩当前会话」）：无条件对当前历史跑一次
   *  摘要折叠，摘要通过 buildCompaction 的 onCompacted 落为 compaction part
   *  并发事件。与自动 compaction 共用同一套保护（膨胀拒绝/失败降级）。 */
  async compactSession(sessionId: string): Promise<{ ok: boolean; reason?: string }> {
    if (!this.deps.compaction?.enabled || !this.deps.compaction.summaryModel) {
      return { ok: false, reason: "compaction-disabled" };
    }
    const session = await this.deps.store.getSession(sessionId);
    if (!session) return { ok: false, reason: "session-not-found" };
    const transform = await this.buildCompaction(session, (event) => this.publish(event, session.id), true);
    if (!transform) return { ok: false, reason: "compaction-disabled" };
    const workflowRuns = this.deps.store.workflow ? await this.deps.store.workflow.workflowRuns(sessionId) : [];
    const excludedUserIds = this.deps.store.workflow
      ? new Set(workflowRuns.filter((run) => run.status !== "completed" && run.status !== "failed").map((run) => run.receipt.userMessageId))
      : undefined;
    const messages = await this.rebuildMessages(sessionId, excludedUserIds);
    if (messages.length <= 1) return { ok: false, reason: "nothing-to-compact" };
    await transform(messages);
    return { ok: true };
  }

  /** 当前会话的压缩阈值：优先取模型目录给的真实上下文窗口，回落 runtime 级
   *  全局配置。旧行为恒取 deps.compaction.contextWindow；模型目录未覆盖该
   *  modelId 时 model.contextWindow 即等于该全局值，行为不变。
   *  modelFor 抛错（宿主 provider 不认识该 ref）时同样回落，绝不阻断压缩。 */
  private contextWindowFor(session: SessionInfo): number {
    const fallback = this.deps.compaction?.contextWindow ?? 0;
    try {
      const model = this.deps.modelFor(session.model) as { contextWindow?: unknown } | null | undefined;
      const win = model?.contextWindow;
      return typeof win === "number" && win > 0 ? win : fallback;
    } catch {
      return fallback;
    }
  }

  /** Builds the compaction transformContext (spec §8.3) when the runner has a
   *  summary model configured. Emits a `compaction` part on the latest
   *  assistant message so the boundary shows in the transcript. force=true
   *  skips the threshold/滞回 early-outs (手动「压缩当前会话」). */
  private async buildCompaction(session: SessionInfo, emit: (event: FrameworkEvent) => void, force = false) {
    if (!this.deps.compaction?.enabled || !this.deps.compaction.summaryModel) return undefined;
    const { buildCompactionTransform, streamOneText } = await import("./compaction.js");
    return buildCompactionTransform({
      enabled: true,
      contextWindow: this.contextWindowFor(session),
      summaryModel: this.deps.compaction.summaryModel,
      ...(force ? { force: true } : {}),
      streamOne: async (model, messages) => {
        const streamFn = this.deps.streamFnFor(session);
        return streamOneText(
          async (m, ctx) => {
            const stream = await streamFn(m, ctx as never);
            return stream;
          },
          model,
          "你是上下文压缩助手。只输出结构化摘要，不续写对话。",
          messages,
        );
      },
      onCompacted: (summary) => {
        void (async () => {
          const entries = await this.deps.store.getMessages(session.id);
          const lastAssistant = [...entries].reverse().find((entry) => entry.info.role === "assistant");
          if (!lastAssistant) return;
          const part: Part = { id: newPartId(), sessionId: session.id, messageId: lastAssistant.info.id, type: "compaction", summary };
          await this.deps.store.appendPart(part).catch(() => undefined);
          emit({ type: "message.part.updated", data: { part } });
        })();
      },
    });
  }

  /** Layers the session's workspace custom agents (`.zmzai/agents/*.md`) on top
   *  of the shared registry without mutating it (spec §6.3). Load failures
   *  degrade to the base registry — a malformed md never blocks a run. */
  private async registryFor(session: SessionInfo): Promise<AgentRegistry> {    const base = this.deps.registry;
    if (!this.deps.loadWorkspaceAgents) return base;
    try {
      const custom = await this.deps.loadWorkspaceAgents(session);
      return base.derive(custom);
    } catch {
      return base;
    }
  }

  /** Versioned agents are resolved from the product control plane. A missing
   *  version intentionally falls back to the M1-M5 registry so old sessions
   *  and standalone consumers remain valid. */
  private async resolvedAgentFor(session: SessionInfo): Promise<ResolvedAgent | null> {
    if (!this.deps.agentResolver) return null;
    try {
      return await this.deps.agentResolver.resolve(session);
    } catch {
      return null;
    }
  }

  /** 一次 Attempt：从模型上下文构造到终态收尾的完整内部运行。
   *
   *  `taskContext` 存在时，任务契约会注入 systemPrompt（**不落成消息**，
   *  规格 §19 禁止伪用户消息）。它同时携带 continuation 的 advisory，
   *  保证「续跑指令」与「任务契约」在同一条系统指令里，不会互相矛盾。
   *  它还携带 `loopGuard`：任务层自己持有一个跨 Attempt 的实例，避免每轮
   *  重置循环防护的计数（见下方注释）。 */
  private async runLoop(
    session: SessionInfo,
    input: PromptInput,
    acceptedUserId?: string,
    taskContext?: { task: TaskRecord; advisory?: string; continuation?: boolean; loopGuard?: LoopGuard } | null,
  ): Promise<RunOutcome> {
    const registry = await this.registryFor(session);
    const resolved = await this.resolvedAgentFor(session);
    const agentName = resolved ? resolved.agent.name : input.agent ?? session.agent;
    const agentInfo = resolved?.agent ?? registry.get(agentName) ?? registry.get("default");
    const model = input.model ?? agentInfo?.model ?? session.model;
    // 回写当轮实际模型：session.model 是「会话当前模型」的持久来源，但
    // prompt 传入的 model / agent 声明的 model 此前只用于当轮、从不落库，
    // 于是所有读 session.model 的旁路（压缩阈值 contextWindowFor、总结
    // 陈词 summarizeRun、子代理继承、宿主侧标题生成）拿到的都是建会话时
    // 的旧模型甚至 env 兜底值。回写后这些旁路自动跟随当轮模型，无需各自
    // 传参。必须在 buildCompaction 之前完成，否则压缩阈值仍按旧模型算。
    if (model.providerId !== session.model?.providerId || model.modelId !== session.model?.modelId) {
      await this.deps.store.updateSession(session.id, { model }).catch(() => undefined);
      // 同步内存引用：本轮后续（buildCompaction/闭包捕获）都用新模型
      session = { ...session, model };
    }

    const agentRulesets = resolved ? [registry.rulesetsFor("default")[0]!, resolved.agent.permission] : registry.rulesetsFor(agentInfo?.name ?? "default");
    /** 本轮模型最后投递的 todo 列表（步骤投影的输入）。 */
    let latestTodos: { content: string; status: string }[] | null = null;
    const engine = new PermissionEngine(session.id, agentRulesets, session.permission, {
      onAsked: async (request) => {
        await this.publish({ type: "session.status", data: { status: "waiting_permission" } }, session.id);
        await this.publish({ type: "permission.asked", data: { request } }, session.id);
        // 权限等待必须让任务层可见（规格 §11.1）。否则用户在盯着授权卡的时候，
        // 任务状态还是「运行中」——「在跑」和「在等你点授权」对用户是两件事，
        // 而任务 API 会给出一个错的答案。
        await this.markPermissionWait(taskContext?.task.id, request.permission, request.patterns, true);
      },
      onReplied: async (request, reply) => {
        await this.publish({ type: "permission.replied", data: { id: request.id, reply } }, session.id);
        await this.publish({ type: "session.status", data: { status: "running" } }, session.id);
        // 授权通过或拒绝都解除等待：规格 §11.3 要求把拒绝结果交回模型去试替代
        // 方案，只有模型也没有替代方案时才判 blocked/failed。留在
        // waiting_permission 会把「已经拒绝了」误报成「还在等你授权」。
        await this.markPermissionWait(taskContext?.task.id, request.permission, request.patterns, false);
      },
      onSessionRuleAdded: async (sessionId, rule) => {
        const latest = await this.deps.store.getSession(sessionId);
        if (!latest) return;
        const expiresAt = this.deps.sessionRuleTtlMs && this.deps.sessionRuleTtlMs > 0
          ? new Date(Date.now() + this.deps.sessionRuleTtlMs).toISOString()
          : undefined;
        await this.deps.store.updateSession(sessionId, { permission: [...latest.permission, { ...rule, ...(expiresAt ? { expiresAt } : {}) }] });
      },
    });

    /** 本轮事件的公共漏斗——**模型流通路和工具通路都必须经过它**。
     *
     *  【为什么必须是一个共享函数】曾经把 todo 捕获写在下面 `serializeEmit` 的
     *  包装器里，注释还写着「事件流是所有路径的漏斗，不会漏」。那是错的：默认
     *  tool context 的 `setTodos` 拿到的 emit 直接调 `publish`，根本不经过包装器。
     *  结果是 `latestTodos` 永远是 null，步骤数组永远为空，任务于是按「没有步骤」
     *  的分支判定——模型刚说完一句试点性的开场白就被判成「已交付」。这类 bug
     *  的危险之处在于它不报错，只是悄悄把完成判定放宽到形同虚设。 */
    const observeRunEvent = async (event: FrameworkEvent): Promise<void> => {
      if (event.type === "todo.updated") {
        latestTodos = event.data.todos.map((todo) => ({ content: todo.content, status: todo.status }));
      }
    };

    const { emit, settled } = serializeEmit(async (event) => {
      await observeRunEvent(event);
      await this.persist(event, session.id);
    });

    const projector = new PartProjector({ sessionId: session.id, agent: agentInfo?.name ?? "default", model });
    if (acceptedUserId) projector.restoreUserMessage(acceptedUserId);
    let mandatorySkillContext = "";
    if (input.skill) {
      if (!this.deps.resolveMandatorySkill) throw new Error("该运行环境不支持 Skill 加载");
      const loaded = await this.deps.resolveMandatorySkill(session, input.skill);
      mandatorySkillContext = loaded.context;
    }
    // Exclude task from contexts that can't nest; include for primary runs.
    const baseTools = [...(this.deps.tools ?? builtinTools), ...(this.deps.localTools ?? []), ...(resolved?.tools ?? [])];
    const toolList = session.parentId ? baseTools.filter((def) => def.id !== "task") : baseTools;
    const toolDefs = new Map<string, AnyToolDef>(toolList.map((def) => [def.id, def]));
    const sandbox = this.deps.sandbox ?? noopSandboxExecutor();
    // 子代理写路径隔离（07-subagent）：会话声明了 writePaths 时把 workspace
    // 门面包进结构层圈禁——越界 write/edit 直接抛错，不可绕过。
    const rawWorkspace = this.deps.workspaceFor(session);
    const workspace = session.writePaths?.length ? confineWorkspaceFiles(rawWorkspace, session.writePaths) : rawWorkspace;
    const emitAsync = async (event: FrameworkEvent) => {
      await observeRunEvent(event);
      await this.publish(event,session.id);
    };
    const toolContext = (this.deps.buildToolContext ?? defaultToolContext)({ session, engine, workspace, sandbox, emit: emitAsync });
    // Subagent spawning is only available to primary (non-child) sessions, and
    // only when the runner can host a nested run (spec §6.4).
    if (!session.parentId) {
      toolContext.spawnSubagent = (spawnInput) => this.spawnSubagent(session, spawnInput, registry, engine);
    }
    const piTools = [...toolDefs.values()].map((def) => adaptAnyTool(def, toolContext));
    let unknownSideEffect = false;
    let sideEffectDetail: string | null = null;
    /** 以 error 结束的工具调用摘要（最多留最近三条）。
     *  只用于续跑提示，**不构成阻塞**——工具失败后模型换条路走通是常态。 */
    const toolErrors: string[] = [];
    /** 本轮**自己的**最后一条 assistant 文本（交付文本的来源）。
     *
     *  【为什么不用「会话里最后一条」】续跑时那会取到上一轮的文本：一轮「我先看看
     *  文件」之后，下一轮只用工具调完了全部步骤，交付卡上就会出现一句跟本次交付
     *  无关、甚至自相矛盾的正文。连带 `finalTextPresent` 也会用陈旧文本为一次
     *  没说话的运行开绿灯。这里只认本轮新增的消息。 */
    let attemptFinalText = "";
    /** 本轮的证据候选。在工具热路径上只累积内存，Attempt 结束时一次性投影进
     *  任务并落库——否则每次工具调用都要 CAS 写一次任务表。 */
    const evidenceCandidates: { kind: TaskEvidenceKind; summary: string; ref?: string }[] = [];
    /** 本轮模型用 `task_block` 声明的阻塞（规格 3 §11）。见 `RunOutcome.taskBlock`。 */
    let taskBlock: TaskBlockInput | null = null;
    /** 本轮模型用 `task_deliver` 提交的交付声明（规格 3 §9 条件 6）。见 `RunOutcome.delivery`。 */
    let delivery: TaskDeliverInput | null = null;

    const compactionTransform = await this.buildCompaction(session, emit);
    // 记忆召回（spec §记忆）：单点注入 runLoop，天然覆盖正常 prompt/排队出
    // 队/automation/子代理触发四条路径。只进内存不落 store；抛错静默降级。
    const workflowRuns = this.deps.store.workflow ? await this.deps.store.workflow.workflowRuns(session.id) : [];
    const excludedUserIds = this.deps.store.workflow
      ? new Set(workflowRuns.filter((run) => run.status !== "completed" && run.status !== "failed").map((run) => run.receipt.userMessageId))
      : undefined;
    const history = await this.rebuildMessages(session.id, excludedUserIds);
    if (this.deps.memoryContextFor) {
      try {
        const section = await this.deps.memoryContextFor(session, input.text);
        if (section) {
          history.unshift({ role: "user", content: [{ type: "text", text: section }], timestamp: Date.now() } as AgentMessage);
        }
      } catch {
        // 召回失败不阻塞 run
      }
    }
    // baseline：本次 run 新增消息从这之后算（供 onRunEnd 提取 retain）
    const baseline = history.length;
    const agent = new Agent({
      initialState: {
        systemPrompt: [
          agentInfo?.prompt ?? "",
          mandatorySkillContext,
          // 任务契约（规格 3 §6 / §8.2）：每个 Attempt 重新注入一次，因此
          // 上下文被压缩掉也不影响任务目标的存续。续跑指令与它同源。
          taskContext ? taskContractText(taskContext.task, taskContext.advisory) : "",
          input.references?.length ? `<attached-resources>\nThe user attached these workspace paths. Read the relevant ones before acting:\n${input.references.join("\n")}\n</attached-resources>` : "",
        ].filter(Boolean).join("\n\n"),
        model: this.deps.modelFor(model),
        // 推理力度（P1-8 复活）：relay 现已按模型白名单接受 reasoning_effort；
        // 仅当调用方显式选择且非 off 时下发（默认不设 = 完全不带该字段）。
        ...(input.effort && input.effort !== "off" ? { thinkingLevel: input.effort } : {}),
        tools: piTools,
        messages: history,
      },
      streamFn: this.deps.streamFnFor(session),
      toolExecution: "sequential",
      ...(compactionTransform ? { transformContext: compactionTransform } : {}),
      shouldStopAfterTurn: ({ newMessages }) => newMessages.filter((message) => message.role === "assistant").length >= (agentInfo?.steps ?? 12),
    });

    const abortController = new AbortController();
    const abort = () => {
      abortController.abort();
      agent.abort();
    };
    let resolveDone!: () => void;
    const done = new Promise<void>((resolve) => { resolveDone = resolve; });
    activeRuns.register(session.id, { agent, engine, settled, abort, done });
    if (this.scheduler.isStopRequested(session.id)) abort();
    await this.scheduler.stampLease(session.id);

    // 循环防护在任务层跨 Attempt 复用（规格 3 §16 阶段 D）：一条任务会自己续跑
    // 多轮，而「同一个工具一直以同样的方式失败」是不会因为换了一轮就消失的事实。
    // 每轮新建一个 guard，会让上一轮的两次失败在这一轮从未发生，模型于是有机会
    // 把同一个错误再撞一遍——续跑越多，这个洞越大。
    const loopGuard = taskContext?.loopGuard ?? new LoopGuard();
    agent.beforeToolCall = async ({ toolCall, args }) => {
      if (unknownSideEffect) {
        return { block: true, reason: "上一个可能产生副作用的动作结果不确定，已暂停执行。请先确认外部系统状态，再决定继续或重试。", terminate: true };
      }
      // 重复失败守卫（edit）：同一 (path, oldText) 已连续失败多次时，
      // 重试前先复查文件状态——oldText 已唯一存在则放行清记录，
      // 否则直接拦截（避免无意义空转烧步数）。
      const editDef = toolCall.name === "edit" ? toolDefs.get("edit") : undefined;
      const editArgs = editDef && !isExternalToolDef(editDef) ? editDef.parameters.safeParse(args) : undefined;
      if (editDef && editArgs?.success && loopGuard.needsEditRecheck(editArgs.data.path, editArgs.data.oldText)) {
        const file = await workspace.read(editArgs.data.path);
        const occurrences = file ? file.content.split(editArgs.data.oldText).length - 1 : 0;
        if (occurrences === 1) loopGuard.clearEditFailure(editArgs.data.path, editArgs.data.oldText);
        else {
          return {
            block: true,
            reason:
              `[循环防护] 同一 edit（${editArgs.data.path}）已连续失败 ${REPEAT_EDIT_FAILURE_THRESHOLD} 次以上，且文件内容没有变化。` +
              `不要继续重试：先用 read 读取 ${editArgs.data.path} 的最新内容，按实际内容重新选择 oldText。`,
            terminate: false,
          };
        }
      }
      // 生命周期钩子（P0）：所有工具统一的第一道闸口（在权限评估之前，
      // 便于宿主实现全量工具审计/拦截）；reason 会反馈给模型
      const hookBlock = await firstToolBlock(this.hooks, {
        sessionId: session.id,
        agent: session.agent,
        tool: toolCall.name,
        args,
      }) as { block?: boolean; reason?: string } | undefined;
      if (hookBlock?.block) {
        return { block: true, reason: String(hookBlock.reason ?? "被钩子拦截"), terminate: false };
      }
      const mapped = permissionForCall(toolDefs, toolCall.name, args);
      if (!mapped) return undefined;
      try {
        await engine.ask({
          sessionId: session.id,
          permission: mapped.permission,
          patterns: mapped.patterns,
          always: mapped.always,
          metadata: mapped.metadata,
          tool: { messageId: projector.currentAssistantMessageId ?? "", callId: toolCall.id },
        });
        return undefined;
      } catch (error) {
        if (error instanceof RejectedError) {
          // 连续被拒 streak：拼入改变策略指令，阻止模型硬闯不允许的操作
          const advisory = loopGuard.onBlocked(toolCall.name);
          return { block: true, reason: advisory ? `${error.message}\n\n${advisory}` : error.message, terminate: false };
        }
        throw error;
      }
    };

    // storm 断路器：同一工具连续以相同响应失败 3 次（签名不含 args，
    // 防"化妆参数"重试），在第 3 次的结果里注入改变策略指令。
    // 只碰工具结果，不碰 F6 模型级重试路径。
    agent.afterToolCall = async ({ toolCall, args, result, isError }) => {
      const details = typeof result.details === "object" && result.details !== null ? result.details as Record<string, unknown> : null;
      if (details?.outcome === "unknown") {
        unknownSideEffect = true;
        sideEffectDetail ??= `${toolCall.name} 的结果不确定`;
      }
      const resultText = (result.content ?? [])
        .filter((block): block is Extract<typeof block, { type: "text" }> => block.type === "text")
        .map((block) => block.text)
        .join("\n");
      // 证据采集（规格 3 §9 条件 3）：只记**成功**的写 / 执行 / 外部核对类调用。
      // 失败不是验证证据；读取类工具也不记（见 evidenceKindForTool 的说明）——
      // 否则「有证据」会退化成「调过工具」。
      if (isError) {
        toolErrors.push(`${toolCall.name}: ${resultText.trim().slice(0, 160)}`);
        if (toolErrors.length > 3) toolErrors.shift();
      } else {
        // 模型声明「需要用户介入」（规格 §11）。只认成功的调用：一次被拒绝或
        // 崩溃的 task_block 没有资格把任务停下来等用户。
        if (toolCall.name === TASK_BLOCK_TOOL_ID) taskBlock = readTaskBlock(args);
        // 模型声明「我交付了」（规格 §9 条件 6）。同样只认成功的调用——参数过不了
        // schema 的交付声明必须当成「没有声明」，否则一次格式错误就能换来 delivered。
        if (toolCall.name === TASK_DELIVER_TOOL_ID) delivery = readTaskDelivery(args);
        const kind = evidenceKindForTool(toolCall.name);
        if (kind) {
          const path = (args as { path?: unknown } | undefined)?.path;
          const program = (args as { program?: unknown } | undefined)?.program;
          const ref = typeof path === "string" ? path : typeof program === "string" ? program : undefined;
          const title = typeof details?.title === "string" ? details.title : undefined;
          evidenceCandidates.push({
            kind,
            summary: (title ?? resultText).trim().slice(0, 160) || toolCall.name,
            ...(ref ? { ref } : {}),
          });
        }
      }
      let advisory = loopGuard.onToolResult({ toolName: toolCall.name, isError, errorText: resultText });
      // 生命周期钩子（P0）：只读观测，不阻塞结果路径
      void Promise.all(fireAfterToolCall(this.hooks, {
        sessionId: session.id,
        agent: session.agent,
        tool: toolCall.name,
        isError,
        title: typeof details?.title === "string" ? details.title : undefined,
      }));
      if (toolCall.name === "edit") {
        const editAfterDef = toolDefs.get("edit");
        const parsed = editAfterDef && !isExternalToolDef(editAfterDef) ? editAfterDef.parameters.safeParse(args) : undefined;
        if (parsed?.success) {
          if (isError) {
            loopGuard.noteEditFailure(parsed.data.path, parsed.data.oldText);
            if (!advisory && loopGuard.needsEditRecheck(parsed.data.path, parsed.data.oldText)) {
              advisory = `[循环防护] 同一 edit 已连续失败 ${REPEAT_EDIT_FAILURE_THRESHOLD} 次（oldText 不存在或不唯一）。停止重试：先 read 该文件获取最新内容，再按实际内容重新选择 oldText。`;
            }
          } else {
            loopGuard.clearEditFailure(parsed.data.path, parsed.data.oldText);
          }
        }
      }
      if (!advisory) return undefined;
      return { content: [{ type: "text" as const, text: `${advisory}\n\n--- 原始工具结果 ---\n${resultText}` }] };
    };

    // 流空闲看门狗：上游无响应时（模型不支持该输入如非视觉模型收图、网络挂起），
    // runLoop 会无限挂起，用户端表现为「卡住」。任意 agent 事件喂狗；
    // 超过阈值未喂则发布 session.error 并 abort，让 UI 得到明确反馈而非永久等待。
    // P2 裁决：180s→300s——长工具调用（大文件检索、慢沙箱）+ 模型排队首 token
    // 叠加起来 3 分钟都可能不够，5 分钟内不应限制；可用 ZMZAI_STREAM_IDLE_TIMEOUT_MS 覆盖。
    const STREAM_IDLE_TIMEOUT_MS = Number(process.env.ZMZAI_STREAM_IDLE_TIMEOUT_MS ?? 300_000);
    let lastStreamActivityAt = Date.now();
    const feedStreamWatchdog = () => {
      lastStreamActivityAt = Date.now();
    };

    // 任务终态小结统计（N5）：工具调用数 + 编辑/写入文件去重集合。
    // 在 tool_execution_start 累加（比事后解析 agent.state.messages 更稳——
    // 那里 toolCall 是 AssistantMessage.content 里的块，结构复杂易漏）。
    let summaryToolCalls = 0;
    const summaryEditedFiles = new Set<string>();
    // N6 长任务 checkpoint：记录最后一个工具名（中途快照用）
    let summaryLastTool: string | undefined;

    agent.subscribe((event) => {
      feedStreamWatchdog();
      switch (event.type) {
        case "message_start":
          if (event.message.role === "assistant") projector.onAssistantStart(emit);
          break;
        case "message_update": {
          const streamEvent = event.assistantMessageEvent;
          if (streamEvent.type === "text_delta") projector.onTextDelta(emit, streamEvent.contentIndex, streamEvent.delta);
          if (streamEvent.type === "thinking_delta") projector.onThinkingDelta(emit, streamEvent.contentIndex, streamEvent.delta);
          break;
        }
        case "message_end":
          if (event.message.role === "assistant") projector.onAssistantEnd(emit, event.message);
          break;
        case "tool_execution_start":
          summaryToolCalls += 1;
          summaryLastTool = event.toolName;
          if (event.toolName === "edit" || event.toolName === "write") {
            const path = (event.args as { path?: unknown } | undefined)?.path;
            if (typeof path === "string") summaryEditedFiles.add(path);
          }
          projector.onToolExecutionStart(emit, event.toolCallId, event.toolName, event.args, toolDefs.get(event.toolName)?.label);
          break;
        case "tool_execution_update":
          projector.onToolExecutionUpdate(emit, event.toolCallId, event.partialResult);
          break;
        case "tool_execution_end":
          projector.onToolExecutionEnd(emit, event.toolCallId, event.result, event.isError);
          break;
      }
    });
    const streamWatchdog = setInterval(() => {
      if (Date.now() - lastStreamActivityAt < STREAM_IDLE_TIMEOUT_MS) return;
      lastStreamActivityAt = Date.now(); // 只触发一次，错误路径会 abort 收尾
      void this.publish(
        { type: "session.error", data: { name: "StreamIdleTimeout", message: `上游 ${STREAM_IDLE_TIMEOUT_MS / 1000}s 无响应，已中止本次运行（模型可能不支持该输入，如非视觉模型收到图片）。点「继续」可在同一会话续跑；若持续超时可切换模型重试。` } },
        session.id,
      );
      abortController.abort();
    }, 15_000);

    let runErrored = false;
    /** 本轮失败的错误消息。用来区分「上游抖动（可重试）」与「确定没救」——
     *  两者在 Completion Gate 里走完全不同的分支（续跑 vs failed）。 */
    let runErrorMessage: string | null = null;
    const runStartedAt = Date.now();

    // N6 长任务中途 checkpoint：运行超过阈值后周期性发布进度快照（已执行工具数 /
    // 最后一步工具 / 耗时），崩溃/中断后前端据此提示「上次进行到哪」。终态收尾仍
    // 由 session.summary 兜底；这里只在运行中给「中间落点」。可用
    // ZMZAI_CHECKPOINT_INTERVAL_MS 覆盖间隔（默认 2 分钟），首次触发即从此刻起算。
    const CHECKPOINT_INTERVAL_MS = Number(process.env.ZMZAI_CHECKPOINT_INTERVAL_MS ?? 120_000);
    const checkpointTimer = setInterval(() => {
      if (abortController.signal.aborted) return;
      const elapsedMs = Date.now() - runStartedAt;
      // 只在确实有进展时发（有工具调用），避免空跑会话也刷 checkpoint
      if (summaryToolCalls === 0) return;
      void this.publish(
        {
          type: "session.checkpoint",
          data: { toolCalls: summaryToolCalls, lastTool: summaryLastTool, elapsedMs },
        },
        session.id,
      ).catch(() => undefined);
    }, CHECKPOINT_INTERVAL_MS);

    try {
      await Promise.all(fireRunStart(this.hooks, { sessionId: session.id, agent: session.agent, text: input.text }));
      await this.publish({ type: "session.status", data: { status: "running" } }, session.id);
      if (abortController.signal.aborted) throw new Error("Run cancelled during setup");
      // `resume` 与 `acceptedUserId` 都表示「这一轮没有一个用户回合」：前者是用户
      // 按了按钮，后者是任务自己接着跑。两条路径都不能投影用户消息（规格 §18.2）。
      if (!acceptedUserId && !input.resume) projector.onUserPrompt(emit, input.text, input.images, input.skill, input.references, input.attachments, input.attachmentRefs);
      const piImages = input.images?.map((img) => {
        const match = img.url.match(/^data:([^;]+);base64,(.+)$/);
        return match ? { type: "image" as const, data: match[2]!, mimeType: match[1]! } : null;
      }).filter((img): img is { type: "image"; data: string; mimeType: string } => img !== null);
      const attachmentParts = await attachmentRefContent(this.deps.attachments, input.attachmentRefs ?? [], { sessionId: session.id });
      // 内部续跑喂给模型的驱动文本（规格 3 §8.2）。它**不落库**：上面那条
      // `if (!acceptedUserId) projector.onUserPrompt(...)` 已经跳过，所以聊天
      // 记录里看不到它（§18.2 验收要求「没有合成用户消息」）。但驱动模型本身
      // 必须有个输入——规格 §19 禁止的是把「继续」做成一条**持久化的伪用户
      // 消息**，不是禁止给模型一个继续的由头。
      const driveText = input.resume
        ? RESUME_DRIVE_TEXT
        : taskContext?.continuation
          ? "[继续执行任务] 上一轮结束时任务还没有完成。按上面的任务契约继续推进，不要中途把控制权交回用户。"
          : input.text;
      await agent.prompt({ role: "user", content: [{ type: "text", text: driveText }, ...attachmentContent(input.attachments ?? []), ...attachmentParts, ...(piImages ?? [])], timestamp: Date.now() });
      await settled();
      let failed = agent.state.errorMessage;
      if (unknownSideEffect) {
        await this.publish({ type: "session.status", data: { status: "waiting_input" } }, session.id);
      } else {
      // 自动重试（F6）：上游中断类错误（terminated/econnreset/timeout/429/5xx 等）
      // 带退避重试，最多 5 次。PI 失败时会注入一条 assistant failure 占位
      // 消息（last 是 assistant → continue() 被拒），换成合成 user 消息驱动
      // continue 重新生成；store 里同步的 failure 消息保留展示（UI 显示
      // "出错了"有诊断价值）。退避 500ms→1s→2s→4s→8s 避免对上游施压。
      // P1：3→5 次——限流（429）场景退避窗口需要更长才有机会恢复。
      const MAX_RETRIES = 5;
      for (let attempt = 0; attempt < MAX_RETRIES && failed && isRetryableError(failed); attempt += 1) {
        if (attempt > 0) await new Promise((resolve) => setTimeout(resolve, 500 * 2 ** (attempt - 1)));
        const messages = agent.state.messages;
        const last = messages[messages.length - 1];
        if (last?.role === "assistant" && "errorMessage" in last && last.errorMessage) {
          agent.state.messages = [
            ...messages.slice(0, -1),
            { role: "user", content: [{ type: "text", text: RETRY_PLACEHOLDER_TEXT }], timestamp: Date.now() },
          ];
        }
        try {
          await agent.continue();
          await settled();
          failed = agent.state.errorMessage;
        } catch (retryError) {
          failed = retryError instanceof Error ? retryError.message : "Agent 重试失败";
        }
      }
      if (failed) {
        runErrored = true;
        runErrorMessage = failed;
        await this.publish({ type: "session.error", data: { name: "APIError", message: failed } }, session.id);
      }
      await this.publish({ type: "session.status", data: { status: "idle" } }, session.id);
      }
    } catch (error) {
      await settled();
      const aborted = abortController.signal.aborted;
      if (!aborted && !unknownSideEffect) {
        runErrored = true;
        runErrorMessage = error instanceof Error ? error.message : "Agent 运行失败";
      }
      await this.publish(
        unknownSideEffect
          ? { type: "session.status", data: { status: "waiting_input" } }
          : aborted
          ? { type: "session.status", data: { status: "idle" } }
          : { type: "session.error", data: { name: "AgentRuntimeError", message: error instanceof Error ? error.message : "Agent 运行失败" } },
        session.id,
      );
      if (!aborted && !unknownSideEffect) await this.publish({ type: "session.status", data: { status: "idle" } }, session.id);
    } finally {
      clearInterval(streamWatchdog);
      clearInterval(checkpointTimer);
      activeRuns.delete(session.id);
      engine.dispose();
      // Workflow settlement clears its lease atomically with the terminal run state.
      if (!acceptedUserId) await this.scheduler.clearLease(session.id);
      const newMessages: RunTranscriptMessage[] = extractRunTranscript(agent.state.messages, baseline);
      attemptFinalText = [...newMessages].reverse().find((message) => message.role === "assistant")?.text ?? "";
      // 任务终态小结（N5）：终态 status 已发布后补一条 session.summary，
      // 让「任务完成」有明确收尾（AI 一句总结 + 结构化统计）。await 保证
      // 落库后再 resolveDone（中断/失败场景不阻塞——内部有静默降级）。
      const summaryKind = abortController.signal.aborted ? "aborted" : runErrored ? "error" : "completed";
      await this.summarizeRun(session, {
        agent,
        baseline,
        startedAt: runStartedAt,
        kind: summaryKind,
        stats: { toolCalls: summaryToolCalls, editedFiles: [...summaryEditedFiles] },
      });
      void Promise.all(fireRunEnd(this.hooks, { sessionId: session.id, agent: session.agent, ok: !runErrored, aborted: abortController.signal.aborted, workspaceId: session.workspaceId, newMessages }));
      resolveDone();
    }

    const aborted = abortController.signal.aborted;
    const outcome: RunOutcome = {
      state: unknownSideEffect ? "recovery_required" : aborted ? "cancelled" : runErrored ? "failed" : "completed",
      settled: !aborted && !runErrored && !unknownSideEffect,
      aborted,
      unknownSideEffect,
      sideEffectDetail,
      filesEdited: [...summaryEditedFiles],
      toolCalls: summaryToolCalls,
      durationMs: Date.now() - runStartedAt,
      toolErrors: [...toolErrors],
      finalText: attemptFinalText,
      todos: latestTodos,
      taskBlock,
      delivery,
      evidenceCandidates: [...evidenceCandidates],
      errorMessage: runErrorMessage,
    };
    if (acceptedUserId || unknownSideEffect) return outcome;
    // FIFO queued prompts (spec §13.3): settle fully, then take the next one.
    const next = await this.deps.store.dequeuePrompt(session.id);
    if (next) {
      const latest = await this.deps.store.getSession(session.id);
      if (latest) await this.runLoop(latest, {
        text: next.text,
        attachments: next.attachments,
        images: next.images,
        model: next.model,
        ...(next.agent ? { agent: next.agent } : {}),
        ...(next.effort ? { effort: next.effort } : {}),
        ...(next.skill ? { skill: next.skill } : {}),
        ...(next.references?.length ? { references: [...next.references] } : {}),
      });
    }
    return outcome;
  }

  // ---- 持续任务执行（规格 3 §8）----------------------------------------------

  /** 带重试的 CAS 写入。
   *
   *  【为什么不「冲突就返回 latest」】那会让调用方以为补丁生效了，而库里没变——
   *  结算路径尤其致命：它会照常发出 `task.delivered`，于是客户端显示「已完成」
   *  而持久化状态还是 `running`，重启后任务像个卡住的僵尸。写不进去就必须知道。
   *  重试几次是给「恰好撞上另一个 drain 的收尾写」留余地；仍然失败就是真的有人
   *  在并发改同一个任务，那种情况必须浮出来（drain 会把它落成 recovery_required）。 */
  private async casTask(task: TaskRecord, patch: TaskPatch): Promise<TaskRecord> {
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
  private async markPermissionWait(taskId: string | undefined, permission: string, patterns: readonly string[], waiting: boolean): Promise<void> {
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
      await this.publish(
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
  private completionStateOf(outcome: RunOutcome, session: SessionInfo): CompletionRuntimeState {
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
      await this.publish(
        { type, data: { taskId: next.id, revision: next.revision, stepId: step.id, message: step.title, completedSteps: completed, totalSteps: next.steps.length } },
        sessionId,
      );
    }
    if (before.size !== next.steps.length) {
      await this.publish(
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
        ref: TASK_DELIVER_TOOL_ID,
        now,
      });
      evidence = appended.evidence;
      dropped.push(...appended.dropped);
      declarationEvidenceId = evidence.find((item) => item.kind === "model_observation" && item.ref === TASK_DELIVER_TOOL_ID)?.id;
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
      await this.publish(
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
      await this.publish({ type: "task.failed", data: { taskId, revision: updated.revision, reason: verdict.reason } }, session.id);
      return "failed";
    }

    if (verdict.status === "cancelled") {
      const updated = await this.casTask(task, { status: "cancelled" });
      await this.publish({ type: "task.cancelled", data: { taskId, revision: updated.revision, reason: verdict.reason } }, session.id);
      return "cancelled";
    }

    // blocked / waiting_*：阻塞种类决定状态，UI 据此给对应按钮（规格 §14.2）
    const status = lifecycleForBlocker(verdict.blocker.kind);
    const updated = await this.casTask(task, { status, blocker: verdict.blocker });
    await this.publish({ type: "task.blocked", data: { taskId, revision: updated.revision, blocker: verdict.blocker } }, session.id);
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
  private async runTask(session: SessionInfo, input: PromptInput, acceptedUserId?: string): Promise<WorkflowState> {
    const taskStore = this.deps.store.task;
    // 没有 TaskStore：退化为一次性运行。工具、权限、事件全部照常，只是没有
    // 「跨运行的目标」这层语义——这不是错误路径，而是宿主未启用该能力的降级。
    if (!taskStore) return (await this.runLoop(session, input, acceptedUserId)).state;

    let task = input.taskId ? await taskStore.getTask(input.taskId) : await taskStore.getActiveTask(session.id);
    if (!task) return (await this.runLoop(session, input, acceptedUserId)).state;

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
        await this.publish(
          { type: "task.recovery.started", data: { taskId: task.id, revision: task.revision, message: advisory ?? "继续推进任务", attempt: attemptNumber } },
          session.id,
        );
      }

      const outcome = await this.runLoop(session, attemptInput, acceptedUserId, {
        task,
        loopGuard,
        ...(advisory ? { advisory } : {}),
        ...(continuation ? { continuation: true } : {}),
      });
      stats = { filesEdited: outcome.filesEdited, toolCalls: outcome.toolCalls, durationMs: outcome.durationMs };

      task = await this.syncTaskFromAttempt(task, outcome, session.id);

      // 一次 Attempt 结束——**不是**任务完成（规格 §8.3）。UI 只能拿它画轨迹。
      await this.publish(
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

  /** Spawns a subagent child session (spec §6.4): depth-capped, permission
   *  stamped from parent session + subagent preset, runs a nested PI loop to
   *  completion, and returns the child's final assistant text as the parent
   *  tool's result. Awaits the nested runLoop directly. */
  private async spawnSubagent(
    parent: SessionInfo,
    input: { description: string; prompt: string; subagentType: string },
    registry: AgentRegistry,
    parentEngine: PermissionEngine,
  ): Promise<{ childSessionId: string; summary: string; state: "completed" | "error" }> {
    const depth = await this.sessionDepth(parent);
    if (depth >= this.deps.subagentDepth) {
      throw new Error(`子代理嵌套深度超过限制（${this.deps.subagentDepth}）`);
    }
    const subagent = registry.get(input.subagentType);
    if (!subagent || (subagent.mode !== "subagent" && subagent.mode !== "all")) {
      throw new Error(`未知或非子代理类型：${input.subagentType}`);
    }
    await parentEngine.ask({
      sessionId: parent.id,
      permission: "task",
      patterns: [input.subagentType],
      always: ["*"],
      metadata: { subagent: input.subagentType, description: input.description },
    });

    const childSession = await createFrameworkSession({
      store: this.deps.store,
      userId: parent.userId,
      workspaceId: parent.workspaceId,
      agent: input.subagentType,
      model: subagent.model ?? parent.model,
      prompt: input.prompt,
      parentId: parent.id,
      title: input.description,
      // 写路径隔离（07-subagent）：子代理 preset 声明 writePaths 时，权限层
      // 追加白名单 allow + 全局 deny 兜底（LAST match wins，兜底必须在最后），
      // 结构层通过 SessionInfo.writePaths 在子 runLoop 里圈禁 workspace。
      permission: [...parent.permission, ...writePathGuardRules(subagent.writePaths ?? [])],
      ...(subagent.writePaths?.length ? { writePaths: subagent.writePaths } : {}),
    });

    // 事件桥接（R3，opencode 式页面联动）：子代理生命周期发到父会话事件流，
    // UI 可实时展示子代理的执行进度而无需订阅子会话。
    const startedAt = Date.now();
    let toolCalls = 0;
    await this.publish(
      { type: "subagent.started", data: { id: childSession.id, agent: input.subagentType, task: input.description, parentSessionId: parent.id } },
      parent.id,
    );

    try {
      // Run the child with a FRESH runner (not this instance's nested runLoop):
      // reusing runLoop here would deadlock on the shared in-process state and
      // the parent's event chain. A dedicated runner owns the child's loop.
      // 附加 step 桥接钩子：子会话每次工具调用完成 → subagent.step 事件。
      const stepHook: LifecycleHook = {
        name: "subagent-step-bridge",
        onAfterToolCall: async ({ sessionId, tool, isError, title }) => {
          if (sessionId !== childSession.id) return;
          toolCalls += 1;
          await this.publish(
            { type: "subagent.step", data: { id: childSession.id, tool, title, state: isError ? "error" : "completed" } },
            parent.id,
          );
        },
      };
      const childRunner = new SessionRunner({ ...this.deps, hooks: [...(this.deps.hooks ?? []), stepHook] });
      await childRunner.runLoop(childSession, { text: input.prompt, agent: input.subagentType });
      const summary = await this.lastAssistantText(childSession.id);
      await this.recordSubtask(parent, { prompt: input.prompt, description: input.description, agent: input.subagentType, childSessionId: childSession.id });
      await this.publish(
        { type: "subagent.finished", data: { id: childSession.id, state: "completed", durationMs: Date.now() - startedAt, toolCalls } },
        parent.id,
      );
      return { childSessionId: childSession.id, summary: summary || "（子代理无文本输出）", state: "completed" };
    } catch (error) {
      await this.recordSubtask(parent, { prompt: input.prompt, description: input.description, agent: input.subagentType, childSessionId: childSession.id });
      await this.publish(
        { type: "subagent.finished", data: { id: childSession.id, state: "error", durationMs: Date.now() - startedAt, toolCalls } },
        parent.id,
      );
      return { childSessionId: childSession.id, summary: `子代理失败：${error instanceof Error ? error.message : "未知错误"}`, state: "error" };
    }
  }

  /** Persists a subtask part on the parent's latest assistant message so the
   *  transcript links to the child session (spec §6.4 step 5). */
  private async recordSubtask(parent: SessionInfo, input: { prompt: string; description: string; agent: string; childSessionId: string }): Promise<void> {
    const entries = await this.deps.store.getMessages(parent.id);
    const lastAssistant = [...entries].reverse().find((entry) => entry.info.role === "assistant");
    if (!lastAssistant) return;
    const part: Part = {
      id: newPartId(),
      sessionId: parent.id,
      messageId: lastAssistant.info.id,
      type: "subtask",
      prompt: input.prompt,
      description: input.description,
      agent: input.agent,
      childSessionId: input.childSessionId,
    };
    await this.deps.store.appendPart(part).catch(() => undefined);
    await this.publish({ type: "message.part.updated", data: { part } }, parent.id);
  }

  /** 任务终态小结（N5）：run 收尾时用 summary 模型生成一句自然语言总结，
   *  附本轮结构化统计，发布 session.summary 事件供前端渲染「任务完成卡」。
   *  失败/中断也发（kind 区分），让 UI 的收尾永远有明确落点。生成失败或
   *  无 summaryModel 时静默跳过（不阻塞 run 收尾）。 */
  private async summarizeRun(
    session: SessionInfo,
    input: {
      agent: Agent;
      baseline: number;
      startedAt: number;
      kind: "completed" | "aborted" | "error";
      stats: { toolCalls: number; editedFiles: string[] };
    },
  ): Promise<void> {
    // 终态先落 session 记录（列表三态用，N5）——即使 summaryModel 缺失或生成
    // 失败，lastOutcome 也要写回，保证列表能区分完成/中断/失败。
    await this.deps.store.updateSession(session.id, { lastOutcome: input.kind }).catch(() => undefined);

    const durationMs = Date.now() - input.startedAt;
    const meta = { filesEdited: input.stats.editedFiles.length, toolCalls: input.stats.toolCalls, durationMs };

    // 兜底文案：summary 生成失败 / 无模型 / 超时 / 空文本时，仍然发一条带
    // meta 的 session.summary，保证前端「任务完成卡」三态必现，而非悄无声息结束。
    const fallbackText =
      input.kind === "completed"
        ? `本轮任务已完成，共 ${meta.toolCalls} 次工具调用${meta.filesEdited > 0 ? `，改动 ${meta.filesEdited} 个文件` : ""}。`
        : input.kind === "aborted"
        ? `本轮任务已中断，已完成 ${meta.toolCalls} 次工具调用${meta.filesEdited > 0 ? `，改动 ${meta.filesEdited} 个文件` : ""}。`
        : `本轮任务执行出错，已完成 ${meta.toolCalls} 次工具调用${meta.filesEdited > 0 ? `，改动 ${meta.filesEdited} 个文件` : ""}。`;

    // 总结模型沿用「会话实际模型」而非 compaction 专用 summaryModel，保证
    // 总结卡文案由当前会话正在用的模型生成。仅当 compaction 启用时才做 AI
    // 总结（否则落到兜底文案），但模型来源与会话模型解耦。modelFor 抛错
    // （宿主 provider 不认识该 ref）时回落 compaction.summaryModel，再不行
    // 落到下方兜底文案。
    let summaryModel: Model<Api> | null = null;
    if (this.deps.compaction?.enabled) {
      try {
        summaryModel = this.deps.modelFor(session.model);
      } catch {
        summaryModel = this.deps.compaction.summaryModel ?? null;
      }
    }
    // 本轮新增消息（baseline 之后），只取 user/assistant 文本作总结素材
    const messages = input.agent.state.messages.slice(input.baseline);
    const textMessages = messages.filter((m) => m.role === "user" || m.role === "assistant");

    let text = "";
    if (summaryModel && textMessages.length > 0) {
      // 总结提示词：只描述本轮做了什么，一句/几句自然语言，不续写
      const systemPrompt =
        "你是任务收尾助手。根据用户本轮的任务与助手已完成的工作，写一句简短、克制的中文总结（1-2 句），" +
        "说明「做了什么、结果如何、下一步建议」。不要客套、不要问句、不要续写任务，只输出总结正文。";
      try {
        const { streamOneText } = await import("./compaction.js");
        const streamFn = this.deps.streamFnFor(session);
        // 15s 超时兜底：summary 是收尾的锦上添花，不能因为上游慢而卡住 run 收尾。
        text = await Promise.race([
          streamOneText(
            async (m, ctx) => streamFn(m, ctx as never),
            summaryModel,
            systemPrompt,
            textMessages,
          ),
          new Promise<string>((resolve) => setTimeout(() => resolve(""), 15_000)),
        ]);
      } catch {
        /* 总结生成失败 → 落到下方兜底文案 */
      }
    }

    const trimmed = text.trim();
    await this.publish(
      { type: "session.summary", data: { text: trimmed || fallbackText, kind: input.kind, meta } },
      session.id,
    ).catch(() => undefined);
  }

  private async lastAssistantText(sessionId: string): Promise<string> {
    const entries = await this.deps.store.getMessages(sessionId);
    for (let index = entries.length - 1; index >= 0; index--) {
      const entry = entries[index]!;
      if (entry.info.role !== "assistant") continue;
      const text = entry.parts
        .filter((part): part is Extract<Part, { type: "text" }> => part.type === "text")
        .map((part) => part.text)
        .join("\n")
        .trim();
      if (text) return text;
    }
    return "";
  }

  private async sessionDepth(session: SessionInfo): Promise<number> {
    let depth = 0;
    let current = session;
    while (current.parentId) {
      depth += 1;
      const next = await this.deps.store.getSession(current.parentId);
      if (!next) break;
      current = next;
    }
    return depth;
  }
  private async rebuildMessages(sessionId: string, excludedUserIds?: Set<string>): Promise<AgentMessage[]> {
    const entries = await this.deps.store.getMessages(sessionId);
    const messages: AgentMessage[] = [];
    for (const { info, parts } of entries) {
      if (info.role === "user") {
        if (excludedUserIds?.has(info.id)) continue;
        const text = parts
          .filter((part): part is Extract<Part, { type: "text" }> => part.type === "text")
          .map((part) => part.text)
          .join("\n");
        const fileParts = parts.filter((p): p is Extract<Part, { type: "file" }> => p.type === "file");
        // 旧链路历史：data URL 内联部分保持原样重建，否则升级后老会话会「丢附件」。
        const legacy = fileParts.flatMap((p) => {
          const url = p.url;
          if (typeof url !== "string" || !url.startsWith("data:")) return [];
          return [{ name: p.filename, mediaType: p.mime, data: url, size: Buffer.from(url.slice(url.indexOf(",") + 1), "base64").length }];
        });
        // 新链路：按描述符重建，正文经 provider 读取（图片→视觉输入、小文本→内联、其余→清单）。
        // 因此重放历史**不会**把所有附件正文反复塞进后续每个 turn（规格 2 §11）。
        // 用 AttachmentContentRef 而不是 InputAttachmentRef：part 里没有 sha256，
        // 硬编一个假摘要会违反该类型的不变量。
        const refs: AttachmentContentRef[] = fileParts.flatMap((p) => p.attachmentId
          ? [{
            id: p.attachmentId,
            name: p.filename,
            mediaType: p.mime,
            ...(typeof p.size === "number" ? { size: p.size } : {}),
            kind: p.kind ?? "text",
          }]
          : []);
        const refParts = await attachmentRefContent(this.deps.attachments, refs, { sessionId });
        messages.push({ role: "user", content: [{ type: "text", text }, ...attachmentContent(legacy), ...refParts], timestamp: Date.parse(info.time.created) || Date.now() });
      } else {
        const text = parts
          .filter((part): part is Extract<Part, { type: "text" }> => part.type === "text")
          .map((part) => part.text)
          .join("\n");
        if (!text) continue;
        messages.push({
          role: "assistant",
          content: [{ type: "text", text }],
          api: "openai-completions",
          provider: info.model.providerId,
          model: info.model.modelId,
          usage: { input: info.tokens?.input ?? 0, output: info.tokens?.output ?? 0, cacheRead: info.tokens?.cacheRead ?? 0, cacheWrite: info.tokens?.cacheWrite ?? 0, totalTokens: (info.tokens?.input ?? 0) + (info.tokens?.output ?? 0) + (info.tokens?.cacheRead ?? 0) + (info.tokens?.cacheWrite ?? 0) },
          stopReason: info.error ? "error" : "stop",
          ...(info.error ? { errorMessage: info.error.message } : {}),
          timestamp: Date.parse(info.time.created) || Date.now(),
        } as AgentMessage);
      }
    }
    return messages;
  }
}

export async function createFrameworkSession(input: {
  store: SessionStore;
  id?: string;
  userId: string;
  workspaceId: string;
  agent?: string;
  agentId?: string;
  agentVersionId?: string;
  model: ModelRef;
  prompt?: string;
  parentId?: string;    // subagent child: links to the spawning session (§6.4)
  title?: string;       // override the prompt-truncation default
  permission?: Ruleset; // pre-stamped session rules (subagent inherits parent's)
  writePaths?: string[]; // 子代理写路径白名单（WritePathSet，07-subagent）
  creationRequestId?: string;
  creationPayloadHash?: string;
}): Promise<SessionInfo> {
  const session: SessionInfo = {
    id: input.id ?? newSessionId(),
    workspaceId: input.workspaceId,
    userId: input.userId,
    ...(input.parentId ? { parentId: input.parentId } : {}),
    title: (input.title ?? input.prompt ?? "新会话").slice(0, 40),
    agent: input.agent ?? "default",
    ...(input.agentId ? { agentId: input.agentId } : {}),
    ...(input.agentVersionId ? { agentVersionId: input.agentVersionId } : {}),
    model: input.model,
    permission: input.permission ?? [],
    ...(input.writePaths?.length ? { writePaths: input.writePaths } : {}),
    queuedPrompts: [],
    ...(input.creationRequestId ? { creationRequestId: input.creationRequestId } : {}),
    ...(input.creationPayloadHash ? { creationPayloadHash: input.creationPayloadHash } : {}),
    time: { created: new Date().toISOString(), updated: new Date().toISOString() },
  };
  await input.store.createSession(session);
  return session;
}

export function isSessionActive(sessionId: string): boolean {
  return activeRuns.has(sessionId);
}

/** 会话当前 run 是否挂起等待人工授权（HITL 待确认）。宿主会话列表用它把
 *  「待确认」从笼统的「运行中」里区分出来，否则后台会话被权限卡住时
 *  侧边栏毫无信号。无 run 或 run 无 pending 请求均为 false。 */
export function isSessionAwaitingPermission(sessionId: string): boolean {
  const active = activeRuns.get(sessionId);
  return !!active && active.engine.pendingRequests.length > 0;
}

/** 当前所有 running 会话 id（Electron 优雅退出等收尾场景枚举用，P2）。
 *  activeRuns 是模块级 globalThis 单例，跨项目/跨 runtime 共享。 */
export function listActiveSessions(): string[] {
  return activeRuns.sessionIds();
}

// The package runner is storage-agnostic: stores (Mongo/JSONL), event logs,
// workspace backends and sandbox executors are all injected via RunnerDeps.
// Products assemble them in createServer(); the CLI uses JSONL + subprocess.

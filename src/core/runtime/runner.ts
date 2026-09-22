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
import { CommandService } from "./command-service.js";
import { TaskLifecycle, RESET_GUARDS_ON_RESUME, isRetryableError, type RunOutcome } from "./task-lifecycle.js";
import { ContextBuilder } from "./context-builder.js";
import { AttemptExecutor } from "./attempt-executor.js";
export { isRetryableError } from "./task-lifecycle.js";
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
  /** 子代理协调器（M3-S21）：注入后 agent_* 工具可用，spawnSubagent 走
   *  持久协调（SubagentRecord/限额队列）；未注入时保持旧嵌套 runLoop 行为。 */
  subagentCoordinator?: import("../subagents/coordinator.js").SubagentCoordinator;
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



export class SessionRunner {
  private readonly scheduler: RunScheduler;
  private readonly lifecycle: TaskLifecycle;
  private readonly contextBuilder: ContextBuilder;
  private readonly attemptExecutor: AttemptExecutor;
  private readonly commandService: CommandService;

  constructor(private readonly deps: RunnerDeps) {
    // 调度（drain 驱动链 / 放行登记 / 停止协调 / 租约）在 RunScheduler（W6 S3），
    // 提交链（投影 → 任务归属 → acceptPrompt → task.started）在 CommandService
    // （W6 S4）。runner 经回调提供执行语义；W7 换 AttemptExecutor 时改这里。
    this.contextBuilder = new ContextBuilder({
      store: deps.store,
      ...(deps.attachments ? { attachments: deps.attachments } : {}),
      ...(deps.compaction ? { compaction: deps.compaction } : {}),
      modelFor: (ref) => deps.modelFor(ref),
      streamFnFor: (session) => deps.streamFnFor(session),
      ...(deps.memoryContextFor ? { memoryContextFor: (session, text) => deps.memoryContextFor!(session, text) } : {}),
    });
    this.lifecycle = new TaskLifecycle({
      store: deps.store,
      publish: (event, sessionId) => this.publish(event, sessionId),
      attemptRunner: (session, input, acceptedUserId, taskContext) => this.attemptExecutor.runLoop(session, input, acceptedUserId, taskContext),
      ...(deps.taskPolicy ? { taskPolicy: deps.taskPolicy } : {}),
    });
    this.scheduler = new RunScheduler({
      store: deps.store,
      executor: {
        runJob: (session, input, acceptedUserId) => this.lifecycle.runTask(session, input, acceptedUserId),
        driveResumed: (session) => this.driveResumedTask(session),
        cancelResidual: (sessionId) => this.cancelResidualTask(sessionId),
      },
      ...(deps.leaseStore ? { leaseStore: deps.leaseStore } : {}),
    });
    this.attemptExecutor = new AttemptExecutor(deps, {
      lifecycle: this.lifecycle,
      scheduler: this.scheduler,
      contextBuilder: this.contextBuilder,
      publish: (event, sessionId) => this.publish(event, sessionId),
      persist: (event, fallbackSessionId) => this.persist(event, fallbackSessionId),
      spawnSubagent: (session, input, registry, engine) => this.spawnSubagent(session, input, registry, engine),
    });
    this.commandService = new CommandService({
      store: deps.store,
      scheduler: this.scheduler,
      casTask: (task, patch) => this.lifecycle.casTask(task, patch),
      publish: (event, sessionId) => this.publish(event, sessionId),
      launch: (session, input) => void this.attemptExecutor.runLoop(session, input),
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
    await this.lifecycle.runTask(
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
    await this.lifecycle.casTask(task, { status: "queued", blocker: undefined, ...RESET_GUARDS_ON_RESUME });
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
    const updated = await this.lifecycle.casTask(task, { status: "cancelled", blocker: undefined });
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
    const transform = await this.contextBuilder.buildCompaction(session, (event) => this.publish(event, session.id), true);
    if (!transform) return { ok: false, reason: "compaction-disabled" };
    const { entries, excludedUserIds } = await this.contextBuilder.historySnapshot(sessionId);
    const messages = await this.contextBuilder.rebuildMessages(sessionId, entries, excludedUserIds);
    if (messages.length <= 1) return { ok: false, reason: "nothing-to-compact" };
    await transform(messages);
    return { ok: true };
  }

  /** Layers the session's workspace custom agents (`.zmzai/agents/*.md`) on top
   *  of the shared registry without mutating it (spec §6.3). Load failures
   *  degrade to the base registry — a malformed md never blocks a run. */
  // ---- 持续任务执行（规格 3 §8）----------------------------------------------

  /** 子代理嵌套运行的内部入口（W7-S7：runLoop 已迁 AttemptExecutor）。
   *  非 async 直通——委托层禁止 async 包 promise（会多一拍，见 W6 §8）。 */
  runAttempt(session: SessionInfo, input: PromptInput): Promise<RunOutcome> {
    return this.attemptExecutor.runLoop(session, input);
  }

  /** Spawns a subagent child session (spec §6.4): depth-capped, permission
   *  stamped from parent session + subagent preset, runs a nested PI loop to
   *  completion, and returns the child's final assistant text as the parent
   *  tool's result. Awaits the nested runLoop directly. */
  private async spawnSubagent(
    parent: SessionInfo,
    input: { description: string; prompt: string; subagentType: string; spawnRequestId?: string; mode?: "read_only" | "workspace_write" },
    registry: AgentRegistry,
    parentEngine: PermissionEngine,
  ): Promise<{ childSessionId: string; summary: string; state: "completed" | "error" }> {
    // M3-S21：协调器路径——SubagentRecord 持久化 + 限额队列 + 事件桥保留
    const coordinator = this.deps.subagentCoordinator;
    if (coordinator) {
      const depth = await this.sessionDepth(parent);
      if (depth >= this.deps.subagentDepth) throw new Error(`子代理嵌套深度超过限制（${this.deps.subagentDepth}）`);
      const subagent = registry.get(input.subagentType);
      if (!subagent || (subagent.mode !== "subagent" && subagent.mode !== "all")) throw new Error(`未知或非子代理类型：${input.subagentType}`);
      await parentEngine.ask({ sessionId: parent.id, permission: "task", patterns: [input.subagentType], always: ["*"], metadata: { subagent: input.subagentType, description: input.description } });
      // 权限 stamp 的子会话创建 + 事件桥（与旧路径同构）
      const childSession = await createFrameworkSession({
        store: this.deps.store, userId: parent.userId, workspaceId: parent.workspaceId,
        agent: input.subagentType, model: subagent.model ?? parent.model, prompt: input.prompt,
        parentId: parent.id, title: input.description,
        // read_only 模式：父权限为上限，写工具全 deny（writePathGuardRules([]) 空集 +
        // preset 无 writePaths → 圈禁为空 → executor 的 confine 会拒绝全部写路径）
        permission: input.mode === "read_only" ? [...parent.permission] : [...parent.permission, ...writePathGuardRules(subagent.writePaths ?? [])],
        ...(input.mode !== "read_only" && subagent.writePaths?.length ? { writePaths: subagent.writePaths } : {}),
      });
      await this.publish({ type: "subagent.started", data: { id: childSession.id, agent: input.subagentType, task: input.description, parentSessionId: parent.id } }, parent.id);
      const activeTask = await this.deps.store.task?.getActiveTask(parent.id);
      const record = await coordinator.spawn(parent, activeTask?.id ?? "task_adhoc", activeTask?.rootRequestId ?? activeTask?.id ?? "task_adhoc", {
        description: input.description, prompt: input.prompt, subagentType: input.subagentType,
        childSessionId: childSession.id,
        ...(input.mode ? { mode: input.mode } : {}),
        ...(input.spawnRequestId ? { spawnRequestId: input.spawnRequestId } : {}),
      });
      const { changed } = await coordinator.wait([record.childId], 300_000);
      const final = changed.find((r) => r.childId === record.childId);
      const summary = final?.result?.summary ?? ((await this.lastAssistantText(childSession.id)) || `(状态 ${final?.status ?? "unknown"})`);
      await this.recordSubtask(parent, { prompt: input.prompt, description: input.description, agent: input.subagentType, childSessionId: childSession.id });
      const terminalState = final && (final.status === "completed") ? "completed" : "error";
      await this.publish({ type: "subagent.finished", data: { id: childSession.id, state: terminalState, durationMs: Date.now() - Date.parse(record.times.spawnedAt), toolCalls: 0 } }, parent.id);
      return { childSessionId: childSession.id, summary, state: terminalState };
    }
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
      await childRunner.runAttempt(childSession, { text: input.prompt, agent: input.subagentType });
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

export { isSessionActive, isSessionAwaitingPermission, listActiveSessions } from "./active-run-registry.js";

// The package runner is storage-agnostic: stores (Mongo/JSONL), event logs,
// workspace backends and sandbox executors are all injected via RunnerDeps.
// Products assemble them in createServer(); the CLI uses JSONL + subprocess.

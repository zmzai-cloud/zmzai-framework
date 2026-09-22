import { Agent } from "@earendil-works/pi-agent-core";
import type { Api, Model } from "@earendil-works/pi-ai";
import { attachmentContent, attachmentRefContent } from "./attachments.js";
import type { AgentRegistry } from "../agent/registry.js";
import type { AgentResolver, ResolvedAgent } from "../agent/resolver.js";
import type { FrameworkEvent } from "../events/manifest.js";
import { PermissionEngine, RejectedError } from "../permission/engine.js";
import { confineWorkspaceFiles } from "../permission/write-path.js";
import { PartProjector, serializeEmit } from "./pi-bridge.js";
import { LoopGuard, REPEAT_EDIT_FAILURE_THRESHOLD } from "./loop-guard.js";
import type { SessionStore } from "../session/store.js";
import type { ModelRef, SelectedSkill, SessionInfo } from "../session/types.js";
import type { PromptInput } from "../session/workflow.js";
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
import { isRetryableError, type RunOutcome, type TaskLifecycle } from "./task-lifecycle.js";
import type { RunScheduler } from "./run-scheduler.js";
import type { ContextBuilder } from "./context-builder.js";
import { defaultActiveRunRegistry } from "./active-run-registry.js";

/** 活跃 run 表（registry 门面，与 runner 共享同一 globalThis 实例）。 */
const activeRuns = defaultActiveRunRegistry;
import type { TaskRecord, TaskEvidenceKind } from "../task/types.js";
import { taskContractText } from "../task/contract.js";
import { evidenceKindForTool } from "../task/plan.js";

/** 人工放行时喂给模型的驱动文本（与 `continuation` 那条同源但不同话术）。
 *
 *  它同样**不落库**：`resumeTask` 不经过 `prompt()`，没有 message、没有 workflow
 *  receipt，`acceptedUserId` 为 undefined——但这里必须显式跳过投影，因为
 *  `acceptedUserId` 为空正是「投影一条用户消息」的默认路径（见 runLoop）。
 *  用一个专门的标记区分，才不会把「继续」画成用户说过的话。 */
const RESUME_DRIVE_TEXT =
  "[继续执行任务] 用户已经核对过当前状态并授权继续。按上面的任务契约接着推进，不要从头再做一遍，也不要把控制权提前交回用户。";

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


/** AttemptExecutor（W7-S7 自 SessionRunner 原样搬移，spec §7）：
 *  PI 适配、上下文消费、工具执行钩子、事件漏斗与 RunOutcome 装配。
 *  单次 Attempt 的完整执行；任务循环在 TaskLifecycle，调度在 RunScheduler。 */
/** 协作者由 runner 装配注入；RunnerDeps 字段**持有原对象引用**（测试会在
 *  构造 runner 之后改 deps 字段，快照会让它们静默失效——W7-S7 实测踩过）。 */
export type AttemptCollaborators = {
  lifecycle: TaskLifecycle;
  scheduler: RunScheduler;
  contextBuilder: ContextBuilder;
  publish: (event: FrameworkEvent, sessionId: string) => Promise<void>;
  persist: (event: FrameworkEvent, fallbackSessionId: string) => Promise<void>;
  subagentCoordinator?: import("../subagents/coordinator.js").SubagentCoordinator;
  spawnSubagent: (session: SessionInfo, input: { description: string; prompt: string; subagentType: string }, registry: AgentRegistry, parentEngine: PermissionEngine) => Promise<{ childSessionId: string; summary: string; state: "completed" | "error" }>;
};

export class AttemptExecutor {
  #hooks: LifecycleHook[] = [];
  /** 供 runLoop 取归一化钩子数组（lazy：constructor 后仍可由 deps 引用共享）。 */
  private get hooks(): LifecycleHook[] {
    if (this.#hooks.length !== (this.deps.hooks?.length ?? 0)) this.#hooks = [...(this.deps.hooks ?? [])];
    return this.#hooks;
  }

  constructor(private readonly deps: import("./runner.js").RunnerDeps, private readonly collabs: AttemptCollaborators) {}

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
  async runLoop(
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
        await this.collabs.publish({ type: "session.status", data: { status: "waiting_permission" } }, session.id);
        await this.collabs.publish({ type: "permission.asked", data: { request } }, session.id);
        // 权限等待必须让任务层可见（规格 §11.1）。否则用户在盯着授权卡的时候，
        // 任务状态还是「运行中」——「在跑」和「在等你点授权」对用户是两件事，
        // 而任务 API 会给出一个错的答案。
        await this.collabs.lifecycle.markPermissionWait(taskContext?.task.id, request.permission, request.patterns, true);
      },
      onReplied: async (request, reply) => {
        await this.collabs.publish({ type: "permission.replied", data: { id: request.id, reply } }, session.id);
        await this.collabs.publish({ type: "session.status", data: { status: "running" } }, session.id);
        // 授权通过或拒绝都解除等待：规格 §11.3 要求把拒绝结果交回模型去试替代
        // 方案，只有模型也没有替代方案时才判 blocked/failed。留在
        // waiting_permission 会把「已经拒绝了」误报成「还在等你授权」。
        await this.collabs.lifecycle.markPermissionWait(taskContext?.task.id, request.permission, request.patterns, false);
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
      await this.collabs.persist(event, session.id);
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
      await this.collabs.publish(event,session.id);
    };
    const toolContext = (this.deps.buildToolContext ?? defaultToolContext)({ session, engine, workspace, sandbox, emit: emitAsync });
    // Subagent spawning is only available to primary (non-child) sessions, and
    // only when the runner can host a nested run (spec §6.4).
    if (!session.parentId) {
      toolContext.spawnSubagent = (spawnInput) => this.collabs.spawnSubagent(session, spawnInput, registry, engine);
      // M3-S21：协调器可用时注入 agent_* 工具族（宿主须先在 tools 里带上
      // subagentTools——这里只注入运行期上下文：coordinator + 任务归属）
      const coordinator = this.deps.subagentCoordinator;
      if (coordinator) {
        const activeTask = await this.deps.store.task?.getActiveTask(session.id).catch(() => null);
        (toolContext as unknown as { subagents?: unknown }).subagents = {
          coordinator,
          rootTaskId: activeTask?.rootRequestId ?? activeTask?.id ?? "task_adhoc",
          parentTaskId: activeTask?.id ?? "task_adhoc",
        };
      }
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

    // 上下文组装唯一入口（W7-S6）：压缩 transform、同拍快照重建、记忆召回。
    const { compactionTransform, history, baseline } = await this.collabs.contextBuilder.buildAttemptContext(session, input, emit);
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
    if (this.collabs.scheduler.isStopRequested(session.id)) abort();
    await this.collabs.scheduler.stampLease(session.id);

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
      void this.collabs.publish(
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
      void this.collabs.publish(
        {
          type: "session.checkpoint",
          data: { toolCalls: summaryToolCalls, lastTool: summaryLastTool, elapsedMs },
        },
        session.id,
      ).catch(() => undefined);
    }, CHECKPOINT_INTERVAL_MS);

    try {
      await Promise.all(fireRunStart(this.hooks, { sessionId: session.id, agent: session.agent, text: input.text }));
      await this.collabs.publish({ type: "session.status", data: { status: "running" } }, session.id);
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
        await this.collabs.publish({ type: "session.status", data: { status: "waiting_input" } }, session.id);
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
        await this.collabs.publish({ type: "session.error", data: { name: "APIError", message: failed } }, session.id);
      }
      await this.collabs.publish({ type: "session.status", data: { status: "idle" } }, session.id);
      }
    } catch (error) {
      await settled();
      const aborted = abortController.signal.aborted;
      if (!aborted && !unknownSideEffect) {
        runErrored = true;
        runErrorMessage = error instanceof Error ? error.message : "Agent 运行失败";
      }
      await this.collabs.publish(
        unknownSideEffect
          ? { type: "session.status", data: { status: "waiting_input" } }
          : aborted
          ? { type: "session.status", data: { status: "idle" } }
          : { type: "session.error", data: { name: "AgentRuntimeError", message: error instanceof Error ? error.message : "Agent 运行失败" } },
        session.id,
      );
      if (!aborted && !unknownSideEffect) await this.collabs.publish({ type: "session.status", data: { status: "idle" } }, session.id);
    } finally {
      clearInterval(streamWatchdog);
      clearInterval(checkpointTimer);
      defaultActiveRunRegistry.delete(session.id);
      engine.dispose();
      // Workflow settlement clears its lease atomically with the terminal run state.
      if (!acceptedUserId) await this.collabs.scheduler.clearLease(session.id);
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
    await this.collabs.publish(
      { type: "session.summary", data: { text: trimmed || fallbackText, kind: input.kind, meta } },
      session.id,
    ).catch(() => undefined);
  }

}

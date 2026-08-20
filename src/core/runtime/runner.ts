import { Agent, type AgentMessage } from "@earendil-works/pi-agent-core";
import type { Api, Model } from "@earendil-works/pi-ai";

import { AgentRegistry, type AgentInfo } from "../agent/registry.js";
import type { AgentResolver, ResolvedAgent } from "../agent/resolver.js";
import { leaseDurationMs } from "../../adapters/index.js";
import { notifyEventLogListeners, type EventLog } from "../events/bus.js";
import type { FrameworkEvent } from "../events/manifest.js";
import { PermissionEngine, RejectedError, type Reply } from "../permission/engine.js";
import type { Ruleset } from "../permission/ruleset.js";
import { PartProjector, serializeEmit } from "./pi-bridge.js";
import { LoopGuard, REPEAT_EDIT_FAILURE_THRESHOLD } from "./loop-guard.js";
import type { SessionStore } from "../session/store.js";
import { newPartId, newSessionId } from "../session/ids.js";
import type { ModelRef, Part, SessionInfo } from "../session/types.js";
import { adaptTool, permissionForCall } from "../tools/adapter.js";
import { builtinTools } from "../tools/builtins.js";
import type { ToolContext, WorkspaceFiles } from "../tools/context.js";
import type { ToolDef } from "../tools/def.js";
import type { SandboxExecutor } from "../../adapters/index.js";
import { noopSandboxExecutor } from "../../adapters/index.js";

/** SessionRunner (spec §8.1): owns one session's full lifecycle — prompt →
 *  PI agent loop → persisted parts + framework events → terminal settlement
 *  → queued prompt continuation. Permission checks happen only in
 *  beforeToolCall (spec §5.4).
 *
 *  M5: fully storage/backend-agnostic. All product surfaces (model, sandbox,
 *  workspace files, event log, lease) are injected. */

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
  tools?: ToolDef[];
  buildToolContext?: (input: { session: SessionInfo; engine: PermissionEngine }) => ToolContext;
  /** Loads workspace custom agents (spec §6.3). */
  loadWorkspaceAgents?: (session: SessionInfo) => Promise<AgentInfo[]>;
  /** Optional control-plane lookup for an immutable Agent Version. */
  agentResolver?: AgentResolver;
  /** Max subagent nesting depth (spec §6.4, default 1). */
  subagentDepth: number;
  /** Auto-compaction (spec §8.3). Disabled when summaryModel is null. */
  compaction?: { enabled: boolean; contextWindow: number; summaryModel: Model<Api> | null };
};

type ActiveRun = {
  agent: Agent;
  engine: PermissionEngine;
  settled: () => Promise<void>;
  abort: () => void;
};

/** 事件的 sessionId 提取：能自带的自带（message/part/session），其余
 *  （message.part.delta 等）用发起 run 的会话 id 兜底。 */
function sessionIdOf(event: FrameworkEvent, fallbackSessionId: string): string {
  if (event.type === "message.updated") return event.data.message.sessionId;
  if (event.type === "message.part.updated") return event.data.part.sessionId;
  if (event.type === "session.updated") return event.data.session.id;
  return fallbackSessionId;
}

const globalRunners = globalThis as typeof globalThis & { __zmzaiFrameworkRuns?: Map<string, ActiveRun> };
const activeRuns = globalRunners.__zmzaiFrameworkRuns ?? new Map<string, ActiveRun>();
globalRunners.__zmzaiFrameworkRuns = activeRuns;

/** 上游中断类错误（F6）：模型流偶发终止/连接断开时自动重试一次，避免
 *  偶发中断直接结束任务（实测 relay 透传 "terminated"、上游断流
 *  "upstream_http2_stream_error" 等）。余额/鉴权等确定性错误不重试。 */
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
    normalized.includes("stream failed")
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

export class SessionRunner {
  constructor(private readonly deps: RunnerDeps) {}

  /** fallbackSessionId 由 runLoop 闭包传入（而非实例字段）：runner 是进程级
   *  单例，两个会话并发时实例字段会互相覆盖，导致 message.part.delta 等
   *  无自带 sessionId 的事件落到错误的会话事件流里（串台）。 */
  private async persist(event: FrameworkEvent, fallbackSessionId: string): Promise<void> {
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
    const persisted = await this.deps.eventLog.append({ sessionId: sessionIdOf(event, fallbackSessionId), ...event });
    notifyEventLogListeners(persisted);
  }

  private async publish(event: FrameworkEvent, sessionId: string): Promise<void> {
    const persisted = await this.deps.eventLog.append({ sessionId, ...event });
    notifyEventLogListeners(persisted);
  }

  private async stampLease(sessionId: string): Promise<void> {
    if (!this.deps.leaseStore) return; // demo/JSONL mode: no lease
    await this.deps.leaseStore.stamp(sessionId, `node:${process.pid}`, new Date(Date.now() + leaseDurationMs)).catch(() => undefined);
  }

  private async clearLease(sessionId: string): Promise<void> {
    if (!this.deps.leaseStore) return;
    await this.deps.leaseStore.clear(sessionId).catch(() => undefined);
  }

  async prompt(sessionId: string, input: { text: string; agent?: string; model?: ModelRef }): Promise<{ queued: boolean }> {
    const session = await this.deps.store.getSession(sessionId);
    if (!session) throw new Error("SESSION_NOT_FOUND");

    if (activeRuns.has(sessionId)) {
      await this.deps.store.enqueuePrompt(sessionId, { text: input.text, ...(input.agent ? { agent: input.agent } : {}), enqueuedAt: new Date().toISOString() });
      return { queued: true };
    }

    void this.runLoop(session, input);
    return { queued: false };
  }

  async replyPermission(sessionId: string, requestId: string, reply: Reply, feedback?: string): Promise<boolean> {
    const active = activeRuns.get(sessionId);
    if (!active) return false;
    return active.engine.reply(requestId, reply, feedback);
  }

  async abort(sessionId: string): Promise<void> {
    const active = activeRuns.get(sessionId);
    await this.deps.store.clearQueuedPrompts(sessionId);
    if (!active) return;
    active.abort();
  }

  /** Builds the compaction transformContext (spec §8.3) when the runner has a
   *  summary model configured. Emits a `compaction` part on the latest
   *  assistant message so the boundary shows in the transcript. */
  private async buildCompaction(session: SessionInfo, emit: (event: FrameworkEvent) => void) {
    if (!this.deps.compaction?.enabled || !this.deps.compaction.summaryModel) return undefined;
    const { buildCompactionTransform, streamOneText } = await import("./compaction.js");
    return buildCompactionTransform({
      enabled: true,
      contextWindow: this.deps.compaction.contextWindow,
      summaryModel: this.deps.compaction.summaryModel,
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

  private async runLoop(session: SessionInfo, input: { text: string; agent?: string; model?: ModelRef }): Promise<void> {
    const registry = await this.registryFor(session);
    const resolved = await this.resolvedAgentFor(session);
    const agentName = resolved ? resolved.agent.name : input.agent ?? session.agent;
    const agentInfo = resolved?.agent ?? registry.get(agentName) ?? registry.get("default");
    const model = input.model ?? agentInfo?.model ?? session.model;

    const agentRulesets = resolved ? [registry.rulesetsFor("default")[0]!, resolved.agent.permission] : registry.rulesetsFor(agentInfo?.name ?? "default");
    const engine = new PermissionEngine(session.id, agentRulesets, session.permission, {
      onAsked: async (request) => {
        await this.publish({ type: "session.status", data: { status: "waiting_permission" } }, session.id);
        await this.publish({ type: "permission.asked", data: { request } }, session.id);
      },
      onReplied: async (request, reply) => {
        await this.publish({ type: "permission.replied", data: { id: request.id, reply } }, session.id);
        await this.publish({ type: "session.status", data: { status: "running" } }, session.id);
      },
      onSessionRuleAdded: async (sessionId, rule) => {
        const latest = await this.deps.store.getSession(sessionId);
        if (!latest) return;
        await this.deps.store.updateSession(sessionId, { permission: [...latest.permission, rule] });
      },
    });

    const { emit, settled } = serializeEmit(async (event) => {
      await this.persist(event, session.id);
    });

    const projector = new PartProjector({ sessionId: session.id, agent: agentInfo?.name ?? "default", model });
    // Exclude task from contexts that can't nest; include for primary runs.
    const baseTools = [...(this.deps.tools ?? builtinTools), ...(resolved?.tools ?? [])];
    const toolList = session.parentId ? baseTools.filter((def) => def.id !== "task") : baseTools;
    const toolDefs = new Map<string, ToolDef>(toolList.map((def) => [def.id, def]));
    const sandbox = this.deps.sandbox ?? noopSandboxExecutor();
    const workspace = this.deps.workspaceFor(session);
    const emitAsync = async (event: FrameworkEvent) => {
      const persisted = await this.deps.eventLog.append({ sessionId: session.id, ...event });
      notifyEventLogListeners(persisted);
    };
    const toolContext = (this.deps.buildToolContext ?? defaultToolContext)({ session, engine, workspace, sandbox, emit: emitAsync });
    // Subagent spawning is only available to primary (non-child) sessions, and
    // only when the runner can host a nested run (spec §6.4).
    if (!session.parentId) {
      toolContext.spawnSubagent = (spawnInput) => this.spawnSubagent(session, spawnInput, registry, engine);
    }
    const piTools = [...toolDefs.values()].map((def) => adaptTool(def, toolContext));

    const compactionTransform = await this.buildCompaction(session, emit);
    const agent = new Agent({
      initialState: {
        systemPrompt: agentInfo?.prompt ?? "",
        model: this.deps.modelFor(model),
        // NOTE: deliberately NOT setting thinkingLevel here. The relay backend
        // rejects `reasoning_effort` in its request schema (400 INVALID_BODY),
        // so any non-"off" thinking level breaks every model call. If reasoning
        // output is desired later, the relay must accept the field first.
        tools: piTools,
        messages: await this.rebuildMessages(session.id),
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
    activeRuns.set(session.id, { agent, engine, settled, abort });
    await this.stampLease(session.id);

    const loopGuard = new LoopGuard();
    agent.beforeToolCall = async ({ toolCall, args }) => {
      // 重复失败守卫（edit）：同一 (path, oldText) 已连续失败多次时，
      // 重试前先复查文件状态——oldText 已唯一存在则放行清记录，
      // 否则直接拦截（避免无意义空转烧步数）。
      const editDef = toolCall.name === "edit" ? toolDefs.get("edit") : undefined;
      const editArgs = editDef ? editDef.parameters.safeParse(args) : undefined;
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
      const resultText = (result.content ?? [])
        .filter((block): block is Extract<typeof block, { type: "text" }> => block.type === "text")
        .map((block) => block.text)
        .join("\n");
      let advisory = loopGuard.onToolResult({ toolName: toolCall.name, isError, errorText: resultText });
      if (toolCall.name === "edit") {
        const parsed = toolDefs.get("edit")?.parameters.safeParse(args);
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

    agent.subscribe((event) => {
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
          projector.onToolExecutionStart(emit, event.toolCallId, event.toolName, event.args);
          break;
        case "tool_execution_update":
          projector.onToolExecutionUpdate(emit, event.toolCallId, event.partialResult);
          break;
        case "tool_execution_end":
          projector.onToolExecutionEnd(emit, event.toolCallId, event.result, event.isError);
          break;
      }
    });

    await this.publish({ type: "session.status", data: { status: "running" } }, session.id);

    try {
      projector.onUserPrompt(emit, input.text);
      await agent.prompt(input.text);
      await settled();
      let failed = agent.state.errorMessage;
      // 自动重试（F6）：上游中断类错误（terminated/econnreset/timeout 等）
      // 带退避重试，最多 3 次。PI 失败时会注入一条 assistant failure 占位
      // 消息（last 是 assistant → continue() 被拒），换成合成 user 消息驱动
      // continue 重新生成；store 里同步的 failure 消息保留展示（UI 显示
      // "出错了"有诊断价值）。退避 500ms→1s→2s 避免对上游施压。
      const MAX_RETRIES = 3;
      for (let attempt = 0; attempt < MAX_RETRIES && failed && isRetryableError(failed); attempt += 1) {
        if (attempt > 0) await new Promise((resolve) => setTimeout(resolve, 500 * 2 ** (attempt - 1)));
        const messages = agent.state.messages;
        const last = messages[messages.length - 1];
        if (last?.role === "assistant" && "errorMessage" in last && last.errorMessage) {
          agent.state.messages = [
            ...messages.slice(0, -1),
            { role: "user", content: [{ type: "text", text: "（上轮回复生成中断，请继续完成回复。）" }], timestamp: Date.now() },
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
        await this.publish({ type: "session.error", data: { name: "APIError", message: failed } }, session.id);
      }
      await this.publish({ type: "session.status", data: { status: "idle" } }, session.id);
    } catch (error) {
      await settled();
      const aborted = abortController.signal.aborted;
      await this.publish(
        aborted
          ? { type: "session.status", data: { status: "idle" } }
          : { type: "session.error", data: { name: "AgentRuntimeError", message: error instanceof Error ? error.message : "Agent 运行失败" } },
        session.id,
      );
      if (aborted) await this.publish({ type: "session.status", data: { status: "idle" } }, session.id);
    } finally {
      activeRuns.delete(session.id);
      engine.dispose();
      await this.clearLease(session.id);
    }

    // FIFO queued prompts (spec §13.3): settle fully, then take the next one.
    const next = await this.deps.store.dequeuePrompt(session.id);
    if (next) {
      const latest = await this.deps.store.getSession(session.id);
      if (latest) await this.runLoop(latest, { text: next.text, ...(next.agent ? { agent: next.agent } : {}) });
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
      permission: [...parent.permission],
    });

    try {
      // Run the child with a FRESH runner (not this instance's nested runLoop):
      // reusing runLoop here would deadlock on the shared in-process state and
      // the parent's event chain. A dedicated runner owns the child's loop.
      const childRunner = new SessionRunner(this.deps);
      await childRunner.runLoop(childSession, { text: input.prompt, agent: input.subagentType });
      const summary = await this.lastAssistantText(childSession.id);
      await this.recordSubtask(parent, { prompt: input.prompt, description: input.description, agent: input.subagentType, childSessionId: childSession.id });
      return { childSessionId: childSession.id, summary: summary || "（子代理无文本输出）", state: "completed" };
    } catch (error) {
      await this.recordSubtask(parent, { prompt: input.prompt, description: input.description, agent: input.subagentType, childSessionId: childSession.id });
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
  private async rebuildMessages(sessionId: string): Promise<AgentMessage[]> {
    const entries = await this.deps.store.getMessages(sessionId);
    const messages: AgentMessage[] = [];
    for (const { info, parts } of entries) {
      if (info.role === "user") {
        const text = parts
          .filter((part): part is Extract<Part, { type: "text" }> => part.type === "text")
          .map((part) => part.text)
          .join("\n");
        messages.push({ role: "user", content: text || "（空消息）", timestamp: Date.parse(info.time.created) || Date.now() });
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
    queuedPrompts: [],
    time: { created: new Date().toISOString(), updated: new Date().toISOString() },
  };
  await input.store.createSession(session);
  return session;
}

export function isSessionActive(sessionId: string): boolean {
  return activeRuns.has(sessionId);
}

// The package runner is storage-agnostic: stores (Mongo/JSONL), event logs,
// workspace backends and sandbox executors are all injected via RunnerDeps.
// Products assemble them in createServer(); the CLI uses JSONL + subprocess.

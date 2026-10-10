import { SessionRunner, createFrameworkSession } from "../core/runtime/runner.js";
import { AgentRegistry } from "../core/agent/registry.js";
import type { SessionStore } from "../core/session/store.js";
import type { EventLog } from "../core/events/bus.js";
import type { WorkspaceFiles } from "../core/tools/context.js";
import type { SandboxExecutor } from "../adapters/index.js";
import { noopSandboxExecutor } from "../adapters/index.js";
import type { SessionInfo, ModelRef } from "../core/session/types.js";
import type { ModelProvider } from "../adapters/index.js";

/** createServer (M5 spec §1/§4): assembles a self-contained agent framework
 *  from injected backends. The product binds Mongo store + relay provider +
 *  OpenSandbox; the CLI binds JSONL store + OpenAI provider + subprocess
 *  sandbox + FS workspace. Either way the returned object is the whole
 *  framework: runner, store, event log, registry. */

export type FrameworkDeps = {
  store: SessionStore;
  eventLog: EventLog;
  modelProvider: ModelProvider;
  workspaceFor: (session: SessionInfo) => WorkspaceFiles;
  sandbox?: SandboxExecutor;
  registry?: AgentRegistry;
  loadWorkspaceAgents?: (session: SessionInfo) => Promise<import("../core/agent/registry.js").AgentInfo[]>;
  /** Host-injected tools (desktop fs/shell, MCP server tools…). Read at every
   *  run, so mutating the array between prompts takes effect on the next run. */
  localTools?: import("../core/tools/def.js").AnyToolDef[];
  /** 生命周期钩子（P0）：observe/block，见 core/runtime/lifecycle.ts。 */
  hooks?: import("../core/runtime/lifecycle.js").LifecycleHook[];
  subagentDepth?: number;
  /** 子代理协调器（T02，spec 2026-09-28 §4.1）：宿主注入执行服务
   *  （runChild/abortChild/限额，可选自定义子会话工厂）；本函数把它透传给
   *  SessionRunner 并绑定 runner 同源的运行期服务（会话级 registry 解析 +
   *  深度上限）。此前该字段不存在——宿主经条件 spread 传入会被本边界静默
   *  丢弃，agent_* 工具已注册但执行期 ctx.subagents 永不注入（F01）。 */
  subagentCoordinator?: import("../core/subagents/coordinator.js").SubagentCoordinator;
  compaction?: { enabled: boolean; contextWindow: number; summaryModel: import("@earendil-works/pi-ai").Model<import("@earendil-works/pi-ai").Api> | null };
  leaseStore?: { stamp(sessionId: string, owner: string, expiresAt: Date): Promise<void>; clear(sessionId: string): Promise<void> };
  resolveMandatorySkill?: import("../core/runtime/runner.js").MandatorySkillResolver;
  /** 以下为 RunnerDeps 尚未收敛进 preset 的字段。此前宿主（zmzai-agent）经
   *  createAgentRuntime 的 runnerOptions 条件 spread 传入时，因不在本类型上
   *  被本边界静默丢弃（同 F01 一类缺陷）——agentResolver（workspace=智能体）
   *  与 memoryContextFor（长期记忆召回）在真实运行中从未生效。显式声明并
   *  转发，回归测试见 create-agent-runtime.test.ts。 */
  sessionRuleTtlMs?: number;
  agentResolver?: import("../core/agent/resolver.js").AgentResolver;
  /** 长期记忆召回：run 开始时查询，返回文本则前插为 in-memory user 消息。 */
  memoryContextFor?: (session: SessionInfo, text: string) => Promise<string | undefined>;
  /** 附件正文读取器（规格 2 §9.2）。 */
  attachments?: import("../core/runtime/attachments.js").AttachmentProvider;
  /** 持续任务执行的保护阈值（规格 3 §10.1）。 */
  taskPolicy?: NonNullable<import("../core/runtime/runner.js").RunnerDeps["taskPolicy"]>;
  buildToolContext?: import("../core/runtime/runner.js").RunnerDeps["buildToolContext"];
  /** 直接注入的顶层工具集（一般走 localTools / agentResolver.tools）。 */
  tools?: import("../core/tools/def.js").AnyToolDef[];
};

export type AgentFramework = {
  runner: SessionRunner;
  store: SessionStore;
  eventLog: EventLog;
  registry: AgentRegistry;
  /** Creates a session bound to a workspace + user, optionally with an initial
   *  prompt that starts running immediately. */
  createSession(input: { id?: string; userId: string; workspaceId: string; agent?: string; model: ModelRef; prompt?: string; parentId?: string; title?: string; creationRequestId?: string; creationPayloadHash?: string }): Promise<SessionInfo>;
  /** One-shot 补全原语（spec §13.2 async title generation 等）：宿主侧的
   *  非会话型 LLM 调用（标题生成等）复用主聊天链路的 provider——
   *  端点/鉴权/降级逻辑与聊天完全一致，无需另行接线。 */
  modelFor(ref: ModelRef): ReturnType<ModelProvider["getModel"]>;
  streamFor(session: SessionInfo): ReturnType<ModelProvider["streamFor"]>;
};

export function createServer(deps: FrameworkDeps): AgentFramework {
  const registry = deps.registry ?? new AgentRegistry();
  const runner = new SessionRunner({
    store: deps.store,
    registry,
    streamFnFor: (session) => deps.modelProvider.streamFor(session),
    modelFor: (ref) => deps.modelProvider.getModel(ref),
    eventLog: deps.eventLog,
    workspaceFor: deps.workspaceFor,
    sandbox: deps.sandbox ?? noopSandboxExecutor(),
    ...(deps.loadWorkspaceAgents ? { loadWorkspaceAgents: deps.loadWorkspaceAgents } : {}),
    ...(deps.localTools ? { localTools: deps.localTools } : {}),
    ...(deps.hooks ? { hooks: deps.hooks } : {}),
    subagentDepth: deps.subagentDepth ?? 1,
    ...(deps.compaction ? { compaction: deps.compaction } : {}),
    ...(deps.leaseStore ? { leaseStore: deps.leaseStore } : {}),
    ...(deps.resolveMandatorySkill ? { resolveMandatorySkill: deps.resolveMandatorySkill } : {}),
    ...(deps.subagentCoordinator ? { subagentCoordinator: deps.subagentCoordinator } : {}),
    ...(deps.sessionRuleTtlMs !== undefined ? { sessionRuleTtlMs: deps.sessionRuleTtlMs } : {}),
    ...(deps.agentResolver ? { agentResolver: deps.agentResolver } : {}),
    ...(deps.memoryContextFor ? { memoryContextFor: deps.memoryContextFor } : {}),
    ...(deps.attachments ? { attachments: deps.attachments } : {}),
    ...(deps.taskPolicy ? { taskPolicy: deps.taskPolicy } : {}),
    ...(deps.buildToolContext ? { buildToolContext: deps.buildToolContext } : {}),
    ...(deps.tools ? { tools: deps.tools } : {}),
  });
  // T02：绑定 runner 同源的运行期服务——协调器的类型检查/默认子会话工厂解析
  // 到与 runner 相同的 registry（含 workspace 自定义 Agent），深度上限同源。
  if (deps.subagentCoordinator) {
    deps.subagentCoordinator.bindRuntimeServices({
      registryFor: (session) => runner.registryFor(session),
      subagentDepth: deps.subagentDepth ?? 1,
    });
  }

  return {
    runner,
    store: deps.store,
    eventLog: deps.eventLog,
    registry,
    modelFor: (ref) => deps.modelProvider.getModel(ref),
    streamFor: (session) => deps.modelProvider.streamFor(session),
    async createSession(input) {
      return createFrameworkSession({ store: deps.store, ...input });
    },
  };
}

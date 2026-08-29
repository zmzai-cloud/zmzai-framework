import { createFsWorkspaceFiles } from "../adapters/fs-workspace.js";
import { noopSandboxExecutor, type ModelProvider, type SandboxExecutor } from "../adapters/index.js";
import { createSubprocessSandbox } from "../adapters/subprocess-sandbox.js";
import type { EventLog } from "../core/events/bus.js";
import { createMemoryEventLog } from "../core/events/bus.js";
import type { WorkspaceFiles } from "../core/tools/context.js";
import type { AnyToolDef } from "../core/tools/def.js";
import { createRepoMapTool } from "../core/tools/repomap.js";
import type { RunnerDeps } from "../core/runtime/runner.js";
import type { SessionInfo } from "../core/session/types.js";
import type { SessionStore } from "../core/session/store.js";
import { createServer, type AgentFramework } from "./create-server.js";

/**
 * createAgentRuntime (spec D2 装配收敛)：createServer 之上的高层工厂。
 *
 * createServer 要求消费方自行装配全部后端与工具；两端（zmzai-agent /
 * zmzai-harness）因此各自维护一份手工接线，每加一个框架能力都要两处重复。
 * preset 把「声明差异」与「能力接线」分离：
 *
 *  - 消费方只声明后端差异：workspace（fs 目录 vs 自定义）、sandbox（子进程
 *    vs 注入执行器）、modelProvider / store；
 *  - 能力（repo_map、subagent 等）以 capabilities 声明开关，工厂统一接线——
 *    两端升级 framework 依赖即获得新能力，不再手工复制工具注册。
 *
 * 未收敛的 RunnerDeps 字段（agentResolver / memoryContextFor / leaseStore /
 * compaction …）经 runnerOptions 透传，渐进迁移：新能力走 preset，旧装配
 * 逐步替换，不做一次性大迁移。
 */

export type AgentRuntimeWorkspace =
  | { kind: "fs"; root: string | (() => string) }
  | { kind: "custom"; workspaceFor: (session: SessionInfo) => WorkspaceFiles };

export type AgentRuntimeSandbox =
  | { kind: "subprocess"; workspaceRoot?: string | (() => string) }
  | SandboxExecutor;

export type AgentRuntimeCapabilities = {
  /** Repo Map（R1，Aider 式项目地图）：fs 工作区默认开启；false 关闭；
   *  对象形式显式开启（custom 工作区如 Mongo 虚拟 fs 也可指定索引根）。 */
  repoMap?: { workspaceRoot?: string | (() => string) } | false;
  /** 子代理嵌套深度（R3，spec §6.4）：默认 1；false 关闭。 */
  subagents?: number | false;
};

export type AgentRuntimePreset = {
  store: SessionStore;
  /** 模型 provider 装配（getModel + streamFor）。与 runnerOptions 的
   *  streamFnFor/modelFor 双函数二选一：两者都省略则装配失败。 */
  modelProvider?: ModelProvider;
  eventLog?: EventLog;
  workspace: AgentRuntimeWorkspace;
  sandbox?: AgentRuntimeSandbox;
  /** host 工具（terminal/git/MCP server 工具…）。能力工具（repo_map 等）
   *  prepended 到它前面；数组按引用合并——消费方对传入数组就地重置
   *  （如 harness 的 MCP 注入）仍然生效。 */
  localTools?: AnyToolDef[];
  /** 能力开关：默认 repoMap（fs 工作区）+ subagents depth 1。 */
  capabilities?: AgentRuntimeCapabilities;
  /** 透传 RunnerDeps 其余字段（streamFnFor / modelFor / agentResolver /
   *  memoryContextFor / hooks / leaseStore / compaction /
   *  loadWorkspaceAgents / sessionRuleTtlMs…），是渐进迁移的兜底出口。
   *  streamFnFor/modelFor 传入时覆盖 modelProvider 派生（适配旧式双函数装配）。 */
  runnerOptions?: Partial<Omit<RunnerDeps, "store" | "registry" | "eventLog" | "workspaceFor" | "sandbox" | "localTools" | "subagentDepth" | "tools">>;
};

/** createAgentRuntime 的返回：与 createServer 相同的框架门面。 */
export type AgentRuntime = AgentFramework;

function asFactory(value: string | (() => string)): () => string {
  return typeof value === "function" ? value : () => value;
}

export function createAgentRuntime(preset: AgentRuntimePreset): AgentFramework {
  const caps = preset.capabilities ?? {};

  // workspace：fs 目录一键接入（builtin read/write/glob/grep 与 repomap 共享根）
  const workspaceSpec = preset.workspace;
  const workspaceFor: (session: SessionInfo) => WorkspaceFiles =
    workspaceSpec.kind === "fs"
      ? () => createFsWorkspaceFiles({ root: asFactory(workspaceSpec.root)() })
      : workspaceSpec.workspaceFor;

  // sandbox：子进程参考实现（本机模式）或注入执行器（云端模式）
  let sandbox: SandboxExecutor = noopSandboxExecutor();
  const sandboxSpec = preset.sandbox;
  if (sandboxSpec) {
    if ("kind" in sandboxSpec && sandboxSpec.kind === "subprocess") {
      const { workspaceRoot } = sandboxSpec;
      sandbox = createSubprocessSandbox(workspaceRoot !== undefined ? { workspaceRoot: asFactory(workspaceRoot) } : {});
    } else {
      sandbox = sandboxSpec as SandboxExecutor;
    }
  }

  // 能力工具（repo_map）：默认随 fs 工作区开启；false 关闭；对象形式显式指定索引根
  const capabilityTools: AnyToolDef[] = [];
  const repoMap = caps.repoMap;
  let repoMapRoot: string | (() => string) | undefined;
  if (repoMap === false) {
    repoMapRoot = undefined;
  } else if (repoMap != null) {
    repoMapRoot = repoMap.workspaceRoot ?? (preset.workspace.kind === "fs" ? preset.workspace.root : undefined);
  } else if (preset.workspace.kind === "fs") {
    repoMapRoot = preset.workspace.root;
  }
  if (repoMapRoot !== undefined) {
    capabilityTools.push(createRepoMapTool({ workspaceRoot: asFactory(repoMapRoot) }));
  }

  const subagentDepth = caps.subagents === false ? 0 : (caps.subagents ?? 1);

  // 模型装配：runnerOptions 双函数优先（旧式 relay 装配），否则 modelProvider
  const modelFor = preset.runnerOptions?.modelFor;
  const streamFnFor = preset.runnerOptions?.streamFnFor;
  if (!preset.modelProvider && (!modelFor || !streamFnFor)) {
    throw new Error("createAgentRuntime: modelProvider 与 runnerOptions.streamFnFor/modelFor 至少提供其一");
  }
  const modelProvider: ModelProvider = preset.modelProvider ?? {
    getModel: (ref) => modelFor!(ref),
    streamFor: (session) => streamFnFor!(session),
  };

  return createServer({
    store: preset.store,
    eventLog: preset.eventLog ?? createMemoryEventLog(),
    modelProvider,
    workspaceFor,
    sandbox,
    localTools: [...capabilityTools, ...(preset.localTools ?? [])],
    subagentDepth,
    ...preset.runnerOptions,
  });
}

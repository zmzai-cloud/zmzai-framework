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
  subagentDepth?: number;
  compaction?: { enabled: boolean; contextWindow: number; summaryModel: import("@earendil-works/pi-ai").Model<import("@earendil-works/pi-ai").Api> | null };
  leaseStore?: { stamp(sessionId: string, owner: string, expiresAt: Date): Promise<void>; clear(sessionId: string): Promise<void> };
};

export type AgentFramework = {
  runner: SessionRunner;
  store: SessionStore;
  eventLog: EventLog;
  registry: AgentRegistry;
  /** Creates a session bound to a workspace + user, optionally with an initial
   *  prompt that starts running immediately. */
  createSession(input: { userId: string; workspaceId: string; agent?: string; model: ModelRef; prompt?: string; parentId?: string; title?: string }): Promise<SessionInfo>;
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
    subagentDepth: deps.subagentDepth ?? 1,
    ...(deps.compaction ? { compaction: deps.compaction } : {}),
    ...(deps.leaseStore ? { leaseStore: deps.leaseStore } : {}),
  });

  return {
    runner,
    store: deps.store,
    eventLog: deps.eventLog,
    registry,
    async createSession(input) {
      return createFrameworkSession({ store: deps.store, ...input });
    },
  };
}

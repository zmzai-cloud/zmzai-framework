/** @zmzai/agent-framework — PI-based agent framework (OpenCode-style).
 *  Storage/backend-agnostic: sessions, permissions, tools, runner, events.
 *  Assemble with createServer() (or wire SessionRunner directly). */

// core: session
export type { MessageInfo, MessageWithParts, Part, QueuedPrompt, SessionInfo, SessionStatus, ModelRef, ToolState } from "./core/session/types.js";
export type { SessionStore } from "./core/session/store.js";
export { newSessionId, newMessageId, newPartId, newPermissionRequestId, newEventId } from "./core/session/ids.js";
export { createJsonlSessionStore } from "./core/session/jsonl-store.js";

// core: events
export type { FrameworkEvent, FrameworkEventType, PersistedFrameworkEvent, TodoItem } from "./core/events/manifest.js";
export { frameworkEventSchemas, parseFrameworkEvent } from "./core/events/manifest.js";
export type { EventLog, SubscribeOptions } from "./core/events/bus.js";
export { createMemoryEventLog, subscribeEventLog, notifyEventLogListeners } from "./core/events/bus.js";

// core: permission
export type { Action, Rule, Ruleset, PermissionConfig } from "./core/permission/ruleset.js";
export { rulesetFromConfig, evaluateRules, wildcardMatch, PERMISSIONS } from "./core/permission/ruleset.js";
export type { Reply, PermissionRequest } from "./core/permission/engine.js";
export { PermissionEngine, RejectedError } from "./core/permission/engine.js";

// core: agent
export type { AgentInfo, AgentDefinition } from "./core/agent/registry.js";
export { AgentRegistry, builtinAgents, builtinDefaults } from "./core/agent/registry.js";
export { loadCustomAgents } from "./core/agent/loader.js";
export type { AgentResolver, ResolvedAgent } from "./core/agent/resolver.js";
export { parseAgentPlugin, parsePluginManifest, parsePluginMcp } from "./core/agent/plugin.js";
export type { ParsedAgentPlugin, PluginFileSystem, PluginManifest, PluginMcpServer, PluginSkill } from "./core/agent/plugin.js";

// core: mcp
export { McpStdioClient } from "./core/mcp/client.js";
export type { McpToolInfo, McpCallResult, StdioServerSpec, McpClientOptions } from "./core/mcp/client.js";
export { startMcpServers } from "./core/mcp/servers.js";
export type { McpServerEntry, McpServerStatus, McpPoolResult } from "./core/mcp/servers.js";

// core: tools
export type { ToolDef, ExternalToolDef, AnyToolDef } from "./core/tools/def.js";
export { isExternalToolDef } from "./core/tools/def.js";
export type { ToolContext, WorkspaceFiles, SandboxSnapshot, SandboxExecResult, SandboxExecInput } from "./core/tools/context.js";
export { adaptTool, adaptExternalTool, adaptAnyTool, permissionForCall } from "./core/tools/adapter.js";
export { builtinTools, readTool, globTool, grepTool, writeTool, editTool, todoTool, bashTool } from "./core/tools/builtins.js";
export { taskTool } from "./core/tools/task.js";

// core: runtime
export { SessionRunner, createFrameworkSession, isSessionActive, type RunnerDeps } from "./core/runtime/runner.js";
export { PartProjector, serializeEmit } from "./core/runtime/pi-bridge.js";
export { buildCompactionTransform, createCompactionTransform, streamOneText } from "./core/runtime/compaction.js";
export { startLeaseRecovery, reclaimExpiredLeases, finalizeInterruptedRun, type LeaseRecoveryStore } from "./core/runtime/lease-recovery.js";

// adapters
export type { ModelProvider, SandboxExecutor, LeaseStore } from "./adapters/index.js";
export { noopSandboxExecutor, leaseDurationMs } from "./adapters/index.js";
export { qaCheckResultSchema, qaCheckTool, type QaCheckResult } from "./core/tools/qa-check.js";
export { webfetchTool } from "./core/tools/webfetch.js";
export { createFsWorkspaceFiles } from "./adapters/fs-workspace.js";
export { createOpenAiModelProvider } from "./adapters/openai-provider.js";
export { createSubprocessSandbox } from "./adapters/subprocess-sandbox.js";

// server
export { createServer, type FrameworkDeps, type AgentFramework } from "./server/create-server.js";

/** @zmzai/agent-framework — PI-based agent framework (OpenCode-style).
 *  Storage/backend-agnostic: sessions, permissions, tools, runner, events.
 *  Assemble with createServer() (or wire SessionRunner directly). */

// core: session
export type { MessageInfo, MessageWithParts, Part, QueuedPrompt, SessionInfo, SessionStatus, ModelRef, ToolState, ThinkingEffort } from "./core/session/types.js";
export type { SessionStore } from "./core/session/store.js";
export { newSessionId, newMessageId, newPartId, newPermissionRequestId, newEventId } from "./core/session/ids.js";
export { createJsonlSessionStore } from "./core/session/jsonl-store.js";
export { createSqliteSessionStore } from "./core/session/sqlite-store.js";

// core: events
export type { FrameworkEvent, FrameworkEventType, PersistedFrameworkEvent, TodoItem } from "./core/events/manifest.js";
export { frameworkEventSchemas, parseFrameworkEvent } from "./core/events/manifest.js";
export type { EventLog, SubscribeOptions } from "./core/events/bus.js";
export { createMemoryEventLog, subscribeEventLog, notifyEventLogListeners } from "./core/events/bus.js";

// core: permission
export type { Action, Rule, Ruleset, PermissionConfig } from "./core/permission/ruleset.js";
export { rulesetFromConfig, evaluateRules, wildcardMatch, PERMISSIONS } from "./core/permission/ruleset.js";
export { pathInWritePaths, writePathGuardRules, confineWorkspaceFiles } from "./core/permission/write-path.js";
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
export type { McpServerEntry, McpServerStatus, McpPoolResult, McpPoolOptions } from "./core/mcp/servers.js";
export { McpStreamableHttpClient, McpSseClient, createMcpHttpClient, createSseParser } from "./core/mcp/http-client.js";
export type { McpClientLike } from "./core/mcp/http-client.js";

// core: tools
export type { ToolDef, ExternalToolDef, AnyToolDef } from "./core/tools/def.js";
export { isExternalToolDef } from "./core/tools/def.js";
export type { ToolContext, WorkspaceFiles, SandboxSnapshot, SandboxExecResult, SandboxExecInput } from "./core/tools/context.js";
export { adaptTool, adaptExternalTool, adaptAnyTool, permissionForCall } from "./core/tools/adapter.js";
export { pruneFailureLog, trimFailureOutput, type FailureTrimResult } from "./core/tools/trim.js";
export { builtinTools, readTool, globTool, grepTool, writeTool, editTool, todoTool, bashTool } from "./core/tools/builtins.js";
export { taskTool } from "./core/tools/task.js";
export { createGitTools } from "./core/tools/git.js";
export type { GitToolsOptions } from "./core/tools/git.js";
export { TerminalManager, createTerminalTools } from "./core/tools/terminal.js";
export type { TerminalBackend, TerminalHandle, TerminalSessionInfo, TerminalSessionStatus } from "./core/tools/terminal.js";
export { createHostTerminalBackend } from "./adapters/terminal-backend.js";
export { createRepoMapTool } from "./core/tools/repomap.js";
export { renderRepoMap, resolveFrameworkVendorDirs, setWasmDirs, type RepoMapOptions, type RepoMapResult } from "./core/repomap/repomap.js";

// core: runtime
export { SessionRunner, createFrameworkSession, isSessionActive, type RunnerDeps, type PromptInput } from "./core/runtime/runner.js";
export type { LifecycleHook } from "./core/runtime/lifecycle.js";
export { extractRunTranscript, RETRY_PLACEHOLDER_TEXT, type RunTranscriptMessage } from "./core/runtime/run-transcript.js";
export { PartProjector, serializeEmit } from "./core/runtime/pi-bridge.js";
export { buildCompactionTransform, createCompactionTransform, streamOneText } from "./core/runtime/compaction.js";
export { startLeaseRecovery, reclaimExpiredLeases, finalizeInterruptedRun, type LeaseRecoveryStore } from "./core/runtime/lease-recovery.js";

// adapters
export type { ModelProvider, SandboxExecutor, LeaseStore } from "./adapters/index.js";
export { noopSandboxExecutor, leaseDurationMs } from "./adapters/index.js";
export { qaCheckResultSchema, qaCheckTool, type QaCheckResult } from "./core/tools/qa-check.js";
export { webfetchTool } from "./core/tools/webfetch.js";
export { createWebSearchTool, parseDuckDuckGoHtml } from "./core/tools/websearch.js";
export type { WebSearchOptions, WebSearchResult } from "./core/tools/websearch.js";
export { applyPatchTool, parseUnifiedPatch, applyFilePatch } from "./core/tools/patch.js";
export type { FilePatch, PatchParseResult, ApplyPatchReportEntry } from "./core/tools/patch.js";
export { createFsWorkspaceFiles } from "./adapters/fs-workspace.js";
export { createOpenAiModelProvider, type ProviderHeaders, type FailoverEndpoint, type FailoverEvent } from "./adapters/openai-provider.js";
export { createSubprocessSandbox } from "./adapters/subprocess-sandbox.js";

// server
export { createServer, type FrameworkDeps, type AgentFramework } from "./server/create-server.js";
export { createAgentRuntime, type AgentRuntimePreset, type AgentRuntime, type AgentRuntimeWorkspace, type AgentRuntimeSandbox, type AgentRuntimeCapabilities } from "./server/create-agent-runtime.js";

import type { PermissionEngine } from "../permission/engine.js";

/** Snapshot of a workspace handed to the sandbox: committed files + revision.
 *  Kept framework-local (was lib/sandbox-types) so the package owns its types. */
export type SandboxSnapshot = {
  revisionId: string | null;
  files: Array<{ path: string; content: string }>;
};

/** Workspace facade: the single seam between framework tools and the file
 *  backend. Products implement this (Mongo) or use the package's FS/JSONL
 *  reference implementation. */
export interface WorkspaceFiles {
  list(): Promise<{ path: string; bytes: number }[]>;
  read(path: string): Promise<{ path: string; content: string } | null>;
  /** Direct write with revision + diff. Returns null when the path is
   *  rejected by workspace path validation. */
  write(input: { path: string; content: string; author: "agent"; summary: string }): Promise<{ revisionId: string; diff: string } | null>;
  /** Direct edit (exact oldText → newText, unique occurrence). */
  edit(input: { path: string; oldText: string; newText: string; author: "agent"; summary: string }): Promise<{ revisionId: string; diff: string } | { error: string }>;
}

export type SandboxExecResult = {
  ok: boolean;
  exitCode: number | null;
  outputText: string;
  durationMs: number;
  artifacts: { path: string; bytes: number; contentType: string; downloadUrl: string; previewUrl?: string }[];
};

export type SandboxExecInput = {
  toolCallId: string;
  command: { program: string; args: string[]; cwd?: string; env?: Record<string, string> };
  snapshot: SandboxSnapshot;
  /** Streams raw sandbox output back (runner forwards it as tool metadata). */
  onOutput?: (chunk: string) => void;
};

export interface ToolContext {
  sessionId: string;
  userId: string;
  workspaceId: string;
  agent: string;
  abort: AbortSignal;
  /** Permission escalation from inside a tool (rare; prefer the declarative
   *  `permission` field on ToolDef, which the runner evaluates first). */
  ask: PermissionEngine["ask"];
  workspace: WorkspaceFiles;
  buildSnapshot(): Promise<SandboxSnapshot>;
  runSandbox(input: SandboxExecInput): Promise<SandboxExecResult>;
  /** Updates the live todo projection; emits todo.updated. */
  setTodos(todos: { content: string; status: "pending" | "in_progress" | "completed" | "cancelled"; priority?: "high" | "medium" | "low" }[]): Promise<void>;
  /** Emits file.edited after a direct write/edit lands. */
  emitFileEdited(input: { path: string; revisionId: string; diff: string }): Promise<void>;
  /** Emits artifact.created for every sandbox deliverable. */
  emitArtifact(input: { artifactId: string; path: string; bytes: number; contentType: string; downloadUrl: string; previewUrl?: string }): Promise<void>;
  /** Spawns a subagent as a child session (spec §6.4), wired by the runner.
   *  Absent in contexts that can't nest (e.g. the JSONL demo without a
   *  subagent-capable runner). */
  spawnSubagent?: (input: { description: string; prompt: string; subagentType: string }) => Promise<{ childSessionId: string; summary: string; state: "completed" | "error" }>;
  /** Records a subtask part on the parent transcript (childSessionId link). */
  emitSubtask?: (input: { prompt: string; description: string; agent: string; childSessionId: string }) => Promise<void>;
}

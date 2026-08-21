import type { Api, Model } from "@earendil-works/pi-ai";
import type { StreamFn } from "@earendil-works/pi-agent-core";
import type { ModelRef, SessionInfo } from "../core/session/types.js";
import type { SandboxSnapshot, SandboxExecResult, SandboxExecInput } from "../core/tools/context.js";

/** ModelProvider (M5 spec §5): the package's seam to the outside model
 *  runtime. Products bind relay/OpenAI/etc.; the CLI binds an OpenAI-compatible
 *  provider. The framework only ever talks to PI through these two methods. */
export interface ModelProvider {
  /** Resolves a model reference to a PI Model (used for the main loop). */
  getModel(ref: ModelRef): Model<Api>;
  /** Builds the PI streamFn for a run (per-session billing identity). */
  streamFor(session: SessionInfo): StreamFn;
}

/** SandboxExecutor (M5 spec §5): isolated command execution + snapshot
 *  building. The package ships a subprocess reference implementation (no
 *  isolation, demo-only); products provide the OpenSandbox-backed one. */
export interface SandboxExecutor {
  /** Builds the workspace snapshot handed to the sandbox. */
  buildSnapshot(input: { userId: string; workspaceId: string; runId: string }): Promise<SandboxSnapshot>;
  /** Runs one command in the sandbox and returns the result. */
  run(input: SandboxExecInput & { userId: string; workspaceId: string; runId: string }): Promise<SandboxExecResult>;
}

/** No-op sandbox: the framework still works for read/write/todo/subagent
 *  flows without any execution backend; bash tool errors out clearly. */
export function noopSandboxExecutor(reason = "未配置沙箱执行器"): SandboxExecutor {
  return {
    async buildSnapshot() {
      return { revisionId: null, files: [] };
    },
    async run() {
      return { ok: false, outcome: "failed", exitCode: 1, outputText: "", durationMs: 0, artifacts: [], errorMessage: reason };
    },
  };
}

/** LeaseStore (M5): the runner stamps a lease on the session doc while it owns
 *  a run. Products implement over Mongo; the package's JSONL store implements
 *  over files. Recovery scans expired leases via the same interface. */
export interface LeaseStore {
  stampLease(sessionId: string, owner: string, expiresAt: Date): Promise<void>;
  clearLease(sessionId: string): Promise<void>;
  listExpiredLeases(): Promise<{ sessionId: string }[]>;
  clearLeaseIfExpired(sessionId: string): Promise<boolean>;
}

export const leaseDurationMs = 10 * 60 * 1000;

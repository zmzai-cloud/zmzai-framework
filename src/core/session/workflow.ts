import { createHash } from "node:crypto";
import type { MessageInfo, Part } from "./types.js";
import type { PromptInput } from "../runtime/runner.js";
import type { PersistedFrameworkEvent } from "../events/manifest.js";

export type PromptReceipt = { ok: true; queued: boolean; requestId: string; runId: string; userMessageId: string; disposition: "started" | "queued" };
export type WorkflowState = "queued" | "running" | "completed" | "failed" | "cancelled" | "recovery_required";
export type WorkflowRun = { receipt: PromptReceipt; input: PromptInput; status: WorkflowState; revision: number };
export type AcceptedPrompt = { receipt: PromptReceipt; events: PersistedFrameworkEvent[] };
export interface WorkflowStore {
  acceptPrompt(sessionId: string, input: PromptInput, events: { message: MessageInfo; parts: Part[] }): Promise<AcceptedPrompt>;
  claimPrompt(sessionId: string, owner: string): Promise<WorkflowRun | null>;
  finishPrompt(sessionId: string, runId: string, revision: number, state: WorkflowState): Promise<void>;
  recoverInterrupted(sessionId: string): Promise<void>;
  workflowRuns(sessionId: string): Promise<WorkflowRun[]>;
  findPrompt(sessionId: string, requestId: string): Promise<WorkflowRun | null>;
}

export function promptHash(payload: unknown): string {
  function canonical(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(canonical);
    if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, canonical(item)]));
    return value;
  }
  return createHash("sha256").update(JSON.stringify(canonical(payload))).digest("hex");
}

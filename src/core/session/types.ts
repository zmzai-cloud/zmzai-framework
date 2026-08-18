import type { Ruleset } from "../permission/ruleset.js";

/** v0 wire format (spec §2). These types are the framework's public contract:
 *  every client (web workbench, future TUI, SDK) renders from them. */

export type ModelRef = { providerId: string; modelId: string };

export type QueuedPrompt = { text: string; agent?: string; enqueuedAt: string };

export type SessionInfo = {
  id: string; // ses_...
  workspaceId: string; // §13.1: bound at creation, immutable
  userId: string;
  parentId?: string; // child session spawned by the task tool
  title: string; // prompt truncation initially; replaced async by cheap-model title (§13.2)
  agent: string; // current primary agent preset name
  /** Product control plane identity. Absent on M1-M5 sessions created before
   *  versioned agents; new cloud sessions should pin both fields. */
  agentId?: string;
  agentVersionId?: string;
  model: ModelRef;
  permission: Ruleset; // session-scoped rules ("always" replies land here)
  queuedPrompts: QueuedPrompt[]; // FIFO for prompts submitted while running (§13.3)
  time: { created: string; updated: string; archived?: string };
};

export type MessageInfo =
  | {
      id: string; // msg_...
      sessionId: string;
      role: "user";
      agent: string;
      model: ModelRef;
      time: { created: string };
    }
  | {
      id: string;
      sessionId: string;
      role: "assistant";
      parentId: string; // the user message that triggered it
      agent: string;
      model: ModelRef;
      error?: { name: string; message: string };
      tokens?: { input: number; output: number; cacheRead?: number; cacheWrite?: number };
      time: { created: string; completed?: string };
    };

export type ToolState =
  | { status: "pending"; input: unknown }
  | { status: "running"; input: unknown; title?: string; time: { start: string } }
  | {
      status: "completed";
      input: unknown;
      output: string;
      title: string;
      metadata?: Record<string, unknown>;
      time: { start: string; end: string };
    }
  | { status: "error"; input: unknown; error: string; time: { start: string; end: string } };

type PartBase = { id: string; sessionId: string; messageId: string };

export type Part = PartBase &
  (
    | { type: "text"; text: string; synthetic?: boolean }
    | { type: "reasoning"; text: string }
    | { type: "tool"; callId: string; tool: string; state: ToolState }
    | { type: "step-start" }
    | { type: "step-finish"; tokens?: { input: number; output: number; cacheRead?: number; cacheWrite?: number } }
    | { type: "subtask"; prompt: string; description: string; agent: string; childSessionId: string }
    | { type: "file"; mime: string; filename: string; url: string }
    | { type: "compaction"; summary: string }
  );

export type MessageWithParts = { info: MessageInfo; parts: Part[] };

export type SessionStatus = "idle" | "running" | "waiting_permission";

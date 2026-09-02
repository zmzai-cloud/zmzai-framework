import type { AgentMessage } from "@earendil-works/pi-agent-core";

import type { FrameworkEvent } from "../events/manifest.js";
import { newMessageId, newPartId } from "../session/ids.js";
import type { MessageInfo, ModelRef, Part, SelectedSkill, ToolState } from "../session/types.js";

/** Part-projector (spec §8.2): folds PI agent events into the persisted
 *  Message/Part graph and the framework events to publish. Pure and sync —
 *  the runner feeds PI events one by one and drains the output queue. */

export type BridgeIdentity = { sessionId: string; agent: string; model: ModelRef };

type Emit = (event: FrameworkEvent) => void;

type TextTrack = { partId: string; buffer: string };

/** The part variants a projector can create, minus the base fields it fills in. */
type ProjectablePart =
  | { type: "text"; text: string; synthetic?: boolean }
  | { type: "reasoning"; text: string }
  | { type: "tool"; callId: string; tool: string; state: ToolState }
  | { type: "step-start" }
  | { type: "step-finish"; tokens?: { input: number; output: number; cacheRead?: number; cacheWrite?: number } };

/** Serializes the emitted events through an async sink while preserving order:
 *  handler calls stay sync, persistence/publish fan-out happens in a chained
 *  promise so PI's awaited subscribers never observe reordering. */
export function serializeEmit(sink: (event: FrameworkEvent) => Promise<void>): { emit: Emit; settled: () => Promise<void> } {
  let chain: Promise<void> = Promise.resolve();
  return {
    emit: (event) => {
      chain = chain.then(() => sink(event));
    },
    settled: () => chain,
  };
}

export class PartProjector {
  private userMessageId: string | null = null;
  private assistantMessageId: string | null = null;
  private readonly parts = new Map<string, Part>();
  private readonly textByContent = new Map<number, TextTrack>(); // contentIndex → text part
  private readonly reasoningByContent = new Map<number, TextTrack>();
  private readonly toolPartByCallId = new Map<string, string>(); // toolCallId → partId
  private stepOpen = false;
  private stepCounter = 0;
  /** Tools belong to the assistant message that requested them. PI emits
   *  message_end(assistant) before that turn's tool executions, so the tool
   *  parts anchor here instead of the (already cleared) current message. */
  private toolAnchorMessageId: string | null = null;

  /** Exposed for the runner's permission hook (permission requests carry the
   *  originating message id). */
  get currentAssistantMessageId(): string | null {
    return this.assistantMessageId ?? this.toolAnchorMessageId;
  }

  constructor(private readonly identity: BridgeIdentity) {}

  private emitPart(emit: Emit, part: Part): void {
    this.parts.set(part.id, part);
    emit({ type: "message.part.updated", data: { part } });
  }

  private patchPart(emit: Emit, partId: string, patch: (part: Part) => Part): void {
    const current = this.parts.get(partId);
    if (!current) return;
    this.emitPart(emit, patch(current));
  }

  private flushText(emit: Emit, track: TextTrack | undefined, kind: "text" | "reasoning"): void {
    if (!track || !track.buffer) return;
    const delta = track.buffer;
    track.buffer = "";
    emit({ type: "message.part.delta", data: { messageId: this.assistantMessageId ?? "", partId: track.partId, field: "text", delta } });
    this.patchPart(emit, track.partId, (part) => (part.type === kind ? { ...part, text: part.text + delta } : part));
  }

  private flushAllText(emit: Emit): void {
    for (const track of this.textByContent.values()) this.flushText(emit, track, "text");
    for (const track of this.reasoningByContent.values()) this.flushText(emit, track, "reasoning");
  }

  private assistantPart(emit: Emit, extra: ProjectablePart, messageIdOverride?: string): Part {
    const part = {
      id: newPartId(),
      sessionId: this.identity.sessionId,
      messageId: messageIdOverride ?? this.assistantMessageId ?? "",
      ...extra,
    } as Part;
    this.emitPart(emit, part);
    return part;
  }

  // ---- PI event handlers (called by handleAgentEvent) ----

  onUserPrompt(emit: Emit, text: string, images?: readonly { url: string; mediaType: string }[], skill?: SelectedSkill): MessageInfo {
    const message: MessageInfo = {
      id: newMessageId(),
      sessionId: this.identity.sessionId,
      role: "user",
      agent: this.identity.agent,
      model: this.identity.model,
      ...(skill ? { skill } : {}),
      time: { created: new Date().toISOString() },
    };
    this.userMessageId = message.id;
    emit({ type: "message.updated", data: { message } });
    const normalizedText = text.trim();
    if (normalizedText) {
      const part: Part = {
        id: newPartId(),
        sessionId: this.identity.sessionId,
        messageId: message.id,
        type: "text",
        text: normalizedText,
      };
      this.parts.set(part.id, part);
      emit({ type: "message.part.updated", data: { part } });
    }
    if (images?.length) {
      for (const image of images) {
        const part: Part = {
          id: newPartId(),
          sessionId: this.identity.sessionId,
          messageId: message.id,
          type: "image",
          url: image.url,
          mediaType: image.mediaType,
        };
        this.parts.set(part.id, part);
        emit({ type: "message.part.updated", data: { part } });
      }
    }
    return message;
  }

  onAssistantStart(emit: Emit): void {
    const message: MessageInfo = {
      id: newMessageId(),
      sessionId: this.identity.sessionId,
      role: "assistant",
      parentId: this.userMessageId ?? "",
      agent: this.identity.agent,
      model: this.identity.model,
      time: { created: new Date().toISOString() },
    };
    this.assistantMessageId = message.id;
    this.toolAnchorMessageId = message.id;
    this.toolPartByCallId.clear(); // new assistant message = new tool batch
    emit({ type: "message.updated", data: { message } });
    if (!this.stepOpen) {
      this.stepOpen = true;
      this.stepCounter += 1;
      this.assistantPart(emit, { type: "step-start" });
    }
  }

  onTextDelta(emit: Emit, contentIndex: number, delta: string): void {
    const track = this.textByContent.get(contentIndex) ?? { partId: "", buffer: "" };
    if (!track.partId) {
      const part = this.assistantPart(emit, { type: "text", text: "" });
      track.partId = part.id;
    }
    track.buffer += delta;
    this.textByContent.set(contentIndex, track);
    if (Buffer.byteLength(track.buffer, "utf8") >= 2 * 1024) this.flushText(emit, track, "text");
  }

  onThinkingDelta(emit: Emit, contentIndex: number, delta: string): void {
    const track = this.reasoningByContent.get(contentIndex) ?? { partId: "", buffer: "" };
    if (!track.partId) {
      const part = this.assistantPart(emit, { type: "reasoning", text: "" });
      track.partId = part.id;
    }
    track.buffer += delta;
    this.reasoningByContent.set(contentIndex, track);
    if (Buffer.byteLength(track.buffer, "utf8") >= 2 * 1024) this.flushText(emit, track, "reasoning");
  }

  onToolExecutionStart(emit: Emit, toolCallId: string, toolName: string, args: unknown, label?: string): void {
    this.flushAllText(emit);
    const part = this.assistantPart(
      emit,
      {
        type: "tool",
        callId: toolCallId,
        tool: toolName,
        state: { status: "running", input: args, ...(label ? { title: label } : {}), time: { start: new Date().toISOString() } },
      },
      this.toolAnchorMessageId ?? undefined,
    );
    this.toolPartByCallId.set(toolCallId, part.id);
  }

  onToolExecutionUpdate(emit: Emit, toolCallId: string, partial: unknown): void {
    const partId = this.toolPartByCallId.get(toolCallId);
    if (!partId) return;
    const title = extractTitle(partial);
    if (!title) return;
    this.patchPart(emit, partId, (part) =>
      part.type === "tool" && part.state.status === "running" ? { ...part, state: { ...part.state, title } } : part,
    );
  }

  onToolExecutionEnd(emit: Emit, toolCallId: string, result: unknown, isError: boolean): void {
    const partId = this.toolPartByCallId.get(toolCallId);
    if (!partId) return;
    const { output, title, metadata } = extractResult(result);
    this.patchPart(emit, partId, (part) => {
      if (part.type !== "tool" || part.state.status !== "running") return part;
      const unknown = metadata?.outcome === "unknown";
      const state: ToolState = unknown
        ? { status: "error", input: part.state.input, error: output, metadata: { ...(metadata ?? {}), outcome: "unknown" }, time: { start: part.state.time.start, end: new Date().toISOString() } }
        : isError
        ? { status: "error", input: part.state.input, error: output, ...(metadata ? { metadata } : {}), time: { start: part.state.time.start, end: new Date().toISOString() } }
        : {
            status: "completed",
            input: part.state.input,
            output,
            title: title ?? part.state.title ?? "完成",
            ...(metadata ? { metadata } : {}),
            time: { start: part.state.time.start, end: new Date().toISOString() },
          };
      return { ...part, state };
    });
  }

  onAssistantEnd(emit: Emit, message: AgentMessage): void {
    this.flushAllText(emit);
    if (!this.assistantMessageId) return;
    if (this.stepOpen) {
      this.stepOpen = false;
      const usage = extractUsage(message);
      this.assistantPart(emit, { type: "step-finish", ...(usage ? { tokens: usage } : {}) });
    }
    const usage = extractUsage(message);
    const error = extractError(message);
    const info: MessageInfo = {
      id: this.assistantMessageId,
      sessionId: this.identity.sessionId,
      role: "assistant",
      parentId: this.userMessageId ?? "",
      agent: this.identity.agent,
      model: this.identity.model,
      ...(usage ? { tokens: usage } : {}),
      ...(error ? { error } : {}),
      time: { created: this.parts.size ? new Date().toISOString() : new Date().toISOString(), completed: new Date().toISOString() },
    };
    emit({ type: "message.updated", data: { message: info } });
    this.assistantMessageId = null;
    this.textByContent.clear();
    this.reasoningByContent.clear();
    // toolAnchorMessageId and toolPartByCallId survive message_end: this
    // turn's tool executions arrive after it and must resolve their parts.
    // They reset when the next assistant message starts (onAssistantStart).
  }
}

function extractTitle(partial: unknown): string | null {
  if (typeof partial !== "object" || partial === null) return null;
  const details = (partial as { details?: unknown }).details;
  if (typeof details === "object" && details !== null && typeof (details as { title?: unknown }).title === "string") {
    return (details as { title: string }).title;
  }
  return null;
}

function extractResult(result: unknown): { output: string; title: string | null; metadata: Record<string, unknown> | null } {
  if (typeof result !== "object" || result === null) return { output: String(result), title: null, metadata: null };
  const record = result as { content?: unknown; details?: unknown };
  let output = "";
  if (Array.isArray(record.content)) {
    output = record.content
      .map((block) => (typeof block === "object" && block !== null && (block as { type?: unknown }).type === "text" ? String((block as { text?: unknown }).text ?? "") : ""))
      .filter(Boolean)
      .join("\n");
  }
  const details = typeof record.details === "object" && record.details !== null ? (record.details as Record<string, unknown>) : null;
  const title = details && typeof details.title === "string" ? details.title : null;
  const metadata = details ? Object.fromEntries(Object.entries(details).filter(([key]) => key !== "title")) : null;
  return { output: output || "（无输出）", title, metadata: metadata && Object.keys(metadata).length ? metadata : null };
}

function extractUsage(message: AgentMessage): { input: number; output: number; cacheRead?: number; cacheWrite?: number } | null {
  if (message.role !== "assistant") return null;
  const usage = (message as { usage?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number } }).usage;
  if (!usage) return null;
  return {
    input: usage.input ?? 0,
    output: usage.output ?? 0,
    ...(usage.cacheRead ? { cacheRead: usage.cacheRead } : {}),
    ...(usage.cacheWrite ? { cacheWrite: usage.cacheWrite } : {}),
  };
}

function extractError(message: AgentMessage): { name: string; message: string } | null {
  if (message.role !== "assistant") return null;
  const record = message as { stopReason?: string; errorMessage?: string };
  if (record.stopReason === "error" || record.stopReason === "aborted") {
    return { name: record.stopReason === "aborted" ? "AbortedError" : "APIError", message: record.errorMessage ?? "模型调用失败" };
  }
  return null;
}

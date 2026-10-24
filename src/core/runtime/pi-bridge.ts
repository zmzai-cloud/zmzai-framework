import type { AgentMessage } from "@earendil-works/pi-agent-core";

import type { FrameworkEvent } from "../events/manifest.js";
import { newMessageId, newPartId } from "../session/ids.js";
import type { MessageInfo, ModelRef, Part, SelectedSkill, ToolState } from "../session/types.js";

/** Part-projector (spec §8.2): folds PI agent events into the persisted
 *  Message/Part graph and the framework events to publish. Sync in the hot
 *  path — the runner feeds PI events one by one and drains the output queue.
 *  0.18 起带一个 80ms 补发定时器（见 scheduleFlushTimer），慢速流按时间步进；
 *  它只会在 PI 事件之间触发，边界 flush 清空 buffer 后回调自然 no-op。 */

export type BridgeIdentity = { sessionId: string; agent: string; model: ModelRef };

type Emit = (event: FrameworkEvent) => void;

type TextTrack = { partId: string; buffer: string; pendingBytes: number; lastCheckpointAt: number };

/** 流式步进阈值（0.18）：delta 攒到 64B 或首字节后 80ms 就发一批。旧值 2KB 会把
 *  一段两三百字的回复攒成「零 delta、assistant 结束一次性弹出」——中文回复永远
 *  看不到流式。64B/80ms 后事件量约 2–6 条/秒/会话，durable append 与 SSE 都在
 *  安全区内。 */
const FLUSH_MIN_BYTES = 64;
const FLUSH_MAX_WAIT_MS = 80;
/** part.updated checkpoint 阈值：delta 事件高频之后，携带全量文本的
 *  message.part.updated 若仍逐批配对，写放大随消息长度平方增长（10KB 消息 ×
 *  80 批 ≈ 数百 KB）。改为 2KB/1.5s 才落一次快照，边界（工具切换/消息结束）
 *  恒强制落——崩溃恢复的丢文本窗口最多 1.5s 的生成量。 */
const CHECKPOINT_MIN_BYTES = 2 * 1024;
const CHECKPOINT_MIN_INTERVAL_MS = 1_500;

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

  restoreUserMessage(id: string): void { this.userMessageId = id; }

  private emitPart(emit: Emit, part: Part): void {
    this.parts.set(part.id, part);
    emit({ type: "message.part.updated", data: { part } });
  }

  private patchPart(emit: Emit, partId: string, patch: (part: Part) => Part): void {
    const current = this.parts.get(partId);
    if (!current) return;
    this.emitPart(emit, patch(current));
  }

  private flushText(emit: Emit, track: TextTrack | undefined, kind: "text" | "reasoning", forceCheckpoint = false): void {
    if (!track) return;
    if (track.buffer) {
      const delta = track.buffer;
      track.buffer = "";
      track.pendingBytes += Buffer.byteLength(delta, "utf8");
      emit({ type: "message.part.delta", data: { messageId: this.assistantMessageId ?? "", partId: track.partId, field: "text", delta } });
      // 内部 parts 映射每次 flush 都推进（不对外发事件），checkpoint 时才有干净的全量可发。
      const current = this.parts.get(track.partId);
      if (current && current.type === kind) this.parts.set(track.partId, { ...current, text: current.text + delta });
    }
    // buffer 可能已被大小阈值冲掉而还没落过快照：checkpoint 看 pendingBytes，
    // 不看 buffer——边界（工具切换/消息结束）必须把已流出的文本落成全量快照。
    const now = Date.now();
    if (track.pendingBytes > 0 && (forceCheckpoint || track.pendingBytes >= CHECKPOINT_MIN_BYTES || now - track.lastCheckpointAt >= CHECKPOINT_MIN_INTERVAL_MS)) {
      const part = this.parts.get(track.partId);
      if (part) this.emitPart(emit, part);
      track.pendingBytes = 0;
      track.lastCheckpointAt = now;
    }
  }

  private flushAllText(emit: Emit, forceCheckpoint = false): void {
    for (const track of this.textByContent.values()) this.flushText(emit, track, "text", forceCheckpoint);
    for (const track of this.reasoningByContent.values()) this.flushText(emit, track, "reasoning", forceCheckpoint);
    if (this.flushTimer && !this.hasBufferedText()) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
  }

  private hasBufferedText(): boolean {
    for (const track of this.textByContent.values()) if (track.buffer) return true;
    for (const track of this.reasoningByContent.values()) if (track.buffer) return true;
    return false;
  }

  /** 到期补发（0.18）：慢速流按时间步进，否则只有攒满 64B 才动，慢模型的体验
   *  仍是「一卡一卡」。定时器在 JS 单线程里只会在 PI 事件之间触发；边界处的
   *  flushAllText 已清空 buffer，晚到的回调面对空 buffer 自然 no-op，不会与
   *  onToolExecutionStart / onAssistantEnd 交错出错序。 */
  private scheduleFlushTimer(emit: Emit): void {
    this.emitRef = emit;
    if (this.flushTimer) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      if (this.hasBufferedText() && this.emitRef) this.flushAllText(this.emitRef);
    }, FLUSH_MAX_WAIT_MS);
  }

  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private emitRef: Emit | null = null;

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

  onUserPrompt(emit: Emit, text: string, images?: readonly { url: string; mediaType: string }[], skill?: SelectedSkill, references?: readonly string[], attachments?: readonly import("./attachments.js").InputAttachment[], attachmentRefs?: readonly import("./attachments.js").InputAttachmentRef[]): MessageInfo {
    const message: MessageInfo = {
      id: newMessageId(),
      sessionId: this.identity.sessionId,
      role: "user",
      agent: this.identity.agent,
      model: this.identity.model,
      ...(skill ? { skill } : {}),
      ...(references?.length ? { references: [...references] } : {}),
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
    for (const file of attachments ?? []) {
      const part: Part = { id: newPartId(), sessionId: this.identity.sessionId, messageId: message.id, type: "file", filename: file.name, mime: file.mediaType, url: file.data };
      this.parts.set(part.id, part);
      emit({ type: "message.part.updated", data: { part } });
    }
    // 新契约（规格 2 §11）：只写描述符，不写内容——消息 part 与事件里因此不再出现
    // base64，历史加载也不必反序列化整份文件。
    for (const ref of attachmentRefs ?? []) {
      const part: Part = {
        id: newPartId(),
        sessionId: this.identity.sessionId,
        messageId: message.id,
        type: "file",
        filename: ref.name,
        mime: ref.mediaType,
        attachmentId: ref.id,
        size: ref.size,
        kind: ref.kind,
        status: "ready",
      };
      this.parts.set(part.id, part);
      emit({ type: "message.part.updated", data: { part } });
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
    let track = this.textByContent.get(contentIndex);
    if (!track) {
      const part = this.assistantPart(emit, { type: "text", text: "" });
      track = { partId: part.id, buffer: "", pendingBytes: 0, lastCheckpointAt: Date.now() };
      this.textByContent.set(contentIndex, track);
    }
    track.buffer += delta;
    if (Buffer.byteLength(track.buffer, "utf8") >= FLUSH_MIN_BYTES) this.flushText(emit, track, "text");
    else this.scheduleFlushTimer(emit);
  }

  onThinkingDelta(emit: Emit, contentIndex: number, delta: string): void {
    let track = this.reasoningByContent.get(contentIndex);
    if (!track) {
      const part = this.assistantPart(emit, { type: "reasoning", text: "" });
      track = { partId: part.id, buffer: "", pendingBytes: 0, lastCheckpointAt: Date.now() };
      this.reasoningByContent.set(contentIndex, track);
    }
    track.buffer += delta;
    if (Buffer.byteLength(track.buffer, "utf8") >= FLUSH_MIN_BYTES) this.flushText(emit, track, "reasoning");
    else this.scheduleFlushTimer(emit);
  }

  onToolExecutionStart(emit: Emit, toolCallId: string, toolName: string, args: unknown, label?: string): void {
    this.flushAllText(emit, true);
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
    this.flushAllText(emit, true);
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

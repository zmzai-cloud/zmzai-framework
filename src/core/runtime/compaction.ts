import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { Api, Model } from "@earendil-works/pi-ai";

/** Framework compaction (spec §8.3) — projection style (tutorial-advanced 06):
 *  canonical history (PI state.messages) is never mutated; the transform keeps
 *  closure state {anchor, summary} and projects the model's view as
 *  [summaryMessage, ...messages.slice(anchor)]. PI's transformContext result is
 *  request-only (never written back to state), so the previous stateless
 *  version re-summarized the whole history on every LLM request — the anchor
 *  turns compaction into an incremental, idempotent projection.
 *  Known limitation: closure state lives per-run (the runner builds a fresh
 *  transform for each runLoop), so a new run re-summarizes once when it next
 *  crosses the threshold; cross-run persistence belongs in the store later.
 *
 *  Harness-course retrofits (tutorial-harness 05/07) preserved:
 *  - 膨胀拒绝：新摘要比它替代的内容（新折叠段 + 旧摘要）还长时作废本次压缩。
 *  - 失败记忆：摘要调用失败或膨胀后，本轮不再反复烧摘要 token。
 *  Projection retrofit adds (tutorial-advanced 06):
 *  - 滞回带：已有摘要时，只有投影尾部自上次压缩后长够摘要体量的一半才再压，
 *    防止超窗后每个请求都重摘一遍。
 *  - 增量摘要：摘要提示词带【已有摘要】+ 新折叠段，反复压缩是续写不是重启。
 *  - 摘要消息固定 timestamp: 0：投影前缀跨请求逐字节稳定，provider 的
 *    prompt cache（前缀逐字节匹配）在两次压缩之间持续命中。 */

export type CompactionOptions = {
  /** Cheap model used to write the summary (the relay's small model). */
  summaryModel: Model<Api>;
  /** Main model's context window (tokens). */
  contextWindow: number;
  /** Reserve headroom for the summary prompt + next reply. */
  reserveTokens?: number;
  /** How many recent messages to keep verbatim. */
  keepRecentMessages?: number;
  /** Streams one completion from the summary model. */
  streamSummary: (messages: AgentMessage[]) => Promise<string>;
  /** Called when a compaction happens so the runner can emit the part. */
  onCompacted?: (summary: string, tokensBefore: number) => void;
  /** Called when a compaction attempt fails ("summary-empty" | "summary-inflated");
   *  after any failure the transform stops retrying for this run (失败记忆). */
  onCompactionFailed?: (reason: "summary-empty" | "summary-inflated") => void | Promise<void>;
};

/** Rough token estimate (chars/4) — good enough for a threshold trigger; the
 *  precise accounting happens provider-side. */
function estimateTokens(messages: AgentMessage[]): number {
  let total = 0;
  for (const message of messages) {
    const content = (message as { content?: unknown }).content;
    if (typeof content === "string") total += Math.ceil(content.length / 4);
    else if (Array.isArray(content)) {
      for (const block of content) {
        if (typeof block === "object" && block !== null && typeof (block as { text?: unknown }).text === "string") {
          total += Math.ceil(((block as { text: string }).text).length / 4);
        }
      }
    }
    if (message.role === "toolResult") {
      const blocks = (message as { content?: unknown }).content;
      if (Array.isArray(blocks)) {
        for (const block of blocks) {
          if (typeof block === "object" && block !== null && typeof (block as { text?: unknown }).text === "string") {
            total += Math.ceil(((block as { text: string }).text).length / 4);
          }
        }
      }
    }
  }
  return total;
}

const SUMMARY_INSTRUCTION =
  "把以下对话压缩成一份中文工作摘要，保留：任务目标、已完成的关键步骤与工具结果、当前进度、待办事项、重要的文件路径/命令/产物。不要续写对话，只输出结构化摘要。";

/** The summary message is deterministic (fixed shape, timestamp 0) so the
 *  projected prefix is byte-stable across requests — this is what lets the
 *  provider's prompt cache keep hitting between two compactions. */
function summaryMessage(text: string): AgentMessage {
  return { role: "user", content: `【早期对话摘要】\n${text}`, timestamp: 0 } as AgentMessage;
}

/** Returns a transformContext that projects the model's view as
 *  [summaryMessage?, ...messages.slice(anchor)] and compacts incrementally
 *  when the projection crosses the window. */
export function createCompactionTransform(options: CompactionOptions): (messages: AgentMessage[], signal?: AbortSignal) => Promise<AgentMessage[]> {
  const reserve = options.reserveTokens ?? 4096;
  const keepRecent = options.keepRecentMessages ?? 8;
  let summary: string | null = null; // 投影的唯一状态：当前摘要
  let anchor = 0; // canonical 历史中已折叠的前缀长度
  let tailTokensAtCompaction = 0; // 上次压缩时投影尾部的 token 量（滞回带基准）
  let hasFailed = false; // 失败记忆：本轮不再重试摘要

  return async (messages, signal) => {
    void signal;
    // 投影：canonical 不可变，模型看到的永远是 [摘要?, slice(anchor)]
    const projected = summary === null ? messages : [summaryMessage(summary), ...messages.slice(anchor)];
    const projectedTokens = estimateTokens(projected);
    if (projectedTokens + reserve < options.contextWindow) return projected;

    // 滞回带：已有摘要但尾部自上次压缩后没长够摘要的一半——再压不划算
    const tailTokens = estimateTokens(messages.slice(anchor));
    const summaryTokens = summary === null ? 0 : estimateTokens([summaryMessage(summary)]);
    const grownEnough = summary === null || tailTokens >= tailTokensAtCompaction + Math.ceil(summaryTokens / 2);
    if (hasFailed || !grownEnough) return projected;
    if (messages.length - anchor <= keepRecent + 1) return projected; // nothing new worth folding

    const tailCount = Math.min(keepRecent, messages.length - anchor);
    const fold = messages.slice(anchor, messages.length - tailCount);
    const foldTokens = estimateTokens(fold);

    // 增量摘要：旧摘要作为上下文带入，只对新折叠段续写
    const priorSection = summary === null ? "" : `【已有摘要】\n${summary}\n\n`;
    const summaryInput: AgentMessage[] = [
      ...fold,
      { role: "user", content: `${priorSection}${SUMMARY_INSTRUCTION}`, timestamp: Date.now() } as AgentMessage,
    ];
    const next = await options.streamSummary(summaryInput).catch(() => "");
    if (!next) {
      hasFailed = true;
      await options.onCompactionFailed?.("summary-empty");
      return projected; // compaction failed — degrade to the current projection
    }
    // 膨胀拒绝：新摘要比它替代的内容（新折叠段 + 旧摘要）还长，压了不如不压
    const nextTokens = estimateTokens([summaryMessage(next)]);
    if (nextTokens >= foldTokens + summaryTokens) {
      hasFailed = true;
      await options.onCompactionFailed?.("summary-inflated");
      return projected;
    }

    summary = next;
    anchor = messages.length - tailCount;
    tailTokensAtCompaction = estimateTokens(messages.slice(anchor));
    options.onCompacted?.(summary, projectedTokens);
    return [summaryMessage(summary), ...messages.slice(anchor)];
  };
}

/** One-shot completion via an AssistantMessageEventStream (relay streamFn
 *  shape): drives the stream to completion and returns its full text. Used for
 *  summary generation and async title generation (spec §13.2). */
export async function streamOneText(
  streamFn: (model: Model<Api>, context: { systemPrompt: string; messages: AgentMessage[] }) => Promise<{ result(): Promise<{ content?: unknown }> }> | { result(): Promise<{ content?: unknown }> },
  model: Model<Api>,
  systemPrompt: string,
  messages: AgentMessage[],
): Promise<string> {
  const stream = await streamFn(model, { systemPrompt, messages });
  const final = await stream.result();
  const content = final.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((block) => (typeof block === "object" && block !== null && (block as { type?: unknown }).type === "text" ? String((block as { text?: unknown }).text ?? "") : ""))
      .filter(Boolean)
      .join("\n");
  }
  return "";
}

/** Builds the compaction transform for a run from a relay stream fn + model
 *  refs. Returns undefined when compaction is disabled (no summaryModel). */
export function buildCompactionTransform(input: {
  enabled: boolean;
  contextWindow: number;
  summaryModel: Model<Api> | null;
  streamOne: (model: Model<Api>, messages: AgentMessage[]) => Promise<string>;
  onCompacted?: (summary: string, tokensBefore: number) => void;
}): ((messages: AgentMessage[], signal?: AbortSignal) => Promise<AgentMessage[]>) | undefined {
  if (!input.enabled || !input.summaryModel) return undefined;
  return createCompactionTransform({
    summaryModel: input.summaryModel,
    contextWindow: input.contextWindow,
    streamSummary: (messages) => input.streamOne(input.summaryModel!, messages),
    ...(input.onCompacted ? { onCompacted: input.onCompacted } : {}),
  });
}

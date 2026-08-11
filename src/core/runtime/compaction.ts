import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { Api, Model } from "@earendil-works/pi-ai";

/** Framework compaction (spec §8.3): when the PI-visible context approaches the
 *  model's window, replace the older history with a generated summary and keep
 *  a recent tail. Wired through PI's transformContext — the loop calls it
 *  before every LLM request. The emitted `compaction` part marks the boundary
 *  in the transcript (the full pre-compaction messages stay persisted in the
 *  framework store; only the model's working context is condensed). */

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

/** Returns a transformContext that compacts when over threshold. */
export function createCompactionTransform(options: CompactionOptions): (messages: AgentMessage[], signal?: AbortSignal) => Promise<AgentMessage[]> {
  const reserve = options.reserveTokens ?? 4096;
  const keepRecent = options.keepRecentMessages ?? 8;
  return async (messages, signal) => {
    void signal;
    const tokens = estimateTokens(messages);
    if (tokens + reserve < options.contextWindow) return messages;
    if (messages.length <= keepRecent + 1) return messages; // nothing worth compacting

    const tail = messages.slice(-keepRecent);
    const head = messages.slice(0, -keepRecent);
    const summaryInput: AgentMessage[] = [
      ...head,
      { role: "user", content: SUMMARY_INSTRUCTION, timestamp: Date.now() } as AgentMessage,
    ];
    const summary = await options.streamSummary(summaryInput).catch(() => "");
    if (!summary) return messages; // compaction failed — degrade to full context

    options.onCompacted?.(summary, tokens);
    const compactionMessage: AgentMessage = {
      role: "user",
      content: `【早期对话摘要】\n${summary}`,
      timestamp: Date.now(),
    } as AgentMessage;
    return [compactionMessage, ...tail];
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

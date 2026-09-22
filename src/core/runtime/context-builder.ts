import type { Agent, AgentMessage } from "@earendil-works/pi-agent-core";
import type { Api, Model } from "@earendil-works/pi-ai";
import { attachmentContent, attachmentRefContent, type AttachmentContentRef, type AttachmentProvider } from "./attachments.js";
import type { FrameworkEvent } from "../events/manifest.js";
import { newPartId } from "../session/ids.js";
import type { SessionStore } from "../session/store.js";
import type { MessageWithParts, ModelRef, Part, SessionInfo } from "../session/types.js";

/** 上下文组装（W7 S6 自 SessionRunner 搬移，spec §9.1 的先行子集）：
 *  历史重建（同拍快照修 TOCTOU）、压缩 transform、记忆召回——runLoop 里
 *  唯一的上下文来源。§9.1 的 ContextManifest/预算计费属 M2，不在此。 */
export class ContextBuilder {
  constructor(private readonly deps: {
    store: SessionStore;
    attachments?: AttachmentProvider;
    compaction?: { enabled: boolean; contextWindow: number; summaryModel: Model<Api> | null };
    modelFor: (ref: ModelRef) => Model<Api>;
    streamFnFor: (session: SessionInfo) => ConstructorParameters<typeof Agent>[0]["streamFn"];
    memoryContextFor?: (session: SessionInfo, text: string) => Promise<string | undefined>;
  }) {}

  /** 「重建输入」的一致性快照：排除集与消息条目**同拍**读取。
   *
   *  【为什么必须同拍】此前 runLoop 先读 workflowRuns 算排除集、下一拍才
   *  getMessages——两拍之间 acceptPrompt 落库的新消息已进 messages 表但不在
   *  排除集里，排队中的用户消息于是泄入正在运行 run 的模型上下文（W6 §8
   *  用插桩证实的读偏斜竞态，FIFO 用例靠一拍微任务时序侥幸掩盖）。
   *  sqlite 实现走单 transaction；实现未提供 rebuildSnapshot 时回落两拍
   *  （JSONL/demo 模式可接受——无并发提交面）。 */
  async historySnapshot(sessionId: string): Promise<{ entries: MessageWithParts[]; excludedUserIds: Set<string> }> {
    const workflow = this.deps.store.workflow;
    if (workflow?.rebuildSnapshot) return await workflow.rebuildSnapshot(sessionId);
    const workflowRuns = workflow ? await workflow.workflowRuns(sessionId) : [];
    const excludedUserIds = new Set(workflowRuns.filter((run) => run.status !== "completed" && run.status !== "failed").map((run) => run.receipt.userMessageId));
    const entries = await this.deps.store.getMessages(sessionId);
    return { entries, excludedUserIds };
  }

  /** 从持久 parts 重建 PI 上下文（自 runner 原样搬移；entries 由
   *  historySnapshot 提供，保证排除判定与消息读取一致）。 */
  async rebuildMessages(sessionId: string, entries: MessageWithParts[], excludedUserIds: Set<string> | undefined): Promise<AgentMessage[]> {
    const messages: AgentMessage[] = [];
    for (const { info, parts } of entries) {
      if (info.role === "user") {
        if (excludedUserIds?.has(info.id)) continue;
        const text = parts
          .filter((part): part is Extract<Part, { type: "text" }> => part.type === "text")
          .map((part) => part.text)
          .join("\n");
        const fileParts = parts.filter((p): p is Extract<Part, { type: "file" }> => p.type === "file");
        // 旧链路历史：data URL 内联部分保持原样重建，否则升级后老会话会「丢附件」。
        const legacy = fileParts.flatMap((p) => {
          const url = p.url;
          if (typeof url !== "string" || !url.startsWith("data:")) return [];
          return [{ name: p.filename, mediaType: p.mime, data: url, size: Buffer.from(url.slice(url.indexOf(",") + 1), "base64").length }];
        });
        // 新链路：按描述符重建，正文经 provider 读取（图片→视觉输入、小文本→内联、其余→清单）。
        // 因此重放历史**不会**把所有附件正文反复塞进后续每个 turn（规格 2 §11）。
        // 用 AttachmentContentRef 而不是 InputAttachmentRef：part 里没有 sha256，
        // 硬编一个假摘要会违反该类型的不变量。
        const refs: AttachmentContentRef[] = fileParts.flatMap((p) => p.attachmentId
          ? [{
            id: p.attachmentId,
            name: p.filename,
            mediaType: p.mime,
            ...(typeof p.size === "number" ? { size: p.size } : {}),
            kind: p.kind ?? "text",
          }]
          : []);
        const refParts = await attachmentRefContent(this.deps.attachments, refs, { sessionId });
        messages.push({ role: "user", content: [{ type: "text", text }, ...attachmentContent(legacy), ...refParts], timestamp: Date.parse(info.time.created) || Date.now() });
      } else {
        const text = parts
          .filter((part): part is Extract<Part, { type: "text" }> => part.type === "text")
          .map((part) => part.text)
          .join("\n");
        if (!text) continue;
        messages.push({
          role: "assistant",
          content: [{ type: "text", text }],
          api: "openai-completions",
          provider: info.model.providerId,
          model: info.model.modelId,
          usage: { input: info.tokens?.input ?? 0, output: info.tokens?.output ?? 0, cacheRead: info.tokens?.cacheRead ?? 0, cacheWrite: info.tokens?.cacheWrite ?? 0, totalTokens: (info.tokens?.input ?? 0) + (info.tokens?.output ?? 0) + (info.tokens?.cacheRead ?? 0) + (info.tokens?.cacheWrite ?? 0) },
          stopReason: info.error ? "error" : "stop",
          ...(info.error ? { errorMessage: info.error.message } : {}),
          timestamp: Date.parse(info.time.created) || Date.now(),
        } as AgentMessage);
      }
    }
    return messages;
  }

  /** 当前会话的压缩阈值：优先取模型目录给的真实上下文窗口，回落 runtime 级
   *  全局配置。旧行为恒取 deps.compaction.contextWindow；模型目录未覆盖该
   *  modelId 时 model.contextWindow 即等于该全局值，行为不变。
   *  modelFor 抛错（宿主 provider 不认识该 ref）时同样回落，绝不阻断压缩。 */
  private contextWindowFor(session: SessionInfo): number {
    const fallback = this.deps.compaction?.contextWindow ?? 0;
    try {
      const model = this.deps.modelFor(session.model) as { contextWindow?: unknown } | null | undefined;
      const win = model?.contextWindow;
      return typeof win === "number" && win > 0 ? win : fallback;
    } catch {
      return fallback;
    }
  }

  /** Builds the compaction transformContext (spec §8.3) when the builder has a
   *  summary model configured. Emits a `compaction` part on the latest
   *  assistant message so the boundary shows in the transcript. force=true
   *  skips the threshold/滞回 early-outs (手动「压缩当前会话」)。 */
  async buildCompaction(session: SessionInfo, emit: (event: FrameworkEvent) => void, force = false) {
    if (!this.deps.compaction?.enabled || !this.deps.compaction.summaryModel) return undefined;
    const { buildCompactionTransform, streamOneText } = await import("./compaction.js");
    return buildCompactionTransform({
      enabled: true,
      contextWindow: this.contextWindowFor(session),
      summaryModel: this.deps.compaction.summaryModel,
      ...(force ? { force: true } : {}),
      streamOne: async (model, messages) => {
        const streamFn = this.deps.streamFnFor(session);
        return streamOneText(
          async (m, ctx) => {
            const stream = await streamFn(m, ctx as never);
            return stream;
          },
          model,
          "你是上下文压缩助手。只输出结构化摘要，不续写对话。",
          messages,
        );
      },
      onCompacted: (summary) => {
        void (async () => {
          const entries = await this.deps.store.getMessages(session.id);
          const lastAssistant = [...entries].reverse().find((entry) => entry.info.role === "assistant");
          if (!lastAssistant) return;
          const part: Part = { id: newPartId(), sessionId: session.id, messageId: lastAssistant.info.id, type: "compaction", summary };
          await this.deps.store.appendPart(part).catch(() => undefined);
          emit({ type: "message.part.updated", data: { part } });
        })();
      },
    });
  }

  /** Attempt 上下文的唯一组装入口：压缩 transform → 同拍快照重建 → 记忆召回。
   *  baseline：本次 run 新增消息从这之后算（供 onRunEnd 提取 retain）。 */
  async buildAttemptContext(
    session: SessionInfo,
    input: { text: string },
    emit: (event: FrameworkEvent) => void,
  ): Promise<{ compactionTransform: Awaited<ReturnType<ContextBuilder["buildCompaction"]>>; history: AgentMessage[]; baseline: number }> {
    const compactionTransform = await this.buildCompaction(session, emit);
    // 记忆召回（spec §记忆）：单点注入，天然覆盖正常 prompt/排队出队/
    // automation/子代理触发四条路径。只进内存不落 store；抛错静默降级。
    const { entries, excludedUserIds } = await this.historySnapshot(session.id);
    const history = await this.rebuildMessages(session.id, entries, excludedUserIds);
    if (this.deps.memoryContextFor) {
      try {
        const section = await this.deps.memoryContextFor(session, input.text);
        if (section) {
          history.unshift({ role: "user", content: [{ type: "text", text: section }], timestamp: Date.now() } as AgentMessage);
        }
      } catch {
        // 召回失败不阻塞 run
      }
    }
    return { compactionTransform, history, baseline: history.length };
  }
}

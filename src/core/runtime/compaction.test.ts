import { describe, expect, it, vi } from "vitest";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { Api, Model } from "@earendil-works/pi-ai";

import { buildCompactionTransform, createCompactionTransform, streamOneText } from "../runtime/compaction.js";

function userMessage(text: string): AgentMessage {
  return { role: "user", content: text, timestamp: Date.now() } as AgentMessage;
}

function assistantMessage(text: string): AgentMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    api: "openai-completions",
    provider: "relay",
    model: "m",
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 },
    stopReason: "stop",
    timestamp: Date.now(),
  } as AgentMessage;
}

const fakeModel = { id: "m", provider: "relay" } as unknown as Model<Api>;

describe("createCompactionTransform", () => {
  it("passes messages through when under the window", async () => {
    const onCompacted = vi.fn();
    const transform = createCompactionTransform({
      summaryModel: fakeModel,
      contextWindow: 128_000,
      streamSummary: async () => "摘要",
      onCompacted,
    });
    const messages = [userMessage("短"), assistantMessage("短的回复")];
    const result = await transform(messages);
    expect(result).toEqual(messages);
    expect(onCompacted).not.toHaveBeenCalled();
  });

  it("compacts when over the window, keeping a recent tail", async () => {
    const onCompacted = vi.fn();
    const transform = createCompactionTransform({
      summaryModel: fakeModel,
      contextWindow: 1_000, // tiny window forces compaction
      keepRecentMessages: 2,
      streamSummary: async () => "早期对话的摘要",
      onCompacted,
    });
    const big = "字".repeat(400); // ~100 tokens each
    const messages = [userMessage(big), assistantMessage(big), userMessage(big), assistantMessage(big), userMessage("最近一"), assistantMessage("最近答")];
    const result = await transform(messages);
    expect(result.length).toBeLessThan(messages.length);
    expect((result[0] as { content: string }).content).toContain("早期对话的摘要");
    // tail preserved
    expect(result[result.length - 1]).toEqual(messages[messages.length - 1]);
    expect(onCompacted).toHaveBeenCalledWith("早期对话的摘要", expect.any(Number));
  });

  it("degrades to full context when the summary fails", async () => {
    const transform = createCompactionTransform({
      summaryModel: fakeModel,
      contextWindow: 100,
      keepRecentMessages: 2,
      streamSummary: async () => {
        throw new Error("model down");
      },
    });
    const messages = [userMessage("x".repeat(400)), assistantMessage("y".repeat(400)), userMessage("z"), assistantMessage("w")];
    const result = await transform(messages);
    expect(result).toEqual(messages);
  });

  it("rejects an inflated summary and remembers the failure (harness-course 05/07 retrofit)", async () => {
    const onCompactionFailed = vi.fn();
    const streamSummary = vi.fn(async () => "长".repeat(2000)); // 比被压区还长
    const transform = createCompactionTransform({
      summaryModel: fakeModel,
      contextWindow: 100,
      keepRecentMessages: 2,
      streamSummary,
      onCompactionFailed,
    });
    const messages = [userMessage("x".repeat(400)), assistantMessage("y".repeat(400)), userMessage("z"), assistantMessage("w")];
    const result = await transform(messages);
    expect(result).toEqual(messages); // 膨胀拒绝：宁用全量
    expect(onCompactionFailed).toHaveBeenCalledWith("summary-inflated");
    // 失败记忆：再超阈值也不重新调摘要
    await transform(messages);
    expect(streamSummary).toHaveBeenCalledTimes(1);
  });

  it("remembers an empty-summary failure too", async () => {
    const onCompactionFailed = vi.fn();
    const streamSummary = vi.fn(async () => "");
    const transform = createCompactionTransform({
      summaryModel: fakeModel,
      contextWindow: 100,
      keepRecentMessages: 2,
      streamSummary,
      onCompactionFailed,
    });
    const messages = [userMessage("x".repeat(400)), assistantMessage("y".repeat(400)), userMessage("z"), assistantMessage("w")];
    await transform(messages);
    await transform(messages);
    expect(onCompactionFailed).toHaveBeenCalledTimes(1);
    expect(streamSummary).toHaveBeenCalledTimes(1);
  });
});

describe("createCompactionTransform — projection (tutorial-advanced 06)", () => {
  const tinyWindow = { contextWindow: 1_000, keepRecentMessages: 2 };

  it("emits a fixed summary message (timestamp 0) that stays byte-stable across requests", async () => {
    const transform = createCompactionTransform({ summaryModel: fakeModel, ...tinyWindow, streamSummary: async () => "摘要" });
    const big = "字".repeat(400);
    const messages = [userMessage(big), assistantMessage(big), userMessage(big), assistantMessage(big), userMessage("最近一"), assistantMessage("最近答")];
    const first = await transform(messages);
    expect((first[0] as { timestamp: number }).timestamp).toBe(0);
    // 尾部多了一条小消息：投影前缀必须逐字节不变（prompt cache 命中的前提）
    const second = await transform([...messages, userMessage("小小的追问")]);
    expect(second[0]).toEqual({ role: "user", content: "【早期对话摘要】\n摘要", timestamp: 0 });
    expect(second[second.length - 1]).toEqual({ role: "user", content: "小小的追问", timestamp: expect.any(Number) });
  });

  it("does not re-summarize while the tail is inside the hysteresis band", async () => {
    const streamSummary = vi.fn(async () => "精简摘要");
    const transform = createCompactionTransform({ summaryModel: fakeModel, ...tinyWindow, streamSummary });
    const big = "字".repeat(400);
    const messages = [userMessage(big), assistantMessage(big), userMessage(big), assistantMessage(big), userMessage("最近一"), assistantMessage("最近答")];
    await transform(messages);
    await transform([...messages, userMessage("小小的追问")]);
    expect(streamSummary).toHaveBeenCalledTimes(1); // 滞回带内不重摘
  });

  it("re-compacts incrementally, carrying 【已有摘要】 into the next summary prompt", async () => {
    const streamSummary = vi.fn().mockResolvedValueOnce("第一版摘要").mockResolvedValue("第二版摘要");
    const transform = createCompactionTransform({ summaryModel: fakeModel, ...tinyWindow, streamSummary });
    const big = "字".repeat(400);
    const messages = [userMessage(big), assistantMessage(big), userMessage(big), assistantMessage(big), userMessage("最近一"), assistantMessage("最近答")];
    await transform(messages);
    // 追加一大段新对话：尾部增量超过摘要体量的一半，触发增量再压缩
    const grown = [...messages, userMessage(big), assistantMessage(big), userMessage(big), assistantMessage(big), userMessage(big), assistantMessage(big)];
    const result = await transform(grown);
    expect(streamSummary).toHaveBeenCalledTimes(2);
    const summaryInput = streamSummary.mock.calls[1]![0] as AgentMessage[];
    const instruction = summaryInput[summaryInput.length - 1]! as { content: string };
    expect(instruction.content).toContain("【已有摘要】");
    expect(instruction.content).toContain("第一版摘要"); // 旧摘要作为上下文带入
    expect((result[0] as { content: string }).content).toContain("第二版摘要");
  });

  it("keeps the canonical history untouched (projection, not mutation)", async () => {
    const transform = createCompactionTransform({ summaryModel: fakeModel, ...tinyWindow, streamSummary: async () => "摘要" });
    const big = "字".repeat(400);
    const messages = [userMessage(big), assistantMessage(big), userMessage(big), assistantMessage(big), userMessage("最近一"), assistantMessage("最近答")];
    const snapshot = structuredClone(messages);
    const result = await transform(messages);
    expect(messages).toEqual(snapshot); // canonical 不可变
    expect(result[0]).not.toBe(messages[0]); // 投影头是新的摘要消息
    expect(result[result.length - 1]).toBe(messages[messages.length - 1]); // 尾部保持引用
  });
});

describe("buildCompactionTransform", () => {
  it("returns undefined when disabled or no summary model", () => {
    expect(buildCompactionTransform({ enabled: false, contextWindow: 1000, summaryModel: fakeModel, streamOne: async () => "" })).toBeUndefined();
    expect(buildCompactionTransform({ enabled: true, contextWindow: 1000, summaryModel: null, streamOne: async () => "" })).toBeUndefined();
  });

  it("returns a transform when enabled with a model", () => {
    const transform = buildCompactionTransform({ enabled: true, contextWindow: 1000, summaryModel: fakeModel, streamOne: async () => "s" });
    expect(typeof transform).toBe("function");
  });
});

describe("streamOneText", () => {
  it("extracts text from a completed AssistantMessage", async () => {
    const text = await streamOneText(
      async () => ({ result: async () => ({ content: [{ type: "text", text: "你好" }, { type: "text", text: "世界" }] }) }),
      fakeModel,
      "sys",
      [],
    );
    expect(text).toBe("你好\n世界");
  });

  it("handles string content", async () => {
    const text = await streamOneText(async () => ({ result: async () => ({ content: "直接文本" }) }), fakeModel, "sys", []);
    expect(text).toBe("直接文本");
  });
});

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

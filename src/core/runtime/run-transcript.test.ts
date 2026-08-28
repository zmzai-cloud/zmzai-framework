import { describe, expect, it } from "vitest";
import type { AgentMessage } from "@earendil-works/pi-agent-core";

import { extractRunTranscript, RETRY_PLACEHOLDER_TEXT, type RunTranscriptMessage } from "./run-transcript.js";

function userMessage(text: string): AgentMessage {
  return { role: "user", content: text, timestamp: 1 };
}

function assistantMessage(text: string): AgentMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    api: "openai-completions",
    provider: "faux",
    model: "test-model",
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 },
    stopReason: "stop",
    timestamp: 2,
  } as AgentMessage;
}

describe("extractRunTranscript", () => {
  it("只保留 baseline 之后新增的 user/assistant 文本", () => {
    const messages = [userMessage("旧消息"), assistantMessage("旧回复"), userMessage("新任务"), assistantMessage("新回复")];
    const result = extractRunTranscript(messages, 2);
    expect(result).toEqual<RunTranscriptMessage[]>([
      { role: "user", text: "新任务" },
      { role: "assistant", text: "新回复" },
    ]);
  });

  it("跳过 thinking/toolCall 块，只取 text 块", () => {
    const withToolCall = {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "思考中" },
        { type: "toolCall", id: "call_1", name: "read", arguments: {} },
        { type: "text", text: "读完了" },
      ],
      stopReason: "toolUse",
      timestamp: 3,
    } as unknown as AgentMessage;
    expect(extractRunTranscript([withToolCall], 0)).toEqual<RunTranscriptMessage[]>([{ role: "assistant", text: "读完了" }]);
  });

  it("排除空文本与 F6 合成占位消息", () => {
    const messages = [
      userMessage("   "),
      userMessage(RETRY_PLACEHOLDER_TEXT),
      assistantMessage(""),
    ];
    expect(extractRunTranscript(messages, 0)).toEqual([]);
  });

  it("baseline 越界时返回空数组", () => {
    expect(extractRunTranscript([userMessage("x")], 5)).toEqual([]);
  });
});

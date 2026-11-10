import { describe, expect, it } from "vitest";

import { PartProjector } from "./pi-bridge.js";
import { isRetryableError, upstreamRetryable } from "./task-lifecycle.js";
import type { FrameworkEvent } from "../events/manifest.js";

/** 第一档接入回归（2026-11-10）：
 *  ① pi 1.5 的 durationMs / thinkingLevel / cost(totalFromProvider) 投影进
 *     assistant 消息 info 与 step-finish part；工具耗时进完成态。
 *  ② 重试判定优先 pi-ai isRetryableAssistantError——上游精度收益要有测试钉住
 *     （server_busy 上游可重试而本地列表不认；Zhipu 1308 上游判不可重试）。 */

const model = { providerId: "faux", modelId: "test-model" } as never;
const identity = { sessionId: "ses_t1", agent: "a", model };

function assistantInfo(events: FrameworkEvent[]): Record<string, unknown> {
  return events.filter((e) => e.type === "message.updated")
    .map((e) => (e as unknown as { data: { message: Record<string, unknown> } }).data.message)
    .filter((m) => m.role === "assistant").at(-1)!; // onAssistantStart 先发骨架，终态在最后一条
}

function collect() {
  const events: FrameworkEvent[] = [];
  const emit = (event: FrameworkEvent) => { events.push(event); };
  return { events, emit };
}

describe("pi 1.5 度量投影（PartProjector）", () => {
  it("assistant 结束：info 带耗时/档位/费用，step-finish 带费用", () => {
    const proj = new PartProjector(identity);
    const { events, emit } = collect();
    proj.onUserPrompt(emit, "跑");
    proj.onAssistantStart(emit);
    proj.onAssistantEnd(emit, {
      role: "assistant",
      durationMs: 1234,
      thinkingLevel: "high",
      usage: { input: 10, output: 5, cost: { total: 0.0042, totalFromProvider: true } },
    } as never);

    const info = assistantInfo(events);
    expect(info.durationMs).toBe(1234);
    expect(info.thinkingLevel).toBe("high");
    expect(info.cost).toEqual({ total: 0.0042, totalFromProvider: true });

    const step = events.map((e) => (e as unknown as { data?: { part?: { type: string } } }).data?.part).filter((p) => p?.type === "step-finish").at(-1) as { cost?: { total: number; totalFromProvider: boolean } };
    expect(step.cost).toEqual({ total: 0.0042, totalFromProvider: true });
  });

  it("费用缺失/目录估算：totalFromProvider=false；无 usage 不落字段", () => {
    const proj = new PartProjector(identity);
    const { events, emit } = collect();
    proj.onUserPrompt(emit, "跑");
    proj.onAssistantStart(emit);
    proj.onAssistantEnd(emit, { role: "assistant", durationMs: 10, usage: { input: 1, output: 1, cost: { total: 0.5, totalFromProvider: false } } } as never);
    const info = assistantInfo(events);
    expect(info.cost).toEqual({ total: 0.5, totalFromProvider: false });

    const proj2 = new PartProjector(identity);
    const { events: events2, emit: emit2 } = collect();
    proj2.onUserPrompt(emit2, "跑");
    proj2.onAssistantStart(emit2);
    proj2.onAssistantEnd(emit2, { role: "assistant" } as never);
    const info2 = assistantInfo(events2);
    expect(info2.cost).toBeUndefined();
    expect(info2.durationMs).toBeUndefined();
    expect(info2.thinkingLevel).toBeUndefined();
  });

  it("工具执行耗时（pi 单调时钟）落在完成态", () => {
    const proj = new PartProjector(identity);
    const { events, emit } = collect();
    proj.onUserPrompt(emit, "跑");
    proj.onAssistantStart(emit);
    proj.onToolExecutionStart(emit, "call_1", "probe", { text: "x" });
    proj.onToolExecutionEnd(emit, "call_1", { role: "toolResult", content: [], durationMs: 55 }, false);
    const part = events.map((e) => (e as unknown as { data?: { part?: { type: string } } }).data?.part).filter((p) => p?.type === "tool").at(-1) as unknown as { state: { durationMs?: number; status: string } };
    expect(part.state.status).toBe("completed");
    expect(part.state.durationMs).toBe(55);
  });
});

describe("重试判定：上游优先、本地兜底", () => {
  const errorMessage = (message: string) => ({ role: "assistant", stopReason: "error", errorMessage: message }) as never;

  it("server_busy：上游判可重试（本地字符串列表不认——上游精度收益）", () => {
    expect(upstreamRetryable(errorMessage("server_busy: servers are currently busy"))).toBe(true);
    expect(isRetryableError("server_busy: servers are currently busy")).toBe(false);
  });

  it("Zhipu 1308 用量超限：上游判不可重试（重试不可能成功）", () => {
    expect(upstreamRetryable(errorMessage("Zhipu usage limit exceeded, code 1308"))).toBe(false);
    expect(isRetryableError("Zhipu usage limit exceeded, code 1308")).toBe(false);
  });

  it("网络类错误两边都认；非 assistant 结构回落 null（本地兜底继续生效）", () => {
    expect(upstreamRetryable(errorMessage("fetch failed: socket hang up"))).toBe(true);
    expect(isRetryableError("socket hang up")).toBe(true);
    expect(upstreamRetryable(null)).toBeNull();
    expect(upstreamRetryable({ role: "user" })).toBeNull();
  });
});

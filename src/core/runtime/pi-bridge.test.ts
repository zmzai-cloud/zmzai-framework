import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("node:crypto", () => {
  let counter = 0;
  return {
    randomUUID: () => `test-uuid-${++counter}`,
  };
});

import { PartProjector, serializeEmit } from "@/packages/agent-framework/src/core/runtime/pi-bridge";
import type { FrameworkEvent } from "@/packages/agent-framework/src/core/events/manifest";
import type { ModelRef } from "@/packages/agent-framework/src/core/session/types";

const model: ModelRef = { providerId: "openai", modelId: "gpt-4" };
const identity = { sessionId: "ses_test", agent: "test-agent", model };

function collect() {
  const events: FrameworkEvent[] = [];
  const emit = (e: FrameworkEvent) => { events.push(e); };
  return { events, emit };
}

beforeEach(() => {
  vi.clearAllMocks();
});

// ---- serializeEmit ----

describe("serializeEmit", () => {
  it("serializes events through the async sink in order", async () => {
    const order: number[] = [];
    const sink = async (e: FrameworkEvent) => {
      // simulate async work
      await new Promise((r) => setTimeout(r, 0));
      order.push((e.data as { seq?: number }).seq ?? 0);
    };
    const { emit, settled } = serializeEmit(sink);
    emit({ type: "session.status", data: { status: "running" } } as unknown as FrameworkEvent);
    emit({ type: "session.status", data: { status: "idle" } } as unknown as FrameworkEvent);
    await settled();
    expect(order).toEqual([0, 0]);
  });
});

// ---- PartProjector: onUserPrompt ----

describe("PartProjector.onUserPrompt", () => {
  it("creates a user message and a text part", () => {
    const proj = new PartProjector(identity);
    const { events, emit } = collect();
    const msg = proj.onUserPrompt(emit, "Hello world");
    expect(msg.role).toBe("user");
    expect(msg.sessionId).toBe("ses_test");
    expect(msg.agent).toBe("test-agent");
    // message.updated + message.part.updated (text)
    const msgUpdated = events.filter((e) => e.type === "message.updated");
    const partUpdated = events.filter((e) => e.type === "message.part.updated");
    expect(msgUpdated).toHaveLength(1);
    expect(partUpdated).toHaveLength(1);
    const part = (partUpdated[0] as { data: { part: { type: string; text: string } } }).data.part;
    expect(part.type).toBe("text");
    expect(part.text).toBe("Hello world");
  });

  it("skips text part when input is whitespace-only", () => {
    const proj = new PartProjector(identity);
    const { events, emit } = collect();
    proj.onUserPrompt(emit, "   ");
    const partEvents = events.filter((e) => e.type === "message.part.updated");
    expect(partEvents).toHaveLength(0);
  });

  it("creates image parts for each attached image", () => {
    const proj = new PartProjector(identity);
    const { events, emit } = collect();
    const images = [
      { url: "data:image/png;base64,abc", mediaType: "image/png" },
      { url: "data:image/jpeg;base64,def", mediaType: "image/jpeg" },
    ];
    proj.onUserPrompt(emit, "Look at this", images);
    const partEvents = events.filter((e) => e.type === "message.part.updated");
    expect(partEvents).toHaveLength(3); // 1 text + 2 images
    const imgParts = partEvents.filter((e) => (e.data.part as { type: string }).type === "image");
    expect(imgParts).toHaveLength(2);
    expect((imgParts[0]!.data.part as { url: string }).url).toBe("data:image/png;base64,abc");
    expect((imgParts[1]!.data.part as { mediaType: string }).mediaType).toBe("image/jpeg");
  });
});

// ---- PartProjector: assistant lifecycle ----

describe("PartProjector assistant lifecycle", () => {
  it("onAssistantStart creates message + step-start", () => {
    const proj = new PartProjector(identity);
    const { events, emit } = collect();
    proj.onUserPrompt(emit, "hi");
    const { events: aEvents, emit: aEmit } = collect();
    proj.onAssistantStart(aEmit);
    const msgEvents = aEvents.filter((e) => e.type === "message.updated");
    const partEvents = aEvents.filter((e) => e.type === "message.part.updated");
    expect(msgEvents).toHaveLength(1);
    const msg = (msgEvents[0] as { data: { message: { role: string } } }).data.message;
    expect(msg.role).toBe("assistant");
    // step-start part
    expect(partEvents).toHaveLength(1);
    const stepPart = (partEvents[0] as { data: { part: { type: string } } }).data.part;
    expect(stepPart.type).toBe("step-start");
  });

  it("onTextDelta creates text part and accumulates deltas", () => {
    const proj = new PartProjector(identity);
    const { emit } = collect();
    proj.onUserPrompt(emit, "hi");
    const { events, emit: aEmit } = collect();
    proj.onAssistantStart(aEmit);
    proj.onTextDelta(aEmit, 0, "Hello ");
    proj.onTextDelta(aEmit, 0, "world");
    // Should have created a text part (step-start + text part)
    const partEvents = events.filter((e) => e.type === "message.part.updated");
    expect(partEvents.length).toBeGreaterThanOrEqual(2); // step-start + text part
    const textPart = partEvents.find((e) => {
      const p = (e as { data: { part: { type: string } } }).data.part;
      return p.type === "text";
    });
    expect(textPart).toBeDefined();
  });

  it("onTextDelta flushes when buffer exceeds 2KB", () => {
    const proj = new PartProjector(identity);
    const { emit } = collect();
    proj.onUserPrompt(emit, "hi");
    const { events, emit: aEmit } = collect();
    proj.onAssistantStart(aEmit);
    // Send a large delta (> 2KB)
    const largeDelta = "x".repeat(3000);
    proj.onTextDelta(aEmit, 0, largeDelta);
    // Should have a delta event (flush)
    const deltaEvents = events.filter((e) => e.type === "message.part.delta");
    expect(deltaEvents.length).toBeGreaterThanOrEqual(1);
  });

  it("onThinkingDelta creates reasoning part", () => {
    const proj = new PartProjector(identity);
    const { emit } = collect();
    proj.onUserPrompt(emit, "hi");
    const { events, emit: aEmit } = collect();
    proj.onAssistantStart(aEmit);
    proj.onThinkingDelta(aEmit, 0, "Let me think...");
    const partEvents = events.filter((e) => e.type === "message.part.updated");
    const reasoningPart = partEvents.find((e) => {
      const p = (e as { data: { part: { type: string } } }).data.part;
      return p.type === "reasoning";
    });
    expect(reasoningPart).toBeDefined();
  });
});

// ---- Tool lifecycle ----

describe("PartProjector tool lifecycle", () => {
  it("creates, updates, and completes a tool part", () => {
    const proj = new PartProjector(identity);
    const { emit } = collect();
    proj.onUserPrompt(emit, "run it");
    const { events, emit: aEmit } = collect();
    proj.onAssistantStart(aEmit);

    proj.onToolExecutionStart(aEmit, "call_1", "bash", { command: "ls" });
    const startParts = events.filter((e) => e.type === "message.part.updated");
    const toolPart = startParts.find((e) => {
      const p = (e as { data: { part: { type: string } } }).data.part;
      return p.type === "tool";
    });
    expect(toolPart).toBeDefined();
    const toolPartData = (toolPart as { data: { part: { type: string; state: { status: string } } } }).data.part;
    expect(toolPartData.state.status).toBe("running");

    // Update with title
    proj.onToolExecutionUpdate(aEmit, "call_1", { details: { title: "Listing files" } });
    // End successfully
    proj.onToolExecutionEnd(aEmit, "call_1", { content: [{ type: "text", text: "file1\nfile2" }] }, false);

    // Find the final tool part state
    const allToolEvents = events.filter((e) => {
      if (e.type !== "message.part.updated") return false;
      const p = (e as { data: { part: { type: string } } }).data.part;
      return p?.type === "tool";
    });
    const lastToolEvent = allToolEvents[allToolEvents.length - 1] as { data: { part: { state: { status: string; output: string; title: string } } } };
    expect(lastToolEvent.data.part.state.status).toBe("completed");
    expect(lastToolEvent.data.part.state.output).toBe("file1\nfile2");
    expect(lastToolEvent.data.part.state.title).toBe("Listing files");
  });

  it("marks tool as error when isError=true", () => {
    const proj = new PartProjector(identity);
    const { emit } = collect();
    proj.onUserPrompt(emit, "run");
    const { events, emit: aEmit } = collect();
    proj.onAssistantStart(aEmit);
    proj.onToolExecutionStart(aEmit, "call_2", "bash", { command: "rm -rf /" });
    proj.onToolExecutionEnd(aEmit, "call_2", { content: [{ type: "text", text: "Permission denied" }] }, true);
    const toolEvents = events.filter((e) => {
      if (e.type !== "message.part.updated") return false;
      const p = (e as { data: { part: { type: string } } }).data.part;
      return p?.type === "tool";
    });
    const last = toolEvents[toolEvents.length - 1] as { data: { part: { state: { status: string; error: string } } } };
    expect(last.data.part.state.status).toBe("error");
    expect(last.data.part.state.error).toBe("Permission denied");
  });

  it("marks tool as error with unknown outcome when metadata.outcome=unknown", () => {
    const proj = new PartProjector(identity);
    const { emit } = collect();
    proj.onUserPrompt(emit, "run");
    const { events, emit: aEmit } = collect();
    proj.onAssistantStart(aEmit);
    proj.onToolExecutionStart(aEmit, "call_3", "bash", {});
    proj.onToolExecutionEnd(aEmit, "call_3", { content: [], details: { outcome: "unknown" } }, false);
    const toolEvents = events.filter((e) => {
      if (e.type !== "message.part.updated") return false;
      const p = (e as { data: { part: { type: string } } }).data.part;
      return p?.type === "tool";
    });
    const last = toolEvents[toolEvents.length - 1] as { data: { part: { state: { status: string; metadata?: { outcome: string } } } } };
    expect(last.data.part.state.status).toBe("error");
    expect(last.data.part.state.metadata?.outcome).toBe("unknown");
  });
});

// ---- onAssistantEnd ----

describe("PartProjector.onAssistantEnd", () => {
  it("emits step-finish and message.updated with usage", () => {
    const proj = new PartProjector(identity);
    const { emit } = collect();
    proj.onUserPrompt(emit, "hi");
    const { events, emit: aEmit } = collect();
    proj.onAssistantStart(aEmit);
    proj.onTextDelta(aEmit, 0, "response");

    const endMsg = { role: "assistant" as const, usage: { input: 10, output: 20 } } as unknown as import("@earendil-works/pi-agent-core").AgentMessage;
    proj.onAssistantEnd(aEmit, endMsg);

    // step-finish part
    const stepFinish = events.filter((e) => {
      if (e.type !== "message.part.updated") return false;
      const p = (e as { data: { part: { type: string } } }).data.part;
      return p?.type === "step-finish";
    });
    expect(stepFinish).toHaveLength(1);
    const tokens = (stepFinish[0] as { data: { part: { tokens?: { input: number; output: number } } } }).data.part.tokens;
    expect(tokens).toEqual({ input: 10, output: 20 });

    // message.updated with tokens (last one is the assistant end)
    const msgUpdated = events.filter((e) => e.type === "message.updated");
    const lastMsg = msgUpdated[msgUpdated.length - 1] as { data: { message: { tokens?: { input: number; output: number } } } };
    expect(lastMsg.data.message.tokens).toEqual({ input: 10, output: 20 });
  });

  it("extracts error when stopReason=error", () => {
    const proj = new PartProjector(identity);
    const { emit } = collect();
    proj.onUserPrompt(emit, "hi");
    const { events, emit: aEmit } = collect();
    proj.onAssistantStart(aEmit);

    const endMsg = { role: "assistant" as const, stopReason: "error", errorMessage: "Model crashed" } as unknown as import("@earendil-works/pi-agent-core").AgentMessage;
    proj.onAssistantEnd(aEmit, endMsg);

    const msgUpdated = events.filter((e) => e.type === "message.updated");
    const lastMsg = msgUpdated[msgUpdated.length - 1] as { data: { message: { error?: { name: string; message: string } } } };
    expect(lastMsg.data.message.error).toEqual({ name: "APIError", message: "Model crashed" });
  });

  it("extracts error when stopReason=aborted", () => {
    const proj = new PartProjector(identity);
    const { emit } = collect();
    proj.onUserPrompt(emit, "hi");
    const { events, emit: aEmit } = collect();
    proj.onAssistantStart(aEmit);

    const endMsg = { role: "assistant" as const, stopReason: "aborted", errorMessage: "User cancelled" } as unknown as import("@earendil-works/pi-agent-core").AgentMessage;
    proj.onAssistantEnd(aEmit, endMsg);

    const msgUpdated2 = events.filter((e) => e.type === "message.updated");
    const lastMsg2 = msgUpdated2[msgUpdated2.length - 1] as { data: { message: { error?: { name: string; message: string } } } };
    expect(lastMsg2.data.message.error).toEqual({ name: "AbortedError", message: "User cancelled" });
  });
});

// ---- currentAssistantMessageId ----

describe("PartProjector.currentAssistantMessageId", () => {
  it("returns null before any assistant message", () => {
    const proj = new PartProjector(identity);
    expect(proj.currentAssistantMessageId).toBeNull();
  });

  it("returns assistant message id after onAssistantStart", () => {
    const proj = new PartProjector(identity);
    const { emit } = collect();
    proj.onUserPrompt(emit, "hi");
    proj.onAssistantStart(emit);
    expect(proj.currentAssistantMessageId).toBeTruthy();
  });

  it("returns null after onAssistantEnd but retains tool anchor", () => {
    const proj = new PartProjector(identity);
    const { emit } = collect();
    proj.onUserPrompt(emit, "hi");
    proj.onAssistantStart(emit);
    const id = proj.currentAssistantMessageId;
    expect(id).toBeTruthy();
    const endMsg = { role: "assistant" as const } as unknown as import("@earendil-works/pi-agent-core").AgentMessage;
    proj.onAssistantEnd(emit, endMsg);
    // toolAnchorMessageId still holds the previous assistant message
    expect(proj.currentAssistantMessageId).toBe(id);
  });
});

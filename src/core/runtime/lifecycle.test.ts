import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { createFauxCore, fauxAssistantMessage, fauxToolCall, type FauxContentBlock } from "@earendil-works/pi-ai/providers/faux";

import { AgentRegistry } from "../agent/registry.js";
import { SessionRunner, createFrameworkSession, type RunnerDeps } from "./runner.js";
import { firstToolBlock, fireRunEnd, fireRunStart, type LifecycleHook } from "./lifecycle.js";
import type { SessionStore } from "../session/store.js";
import type { MessageInfo, MessageWithParts, Part, SessionInfo } from "../session/types.js";
import type { ToolContext, WorkspaceFiles } from "../tools/context.js";
import { createMemoryEventLog } from "../events/bus.js";

// 最小 in-memory store（与 runner.test.ts 同构）
function memoryStore(): SessionStore & { sessions: Map<string, SessionInfo>; messages: Map<string, MessageInfo>; parts: Map<string, Part> } {
  const sessions = new Map<string, SessionInfo>();
  const messages = new Map<string, MessageInfo>();
  const parts = new Map<string, Part>();
  return {
    sessions,
    messages,
    parts,
    async createSession(info) { sessions.set(info.id, structuredClone(info)); },
    async getSession(id) { const s = sessions.get(id); return s ? structuredClone(s) : null; },
    async updateSession(id, patch) { const s = sessions.get(id); if (s) sessions.set(id, { ...s, ...patch }); },
    async listSessions() { return [...sessions.values()]; },
    async appendMessage(info) { messages.set(info.id, structuredClone(info)); },
    async updateMessage(id, patch) { const m = messages.get(id); if (m) messages.set(id, { ...m, ...patch } as MessageInfo); },
    async appendPart(part) { parts.set(part.id, structuredClone(part)); },
    async updatePart(part) { parts.set(part.id, structuredClone(part)); },
    async getMessages(sessionId) {
      return [...messages.values()].filter((m) => m.sessionId === sessionId).map((m) => ({ info: structuredClone(m), parts: [...parts.values()].filter((p) => p.messageId === m.id) })) as MessageWithParts[];
    },
    async enqueuePrompt(sessionId, prompt) { const s = sessions.get(sessionId); if (!s) return 0; (s as unknown as { q: unknown[] }).q ??= []; (s as unknown as { q: unknown[] }).q.push(prompt); return 1; },
    async dequeuePrompt(sessionId) { const s = sessions.get(sessionId) as unknown as { q?: unknown[] } | undefined; return (s?.q?.shift() as never) ?? null; },
    async clearQueuedPrompts() {},
  };
}

function harness(hooks: LifecycleHook[], script: ReturnType<typeof fauxAssistantMessage>[]) {
  const faux = createFauxCore({ models: [{ id: "test-model" }] });
  faux.setResponses(script);
  const toolContext = {
    sessionId: "ses_x",
    userId: "user_1",
    workspaceId: "ws_1",
    agent: "default",
    abort: new AbortController().signal,
    ask: vi.fn(),
    workspace: { list: vi.fn().mockResolvedValue([]), read: vi.fn(), write: vi.fn(), edit: vi.fn() },
    buildSnapshot: vi.fn(),
    runSandbox: vi.fn(),
    setTodos: vi.fn(),
    emitFileEdited: vi.fn(),
    emitArtifact: vi.fn(),
  } as unknown as ToolContext;
  const deps: RunnerDeps = {
    store: memoryStore(),
    registry: new AgentRegistry(),
    streamFnFor: () => faux.streamSimple as never,
    modelFor: () => faux.getModel() as never,
    eventLog: createMemoryEventLog(),
    workspaceFor: (): WorkspaceFiles => ({ list: async () => [], read: async () => null, write: async () => ({ revisionId: "r", diff: "" }), edit: async () => ({ error: "x" }) }),
    buildToolContext: () => toolContext,
    subagentDepth: 1,
    hooks,
  };
  return { runner: new SessionRunner(deps), deps, toolContext };
}

async function sessionFor(deps: RunnerDeps): Promise<SessionInfo> {
  return createFrameworkSession({
    store: deps.store,
    userId: "user_1",
    workspaceId: "ws_1",
    model: { providerId: "faux", modelId: "test-model" },
    prompt: "开始",
  });
}

const fauxText = (text: string): FauxContentBlock => ({ type: "text", text });

describe("生命周期钩子（集成）", () => {
  it("onRunStart / onRunEnd 按序触发并携带 ok 终态", async () => {
    const events: string[] = [];
    const hook: LifecycleHook = {
      name: "recorder",
      onRunStart(i) { events.push(`start:${i.text}`); },
      onRunEnd(i) { events.push(`end:${i.ok ? "ok" : "error"}${i.aborted ? ":aborted" : ""}`); },
    };
    const { runner, deps } = harness([hook], [fauxAssistantMessage("完成。")]);
    const session = await sessionFor(deps);
    await runner.prompt(session.id, { text: "做个小事" });
    await new Promise((r) => setTimeout(r, 40));
    expect(events).toEqual(["start:做个小事", "end:ok"]);
  });

  it("onBeforeToolCall 可拦截工具执行（模型会看到 reason），onAfterToolCall 只读收到 isError", async () => {
    // scripted：一次 todo 工具调用（permission=null，直接到钩子闸口）+ 结束文本
    const script = [
      fauxAssistantMessage([fauxText("我先记录清单。"), fauxToolCall("todo", { todos: [{ content: "步骤", status: "in_progress" }] })]),
      fauxAssistantMessage("被拦了就直说。"),
    ];
    const afterCalls: Array<{ tool: string; isError: boolean }> = [];
    const blocker: LifecycleHook = {
      onBeforeToolCall(i) {
        if (i.tool === "todo") return { block: true, reason: "清单功能已被管理员禁用" };
        return undefined;
      },
      onAfterToolCall(i) { afterCalls.push({ tool: i.tool, isError: i.isError }); },
    };
    const { runner, deps, toolContext } = harness([blocker], script);
    const session = await sessionFor(deps);
    await runner.prompt(session.id, { text: "试试工具" });
    await new Promise((r) => setTimeout(r, 30));
    // 拦截语义：工具体从未执行（setTodos 未发生），且 onAfterToolCall 也不会
    // 为被拦调用发出通知；模型收到 reason 后继续产出后续回复
    expect(toolContext.setTodos).not.toHaveBeenCalled();
    expect(afterCalls.filter((c) => c.tool === "todo" && !c.isError)).toHaveLength(0);
  });

  it("钩子抛错不中断运行", async () => {
    const bad: LifecycleHook = {
      onRunStart() { throw new Error("hook boom"); },
      onRunEnd() { throw new Error("hook boom end"); },
    };
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { runner, deps } = harness([bad], [fauxAssistantMessage("仍然完成。")]);
    const session = await sessionFor(deps);
    await expect(runner.prompt(session.id, { text: "x" })).resolves.toBeDefined();
    warnSpy.mockRestore();
  });
});

describe("firstToolBlock（单元）", () => {
  it("第一个 block 生效；异步与同步混用按序取先", async () => {
    const calls: string[] = [];
    const hooks: LifecycleHook[] = [
      { name: "a", async onBeforeToolCall() { calls.push("a"); await new Promise((r) => setTimeout(r, 5)); return undefined; } },
      { name: "b", onBeforeToolCall() { calls.push("b"); return { block: true, reason: "nope" }; } },
      { name: "c", onBeforeToolCall() { calls.push("c"); return { block: true, reason: "never" }; } },
    ];
    const result = await firstToolBlock(hooks, { sessionId: "s", agent: "default", tool: "bash", args: {} });
    expect(result).toEqual({ block: true, reason: "nope" });
    expect(calls).toEqual(["a", "b"]);
    void fireRunStart; void fireRunEnd;
  });
});

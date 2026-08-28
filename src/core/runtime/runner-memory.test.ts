import { beforeEach, describe, expect, it, vi } from "vitest";
import { createFauxCore, fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";

import { AgentRegistry } from "../agent/registry.js";
import { createMemoryEventLog } from "../events/bus.js";
import { SessionRunner, createFrameworkSession, type RunnerDeps } from "./runner.js";
import type { RunTranscriptMessage } from "./run-transcript.js";
import type { SessionStore } from "../session/store.js";
import type { MessageInfo, Part, SessionInfo } from "../session/types.js";
import type { ToolContext, WorkspaceFiles } from "../tools/context.js";
import { RETRY_PLACEHOLDER_TEXT } from "./run-transcript.js";

// ---- in-memory SessionStore（复刻 runner.test.ts）----

function memoryStore(): SessionStore & { sessions: Map<string, SessionInfo>; messages: Map<string, MessageInfo>; parts: Map<string, Part> } {
  const sessions = new Map<string, SessionInfo>();
  const messages = new Map<string, MessageInfo>();
  const parts = new Map<string, Part>();
  const byMessage = (sessionId: string) =>
    [...messages.values()].filter((info) => info.sessionId === sessionId).map((info) => ({ info, parts: [...parts.values()].filter((part) => part.messageId === info.id) }));
  return {
    sessions,
    messages,
    parts,
    async createSession(info) {
      sessions.set(info.id, structuredClone(info));
    },
    async getSession(id) {
      const session = sessions.get(id);
      return session ? structuredClone(session) : null;
    },
    async updateSession(id, patch) {
      const session = sessions.get(id);
      if (session) sessions.set(id, { ...session, ...patch, time: { ...session.time, updated: new Date().toISOString() } });
    },
    async listSessions() {
      return [...sessions.values()];
    },
    async appendMessage(info) {
      messages.set(info.id, structuredClone(info));
    },
    async updateMessage() {},
    async appendPart(part) {
      parts.set(part.id, structuredClone(part));
    },
    async updatePart(part) {
      parts.set(part.id, structuredClone(part));
    },
    async getMessages(sessionId) {
      return byMessage(sessionId);
    },
    async enqueuePrompt(sessionId, prompt) {
      const session = sessions.get(sessionId);
      if (!session) return 0;
      session.queuedPrompts.push(prompt);
      return session.queuedPrompts.length;
    },
    async dequeuePrompt(sessionId) {
      return sessions.get(sessionId)?.queuedPrompts.shift() ?? null;
    },
    async clearQueuedPrompts(sessionId) {
      const session = sessions.get(sessionId);
      if (session) session.queuedPrompts = [];
    },
  };
}

// ---- test fixtures（复刻 runner.test.ts）----

function fakeToolContext(): ToolContext {
  return {
    sessionId: "ses_x",
    userId: "user_1",
    workspaceId: "ws_1",
    agent: "default",
    abort: new AbortController().signal,
    ask: vi.fn(),
    workspace: fakeWorkspace(),
    buildSnapshot: vi.fn().mockResolvedValue({ files: [] }),
    runSandbox: vi.fn().mockResolvedValue({ ok: true, exitCode: 0, outputText: "ok", durationMs: 5, artifacts: [] }),
    setTodos: vi.fn(),
    emitFileEdited: vi.fn(),
    emitArtifact: vi.fn(),
  } as unknown as ToolContext;
}

function fakeWorkspace(): WorkspaceFiles {
  return {
    list: vi.fn().mockResolvedValue([{ path: "a.ts", bytes: 10 }]),
    read: vi.fn().mockResolvedValue({ path: "a.ts", content: "const a = 1;" }),
    write: vi.fn().mockResolvedValue({ revisionId: "rev_1", diff: "diff" }),
    edit: vi.fn().mockResolvedValue({ revisionId: "rev_2", diff: "diff2" }),
  };
}

function fakeSandbox() {
  return {
    buildSnapshot: vi.fn().mockResolvedValue({ revisionId: null, files: [] }),
    run: vi.fn().mockResolvedValue({ ok: true, exitCode: 0, outputText: "ok", durationMs: 5, artifacts: [] }),
  };
}

async function makeSession(store: SessionStore): Promise<SessionInfo> {
  return createFrameworkSession({
    store,
    userId: "user_1",
    workspaceId: "ws_1",
    model: { providerId: "faux", modelId: "test-model" },
    prompt: "测试任务",
  });
}

async function waitFor(condition: () => boolean, timeoutMs = 3_000): Promise<void> {
  const start = Date.now();
  while (!condition()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitFor 超时");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

type MemoryHarness = {
  runner: SessionRunner;
  store: SessionStore;
  memoryCalls: { sessionId: string; text: string }[];
  memorySection: string | undefined;
  memoryError: Error | null;
  runEnds: { sessionId: string; workspaceId?: string; newMessages?: RunTranscriptMessage[] }[];
};

function makeMemoryHarness(script: ReturnType<typeof fauxAssistantMessage>[]): MemoryHarness {
  const faux = createFauxCore({ models: [{ id: "test-model" }] });
  faux.setResponses(script);
  const store = memoryStore();
  const toolContext = fakeToolContext();
  const harness: MemoryHarness = {
    store,
    memoryCalls: [],
    memorySection: "相关记忆：之前讨论过部署脚本。",
    memoryError: null,
    runEnds: [],
    runner: undefined as unknown as SessionRunner,
  };
  const deps: RunnerDeps = {
    store,
    registry: new AgentRegistry(),
    streamFnFor: () => faux.streamSimple as never,
    modelFor: () => faux.getModel() as never,
    eventLog: createMemoryEventLog(),
    workspaceFor: () => fakeWorkspace(),
    sandbox: fakeSandbox(),
    buildToolContext: () => toolContext,
    subagentDepth: 1,
    memoryContextFor: async (session, text) => {
      if (harness.memoryError) throw harness.memoryError;
      harness.memoryCalls.push({ sessionId: session.id, text });
      return harness.memorySection;
    },
    hooks: [
      {
        name: "collect-run-end",
        onRunEnd(input) {
          harness.runEnds.push({ sessionId: input.sessionId, workspaceId: input.workspaceId, newMessages: input.newMessages });
        },
      },
    ],
  };
  harness.runner = new SessionRunner(deps);
  return harness;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("SessionRunner 记忆接入（批次二）", () => {
  it("memoryContextFor 返回文本：正常完成，注入文本不落 store", async () => {
    const harness = makeMemoryHarness([fauxAssistantMessage("任务完成。")]);
    const session = await makeSession(harness.store);

    await harness.runner.prompt(session.id, { text: "部署脚本怎么写" });
    await waitFor(() => harness.runEnds.length >= 1);

    expect(harness.memoryCalls).toEqual([{ sessionId: session.id, text: "部署脚本怎么写" }]);
    expect(harness.runEnds[0]!.workspaceId).toBe(session.workspaceId);
    // onRunEnd 只含本次新增消息，不含 memory 注入段
    expect(harness.runEnds[0]!.newMessages).toEqual<RunTranscriptMessage[]>([
      { role: "user", text: "部署脚本怎么写" },
      { role: "assistant", text: "任务完成。" },
    ]);
  });

  it("memoryContextFor 抛错：run 不受影响，仍触发 onRunEnd", async () => {
    const harness = makeMemoryHarness([fauxAssistantMessage("任务完成。")]);
    harness.memoryError = new Error("recall 网络炸了");
    const session = await makeSession(harness.store);

    await harness.runner.prompt(session.id, { text: "随便跑跑" });
    await waitFor(() => harness.runEnds.length >= 1);

    expect(harness.memoryCalls).toEqual([]);
    expect(harness.runEnds[0]!.newMessages?.map((message) => message.text)).toContain("随便跑跑");
  });

  it("排队出队续跑：每次 runLoop 都触发一次 memoryContextFor，newMessages 只含各自 run", async () => {
    const harness = makeMemoryHarness([fauxAssistantMessage("第一轮完成。"), fauxAssistantMessage("第二轮完成。")]);
    const session = await makeSession(harness.store);

    const first = harness.runner.prompt(session.id, { text: "第一条" });
    const second = harness.runner.prompt(session.id, { text: "第二条" });
    await Promise.all([first, second]);
    await waitFor(() => harness.runEnds.length >= 2);

    expect(harness.memoryCalls.map((call) => call.text)).toEqual(["第一条", "第二条"]);
    const texts = harness.runEnds.map((runEnd) => runEnd.newMessages?.map((message) => message.text));
    expect(texts[0]).toEqual(["第一条", "第一轮完成。"]);
    expect(texts[1]).toEqual(["第二条", "第二轮完成。"]);
  });

  it("memoryContextFor 返回 undefined：不注入、行为零变化", async () => {
    const harness = makeMemoryHarness([fauxAssistantMessage("任务完成。")]);
    harness.memorySection = undefined;
    const session = await makeSession(harness.store);

    await harness.runner.prompt(session.id, { text: "无记忆运行" });
    await waitFor(() => harness.runEnds.length >= 1);

    expect(harness.memoryCalls).toHaveLength(1);
    expect(harness.runEnds[0]!.newMessages?.[0]).toEqual({ role: "user", text: "无记忆运行" });
  });

  it("RETRY_PLACEHOLDER_TEXT 与 runner F6 注入文本一致", () => {
    expect(RETRY_PLACEHOLDER_TEXT).toBe("（上轮回复生成中断，请继续完成回复。）");
  });
});

import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { createFauxCore, fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";

import { AgentRegistry } from "../agent/registry.js";
import { SessionRunner, createFrameworkSession, isRetryableError, isSessionActive, type RunnerDeps } from "../runtime/runner.js";
import type { SessionStore } from "../session/store.js";
import type { MessageInfo, MessageWithParts, Part, SessionInfo } from "../session/types.js";
import type { ToolContext, WorkspaceFiles } from "../tools/context.js";
import type { ToolDef } from "../tools/def.js";
import { createMemoryEventLog } from "../events/bus.js";

// ---- in-memory SessionStore ----

function memoryStore(): SessionStore & { sessions: Map<string, SessionInfo>; messages: Map<string, MessageInfo>; parts: Map<string, Part> } {
  const sessions = new Map<string, SessionInfo>();
  const messages = new Map<string, MessageInfo>();
  const parts = new Map<string, Part>();
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
    async updateMessage(id, patch) {
      const message = messages.get(id);
      if (message) messages.set(id, { ...message, ...patch } as MessageInfo);
    },
    async appendPart(part) {
      parts.set(part.id, structuredClone(part));
    },
    async updatePart(part) {
      parts.set(part.id, structuredClone(part));
    },
    async getMessages(sessionId) {
      const result: MessageWithParts[] = [];
      for (const message of messages.values()) {
        if (message.sessionId !== sessionId) continue;
        result.push({ info: structuredClone(message), parts: [...parts.values()].filter((part) => part.messageId === message.id) });
      }
      return result;
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

// ---- test fixtures ----

function fakeToolContext(): ToolContext & { calls: { sandbox: { program: string }[]; todos: unknown[] } } {
  const calls = { sandbox: [] as { program: string }[], todos: [] as unknown[] };
  return {
    sessionId: "ses_x",
    userId: "user_1",
    workspaceId: "ws_1",
    agent: "default",
    abort: new AbortController().signal,
    ask: vi.fn(),
    workspace: {
      list: vi.fn().mockResolvedValue([{ path: "a.ts", bytes: 10 }]),
      read: vi.fn().mockResolvedValue({ path: "a.ts", content: "const a = 1;" }),
      write: vi.fn().mockResolvedValue({ revisionId: "rev_1", diff: "diff" }),
      edit: vi.fn().mockResolvedValue({ revisionId: "rev_2", diff: "diff2" }),
    },
    buildSnapshot: vi.fn().mockResolvedValue({ files: [] }),
    runSandbox: vi.fn().mockImplementation(async (input: { command: { program: string } }) => {
      calls.sandbox.push({ program: input.command.program });
      return { ok: true, exitCode: 0, outputText: "构建成功", durationMs: 5, artifacts: [] };
    }),
    setTodos: vi.fn().mockImplementation(async (todos: unknown) => {
      calls.todos.push(todos);
    }),
    emitFileEdited: vi.fn(),
    emitArtifact: vi.fn(),
    calls,
  } as unknown as ToolContext & { calls: { sandbox: { program: string }[]; todos: unknown[] } };
}

function makeHarness(script: ReturnType<typeof fauxAssistantMessage>[]) {
  const faux = createFauxCore({ models: [{ id: "test-model" }] });
  faux.setResponses(script);
  const store = memoryStore();
  const toolContext = fakeToolContext();
  const eventLog = createMemoryEventLog();
  // Collect all published events for assertions (mirrors the SSE fan-out).
  const published: { type: string; data: unknown; seq: number }[] = [];
  const logAppend = eventLog.append.bind(eventLog);
  eventLog.append = async (event) => {
    const persisted = await logAppend(event);
    published.push({ type: persisted.type, data: persisted.data, seq: persisted.seq });
    return persisted;
  };
  const deps: RunnerDeps = {
    store,
    registry: new AgentRegistry(),
    streamFnFor: () => faux.streamSimple as never,
    modelFor: () => faux.getModel() as never,
    eventLog,
    workspaceFor: () => fakeWorkspace(),
    sandbox: fakeSandbox(),
    buildToolContext: () => toolContext,
    subagentDepth: 1,
  };
  return { runner: new SessionRunner(deps), store, toolContext, faux, published, deps };
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
    run: vi.fn().mockResolvedValue({ ok: true, exitCode: 0, outputText: "构建成功", durationMs: 5, artifacts: [] }),
  };
}

async function makeSession(store: ReturnType<typeof memoryStore>): Promise<SessionInfo> {
  return createFrameworkSession({
    store,
    userId: "user_1",
    workspaceId: "ws_1",
    model: { providerId: "faux", modelId: "test-model" },
    prompt: "测试任务",
  });
}

function publishedTypes(published: { type: string }[]): string[] {
  return published.map((event) => event.type);
}

function lastStatus(published: { type: string; data: unknown }[]): string | null {
  const statuses = published
    .filter((event) => event.type === "session.status")
    .map((event) => (event.data as { status?: string }).status);
  return statuses[statuses.length - 1] ?? null;
}

async function waitFor(condition: () => boolean, timeoutMs = 3_000): Promise<void> {
  const start = Date.now();
  while (!condition()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitFor 超时");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function storeHasCompletedTool(store: ReturnType<typeof memoryStore>): boolean {
  return [...store.parts.values()].some((part) => part.type === "tool" && part.state.status === "completed");
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("SessionRunner", () => {
  it("text-only run: emits full part chain and settles idle", async () => {
    const { runner, store, published: harness } = makeHarness([fauxAssistantMessage("任务完成，已读取 1 个文件。")]);
    const session = await makeSession(store);

    await runner.prompt(session.id, { text: "读取代码" });
    await waitFor(() => publishedTypes(harness).filter((type) => type === "session.status").length >= 2);

    const types = publishedTypes(harness);
    expect(types).toContain("message.updated");
    expect(types).toContain("message.part.updated");
    expect(types).toContain("session.status");

    const messages = await store.getMessages(session.id);
    const user = messages.find((entry) => entry.info.role === "user");
    expect(user).toBeDefined();
    expect(user!.parts).toEqual([expect.objectContaining({ type: "text", text: "读取代码" })]);
    const assistant = messages.find((entry) => entry.info.role === "assistant");
    expect(assistant).toBeDefined();
    const textPart = assistant!.parts.find((part) => part.type === "text");
    expect(textPart).toBeDefined();
    expect((textPart as Extract<Part, { type: "text" }>).text).toContain("任务完成");
    expect(assistant!.parts.some((part) => part.type === "step-start")).toBe(true);
    expect(assistant!.parts.some((part) => part.type === "step-finish")).toBe(true);
  });

  it("prompt 传入的 model 回写 session.model（旁路不再读到建会话时的旧模型）", async () => {
    const { runner, store, published: harness } = makeHarness([fauxAssistantMessage("已切换模型完成。")]);
    const session = await makeSession(store);
    expect(session.model).toEqual({ providerId: "faux", modelId: "test-model" });

    await runner.prompt(session.id, { text: "换个模型跑", model: { providerId: "faux", modelId: "switched" } });
    await waitFor(() => lastStatus(harness) === "idle");

    // 回写后：压缩阈值（contextWindowFor）、总结陈词（summarizeRun）、
    // 子代理继承、宿主侧标题生成读 session.model 时都跟随当轮模型
    const updated = await store.getSession(session.id);
    expect(updated!.model).toEqual({ providerId: "faux", modelId: "switched" });
  });

  it("repairs structurally truncated raw tool JSON before PI validates and executes it", async () => {
    const received: string[] = [];
    const echoTool: ToolDef = {
      id: "echo",
      label: "回声",
      description: "测试工具参数修复",
      parameters: z.object({ text: z.string().min(1) }),
      permission: () => null,
      async execute(args) {
        received.push(args.text);
        return { title: "回声", output: args.text };
      },
    };
    const { runner, store, published: harness, deps } = makeHarness([
      fauxAssistantMessage([fauxToolCall("echo", '{"text":"修复成功"' as never)]),
      fauxAssistantMessage("已完成。"),
    ]);
    deps.tools = [echoTool];
    const session = await makeSession(store);

    await runner.prompt(session.id, { text: "调用工具" });
    await waitFor(() => lastStatus(harness) === "idle");

    expect(received).toEqual(["修复成功"]);
    expect(storeHasCompletedTool(store)).toBe(true);
  });

  it("retries on a retryable upstream failure and still delivers the reply", async () => {
    const { runner, store, faux, published: harness } = makeHarness([
      fauxAssistantMessage("", { stopReason: "error", errorMessage: "terminated" }),
      fauxAssistantMessage("重试后的回复"),
    ]);
    const session = await makeSession(store);

    await runner.prompt(session.id, { text: "生成回复" });
    await waitFor(() => faux.state.callCount >= 2);
    await waitFor(() => publishedTypes(harness).filter((type) => type === "session.status").length >= 2);

    // 重试成功：不发 session.error，状态 idle，回复文本来自第二次生成。
    expect(harness.filter((event) => event.type === "session.error")).toHaveLength(0);
    expect(lastStatus(harness)).toBe("idle");
    const messages = await store.getMessages(session.id);
    const assistant = messages.filter((entry) => entry.info.role === "assistant");
    // 第一条是失败占位（空文本），第二条是重试回复。
    const textPart = assistant.flatMap((entry) => entry.parts).find((part) => part.type === "text" && (part as { text?: string }).text);
    expect((textPart as Extract<Part, { type: "text" }> | undefined)?.text).toContain("重试后的回复");
  });

  it("retries up to 5 times on repeated retryable failures before giving up", { timeout: 30_000 }, async () => {
    const { runner, store, faux, published: harness } = makeHarness([
      fauxAssistantMessage("", { stopReason: "error", errorMessage: "terminated" }),
      fauxAssistantMessage("", { stopReason: "error", errorMessage: "terminated" }),
      fauxAssistantMessage("", { stopReason: "error", errorMessage: "terminated" }),
      fauxAssistantMessage("", { stopReason: "error", errorMessage: "terminated" }),
      fauxAssistantMessage("", { stopReason: "error", errorMessage: "terminated" }),
      fauxAssistantMessage("", { stopReason: "error", errorMessage: "terminated" }),
    ]);
    const session = await makeSession(store);

    await runner.prompt(session.id, { text: "生成回复" });
    // 首次 + 最多 5 次重试 = 6 次调用；退避累计 0.5+1+2+4+8 = 15.5s，放宽等待窗口。
    await waitFor(() => faux.state.callCount >= 6, 20_000);
    await waitFor(() => publishedTypes(harness).includes("session.error"), 20_000);

    expect(faux.state.callCount).toBe(6);
    expect(lastStatus(harness)).toBe("idle");
    const errors = harness.filter((event) => event.type === "session.error");
    expect(errors).toHaveLength(1);
    expect((errors[0]!.data as { message?: string }).message).toContain("terminated");
  });

  it("treats rate-limit and gateway errors as retryable (P1)", async () => {
    for (const message of ["HTTP 429 too many requests", "503 service unavailable", "502 bad gateway", "rate limit exceeded, retry after 10s"]) {
      expect(isRetryableError(message)).toBe(true);
    }
    // 普通数字不误匹配（\b 边界）
    expect(isRetryableError("输出 1429 tokens")).toBe(false);
    // 确定性错误仍不重试
    expect(isRetryableError("余额不足")).toBe(false);
    expect(isRetryableError("invalid api key")).toBe(false);
  });

  it("does not retry deterministic errors (auth/billing)", async () => {
    const { runner, store, faux, published: harness } = makeHarness([
      fauxAssistantMessage("", { stopReason: "error", errorMessage: "余额不足" }),
    ]);
    const session = await makeSession(store);

    await runner.prompt(session.id, { text: "生成回复" });
    await waitFor(() => publishedTypes(harness).includes("session.error"));

    expect(faux.state.callCount).toBe(1);
    expect(lastStatus(harness)).toBe("idle");
  });

  it("runs from the immutable Agent Version when a resolver is configured", async () => {
    const { runner, store, published: harness, deps } = makeHarness([fauxAssistantMessage("版本代理完成。")]);
    const resolve = vi.fn().mockResolvedValue({
      agent: {
        name: "versioned-agent",
        description: "版本快照",
        mode: "primary",
        steps: 1,
        prompt: "你是版本快照代理。",
        permission: [],
      },
    });
    deps.agentResolver = { resolve };
    const session = await createFrameworkSession({
      store,
      userId: "user_1",
      workspaceId: "ws_1",
      agent: "default",
      agentId: "agt_1",
      agentVersionId: "agtver_1",
      model: { providerId: "faux", modelId: "test-model" },
    });

    await runner.prompt(session.id, { text: "按版本执行" });
    await waitFor(() => lastStatus(harness) === "idle");

    expect(resolve).toHaveBeenCalledWith(expect.objectContaining({ agentId: "agt_1", agentVersionId: "agtver_1" }));
    const assistant = [...store.messages.values()].find((message) => message.role === "assistant");
    expect(assistant?.agent).toBe("versioned-agent");
  });

  it("bash run: permission.asked → once reply → sandbox executes → tool part completes", async () => {
    const { runner, store, toolContext, published: harness } = makeHarness([
      fauxAssistantMessage([fauxToolCall("bash", { program: "npm", args: ["run", "build"] })]),
      fauxAssistantMessage("构建完成。"),
    ]);
    const session = await makeSession(store);

    await runner.prompt(session.id, { text: "构建项目" });
    // The run suspends on the bash permission ask.
    await waitFor(() => publishedTypes(harness).includes("permission.asked"));
    const asked = harness.find((event) => event.type === "permission.asked");
    const request = (asked as unknown as { data: { request: { id: string; patterns: string[] } } }).data.request;
    expect(request.patterns).toEqual(["npm run build"]);

    const replied = await runner.replyPermission(session.id, request.id, "once");
    expect(replied).toBe(true);

    await waitFor(() => lastStatus(harness) === "idle");
    // The event chain is fanned out asynchronously; wait until the completed
    // tool part lands in the store.
    await waitFor(() => storeHasCompletedTool(store));

    expect(toolContext.calls.sandbox).toEqual([{ program: "npm" }]);
    const messages = await store.getMessages(session.id);
    const toolPart = messages.flatMap((entry) => entry.parts).find((part) => part.type === "tool");
    expect(toolPart).toBeDefined();
    const state = (toolPart as Extract<Part, { type: "tool" }>).state;
    expect(state.status).toBe("completed");
    if (state.status === "completed") expect(state.output).toContain("构建成功");
  });

  it("bash run: reject blocks execution and the model sees the reason", async () => {
    const { runner, store, toolContext, published: harness } = makeHarness([
      fauxAssistantMessage([fauxToolCall("bash", { program: "rm", args: ["-rf", "dist"] })]),
      fauxAssistantMessage("好的，我不执行删除。"),
    ]);
    const session = await makeSession(store);

    await runner.prompt(session.id, { text: "清理构建产物" });
    await waitFor(() => publishedTypes(harness).includes("permission.asked"));
    const asked = harness.find((event) => event.type === "permission.asked");
    const request = (asked as unknown as { data: { request: { id: string } } }).data.request;

    await runner.replyPermission(session.id, request.id, "reject", "先备份");
    await waitFor(() => lastStatus(harness) === "idle");
    await waitFor(() => [...store.parts.values()].some((part) => part.type === "tool" && part.state.status === "error"));

    expect(toolContext.calls.sandbox).toEqual([]);
    const toolPart = (await store.getMessages(session.id)).flatMap((entry) => entry.parts).find((part) => part.type === "tool");
    expect((toolPart as Extract<Part, { type: "tool" }>).state.status).toBe("error");
  });

  it("waits for a stopped run to settle before abort resolves", async () => {
    const { runner, store, published: harness } = makeHarness([
      fauxAssistantMessage([fauxToolCall("bash", { program: "npm", args: ["run", "build"] })]),
    ]);
    const session = await makeSession(store);

    await runner.prompt(session.id, { text: "构建项目" });
    await waitFor(() => publishedTypes(harness).includes("permission.asked"));
    expect(isSessionActive(session.id)).toBe(true);

    await runner.abort(session.id);

    expect(isSessionActive(session.id)).toBe(false);
    expect(lastStatus(harness)).toBe("idle");
  });

  it("pauses after an uncertain side effect and does not execute the next tool", async () => {
    const execute = vi.fn().mockResolvedValue({
      title: "外部动作状态未知",
      output: "请求已发出，但无法确认最终状态。",
      metadata: { outcome: "unknown" },
    });
    const uncertainTool: ToolDef = {
      id: "uncertain",
      label: "不确定动作",
      description: "测试一个可能已经产生副作用但状态未知的动作。",
      parameters: z.object({ value: z.string() }),
      permission: () => null,
      execute,
    };
    const { runner, store, published: harness, deps } = makeHarness([
      fauxAssistantMessage([fauxToolCall("uncertain", { value: "first" })]),
      fauxAssistantMessage([fauxToolCall("uncertain", { value: "second" })]),
    ]);
    deps.tools = [uncertainTool];
    const session = await makeSession(store);

    await runner.prompt(session.id, { text: "执行外部动作" });
    await waitFor(() => lastStatus(harness) === "waiting_input");

    expect(execute).toHaveBeenCalledTimes(1);
    expect(store.sessions.get(session.id)?.queuedPrompts).toHaveLength(0);
    const toolParts = [...store.parts.values()].filter((part): part is Extract<Part, { type: "tool" }> => part.type === "tool");
    expect(toolParts.some((part) => part.state.status === "error" && part.state.metadata?.outcome === "unknown")).toBe(true);
    expect(lastStatus(harness)).toBe("waiting_input");
  });

  it("queues a prompt submitted mid-run and drains it after settlement", async () => {
    const { runner, store, faux, published: harness } = makeHarness([fauxAssistantMessage([fauxToolCall("bash", { program: "sleep", args: ["1"] })])]);
    const session = await makeSession(store);

    await runner.prompt(session.id, { text: "第一个任务" });
    await waitFor(() => publishedTypes(harness).includes("permission.asked"));

    // Mid-run prompt goes to the FIFO queue.
    const queued = await runner.prompt(session.id, { text: "第二个任务" });
    expect(queued).toEqual({ queued: true });
    expect(store.sessions.get(session.id)?.queuedPrompts).toHaveLength(1);

    // Approve → first run settles → queued prompt drains with the next scripted response.
    faux.appendResponses([fauxAssistantMessage("第一个完成。"), fauxAssistantMessage("第二个完成。")]);
    const asked = harness.find((event) => event.type === "permission.asked");
    await runner.replyPermission(session.id, (asked as unknown as { data: { request: { id: string } } }).data.request.id, "once");

    await waitFor(() => store.sessions.get(session.id)?.queuedPrompts.length === 0);
    await waitFor(() => {
      const userMessages = [...store.messages.values()].filter((message) => message.role === "user");
      return userMessages.length >= 2;
    });
    const userMessages = [...store.messages.values()].filter((message) => message.role === "user");
    expect(userMessages).toHaveLength(2);
  });

  it("rebuildMessages reconstructs PI context from persisted parts", async () => {
    const { runner, store } = makeHarness([fauxAssistantMessage("第一轮回答。")]);
    const session = await makeSession(store);
    await runner.prompt(session.id, { text: "第一轮问题" });
    await waitFor(() => {
      const statuses = [...store.messages.values()];
      return statuses.some((m) => m.role === "assistant");
    });

    const fresh = makeHarness([fauxAssistantMessage("基于第一轮继续。")]);
    // Point the new runner at the same store to simulate a process restart.
    const restarted = new SessionRunner({
      store,
      registry: new AgentRegistry(),
      streamFnFor: () => fresh.faux.streamSimple as never,
      modelFor: () => fresh.faux.getModel() as never,
      eventLog: fresh.deps.eventLog as never,
      workspaceFor: () => fakeWorkspace(),
      sandbox: fresh.deps.sandbox,
      buildToolContext: () => fakeToolContext(),
      subagentDepth: 1,
    });
    await restarted.prompt(session.id, { text: "第二轮问题" });
    await waitFor(() => [...store.messages.values()].filter((message) => message.role === "assistant").length >= 2);
    expect([...store.messages.values()].filter((message) => message.role === "assistant")).toHaveLength(2);
  });

  it("spawnSubagent creates a stamped child session (unit)", async () => {
    const { runner, store } = makeHarness([]);
    const registry = new AgentRegistry();
    const parent = await makeSession(store);
    // Drive the private spawn directly: asserts child creation + inheritance
    // without depending on two interleaved FI loops in one test process.
    type SpawnFn = (parent: SessionInfo, input: { description: string; prompt: string; subagentType: string }, registry: AgentRegistry, engine: never) => Promise<{ childSessionId: string }>;
    const permissionEngine = { ask: async () => "once" } as never;
    const childId = await (runner as unknown as { spawnSubagent: SpawnFn })
      .spawnSubagent(parent, { description: "分析模块", prompt: "分析 src 结构", subagentType: "general" }, registry, permissionEngine)
      .then((result) => result.childSessionId)
      .catch(() => null);
    // The child may fail to complete (no scripted stream for it), but it must
    // have been created with the correct stamping.
    const child = childId ? await store.getSession(childId) : [...store.sessions.values()].find((candidate) => candidate.parentId === parent.id);
    if (child) {
      expect(child.parentId).toBe(parent.id);
      expect(child.agent).toBe("general");
      expect(child.workspaceId).toBe(parent.workspaceId);
      expect(child.title).toBe("分析模块");
    } else {
      // Depth/registry guard prevented creation — acceptable only if it threw
      // before creating; assert the parent has no orphan child then.
      expect([...store.sessions.values()].filter((s) => s.parentId === parent.id)).toHaveLength(0);
    }
  });

  it("spawnSubagent publishes started/step/finished events to the parent stream", async () => {
    const { runner, store, published } = makeHarness([]);
    const registry = new AgentRegistry();
    const parent = await makeSession(store);
    type SpawnFn = (parent: SessionInfo, input: { description: string; prompt: string; subagentType: string }, registry: AgentRegistry, engine: never) => Promise<{ childSessionId: string }>;
    const permissionEngine = { ask: async () => "once" } as never;
    await (runner as unknown as { spawnSubagent: SpawnFn })
      .spawnSubagent(parent, { description: "分析模块", prompt: "分析 src 结构", subagentType: "general" }, registry, permissionEngine)
      .catch(() => null);
    const types = published.map((event) => event.type);
    // started 必发；finished 无论成功/失败都必须收口（幂等收口，父流不悬挂）
    expect(types.filter((t) => t === "subagent.started")).toHaveLength(1);
    expect(types.filter((t) => t === "subagent.finished")).toHaveLength(1);
    // 事件投递到父会话流，且 id 一致
    const started = published.find((event) => event.type === "subagent.started") as { data: { parentSessionId: string; agent: string; task: string } };
    expect(started.data.parentSessionId).toBe(parent.id);
    expect(started.data.agent).toBe("general");
    expect(started.data.task).toBe("分析模块");
    const finished = published.find((event) => event.type === "subagent.finished") as { data: { state: string; durationMs: number; toolCalls: number } };
    expect(["completed", "error"]).toContain(finished.data.state);
    expect(typeof finished.data.durationMs).toBe("number");
    expect(typeof finished.data.toolCalls).toBe("number");
  });

  it("task tool end-to-end: parent spawns a subagent that completes and returns its summary", async () => {
    const { runner, store, published: harness } = makeHarness([
      fauxAssistantMessage([fauxToolCall("task", { description: "分析模块", prompt: "分析 src 目录结构", subagent_type: "general" })]),
      fauxAssistantMessage("子代理结论：模块结构清晰，共 3 个文件。"),
      fauxAssistantMessage("父代理总结：已通过子代理完成分析。"),
    ]);
    const session = await makeSession(store);

    await runner.prompt(session.id, { text: "派一个子代理分析模块" });
    // task 在 builtinDefaults 里落到 "*": allow，无需审批；子代理在 task 工具
    // 执行中完整跑完（单进程双 PI 循环用顺序响应驱动），父 idle 即全链路结束
    await waitFor(() => lastStatus(harness) === "idle");
    await waitFor(() => [...store.sessions.values()].some((candidate) => candidate.parentId === session.id));

    // 子会话创建并烙印父会话属性
    const child = [...store.sessions.values()].find((candidate) => candidate.parentId === session.id)!;
    expect(child.agent).toBe("general");
    expect(child.workspaceId).toBe(session.workspaceId);
    expect(child.title).toBe("分析模块");

    // 子代理的回复落库（嵌套 runLoop 完整跑完）
    const childMessages = await store.getMessages(child.id);
    expect(childMessages.some((entry) => entry.info.role === "assistant")).toBe(true);

    // 父会话收到 subtask part 链接子会话，且最终回复来自父代理（摘要已回传上下文）
    const subtask = [...store.parts.values()].find((part) => part.type === "subtask");
    expect(subtask).toBeDefined();
    expect((subtask as Extract<Part, { type: "subtask" }>).childSessionId).toBe(child.id);
    const parentMessages = await store.getMessages(session.id);
    const parentText = parentMessages
      .flatMap((entry) => entry.parts)
      .filter((part): part is Extract<Part, { type: "text" }> => part.type === "text")
      .map((part) => part.text)
      .join("\n");
    expect(parentText).toContain("父代理总结");
  });

  it("task tool rejects when depth cap reached (child cannot re-spawn)", async () => {
    const { store } = makeHarness([]);
    const registry = new AgentRegistry();
    // Build a child session (parentId set) and verify the runner marks depth.
    const parent = await makeSession(store);
    const { createFrameworkSession } = await import("../runtime/runner.js");
    const child = await createFrameworkSession({ store, userId: "user_1", workspaceId: "ws_1", model: { providerId: "faux", modelId: "test-model" } });
    await store.updateSession(child.id, { parentId: parent.id });
    // The depth walk from the child sees 1 ancestor; with subagentDepth 1 it must refuse.
    const runner = new SessionRunner({ store, registry, eventLog: createMemoryEventLog(), workspaceFor: () => fakeWorkspace(), streamFnFor: () => { throw new Error("no stream"); }, modelFor: () => { throw new Error("no model"); }, subagentDepth: 1 });
    const childSession = (await store.getSession(child.id))!;
    type SpawnFn = (parent: SessionInfo, input: { description: string; prompt: string; subagentType: string }, registry: AgentRegistry, engine: never) => Promise<{ childSessionId: string }>;
    await expect(
      (runner as unknown as { spawnSubagent: SpawnFn }).spawnSubagent(childSession, { description: "x", prompt: "y", subagentType: "general" }, registry, { ask: async () => "once" } as never),
    ).rejects.toThrow("深度超过限制");
  });

  it("循环防护：edit 同一 (path, oldText) 反复失败时先注入指令再拦截重试", async () => {
    const editArgs = { path: "a.ts", oldText: "missing", newText: "x" };
    const { runner, store, toolContext, published: harness } = makeHarness([
      fauxAssistantMessage([fauxToolCall("edit", editArgs)]),
      fauxAssistantMessage([fauxToolCall("edit", editArgs)]),
      fauxAssistantMessage([fauxToolCall("edit", editArgs)]),
      fauxAssistantMessage("完成。"),
    ]);
    (toolContext.workspace.edit as ReturnType<typeof vi.fn>).mockResolvedValue({ error: "oldText 不存在" });
    (toolContext.workspace.read as ReturnType<typeof vi.fn>).mockResolvedValue({ path: "a.ts", content: "const a = 1;" });
    const session = await makeSession(store);

    await runner.prompt(session.id, { text: "改代码" });
    await waitFor(() => lastStatus(harness) === "idle");

    // 第 3 次被 beforeToolCall 拦截，真正执行的只有前两次
    expect(toolContext.workspace.edit).toHaveBeenCalledTimes(2);
    const errors = [...store.parts.values()]
      .filter((part): part is Extract<Part, { type: "tool" }> => part.type === "tool")
      .flatMap((part) => (part.state.status === "error" ? [part.state.error ?? ""] : []));
    // 第 2 次失败注入策略指令，第 3 次拦截理由也带循环防护前缀
    expect(errors.filter((error) => error.includes("循环防护")).length).toBeGreaterThanOrEqual(2);
    expect(errors.some((error) => error.includes("先用 read 读取"))).toBe(true);
  });

  it("循环防护：同一工具连续 3 次同响应失败，第 3 次注入改变策略指令", async () => {
    const flakyTool: ToolDef = {
      id: "flaky",
      label: "总是失败",
      description: "测试用：永远失败",
      parameters: z.object({ attempt: z.number() }),
      permission: () => null,
      async execute() {
        throw new Error("upstream rejected");
      },
    };
    const { runner, store, published: harness, deps } = makeHarness([
      fauxAssistantMessage([fauxToolCall("flaky", { attempt: 1 })]),
      fauxAssistantMessage([fauxToolCall("flaky", { attempt: 2 })]),
      fauxAssistantMessage([fauxToolCall("flaky", { attempt: 3 })]),
      fauxAssistantMessage("完成。"),
    ]);
    deps.tools = [flakyTool];
    const session = await makeSession(store);

    await runner.prompt(session.id, { text: "调 flaky" });
    await waitFor(() => lastStatus(harness) === "idle");

    const errors = [...store.parts.values()]
      .filter((part): part is Extract<Part, { type: "tool" }> => part.type === "tool")
      .flatMap((part) => (part.state.status === "error" ? [part.state.error ?? ""] : []));
    expect(errors).toHaveLength(3);
    // 前两次是原始错误，第 3 次被断路器覆写为策略指令
    expect(errors.filter((error) => error.includes("循环防护"))).toHaveLength(1);
    expect(errors[0]!).not.toContain("循环防护");
  });

  describe("contextWindowFor（压缩阈值来源）", () => {
    const session = { id: "ses_1", model: { providerId: "faux", modelId: "long-ctx" } } as never;

    function makeRunner(modelFor: RunnerDeps["modelFor"], compactionWindow = 128_000): SessionRunner {
      const deps: RunnerDeps = {
        store: memoryStore(),
        registry: new AgentRegistry(),
        streamFnFor: () => {
          throw new Error("no stream");
        },
        modelFor,
        eventLog: createMemoryEventLog(),
        workspaceFor: () => fakeWorkspace(),
        subagentDepth: 1,
        compaction: { enabled: true, contextWindow: compactionWindow, summaryModel: null },
      };
      return new SessionRunner(deps);
    }

    const windowFor = (runner: SessionRunner) =>
      (runner as unknown as { contextWindowFor: (s: never) => number }).contextWindowFor(session);

    it("优先取模型目录给的真实窗口，而非 runtime 级全局配置", () => {
      // 断层修复点：长窗口模型不再被 128k 提前压缩
      const runner = makeRunner(() => ({ contextWindow: 1_000_000 }) as never);
      expect(windowFor(runner)).toBe(1_000_000);
    });

    it("模型未暴露窗口时回落全局配置（旧行为）", () => {
      const runner = makeRunner(() => ({}) as never);
      expect(windowFor(runner)).toBe(128_000);
    });

    it("modelFor 抛错时不阻断压缩，回落全局配置", () => {
      const runner = makeRunner(() => {
        throw new Error("unknown provider");
      });
      expect(windowFor(runner)).toBe(128_000);
    });

    it("窗口非正数视为无效，回落全局配置", () => {
      // 0 会让压缩每轮都触发，比用保守默认值严重
      const runner = makeRunner(() => ({ contextWindow: 0 }) as never);
      expect(windowFor(runner)).toBe(128_000);
    });
  });
});

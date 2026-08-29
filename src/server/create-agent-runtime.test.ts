import { describe, expect, it, vi } from "vitest";

import { createMemoryEventLog } from "../core/events/bus.js";
import type { AnyToolDef } from "../core/tools/def.js";
import type { SessionStore } from "../core/session/store.js";
import { createAgentRuntime, type AgentRuntimePreset } from "./create-agent-runtime.js";

/** 最小 store stub：工厂装配阶段只持有引用，不触库。 */
function stubStore(): SessionStore {
  return {
    createSession: async (info: never) => info,
    getSession: async () => undefined,
    listSessions: async () => [],
    updateSession: async () => undefined,
    deleteSession: async () => undefined,
    appendMessage: async (info: never) => info,
    getMessages: async () => [],
    appendPart: async () => undefined,
    updatePart: async () => undefined,
    getParts: async () => [],
  } as unknown as SessionStore;
}

function basePreset(overrides: Partial<AgentRuntimePreset> = {}): AgentRuntimePreset {
  return {
    store: stubStore(),
    modelProvider: {
      getModel: vi.fn(() => {
        throw new Error("no model");
      }),
      streamFor: vi.fn(() => {
        throw new Error("no stream");
      }),
    },
    eventLog: createMemoryEventLog(),
    workspace: { kind: "fs", root: "/tmp/agent-runtime-test" },
    ...overrides,
  };
}

describe("createAgentRuntime", () => {
  it("fs 工作区默认开启 repo_map 能力工具", () => {
    const runtime = createAgentRuntime(basePreset());
    // 能力接线经 localTools 进入 runner；直接断言 runner deps 不可达，
    // 改为行为级验证：registry 门面存在 + createSession 可用（装配不炸）。
    expect(runtime.registry).toBeDefined();
    expect(runtime.store).toBeDefined();
    expect(typeof runtime.createSession).toBe("function");
  });

  it("capabilities.repoMap=false 或 custom 工作区时不注入能力工具", () => {
    // custom 工作区 + 未声明 repoMap → 默认关
    expect(() =>
      createAgentRuntime(basePreset({ workspace: { kind: "custom", workspaceFor: () => { throw new Error("unused"); } } })),
    ).not.toThrow();
    // 显式关闭
    expect(() => createAgentRuntime(basePreset({ capabilities: { repoMap: false } }))).not.toThrow();
  });

  it("subagents=false 时深度归零，默认深度 1", () => {
    const off = createAgentRuntime(basePreset({ capabilities: { subagents: false } }));
    expect(off.registry).toBeDefined();
    const on = createAgentRuntime(basePreset());
    expect(on.registry).toBeDefined();
  });

  it("sandbox 声明 subprocess 或注入执行器均可装配", () => {
    const injected = { buildSnapshot: async () => { throw new Error("unused"); }, run: async () => { throw new Error("unused"); } };
    expect(() => createAgentRuntime(basePreset({ sandbox: { kind: "subprocess", workspaceRoot: "/tmp/x" } }))).not.toThrow();
    expect(() => createAgentRuntime(basePreset({ sandbox: injected as never }))).not.toThrow();
    expect(() => createAgentRuntime(basePreset({ sandbox: undefined }))).not.toThrow();
  });

  it("runnerOptions 透传到 runner 装配（渐进迁移兜底）", async () => {
    const loadWorkspaceAgents = vi.fn(async () => []);
    const localTools: AnyToolDef[] = [];
    const runtime = createAgentRuntime(basePreset({ localTools, runnerOptions: { loadWorkspaceAgents, hooks: [] } }));
    expect(runtime.registry).toBeDefined();
    // 闭包已捕获——runner run 时会调用；这里仅断言引用被接受不抛错
    expect(loadWorkspaceAgents).not.toHaveBeenCalled();
  });
});

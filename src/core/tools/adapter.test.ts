import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { adaptTool, permissionForCall, repairToolArguments } from "../tools/adapter.js";
import type { ToolContext } from "../tools/context.js";
import type { ToolDef } from "../tools/def.js";

function fakeContext(): ToolContext {
  return {
    sessionId: "ses_1",
    userId: "user_1",
    workspaceId: "ws_1",
    agent: "default",
    abort: new AbortController().signal,
    ask: vi.fn(),
    workspace: { list: vi.fn(), read: vi.fn(), write: vi.fn(), edit: vi.fn() },
    buildSnapshot: vi.fn(),
    runSandbox: vi.fn(),
    setTodos: vi.fn(),
    emitFileEdited: vi.fn(),
    emitArtifact: vi.fn(),
  };
}

const echoTool: ToolDef = {
  id: "echo",
  label: "回声",
  description: "返回输入文本",
  parameters: z.object({ text: z.string().min(1).max(100) }),
  permission: (args) => ({ permission: "echo", patterns: [args.text.slice(0, 20)] }),
  async execute(args) {
    return { title: `回声：${args.text}`, output: args.text };
  },
};

describe("adaptTool", () => {
  it("exposes name/label/description and JSON-Schema parameters", () => {
    const tool = adaptTool(echoTool, fakeContext());
    expect(tool.name).toBe("echo");
    expect(tool.label).toBe("回声");
    const parameters = tool.parameters as { type: string; properties: Record<string, unknown>; required: string[] };
    expect(parameters.type).toBe("object");
    expect(parameters.properties).toHaveProperty("text");
    expect(parameters.required).toEqual(["text"]);
  });

  it("executes with validated args and returns text content + title detail", async () => {
    const tool = adaptTool(echoTool, fakeContext());
    const result = await tool.execute("call_1", { text: "你好" });
    expect(result.content).toEqual([{ type: "text", text: "你好" }]);
    expect(result.details).toEqual({ title: "回声：你好" });
  });

  it("throws a model-friendly error on invalid args", async () => {
    const tool = adaptTool(echoTool, fakeContext());
    await expect(tool.execute("call_2", { text: "" })).rejects.toThrow("参数无效");
  });

  it("repairs a safely truncated JSON argument object before validation", async () => {
    const tool = adaptTool(echoTool, fakeContext());
    const repaired = tool.prepareArguments?.('{"text":"你好"');
    expect(repaired).toEqual({ text: "你好" });
    await expect(tool.execute("call_repaired", repaired)).resolves.toMatchObject({ details: { title: "回声：你好" } });
  });

  it("does not guess an unterminated JSON string", () => {
    expect(repairToolArguments('{"text":"unclosed}')).toBe('{"text":"unclosed}');
  });

  it("unwraps once- or twice-encoded JSON tool arguments", () => {
    expect(repairToolArguments('{"text":"hello"}')).toEqual({ text: "hello" });
    expect(repairToolArguments(JSON.stringify(JSON.stringify({ text: "hello" })))).toEqual({ text: "hello" });
  });

  it("truncates oversized output and records it in details", async () => {
    const bigTool: ToolDef = {
      ...echoTool,
      id: "big",
      parameters: z.object({}),
      permission: () => null,
      async execute() {
        // 头部/尾部可辨识，验证 head+tail 裁剪而非硬截断
        return { title: "大输出", output: `HEAD${"x".repeat(60 * 1024)}TAIL` };
      },
    };
    const tool = adaptTool(bigTool, fakeContext());
    const result = await tool.execute("call_3", {});
    const text = (result.content[0] as { text: string }).text;
    expect(Buffer.byteLength(text, "utf8")).toBeLessThanOrEqual(48 * 1024);
    expect(result.details).toMatchObject({ truncated: true });
    // head+tail：文首文末都保留，中间换成裁剪标记（尾部常带报错信息，不能切掉）
    expect(text.startsWith("HEAD")).toBe(true);
    expect(text.endsWith("TAIL")).toBe(true);
    expect(text).toContain("输出过长已裁剪");
  });

  it("propagates tool execution errors", async () => {
    const failTool: ToolDef = { ...echoTool, parameters: z.object({}), permission: () => null, async execute() { throw new Error("爆炸"); } };
    const tool = adaptTool(failTool, fakeContext());
    await expect(tool.execute("call_4", {})).rejects.toThrow("爆炸");
  });
});

describe("permissionForCall", () => {
  it("maps valid args through the tool's permission function", () => {
    const defs = new Map<string, ToolDef>([["echo", echoTool]]);
    expect(permissionForCall(defs, "echo", { text: "hello world" })).toEqual({ permission: "echo", patterns: ["hello world"] });
  });

  it("returns null for unknown tools and invalid args", () => {
    const defs = new Map<string, ToolDef>([["echo", echoTool]]);
    expect(permissionForCall(defs, "missing", {})).toBeNull();
    expect(permissionForCall(defs, "echo", { text: "" })).toBeNull();
  });
});

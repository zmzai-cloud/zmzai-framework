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

  it("persists the full output to the workspace on truncation (R2)", async () => {
    const ctx = fakeContext();
    (ctx.workspace.write as ReturnType<typeof vi.fn>).mockResolvedValue({ revisionId: "r1", diff: "" });
    const bigTool: ToolDef = {
      ...echoTool,
      id: "big",
      parameters: z.object({}),
      permission: () => null,
      async execute() {
        return { title: "大输出", output: `HEAD${"x".repeat(60 * 1024)}TAIL` };
      },
    };
    const tool = adaptTool(bigTool, ctx);
    const result = await tool.execute("call_log", {});
    // 完整原文落盘到 .zmzai/outputs/<sessionId>/<toolCallId>.log
    expect(ctx.workspace.write).toHaveBeenCalledWith(
      expect.objectContaining({
        path: ".zmzai/outputs/ses_1/call_log.log",
        author: "agent",
      }),
    );
    const firstCall = (ctx.workspace.write as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as { content: string } | undefined;
    expect(firstCall).toBeDefined();
    const writtenArg = firstCall!;
    expect(writtenArg.content.startsWith("HEAD")).toBe(true);
    expect(writtenArg.content.endsWith("TAIL")).toBe(true);
    // 裁剪标记回填真实路径，details 携带 outputPath
    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain(".zmzai/outputs/ses_1/call_log.log");
    expect(result.details).toMatchObject({ truncated: true, outputPath: ".zmzai/outputs/ses_1/call_log.log" });
  });

  it("degrades silently when output persistence fails", async () => {
    const ctx = fakeContext();
    (ctx.workspace.write as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("磁盘满了"));
    const bigTool: ToolDef = {
      ...echoTool,
      id: "big",
      parameters: z.object({}),
      permission: () => null,
      async execute() {
        return { title: "大输出", output: "x".repeat(60 * 1024) };
      },
    };
    const tool = adaptTool(bigTool, ctx);
    const result = await tool.execute("call_fail", {});
    // 落盘失败不影响主链路：结果照常返回，只是没有 outputPath
    expect(result.details).toMatchObject({ truncated: true });
    expect((result.details as Record<string, unknown>).outputPath).toBeUndefined();
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

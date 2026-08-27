import { describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";

import { McpStdioClient } from "./client.js";
import { startMcpServers } from "./servers.js";

const fixtureServer = fileURLToPath(new URL("./fixtures/echo-mcp-server.mjs", import.meta.url));
const nodeBin = process.execPath;

function echoSpec() {
  return { type: "stdio" as const, command: nodeBin, args: [fixtureServer] };
}

describe("McpStdioClient", () => {
  it("完成 initialize 握手并列出工具（含自动翻页）", async () => {
    const client = new McpStdioClient({ command: nodeBin, args: [fixtureServer] });
    await client.start();
    try {
      const tools = await client.listTools();
      expect(tools.map((t) => t.name)).toEqual(["echo", "fail"]);
      expect(tools[0]!.inputSchema).toMatchObject({ type: "object" });
    } finally {
      client.close();
    }
  });

  it("callTool 回传文本；isError=true 语义保留", async () => {
    const client = new McpStdioClient({ command: nodeBin, args: [fixtureServer] });
    await client.start();
    try {
      const ok = await client.callTool("echo", { msg: "你好" });
      expect(ok).toEqual({ text: "echo:你好", isError: false });

      const bad = await client.callTool("fail", {});
      expect(bad.isError).toBe(true);
      expect(bad.text).toBe("boom");
    } finally {
      client.close();
    }
  });

  it("服务器进程退出后未决请求被拒绝（不再悬挂）", async () => {
    const client = new McpStdioClient(
      // /bin/true 立即退出且不响应 initialize → 握手失败或进程错误
      { command: "/bin/true" },
      { connectTimeoutMs: 4000 },
    );
    await expect(client.start()).rejects.toThrow(/MCP/i);
    expect(client.connected).toBe(false);
  }, 10_000);

  it("连接不可用时 request 直接拒绝", async () => {
    const client = new McpStdioClient({ command: nodeBin, args: ["-e", ""] });
    await expect(client.request("tools/list")).rejects.toThrow(/不可用/);
  });
});

describe("startMcpServers", () => {
  it("把 stdio server 的工具装配成命名空间化 ExternalToolDef", async () => {
    const pool = await startMcpServers([{ name: "demo.server", spec: echoSpec() }]);
    try {
      expect(pool.statuses).toEqual([
        { name: "demo.server", state: "connected", transport: "stdio", tools: ["echo", "fail"] },
      ]);
      expect(pool.defs.map((d) => d.id)).toEqual(["mcp__demo_server__echo", "mcp__demo_server__fail"]);
      const def = pool.defs.find((d) => d.id === "mcp__demo_server__echo")!;
      expect(def.parametersJsonSchema).toMatchObject({ type: "object" });

      const mapped = def.permission({ msg: "hi" });
      expect(mapped).toMatchObject({ permission: "mcp", patterns: ["demo.server/echo"], always: ["demo.server/*"] });

      await expect(def.execute({ msg: "你好" }, stubContext())).resolves.toMatchObject({
        title: "demo.server/echo",
        output: "echo:你好",
      });
      const failDef = pool.defs.find((d) => d.id === "mcp__demo_server__fail")!;
      await expect(failDef.execute({}, stubContext())).rejects.toThrow(/boom|isError/);
    } finally {
      pool.dispose();
    }
  });

  it("坏命令只记 error status，不影响其它 server", async () => {
    const pool = await startMcpServers([
      { name: "ghost", spec: { type: "stdio", command: "/nonexistent/zmzai-ghost-binary" } },
      { name: "real", spec: echoSpec() },
    ], { connectTimeoutMs: 4000 });
    try {
      const ghost = pool.statuses.find((s) => s.name === "ghost")!;
      expect(ghost.state).toBe("error");
      expect(ghost.error).toBeTruthy();
      expect(pool.statuses.find((s) => s.name === "real")!.state).toBe("connected");
      expect(pool.defs.map((d) => d.id).every((id) => id.startsWith("mcp__real_"))).toBe(true);
    } finally {
      pool.dispose();
    }
  }, 15_000);

  it("非 stdio transport 明确报不支持", async () => {
    const pool = await startMcpServers([
      { name: "remote", spec: { type: "sse", url: "https://example.com/sse" } },
    ]);
    expect(pool.statuses[0]).toMatchObject({ name: "remote", state: "error", tools: [] });
    expect(pool.statuses[0]!.error).toContain("stdio");
    pool.dispose();
  });
});

function stubContext() {
  return {
    sessionId: "ses_test",
    userId: "local",
    workspaceId: "local",
    agent: "default",
    toolCallId: "call_test",
    workspace: { list: async () => [], read: async () => null, write: async () => null, edit: async () => ({ error: "nope" }) },
  } as never;
}

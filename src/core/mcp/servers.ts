import type { ExternalToolDef } from "../tools/def.js";
import type { PluginMcpServer } from "../agent/plugin.js";
import { McpStdioClient, type McpToolInfo } from "./client.js";
import { createMcpHttpClient, type McpClientLike } from "./http-client.js";

/** 把已解析的插件 mcp.json server 配置接成可用的 MCP 工具集：逐个启动
 *  （stdio 子进程），listTools 后生成命名空间化的 ExternalToolDef。
 *  单个 server 连不上不影响其它——错误进 statuses，由宿主决定透出方式。 */

export type McpServerStatus = {
  name: string;
  state: "connected" | "error";
  transport: string;
  tools: string[];
  error?: string;
};

export type McpServerEntry = { name: string; spec: PluginMcpServer };

export type McpPoolResult = {
  /** 成功连接的 server 提供的工具（id 形如 mcp__<server>__<tool>）。 */
  defs: ExternalToolDef[];
  statuses: McpServerStatus[];
  /** 统一关停（宿主退出时调用）。 */
  dispose: () => void;
};

const idSafe = (value: string) => value.replace(/[^A-Za-z0-9_-]/g, "_");

function sanitizeInputSchema(schema: Record<string, unknown> | undefined): Record<string, unknown> {
  if (!schema || typeof schema !== "object") return { type: "object", properties: {}, additionalProperties: true };
  return schema;
}

function summarizeArgs(args: Record<string, unknown>): string {
  try {
    const json = JSON.stringify(args);
    return json.length <= 2000 ? json : json.slice(0, 2000) + "…";
  } catch {
    return "";
  }
}

type ConnectOutcome = { kind: "ok"; client: McpClientLike; tools: McpToolInfo[] } | { kind: "error"; message: string };

export type McpPoolOptions = {
  connectTimeoutMs?: number;
  /** stdio 命令白名单（P0 隔离）：透传给 McpStdioClient，basename 匹配。 */
  allowedCommands?: string[];
};

async function connectOne(entry: McpServerEntry, opts: McpPoolOptions): Promise<ConnectOutcome> {
  let client: McpClientLike;
  if (entry.spec.type === "stdio") {
    const stdio = new McpStdioClient(
      { command: entry.spec.command, args: entry.spec.args, env: entry.spec.env, cwd: entry.spec.cwd },
      { connectTimeoutMs: opts.connectTimeoutMs, allowedCommands: opts.allowedCommands },
    );
    client = stdio;
  } else {
    const http = createMcpHttpClient(entry.spec, { requestTimeoutMs: opts.connectTimeoutMs });
    if (!http) return { kind: "error", message: `不支持的 transport：${entry.spec.type as string}` };
    client = http;
  }
  try {
    await startHandshake(entry.spec, client);
    const tools = await client.listTools();
    return { kind: "ok", client, tools };
  } catch (error) {
    client.close();
    return { kind: "error", message: (error as Error).message };
  }
}

/** 三种传输的握手统一化：stdio 客户端自带 start()；HTTP 两种在各自的实现里。 */
async function startHandshake(_spec: PluginMcpServer, client: McpClientLike): Promise<void> {
  const withStart = client as McpClientLike & { start?: () => Promise<void> };
  if (typeof withStart.start === "function") await withStart.start();
}

export async function startMcpServers(entries: McpServerEntry[], opts: McpPoolOptions = {}): Promise<McpPoolResult> {
  const clients = new Map<string, McpClientLike>();
  const defs: ExternalToolDef[] = [];
  const settled = await Promise.allSettled(entries.map((entry) => connectOne(entry, opts)));
  const statuses: McpServerStatus[] = entries.map((entry, index) => {
    const outcome = settled[index]!;
    if (outcome.status === "fulfilled" && outcome.value.kind === "ok") {
      const { client, tools } = outcome.value;
      clients.set(entry.name, client);
      for (const tool of tools) {
        defs.push(mcpToolDef(entry, tool, client));
      }
      return { name: entry.name, state: "connected" as const, transport: entry.spec.type, tools: tools.map((t) => t.name) };
    }
    const message =
      outcome.status === "rejected"
        ? String((outcome.reason as Error)?.message ?? outcome.reason)
        : outcome.value.kind === "error"
          ? outcome.value.message
          : "未知错误";
    return { name: entry.name, state: "error" as const, transport: entry.spec.type, tools: [], error: message };
  });

  return {
    defs,
    statuses,
    dispose: () => {
      for (const client of clients.values()) client.close();
      clients.clear();
    },
  };
}

function mcpToolDef(entry: McpServerEntry, tool: McpToolInfo, client: McpClientLike): ExternalToolDef {
  const label = `${entry.name}/${tool.name}`;
  const id = `mcp__${idSafe(entry.name)}__${idSafe(tool.name)}`;
  return {
    id,
    label,
    description: tool.description ?? `MCP 工具 ${label}`,
    parametersJsonSchema: sanitizeInputSchema(tool.inputSchema),
    permission: (args) => ({
      permission: "mcp",
      patterns: [`${entry.name}/${tool.name}`],
      always: [`${entry.name}/*`],
      metadata: { server: entry.name, tool: tool.name, argsSummary: summarizeArgs(args) },
    }),
    executionMode: "sequential",
    async execute(args) {
      const result = await client.callTool(tool.name, args);
      if (result.isError) throw new Error(result.text || `MCP 工具 ${label} 返回 isError`);
      return {
        title: label,
        output: result.text || "（无文本输出）",
        metadata: { server: entry.name, tool: tool.name },
      };
    },
  };
}

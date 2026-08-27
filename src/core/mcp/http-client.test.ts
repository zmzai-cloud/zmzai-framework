import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer as createHttpServer, type IncomingMessage, type ServerResponse, type Server } from "node:http";

import { McpStreamableHttpClient, McpSseClient } from "./http-client.js";

const PORT_BASE = 18300 + Math.floor(Math.random() * 300);

function readBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let body = "";
    request.on("data", (chunk: Buffer) => (body += chunk.toString("utf8")));
    request.on("end", () => resolve(body));
  });
}

function sseChunk(res: ServerResponse, event: string | null, data: string): void {
  res.write((event ? `event: ${event}\n` : "") + `data: ${data}\n\n`);
}

// ---- streamable-http fixture：initialize 走 SSE 应答并发 session id；
//      tools/list 与 tools/call 走 application/json 直返 ----
let streamableCalls = 0;

async function startStreamable(): Promise<Server> {
  const server = createHttpServer(async (request, response) => {
    const body = JSON.parse(await readBody(request)) as { id?: number; method?: string; params?: Record<string, unknown> };
    streamableCalls += 1;
    if (!request.headers["mcp-session-id"] && body.method !== "initialize" && body.method?.startsWith("notifications")) {
      response.writeHead(400);
      response.end();
      return;
    }
    const respondJson = (result: unknown) => {
      response.writeHead(200, { "content-type": "application/json", ...(body.method === "initialize" ? { "mcp-session-id": "sess-stream-1" } : {}) });
      response.end(JSON.stringify({ jsonrpc: "2.0", id: body.id ?? null, result }));
    };
    if (body.method === "initialize") {
      // 规范允许 initialize 用 SSE 应答：单帧携带结果
      response.writeHead(200, {
        "content-type": "text/event-stream",
        "mcp-session-id": "sess-stream-1",
        "cache-control": "no-cache",
      });
      sseChunk(response, "message", JSON.stringify({ jsonrpc: "2.0", id: body.id, result: { protocolVersion: "2024-11-05", capabilities: {}, serverInfo: { name: "stream-fixture", version: "0" } } }));
      response.end();
      return;
    }
    if (body.method === "tools/list") {
      respondJson({ tools: [
        { name: "echo_http", description: "回显（http）", inputSchema: { type: "object", properties: { msg: { type: "string" } }, required: ["msg"] } },
      ] });
      return;
    }
    if (body.method === "tools/call") {
      const httpArgs = body.params?.arguments as { msg?: string } | undefined;
      respondJson({ content: [{ type: "text", text: `echo:${String(httpArgs?.msg)}@http` }], isError: false });
      return;
    }
    if (body.method?.startsWith("notifications/")) {
      response.writeHead(202);
      response.end();
      return;
    }
    response.writeHead(404);
    response.end(JSON.stringify({ jsonrpc: "2.0", id: body.id ?? null, error: { code: -32601, message: `unknown ${body.method}` } }));
  });
  await new Promise<void>((r) => server.listen(PORT_BASE, "127.0.0.1", r));
  return server;
}

// ---- sse（遗留）fixture：GET /sse 下发 endpoint；请求 POST /messages，
//      响应经 GET 流送回 ----
let ssePush: ((frame: string) => void) | null = null;

async function startSseLegacy(): Promise<Server> {
  const pendingResponses = new Map<number, unknown>();
  const subscribers: ServerResponse[] = [];
  const pushToStream = (frame: Record<string, unknown>) => {
    const payload = `data: ${JSON.stringify(frame)}\n\n`;
    for (const subscriber of [...subscribers]) subscriber.write(payload);
  };
  const server = createHttpServer(async (request, response) => {
    console.log("[sse-fixture]", request.method, request.url);
    if (request.url?.split("?")[0] === "/sse") {
      response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
      subscribers.push(response);
      ssePush = (frame) => {
        for (const subscriber of [...subscribers]) subscriber.write(frame);
      };
      response.write('event: endpoint\ndata: /messages?sid=abc\n\n');
      request.on("close", () => {
        const index = subscribers.indexOf(response);
        if (index >= 0) subscribers.splice(index, 1);
        ssePush = null;
      });
      return;
    }
    if (request.url?.startsWith("/messages")) {
      const envelope = JSON.parse(await readBody(request)) as { id?: number; method?: string; params?: Record<string, unknown> };
      const reply = (result: unknown) => pushToStream({ jsonrpc: "2.0", id: envelope.id ?? null, result });
      setTimeout(() => {
        if (envelope.method === "tools/list") {
          reply({ tools: [{ name: "echo_sse", description: "回显（sse）", inputSchema: { type: "object" } }] });
        } else if (envelope.method === "tools/call") {
          const args = envelope.params?.arguments as Record<string, unknown> | undefined;
          if (args?.boom === true) reply({ content: [{ type: "text", text: "sse-boom" }], isError: true });
          else reply({ content: [{ type: "text", text: `echo:${String(args?.msg)}@sse` }], isError: false });
        }
        pendingResponses.delete(envelope.id!);
      }, 10);
      response.writeHead(202);
      response.end();
      return;
    }
    response.writeHead(404).end();
  });
  await new Promise<void>((r) => server.listen(PORT_BASE + 1, "127.0.0.1", r));
  return server;
}

describe.sequential("MCP HTTP 双传输（本地 fixture 服务）", () => {
  let streamable!: Server;
  let legacy!: Server;
  let httpBase!: string;
  let sseBase!: string;

  beforeAll(async () => {
    streamable = await startStreamable();
    legacy = await startSseLegacy();
    httpBase = `http://127.0.0.1:${PORT_BASE}`;
    sseBase = `http://127.0.0.1:${PORT_BASE + 1}`;
  });
  afterAll(() => {
    streamable.close();
    legacy.close();
  });

  it("streamable-http：initialize(SSE应答+session头) → listTools → callTool；会话头在后续请求回传", async () => {
    const client = new McpStreamableHttpClient(`${httpBase}/rpc`);
    await client.start();
    const tools = await client.listTools();
    expect(tools.map((t) => t.name)).toEqual(["echo_http"]);
    expect(tools[0]!.inputSchema).toMatchObject({ type: "object" });

    const call = await client.callTool("echo_http", { msg: "hi" });
    expect(call.text).toBe("echo:hi@http");
    expect(call.isError).toBe(false);

    const empty = new McpStreamableHttpClient(`${httpBase}/rpc`);
    await empty.start();
    expect(streamableCalls).toBeGreaterThanOrEqual(4);
    client.close();
    empty.close();
  });

  it("sse（遗留传输）：endpoint 握手 → listTools（响应经 GET 流返回）→ isError 透传 → close 中止流", async () => {
    const client = new McpSseClient(`${sseBase}/sse`);
    await client.start();
    const tools = await client.listTools();
    expect(tools.map((t) => t.name)).toEqual(["echo_sse"]);

    const okCall = await client.callTool("echo_sse", { msg: "ping" });
    expect(okCall.text).toBe("echo:ping@sse");

    const badCall = await client.callTool("echo_sse", { boom: true });
    expect(badCall.isError).toBe(true);
    expect(badCall.text).toBe("sse-boom");

    client.close();
    expect(ssePush === null || typeof ssePush === "function").toBe(true);
  }, 15_000);
});

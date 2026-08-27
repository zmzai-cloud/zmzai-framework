import type { PluginMcpServer } from "../agent/plugin.js";
import type { McpCallResult, McpToolInfo } from "./client.js";

/** MCP HTTP 双传输（P0 收尾）：
 *  - streamable-http（现行规范）：单端点 POST，响应可为 application/json 或
 *    text/event-stream 帧；initialize 下发的 Mcp-Session-Id 需回传；
 *    notifications POST 期望 202。
 *  - sse（遗留）：常开 GET 事件流承载响应；服务端以 endpoint 事件告知 POST 目标。
 *
 *  stdio 走既有 McpStdioClient；三者都满足下方 McpClientLike 结构。 */

export type McpClientLike = {
  listTools(): Promise<McpToolInfo[]>;
  callTool(name: string, args: Record<string, unknown>): Promise<McpCallResult>;
  close(): void;
};

const UA = "zmzai-agent-framework/0.1";
const DEFAULT_TIMEOUT = 30_000;

// ---- 共享件 ----------------------------------------------------------------

type JsonRpcFrame = {
  jsonrpc?: unknown;
  id?: unknown;
  method?: unknown;
  result?: unknown;
  error?: { code?: unknown; message?: string };
};

function parseSseData(data: string): JsonRpcFrame | null {
  try {
    const parsed = JSON.parse(data) as unknown;
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? (parsed as JsonRpcFrame) : null;
  } catch {
    return null;
  }
}

/** 增量 SSE 帧解析：data:/event:/id: 行、空行分帧、`:` 开头为注释心跳。 */
export function createSseParser(onEvent: (event: { event: string | null; data: string }) => void): (chunk: string) => void {
  let buffer = "";
  let dataLines: string[] = [];
  let eventName: string | null = null;

  const flush = () => {
    if (dataLines.length || eventName !== null) onEvent({ event: eventName, data: dataLines.join("\n") });
    dataLines = [];
    eventName = null;
  };

  return (chunk: string) => {
    buffer += chunk;
    let index: number;
    while ((index = buffer.indexOf("\n")) >= 0) {
      const rawLine = buffer.slice(0, index).replace(/\r$/, "");
      buffer = buffer.slice(index + 1);
      if (rawLine === "") {
        flush();
        continue;
      }
      if (rawLine.startsWith(":")) continue;
      const colonAt = rawLine.indexOf(":");
      const field = colonAt === -1 ? rawLine : rawLine.slice(0, colonAt);
      let value = colonAt === -1 ? "" : rawLine.slice(colonAt + 1);
      if (value.startsWith(" ")) value = value.slice(1);
      if (field === "event") eventName = value;
      else if (field === "data") dataLines.push(value);
    }
  };
}

async function httpError(response: Response): Promise<never> {
  let detail = "";
  try {
    detail = (await response.text()).slice(0, 300);
  } catch {
    /* ignore */
  }
  throw new Error(`MCP HTTP 错误 ${response.status} ${response.statusText}${detail ? `：${detail}` : ""}`);
}

class PendingRegistry {
  #nextIdValue = 1;
  readonly #pending = new Map<number, { resolve(v: unknown): void; reject(e: Error): void; timer: NodeJS.Timeout }>();

  get nextId(): number {
    return this.#nextIdValue++;
  }

  register<T>(id: number, timeoutMs: number, label: string): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new Error(`MCP 请求超时：${label}（${timeoutMs}ms）`));
      }, timeoutMs);
      this.#pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer });
    });
  }

  settle(frame: JsonRpcFrame): boolean {
    if (typeof frame.id !== "number") return false;
    const pending = this.#pending.get(frame.id);
    if (!pending) return false;
    this.#pending.delete(frame.id);
    clearTimeout(pending.timer);
    if (frame.error) pending.reject(new Error(`MCP 错误 ${String(frame.error.code ?? "-")}: ${frame.error.message ?? "未知错误"}`));
    else pending.resolve(frame.result);
    return true;
  }

  failAll(error: Error): void {
    for (const [, p] of this.#pending) {
      clearTimeout(p.timer);
      p.reject(error);
    }
    this.#pending.clear();
  }
}

// ---- streamable-http --------------------------------------------------------

export class McpStreamableHttpClient implements McpClientLike {
  readonly #url: string;
  readonly #headers: Record<string, string>;
  readonly #timeoutMs: number;
  #sessionId: string | null = null;
  #closed = false;

  constructor(url: string, opts: { headers?: Record<string, string>; requestTimeoutMs?: number } = {}) {
    this.#url = url;
    this.#headers = opts.headers ?? {};
    this.#timeoutMs = opts.requestTimeoutMs ?? DEFAULT_TIMEOUT;
  }

  async start(): Promise<void> {
    await this.request("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "zmzai-agent-framework", version: "0.1.0" } });
    await this.notify("notifications/initialized");
  }

  private async postJsonRpc(payload: Record<string, unknown>): Promise<unknown> {
    const targetId = typeof payload.id === "number" ? payload.id : null;
    const headers: Record<string, string> = {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "user-agent": UA,
      ...this.#headers,
    };
    if (this.#sessionId) headers["mcp-session-id"] = this.#sessionId;
    const response = await fetch(this.#url, { method: "POST", headers, body: JSON.stringify(payload), signal: AbortSignal.timeout(this.#timeoutMs) });

    const sid = response.headers.get("mcp-session-id");
    if (sid) this.#sessionId = sid;

    if (response.status === 202) return undefined;
    if (!response.ok) await httpError(response);

    const contentType = response.headers.get("content-type") ?? "";
    if (contentType.includes("text/event-stream") && response.body) {
      // SSE 应答：逐帧扫描直到目标 id 的响应出现或流关闭
      return new Promise<unknown>((resolve, reject) => {
        const timer = setTimeout(() => {
          void response.body!.cancel().catch(() => undefined);
          reject(new Error(`MCP 请求超时（流式应答 ${this.#timeoutMs}ms 无 ${targetId} 帧）`));
        }, this.#timeoutMs);
        const reader = response.body!.getReader();
        const decoder = new TextDecoder();
        const parser = createSseParser((event) => {
          const frame = parseSseData(event.data);
          if (!frame || frame.id !== targetId) return;
          clearTimeout(timer);
          void reader.cancel().catch(() => undefined);
          if (frame.error) reject(new Error(`MCP 错误 ${String(frame.error.code ?? "-")}: ${frame.error.message ?? "未知错误"}`));
          else resolve(frame.result);
        });
        void (async () => {
          try {
            for (;;) {
              const { done, value } = await reader.read();
              if (done) break;
              parser(decoder.decode(value, { stream: true }));
            }
            clearTimeout(timer);
            reject(new Error("MCP 流式应答在收到结果前关闭"));
          } catch (error) {
            clearTimeout(timer);
            reject(error instanceof Error ? error : new Error(String(error)));
          }
        })();
      });
    }

    const text = await response.text();
    const frame = parseSseData(text);
    if (!frame) throw new Error("MCP 响应不是合法 JSON-RPC 帧");
    if (frame.id !== targetId && Array.isArray(frame)) throw new Error("MCP 批量响应暂不支持");
    if (frame.error) throw new Error(`MCP 错误 ${String(frame.error.code ?? "-")}: ${frame.error.message ?? "未知错误"}`);
    return frame.result;
  }

  async request(method: string, params?: unknown): Promise<unknown> {
    if (this.#closed) throw new Error(`MCP 连接不可用（${method}）`);
    const id = Math.floor(Math.random() * 2 ** 31);
    return this.postJsonRpc({ jsonrpc: "2.0", id, method, ...(params !== undefined ? { params } : {}) });
  }

  async notify(method: string, params?: unknown): Promise<void> {
    if (this.#closed) return;
    try {
      await this.postJsonRpc({ jsonrpc: "2.0", method, ...(params !== undefined ? { params } : {}) });
    } catch (error) {
      console.warn("[zmzai-agent-framework] mcp notify 失败：", error);
    }
  }

  async listTools(): Promise<McpToolInfo[]> {
    return toolsFromResult(await this.request("tools/list"));
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<McpCallResult> {
    return callFromResult(await this.request("tools/call", { name, arguments: args }));
  }

  close(): void {
    this.#closed = true;
  }
}

// 工具结果归一化（两传输共用）
type ResultWithTools = Record<string, unknown>;

export function toolsFromResult(result: unknown): McpToolInfo[] {
  const container = (typeof result === "object" && result !== null ? result : {}) as ResultWithTools;
  const rawTools = Array.isArray(container.tools) ? container.tools : [];
  return rawTools.flatMap((tool) => {
    if (typeof tool !== "object" || tool === null) return [];
    const record = tool as Record<string, unknown>;
    if (typeof record.name !== "string") return [];
    return [{
      name: record.name,
      ...(typeof record.description === "string" ? { description: record.description } : {}),
      ...(typeof record.inputSchema === "object" && record.inputSchema !== null ? { inputSchema: record.inputSchema as Record<string, unknown> } : {}),
    }];
  });
}

export function callFromResult(result: unknown): McpCallResult {
  const container = (typeof result === "object" && result !== null ? result : {}) as Record<string, unknown>;
  const isError = container.isError === true;
  const text = Array.isArray(container.content)
    ? (container.content as Array<Record<string, unknown>>)
        .map((block) => (block.type === "text" && typeof block.text === "string" ? block.text : ""))
        .filter(Boolean)
        .join("\n")
    : "";
  return { text, isError };
}

// ---- sse（遗留传输）----------------------------------------------------------

export class McpSseClient implements McpClientLike {
  readonly #url: string;
  readonly #headers: Record<string, string>;
  readonly #timeoutMs: number;
  readonly #registry = new PendingRegistry();
  #endpointUrl: string | null = null;
  #abort: AbortController | null = null;
  #closed = false;

  constructor(url: string, opts: { headers?: Record<string, string>; requestTimeoutMs?: number } = {}) {
    this.#url = url;
    this.#headers = opts.headers ?? {};
    this.#timeoutMs = opts.requestTimeoutMs ?? DEFAULT_TIMEOUT;
  }

  async start(): Promise<void> {
    this.#abort = new AbortController();
    const endpointReady = new Promise<void>((resolveEndpoint, failHandshake) => {
      const timer = setTimeout(() => failHandshake(new Error("MCP sse 握手超时（未收到 endpoint 事件）")), this.#timeoutMs);
      timer.unref?.();
      this.#onEndpointResolved = () => {
        clearTimeout(timer);
        resolveEndpoint();
      };
      this.#onHandshakeFail = (e) => {
        clearTimeout(timer);
        failHandshake(e);
      };
    });

    try {
      const response = await fetch(this.#url, {
        headers: { accept: "text/event-stream", "user-agent": UA, ...this.#headers },
        signal: this.#abort.signal,
      });
      if (!response.ok) await httpError(response);
      if (!response.body) throw new Error("MCP sse 无响应体");

      const parser = createSseParser((event) => this.#handleEvent(event.event, event.data));
      void this.#pump(response, parser);

      await endpointReady;
      // initialized 通知：POST 到端点，202 即可
      const ack = await this.postToEndpoint({ jsonrpc: "2.0", method: "notifications/initialized" });
      if (!ack.ok && ack.status !== 202) await httpError(ack);
    } catch (error) {
      this.close();
      throw error instanceof Error ? error : new Error(String(error));
    }
  }

  #onEndpointResolved: (() => void) | null = null;
  #onHandshakeFail: ((error: Error) => void) | null = null;

  async #pump(response: Response, parser: (chunk: string) => void): Promise<void> {
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        parser(decoder.decode(value, { stream: true }));
      }
    } catch {
      /* aborted */
    } finally {
      reader.releaseLock();
      if (this.#onEndpointResolved === null) this.#registry.failAll(new Error("MCP sse 事件流已断开"));
      else {
        const failStart = this.#onHandshakeFail;
        failStart?.(new Error("MCP sse 流在握手前断开"));
      }
    }
  }

  #handleEvent(eventName: string | null, data: string): void {
    if (eventName === "endpoint") {
      // 端点提示常见两种形态：裸相对路径 与 JSON 字符串（如 "\"/mcp\""）；都接受
      let hint = data.trim();
      try {
        const parsed = JSON.parse(hint) as unknown;
        if (typeof parsed === "string") hint = parsed;
      } catch {
        /* 非 JSON 即裸路径 */
      }
      try {
        this.#endpointUrl = new URL(hint, this.#url).toString();
      } catch {
        return;
      }
      const resolver = this.#onEndpointResolved;
      this.#onEndpointResolved = null;
      resolver?.();
      return;
    }
    const frame = parseSseData(data);
    if (frame) this.#registry.settle(frame);
  }

  async postToEndpoint(payload: Record<string, unknown>): Promise<Response> {
    if (!this.#endpointUrl) throw new Error("MCP sse 端点尚未建立");
    return fetch(this.#endpointUrl, {
      method: "POST",
      headers: { "content-type": "application/json", "user-agent": UA, ...this.#headers },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(this.#timeoutMs),
    });
  }

  private async postedRequest(payload: Record<string, unknown>, label: string, registryId: number | null): Promise<unknown> {
    if (registryId === null) return undefined;
    const waitPromise = this.#registry.register<unknown>(registryId, this.#timeoutMs, label);
    const response = await this.postToEndpoint(payload);
    if (!response.ok && response.status !== 202) await httpError(response);
    return waitPromise;
  }

  async listTools(): Promise<McpToolInfo[]> {
    const id = this.#registry.nextId;
    return toolsFromResult(await this.postedRequest({ jsonrpc: "2.0", id, method: "tools/list" }, "tools/list", id));
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<McpCallResult> {
    const id = this.#registry.nextId;
    return callFromResult(
      await this.postedRequest({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } }, `tools/call:${name}`, id),
      );
  }

  async notifyInitialized(): Promise<void> {
    const ack = await this.postToEndpoint({ jsonrpc: "2.0", method: "notifications/initialized" });
    if (!ack.ok && ack.status !== 202) await httpError(ack);
  }

  close(): void {
    this.#closed = true;
    this.#abort?.abort();
    this.#registry.failAll(new Error("MCP 连接已由宿主关闭"));
  }

  get closed(): boolean {
    return this.#closed;
  }
}

// ---- 装配入口 ----------------------------------------------------------------

export function createMcpHttpClient(
  spec: PluginMcpServer,
  opts: { requestTimeoutMs?: number } = {},
): McpClientLike | null {
  switch (spec.type) {
    case "streamable-http":
      return new McpStreamableHttpClient(spec.url, { headers: spec.headers, requestTimeoutMs: opts.requestTimeoutMs });
    case "sse":
      return new McpSseClient(spec.url, { headers: spec.headers, requestTimeoutMs: opts.requestTimeoutMs });
    default:
      return null;
  }
}

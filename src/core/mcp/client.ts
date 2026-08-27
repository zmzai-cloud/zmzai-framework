import { spawn, type ChildProcess } from "node:child_process";

/** Minimal MCP (Model Context Protocol) stdio client. Speaks newline-delimited
 *  JSON-RPC 2.0 over the spawned server's stdin/stdout — the same framing as
 *  the official @modelcontextprotocol/sdk stdio transport, without pulling the
 *  SDK dependency (framework keeps zod/pi as its only runtime deps).
 *
 *  Scope (P0): initialize handshake + tools/list + tools/call. Server→client
 *  requests outside the tool lifecycle are politely refused (-32601) so
 *  compliant servers never hang waiting on sampling/roots we don't offer. */

const PROTOCOL_VERSION = "2024-11-05";
const MAX_FRAME_BYTES = 16 * 1024 * 1024;

export type McpToolInfo = {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
};

export type McpCallResult = {
  /** Concatenated text content blocks; empty when the server returned none. */
  text: string;
  isError: boolean;
};

type JsonRpcRequest = { jsonrpc: "2.0"; id: number; method: string; params?: unknown };
type JsonRpcNotification = { jsonrpc: "2.0"; method: string; params?: unknown };
type JsonRpcResponse = {
  jsonrpc: "2.0";
  id: number | string | null;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
};

type Pending = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
};

export type McpClientOptions = {
  /** Per-request timeout (default 30s). */
  requestTimeoutMs?: number;
  /** initialize 握手超时（default 15s）——含进程启动与首条响应。 */
  connectTimeoutMs?: number;
  /** 子进程工作目录（默认继承当前进程）。 */
  cwd?: string;
  /** 追加到子进程环境的基础变量（在 server env 之前合并，可被覆盖）。 */
  baseEnv?: Record<string, string>;
};

/** 与 PluginMcpServer 的 stdio 形态解耦的最小入参，方便宿主直接构造。 */
export type StdioServerSpec = {
  command: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export class McpStdioClient {
  readonly #spec: StdioServerSpec;
  readonly #opts: Required<Pick<McpClientOptions, "requestTimeoutMs" | "connectTimeoutMs">> & McpClientOptions;
  #child: ChildProcess | null = null;
  #buffer = "";
  #nextId = 1;
  #pending = new Map<number, Pending>();
  #onRequest?: (method: string, params: unknown) => unknown | undefined | Promise<unknown | undefined>;
  #closed = false;

  constructor(spec: StdioServerSpec, opts: McpClientOptions = {}) {
    this.#spec = spec;
    this.#opts = {
      requestTimeoutMs: opts.requestTimeoutMs ?? 30_000,
      connectTimeoutMs: opts.connectTimeoutMs ?? 15_000,
      cwd: opts.cwd,
      baseEnv: opts.baseEnv,
    };
  }

  get connected(): boolean {
    return this.#child !== null && !this.#closed && this.#child.exitCode === null;
  }

  /** 启动子进程并完成 initialize 握手。失败时保证子进程被回收后抛错。 */
  async start(): Promise<void> {
    if (this.connected) return;
    const base = this.#opts.baseEnv ?? Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined));
    const env = { ...base, ...this.#spec.env };

    let child: ChildProcess;
    try {
      child = spawn(this.#spec.command, this.#spec.args ?? [], {
        cwd: this.#spec.cwd ?? this.#opts.cwd,
        env,
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch (error) {
      throw new Error(`MCP server 进程无法启动：${(error as Error).message}`);
    }
    this.#child = child;

    child.stdout!.setEncoding("utf8");
    child.stdout!.on("data", (chunk: string) => this.#consume(chunk));
    // stderr 只做环形摘要收集，便于把启动失败原因带给调用方。
    const stderrTail: string[] = [];
    child.stderr!.setEncoding("utf8");
    child.stderr!.on("data", (chunk: string) => {
      stderrTail.push(chunk);
      if (stderrTail.length > 20) stderrTail.shift();
    });
    this.#stderrTail = stderrTail;

    child.on("error", (error) => {
      this.#failAll(new Error(`MCP server 进程错误：${error.message}`));
    });
    child.on("close", (code, signal) => {
      const detail = stderrTail.length ? `：${stderrTail.join("").trim().slice(-500)}` : "";
      this.#failAll(new Error(`MCP server 已退出（code=${code ?? "null"}${signal ? ` signal=${signal}` : ""}）${detail}`));
      this.#child = null;
    });

    const timeout = setTimeout(() => {
      this.#disposeChild();
      this.#failAll(new Error(`MCP initialize 握手超时（${this.#opts.connectTimeoutMs}ms 无响应）`));
    }, this.#opts.connectTimeoutMs);
    try {
      await this.request("initialize", {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: "zmzai-agent-framework", version: "0.1.0" },
      }, timeout);
      this.notify("notifications/initialized");
    } catch (error) {
      this.close();
      throw error instanceof Error ? error : new Error(String(error));
    } finally {
      clearTimeout(timeout);
    }
  }

  #stderrTail: string[] = [];

  /** tools/list 自动翻页聚合全量工具。 */
  async listTools(): Promise<McpToolInfo[]> {
    const tools: McpToolInfo[] = [];
    let cursor: string | undefined;
    do {
      const result = await this.request("tools/list", cursor ? { cursor } : {}) as Record<string, unknown>;
      if (Array.isArray(result.tools)) {
        for (const tool of result.tools) {
          if (!isRecord(tool) || typeof tool.name !== "string") continue;
          tools.push({
            name: tool.name,
            ...(typeof tool.description === "string" ? { description: tool.description } : {}),
            ...(isRecord(tool.inputSchema) ? { inputSchema: tool.inputSchema } : {}),
          });
        }
      }
      cursor = typeof result.nextCursor === "string" ? result.nextCursor : undefined;
    } while (cursor);
    return tools;
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<McpCallResult> {
    const result = await this.request("tools/call", { name, arguments: args }) as Record<string, unknown>;
    const isError = result.isError === true;
    const text = Array.isArray(result.content)
      ? result.content
          .map((block) => (isRecord(block) && block.type === "text" && typeof block.text === "string" ? block.text : ""))
          .filter(Boolean)
          .join("\n")
      : "";
    return { text, isError };
  }

  request<T = unknown>(method: string, params?: unknown, timerOverride?: NodeJS.Timeout): Promise<T> {
    if (!this.connected) return Promise.reject(new Error(`MCP 连接不可用（method=${method}）`));
    const id = this.#nextId++;
    const timer = timerOverride ?? setTimeout(() => {
      const pending = this.#pending.get(id);
      if (pending) {
        this.#pending.delete(id);
        pending.reject(new Error(`MCP 请求超时：${method}（${this.#opts.requestTimeoutMs}ms）`));
      }
    }, this.#opts.requestTimeoutMs);
    return new Promise<T>((resolve, reject) => {
      this.#pending.set(id, { resolve: resolve as (value: unknown) => void, reject, timer });
      this.#write({ jsonrpc: "2.0", id, method, ...(params !== undefined ? { params } : {}) });
    });
  }

  notify(method: string, params?: unknown): void {
    if (!this.connected) return;
    const frame: JsonRpcNotification = { jsonrpc: "2.0", method, ...(params !== undefined ? { params } : {}) };
    this.#write(frame);
  }

  /** 注册服务器请求回调；返回 false 表示框架不提供该能力（客户端回 -32601）。 */
  onRequest(handler: ((method: string, params: unknown) => unknown | undefined | Promise<unknown | undefined>) | undefined): void {
    this.#onRequest = handler;
  }

  close(): void {
    this.#closed = true;
    this.#disposeChild();
    this.#failAll(new Error("MCP 连接已由宿主关闭"));
  }

  #write(frame: JsonRpcRequest | JsonRpcNotification): void {
    const child = this.#child;
    if (!child || !child.stdin?.writable) return;
    child.stdin.write(JSON.stringify(frame) + "\n");
  }

  #consume(chunk: string): void {
    this.#buffer += chunk;
    let index: number;
    while ((index = this.#buffer.indexOf("\n")) >= 0) {
      const line = this.#buffer.slice(0, index).trim();
      this.#buffer = this.#buffer.slice(index + 1);
      if (!line) continue;
      if (line.length > MAX_FRAME_BYTES) continue;
      let frame: unknown;
      try {
        frame = JSON.parse(line);
      } catch {
        continue; // 非 JSON 行（某些 server 往 stdout 打日志）直接丢弃
      }
      if (!isRecord(frame) || frame.jsonrpc !== "2.0") continue;
      if (typeof frame.id === "number") {
        const pending = this.#pending.get(frame.id);
        if (!pending) continue;
        this.#pending.delete(frame.id);
        clearTimeout(pending.timer);
        const rpcError = frame.error as { code?: number; message?: string } | undefined;
        if (rpcError) {
          pending.reject(new Error(`MCP 错误 ${rpcError.code ?? "-"}: ${rpcError.message ?? "未知错误"}`));
        } else {
          pending.resolve(frame.result);
        }
        continue;
      }
      // 服务器通知忽略；服务器主动请求仅在宿主注册了处理器且其返回非 undefined 时给结果，否则 -32601。
      if (typeof frame.method === "string") {
        void this.#handleServerInitiated(frame.method, frame.params, typeof frame.id !== "undefined" && frame.id !== null ? Number(frame.id) : null);
      }
    }
  }

  async #handleServerInitiated(method: string, params: unknown, id: number | null): Promise<void> {
    const handled = this.#onRequest ? await this.#onRequest(method, params) : undefined;
    if (id === null) return;
    if (handled !== undefined) {
      this.#child?.stdin?.write(JSON.stringify({ jsonrpc: "2.0", id, result: handled }) + "\n");
    } else {
      this.#child?.stdin?.write(JSON.stringify({ jsonrpc: "2.0", id, error: { code: -32601, message: `Method not found: ${method}` } }) + "\n");
    }
  }

  #disposeChild(): void {
    const child = this.#child;
    if (!child) return;
    try {
      child.stdin?.end();
    } catch {
      /* already gone */
    }
    if (child.exitCode === null) {
      child.kill("SIGTERM");
      setTimeout(() => {
        if (child.exitCode === null) child.kill("SIGKILL");
      }, 2000).unref();
    }
  }

  #failAll(error: Error): void {
    for (const [, pending] of this.#pending) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.#pending.clear();
  }
}

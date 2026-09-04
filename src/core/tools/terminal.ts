import { resolve, sep } from "node:path";
import { z } from "zod";

import type { ToolDef } from "./def.js";

/** 交互式终端（P0）：面向 Agent 的长驻/交互式进程能力——`npm run dev`、
 *  watch 模式、会问 y/n 的安装器等，一次性 bash 沙箱跑不了或会卡死。
 *
 *  分层：TerminalManager（环形缓冲 + 会话生命周期）只依赖 TerminalBackend
 *  接口；真正的 PTY vs 管道由宿主注入的 backend 决定（见
 *  adapters/terminal-backend.ts：动态 import node-pty，ABI 不匹配时降级
 *  管道模式）。工具层不需要知道区别。
 *
 *  安全位阶：start 直接在宿主机起进程（不进沙箱），独立权限分类
 *  `terminal` 走审批；read/write/kill 针对已批准创建的会话不再重复询问。 */

export type TerminalSessionStatus = "running" | "exited" | "killed";

export type TerminalSessionInfo = {
  id: string;
  name?: string;
  status: TerminalSessionStatus;
  backend: "pty" | "pipe";
  pid?: number;
  exitCode?: number | null;
  signal?: string | null;
  startedAt: string;
  bytesTotal: number;
};

/** 后端只关心这四件事。onData 之后必须保证 onExit 恰好触发一次。 */
export interface TerminalHandle {
  write(data: string): void;
  kill(signal?: string): void;
  resize?(cols: number, rows: number): void;
}

export interface TerminalBackend {
  readonly kind: "pty" | "pipe";
  start(input: { command: string; cwd: string; env?: Record<string, string>; cols?: number; rows?: number }, hooks: {
    onData(chunk: string): void;
    onExit(result: { exitCode: number | null; signal: string | null }): void;
  }): Promise<TerminalHandle & { pid?: number }>;
}

type RingBuffer = {
  chunks: Buffer;
  /** 已丢弃的头部字节数（绝对游标的原点）。 */
  dropped: number;
  droppedEvents: number;
};

const RING_CAP_DEFAULT = 192 * 1024;

function ringAppend(ring: RingBuffer, chunk: Buffer, capBytes: number): void {
  const merged = ring.chunks.length === 0 ? chunk : Buffer.concat([ring.chunks, chunk]);
  if (merged.length <= capBytes) {
    ring.chunks = merged;
    return;
  }
  const removed = merged.length - capBytes;
  ring.chunks = merged.subarray(removed);
  ring.dropped += removed;
  ring.droppedEvents += 1;
}

export class TerminalManager {
  readonly #backend: TerminalBackend;
  readonly #ringCapBytes: number;
  readonly #maxSessions: number;
  #nextId = 1;
  readonly #sessions = new Map<string, {
    info: TerminalSessionInfo;
    ring: RingBuffer;
    handle: (TerminalHandle & { pid?: number }) | null;
    waiters: (() => void)[];
  }>();

  constructor(backend: TerminalBackend, opts: { ringCapBytes?: number; maxSessions?: number } = {}) {
    this.#backend = backend;
    this.#ringCapBytes = opts.ringCapBytes ?? RING_CAP_DEFAULT;
    this.#maxSessions = opts.maxSessions ?? 16;
  }

  get backendKind(): "pty" | "pipe" {
    return this.#backend.kind;
  }

  async start(input: { name?: string; command: string; cwd: string; env?: Record<string, string>; cols?: number; rows?: number }): Promise<TerminalSessionInfo> {
    // 上限含已退出的会话——一并清理最老的退出会话，还满则拒绝新会话
    if (this.#sessions.size >= this.#maxSessions) {
      const exitedId = [...this.#sessions.entries()].find(([, s]) => s.info.status !== "running")?.[0];
      if (exitedId) this.#sessions.delete(exitedId);
      else throw new Error(`终端会话已达上限 ${this.#maxSessions}：先 terminal_kill 或等现有进程退出`);
    }
    const id = `tty_${String(this.#nextId).padStart(4, "0")}`;
    this.#nextId += 1;
    const session: {
      info: TerminalSessionInfo;
      ring: RingBuffer;
      handle: (TerminalHandle & { pid?: number }) | null;
      waiters: (() => void)[];
    } = {
      info: {
        id,
        ...(input.name ? { name: input.name } : {}),
        status: "running" as const,
        backend: this.#backend.kind,
        startedAt: new Date().toISOString(),
        bytesTotal: 0,
      },
      ring: { chunks: Buffer.alloc(0), dropped: 0, droppedEvents: 0 },
      handle: null as (TerminalHandle & { pid?: number }) | null,
      waiters: [] as (() => void)[],
    };
    this.#sessions.set(id, session);

    const handle = await this.#backend.start(
      { command: input.command, cwd: input.cwd, ...(input.env ? { env: input.env } : {}), ...(input.cols ? { cols: input.cols } : {}), ...(input.rows ? { rows: input.rows } : {}) },
      {
        onData: (chunk) => {
          const buf = Buffer.from(chunk, "utf8");
          session.info.bytesTotal += buf.length;
          ringAppend(session.ring, buf, this.#ringCapBytes);
          for (const wake of session.waiters.splice(0)) wake();
        },
        onExit: ({ exitCode, signal }) => {
          session.info.status = signal && signal !== "" ? "killed" : "exited";
          session.info.exitCode = exitCode;
          if (signal) session.info.signal = signal;
          for (const wake of session.waiters.splice(0)) wake();
        },
      },
    );
    session.handle = handle;
    if (handle.pid != null) session.info.pid = handle.pid;
    return { ...session.info };
  }

  list(): TerminalSessionInfo[] {
    return [...this.#sessions.values()].map((s) => ({ ...s.info }));
  }

  getSession(id: string): TerminalSessionInfo | null {
    const s = this.#sessions.get(id);
    return s ? { ...s.info } : null;
  }

  read(id: string, sinceBytes?: number): { output: string; cursor: number; totalDropped: number; truncatedHead: boolean; session: TerminalSessionInfo } | null {
    const s = this.#sessions.get(id);
    if (!s) return null;
    const origin = s.ring.dropped;
    const from = Math.max(sinceBytes ?? origin, origin); // 早于已被裁剪的头部 → 从现存的最早字节开始并标记截断
    const slice = s.ring.chunks.subarray(from - origin);
    return {
      output: slice.toString("utf8"),
      cursor: origin + s.ring.chunks.length,
      totalDropped: s.ring.dropped,
      truncatedHead: from > (sinceBytes ?? from) || s.ring.dropped > (sinceBytes ?? 0),
      session: { ...s.info },
    };
  }

  write(id: string, text: string): boolean {
    const s = this.#sessions.get(id);
    if (!s?.handle || s.info.status !== "running") return false;
    s.handle.write(text);
    return true;
  }

  resize(id: string, cols: number, rows: number): boolean {
    const s = this.#sessions.get(id);
    if (!s?.handle?.resize || s.info.status !== "running") return false;
    s.handle.resize(cols, rows);
    return true;
  }

  kill(id: string, signal = "SIGTERM"): boolean {
    const s = this.#sessions.get(id);
    if (!s?.handle || s.info.status !== "running") return false;
    s.handle.kill(signal);
    return true;
  }

  disposeAll(signal = "SIGKILL"): void {
    for (const [, s] of this.#sessions) {
      if (s.info.status === "running") {
        try {
          s.handle?.kill(signal);
        } catch {
          /* already gone */
        }
      }
    }
  }
}

// ---------------------------------------------------------------------------
// 工具集

export function createTerminalTools(manager: TerminalManager, opts: { workspaceRoot: () => string }): ToolDef[] {
  const requireSession = (id: string) => manager.getSession(id) ?? (() => { throw new Error(`终端会话不存在：${id}（用 terminal_start 创建，或 terminal_list 查看）`); })();

  const formatInfo = (s: TerminalSessionInfo): string =>
    `[${s.id}]${s.name ? `「${s.name}」` : ""} ${s.status}${s.exitCode != null ? `(exit ${s.exitCode})` : ""}${s.signal ? `(sig ${s.signal})` : ""} · ${s.backend} · 输出累计 ${s.bytesTotal}B`;

  const startTool: ToolDef = {
    id: "terminal_start",
    label: "启动交互式终端",
    description:
      "在本机启动一个长驻/交互式命令（dev server、watch、交互安装器等），立即返回 sessionId 不阻塞对话。输出用 terminal_read 增量读取；交互应答用 terminal_write；结束用 terminal_kill。",
    parameters: z.object({
      command: z.string().min(1).max(2048),
      name: z.string().min(1).max(64).optional(),
      cwd: z.string().max(512).optional(),
      cols: z.number().int().min(20).max(500).optional(),
      rows: z.number().int().min(5).max(200).optional(),
    }),
    permission: (args) => {
      // 复合/管道/命令替换（$()、反引号）只沉淀精确整串：首 token 通配会让
      // `npm run dev && rm -rf ~` 这类命令沉淀出 `npm *`，一次批准全放行。
      const isCompound = /[|><;&]|\$\(|`/.test(args.command);
      const firstToken = args.command.trim().split(/\s+/)[0] ?? "*";
      return {
        permission: "terminal",
        patterns: [args.command],
        always: isCompound ? [args.command] : [args.command, `${firstToken} *`],
        metadata: { command: args.command, ...(args.name ? { name: args.name } : {}) },
      };
    },
    executionMode: "sequential",
    async execute(args) {
      const resolvedCwd = args.cwd ? resolveWithin(opts.workspaceRoot(), args.cwd) : opts.workspaceRoot();
      if (!resolvedCwd) throw new Error(`cwd 必须位于工作区内：${args.cwd}`);
      const info = await manager.start({ command: args.command, cwd: resolvedCwd, name: args.name, cols: args.cols, rows: args.rows });
      const initial = manager.read(info.id)!;
      return {
        title: `终端 ${info.id} 已启动${info.backend === "pipe" ? "（管道模式）" : ""}`,
        output: `${formatInfo(info)}\n$ ${args.command}\n${initial.output ? `--- 初始输出 ---\n${initial.output}` : "（暂无输出，稍后用 terminal_read 轮询）"}`,
        metadata: { sessionId: info.id, backend: info.backend, pid: info.pid ?? null },
      };
    },
  };

  const readTool: ToolDef = {
    id: "terminal_read",
    label: "读取终端输出",
    description:
      "增量读取指定终端自 since 字节游标以来的输出；返回新的游标（下次传回即可续读）。输出的末尾包含会话状态；进程已退出时会注明退出码，无需继续轮询。",
    parameters: z.object({
      sessionId: z.string().min(1).max(32),
      since: z.number().int().min(0).optional(),
    }),
    permission: () => null,
    async execute(args) {
      const result = manager.read(args.sessionId, args.since);
      if (!result) throw new Error(`终端会话不存在：${args.sessionId}`);
      const tailNote =
        result.session.status === "running"
          ? "\n（仍在运行，可继续等待后带新游标 terminal_read）"
          : `\n（已结束：exit=${result.session.exitCode ?? "-"}${result.session.signal ? ` sig=${result.session.signal}` : ""}，不会再有新输出）`;
      const headWarning = result.truncatedHead ? `…[头部 ${result.totalDropped} B 已被滚动丢弃]…\n` : "";
      return {
        title: `读 ${args.sessionId}（+${Buffer.byteLength(result.output)}B）`,
        output: `${headWarning}${result.output || "（无新输出）"}\ncursor=${result.cursor}\n${formatInfo(result.session)}${tailNote}`,
        metadata: { sessionId: args.sessionId, cursor: result.cursor, status: result.session.status, exitCode: result.session.exitCode ?? undefined, backend: result.session.backend },
      };
    },
  };

  const writeTool: ToolDef = {
    id: "terminal_write",
    label: "向终端写入",
    description: "向运行中的终端发送输入（如回答 y/n 提示）。默认自动补换行；newline=false 可发送裸按键序列（Ctrl+C 用 \"\\u0003\"）。",
    parameters: z.object({
      sessionId: z.string().min(1).max(32),
      text: z.string().min(1).max(8192),
      newline: z.boolean().optional(),
    }),
    permission: () => null,
    executionMode: "sequential",
    async execute(args) {
      const ok = manager.write(args.sessionId, args.newline === false ? args.text : `${args.text}\n`);
      if (!ok) throw new Error(`无法写入：${args.sessionId} 不是运行中的会话`);
      await new Promise((r) => setTimeout(r, 250)); // 给目标进程一点回显时间
      const after = manager.read(args.sessionId)!;
      return {
        title: `写入 ${args.sessionId}`,
        output: `已写入${args.newline === false ? "（未补换行）" : ""}。\ncursor=${after.cursor}\n${after.output.slice(-2000) || "（暂无响应）"}`,
        metadata: { sessionId: args.sessionId, cursor: after.cursor },
      };
    },
  };

  const killTool: ToolDef = {
    id: "terminal_kill",
    label: "终止终端会话",
    description: "结束一个运行中的终端会话（先 SIGTERM，必要时 SIGKILL 兜底）。已退出的会话会被清理回收。",
    parameters: z.object({ sessionId: z.string().min(1).max(32) }),
    permission: () => null,
    executionMode: "sequential",
    async execute(args) {
      requireSession(args.sessionId);
      const ok = manager.kill(args.sessionId, "SIGTERM");
      await new Promise((r) => setTimeout(r, 300));
      let final = manager.read(args.sessionId)?.session ?? manager.getSession(args.sessionId);
      if (final?.status === "running") {
        manager.kill(args.sessionId, "SIGKILL");
        await new Promise((r) => setTimeout(r, 300));
        final = manager.read(args.sessionId)?.session ?? final;
      }
      if (!ok && final?.status === "running") throw new Error(`终止失败：${args.sessionId} 仍在运行`);
      return {
        title: `终止 ${args.sessionId}`,
        output: final ? formatInfo(final) : `${args.sessionId} 已不存在`,
        metadata: { sessionId: args.sessionId, status: final?.status ?? "gone", exitCode: final?.exitCode ?? undefined },
      };
    },
  };

  const listTool: ToolDef = {
    id: "terminal_list",
    label: "列出终端会话",
    description: "列出全部终端会话及其状态（含 id/name/backend/pid），用于找回上下文丢失的会话。",
    parameters: z.object({}),
    permission: () => null,
    async execute() {
      const all = manager.list();
      return {
        title: `共 ${all.length} 个终端会话`,
        output: all.length ? all.map(formatInfo).join("\n") : "（无终端会话）",
        metadata: { count: all.length, sessions: all },
      };
    },
  };

  return [startTool, readTool, writeTool, killTool, listTool];
}

function resolveWithin(root: string, rel: string): string | null {
  const abs = resolve(root, rel);
  if (abs !== root && !abs.startsWith(root + sep)) return null;
  return abs;
}

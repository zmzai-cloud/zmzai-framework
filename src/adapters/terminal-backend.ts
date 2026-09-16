import { execFileSync, spawn } from "node:child_process";
import { chmodSync, existsSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { createRequire } from "node:module";

import type { TerminalBackend } from "../core/tools/terminal.js";

/** 宿主机终端后端：优先真 PTY（node-pty），不可用自动降级管道模式。
 *
 *  node-pty 是原生模块，ABI 必须与运行时匹配——Electron 里要先
 *  `electron-rebuild -w node-pty`，否则动态 import 抛 ABI 错误；这里把
 *  失败收敛成「回退 pipe」，功能等价（stdin 可写/增量读输出/进程组 kill），
 *  只少 TTY 特性（回显、着色、行编辑）。首次 start 时才解析后端并缓存。 */

type NodePtyModule = {
  spawn: (
    file: string,
    args: string[],
    options: { name?: string; cols?: number; rows?: number; cwd?: string; env?: Record<string, string> },
  ) => {
    pid: number;
    write(data: string): void;
    kill(signal?: string): void;
    resize(cols: number, rows: number): void;
    onData(cb: (chunk: string) => void): void;
    onExit(cb: (result: { exitCode: number; signal?: number | string }) => void): void;
  };
};

let cachedBackend: TerminalBackend | null = null;

/** 同步探测：node-pty 是 CJS 包，用 createRequire 从本模块位置解析——
 *  异步 import().then(...) 会造成首启动时 backend.kind 尚未确定的竞态。 */
function tryLoadNodePty(): NodePtyModule | null {
  try {
    // 变量名解析：框架不硬依赖 node-pty（可选原生依赖），缺失/ABI 不匹配时静默降级
    const specifier = ["node", "pty"].join("-");
    ensureMacPtyHelperExecutable(specifier);
    const mod = requireFromModuleContext(specifier) as NodePtyModule & { default?: NodePtyModule };
    return mod.default ?? mod;
  } catch {
    return null;
  }
}

// 必须从 framework 自己解析：被 Next/Electron 宿主导入时，process.cwd() 指向
// Lectern 项目，无法找到 framework 的 optionalDependencies（如 node-pty）。
const requireFromModuleContext = createRequire(import.meta.url);

/**
 * node-pty 1.1.0 的 darwin-arm64 预构建包偶尔丢失 spawn-helper 的执行位。
 * 这会让加载正常、首次 spawn 却报 `posix_spawnp failed`，最终静默退回 pipe。
 * Electron 打包禁用 asar，因此运行时补齐该位是安全且可复现的。
 */
function ensureMacPtyHelperExecutable(specifier: string): void {
  if (process.platform !== "darwin") return;
  try {
    const entry = requireFromModuleContext.resolve(specifier);
    const helper = resolve(dirname(entry), "..", "prebuilds", `darwin-${process.arch}`, "spawn-helper");
    if (existsSync(helper)) chmodSync(helper, 0o755);
  } catch {
    // 可选依赖缺失或只读安装目录时，后续常规探测会安全降级。
  }
}

/** 宿主终端后端单例：优先真 PTY，node-pty 不可用或 spawn 探测失败时降级管道模式。
 *  首次调用即锁定后端种类（同步），session 标签从此不存在竞态。 */
export function createHostTerminalBackend(): TerminalBackend {
  if (!cachedBackend) {
    const mod = tryLoadNodePty();
    // 加载成功 ≠ 能用：新 Node 运行时与旧 node-pty 的 posix_spawnp 不兼容这类问题
    // 只有真正 spawn 时才暴露，探测一次，失败永久降级 pipe（功能等价）。
    cachedBackend = mod && probePtySpawn(mod) ? createNodePtyBackend(mod) : createPipeBackend();
  }
  return cachedBackend;
}

/** 同步 spawn 探测：用宿主一次性 shell 规格跑 `exit 0`，能起 pty 即认为可用。
 *
 *  回归锚点：这里曾硬编码 `/bin/sh -c true`——Windows 上没有 /bin/sh，探测必失败，
 *  导致打包版在真实 Windows 上**永久静默降级 pipe**（macOS 一直绿，CI 冒烟首次
 *  跑到 backend === "pty" 断言才暴露）。探测必须走 shell() 的跨平台规格。 */
function probePtySpawn(mod: NodePtyModule): boolean {
  try {
    const { file, prefixArgs } = shell();
    const term = mod.spawn(file, [...prefixArgs, "exit 0"], {
      name: "xterm-256color",
      cols: 20,
      rows: 5,
      cwd: process.cwd(),
    });
    term.kill();
    return true;
  } catch {
    return false;
  }
}

/** pty 探测命令（纯函数，便于跨平台单测）。
 *  `exit 0` 在 sh -c / pwsh -Command / cmd /c 下语义一致：立即退出且退出码 0，
 *  绝不能换成交互式变体（会话永不退出，见 shellSpecFor 的 -NoExit 教训）。 */
export function probeCommandFor(
  platform: NodeJS.Platform,
  availability: { hasPwsh: boolean; hasPowershell: boolean; comSpec?: string | undefined },
): { file: string; args: string[] } {
  const { file, prefixArgs } = shellSpecFor(platform, availability);
  return { file, args: [...prefixArgs, "exit 0"] };
}

/** 一次性执行型 shell 规格（纯函数，便于跨平台单测）。
 *
 *  语义必须与 POSIX 的 `sh -c "<command>"` 对齐：命令跑完 shell 即退出。
 *  framework 的终端会话状态完全由进程退出事件驱动（`TerminalBackend.onExit`），
 *  所以这里**绝不能带 `-NoExit`**——它会让 PowerShell 执行完命令后继续挂在交互
 *  提示符上，进程永不退出，会话永远停在 running，read 也再等不到退出码。 */
export function shellSpecFor(
  platform: NodeJS.Platform,
  availability: { hasPwsh: boolean; hasPowershell: boolean; comSpec?: string | undefined },
): { file: string; prefixArgs: string[] } {
  if (platform === "win32") {
    // PowerShell preserves the shell users normally expect on modern Windows;
    // retain cmd as a fallback for minimal/server installations.
    if (availability.hasPwsh) return { file: "pwsh.exe", prefixArgs: ["-NoLogo", "-NoProfile", "-Command"] };
    if (availability.hasPowershell) return { file: "powershell.exe", prefixArgs: ["-NoLogo", "-NoProfile", "-Command"] };
    return { file: availability.comSpec || "cmd.exe", prefixArgs: ["/d", "/s", "/c"] };
  }
  // 统一 POSIX sh（不用 $SHELL）：agent 语义需要可预测的语法方言，
  // fish/zsh 差异会造成同一条命令两种结果。
  return { file: "/bin/sh", prefixArgs: ["-c"] };
}

function shell(): { file: string; prefixArgs: string[] } {
  if (process.platform !== "win32") return shellSpecFor(process.platform, { hasPwsh: false, hasPowershell: false });
  const pathEntries = (process.env.Path ?? process.env.PATH ?? "").split(";");
  const has = (name: string) => pathEntries.some((entry) => existsSync(resolve(entry, name)));
  return shellSpecFor("win32", {
    hasPwsh: has("pwsh.exe"),
    hasPowershell: has("powershell.exe"),
    comSpec: process.env.ComSpec,
  });
}

/** 管道模式：detached 进程组 + 负值 pid 组杀，保证 npm run dev 这类带子进程的树能整树回收。 */
function createPipeBackend(): TerminalBackend {
  return {
    kind: "pipe",
    async start(input, hooks) {
      const { file, prefixArgs } = shell();
      const child = spawn(file, [...prefixArgs, input.command], {
        cwd: input.cwd,
        env: input.env ? { ...process.env, ...input.env } : undefined,
        stdio: ["pipe", "pipe", "pipe"],
        detached: process.platform !== "win32",
      });
      let exited = false;
      const forward = (buf: Buffer) => {
        if (!exited) hooks.onData(buf.toString("utf8"));
      };
      child.stdout!.on("data", forward);
      child.stderr!.on("data", forward);
      child.on("error", (error) => {
        if (!exited) hooks.onData(`\n[pipe] 进程启动失败：${error.message}\n`);
      });
      child.on("close", (code, signal) => {
        exited = true;
        hooks.onData(child.exitCode == null && signal ? `\n[终端被 ${signal} 终止]\n` : "");
        hooks.onExit({ exitCode: code ?? child.exitCode ?? null, signal: signal ?? null });
      });
      const pid = child.pid;
      return {
        pid,
        write(data) {
          if (!child.stdin?.destroyed) child.stdin!.write(data);
        },
        kill(signal = "SIGTERM") {
          if (exited) return;
          try {
            if (pid != null && process.platform !== "win32") process.kill(-pid, signal);
            else killWindowsTree(pid, signal);
          } catch {
            killWindowsTree(pid, "SIGKILL");
          }
        },
      };
    },
  };
}

function killWindowsTree(pid: number | undefined, signal: string): void {
  if (!pid) return;
  try {
    execFileSync("taskkill", ["/PID", String(pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
  } catch {
    // The process may have exited between the status check and taskkill.
  }
}

function createNodePtyBackend(moduleRef: NodePtyModule): TerminalBackend {
  return {
    kind: "pty",
    async start(input, hooks) {
      const cwdAbs = isAbsolute(input.cwd) ? input.cwd : resolve(input.cwd);
      const { file, prefixArgs } = shell();
      // 整条命令交给用户的 shell 执行（sh -c "<command>"）
      const term = moduleRef.spawn(file, [...prefixArgs, input.command], {
        name: "xterm-256color",
        cols: input.cols ?? 120,
        rows: input.rows ?? 30,
        cwd: cwdAbs,
        env: { ...process.env, ...(input.env ?? {}) } as Record<string, string>,
      });
      wirePty(term, hooks);
      return {
        pid: term.pid,
        write: (data) => term.write(data),
        kill: (signal) => {
          if (process.platform === "win32") killWindowsTree(term.pid, signal ?? "SIGTERM");
          else term.kill(signal);
        },
        resize: (cols, rows) => term.resize(cols, rows),
      };
    },
  };
}

function wirePty(
  term: ReturnType<NodePtyModule["spawn"]>,
  hooks: { onData(chunk: string): void; onExit(result: { exitCode: number | null; signal: string | null }): void },
): void {
  let exitSeen = false;
  term.onData((chunk) => {
    if (!exitSeen) hooks.onData(chunk);
  });
  term.onExit(({ exitCode, signal }) => {
    exitSeen = true;
    // node-pty 正常退出时可能给 signal=0（数字），不是真的收到信号
    const normalizedSignal =
      signal == null || Number(signal) === 0 || String(signal).trim() === "" ? null : String(signal);
    hooks.onExit({ exitCode, signal: normalizedSignal });
  });
}

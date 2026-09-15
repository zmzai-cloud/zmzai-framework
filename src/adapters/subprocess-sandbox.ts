import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { copyFile, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import type { SandboxExecutor } from "../adapters/index.js";
import type { SandboxSnapshot, SandboxExecResult } from "../core/tools/context.js";

/** Subprocess SandboxExecutor (M5 §5): 快照到 temp 目录跑普通子进程——无隔离，
 *  面向本机单用户宿主（生产隔离由 OpenSandbox 等真沙箱承担）。
 *
 *  快照/回写语义（E2E 实测修复）：
 *  - 提供 workspaceRoot 时，buildSnapshot 从真实工作区采集文本文件（跳过
 *    node_modules/.git 等重目录，限量防爆），bash 命令能看到并改动工作区文件；
 *  - 命令结束后，快照外的新文件（npm install 的 node_modules、构建产物等）
 *    直接 fs 回写工作区——不逐文件版本化，产物面板事件只收小文本样本，
 *    避免 node_modules 数千条 artifact.created 刷屏。 */

const SNAPSHOT_MAX_FILES = 5000;
const SNAPSHOT_MAX_BYTES = 32 * 1024 * 1024;
const SNAPSHOT_MAX_FILE_BYTES = 512 * 1024;
/** 快照采集跳过的重目录（依赖/构建缓存不入快照，npm install 会重新生成）。 */
const SNAPSHOT_SKIP_DIRS = new Set([
  "node_modules", ".git", ".next", ".nuxt", "dist", "build", "out",
  ".cache", ".venv", "venv", "__pycache__", ".turbo", ".harness-data",
]);
/** 产物面板/回写事件排除（批量落盘照常，只是不进事件流）。 */
const ARTIFACT_SKIP_DIRS = new Set(["node_modules", ".git", "__pycache__", ".cache"]);
const ARTIFACT_MAX_PATHS = 100;
const WORKSPACE_CONTENT_MAX_FILES = 30;
const WORKSPACE_CONTENT_MAX_BYTES = 256 * 1024;

const UNIX_PROGRAMS = new Set([
  "bash", "sh", "ls", "cat", "grep", "find", "mkdir", "cp", "mv", "rm",
  "echo", "printf", "unzip", "tar", "curl", "wget", "env",
]);

function inside(root: string, relative: string): string {
  const candidate = path.resolve(root, relative);
  if (candidate !== root && !candidate.startsWith(`${root}${path.sep}`)) {
    throw new Error(`sandbox path escapes workspace: ${relative}`);
  }
  return candidate;
}

function commandEnvironment(overrides?: Record<string, string>): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const [key, value] of Object.entries(overrides ?? {})) {
    if (process.platform === "win32") {
      for (const inherited of Object.keys(env)) {
        if (inherited.toLowerCase() === key.toLowerCase()) delete env[inherited];
      }
    }
    env[key] = value;
  }
  return env;
}

/** Git for Windows normally exposes only Git/cmd on PATH, not its Unix tools. */
function resolveProgram(program: string, env: NodeJS.ProcessEnv): string {
  if (process.platform !== "win32" || !UNIX_PROGRAMS.has(program)) return program;
  const envKey = (name: string) => Object.keys(env).find((key) => key.toLowerCase() === name.toLowerCase());
  const pathKey = envKey("PATH") ?? "PATH";
  const entries = (env[pathKey] ?? "").split(";").map((entry) => entry.trim().replace(/^"(.*)"$/, "$1"))
    .filter((entry) => path.win32.isAbsolute(entry));
  const candidates = entries.flatMap((entry) => [
    entry,
    path.win32.resolve(entry, "../usr/bin"),
    path.win32.resolve(entry, "../../usr/bin"),
  ]);
  for (const root of [env[envKey("ProgramFiles") ?? ""] ?? "C:\\Program Files", env[envKey("ProgramFiles(x86)") ?? ""]]) {
    if (root) candidates.push(path.win32.join(root, "Git", "usr", "bin"));
  }
  const local = env[envKey("LOCALAPPDATA") ?? ""];
  if (local) candidates.push(path.win32.join(local, "Programs", "Git", "usr", "bin"));
  for (const bin of new Set(candidates)) {
    // Require the Unix toolchain so Windows find.exe is never mistaken for GNU find.
    if (!existsSync(path.win32.join(bin, "sh.exe"))) continue;
    const executable = path.win32.join(bin, `${program}.exe`);
    if (!existsSync(executable)) continue;
    env[pathKey] = `${bin};${env[pathKey] ?? ""}`;
    return executable;
  }
  return program;
}

export function createSubprocessSandbox(input?: {
  /** 提供后：快照从真实工作区采集、新产物回写工作区（函数形式随项目切换）。 */
  workspaceRoot?: string | (() => string | null | undefined);
}): SandboxExecutor {
  const wsRoot = (): string | null =>
    (typeof input?.workspaceRoot === "function" ? input.workspaceRoot() : input?.workspaceRoot) ?? null;

  return {
    async buildSnapshot(): Promise<SandboxSnapshot> {
      const ws = wsRoot();
      if (!ws) return { revisionId: null, files: [] };
      const files: SandboxSnapshot["files"] = [];
      let total = 0;
      const walk = async (dir: string): Promise<void> => {
        if (files.length >= SNAPSHOT_MAX_FILES || total >= SNAPSHOT_MAX_BYTES) return;
        const entries = await readdir(dir, { withFileTypes: true });
        for (const entry of entries) {
          if (files.length >= SNAPSHOT_MAX_FILES || total >= SNAPSHOT_MAX_BYTES) return;
          const full = path.join(dir, entry.name);
          if (entry.isDirectory()) {
            if (SNAPSHOT_SKIP_DIRS.has(entry.name)) continue;
            await walk(full);
          } else if (entry.isFile()) {
            const info = await stat(full);
            if (info.size > SNAPSHOT_MAX_FILE_BYTES) continue;
            const content = await readFile(full, "utf8");
            if (content.includes("\uFFFD")) continue; // 二进制不入快照
            total += info.size;
            files.push({ path: path.relative(ws, full), content });
          }
        }
      };
      try {
        await walk(ws);
      } catch {
        /* 工作区读取失败按空快照跑 */
      }
      return { revisionId: null, files };
    },

    async run(input: { command: { program: string; args: string[]; cwd?: string; env?: Record<string, string> } } & { snapshot: SandboxSnapshot }): Promise<SandboxExecResult> {
      const dir = await mkdtemp(path.join(tmpdir(), "fw-sandbox-"));
      try {
        for (const file of input.snapshot.files) {
          const full = inside(dir, file.path);
          await mkdir(path.dirname(full), { recursive: true });
          await writeFile(full, file.content, "utf8");
        }
        const cwd = input.command.cwd ? inside(dir, input.command.cwd) : dir;
        // cwd 可能指向快照里没有文件的子目录（如刚 mkdir 的空项目）：先建出来
        await mkdir(cwd, { recursive: true });
        const env = commandEnvironment(input.command.env);
        const program = resolveProgram(input.command.program, env);
        const result = await new Promise<{ code: number | null; output: string }>((resolve, reject) => {
          const child = spawn(program, input.command.args ?? [], {
            cwd,
            env,
            shell: false,
            windowsHide: true,
            stdio: ["ignore", "pipe", "pipe"],
          });
          let output = "";
          child.stdout.on("data", (chunk) => {
            output += String(chunk);
          });
          child.stderr.on("data", (chunk) => {
            output += String(chunk);
          });
          child.on("error", (error: NodeJS.ErrnoException) => {
            if (process.platform === "win32" && error.code === "ENOENT") {
              const hint = UNIX_PROGRAMS.has(input.command.program)
                ? ` Install Git for Windows (including Git Bash), add its usr\\bin directory to PATH if installed in a custom location, then restart Lectern.`
                : ` Install "${input.command.program}" or add its installation directory to PATH, then restart Lectern.`;
              reject(new Error(`${error.message}.${hint}`, { cause: error }));
            } else {
              reject(error);
            }
          });
          child.on("close", (code) => resolve({ code, output }));
        });
        // 收集快照外的新文件：批量 fs 回写工作区 + 产物元数据（限流）
        const snapshotPaths = new Set(input.snapshot.files.map((f) => f.path));
        const ws = wsRoot();
        const artifacts: SandboxExecResult["artifacts"] = [];
        let contentSamples = 0;
        let truncated = false;
        const walk = async (dirPath: string): Promise<void> => {
          if (truncated) return;
          const entries = await readdir(dirPath, { withFileTypes: true });
          for (const entry of entries) {
            if (truncated) return;
            const full = path.join(dirPath, entry.name);
            if (entry.isDirectory()) {
              await walk(full);
            } else if (entry.isFile() && entry.name !== ".fw-sandbox") {
              const rel = path.relative(dir, full);
              if (snapshotPaths.has(rel)) continue;
              const info = await stat(full);
              // 批量回写：新文件原样落回工作区（node_modules 也落，install 才有意义）
              if (ws) {
                const parent = path.relative(dir, path.dirname(full));
                const destDir = parent ? path.join(ws, parent) : ws;
                await mkdir(destDir, { recursive: true });
                await copyFile(full, path.join(ws, rel));
              }
              if (ARTIFACT_SKIP_DIRS.has(rel.split(path.sep)[0] ?? "")) continue;
              if (artifacts.length >= ARTIFACT_MAX_PATHS) {
                truncated = true;
                continue;
              }
              // 事件样本：仅小文本给 workspaceContent（走版本化写入 + diff 卡片）
              let workspaceContent: string | undefined;
              if (info.size <= WORKSPACE_CONTENT_MAX_BYTES && contentSamples < WORKSPACE_CONTENT_MAX_FILES) {
                const text = await readFile(full, "utf8");
                if (!text.includes("\uFFFD")) {
                  workspaceContent = text;
                  contentSamples++;
                }
              }
              artifacts.push({
                path: rel,
                bytes: info.size,
                contentType: guessContentType(rel),
                // 回写后的文件指向工作区真实路径（temp 目录在 finally 里会删）
                downloadUrl: pathToFileURL(ws ? path.join(ws, rel) : full).href,
                ...(workspaceContent !== undefined ? { workspaceContent } : {}),
              });
            }
          }
        };
        await walk(dir);
        return {
          ok: result.code === 0,
          outcome: result.code === 0 ? "succeeded" : "failed",
          exitCode: result.code,
          outputText: result.output,
          durationMs: 0,
          artifacts,
        };
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    },
  };
}

function guessContentType(filename: string): string {
  const ext = path.extname(filename).toLowerCase();
  const map: Record<string, string> = {
    ".html": "text/html", ".htm": "text/html", ".png": "image/png", ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg", ".gif": "image/gif", ".svg": "image/svg+xml", ".webp": "image/webp",
    ".pdf": "application/pdf", ".md": "text/markdown", ".txt": "text/plain", ".css": "text/css",
    ".js": "text/javascript", ".json": "application/json", ".py": "text/x-python",
    ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  };
  return map[ext] ?? "application/octet-stream";
}

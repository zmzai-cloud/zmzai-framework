import { spawn } from "node:child_process";
import { mkdtemp, writeFile, rm, readdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import type { SandboxExecutor } from "../adapters/index.js";
import type { SandboxSnapshot, SandboxExecResult } from "../core/tools/context.js";

/** Subprocess SandboxExecutor (M5 §5 CLI reference implementation): writes the
 *  snapshot to a temp dir and runs the command as a plain child process — NO
 *  isolation. Good enough to demo the framework standalone; production uses
 *  OpenSandbox. */
export function createSubprocessSandbox(): SandboxExecutor {
  return {
    async buildSnapshot(input: { workspaceId: string }) {
      void input;
      return { revisionId: null, files: [] };
    },
    async run(input: { command: { program: string; args: string[]; cwd?: string; env?: Record<string, string> } } & { snapshot: SandboxSnapshot }): Promise<SandboxExecResult> {
      const dir = await mkdtemp(path.join(tmpdir(), "fw-sandbox-"));
      try {
        for (const file of input.snapshot.files) {
          const full = path.join(dir, file.path);
          await writeFile(full, file.content, "utf8");
        }
        const cwd = input.command.cwd ? path.join(dir, input.command.cwd) : dir;
        const result = await new Promise<{ code: number | null; output: string }>((resolve, reject) => {
          const child = spawn(input.command.program, input.command.args ?? [], {
            cwd,
            env: { ...process.env, ...(input.command.env ?? {}) },
            shell: false,
            stdio: ["ignore", "pipe", "pipe"],
          });
          let output = "";
          child.stdout.on("data", (chunk) => {
            output += String(chunk);
          });
          child.stderr.on("data", (chunk) => {
            output += String(chunk);
          });
          child.on("error", reject);
          child.on("close", (code) => resolve({ code, output }));
        });
        // Collect files written during the run as deliverables.
        const artifacts: SandboxExecResult["artifacts"] = [];
        const walk = async (dirPath: string): Promise<void> => {
          const entries = await readdir(dirPath, { withFileTypes: true });
          for (const entry of entries) {
            const full = path.join(dirPath, entry.name);
            if (entry.isDirectory()) {
              await walk(full);
            } else if (entry.name !== ".fw-sandbox") {
              const rel = path.relative(dir, full);
              const content = await readFile(full);
              artifacts.push({
                path: rel,
                bytes: content.length,
                contentType: guessContentType(rel),
                downloadUrl: `file://${full}`,
              });
            }
          }
        };
        await walk(dir);
        // Only files NOT in the original snapshot count as deliverables.
        const snapshotPaths = new Set(input.snapshot.files.map((f) => f.path));
        const deliverables = artifacts.filter((a) => !snapshotPaths.has(a.path));
        return {
          ok: result.code === 0,
          exitCode: result.code,
          outputText: result.output,
          durationMs: 0,
          artifacts: deliverables,
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

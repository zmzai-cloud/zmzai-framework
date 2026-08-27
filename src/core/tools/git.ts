import { execFile } from "node:child_process";
import { z } from "zod";

import type { ToolDef } from "./def.js";

/** Git 工具集（P0）：把裸敲 `bash git …` 升级为结构化专用工具。
 *  与 opencode git.ts / codex git-utils 对齐的四个最小面：
 *  status / diff / log 只读（git_read，默认放行），commit 写级
 *  （git_write，走审批）。在真实仓库上执行——不是沙箱快照里的临时副本，
 *  否则 commit 会随快照销毁而丢失。宿主用 cwd 绑定各自的仓库根。 */

export type GitToolsOptions = {
  /** 返回执行 git 命令的仓库根目录。函数形式便于多会话绑定各自工作区。 */
  cwd: () => string;
};

type GitRun = { code: number; stdout: string; stderr: string };

function runGit(cwd: string, args: string[], timeoutMs: number): Promise<GitRun> {
  return new Promise((resolvePromise, reject) => {
    execFile(
      "git",
      args,
      { cwd, timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024, windowsHide: true },
      (error, stdout, stderr) => {
        if (!error) {
          resolvePromise({ code: 0, stdout: String(stdout), stderr: String(stderr) });
          return;
        }
        const err = error as NodeJS.ErrnoException & { code?: number | string; killed?: boolean };
        if (err.code === "ENOENT") {
          reject(new Error("未找到 git 可执行文件：请确认本机已安装 git"));
          return;
        }
        const stderrText = String(stderr ?? "");
        if (/not a git repository/i.test(stderrText)) {
          reject(new Error("当前工作区不是 git 仓库（找不到 .git）"));
          return;
        }
        resolvePromise({
          code: typeof err.code === "number" ? err.code : 1,
          stdout: String(stdout ?? ""),
          stderr: stderrText,
        });
      },
    );
  });
}

function assertRepo(run: GitRun): void {
  if (run.code !== 0) {
    const detail = run.stderr.trim() || `退出码 ${run.code}`;
    throw new Error(`git 执行失败：${detail}`);
  }
}

/** porcelain v1 行解析：XY path 或 XY old -> new */
function parseStatusLine(line: string): { x: string; y: string; path: string; origPath?: string } | null {
  if (line.length < 4) return null;
  const x = line[0]!;
  const y = line[1]!;
  if (x === " " && y === " ") return null;
  let rest = line.slice(3);
  let origPath: string | undefined;
  const renameMarker = rest.indexOf(" -> ");
  if (renameMarker >= 0) {
    origPath = rest.slice(0, renameMarker);
    rest = rest.slice(renameMarker + 4);
  }
  return { x, y, path: rest, ...(origPath ? { origPath } : {}) };
}

export function createGitTools(options: GitToolsOptions): ToolDef[] {
  const cwdOf = () => options.cwd();

  const gitStatusTool: ToolDef = {
    id: "git_status",
    label: "查看 Git 状态",
    description: "查看当前仓库的分支、已暂存/未暂存/未跟踪文件清单（结构化解析 porcelain 输出）。只读操作。",
    parameters: z.object({}),
    permission: () => ({ permission: "git_read", patterns: ["*"] }),
    async execute() {
      const run = await runGit(cwdOf(), ["status", "--porcelain=v1", "-b", "--untracked-files=all"], 15_000);
      assertRepo(run);
      const lines = run.stdout.split("\n").filter(Boolean);
      const head = lines[0] ?? "";
      const trackInfo = head.replace(/^##\s*/, "");
      // 分支名可能带点（v1.0）；ahead/behind 只出现在方括号跟踪信息里，分开匹配防互相吞
      const branch = (trackInfo.split(/\s+/)[0] ?? "").split("...")[0] || "未知";
      const ahead = /\bahead (\d+)\b/.exec(trackInfo)?.[1];
      const behind = /\bbehind (\d+)\b/.exec(trackInfo)?.[1];
      const entries = lines.slice(1).map(parseStatusLine).filter((e): e is NonNullable<typeof e> => e !== null);
      const staged = entries.filter((e) => e.x !== " " && e.x !== "?");
      const unstaged = entries.filter((e) => e.y !== " " && e.y !== "?");
      const untracked = entries.filter((e) => e.x === "?" && e.y === "?");
      const format = (list: typeof entries) =>
        list.map((e) => (e.origPath ? `${e.path}（自 ${e.origPath} 重命名/复制）` : e.path)).join("\n") || "（无）";
      const dirtyNote = entries.length === 0 ? "\n工作区是干净的。" : "";
      const output =
        `分支 ${branch}${ahead ? ` · 领先远端 ${ahead} 个提交` : ""}${behind ? ` · 落后远端 ${behind} 个提交` : ""}\n` +
        `已暂存（${staged.length}）:\n${format(staged)}\n` +
        `未暂存修改（${unstaged.length}）:\n${format(unstaged)}\n` +
        `未跟踪（${untracked.length}）:\n${format(untracked)}` +
        dirtyNote;
      return {
        title: `${branch}${entries.length ? ` · ${entries.length} 处变更` : " · 干净"}`,
        output,
        metadata: {
          branch,
          ...(ahead ? { ahead: Number(ahead) } : {}),
          ...(behind ? { behind: Number(behind) } : {}),
          counts: { staged: staged.length, unstaged: unstaged.length, untracked: untracked.length },
          paths: entries.map((e) => e.origPath ? `${e.origPath} -> ${e.path}` : e.path),
        },
      };
    },
  };

  const gitDiffTool: ToolDef = {
    id: "git_diff",
    label: "查看 Git 差异",
    description: "查看工作区相对 HEAD 的 diff（--no-color 统一格式），可选只看单个文件或仅看已暂存变更。开头附每行增删统计。只读操作。",
    parameters: z.object({
      path: z.string().min(1).max(512).optional(),
      staged: z.boolean().optional(),
    }),
    permission: (args) => ({ permission: "git_read", patterns: [args.path ?? "*"] }),
    async execute(args) {
      const rangeArgs = args.staged ? ["--staged"] : [];
      const pathArgs = args.path ? ["--", args.path] : [];
      const statRun = await runGit(cwdOf(), ["diff", "--numstat", ...rangeArgs, ...pathArgs], 15_000);
      assertRepo(statRun);
      const diffRun = await runGit(cwdOf(), ["diff", "--no-color", ...rangeArgs, ...pathArgs], 30_000);
      assertRepo(diffRun);
      const statLines = statRun.stdout.split("\n").filter(Boolean);
      const totalAdded = statLines.reduce((sum, l) => sum + Number(l.split("\t")[0] || 0), 0);
      const totalRemoved = statLines.reduce((sum, l) => sum + Number(l.split("\t")[1] || 0), 0);
      const summary = `涉及 ${statLines.length} 个文件，+${totalAdded}/-${totalRemoved} 行`;
      const diffBody = diffRun.stdout.trim();
      const output = statLines.length
        ? `${summary}\n\n${statLines.join("\n")}\n\n${diffBody || "（内容无变化）"}`
        : `${summary}\n\n（没有差异）`;
      return {
        title: args.staged ? `Diff（已暂存）：${summary}` : args.path ? `Diff ${args.path}` : `Diff：${summary}`,
        output,
        metadata: { filesChanged: statLines.length, totalAdded, totalRemoved, staged: args.staged === true, ...(args.path ? { path: args.path } : {}) },
      };
    },
  };

  const gitLogTool: ToolDef = {
    id: "git_log",
    label: "查看提交历史",
    description: "列出最近 N 条提交（hash、作者、时间、标题）。只读操作。",
    parameters: z.object({ limit: z.number().int().min(1).max(100).optional() }),
    permission: () => ({ permission: "git_read", patterns: ["*"] }),
    async execute(args) {
      const limit = args.limit ?? 20;
      const run = await runGit(
        cwdOf(),
        ["log", `--max-count=${limit}`, "--pretty=format:%h%x09%an%x09%aI%x09%s"],
        15_000,
      );
      if (/does not have any commits yet/i.test(run.stderr)) {
        return { title: "log：空仓库", output: "这个仓库还没有任何提交。", metadata: { commits: 0 } };
      }
      assertRepo(run);
      const rows = run.stdout.split("\n").filter(Boolean);
      const output = rows.length
        ? rows.map((r) => r.replace(/\t/g, " · ")).join("\n")
        : "（仓库还没有任何提交。）";
      return { title: `最近 ${rows.length} 条提交`, output, metadata: { commits: rows.length } };
    },
  };

  const gitCommitTool: ToolDef = {
    id: "git_commit",
    label: "创建 Git 提交",
    description:
      "把指定文件（paths）或全部变更（addAll: true）暂存并创建提交；都不传则直接提交当前已暂存的内容。message 必填。提交真实发生在仓库中。",
    parameters: z.object({
      message: z.string().trim().min(1).max(2000),
      paths: z.array(z.string().min(1).max(512)).max(50).optional(),
      addAll: z.boolean().optional(),
    }),
    permission: (args) => ({
      permission: "git_write",
      patterns: [args.paths?.length ? args.paths.join(", ") : "(staged/all)"],
      always: ["*"],
      metadata: { message: args.message, fileCount: args.paths?.length ?? (args.addAll ? "all" : "staged") },
    }),
    executionMode: "sequential",
    async execute(args) {
      if (args.paths?.length) {
        const addRun = await runGit(cwdOf(), ["add", "--", ...args.paths], 15_000);
        assertRepo(addRun);
      } else if (args.addAll) {
        const addRun = await runGit(cwdOf(), ["add", "-A"], 15_000);
        assertRepo(addRun);
      }
      const stagedList = await runGit(cwdOf(), ["diff", "--cached", "--name-only"], 15_000);
      assertRepo(stagedList);
      const stagedFiles = stagedList.stdout.split("\n").filter(Boolean);
      if (!stagedFiles.length) {
        throw new Error(
          "没有可提交的变更：工作区既没有已暂存内容，也没有匹配到待暂存文件。先用 git_status 确认改动，再通过 paths 或 addAll 指定要提交的内容。",
        );
      }
      const commitRun = await runGit(cwdOf(), ["commit", "-m", args.message], 30_000);
      assertRepo(commitRun);
      const hashRun = await runGit(cwdOf(), ["rev-parse", "--short", "HEAD"], 10_000);
      const hash = hashRun.code === 0 ? hashRun.stdout.trim() : "未知";
      const title = args.message.split("\n")[0]?.slice(0, 60) ?? "commit";
      return {
        title: `提交 ${hash}: ${title}`,
        output: `已创建提交 ${hash}（${stagedFiles.length} 个文件）：\n${stagedFiles.join("\n")}`,
        metadata: { hash, files: stagedFiles, messageTitle: title },
      };
    },
  };

  return [gitStatusTool, gitDiffTool, gitLogTool, gitCommitTool];
}

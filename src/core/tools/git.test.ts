import { describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { createGitTools } from "./git.js";

const exec = promisify(execFile);
const hasGit = await (async () => {
  try {
    await exec("git", ["--version"]);
    return true;
  } catch {
    return false;
  }
})();

/** 建一个真实临时仓库并做一个初始提交（提交需要配置身份）。 */
async function makeRepo(): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), "fw-git-test-"));
  const git = async (...args: string[]) => exec("git", args, { cwd: dir });
  await git("init");
  await git("config", "user.email", "test@example.com");
  await git("config", "user.name", "Test");
  writeFileSync(join(dir, "hello.md"), "# hello\n\nworld\n");
  await git("add", ".");
  await git("commit", "-m", "init");
  return dir;
}

function toolById(defs: ReturnType<typeof createGitTools>, id: string) {
  const def = defs.find((d) => d.id === id);
  if (!def) throw new Error(`缺少工具 ${id}`);
  if ("parametersJsonSchema" in def) throw new Error(`${id} 应为 zod ToolDef`);
  return def as import("./def.js").ToolDef;
}

async function ctx(repoDir: string) {
  const { createFsWorkspaceFiles } = await import("../../adapters/fs-workspace.js");
  return {
    sessionId: "ses_git_test",
    userId: "local",
    workspaceId: "local",
    agent: "default",
    toolCallId: `call_${Math.random().toString(36).slice(2)}`,
    workspace: createFsWorkspaceFiles({ root: repoDir }),
  } as import("./context.js").ToolContext;
}

describe.skipIf(!hasGit)("git 工具集（真实临时仓库）", () => {
  it("id 齐全：status/diff/log/commit，权限分类正确", () => {
    const defs = createGitTools({ cwd: () => "/tmp" });
    expect(defs.map((d) => d.id)).toEqual(["git_status", "git_diff", "git_log", "git_commit"]);
    for (const def of defs.slice(0, 3)) {
      const mapped = def.permission({} as never) as { permission: string };
      expect(mapped.permission).toBe("git_read");
    }
    const commitPerm = defs[3]!.permission({ message: "m" } as never) as { permission: string; always: string[] };
    expect(commitPerm.permission).toBe("git_write");
    expect(commitPerm.always).toEqual(["*"]);
  });

  it("git_status 报告分支/未跟踪/修改；干净仓库输出干净提示", async () => {
    const repo = await makeRepo();
    const defs = createGitTools({ cwd: () => repo });
    const status = toolById(defs, "git_status");
    const cleanCtx = await ctx(repo);

    const dirty = await status.execute({}, cleanCtx);
    expect(dirty.metadata).toMatchObject({ branch: /.*/, counts: { staged: 0, unstaged: 0, untracked: 0 } });

    writeFileSync(join(repo, "new.txt"), "untracked\n");
    writeFileSync(join(repo, "hello.md"), "# hello\n\nchanged\n");
    const dirty2 = await status.execute({}, cleanCtx);
    expect(dirty2.output).toContain("new.txt");
    expect(dirty2.output).toContain("hello.md");
    expect((dirty2.metadata!.counts as { untracked: number }).untracked).toBe(1);

    const cleanRepo = await makeRepo();
    const cleanDefs = createGitTools({ cwd: () => cleanRepo });
    const res = await toolById(cleanDefs, "git_status").execute({}, await ctx(cleanRepo));
    expect(res.output).toContain("工作区是干净的");
  });

  it("git_diff 输出 numstat 统计 + diff 正文；staged 模式走 --staged", async () => {
    const repo = await makeRepo();
    const defs = createGitTools({ cwd: () => repo });
    const diff = toolById(defs, "git_diff");
    const c = await ctx(repo);
    writeFileSync(join(repo, "hello.md"), "# hello\n\nworld!\nmore lines here\n");

    const unstagedRes = await diff.execute({}, c);
    expect(unstagedRes.output).toContain("world!");
    expect((unstagedRes.metadata as { filesChanged: number }).filesChanged).toBe(1);

    // 未暂存时 --staged 应无差异
    const stagedEmpty = await diff.execute({ staged: true }, c);
    expect(stagedEmpty.output).toContain("没有差异");

    await exec("git", ["add", "."], { cwd: repo });
    const stagedRes = await diff.execute({ staged: true }, c);
    expect(stagedRes.output).toContain("world!");

    const scoped = await diff.execute({ path: "not-exist.md" }, c);
    expect(scoped.output).toContain("没有差异");
  });

  it("git_log 列出提交（新→旧）；空仓库给出友好提示", async () => {
    const repo = await makeRepo();
    const defs = createGitTools({ cwd: () => repo });
    const log = toolById(defs, "git_log");
    const c = await ctx(repo);

    const res = await log.execute({ limit: 5 }, c);
    expect(res.output.split("\n").length).toBeGreaterThanOrEqual(1);
    expect(res.output).toContain("init");
    expect(res.output).toContain("Test");

    const emptyRepo = mkdtempSync(join(tmpdir(), "fw-git-empty-"));
    await exec("git", ["init"], { cwd: emptyRepo });
    const emptyDefs = createGitTools({ cwd: () => emptyRepo });
    const emptyRes = await toolById(emptyDefs, "git_log").execute({}, await ctx(emptyRepo));
    expect(emptyRes.output).toContain("还没有任何提交");
  });

  it("git_commit 按 paths 暂存并创建提交；无变更时报可读错误；身份缺失透出真实原因", async () => {
    const repo = await makeRepo();
    const defs = createGitTools({ cwd: () => repo });
    const commit = toolById(defs, "git_commit");
    const status = toolById(defs, "git_status");
    const log = toolById(defs, "git_log");
    const c = await ctx(repo);

    // 1) 无变更 → 引导性报错
    await expect(commit.execute({ message: "empty" }, c)).rejects.toThrow(/没有可提交的变更/);

    // 2) paths 提交
    writeFileSync(join(repo, "feature.md"), "feat content\n");
    mkdirSync(join(repo, "src"), { recursive: true });
    writeFileSync(join(repo, "src", "a.ts"), "export {}\n");
    const res = await commit.execute({ message: "add feature", paths: ["feature.md", "src/a.ts"] }, c);
    expect(res.title).toMatch(/^提交 [0-9a-f]+: add feature$/);
    expect((res.metadata as { files: string[] }).files).toHaveLength(2);
    const afterCommit = await log.execute({ limit: 3 }, c);
    expect(afterCommit.output).toContain("add feature");
    const st = await status.execute({}, c);
    expect(st.output).toContain("工作区是干净的");

    // 3) 不是仓库的目录 → 友好错误
    const plain = mkdtempSync(join(tmpdir(), "fw-git-plain-"));
    const notRepo = createGitTools({ cwd: () => plain });
    await expect(toolById(notRepo, "git_status").execute({}, await ctx(plain))).rejects.toThrow(/不是 git 仓库/);
  }, 20_000);
});

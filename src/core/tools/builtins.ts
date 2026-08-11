import { z } from "zod";

import type { ToolDef } from "../tools/def.js";
import { wildcardMatch } from "../permission/ruleset.js";

/** Built-in tools (spec §7.2). These operate on the WorkspaceFiles facade, so
 *  the same definitions serve the Mongo cloud backend and a future local FS
 *  backend. */

export const readTool: ToolDef = {
  id: "read",
  label: "读取文件",
  description: "读取当前 Workspace 中一个文本文件的内容。路径必须来自 glob 结果或已知 Workspace 路径。",
  parameters: z.object({ path: z.string().min(1).max(512) }),
  permission: (args) => ({ permission: "read", patterns: [args.path] }),
  async execute(args, ctx) {
    const file = await ctx.workspace.read(args.path);
    if (!file) throw new Error(`文件不存在或不可读取：${args.path}`);
    return { title: `读取 ${args.path}`, output: file.content || "（空文件）", metadata: { path: args.path, bytes: Buffer.byteLength(file.content, "utf8") } };
  },
};

export const globTool: ToolDef = {
  id: "glob",
  label: "按模式列文件",
  description: "按 glob 模式列出 Workspace 文件路径（* 匹配任意字符序列，? 匹配单字符）。不传 pattern 则列出全部。",
  parameters: z.object({ pattern: z.string().max(256).optional() }),
  permission: () => ({ permission: "glob", patterns: ["*"] }),
  async execute(args, ctx) {
    const files = await ctx.workspace.list();
    const matched = args.pattern ? files.filter((file) => wildcardMatch(args.pattern!, file.path)) : files;
    const limited = matched.slice(0, 200);
    return {
      title: `列出 ${limited.length} 个文件`,
      output: limited.length ? limited.map((file) => `${file.path}（${file.bytes} B）`).join("\n") : "没有匹配的文件。",
      metadata: { count: limited.length, total: matched.length },
    };
  },
};

export const grepTool: ToolDef = {
  id: "grep",
  label: "搜索文件内容",
  description: "在 Workspace 文本文件内容中搜索关键词，最多返回 50 条匹配（path:line: 内容）。",
  parameters: z.object({
    query: z.string().min(1).max(256),
    pathPattern: z.string().max(256).optional(),
  }),
  permission: (args) => ({ permission: "grep", patterns: [args.query] }),
  async execute(args, ctx) {
    const files = await ctx.workspace.list();
    const candidates = args.pathPattern ? files.filter((file) => wildcardMatch(args.pathPattern!, file.path)) : files;
    const matches: { path: string; line: number; text: string }[] = [];
    for (const candidate of candidates) {
      if (matches.length >= 50) break;
      const file = await ctx.workspace.read(candidate.path);
      if (!file) continue;
      const lines = file.content.split("\n");
      for (let index = 0; index < lines.length && matches.length < 50; index++) {
        if (lines[index]!.includes(args.query)) {
          matches.push({ path: candidate.path, line: index + 1, text: lines[index]!.slice(0, 200) });
        }
      }
    }
    return {
      title: `搜索 "${args.query}"：${matches.length} 条命中`,
      output: matches.length ? matches.map((match) => `${match.path}:${match.line}: ${match.text}`).join("\n") : "没有命中。",
      metadata: { count: matches.length, truncated: matches.length >= 50 },
    };
  },
};

export const writeTool: ToolDef = {
  id: "write",
  label: "写入文件",
  description: "创建或完整覆盖 Workspace 中的一个文本文件。写入立即生效并生成不可变版本（可通过 file.edited 事件审查差异）。",
  parameters: z.object({
    path: z.string().min(1).max(512),
    content: z.string().max(512 * 1024),
    summary: z.string().max(200).optional(),
  }),
  permission: (args) => ({ permission: "edit", patterns: [args.path], metadata: { path: args.path, bytes: Buffer.byteLength(args.content, "utf8") } }),
  executionMode: "sequential",
  async execute(args, ctx) {
    const result = await ctx.workspace.write({ path: args.path, content: args.content, author: "agent", summary: args.summary ?? `Agent 写入 ${args.path}` });
    if (!result) throw new Error(`路径不合法或写入被拒绝：${args.path}`);
    await ctx.emitFileEdited({ path: args.path, revisionId: result.revisionId, diff: result.diff });
    return { title: `写入 ${args.path}`, output: `已写入 ${args.path}（版本 ${result.revisionId}）。`, metadata: { path: args.path, revisionId: result.revisionId } };
  },
};

export const editTool: ToolDef = {
  id: "edit",
  label: "编辑文件",
  description: "对 Workspace 文件做精确文本替换：oldText 必须在文件中唯一出现。编辑立即生效并生成不可变版本。",
  parameters: z.object({
    path: z.string().min(1).max(512),
    oldText: z.string().min(1).max(64 * 1024),
    newText: z.string().max(64 * 1024),
    summary: z.string().max(200).optional(),
  }),
  permission: (args) => ({ permission: "edit", patterns: [args.path], metadata: { path: args.path } }),
  executionMode: "sequential",
  async execute(args, ctx) {
    const result = await ctx.workspace.edit({ path: args.path, oldText: args.oldText, newText: args.newText, author: "agent", summary: args.summary ?? `Agent 编辑 ${args.path}` });
    if ("error" in result) throw new Error(`编辑失败：${result.error}`);
    await ctx.emitFileEdited({ path: args.path, revisionId: result.revisionId, diff: result.diff });
    return { title: `编辑 ${args.path}`, output: `已编辑 ${args.path}（版本 ${result.revisionId}）。`, metadata: { path: args.path, revisionId: result.revisionId } };
  },
};

export const todoTool: ToolDef = {
  id: "todo",
  label: "更新任务清单",
  description: "维护当前任务的工作清单：开始前拆解步骤（in_progress 标记进行中），每完成一步立即更新状态。让用户随时看到进度。",
  parameters: z.object({
    todos: z.array(
      z.object({
        content: z.string().min(1).max(200),
        status: z.enum(["pending", "in_progress", "completed", "cancelled"]),
        priority: z.enum(["high", "medium", "low"]).optional(),
      }),
    ).max(50),
  }),
  permission: () => null, // always safe: pure projection, no side effects beyond the todo event
  async execute(args, ctx) {
    await ctx.setTodos(args.todos);
    const done = args.todos.filter((todo: { status: string }) => todo.status === "completed").length;
    return { title: `更新清单（${done}/${args.todos.length} 完成）`, output: `清单已更新：${done}/${args.todos.length} 项完成。`, metadata: { total: args.todos.length, completed: done } };
  },
};

const defaultAllowedPrograms = ["node", "npm", "npx", "python3", "bash", "sh", "git", "ls", "cat", "grep", "find", "mkdir", "cp", "mv", "rm", "echo", "printf", "unzip", "tar", "curl", "wget", "env"];

function allowedPrograms(): Set<string> {
  const configured = process.env.EXEC_ALLOWED_PROGRAMS?.trim();
  if (!configured) return new Set(defaultAllowedPrograms);
  return new Set(configured.split(",").map((item) => item.trim()).filter(Boolean));
}

export const bashTool: ToolDef = {
  id: "bash",
  label: "在沙箱中执行命令",
  description:
    "在当前 Workspace 的快照中执行一条命令（隔离沙箱）。程序必须在允许列表内；stdout/stderr 会返回，生成的产物文件可下载。",
  parameters: z.object({
    program: z.string().min(1).max(64),
    args: z.array(z.string().max(512)).max(32).optional(),
    cwd: z.string().min(1).max(512).optional(),
    env: z.record(z.string(), z.string().max(2048)).optional(),
  }),
  permission: (args) => {
    const command = [args.program, ...(args.args ?? [])].join(" ");
    return { permission: "bash", patterns: [command], always: [command, `${args.program} *`], metadata: { command } };
  },
  executionMode: "sequential",
  async execute(args, ctx) {
    const program = args.program.trim();
    if (!allowedPrograms().has(program)) throw new Error(`程序 "${program}" 不在允许列表`);
    const snapshot = await ctx.buildSnapshot();
    const result = await ctx.runSandbox({
      toolCallId: `fwcall_${Date.now()}`,
      command: { program, args: args.args ?? [], ...(args.cwd ? { cwd: args.cwd } : {}), ...(args.env ? { env: args.env } : {}) },
      snapshot,
    });
    for (const artifact of result.artifacts) {
      await ctx.emitArtifact({
        artifactId: `art_${Date.now()}_${artifact.path.replace(/[^a-zA-Z0-9]/g, "_")}`,
        path: artifact.path,
        bytes: artifact.bytes,
        contentType: artifact.contentType,
        downloadUrl: artifact.downloadUrl,
        ...(artifact.previewUrl ? { previewUrl: artifact.previewUrl } : {}),
      });
    }
    const artifactLine = result.artifacts.length ? `\n已交付产物：${result.artifacts.map((item) => `${item.path}（${item.bytes} B）`).join("、")}` : "";
    const output = [`$ ${[program, ...(args.args ?? [])].join(" ")}`, `退出码 ${result.exitCode ?? "未知"} · ${result.durationMs}ms`, result.outputText || "（无输出）"].join("\n") + artifactLine;
    return {
      title: `${program} ${result.ok ? "完成" : "失败"}`,
      output,
      metadata: { exitCode: result.exitCode, durationMs: result.durationMs, artifacts: result.artifacts.map((item) => ({ path: item.path, bytes: item.bytes, downloadUrl: item.downloadUrl, ...(item.previewUrl ? { previewUrl: item.previewUrl } : {}) })) },
    };
  },
};

import { taskTool } from "../tools/task.js";

export const builtinTools: ToolDef[] = [readTool, globTool, grepTool, writeTool, editTool, todoTool, bashTool, taskTool];

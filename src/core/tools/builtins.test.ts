import { beforeEach, describe, expect, it, vi } from "vitest";

import { bashTool, editTool, globTool, grepTool, readTool, todoTool, writeTool } from "../tools/builtins.js";
import type { ToolContext } from "../tools/context.js";

function fakeContext(overrides: Partial<ToolContext> = {}): ToolContext & { emitted: { files: unknown[]; artifacts: unknown[]; todos: unknown[] } } {
  const emitted = { files: [] as unknown[], artifacts: [] as unknown[], todos: [] as unknown[] };
  return {
    sessionId: "ses_1",
    userId: "user_1",
    workspaceId: "ws_1",
    agent: "default",
    abort: new AbortController().signal,
    ask: vi.fn(),
    workspace: {
      list: vi.fn().mockResolvedValue([
        { path: "src/index.ts", bytes: 100 },
        { path: "src/util/helper.ts", bytes: 50 },
        { path: "README.md", bytes: 20 },
      ]),
      read: vi.fn().mockImplementation(async (path: string) =>
        path === "src/index.ts" ? { path, content: "import x from './util/helper.js';\nconsole.log(x);\n// TODO fix" } : null,
      ),
      write: vi.fn().mockResolvedValue({ revisionId: "rev_1", diff: "--- /dev/null\n+++ b/a.ts" }),
      edit: vi.fn().mockResolvedValue({ revisionId: "rev_2", diff: "--- a/a.ts\n+++ b/a.ts" }),
    },
    buildSnapshot: vi.fn().mockResolvedValue({ files: [] }),
    runSandbox: vi.fn().mockResolvedValue({
      ok: true,
      exitCode: 0,
      outputText: "hello",
      durationMs: 12,
      artifacts: [{ path: "out/report.pptx", bytes: 1024, contentType: "application/vnd.openxmlformats-officedocument.presentationml.presentation", downloadUrl: "/dl/1" }],
    }),
    setTodos: vi.fn().mockImplementation(async (todos: unknown[]) => {
      emitted.todos.push(todos);
    }),
    emitFileEdited: vi.fn().mockImplementation(async (payload: unknown) => {
      emitted.files.push(payload);
    }),
    emitArtifact: vi.fn().mockImplementation(async (payload: unknown) => {
      emitted.artifacts.push(payload);
    }),
    ...overrides,
    emitted,
  } as ToolContext & { emitted: { files: unknown[]; artifacts: unknown[]; todos: unknown[] } };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("read tool", () => {
  it("returns file content and metadata", async () => {
    const ctx = fakeContext();
    const result = await readTool.execute({ path: "src/index.ts" }, ctx);
    expect(result.output).toContain("console.log");
    expect(result.metadata).toMatchObject({ path: "src/index.ts" });
  });

  it("throws on missing file", async () => {
    await expect(readTool.execute({ path: "nope.ts" }, fakeContext())).rejects.toThrow("文件不存在");
  });

  it("maps permission to read + path", () => {
    expect(readTool.permission({ path: "a/.env" })).toEqual({ permission: "read", patterns: ["a/.env"] });
  });
});

describe("glob tool", () => {
  it("lists all files without a pattern", async () => {
    const result = await globTool.execute({}, fakeContext());
    expect(result.metadata).toMatchObject({ count: 3, total: 3 });
  });

  it("filters by wildcard pattern", async () => {
    const result = await globTool.execute({ pattern: "src/*" }, fakeContext());
    expect(result.output).toContain("src/index.ts");
    expect(result.output).not.toContain("README.md");
  });
});

describe("grep tool", () => {
  it("finds matching lines with path:line format", async () => {
    const ctx = fakeContext();
    const result = await grepTool.execute({ query: "TODO", pathPattern: "src/*" }, ctx);
    expect(result.output).toBe("src/index.ts:3: // TODO fix");
    expect(result.metadata).toMatchObject({ count: 1 });
  });

  it("reports no hits", async () => {
    const result = await grepTool.execute({ query: "zzz" }, fakeContext());
    expect(result.output).toBe("没有命中。");
  });
});

describe("write tool", () => {
  it("writes directly and emits file.edited", async () => {
    const ctx = fakeContext();
    const result = await writeTool.execute({ path: "src/new.ts", content: "export const a = 1;" }, ctx);
    expect(result.metadata).toMatchObject({ revisionId: "rev_1" });
    expect(ctx.emitted.files).toEqual([{ path: "src/new.ts", revisionId: "rev_1", diff: "--- /dev/null\n+++ b/a.ts" }]);
  });

  it("throws when the backend rejects the path", async () => {
    const ctx = fakeContext();
    (ctx.workspace.write as ReturnType<typeof vi.fn>).mockResolvedValue(null);
    await expect(writeTool.execute({ path: "../evil", content: "x" }, ctx)).rejects.toThrow("路径不合法");
  });

  it("maps permission to edit + path", () => {
    expect(writeTool.permission({ path: "a.ts", content: "x" })).toMatchObject({ permission: "edit", patterns: ["a.ts"] });
  });
});

describe("edit tool", () => {
  it("edits directly and emits file.edited", async () => {
    const ctx = fakeContext();
    const result = await editTool.execute({ path: "src/index.ts", oldText: "TODO", newText: "DONE" }, ctx);
    expect(result.metadata).toMatchObject({ revisionId: "rev_2" });
    expect(ctx.emitted.files).toHaveLength(1);
  });

  it("surfaces backend edit errors", async () => {
    const ctx = fakeContext();
    (ctx.workspace.edit as ReturnType<typeof vi.fn>).mockResolvedValue({ error: "oldText 出现多次" });
    await expect(editTool.execute({ path: "a.ts", oldText: "x", newText: "y" }, ctx)).rejects.toThrow("oldText 出现多次");
  });
});

describe("todo tool", () => {
  it("updates the projection without any permission check", async () => {
    const ctx = fakeContext();
    const todos = [
      { content: "读取代码", status: "completed" as const },
      { content: "写脚本", status: "in_progress" as const, priority: "high" as const },
    ];
    const result = await todoTool.execute({ todos }, ctx);
    expect(ctx.emitted.todos).toEqual([todos]);
    expect(result.metadata).toMatchObject({ total: 2, completed: 1 });
    expect(todoTool.permission({ todos })).toBeNull();
  });
});

describe("bash tool", () => {
  it("runs in the sandbox and emits artifact.created per deliverable", async () => {
    const ctx = fakeContext();
    const result = await bashTool.execute({ program: "python3", args: ["gen.py"] }, ctx);
    expect(ctx.runSandbox).toHaveBeenCalledWith(
      expect.objectContaining({ command: { program: "python3", args: ["gen.py"] } }),
    );
    expect(ctx.emitted.artifacts).toEqual([
      expect.objectContaining({ path: "out/report.pptx", bytes: 1024, downloadUrl: "/dl/1" }),
    ]);
    expect(result.output).toContain("退出码 0");
    expect(result.output).toContain("report.pptx");
    expect(result.metadata).toMatchObject({ exitCode: 0 });
  });

  it("syncs text deliverables into the task workspace for later tools", async () => {
    const ctx = fakeContext({
      runSandbox: vi.fn().mockResolvedValue({
        ok: true,
        exitCode: 0,
        outputText: "generated",
        durationMs: 12,
        artifacts: [{ artifactId: "art_real", path: "index.html", bytes: 35, contentType: "text/html", downloadUrl: "/dl/index", workspaceContent: "<html><body>Revenue</body></html>" }],
      }),
    });

    await bashTool.execute({ program: "node", args: ["generate.js"] }, ctx);

    expect(ctx.workspace.write).toHaveBeenCalledWith(expect.objectContaining({ path: "index.html", content: "<html><body>Revenue</body></html>", author: "agent" }));
    expect(ctx.emitted.files).toEqual([expect.objectContaining({ path: "index.html", revisionId: "rev_1" })]);
    expect(ctx.emitted.artifacts).toEqual([expect.objectContaining({ artifactId: "art_real", path: "index.html", downloadUrl: "/dl/index" })]);
  });

  it("rejects programs outside the allow list before touching the sandbox", async () => {
    const ctx = fakeContext();
    await expect(bashTool.execute({ program: "sudo" }, ctx)).rejects.toThrow("不在允许列表");
    expect(ctx.runSandbox).not.toHaveBeenCalled();
  });

  it("maps permission to bash + command, offering program-level always", () => {
    const mapped = bashTool.permission({ program: "npm", args: ["run", "build"] });
    expect(mapped).toMatchObject({
      permission: "bash",
      patterns: ["npm run build"],
      always: ["npm run build", "npm *"],
    });
  });

  it("splits a full command stuffed into program (model behavior) and still runs it", async () => {
    const ctx = fakeContext();
    const result = await bashTool.execute({ program: "python3 --version" }, ctx);
    expect(ctx.runSandbox).toHaveBeenCalledWith(
      expect.objectContaining({ command: { program: "python3", args: ["--version"] } }),
    );
    expect(result.output).toContain("$ python3 --version");
    // permission mapping uses the same split so the pattern matches execution.
    const mapped = bashTool.permission({ program: "ls -la" });
    expect(mapped).toMatchObject({ patterns: ["ls -la"], always: ["ls -la", "ls *"] });
  });

  it("routes shell pipelines stuffed into program through sh -c", async () => {
    const ctx = fakeContext();
    await bashTool.execute({ program: "pip list 2>/dev/null | grep -i pptx" }, ctx);
    expect(ctx.runSandbox).toHaveBeenCalledWith(
      expect.objectContaining({ command: { program: "sh", args: ["-c", "pip list 2>/dev/null | grep -i pptx"] } }),
    );
  });

  it("surfaces the sandbox error message instead of a bare exit code", async () => {
    const ctx = fakeContext({
      runSandbox: vi.fn().mockResolvedValue({
        ok: false,
        exitCode: 1,
        outputText: "",
        durationMs: 562,
        sandboxRunId: null,
        errorMessage: "无法连接 Sandbox 服务",
        artifacts: [],
      }),
    });
    const result = await bashTool.execute({ program: "echo", args: ["hello"] }, ctx);
    expect(result.output).toContain("沙箱错误：无法连接 Sandbox 服务");
  });
});

import { describe, expect, it } from "vitest";

import { applyFilePatch, applyPatchTool, parseUnifiedPatch } from "./patch.js";
import { createFsWorkspaceFiles } from "../../adapters/fs-workspace.js";
import type { ToolContext } from "./context.js";
import type { ToolDef } from "./def.js";

function defAs(): ToolDef {
  return applyPatchTool;
}

function makeCtx(rootFiles: Map<string, string>, emitted: Array<{ path: string; revisionId: string }>): ToolContext {
  const workspace = createFsWorkspaceFiles({ root: rootFiles.get("__root__") ?? "/tmp/patch-test-none" });
  return {
    sessionId: "ses_patch",
    userId: "local",
    workspaceId: "local",
    agent: "default",
    toolCallId: "call_patch",
    workspace,
    emitFileEdited: (async (event: { path: string; revisionId: string }) => {
      emitted.push(event);
    }) as never,
  } as unknown as ToolContext;
}

function tempRootWithFiles(entries: Record<string, string>): string {
  const { mkdtempSync, mkdirSync, writeFileSync } = require("node:fs") as typeof import("node:fs");
  const { tmpdir } = require("node:os") as typeof import("node:os");
  const { join } = require("node:path") as typeof import("node:path");
  const root = mkdtempSync(join(tmpdir(), "fw-patch-"));
  for (const [path, content] of Object.entries(entries)) {
    const full = join(root, path);
    mkdirSync(full.slice(0, full.lastIndexOf("/")), { recursive: true });
    writeFileSync(full, content);
  }
  rootFilesRoots.set(root, entries);
  return root;
}

const rootFilesRoots = new Map<string, Record<string, string>>();

describe("parseUnifiedPatch", () => {
  it("解析多文件多 hunk，剥离 a/ b/ 前缀并识别 /dev/null 新建", () => {
    const { files } = parseUnifiedPatch(
      [
        "diff --git a/src/a.ts b/src/a.ts",
        "index 111..222 100644",
        "--- a/src/a.ts",
        "+++ b/src/a.ts",
        "@@ -1,3 +1,4 @@",
        " line1",
        "-old2",
        "+new2",
        "+new2b",
        " line3",
        "--- /dev/null",
        "+++ b/docs/new.md",
        "@@ -0,0 +1,2 @@",
        "+hello",
        "+world",
      ].join("\n"),
    );
    expect(files).toHaveLength(2);
    expect(files[0]).toMatchObject({ oldPath: "src/a.ts", newPath: "src/a.ts" });
    expect(files[0]!.hunks[0]!.segments.map((s) => s.kind)).toEqual(["context", "remove", "add", "add", "context"]);
    expect(files[1]).toMatchObject({ oldPath: null, newPath: "docs/new.md" });
  });
});

describe("applyFilePatch", () => {
  it("精确应用；找不到上下文时报错指明 hunk 序号", () => {
    const original = ["alpha", "beta", "gamma"].join("\n") + "\n";
    const patch = parseUnifiedPatch(
      ["--- a/f.txt", "+++ b/f.txt", "@@ -2,2 +2,3 @@", " beta", "-gamma", "+Gamma!", "+delta"].join("\n"),
    ).files[0]!;
    const ok = applyFilePatch(original, patch);
    if (!ok.ok) throw new Error(ok.error);
    expect(ok.content).toBe("alpha\nbeta\nGamma!\ndelta\n");

    const bad = parseUnifiedPatch(["--- a/f.txt", "+++ b/f.txt", "@@ -50,1 +50,1 @@", "-nope", "+yep"].join("\n")).files[0]!;
    expect(applyFilePatch(original, bad)).toMatchObject({ ok: false, error: /第 1 个 hunk/ });
  });

  it("行号漂移：补丁 oldStart 过期时在 ±容差内找到真实位置", () => {
    // 文件在补丁行号之后插入了 5 行头部
    const original = [...Array(5).fill("// 注释"), "target()", "keep()"].join("\n") + "\n";
    const patch = parseUnifiedPatch(["--- a/f.js", "+++ b/f.js", "@@ -1,2 +1,2 @@", "-target()", "+replaced()"].join("\n")).files[0]!;
    const res = applyFilePatch(original, patch);
    expect(res.ok).toBe(true);
    expect((res as { content: string }).content).toContain("replaced()");
    expect((res as { content: string }).content).not.toContain("target()");
  });

  it("新建文件走 --- /dev/null；不支持删除报明确错误", () => {
    const created = applyFilePatch(null, parseUnifiedPatch(["--- /dev/null", "+++ b/x.md", "@@ -0,0 +1,1 @@", "+内容"].join("\n")).files[0]!);
    expect(created).toMatchObject({ ok: true, content: "内容\n" });

    const delPatch = parseUnifiedPatch(["--- a/gone.txt", "+++ /dev/null", "@@ -1,1 +0,0 @@", "-bye"].join("\n")).files[0]!;
    expect(applyFilePatch("bye\n", delPatch)).toMatchObject({ ok: false, error: /不支持删除文件/ });
  });
});

describe("applyPatchTool（fs 门面端到端）", () => {
  it("两阶段：全部校验通过才落盘并产出版本+diff 事件；任一失败整体拒绝", async () => {
    const emitted: Array<{ path: string; revisionId: string }> = [];
    const root = tempRootWithFiles({ "src/app.ts": "export const one = 1;\nexport const two = 2;\n" });
    const filesMap = new Map<string, string>([["__root__", root]]);
    const ctx = makeCtx(filesMap, emitted);

    const goodPatch = [
      "--- a/src/app.ts",
      "+++ b/src/app.ts",
      "@@ -1,2 +1,2 @@",
      " export const one = 1;",
      "-export const two = 2;",
      "+export const two = 22;",
    ].join("\n");

    const res = await defAs().execute({ patch: goodPatch }, ctx);
    expect(res.output).toContain("+1/-1");
    expect(emitted).toHaveLength(1);
    expect((res.metadata as { files: unknown[] }).files).toHaveLength(1);

    // 第二个补丁同时改 app.ts 与一个不存在文件 → 两阶段整体拒绝
    const mixed = [goodPatch.replace("two = 22;", "two = 23;"), "--- a/nope.ts", "+++ b/nope.ts", "@@ -1,1 +1,1 @@", "-a", "+b"].join("\n\n");
    await expect(defAs().execute({ patch: mixed }, ctx)).rejects.toThrow(/未应用任何变更|不存在/);

    // 权限映射提取受影响路径（edit 分类）
    const mapped = defAs().permission({ patch: mixed }) as { permission: string; patterns: string[] };
    expect(mapped.permission).toBe("edit");
    expect(mapped.patterns).toEqual(expect.arrayContaining(["src/app.ts", "nope.ts"]));
  }, 15_000);
});

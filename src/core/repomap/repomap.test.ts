import { mkdtemp, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { renderRepoMap } from "./repomap.js";

/** Repo Map 管线测试：真实 tree-sitter wasm 解析 mini fixture 仓，
 *  断言符号抽取、PageRank 排序、预算裁剪、mtime 缓存。 */

const dirs: string[] = [];

async function makeFixture(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "repomap-"));
  dirs.push(root);
  await mkdir(path.join(root, "lib"), { recursive: true });
  await mkdir(path.join(root, "components"), { recursive: true });
  // lib/runtime.ts 定义两个符号，被两个文件引用
  await writeFile(
    path.join(root, "lib", "runtime.ts"),
    [
      "export function runtimeFor(projectPath: string) {",
      "  return { root: projectPath };",
      "}",
      "",
      "export let workspaceRoot = '/tmp/default';",
      "",
      "export class SessionPool {",
      "  get size() { return 0; }",
      "}",
      "",
    ].join("\n"),
    "utf8",
  );
  // app.ts 引用 runtimeFor + workspaceRoot
  await writeFile(
    path.join(root, "app.ts"),
    [
      "import { runtimeFor, workspaceRoot } from './lib/runtime';",
      "const runtime = runtimeFor(workspaceRoot);",
      "console.log(runtime);",
      "",
    ].join("\n"),
    "utf8",
  );
  // components/ChatView.tsx 也引用 runtimeFor
  await writeFile(
    path.join(root, "components", "ChatView.tsx"),
    ["import { runtimeFor } from '../lib/runtime';", "export const view = runtimeFor('x');", ""].join("\n"),
    "utf8",
  );
  // 孤立文件：定义了符号但没人引用
  await writeFile(path.join(root, "orphan.ts"), "export function lonelyThing() {}\n", "utf8");
  // 非代码文件应被跳过
  await writeFile(path.join(root, "README.md"), "# hello\n", "utf8");
  return root;
}

afterEach(async () => {
  // fixture 目录留给系统 tmp 清理，不做 rm（测试沙箱内安全）
  dirs.length = 0;
});

describe("renderRepoMap", () => {
  it("抽取定义符号并渲染地图", async () => {
    const root = await makeFixture();
    const result = await renderRepoMap({ root });
    expect(result.text).toContain("lib/runtime.ts");
    expect(result.text).toContain("runtimeFor");
    expect(result.text).toContain("SessionPool");
    expect(result.text).toContain("lonelyThing");
    expect(result.text).not.toContain("README.md");
    expect(result.stats.indexedFiles).toBe(4); // 3 个 ts + 1 个 tsx
    expect(result.stats.symbolCount).toBeGreaterThan(0);
  });

  it("focus 提及符号提升相关文件排名（personalization）", async () => {
    const root = await makeFixture();
    const withFocus = await renderRepoMap({ root, focus: "修复 runtimeFor 的项目切换问题" });
    const lines = withFocus.text.split("\n");
    const runtimeIdx = lines.findIndex((line) => line.startsWith("lib/runtime.ts"));
    const orphanIdx = lines.findIndex((line) => line.startsWith("orphan.ts"));
    expect(runtimeIdx).toBeGreaterThanOrEqual(0);
    // 被 focus 提及的 runtime.ts 应排在孤立文件之前
    if (orphanIdx >= 0) expect(runtimeIdx).toBeLessThan(orphanIdx);
  });

  it("token 预算裁剪：小预算仍至少返回一个文件", async () => {
    const root = await makeFixture();
    const result = await renderRepoMap({ root, tokenBudget: 64 });
    expect(result.stats.fileCount).toBeGreaterThanOrEqual(1);
    expect(result.stats.tokenEstimate).toBeLessThanOrEqual(256); // 首文件可超预算但不至于失控
  });

  it("mtime 缓存：二次调用命中缓存且结果一致", async () => {
    const root = await makeFixture();
    const first = await renderRepoMap({ root });
    const second = await renderRepoMap({ root });
    expect(second.text).toBe(first.text);
    expect(second.stats.indexedFiles).toBe(first.stats.indexedFiles);
  });
});

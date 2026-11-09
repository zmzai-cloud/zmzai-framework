import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import { resolveFrameworkVendorDirs, resolveVendorDirsFrom } from "./repomap.js";

/** /tmp 在 macOS 是符号链接：断言用 realpath 后的期望路径。 */
const real = (p: string) => realpathSync(p);

/** 0.18.1：依赖布局回归。旧实现只拼「framework 包内嵌套 node_modules」路径——
 *  pnpm（依赖与 @zmzai 同级）和 npm 去重（提升到祖先）两种主流布局下都返回
 *  不存在的目录，消费方经 setWasmDirs 写入后 emscripten 加载失败会结束进程
 *  （Lectern Host 一次 /api/repomap 即崩）。新实现按 Node 依赖查找顺序逐候选
 *  并核对 wasm 文件存在，找不到抛错。 */

const bases: string[] = [];
afterAll(() => { for (const b of bases) rmSync(b, { recursive: true, force: true }); });

/** 造一个只含两个 wasm 探针文件的伪依赖布局。 */
function fakeDeps(root: string, nested: string): void {
  mkdirSync(path.join(root, nested, "web-tree-sitter"), { recursive: true });
  writeFileSync(path.join(root, nested, "web-tree-sitter", "tree-sitter.wasm"), "wasm");
  mkdirSync(path.join(root, nested, "tree-sitter-wasms", "out"), { recursive: true });
  writeFileSync(path.join(root, nested, "tree-sitter-wasms", "out", "tree-sitter-javascript.wasm"), "wasm");
}

describe("resolveVendorDirsFrom：依赖布局感知", () => {
  it("嵌套布局（npm 未去重）：framework/node_modules 下直接命中", () => {
    const root = mkdtempSync(path.join(tmpdir(), "wasm-nested-")); bases.push(root);
    const fw = path.join(root, "agent-framework");
    fakeDeps(root, "agent-framework/node_modules");
    expect(resolveVendorDirsFrom(fw)).toMatchObject({ runtime: real(path.join(fw, "node_modules", "web-tree-sitter")) });
  });

  it("pnpm 布局：依赖在 .pnpm/<entry>/node_modules（与 @zmzai/agent-framework 同级）", () => {
    const root = mkdtempSync(path.join(tmpdir(), "wasm-pnpm-")); bases.push(root);
    // .pnpm/entry/node_modules/@zmzai/agent-framework ← framework 根
    const fw = path.join(root, ".pnpm", "entry", "node_modules", "@zmzai", "agent-framework");
    mkdirSync(fw, { recursive: true });
    fakeDeps(root, ".pnpm/entry/node_modules");
    expect(resolveVendorDirsFrom(fw)).toMatchObject({ runtime: real(path.join(root, ".pnpm", "entry", "node_modules", "web-tree-sitter")) });
  });

  it("npm 提升布局：依赖在祖先 node_modules（monorepo 根）", () => {
    const root = mkdtempSync(path.join(tmpdir(), "wasm-hoist-")); bases.push(root);
    const fw = path.join(root, "packages", "app", "node_modules", "@zmzai", "agent-framework");
    mkdirSync(fw, { recursive: true });
    fakeDeps(root, "node_modules");
    expect(resolveVendorDirsFrom(fw)).toMatchObject({ runtime: real(path.join(root, "node_modules", "web-tree-sitter")) });
  });

  it("缺语法 wasm 的目录不算可用（半残布局跳过，继续找下一个候选）", () => {
    const root = mkdtempSync(path.join(tmpdir(), "wasm-half-")); bases.push(root);
    const fw = path.join(root, "agent-framework");
    // 嵌套位置只有运行时 wasm，没有 tree-sitter-wasms——不应命中
    mkdirSync(path.join(fw, "node_modules", "web-tree-sitter"), { recursive: true });
    writeFileSync(path.join(fw, "node_modules", "web-tree-sitter", "tree-sitter.wasm"), "wasm");
    fakeDeps(root, "node_modules");
    expect(resolveVendorDirsFrom(fw)).toMatchObject({ runtime: real(path.join(root, "node_modules", "web-tree-sitter")) });
  });

  it("全缺失：抛错并列出尝试信息（不再返回不存在的路径）", () => {
    const root = mkdtempSync(path.join(tmpdir(), "wasm-none-")); bases.push(root);
    const fw = path.join(root, "agent-framework");
    mkdirSync(fw, { recursive: true });
    expect(() => resolveVendorDirsFrom(fw)).toThrow(/找不到 tree-sitter wasm 资源/);
  });
});

describe("resolveFrameworkVendorDirs：本仓真实布局（顶层 node_modules）", () => {
  it("框架源码仓内（无自身自链接）也能从 cwd 顶层的 node_modules 命中真实 wasm", () => {
    const dirs = resolveFrameworkVendorDirs();
    expect(dirs.runtime.endsWith("web-tree-sitter")).toBe(true);
    expect(dirs.grammar.endsWith(path.join("tree-sitter-wasms", "out"))).toBe(true);
  });
});

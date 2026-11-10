import { describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createFsWorkspaceFiles } from "./fs-workspace.js";

/** 0.19.2 回归：list() 曾是递归 walk + 逐文件 readFile 拿 bytes——深目录爆调用栈
 *  （用户实测 glob "Maximum call stack size exceeded"）、大工作区全量读内容。
 *  现为显式栈迭代 + stat 拿大小 + 5 万条硬上限。 */
describe("fs workspace list（0.19.2 迭代化）", () => {
  it("深嵌套目录正常遍历（300 层，超出 macOS 单路径可建的更长链）", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "fsw-deep-"));
    try {
      let dir = root;
      for (let i = 0; i < 300; i++) {
        dir = path.join(dir, `d`);
        mkdirSync(dir);
      }
      writeFileSync(path.join(dir, "leaf.txt"), "x");
      const ws = createFsWorkspaceFiles({ root });
      const files = await ws.list();
      expect(files.some((f) => f.path.endsWith("leaf.txt"))).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 30_000);

  it("bytes 来自 stat 而非读取内容；目录符号链接去环仍有效", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "fsw-sym-"));
    try {
      writeFileSync(path.join(root, "a.txt"), "hello");
      mkdirSync(path.join(root, "sub"));
      writeFileSync(path.join(root, "sub", "b.txt"), "world!!");
      symlinkSync(path.join(root, "sub"), path.join(root, "loopback"));
      const ws = createFsWorkspaceFiles({ root });
      const files = await ws.list();
      const a = files.find((f) => f.path === "a.txt");
      expect(a?.bytes).toBe(5);
      // 去环防无限递归：loopback（→sub）只走一次，b.txt 最多两个相对路径（sub/b.txt、loopback/b.txt）
      expect(files.filter((f) => f.path.endsWith("b.txt")).length).toBeLessThanOrEqual(2);
      expect(files.filter((f) => f.path.endsWith("b.txt")).length).toBeGreaterThanOrEqual(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

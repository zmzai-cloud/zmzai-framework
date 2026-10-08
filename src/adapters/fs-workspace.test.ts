import { mkdtemp, mkdir, symlink, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createFsWorkspaceFiles } from "./fs-workspace.js";

/** 符号链接回归（2026-10-08 生产事故：home 快照目录里 agent -> /mnt/... 坏链接，
 *  readdir 列得出、readFile 打不开，list() 无守卫直接 ENOENT，glob/grep 全灭）。 */
describe("createFsWorkspaceFiles list 符号链接", () => {
  let root: string;
  let outside: string;

  beforeAll(async () => {
    root = await mkdtemp(path.join(tmpdir(), "fw-ws-links-"));
    outside = await mkdtemp(path.join(tmpdir(), "fw-ws-outside-"));
    await writeFile(path.join(root, "a.txt"), "hello", "utf8");
    await mkdir(path.join(root, "inner"));
    await writeFile(path.join(root, "inner", "b.txt"), "inner-file", "utf8");
    // 坏链接：目标不存在（事故现场形态）
    await symlink("/mnt/definitely/not/here", path.join(root, "agent"));
    // 指向 root 内目录的链接：应跟随列出
    await symlink(path.join(root, "inner"), path.join(root, "inner-link"));
    // 指向 root 外目录的链接：不跟随（list 出来的路径必须仍可 safeJoin/read）
    await symlink(outside, path.join(root, "outside-link"));
    // 自环：a-loop -> .，遍历必须终止
    await symlink(".", path.join(root, "a-loop"));
    // 指向 root 内文件的链接：作为文件列出
    await symlink(path.join(root, "a.txt"), path.join(root, "a-link.txt"));
    // 外部普通文件链接：read 能读到，应列出
    await writeFile(path.join(outside, "o.txt"), "outside-file", "utf8");
    await symlink(path.join(outside, "o.txt"), path.join(root, "o-link.txt"));
  });

  afterAll(async () => {
    // rm 根目录前先摘掉自环/外指链接，避免递归删除跟随链接越界
    await rm(path.join(root, "a-loop"), { force: true }).catch(() => {});
    await rm(path.join(root, "outside-link"), { force: true }).catch(() => {});
    await rm(root, { recursive: true, force: true }).catch(() => {});
    await rm(outside, { recursive: true, force: true }).catch(() => {});
  });

  it("坏链接不炸整个 list，且各类链接按策略处理", async () => {
    const files = await createFsWorkspaceFiles({ root }).list();
    const paths = files.map((file) => file.path).sort();

    expect(paths).toEqual(["a-link.txt", "a.txt", "inner-link/b.txt", "inner/b.txt", "o-link.txt"]);
    // 坏链接、越界目录链接不出现；inner 经真实目录与链接各列一次（词法路径不同，均合法可读）
    expect(paths).not.toContain("agent");
    expect(paths.some((p) => p.startsWith("outside-link/"))).toBe(false);
    expect(paths.some((p) => p.startsWith("a-loop/"))).toBe(false); // 自环收敛回 root，去重后不重复
    expect(paths.filter((p) => p === "a.txt")).toHaveLength(1);
  });

  it("list 出来的路径都能被 read 读到（list/read 一致性）", async () => {
    const ws = createFsWorkspaceFiles({ root });
    for (const file of await ws.list()) {
      const read = await ws.read(file.path);
      expect(read, file.path).not.toBeNull();
    }
  });
});

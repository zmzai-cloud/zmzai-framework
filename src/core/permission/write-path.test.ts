import { describe, expect, it, vi } from "vitest";

import type { WorkspaceFiles } from "../tools/context.js";
import { confineWorkspaceFiles, pathInWritePaths, writePathGuardRules } from "./write-path.js";

describe("pathInWritePaths", () => {
  it("matches the whitelist root itself and its subtree", () => {
    expect(pathInWritePaths("docs", ["docs"])).toBe(true);
    expect(pathInWritePaths("docs/a.md", ["docs"])).toBe(true);
    expect(pathInWritePaths("docs/sub/b.md", ["docs"])).toBe(true);
  });

  it("does not match sibling prefixes", () => {
    expect(pathInWritePaths("docsx/a.md", ["docs"])).toBe(false);
    expect(pathInWritePaths("src/index.ts", ["docs"])).toBe(false);
  });

  it("matches any of multiple roots", () => {
    expect(pathInWritePaths("reports/q3.md", ["docs", "reports"])).toBe(true);
    expect(pathInWritePaths("secrets.env", ["docs", "reports"])).toBe(false);
  });
});

describe("writePathGuardRules", () => {
  it("puts whitelist allow rules first and the global deny fallback last (LAST match wins)", () => {
    const rules = writePathGuardRules(["docs", "reports"]);
    expect(rules).toEqual([
      { permission: "edit", pattern: "docs/**", action: "allow" },
      { permission: "edit", pattern: "reports/**", action: "allow" },
      { permission: "edit", pattern: "**", action: "deny" },
    ]);
    expect(rules[rules.length - 1]!.action).toBe("deny");
  });

  it("returns no rules for an empty whitelist", () => {
    expect(writePathGuardRules([])).toEqual([]);
  });
});

describe("confineWorkspaceFiles", () => {
  function fakeWorkspace(): WorkspaceFiles & { writeCalls: unknown[]; editCalls: unknown[] } {
    const writeCalls: unknown[] = [];
    const editCalls: unknown[] = [];
    return {
      writeCalls,
      editCalls,
      list: async () => [{ path: "docs/a.md", bytes: 1 }],
      read: async (p) => ({ path: p, content: "content" }),
      write: vi.fn(async (input: { path: string; content: string }) => {
        writeCalls.push(input);
        return { revisionId: "rev_1", diff: `+${input.content}` };
      }),
      edit: vi.fn(async (input: { path: string; oldText: string; newText: string }) => {
        editCalls.push(input);
        return { revisionId: "rev_1", diff: "-old+new" };
      }),
    };
  }

  it("lets whitelisted writes through", async () => {
    const base = fakeWorkspace();
    const confined = confineWorkspaceFiles(base, ["docs"]);
    const result = await confined.write({ path: "docs/a.md", content: "hello", author: "agent", summary: "测试" });
    expect(result).toEqual({ revisionId: "rev_1", diff: "+hello" });
    expect(base.writeCalls).toHaveLength(1);
  });

  it("throws structurally on out-of-whitelist writes (unbypassable)", async () => {
    const base = fakeWorkspace();
    const confined = confineWorkspaceFiles(base, ["docs"]);
    await expect(confined.write({ path: "../etc/passwd", content: "x", author: "agent", summary: "越界" })).rejects.toThrow("写路径越界");
    await expect(confined.edit({ path: "src/index.ts", oldText: "a", newText: "b", author: "agent", summary: "越界" })).rejects.toThrow("写路径越界");
    expect(base.writeCalls).toHaveLength(0);
    expect(base.editCalls).toHaveLength(0);
  });

  it("leaves read/list untouched (exploration needs the full view)", async () => {
    const confined = confineWorkspaceFiles(fakeWorkspace(), ["docs"]);
    const file = await confined.read("src/index.ts");
    expect(file).toEqual({ path: "src/index.ts", content: "content" });
    expect(await confined.list()).toEqual([{ path: "docs/a.md", bytes: 1 }]);
  });
});

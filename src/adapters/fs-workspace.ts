import { mkdir, readFile, writeFile, readdir, unlink } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";

import { createUnifiedDiff } from "./workspace-edit.js";
import type { WorkspaceFiles } from "../core/tools/context.js";

/** FS-backed WorkspaceFiles (M5 §5): the CLI/demo backend operating on a real
 *  directory. Writes land as files with a lightweight revision counter stored
 *  in <root>/.fw-revisions. No Mongo, no sandbox — a standalone runnable
 *  framework. */

type Revision = { id: string; path: string; before: string | null; after: string | null; summary: string; at: string };

const MAX_FILE_BYTES = 512 * 1024;

function revFile(root: string): string {
  return path.join(root, ".fw-revisions.json");
}

async function loadRevisions(root: string): Promise<Revision[]> {
  try {
    return JSON.parse(await readFile(revFile(root), "utf8")) as Revision[];
  } catch {
    return [];
  }
}

async function saveRevisions(root: string, revisions: Revision[]): Promise<void> {
  await writeFile(revFile(root), JSON.stringify(revisions.slice(-200), null, 2), "utf8");
}

function safeJoin(root: string, rel: string): string | null {
  const candidate = path.resolve(root, rel);
  if (candidate !== root && !candidate.startsWith(root + path.sep)) return null;
  return candidate;
}

export function createFsWorkspaceFiles(input: { root: string }): WorkspaceFiles {
  const root = path.resolve(input.root);
  return {
    async list() {
      if (!existsSync(root)) return [];
      const walk = async (dir: string): Promise<{ path: string; bytes: number }[]> => {
        const entries = await readdir(dir, { withFileTypes: true });
        const out: { path: string; bytes: number }[] = [];
        for (const entry of entries) {
          if (entry.name === ".fw-revisions.json" || entry.name.startsWith(".git")) continue;
          const full = path.join(dir, entry.name);
          if (entry.isDirectory()) out.push(...(await walk(full)));
          else out.push({ path: path.relative(root, full), bytes: (await readFile(full)).length });
        }
        return out;
      };
      return walk(root);
    },
    async read(rel) {
      const full = safeJoin(root, rel);
      if (!full || !existsSync(full)) return null;
      const stat = await import("node:fs/promises").then((m) => m.stat(full));
      if (!stat.isFile()) return null;
      if (stat.size > MAX_FILE_BYTES) return null;
      return { path: rel, content: await readFile(full, "utf8") };
    },
    async write({ path: rel, content, summary }) {
      const full = safeJoin(root, rel);
      if (!full) return null;
      await mkdir(path.dirname(full), { recursive: true });
      const before = existsSync(full) ? await readFile(full, "utf8") : null;
      if (Buffer.byteLength(content, "utf8") > MAX_FILE_BYTES) return null;
      await writeFile(full, content, "utf8");
      const id = `rev_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
      await saveRevisions(root, [...(await loadRevisions(root)), { id, path: rel, before, after: content, summary, at: new Date().toISOString() }]);
      return { revisionId: id, diff: createUnifiedDiff({ path: rel, operation: before === null ? "create" : "update", before, after: content }) };
    },
    async edit({ path: rel, oldText, newText, summary }) {
      const full = safeJoin(root, rel);
      if (!full || !existsSync(full)) return { error: `文件不存在：${rel}` };
      const content = await readFile(full, "utf8");
      const first = content.indexOf(oldText);
      if (first === -1) return { error: "EDIT_TARGET_NOT_FOUND" };
      if (content.indexOf(oldText, first + oldText.length) !== -1) return { error: "EDIT_TARGET_AMBIGUOUS" };
      const after = `${content.slice(0, first)}${newText}${content.slice(first + oldText.length)}`;
      await writeFile(full, after, "utf8");
      const id = `rev_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
      await saveRevisions(root, [...(await loadRevisions(root)), { id, path: rel, before: content, after, summary, at: new Date().toISOString() }]);
      return { revisionId: id, diff: createUnifiedDiff({ path: rel, operation: "update", before: content, after }) };
    },
  };
}

export { unlink as deleteFsFile };

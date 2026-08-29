import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";

import type { Tag } from "./tags.js";

/** 标签缓存：mtime 失效（Aider 同款策略），JSON 落 <root>/.zmzai/cache/。
 *  只重析改动文件——Repo Map 的二次调用接近零成本。 */

const CACHE_VERSION = 1;

export type TagCache = {
  version: number;
  entries: Record<string, { mtimeMs: number; size: number; tags: Tag[] }>;
};

function cachePath(root: string): string {
  return path.join(root, ".zmzai", "cache", "repomap-tags.json");
}

export async function loadTagCache(root: string): Promise<TagCache> {
  try {
    const raw = JSON.parse(await readFile(cachePath(root), "utf8")) as TagCache;
    if (raw.version === CACHE_VERSION && typeof raw.entries === "object") return raw;
  } catch {
    // 首次/损坏：重建
  }
  return { version: CACHE_VERSION, entries: {} };
}

/** 返回 (需要重析的文件, 未变文件标签)。 */
export function splitByFreshness(
  cache: TagCache,
  files: string[],
  infos: Map<string, { mtimeMs: number; size: number }>,
): { stale: string[]; freshTags: Tag[] } {
  const stale: string[] = [];
  const freshTags: Tag[] = [];
  for (const file of files) {
    const info = infos.get(file);
    const entry = cache.entries[file];
    if (info && entry && entry.mtimeMs === info.mtimeMs && entry.size === info.size) {
      freshTags.push(...entry.tags);
    } else {
      stale.push(file);
    }
  }
  return { stale, freshTags };
}

export async function saveTagCache(root: string, cache: TagCache): Promise<void> {
  try {
    const file = cachePath(root);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, JSON.stringify(cache), "utf8");
  } catch {
    // 缓存写失败不影响主流程（只读能力）
  }
}

export async function statFiles(root: string, files: string[]): Promise<Map<string, { mtimeMs: number; size: number }>> {
  const infos = new Map<string, { mtimeMs: number; size: number }>();
  await Promise.all(
    files.map(async (file) => {
      try {
        const info = await stat(path.join(root, file));
        infos.set(file, { mtimeMs: info.mtimeMs, size: info.size });
      } catch {
        // 已消失的文件：不入 map（调用方按 stale 处理后 extract 会返回空）
      }
    }),
  );
  return infos;
}

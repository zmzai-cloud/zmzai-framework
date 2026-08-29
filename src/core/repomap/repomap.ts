import path from "node:path";

import { loadTagCache, saveTagCache, splitByFreshness, statFiles } from "./cache.js";
import { buildGraph, pagerank } from "./graph.js";
import { renderMapText } from "./render.js";
import { extractTags, listCodeFiles, type Tag } from "./tags.js";

/** Repo Map 编排（Aider 的完整管线）：文件发现 → mtime 缓存抽取 → 引用图 →
 *  personalized PageRank → 预算渲染。给模型一张「代码库导航图」，
 *  让它不靠盲目 glob/grep 就知道项目结构和该先读哪里。 */

export type RepoMapOptions = {
  root: string;
  /** 任务描述：提到的符号成为 personalization 种子（边权 ×10） */
  focus?: string;
  /** 只索引这些前缀下的文件（相对路径，"/" 分隔） */
  paths?: string[];
  /** 渲染 token 预算（默认 1024，约等于 4KB 文本） */
  tokenBudget?: number;
  maxFiles?: number;
};

export type RepoMapResult = {
  text: string;
  stats: { fileCount: number; symbolCount: number; tokenEstimate: number; indexedFiles: number; hitCap: boolean };
};

const STOPWORDS = new Set([
  "the", "and", "for", "with", "from", "that", "this", "then", "into", "when", "what", "where", "which", "how",
  "function", "class", "return", "const", "let", "var", "import", "export", "type", "interface", "extends",
  "async", "await", "error", "string", "number", "boolean", "object", "array", "value", "file", "files",
  "def", "self", "none", "true", "false", "null", "undefined", "new", "test", "tests", "code",
]);

function mentionedIdents(focus: string | undefined): Set<string> {
  if (!focus) return new Set();
  const idents = focus.match(/[A-Za-z_$][\w$]{2,}/g) ?? [];
  return new Set(idents.filter((name) => !STOPWORDS.has(name.toLowerCase())));
}

export async function renderRepoMap(opts: RepoMapOptions): Promise<RepoMapResult> {
  const root = path.resolve(opts.root);
  const tokenBudget = opts.tokenBudget ?? 1024;

  const { files, skipped } = await listCodeFiles(root, {
    maxFiles: opts.maxFiles ?? 5000,
    filter: opts.paths?.length ? (rel) => opts.paths!.some((prefix) => rel === prefix || rel.startsWith(prefix.endsWith("/") ? prefix : `${prefix}/`)) : undefined,
  });

  const cache = await loadTagCache(root);
  const infos = await statFiles(root, files);
  const { stale, freshTags } = splitByFreshness(cache, files, infos);

  // 重析 stale 文件并回填缓存
  const staleTags: Tag[] = [];
  for (const file of stale) {
    const tags = await extractTags(file, path.join(root, file));
    staleTags.push(...tags);
    const info = infos.get(file);
    if (info) cache.entries[file] = { mtimeMs: info.mtimeMs, size: info.size, tags };
  }
  if (stale.length) await saveTagCache(root, cache);

  const allTags = [...freshTags, ...staleTags];
  const mentioned = mentionedIdents(opts.focus);

  const graph = buildGraph(allTags, mentioned);
  // personalization：包含被提及定义的文件作为随机游走种子
  const personalization = new Map<string, number>();
  if (mentioned.size) {
    for (const tag of allTags) {
      if (tag.kind === "def" && mentioned.has(tag.name)) {
        personalization.set(tag.file, (personalization.get(tag.file) ?? 0) + 1);
      }
    }
  }
  const rank = pagerank(graph, { personalization });
  const defsFiles = new Set(allTags.filter((tag) => tag.kind === "def").map((tag) => tag.file));
  const ranked = [...rank.entries()].sort((a, b) => b[1] - a[1]).map(([file]) => file);
  // 无边文件（定义了但没人引用）也进地图，追加在尾部——否则独立模块不可见
  const rankedFiles = [...ranked, ...[...defsFiles].filter((file) => !rank.has(file)).sort()];

  const rendered = renderMapText(rankedFiles, allTags, tokenBudget);
  return {
    text: rendered.text,
    stats: {
      fileCount: rendered.fileCount,
      symbolCount: rendered.symbolCount,
      tokenEstimate: rendered.tokens,
      indexedFiles: files.length,
      hitCap: skipped > 0,
    },
  };
}

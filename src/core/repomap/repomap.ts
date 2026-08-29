import { realpathSync } from "node:fs";
import path from "node:path";

import { loadTagCache, saveTagCache, splitByFreshness, statFiles } from "./cache.js";
import { buildGraph, pagerank } from "./graph.js";
import { renderMapText } from "./render.js";
import { extractTags, listCodeFiles, setWasmDirs, type Tag } from "./tags.js";

export { setWasmDirs } from "./tags.js";

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
  /** bundler 环境（Next 等）下注入 wasm 资源目录；Node 直跑无需传 */
  vendorDirs?: { runtime?: string; grammar?: string };
};

export type RepoMapResult = {
  text: string;
  stats: { fileCount: number; symbolCount: number; tokenEstimate: number; indexedFiles: number; hitCap: boolean };
};

/** bundler 环境（Next 等）下定位 framework 依赖的 wasm 资源目录：从 framework
 *  包真实磁盘位置出发（穿透 symlink），只需 Node 运行时，不依赖 bundler 的模块
 *  解析。非 Node 运行时或无法定位时抛错——调用方应捕获并 fallback setWasmDirs。 */
export function resolveFrameworkVendorDirs(): { runtime: string; grammar: string } {
  const mod = (process as NodeJS.Process).getBuiltinModule?.("node:module");
  const createRequireFn = mod?.createRequire;
  if (typeof createRequireFn !== "function") throw new Error("node:module.createRequire 不可用（非 Node 运行时）");
  const req = createRequireFn(path.join(process.cwd(), "package.json"));
  // 三个锚点按序尝试：package.json / 主入口（ESM-only 时两个都会被 exports 挡）/
  // node_modules 硬拼（link 包必存在，last resort）
  let entry: string;
  try {
    entry = req.resolve("@zmzai/agent-framework/package.json");
  } catch {
    try {
      entry = req.resolve("@zmzai/agent-framework");
    } catch {
      entry = path.join(process.cwd(), "node_modules", "@zmzai", "agent-framework", "package.json");
    }
  }
  const real = realpathSync(entry);
  const frameworkRoot = real.endsWith("package.json") ? path.dirname(real) : path.dirname(path.dirname(real));
  return {
    runtime: path.join(frameworkRoot, "node_modules", "web-tree-sitter"),
    grammar: path.join(frameworkRoot, "node_modules", "tree-sitter-wasms", "out"),
  };
}

const STOPWORDS = new Set([
  "the", "and", "for", "with", "from", "that", "this", "then", "into", "when", "what", "where", "which", "how",
  "function", "class", "return", "const", "let", "var", "import", "export", "type", "interface", "extends",
  "async", "await", "error", "string", "number", "boolean", "object", "array", "value", "file", "files",
  "def", "self", "none", "true", "false", "null", "undefined", "new", "test", "tests", "code",
]);

function mentionedIdents(focus: string | undefined): Set<string> {
  if (!focus) return new Set();
  const idents = focus.match(/[A-Za-z_$][\w$]{2,}/g) ?? [];
  // 统一小写：任务里常写 PageRank 而 def 名是 pagerank
  return new Set(idents.filter((name) => !STOPWORDS.has(name.toLowerCase())).map((name) => name.toLowerCase()));
}

export async function renderRepoMap(opts: RepoMapOptions): Promise<RepoMapResult> {
  if (opts.vendorDirs) setWasmDirs(opts.vendorDirs);
  const root = path.resolve(opts.root);
  const tokenBudget = opts.tokenBudget ?? 1024;

  const { files, skipped } = await listCodeFiles(root, {
    maxFiles: opts.maxFiles ?? 5000,
    filter: opts.paths?.length ? (rel) => opts.paths!.some((prefix) => rel === prefix || rel.startsWith(prefix.endsWith("/") ? prefix : `${prefix}/`)) : undefined,
  });

  const cache = await loadTagCache(root);
  const infos = await statFiles(root, files);
  const { stale, freshTags } = splitByFreshness(cache, files, infos);

  // 重析 stale 文件并回填缓存。抽取失败（如 bundler 环境下 wasm 不可达）
  // 的文件跳过且不写缓存——下次调用自动重试，坏结果不会被记住。
  const staleTags: Tag[] = [];
  for (const file of stale) {
    let tags: Tag[];
    try {
      tags = await extractTags(file, path.join(root, file));
    } catch {
      continue;
    }
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
      if (tag.kind === "def" && mentioned.has(tag.name.toLowerCase())) {
        personalization.set(tag.file, (personalization.get(tag.file) ?? 0) + 1);
      }
    }
  }
  const rank = pagerank(graph, { personalization });
  const defsFiles = new Set(allTags.filter((tag) => tag.kind === "def").map((tag) => tag.file));
  const ranked = [...rank.entries()].sort((a, b) => b[1] - a[1]).map(([file]) => file);
  // focus 种子文件置顶（PageRank 图只含有边节点——被提及但无人引用的文件
  // 进不了图，必须显式加入）；其后 PageRank 序；最后追加其余无边文件。
  const seeded = new Set(personalization.keys());
  const rankedFiles = [
    ...[...seeded].sort(),
    ...ranked.filter((file) => !seeded.has(file)),
    ...[...defsFiles].filter((file) => !rank.has(file) && !seeded.has(file)).sort(),
  ];

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

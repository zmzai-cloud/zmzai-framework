import type { Tag } from "./tags.js";

/** 引用图 + personalized PageRank（Aider repomap.py 的核心算法，
 *  power iteration 实现约 60 行，O(边数) 每轮）。 */

export type RefGraph = Map<string, Map<string, number>>; // refFile -> defFile -> weight

/** 构建「引用文件 → 定义文件」加权有向图。同名符号被任务提及（focus）
 *  时边权重 ×10——把当前任务关注的符号所在文件拉进个人化种子。 */
export function buildGraph(tags: Tag[], mentioned: Set<string>): RefGraph {
  const defIndex = new Map<string, Map<string, number>>(); // symbol -> defFile -> count
  for (const tag of tags) {
    if (tag.kind !== "def") continue;
    let files = defIndex.get(tag.name);
    if (!files) defIndex.set(tag.name, (files = new Map()));
    files.set(tag.file, (files.get(tag.file) ?? 0) + 1);
  }
  const graph: RefGraph = new Map();
  for (const tag of tags) {
    if (tag.kind !== "ref") continue;
    const targets = defIndex.get(tag.name);
    if (!targets) continue;
    let out = graph.get(tag.file);
    if (!out) graph.set(tag.file, (out = new Map()));
    const weight = mentioned.has(tag.name) ? 10 : 1;
    for (const [defFile] of targets) {
      if (defFile === tag.file) continue; // 自引用不计边
      out.set(defFile, (out.get(defFile) ?? 0) + weight);
    }
  }
  return graph;
}

/** personalized PageRank。personalization 缺省均匀分布。 */
export function pagerank(
  graph: RefGraph,
  opts: { damping?: number; iterations?: number; personalization?: Map<string, number> } = {},
): Map<string, number> {
  const damping = opts.damping ?? 0.85;
  const iterations = opts.iterations ?? 64;

  // 节点全集 = 出边源 ∪ 入边目标（只有引用方的文件也要参与随机游走）
  const nodes = new Set<string>();
  for (const [src, outs] of graph) {
    nodes.add(src);
    for (const dst of outs.keys()) nodes.add(dst);
  }
  const nodeList = [...nodes];
  const count = nodeList.length;
  if (count === 0) return new Map();

  const pers = new Map<string, number>();
  if (opts.personalization?.size) {
    const total = [...opts.personalization.values()].reduce((a, b) => a + b, 0);
    if (total > 0) for (const [node, weight] of opts.personalization) pers.set(node, weight / total);
  }
  const persDefault = pers.size ? 0 : 1 / count;

  let rank = new Map<string, number>(nodeList.map((node) => [node, 1 / count]));
  for (let step = 0; step < iterations; step++) {
    const next = new Map<string, number>();
    let dangling = 0;
    for (const node of nodeList) {
      const outs = graph.get(node);
      const r = rank.get(node)!;
      if (!outs?.size) {
        dangling += r;
        continue;
      }
      let outTotal = 0;
      for (const weight of outs.values()) outTotal += weight;
      for (const [dst, weight] of outs) {
        next.set(dst, (next.get(dst) ?? 0) + (r * weight) / outTotal);
      }
    }
    const base = (1 - damping) / count + (damping * dangling) / count;
    for (const node of nodeList) {
      const value = base + damping * (next.get(node) ?? 0) + damping * (pers.get(node) ?? persDefault);
      next.set(node, value);
    }
    // 收敛检测：最大增量小于阈值提前退出
    let delta = 0;
    for (const node of nodeList) delta = Math.max(delta, Math.abs((next.get(node) ?? 0) - rank.get(node)!));
    rank = next;
    if (delta < 1e-6) break;
  }
  return rank;
}

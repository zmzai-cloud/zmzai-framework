import type { Tag } from "./tags.js";

/** 预算渲染：按 PageRank 降序装文件，每文件列定义行（line: name），
 *  token 估算超预算即止（chars/4 估算，与 compaction 同口径）。 */

export function renderMapText(rankedFiles: string[], tags: Tag[], tokenBudget: number): { text: string; tokens: number; fileCount: number; symbolCount: number } {
  const defsByFile = new Map<string, Tag[]>();
  for (const tag of tags) {
    if (tag.kind !== "def") continue;
    let list = defsByFile.get(tag.file);
    if (!list) defsByFile.set(tag.file, (list = []));
    list.push(tag);
  }

  const lines: string[] = [];
  let tokens = 0;
  let fileCount = 0;
  let symbolCount = 0;
  for (const file of rankedFiles) {
    const defs = defsByFile.get(file);
    if (!defs?.length) continue;
    const sorted = [...defs].sort((a, b) => a.line - b.line);
    const block = [file, ...sorted.map((tag) => `  ${tag.line}: ${tag.name}`)].join("\n");
    const blockTokens = Math.ceil(block.length / 4);
    if (lines.length && tokens + blockTokens > tokenBudget) break; // 至少装一个文件
    lines.push(block);
    tokens += blockTokens;
    fileCount += 1;
    symbolCount += sorted.length;
  }
  return { text: lines.join("\n"), tokens, fileCount, symbolCount };
}

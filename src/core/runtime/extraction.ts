/**
 * 文档提取的结果契约（规格 2 §10.1 / §10.2）。
 *
 * 【为什么 locator 是硬需求】模型引用文件内容时必须能说清「第 4 页」「Sheet1
 * A12:F30」「幻灯片 7」，否则用户无法核对，也就无法信任。所以提取结果不是一段
 * 扁平文本，而是**带定位的分节**；`read_attachment` / `search_attachments` 的输出
 * 一律带 locator。
 *
 * 【为什么框架持有这套类型】framework 不认识 PDF 也不认识 Office——那是 host 的
 * 事（和 `AttachmentProvider` 同一分工）。但工具要按 locator 取块、compaction 要保留
 * 已引用的 locator，这两件事在框架这一侧，所以契约放这里，实现放 host。
 */

/** 定位信息。字段出现哪一个由文件类型决定，不要求全能填。
 *
 *  注意 DOCX 刻意**没有** page：分页是 Word 渲染期的概念，文件里并不存在
 *  「第几页」。硬从渲染结果倒推页码只会给出一个换了字体就变的假定位，所以
 *  Word 文档用 lineStart/lineEnd + 标题层级定位。 */
export type ExtractionLocator = {
  page?: number;
  slide?: number;
  sheet?: string;
  range?: string;
  lineStart?: number;
  lineEnd?: number;
};

export type ExtractedSection = {
  id: string;
  locator: ExtractionLocator;
  text: string;
};

export type ExtractedDocument = {
  attachmentId: string;
  title?: string;
  sections: ExtractedSection[];
  warnings: string[];
  version: number;
};

/** 提取结果的版本。改结构时递增，host 与工具据此拒绝旧格式。 */
export const EXTRACTION_VERSION = 1;

/**
 * 提取结果的上限。解析器的输出属于**不可信输入**：一个 25MB 的 XLSX 能解出
 * 几百万个格子，一个畸形 PDF 能声明几万页。这些上限是 host 侧解析器的硬约束，
 * 也是 `validateExtractedDocument` 的校验依据——先把「解出天文数字」这类失败挡在
 * 记忆与上下文之外，而不是等它把进程撑爆。
 */
export const EXTRACTION_LIMITS = {
  /** 分节总数（PDF 一页一节 / 表格一段一节）。 */
  maxSections: 5_000,
  /** 单节字符数。超长的单页（如整页表格）必须由解析器自己再切。 */
  maxSectionChars: 200_000,
  /** 全文档字符数。 */
  maxTotalChars: 4_000_000,
  maxWarnings: 64,
  maxTitleChars: 500,
} as const;

/** 单次 `read_attachment` 能返回的字符数上限（§10.2「不能把所有提取文本一次性塞进 prompt」）。 */
export const READ_ATTACHMENT_MAX_CHARS = 40_000;
/** `search_attachments` 默认与最大命中数。 */
export const SEARCH_ATTACHMENT_DEFAULT_HITS = 8;
export const SEARCH_ATTACHMENT_MAX_HITS = 30;
/** 搜索片段的上下文半径（命中点左右各取多少字符）。 */
export const SEARCH_SNIPPET_RADIUS = 240;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function locatorOrThrow(raw: unknown): ExtractionLocator {
  if (!isPlainObject(raw)) throw new Error("locator 不合法");
  const locator: ExtractionLocator = {};
  for (const key of ["page", "slide", "lineStart", "lineEnd"] as const) {
    const value = raw[key];
    if (value === undefined) continue;
    if (!Number.isInteger(value) || (value as number) < 1) throw new Error(`locator.${key} 必须是正整数`);
    locator[key] = value as number;
  }
  for (const key of ["sheet", "range"] as const) {
    const value = raw[key];
    if (value === undefined) continue;
    if (typeof value !== "string" || value.length === 0 || value.length > 256) throw new Error(`locator.${key} 不合法`);
    locator[key] = value;
  }
  return locator;
}

/**
 * 校验提取结果（host 解析器的输出同样不可信）。
 *
 * 抛出而不是返回错误对象：调用方要么在这条路径上异常处理，要么就是 host 自己有
 * bug——两种情况都不该靠「读返回值判断」来掩盖。
 */
export function validateExtractedDocument(value: unknown): ExtractedDocument {
  if (!isPlainObject(value)) throw new Error("提取结果不是一个对象");
  if (value.version !== EXTRACTION_VERSION) throw new Error(`提取结果版本不受支持：${String(value.version)}`);
  if (typeof value.attachmentId !== "string" || value.attachmentId.length === 0 || value.attachmentId.length > 128) {
    throw new Error("提取结果的附件 id 不合法");
  }
  if (value.title !== undefined && (typeof value.title !== "string" || value.title.length > EXTRACTION_LIMITS.maxTitleChars)) {
    throw new Error("提取结果的标题不合法");
  }
  const warnings = Array.isArray(value.warnings) ? value.warnings : [];
  if (warnings.length > EXTRACTION_LIMITS.maxWarnings) throw new Error(`解析警告超过 ${EXTRACTION_LIMITS.maxWarnings} 条`);
  for (const warning of warnings) {
    if (typeof warning !== "string" || warning.length === 0 || warning.length > 1_000) throw new Error("解析警告文本不合法");
  }
  if (!Array.isArray(value.sections)) throw new Error("提取结果缺少 sections");
  if (value.sections.length > EXTRACTION_LIMITS.maxSections) {
    throw new Error(`分节数超过 ${EXTRACTION_LIMITS.maxSections}，解析器必须先切块`);
  }
  let totalChars = 0;
  const sections: ExtractedSection[] = value.sections.map((section, index) => {
    if (!isPlainObject(section)) throw new Error(`第 ${index + 1} 节不是对象`);
    const { id, text } = section;
    if (typeof id !== "string" || id.length === 0 || id.length > 128) throw new Error(`第 ${index + 1} 节的 id 不合法`);
    if (typeof text !== "string") throw new Error(`第 ${index + 1} 节的正文不是字符串`);
    if (text.length > EXTRACTION_LIMITS.maxSectionChars) throw new Error(`第 ${index + 1} 节超过 ${EXTRACTION_LIMITS.maxSectionChars} 字符`);
    totalChars += text.length;
    if (totalChars > EXTRACTION_LIMITS.maxTotalChars) throw new Error(`提取正文合计超过 ${EXTRACTION_LIMITS.maxTotalChars} 字符`);
    return { id, locator: locatorOrThrow(section.locator), text };
  });
  return {
    attachmentId: value.attachmentId,
    ...(typeof value.title === "string" ? { title: value.title } : {}),
    sections,
    warnings: warnings as string[],
    version: EXTRACTION_VERSION,
  };
}

/**
 * 把 locator 渲染成人能读（且模型能复述）的一句话。
 *
 * 【为什么必须给一个统一的渲染函数】如果每处各写一遍，工具输出、警告文案和
 * compaction 保留的 locator 迟早会互相不一致，用户看到「第4页」和「第 4 页」
 * 两种写法时会怀疑是不是两处不同的内容。
 */
export function formatLocator(locator: ExtractionLocator): string {
  const parts: string[] = [];
  if (typeof locator.page === "number") parts.push(`第 ${locator.page} 页`);
  if (typeof locator.slide === "number") parts.push(`幻灯片 ${locator.slide}`);
  if (locator.sheet) parts.push(locator.range ? `${locator.sheet} ${locator.range}` : `工作表 ${locator.sheet}`);
  else if (locator.range) parts.push(locator.range);
  if (typeof locator.lineStart === "number") {
    parts.push(locator.lineEnd && locator.lineEnd !== locator.lineStart ? `第 ${locator.lineStart}–${locator.lineEnd} 行` : `第 ${locator.lineStart} 行`);
  }
  return parts.join(" · ") || "整份文件";
}

/**
 * 初始注入选择（§10.2）：小型文档全文内联，大型文档只在预算内取开头。
 *
 * 「按顺序取开头」是刻意的：文档的第一节几乎总是标题、摘要或表头，是最能帮助
 * 模型判断「这份文件跟我这个任务有没有关系」的部分。随机抽样或均匀采样看起来
 * 更公平，但会让模型看不到开头，反而更容易误判。
 */
export function selectInitialSections(
  doc: ExtractedDocument,
  budgetChars: number,
): { sections: ExtractedSection[]; truncated: boolean; totalChars: number } {
  const totalChars = doc.sections.reduce((sum, section) => sum + section.text.length, 0);
  if (totalChars <= budgetChars) return { sections: doc.sections, truncated: false, totalChars };
  const sections: ExtractedSection[] = [];
  let used = 0;
  for (const section of doc.sections) {
    if (used + section.text.length > budgetChars) break;
    sections.push(section);
    used += section.text.length;
  }
  return { sections, truncated: true, totalChars };
}

export type SectionHit = {
  sectionId: string;
  locator: ExtractionLocator;
  /** 命中处附近的片段，两端可能被省略号截断。 */
  snippet: string;
  /** 命中次数（同一节里出现多次只算一条命中，但次数会影响排序）。 */
  occurrences: number;
};

function countOccurrences(haystack: string, needle: string): number {
  let count = 0;
  let index = haystack.indexOf(needle);
  while (index !== -1) {
    count += 1;
    index = haystack.indexOf(needle, index + needle.length);
  }
  return count;
}

function snippetAround(text: string, needle: string, radius: number): string {
  const at = text.toLowerCase().indexOf(needle);
  if (at < 0) return text.slice(0, radius * 2);
  const start = Math.max(0, at - radius);
  const end = Math.min(text.length, at + needle.length + radius);
  return `${start > 0 ? "…" : ""}${text.slice(start, end)}${end < text.length ? "…" : ""}`;
}

/**
 * 在已提取的分节里做字面量搜索（§10.2「先搜索再读取相关块」）。
 *
 * 【为什么是字面量而不是分词/模糊匹配】搜索结果会被当作「文件里真的有这句话」的
 * 证据交给模型。模糊匹配会把「差不多」的内容说成命中，而模型没有能力区分
 * 「文档写了」和「检索器觉得像」——那正是幻觉的来源。大小写不敏感是唯一放宽。
 */
export function searchSections(
  docs: readonly ExtractedDocument[],
  query: string,
  options: { limit?: number; attachmentId?: string } = {},
): Array<SectionHit & { attachmentId: string }> {
  const needle = query.trim().toLowerCase();
  if (needle.length === 0) return [];
  const limit = Math.min(Math.max(1, options.limit ?? SEARCH_ATTACHMENT_DEFAULT_HITS), SEARCH_ATTACHMENT_MAX_HITS);
  const hits: Array<SectionHit & { attachmentId: string; order: number }> = [];
  let order = 0;
  for (const doc of docs) {
    if (options.attachmentId && doc.attachmentId !== options.attachmentId) continue;
    for (const section of doc.sections) {
      const occurrences = countOccurrences(section.text.toLowerCase(), needle);
      if (occurrences === 0) continue;
      hits.push({
        attachmentId: doc.attachmentId,
        sectionId: section.id,
        locator: section.locator,
        snippet: snippetAround(section.text, needle, SEARCH_SNIPPET_RADIUS),
        occurrences,
        order: order++,
      });
    }
  }
  // 命中多的排前面（一段里反复出现的更可能是正题）；同分保持文档顺序，
  // 这样同样的查询每次给出同样的顺序——不稳定排序会让模型看到「同样的搜索
  // 两次结果不同」，进而怀疑自己的判断。
  hits.sort((a, b) => b.occurrences - a.occurrences || a.order - b.order);
  return hits.slice(0, limit).map(({ order: _order, ...hit }) => hit);
}

/** 按 locator 选择分节（`read_attachment` 的定位入口）。 */
export function sectionsForLocator(doc: ExtractedDocument, wanted: Partial<ExtractionLocator> & { sectionId?: string }): ExtractedSection[] {
  if (wanted.sectionId) return doc.sections.filter((section) => section.id === wanted.sectionId);
  return doc.sections.filter((section) => {
    const locator = section.locator;
    if (wanted.page !== undefined && locator.page !== wanted.page) return false;
    if (wanted.slide !== undefined && locator.slide !== wanted.slide) return false;
    if (wanted.sheet !== undefined && locator.sheet?.toLowerCase() !== wanted.sheet.toLowerCase()) return false;
    if (wanted.range !== undefined && locator.range?.toUpperCase() !== wanted.range.toUpperCase()) return false;
    if (wanted.lineStart !== undefined) {
      // 区间相交即命中：调用方给的是「第 12–18 行」，分节可能是「第 1–40 行」
      const end = locator.lineEnd ?? locator.lineStart ?? 0;
      if (end < wanted.lineStart) return false;
    }
    if (wanted.lineEnd !== undefined) {
      const start = locator.lineStart ?? locator.lineEnd ?? 0;
      if (start > wanted.lineEnd) return false;
    }
    return true;
  });
}

/** 压缩（compaction）时要保留的附件清单与已引用定位（§10.2）。 */
export function compactionAttachmentNote(docs: readonly ExtractedDocument[]): string | undefined {
  if (docs.length === 0) return undefined;
  const lines = docs.map((doc) => {
    const outline = doc.sections.slice(0, 12).map((section) => `${section.id}@${formatLocator(section.locator)}`).join(", ");
    return `- attachment_id=${doc.attachmentId}${doc.title ? ` title=${doc.title}` : ""} sections=${doc.sections.length}${outline ? ` outline: ${outline}` : ""}`;
  });
  return [
    "<user_attachments_summary>",
    "Attachments already read in this session. Their full text was dropped by compaction — re-read by attachment_id when needed.",
    ...lines,
    "</user_attachments_summary>",
  ].join("\n");
}

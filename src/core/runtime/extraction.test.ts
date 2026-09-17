import { describe, expect, it } from "vitest";

import {
  EXTRACTION_LIMITS,
  EXTRACTION_VERSION,
  compactionAttachmentNote,
  formatLocator,
  searchSections,
  sectionsForLocator,
  selectInitialSections,
  validateExtractedDocument,
  type ExtractedDocument,
} from "./extraction.js";

function doc(overrides: Partial<ExtractedDocument> = {}): ExtractedDocument {
  return {
    attachmentId: "att_1",
    sections: [
      { id: "s1", locator: { page: 1 }, text: "封面：季度报告" },
      { id: "s2", locator: { page: 2 }, text: "第一节 概述。收入 1200 万，成本 800 万。" },
      { id: "s3", locator: { page: 3 }, text: "第二节 明细。收入 1200 万来自三条产品线。" },
    ],
    warnings: [],
    version: EXTRACTION_VERSION,
    ...overrides,
  };
}

describe("提取结果校验", () => {
  it("接受合法结果并规范化 locator", () => {
    const result = validateExtractedDocument({ ...doc(), version: EXTRACTION_VERSION });
    expect(result.sections).toHaveLength(3);
    expect(result.sections[0]!.locator).toEqual({ page: 1 });
  });

  it("版本不符直接拒绝（host 与工具必须同版本）", () => {
    expect(() => validateExtractedDocument({ ...doc(), version: 0 })).toThrow(/版本/);
  });

  it("分节数超过上限时拒绝，而不是截断后假装完整", () => {
    const sections = Array.from({ length: EXTRACTION_LIMITS.maxSections + 1 }, (_, i) => ({ id: `s${i}`, locator: { page: i + 1 }, text: "x" }));
    expect(() => validateExtractedDocument({ ...doc(), sections })).toThrow(/分节数/);
  });

  it("正文合计超过上限时拒绝", () => {
    const chunk = "x".repeat(EXTRACTION_LIMITS.maxSectionChars);
    const sections = Array.from({ length: Math.ceil(EXTRACTION_LIMITS.maxTotalChars / chunk.length) + 1 }, (_, i) => ({ id: `s${i}`, locator: { page: i + 1 }, text: chunk }));
    expect(() => validateExtractedDocument({ ...doc(), sections })).toThrow(/合计/);
  });

  it("locator 不接受 0 页或非整数页码", () => {
    expect(() => validateExtractedDocument({ ...doc(), sections: [{ id: "s1", locator: { page: 0 }, text: "x" }] })).toThrow(/正整数/);
    expect(() => validateExtractedDocument({ ...doc(), sections: [{ id: "s1", locator: { page: 1.5 }, text: "x" }] })).toThrow(/正整数/);
  });

  it("警告条数与单条长度都受限", () => {
    const warnings = Array.from({ length: EXTRACTION_LIMITS.maxWarnings + 1 }, () => "w");
    expect(() => validateExtractedDocument({ ...doc(), warnings })).toThrow(/警告/);
    expect(() => validateExtractedDocument({ ...doc(), warnings: ["x".repeat(1001)] })).toThrow(/警告文本/);
  });
});

describe("locator 渲染", () => {
  it("各类定位各有说法，且同一种定位只有一种写法", () => {
    expect(formatLocator({ page: 4 })).toBe("第 4 页");
    expect(formatLocator({ slide: 7 })).toBe("幻灯片 7");
    expect(formatLocator({ sheet: "Sheet1", range: "A12:F30" })).toBe("Sheet1 A12:F30");
    expect(formatLocator({ sheet: "Sheet1" })).toBe("工作表 Sheet1");
    expect(formatLocator({ lineStart: 12, lineEnd: 18 })).toBe("第 12–18 行");
    expect(formatLocator({ lineStart: 12, lineEnd: 12 })).toBe("第 12 行");
  });

  it("没有任何定位时给一句可读的话，而不是空串", () => {
    expect(formatLocator({})).toBe("整份文件");
  });

  it("多段定位可以叠加（一张工作表里的一段，带页码语义的 PDF 表格）", () => {
    expect(formatLocator({ page: 4, sheet: "Sheet1", range: "A1:B2" })).toBe("第 4 页 · Sheet1 A1:B2");
  });
});

describe("初始注入预算", () => {
  it("小型文档全文注入", () => {
    const result = selectInitialSections(doc(), 10_000);
    expect(result.truncated).toBe(false);
    expect(result.sections).toHaveLength(3);
  });

  it("大型文档只取开头，并如实标记 truncated", () => {
    const result = selectInitialSections(doc(), 20);
    expect(result.truncated).toBe(true);
    // "封面：季度报告" = 7 字符，第二节 28 字符放不下
    expect(result.sections.map((s) => s.id)).toEqual(["s1"]);
    expect(result.totalChars).toBeGreaterThan(20);
  });

  it("预算为 0 时给空列表而不是一节", () => {
    expect(selectInitialSections(doc(), 0).sections).toEqual([]);
  });

  it("totalChars 是全文长度，不受预算影响（模型要知道文件到底多大）", () => {
    const full = selectInitialSections(doc(), 1_000_000).totalChars;
    expect(selectInitialSections(doc(), 5).totalChars).toBe(full);
  });
});

describe("搜索", () => {
  it("大小写不敏感地命中，并按命中次数排序", () => {
    const hits = searchSections([doc()], "收入 1200 万");
    expect(hits.map((h) => h.sectionId)).toEqual(["s2", "s3"]);
    expect(hits[0]!.occurrences).toBe(1);
  });

  it("重复命中的段落排在前面", () => {
    const repeated: ExtractedDocument = {
      ...doc(),
      sections: [
        { id: "a", locator: { page: 1 }, text: "关键词" },
        { id: "b", locator: { page: 2 }, text: "关键词 关键词 关键词" },
      ],
    };
    expect(searchSections([repeated], "关键词").map((h) => h.sectionId)).toEqual(["b", "a"]);
  });

  it("同分时保持文档顺序——同样查询必须给同样顺序", () => {
    const flat: ExtractedDocument = {
      ...doc(),
      sections: [
        { id: "a", locator: { page: 1 }, text: "甲乙" },
        { id: "b", locator: { page: 2 }, text: "甲乙" },
      ],
    };
    expect(searchSections([flat], "甲乙").map((h) => h.sectionId)).toEqual(["a", "b"]);
    expect(searchSections([flat], "甲乙").map((h) => h.sectionId)).toEqual(["a", "b"]);
  });

  it("片段带上下文与省略号，能看出命中在哪", () => {
    const long: ExtractedDocument = { ...doc(), sections: [{ id: "s1", locator: { page: 1 }, text: `${"前".repeat(500)}针${"后".repeat(500)}` }] };
    const [hit] = searchSections([long], "针", { limit: 1 });
    expect(hit!.snippet.startsWith("…")).toBe(true);
    expect(hit!.snippet.endsWith("…")).toBe(true);
    expect(hit!.snippet).toContain("针");
    expect(hit!.snippet.length).toBeLessThan(600);
  });

  it("空查询不给结果（避免把整份文档当成命中）", () => {
    expect(searchSections([doc()], "   ")).toEqual([]);
  });

  it("可按 attachment 过滤，且命中数受上限约束", () => {
    const other = doc({ attachmentId: "att_2" });
    expect(searchSections([doc(), other], "收入", { attachmentId: "att_2" }).every((h) => h.attachmentId === "att_2")).toBe(true);
    expect(searchSections([doc()], "。", { limit: 1000 }).length).toBeLessThanOrEqual(30);
  });
});

describe("按 locator 取分节", () => {
  it("按页码精确取", () => {
    expect(sectionsForLocator(doc(), { page: 2 }).map((s) => s.id)).toEqual(["s2"]);
  });

  it("按 sectionId 取", () => {
    expect(sectionsForLocator(doc(), { sectionId: "s3" }).map((s) => s.id)).toEqual(["s3"]);
  });

  it("行号区间相交即命中（调用方给 12–18，分节是 1–40）", () => {
    const lines: ExtractedDocument = { ...doc(), sections: [{ id: "l", locator: { lineStart: 1, lineEnd: 40 }, text: "x" }] };
    expect(sectionsForLocator(lines, { lineStart: 12, lineEnd: 18 })).toHaveLength(1);
    expect(sectionsForLocator(lines, { lineStart: 41 })).toHaveLength(0);
    expect(sectionsForLocator(lines, { lineEnd: 0 })).toHaveLength(0);
  });

  it("sheet 名大小写不敏感（用户写 sheet1，文件里是 Sheet1）", () => {
    const sheets: ExtractedDocument = { ...doc(), sections: [{ id: "sh", locator: { sheet: "Sheet1", range: "A1:B2" }, text: "x" }] };
    expect(sectionsForLocator(sheets, { sheet: "sheet1" })).toHaveLength(1);
    expect(sectionsForLocator(sheets, { sheet: "sheet1", range: "a1:b2" })).toHaveLength(1);
  });

  it("无匹配时给空数组，不回落成整份文档", () => {
    expect(sectionsForLocator(doc(), { page: 999 })).toEqual([]);
  });
});

describe("compaction 保留的附件摘要", () => {
  it("保留 id 与大纲，并明确说正文已被丢弃", () => {
    const note = compactionAttachmentNote([doc({ title: "季度报告" })])!;
    expect(note).toContain("attachment_id=att_1");
    expect(note).toContain("季度报告");
    expect(note).toContain("第 1 页");
    expect(note).toContain("dropped by compaction");
  });

  it("没有附件时不给空块", () => {
    expect(compactionAttachmentNote([])).toBeUndefined();
  });
});

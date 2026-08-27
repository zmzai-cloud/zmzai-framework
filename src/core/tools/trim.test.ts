import { describe, expect, it } from "vitest";

import { pruneFailureLog, trimFailureOutput } from "./trim.js";

const passLine = (i: number) => `✓ suite-${i} > case-${i} (${i % 97}ms)`;

/** 5000 行 pass 噪音，中间埋一段失败（01-trim 课程里的合成日志）。 */
function syntheticLog(): string {
  const lines: string[] = [];
  for (let i = 0; i < 2500; i += 1) lines.push(passLine(i));
  lines.push(
    "✗ suite-edge > 并发写冲突应该返回 409",
    "  AssertionError: expected 200 to be 409",
    "      at Object.<anonymous> (src/edge.test.ts:42:11)",
  );
  for (let i = 2500; i < 5000; i += 1) lines.push(passLine(i));
  return lines.join("\n");
}

describe("pruneFailureLog", () => {
  it("keeps only error lines + context, with omission markers between segments", () => {
    const log = syntheticLog();
    const result = pruneFailureLog(log, { contextLines: 2, maxChars: 8_000 });
    expect(result.totalLines).toBe(5003);
    expect(result.keptLines).toBeLessThan(20); // 错误 3 行 + 前后各 2 行上下文
    expect(result.text).toContain("AssertionError: expected 200 to be 409");
    expect(result.text).toContain("src/edge.test.ts:42:11");
    expect(result.text).toContain("省略 2498 行非错误输出"); // 区间之间的省略标记
    expect(result.text).not.toContain("suite-100 "); // pass 噪音被裁掉
    expect(result.text.length).toBeLessThan(1_000);
    expect(result.trimmed).toBe(true);
  });

  it("degrades to head+tail when no line matches an error mark", () => {
    const text = Array.from({ length: 200 }, (_, i) => `plain output line ${i}`).join("\n");
    const result = pruneFailureLog(text, { maxChars: 300 });
    expect(result.trimmed).toBe(true);
    expect(result.text).toContain("plain output line 0"); // 头部保留
    expect(result.text).toContain("plain output line 199"); // 尾部保留
    expect(result.text).not.toContain("plain output line 100\n"); // 中间被省略
    expect(result.text.length).toBeLessThanOrEqual(400);
  });

  it("falls back to head+tail as the final gate when error lines themselves overflow", () => {
    const text = Array.from({ length: 500 }, (_, i) => `Error: boom-${i}`).join("\n");
    const result = pruneFailureLog(text, { contextLines: 0, maxChars: 1_000 });
    expect(result.text.length).toBeLessThanOrEqual(1_200);
    expect(result.trimmed).toBe(true);
  });
});

describe("trimFailureOutput", () => {
  it("leaves small failure outputs untouched", () => {
    const text = "Error: something broke\n  at foo()";
    const result = trimFailureOutput(text);
    expect(result.text).toBe(text);
    expect(result.trimmed).toBe(false);
    expect(result.omittedBytes).toBe(0);
  });

  it("trims a large failure log down to the error scene", () => {
    const log = syntheticLog();
    const result = trimFailureOutput(log);
    expect(result.trimmed).toBe(true);
    expect(result.text).toContain("AssertionError: expected 200 to be 409");
    expect(result.text).not.toContain("suite-3000 ");
    expect(result.text.length).toBeLessThanOrEqual(8_400); // 8000 上限 + 省略标记余量
    expect(result.omittedBytes).toBeGreaterThan(100_000);
  });
});

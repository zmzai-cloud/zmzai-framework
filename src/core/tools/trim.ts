/** 失败日志按行剪裁（tutorial-advanced 01-trim retrofit）：
 *
 *  head+tail 对成功输出够用，但失败日志有更狠的裁法——构建/测试日志的
 *  价值高度集中：几千行 pass 噪音里只有错误声明、断言详情和调用栈值钱。
 *
 *  策略分流（trimToolOutput）：
 *  - failed=true → 只保留命中错误特征的行 + 前后 N 行上下文，区间合并，
 *    区间之间插省略标记；错误行太多撑爆上限时最后一道闸仍是 head+tail。
 *  - failed=false → head+tail（复用 adapter 的 pruneOutput，字节预算）。
 *
 *  两个上限不一样的理由：失败剪裁后信息密度极高（全是错误），8000 字符
 *  ≈ 2000 tokens 足够模型定位问题；成功输出往往是结构化数据，多给配额。
 */

/** 错误行特征：命中任意一条就视为"值钱行"。 */
const ERROR_MARKS: RegExp[] = [
  /\berror\b/i,
  /\bfail(?:ed|ure)?\b/i,
  /\bpanic\b/i,
  /\bexception\b/i,
  /\bassert/i,
  /\btraceback\b/i,
  /\bexit code [^0]/i,
  /[✗✘×]/,
];

export type FailureTrimResult = { text: string; trimmed: boolean; keptLines: number; totalLines: number; omittedBytes: number };

/**
 * 失败日志剪裁：只留错误行 + 上下文。
 * 没找到任何错误行时降级为 head+tail 字符裁剪。
 */
export function pruneFailureLog(text: string, opts: { contextLines?: number; maxChars: number }): FailureTrimResult {
  const contextLines = opts.contextLines ?? 2;
  const lines = text.split("\n");

  // 1. 标记所有值钱行（错误行 + 前后上下文）
  const keep = new Set<number>();
  lines.forEach((line, i) => {
    if (ERROR_MARKS.some((re) => re.test(line))) {
      for (let j = Math.max(0, i - contextLines); j <= Math.min(lines.length - 1, i + contextLines); j += 1) {
        keep.add(j);
      }
    }
  });

  // 2. 一个错误行都没命中——这份输出不像错误日志，降级 head+tail
  const totalLines = lines.length;
  const totalBytes = Buffer.byteLength(text, "utf8");
  if (keep.size === 0) {
    return { ...headTailChars(text, opts.maxChars), keptLines: totalLines, totalLines };
  }

  // 3. 保留行压成连续区间，区间之间插省略标记（runStart/skipped 双指针 O(n)）。
  //    尾部攒下的 skipped 不输出——尾部噪音本来就不要。
  const parts: string[] = [];
  let runStart = -1;
  let skipped = 0;
  for (let i = 0; i <= lines.length; i += 1) {
    const keeping = i < lines.length && keep.has(i);
    if (keeping) {
      if (runStart < 0) {
        if (skipped > 0) parts.push(`…[省略 ${skipped} 行非错误输出]…`);
        runStart = i;
        skipped = 0;
      }
    } else if (runStart >= 0) {
      parts.push(lines.slice(runStart, i).join("\n"));
      runStart = -1;
    }
    if (!keeping) skipped += 1;
  }

  const joined = parts.join("\n");
  if (joined.length <= opts.maxChars) {
    return { text: joined, trimmed: true, keptLines: keep.size, totalLines, omittedBytes: totalBytes - Buffer.byteLength(joined, "utf8") };
  }
  // 4. 错误行太多把结果撑爆上限——最后一道闸仍是 head+tail
  return { ...headTailChars(joined, opts.maxChars), keptLines: keep.size, totalLines };
}

/** 按字符预算做 head+tail（失败路径专用轻量版；成功路径走 adapter 的字节版）。 */
function headTailChars(text: string, maxChars: number): { text: string; trimmed: boolean; omittedBytes: number } {
  if (text.length <= maxChars) return { text, trimmed: false, omittedBytes: 0 };
  const headBudget = Math.floor(maxChars * 0.7);
  const tailBudget = Math.floor(maxChars * 0.25);
  const omitted = text.length - headBudget - tailBudget;
  const result = `${text.slice(0, headBudget)}\n…[省略 ${omitted} 字符，保留头尾]…\n${text.slice(text.length - tailBudget)}`;
  return {
    text: result,
    trimmed: true,
    omittedBytes: Buffer.byteLength(text, "utf8") - Buffer.byteLength(result, "utf8"),
  };
}

/** 工具失败输出裁剪入口：超预算才裁（小失败输出保持原样），失败但没超预算不动。 */
export function trimFailureOutput(text: string): FailureTrimResult {
  if (text.length <= 8_000) {
    const lines = text.split("\n").length;
    return { text, trimmed: false, keptLines: lines, totalLines: lines, omittedBytes: 0 };
  }
  return pruneFailureLog(text, { contextLines: 2, maxChars: 8_000 });
}

import { describe, expect, it } from "vitest";

import {
  BLOCKED_STREAK_THRESHOLD,
  LoopGuard,
  REPEAT_EDIT_FAILURE_THRESHOLD,
  STORM_THRESHOLD,
  normalizeError,
  stormSignature,
} from "./loop-guard.js";

function fail(guard: LoopGuard, toolName: string, errorText: string): string | null {
  return guard.onToolResult({ toolName, isError: true, errorText });
}
function ok(guard: LoopGuard, toolName = "bash"): string | null {
  return guard.onToolResult({ toolName, isError: false, errorText: "" });
}

describe("LoopGuard storm 断路器", () => {
  it("连续同签名失败达到阈值时注入改变策略指令", () => {
    const guard = new LoopGuard();
    expect(fail(guard, "bash", "exit status 1: ModuleNotFoundError")).toBeNull();
    expect(fail(guard, "bash", "exit status 1: ModuleNotFoundError")).toBeNull();
    const advisory = fail(guard, "bash", "exit status 1: ModuleNotFoundError");
    expect(advisory).toContain("循环防护");
    expect(advisory).toContain("bash");
  });

  it("签名不含 args：参数'化妆'但错误相同的重试照样命中", () => {
    const guard = new LoopGuard();
    // 三次错误文本只有行号/数字不同（模型改了参数），归一化后同签名
    fail(guard, "bash", "error at line 12");
    fail(guard, "bash", "error at line 88");
    expect(fail(guard, "bash", "error at line 3")).toContain("循环防护");
  });

  it("注入一次后重新计数，且成功执行清零", () => {
    const guard = new LoopGuard();
    for (let index = 0; index < STORM_THRESHOLD; index += 1) fail(guard, "bash", "same error");
    ok(guard);
    expect(fail(guard, "bash", "same error")).toBeNull();
    expect(fail(guard, "bash", "same error")).toBeNull();
    expect(fail(guard, "bash", "same error")).toContain("循环防护");
  });

  it("不同错误文本不累计", () => {
    const guard = new LoopGuard();
    fail(guard, "bash", "error A");
    fail(guard, "bash", "error A");
    fail(guard, "bash", "error B");
    fail(guard, "bash", "error B");
    expect(fail(guard, "bash", "error A")).toBeNull();
  });

  it("normalizeError 抹数字并压缩空白", () => {
    expect(normalizeError("exit status 127\nat  line  42")).toBe("exit status N at line N");
  });

  it("stormSignature 按工具名区分", () => {
    expect(stormSignature("bash", "err")).not.toBe(stormSignature("edit", "err"));
  });
});

describe("LoopGuard blocked streak", () => {
  it("连续权限拒绝达到阈值时注入指令，且成功执行清零", () => {
    const guard = new LoopGuard();
    for (let index = 0; index < BLOCKED_STREAK_THRESHOLD - 1; index += 1) {
      expect(guard.onBlocked("bash")).toBeNull();
    }
    expect(guard.onBlocked("bash")).toContain("连续被权限拒绝");
    ok(guard);
    expect(guard.onBlocked("bash")).toBeNull();
  });

  it("工具执行结果（含失败）也算中断 blocked streak", () => {
    const guard = new LoopGuard();
    guard.onBlocked("bash");
    guard.onBlocked("bash");
    fail(guard, "read", "文件不存在");
    expect(guard.onBlocked("bash")).toBeNull();
  });
});

describe("LoopGuard edit 重复失败守卫", () => {
  it("同签名失败达到阈值后 needsEditRecheck 为真", () => {
    const guard = new LoopGuard();
    guard.noteEditFailure("a.ts", "old");
    expect(guard.needsEditRecheck("a.ts", "old")).toBe(false);
    for (let index = 1; index < REPEAT_EDIT_FAILURE_THRESHOLD; index += 1) guard.noteEditFailure("a.ts", "old");
    expect(guard.needsEditRecheck("a.ts", "old")).toBe(true);
    // 不同 path / oldText 不受影响
    expect(guard.needsEditRecheck("b.ts", "old")).toBe(false);
    expect(guard.needsEditRecheck("a.ts", "other")).toBe(false);
  });

  it("clearEditFailure 后放行（文件状态已变）", () => {
    const guard = new LoopGuard();
    guard.noteEditFailure("a.ts", "old");
    guard.noteEditFailure("a.ts", "old");
    guard.clearEditFailure("a.ts", "old");
    expect(guard.needsEditRecheck("a.ts", "old")).toBe(false);
  });
});

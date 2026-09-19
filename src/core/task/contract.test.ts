import { describe, expect, it } from "vitest";

import { fallbackResult, initialTaskContract, remainingSteps, renderResult, taskContractText } from "./contract.js";
import type { TaskRecord } from "./types.js";

function taskOf(overrides: Partial<TaskRecord> = {}): TaskRecord {
  return {
    id: "task_1",
    sessionId: "ses_1",
    rootRequestId: "req_1",
    rootUserMessageId: "msg_1",
    goal: "把这个 PDF 的内容完整铺到网页上，并验证页面可用",
    status: "running",
    acceptanceCriteria: [{ id: "crit_implicit", description: "把 PDF 内容铺到网页", required: true, status: "pending", evidenceIds: [] }],
    steps: [],
    evidence: [],
    revision: 1,
    attemptCount: 0,
    noProgressCount: 0,
    constraints: [],
    createdAt: "2026-09-18T00:00:00.000Z",
    updatedAt: "2026-09-18T00:00:00.000Z",
    ...overrides,
  };
}

describe("taskContractText", () => {
  it("带出目标、验收条件与剩余步骤（压缩后仍要能恢复任务）", () => {
    const text = taskContractText(taskOf({
      steps: [
        { id: "s1", title: "解析 PDF", status: "completed", order: 0, evidenceIds: [] },
        { id: "s2", title: "写入页面", status: "in_progress", order: 1, evidenceIds: [] },
      ],
    }));
    expect(text).toContain("把这个 PDF 的内容完整铺到网页上");
    expect(text).toContain("验收条件");
    expect(text).toContain("[x] 解析 PDF");
    expect(text).toContain("[~] 写入页面");
    expect(text).toContain("剩余步骤：写入页面");
  });

  it("把阻塞与「需要用户做什么」写进去，而不是只说请继续", () => {
    const text = taskContractText(taskOf({
      blocker: { kind: "external_auth", message: "GitHub 凭据已失效", requiredAction: "完成登录后任务会自动继续", resumable: true },
    }));
    expect(text).toContain("GitHub 凭据已失效");
    expect(text).toContain("完成登录");
  });

  it("带出用户追加的约束（steering 消息累积）", () => {
    const text = taskContractText(taskOf({ constraints: ["不要动原有导航栏", "图片不要压缩"] }));
    expect(text).toContain("不要动原有导航栏");
    expect(text).toContain("图片不要压缩");
  });

  it("列出已有证据，让续跑知道什么已经验证过", () => {
    const text = taskContractText(taskOf({
      evidence: [{ id: "e1", kind: "command", summary: "pnpm build 通过", createdAt: "2026-09-18T00:00:00.000Z" }],
    }));
    expect(text).toContain("pnpm build 通过");
  });

  it("明确要求不要中途把控制权交回用户", () => {
    const text = taskContractText(taskOf());
    expect(text).toContain("不要在中途把控制权交回用户");
  });

  it("advisory 追加在契约末尾，与契约同源", () => {
    const text = taskContractText(taskOf(), "[任务未推进] 先做诊断");
    expect(text).toContain("[任务未推进] 先做诊断");
    expect(text.indexOf("先做诊断")).toBeGreaterThan(text.indexOf("目标："));
  });

  it("initialTaskContract 与不带 advisory 的契约一致", () => {
    const task = taskOf();
    expect(initialTaskContract(task)).toBe(taskContractText(task));
  });
});

describe("remainingSteps", () => {
  it("只算还没结束的步骤", () => {
    const remaining = remainingSteps(taskOf({
      steps: [
        { id: "s1", title: "已完成", status: "completed", order: 0, evidenceIds: [] },
        { id: "s2", title: "放弃的", status: "cancelled", order: 1, evidenceIds: [] },
        { id: "s3", title: "进行中", status: "in_progress", order: 2, evidenceIds: [] },
        { id: "s4", title: "等着", status: "pending", order: 3, evidenceIds: [] },
      ],
    }));
    expect(remaining.map((step) => step.title)).toEqual(["进行中", "等着"]);
  });
});

describe("renderResult", () => {
  it("四问齐全，剩余项为空时显式写「无」", () => {
    const text = renderResult({ outcome: "铺好了 12 页", changes: ["index.html"], verification: ["pnpm build 通过"], remaining: [] });
    expect(text).toContain("铺好了 12 页");
    expect(text).toContain("改动：index.html");
    expect(text).toContain("验证：pnpm build 通过");
    expect(text).toContain("剩余项：无");
  });

  it("有剩余项时如实列出", () => {
    const text = renderResult({ outcome: "部分完成", changes: [], verification: [], remaining: ["移动端溢出未修"] });
    expect(text).toContain("剩余项：移动端溢出未修");
  });
});

describe("fallbackResult", () => {
  // 它现在是「升级前遗留记录 / 宿主自写 result」的兜底，正常路径走不到（条件 6 要求
  // TaskRecord.result 存在才能交付，而那是 task_deliver 的产物）。断言的重点因此是
  // **它不冒充交付说明**。
  it("没有交付说明时如实说明，而不是编一句「完成了 N 个步骤」", () => {
    const result = fallbackResult({
      task: taskOf({
        steps: [{ id: "s1", title: "解析 PDF", status: "completed", order: 0, evidenceIds: [] }],
        evidence: [{ id: "e1", kind: "command", summary: "pnpm build 通过", createdAt: "2026-09-18T00:00:00.000Z" }],
      }),
      filesEdited: ["index.html"],
      toolCalls: 7,
    });
    expect(result.outcome).toContain("1 个已完成步骤");
    expect(result.outcome).toContain("7 次工具调用");
    expect(result.outcome).toContain("没有留下交付说明");
    expect(result.changes).toEqual(["index.html"]);
    expect(result.verification).toEqual(["pnpm build 通过"]);
    expect(result.remaining).toEqual([]);
    // 不做「已全部完成」这类断言——那是 Completion Gate 的结论，不是这里该下的
    expect(result.outcome).not.toContain("全部完成");
  });

  it("把未完成的步骤如实列进剩余项", () => {
    const result = fallbackResult({
      task: taskOf({ steps: [{ id: "s1", title: "写入页面", status: "in_progress", order: 0, evidenceIds: [] }] }),
      filesEdited: [],
      toolCalls: 2,
    });
    expect(result.remaining).toEqual(["写入页面"]);
  });
});

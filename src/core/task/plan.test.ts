import { describe, expect, it } from "vitest";

import {
  IMPLICIT_CRITERION_ID,
  MAX_EVIDENCE,
  appendEvidence,
  defaultCriteriaFor,
  evidenceKindForTool,
  projectImplicitCriterion,
  projectTodos,
  pruneEvidenceRefs,
  stepIdForContent,
} from "./plan.js";
import type { TaskEvidence, TaskStep } from "./types.js";

const NOW = "2026-09-18T00:00:00.000Z";

describe("defaultCriteriaFor", () => {
  it("无显式验收条件时给一条隐式条件（简单问答不强制拆计划）", () => {
    const criteria = defaultCriteriaFor("解释一下事件循环");
    expect(criteria).toHaveLength(1);
    expect(criteria[0]).toMatchObject({ id: IMPLICIT_CRITERION_ID, required: true, status: "pending" });
    expect(criteria[0]!.description).toBe("解释一下事件循环");
  });
});

describe("stepIdForContent", () => {
  it("同一任务里同样的内容得到同一个 id（模型每轮重发整份列表是常态）", () => {
    expect(stepIdForContent("task_1", "解析 PDF")).toBe(stepIdForContent("task_1", "解析 PDF"));
  });

  it("不同任务里的同名步骤不会互相串号", () => {
    expect(stepIdForContent("task_1", "解析 PDF")).not.toBe(stepIdForContent("task_2", "解析 PDF"));
  });
});

describe("projectTodos", () => {
  it("把 todo 列表投影成步骤，顺序即数组顺序", () => {
    const steps = projectTodos({
      taskId: "task_1",
      steps: [],
      todos: [{ content: "解析 PDF", status: "in_progress" }, { content: "写入页面", status: "pending" }],
      now: NOW,
    });
    expect(steps.map((step) => step.title)).toEqual(["解析 PDF", "写入页面"]);
    expect(steps[0]!.status).toBe("in_progress");
    expect(steps[0]!.startedAt).toBe(NOW);
  });

  it("重复投递同一份列表不会产生重复步骤", () => {
    const first = projectTodos({ taskId: "task_1", steps: [], todos: [{ content: "解析 PDF", status: "pending" }], now: NOW });
    const second = projectTodos({ taskId: "task_1", steps: first, todos: [{ content: "解析 PDF", status: "in_progress" }], now: NOW });
    expect(second).toHaveLength(1);
    expect(second[0]!.status).toBe("in_progress");
  });

  it("已完成的步骤不会被后续投递回退（否则已交付的东西会倒退）", () => {
    const first = projectTodos({ taskId: "task_1", steps: [], todos: [{ content: "解析 PDF", status: "completed" }], now: NOW });
    const second = projectTodos({ taskId: "task_1", steps: first, todos: [{ content: "解析 PDF", status: "pending" }], now: NOW });
    expect(second[0]!.status).toBe("completed");
  });

  it("不再出现的未完成步骤标记为 cancelled 而不是删除（保留重规划痕迹）", () => {
    const first = projectTodos({
      taskId: "task_1",
      steps: [],
      todos: [{ content: "解析 PDF", status: "in_progress" }, { content: "写旧方案", status: "pending" }],
      now: NOW,
    });
    const second = projectTodos({ taskId: "task_1", steps: first, todos: [{ content: "解析 PDF", status: "in_progress" }], now: NOW });
    expect(second).toHaveLength(2);
    expect(second.find((step) => step.title === "写旧方案")!.status).toBe("cancelled");
  });

  it("已完成但不再出现的步骤原样保留", () => {
    const first = projectTodos({ taskId: "task_1", steps: [], todos: [{ content: "解析 PDF", status: "completed" }], now: NOW });
    const second = projectTodos({ taskId: "task_1", steps: first, todos: [], now: NOW });
    expect(second).toHaveLength(1);
    expect(second[0]!.status).toBe("completed");
  });

  it("记录 completedAt，供执行轨迹展示时长", () => {
    const steps = projectTodos({ taskId: "task_1", steps: [], todos: [{ content: "解析 PDF", status: "completed" }], now: NOW });
    expect(steps[0]!.completedAt).toBe(NOW);
  });
});

describe("projectImplicitCriterion", () => {
  const done: TaskStep[] = [{ id: "s1", title: "解析 PDF", status: "completed", order: 0, evidenceIds: [] }];
  const open: TaskStep[] = [{ id: "s1", title: "解析 PDF", status: "in_progress", order: 0, evidenceIds: [] }];

  it("步骤全部完成时隐式条件通过并挂上证据", () => {
    const criteria = projectImplicitCriterion({ criteria: defaultCriteriaFor("目标"), steps: done, evidenceIds: ["evd_1"], answerPresent: true });
    expect(criteria[0]).toMatchObject({ status: "passed", evidenceIds: ["evd_1"] });
  });

  it("有未完成步骤时保持 pending，且不保留证据引用", () => {
    const criteria = projectImplicitCriterion({ criteria: defaultCriteriaFor("目标"), steps: open, evidenceIds: ["evd_1"], answerPresent: true });
    expect(criteria[0]).toMatchObject({ status: "pending", evidenceIds: [] });
  });

  // 纯解释 / 写作 / 问答类任务没有 todo 步骤可拆，唯一可验证的东西就是答复本身
  // （规格 §9 末段）。这两条一起钉住它：有答复才算完成，没答复不能糊过去。
  it("完全没有步骤但已给出答复时通过（纯问答的完成信号）", () => {
    const criteria = projectImplicitCriterion({ criteria: defaultCriteriaFor("目标"), steps: [], evidenceIds: ["evd_1"], answerPresent: true });
    expect(criteria[0]).toMatchObject({ status: "passed", evidenceIds: ["evd_1"] });
  });

  it("完全没有步骤且还没有答复时保持 pending", () => {
    const criteria = projectImplicitCriterion({ criteria: defaultCriteriaFor("目标"), steps: [], evidenceIds: [], answerPresent: false });
    expect(criteria[0]!.status).toBe("pending");
  });

  it("没有隐式条件时原样返回（不动显式条件）", () => {
    const explicit = [{ id: "crit_x", description: "显式", required: true, status: "passed" as const, evidenceIds: ["e"] }];
    expect(projectImplicitCriterion({ criteria: explicit, steps: done, evidenceIds: [], answerPresent: true })).toEqual(explicit);
  });
});

describe("evidenceKindForTool", () => {
  it("写与执行类工具产出证据", () => {
    expect(evidenceKindForTool("bash")).toBe("command");
    expect(evidenceKindForTool("edit")).toBe("file_diff");
    expect(evidenceKindForTool("write")).toBe("file_diff");
    expect(evidenceKindForTool("webfetch")).toBe("external_check");
  });

  // 读取不是验证：把 read 记成证据会让「有证据」退化成「调过工具」
  it("读取类工具不产出证据", () => {
    expect(evidenceKindForTool("read")).toBeNull();
    expect(evidenceKindForTool("glob")).toBeNull();
    expect(evidenceKindForTool("grep")).toBeNull();
    expect(evidenceKindForTool("todo")).toBeNull();
  });
});

describe("appendEvidence", () => {
  const base: TaskEvidence[] = [];

  it("按 (kind, ref) 去重：同一文件改多次只留一条", () => {
    const first = appendEvidence({ evidence: base, kind: "file_diff", summary: "改 a.ts", ref: "src/a.ts", now: NOW });
    const second = appendEvidence({ evidence: first.evidence, kind: "file_diff", summary: "又改 a.ts", ref: "src/a.ts", now: NOW });
    expect(second.evidence).toHaveLength(1);
    expect(second.evidence[0]!.summary).toBe("又改 a.ts");
    // 复用同一条证据的 id：引用它的验收条件不会因为重复改动而悬空
    expect(second.evidence[0]!.id).toBe(first.evidence[0]!.id);
  });

  it("没有 ref 时按 summary 去重", () => {
    const first = appendEvidence({ evidence: base, kind: "model_observation", summary: "已给出解释", now: NOW });
    const second = appendEvidence({ evidence: first.evidence, kind: "model_observation", summary: "已给出解释", now: NOW });
    expect(second.evidence).toHaveLength(1);
  });

  it("超过上限时淘汰最老的，并报告被淘汰的 id", () => {
    let evidence: TaskEvidence[] = [];
    for (let i = 0; i < MAX_EVIDENCE; i += 1) {
      evidence = appendEvidence({ evidence, kind: "tool_result", summary: `第 ${i} 条`, now: NOW }).evidence;
    }
    expect(evidence).toHaveLength(MAX_EVIDENCE);
    expect(evidence.some((item) => item.summary === "第 0 条")).toBe(true);

    const oldestId = evidence[0]!.id;
    const result = appendEvidence({ evidence, kind: "tool_result", summary: "新的一条", now: NOW });
    expect(result.evidence).toHaveLength(MAX_EVIDENCE);
    expect(result.dropped).toEqual([oldestId]);
    expect(result.evidence.some((item) => item.id === oldestId)).toBe(false);
    expect(result.evidence.at(-1)!.summary).toBe("新的一条");
  });
});

describe("pruneEvidenceRefs", () => {
  it("剔除被淘汰证据的悬空引用", () => {
    const items = [{ evidenceIds: ["evd_1", "evd_gone"] }, { evidenceIds: ["evd_2"] }];
    const pruned = pruneEvidenceRefs(items, ["evd_gone"]);
    expect(pruned[0]!.evidenceIds).toEqual(["evd_1"]);
    expect(pruned[1]!.evidenceIds).toEqual(["evd_2"]);
  });

  it("没有淘汰时不改动引用", () => {
    const items = [{ evidenceIds: ["evd_1"] }];
    expect(pruneEvidenceRefs(items, [])).toEqual(items);
  });
});

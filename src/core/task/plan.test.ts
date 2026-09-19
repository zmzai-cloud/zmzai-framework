import { describe, expect, it } from "vitest";

import {
  IMPLICIT_CRITERION_ID,
  MAX_EVIDENCE,
  appendEvidence,
  applyDelivery,
  defaultCriteriaFor,
  evidenceKindForTool,
  projectTodos,
  pruneEvidenceRefs,
  stepIdForContent,
} from "./plan.js";
import type { TaskEvidence } from "./types.js";

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

describe("applyDelivery", () => {
  const criteria = defaultCriteriaFor("把 PDF 铺到网页");
  const toolEvidence: TaskEvidence[] = [
    { id: "evd_cmd", kind: "command", summary: "pnpm build", createdAt: NOW },
    { id: "evd_file", kind: "file_diff", summary: "改了 app/page.tsx", ref: "app/page.tsx", createdAt: NOW },
  ];

  it("省略 criteria 时隐式条件按通过处理，并挂上声明的证据", () => {
    const projection = applyDelivery({
      criteria,
      delivery: { summary: "铺好了", verification: ["打开页面看到内容"] },
      evidence: [],
      declarationEvidenceId: "evd_decl",
      observedChanges: [],
    });
    expect(projection.criteria[0]).toMatchObject({ status: "passed", evidenceIds: ["evd_decl"] });
    expect(projection.unfulfilledRequiredIds).toEqual([]);
  });

  it("四问落进 result；remaining 省略时显式为空数组（§18.7）", () => {
    const projection = applyDelivery({
      criteria,
      delivery: { summary: "铺好了", changes: ["app/page.tsx"], verification: ["pnpm build 通过"], remaining: ["移动端未做"] },
      evidence: toolEvidence,
      observedChanges: ["whatever.ts"],
    });
    expect(projection.result).toEqual({
      outcome: "铺好了",
      changes: ["app/page.tsx"],
      verification: ["pnpm build 通过"],
      remaining: ["移动端未做"],
    });
    const noRemaining = applyDelivery({
      criteria,
      delivery: { summary: "铺好了", verification: ["看了"] },
      evidence: toolEvidence,
      observedChanges: [],
    });
    expect(noRemaining.result.remaining).toEqual([]);
  });

  it("模型没给 changes 时用本轮实际编辑过的文件兜底", () => {
    const projection = applyDelivery({
      criteria,
      delivery: { summary: "改了", verification: ["看了"] },
      evidence: toolEvidence,
      observedChanges: ["src/a.ts", "src/b.ts"],
    });
    expect(projection.result.changes).toEqual(["src/a.ts", "src/b.ts"]);
  });

  // 这是本条改动的核心：证据的来源决定「有证据」这四个字算不算数。
  it("有工具证据时挂工具证据，不挂模型自己的话", () => {
    const projection = applyDelivery({
      criteria,
      delivery: { summary: "铺好了", verification: ["pnpm build 通过"] },
      evidence: toolEvidence,
      declarationEvidenceId: "evd_decl",
      observedChanges: [],
    });
    expect(projection.criteria[0]!.evidenceIds).toEqual(["evd_cmd", "evd_file"]);
  });

  it("显式声明 not_applicable 不能绕过 required 条件", () => {
    const projection = applyDelivery({
      criteria,
      delivery: {
        summary: "算了",
        verification: ["没做"],
        criteria: [{ id: IMPLICIT_CRITERION_ID, status: "not_applicable", evidence: "不适用" }],
      },
      evidence: toolEvidence,
      observedChanges: [],
    });
    expect(projection.criteria[0]!.status).toBe("pending");
    expect(projection.unfulfilledRequiredIds).toEqual([IMPLICIT_CRITERION_ID]);
  });

  it("非 required 条件允许豁免为 not_applicable", () => {
    const optional = [{ id: "crit_opt", description: "可选", required: false, status: "pending" as const, evidenceIds: [] }];
    const projection = applyDelivery({
      criteria: optional,
      delivery: { summary: "做了主体", verification: ["跑了"], criteria: [{ id: "crit_opt", status: "not_applicable", evidence: "本轮不涉及" }] },
      evidence: toolEvidence,
      observedChanges: [],
    });
    expect(projection.criteria[0]!.status).toBe("not_applicable");
  });

  it("声明 failed 的条件不挂证据（避免「有证据」与「没通过」同时为真）", () => {
    const projection = applyDelivery({
      criteria,
      delivery: { summary: "没做完", verification: ["跑了一遍仍有报错"], criteria: [{ id: IMPLICIT_CRITERION_ID, status: "failed", evidence: "构建失败" }] },
      evidence: toolEvidence,
      observedChanges: [],
    });
    expect(projection.criteria[0]).toMatchObject({ status: "failed", evidenceIds: [] });
    expect(projection.unfulfilledRequiredIds).toEqual([IMPLICIT_CRITERION_ID]);
  });

  // 回归：模型只声明了部分条件时，未覆盖的 required 条件必须留在 pending 上被门打回，
  // 而不是被自动补一个通过。旧实现里「有文本 ⇒ 隐式条件通过」正是这么漏的。
  it("未覆盖的 required 条件保持 pending 并进入 unfulfilledRequiredIds", () => {
    const two = [
      ...defaultCriteriaFor("目标"),
      { id: "crit_extra", description: "额外要求", required: true, status: "pending" as const, evidenceIds: [] },
    ];
    const projection = applyDelivery({
      criteria: two,
      delivery: {
        summary: "做了一半",
        verification: ["做了"],
        criteria: [{ id: IMPLICIT_CRITERION_ID, status: "passed", evidence: "看了" }],
      },
      evidence: toolEvidence,
      observedChanges: [],
    });
    expect(projection.criteria[0]!.status).toBe("passed");
    expect(projection.criteria[1]!.status).toBe("pending");
    expect(projection.unfulfilledRequiredIds).toEqual(["crit_extra"]);
  });

  it("声明里引用了不存在的条件 id 时报告出来，但不影响其它条件", () => {
    const projection = applyDelivery({
      criteria,
      delivery: {
        summary: "做了",
        verification: ["看了"],
        criteria: [
          { id: "crit_typo", status: "passed", evidence: "写错了 id" },
          { id: IMPLICIT_CRITERION_ID, status: "passed", evidence: "看了" },
        ],
      },
      evidence: toolEvidence,
      observedChanges: [],
    });
    expect(projection.unknownCriterionIds).toEqual(["crit_typo"]);
    expect(projection.criteria[0]!.status).toBe("passed");
  });

  // `criteria: []` 与省略是同一个意思：不该因为写了对方括号就让隐式条件掉进
  // 「未声明」分支，那会让模型的一次无意义书写变成一轮空转。
  it("空数组与省略等价", () => {
    const projection = applyDelivery({
      criteria,
      delivery: { summary: "做了", verification: ["看了"], criteria: [] },
      evidence: [],
      declarationEvidenceId: "evd_decl",
      observedChanges: [],
    });
    expect(projection.criteria[0]).toMatchObject({ status: "passed", evidenceIds: ["evd_decl"] });
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

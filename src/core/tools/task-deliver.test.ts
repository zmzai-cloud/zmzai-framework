import { describe, expect, it } from "vitest";

import { builtinTools } from "./builtins.js";
import { TASK_DELIVER_TOOL_ID, readTaskDelivery, taskDeliverTool } from "./task-deliver.js";

/** 显式交付声明（规格 3 §9 条件 6）的契约测试。
 *
 *  这个工具承载的是「交付必须是一次显式动作」这条不变量，所以测试与 task_block
 *  同构分三层：合法参数能被读出来、**非法参数必须读成「没有声明」**、以及它真的
 *  注册进了内置工具表。第二层是重点：一次格式错误的调用如果被当成有效声明，
 *  就等于给「随便写点什么都算交付」开了一个新口子——那正是它要堵的洞。 */

describe("readTaskDelivery", () => {
  it("读出四问，并把 summary / verification 原样保留", () => {
    const delivery = readTaskDelivery({
      summary: "页面铺好了",
      changes: ["app/page.tsx"],
      verification: ["pnpm build 通过", "打开预览页看到内容"],
      remaining: ["移动端未适配"],
    });
    expect(delivery).toMatchObject({
      summary: "页面铺好了",
      changes: ["app/page.tsx"],
      verification: ["pnpm build 通过", "打开预览页看到内容"],
      remaining: ["移动端未适配"],
    });
  });

  it("changes / remaining / criteria 都是可选的（隐式条件不必抄 id）", () => {
    const delivery = readTaskDelivery({ summary: "答完了", verification: ["读了一遍"] });
    expect(delivery).not.toBeNull();
    expect(delivery!.changes).toBeUndefined();
    expect(delivery!.criteria).toBeUndefined();
  });

  it("逐条验收结论能被读出，状态值域与 AcceptanceCriterionStatus 对齐", () => {
    const delivery = readTaskDelivery({
      summary: "做了",
      verification: ["跑了"],
      criteria: [
        { id: "crit_implicit", status: "passed", evidence: "pnpm test 全绿" },
        { id: "crit_x", status: "not_applicable", evidence: "本轮不涉及" },
      ],
    });
    expect(delivery!.criteria).toEqual([
      { id: "crit_implicit", status: "passed", evidence: "pnpm test 全绿" },
      { id: "crit_x", status: "not_applicable", evidence: "本轮不涉及" },
    ]);
  });

  it("非法参数一律读成「没有声明」，而不是让一次格式错误换来 delivered", () => {
    const bad: unknown[] = [
      null,
      undefined,
      "已交付",
      {},
      // 问 1 空着
      { summary: "  ", verification: ["看了"] },
      // 问 3 一条都没有：说不清怎么验证的，就不该交付
      { summary: "做完了", verification: [] },
      { summary: "做完了" },
      // 没有 summary
      { verification: ["看了"] },
      // 状态值域外
      { summary: "做了", verification: ["看了"], criteria: [{ id: "c1", status: "pending", evidence: "还没结论" }] },
      // 逐条结论缺依据
      { summary: "做了", verification: ["看了"], criteria: [{ id: "c1", status: "passed" }] },
      // 超过上限
      { summary: "做了", verification: ["看了"], criteria: Array.from({ length: 13 }, (_, i) => ({ id: `c${i}`, status: "passed", evidence: "看" })) },
    ];
    for (const args of bad) expect(readTaskDelivery(args), JSON.stringify(args)).toBeNull();
  });
});

describe("taskDeliverTool", () => {
  it("不需要授权——它只提交声明，判定仍由 Completion Gate 做", () => {
    expect(taskDeliverTool.permission({ summary: "做了", verification: ["看了"] })).toBeNull();
  });

  it("回执把四问摆出来，并说清任务仍要过独立核对", async () => {
    const result = await taskDeliverTool.execute(
      {
        summary: "PDF 内容已铺到网页",
        changes: ["app/page.tsx"],
        verification: ["pnpm build 通过"],
        remaining: ["移动端未适配"],
      },
      {} as never,
    );
    expect(result.output).toContain("系统会独立核对");
    expect(result.output).toContain("PDF 内容已铺到网页");
    expect(result.output).toContain("app/page.tsx");
    expect(result.output).toContain("pnpm build 通过");
    expect(result.output).toContain("移动端未适配");
    expect(result.metadata).toMatchObject({ taskDelivery: { summary: "PDF 内容已铺到网页" } });
  });

  it("没给逐条结论时回执写明隐式条件按通过处理", async () => {
    const result = await taskDeliverTool.execute({ summary: "答完了", verification: ["读了一遍"] }, {} as never);
    expect(result.output).toContain("隐式验收条件按通过处理");
    expect(result.output).toContain("剩余项：无");
  });

  it("已在内置工具表里注册（没注册的话运行时根本看不到它）", () => {
    expect(builtinTools.some((tool) => tool.id === TASK_DELIVER_TOOL_ID)).toBe(true);
  });
});

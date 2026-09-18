import { describe, expect, it } from "vitest";

import { builtinTools } from "./builtins.js";
import { TASK_BLOCK_TOOL_ID, readTaskBlock, taskBlockTool } from "./task-block.js";

/** 声明型工具（规格 3 §11）的契约测试。
 *
 *  这个工具的价值全在「模型说什么就变成什么状态」这一条链路上，所以测试分三层：
 *  参数能被正确读出来、非法参数读不出来、以及它必须真的注册进内置工具表——
 *  最后一条不是废话：工具定义了但没注册，运行时永远看不到它，而单测照样全绿。 */

describe("readTaskBlock", () => {
  it("读出三类声明，并把 message / requiredAction 原样保留", () => {
    for (const kind of ["input", "choice", "external_auth"] as const) {
      const block = readTaskBlock({ kind, message: `卡在 ${kind}`, requiredAction: "去做某件事" });
      expect(block).toMatchObject({ kind, message: `卡在 ${kind}`, requiredAction: "去做某件事" });
    }
  });

  it("缺少 options 不算非法——只有 choice 才需要候选", () => {
    expect(readTaskBlock({ kind: "input", message: "缺域名", requiredAction: "给我域名" })).not.toBeNull();
  });

  it("非法参数一律读成「没有声明」，而不是把任务冻住", () => {
    const bad: unknown[] = [
      null,
      undefined,
      "input",
      {},
      { kind: "吃饭", message: "m", requiredAction: "r" },
      { kind: "input", message: "", requiredAction: "r" },
      { kind: "input", message: "m" },
      { kind: "input", message: "m", requiredAction: "r", options: "只有一项" },
    ];
    for (const args of bad) expect(readTaskBlock(args), JSON.stringify(args)).toBeNull();
  });
});

describe("taskBlockTool", () => {
  it("不需要授权——它只声明状态，不产生任何副作用", () => {
    expect(taskBlockTool.permission({ kind: "input", message: "m", requiredAction: "r" })).toBeNull();
  });

  it("回执告诉模型「停下来等」并提醒它说清卡在哪", async () => {
    const result = await taskBlockTool.execute(
      { kind: "choice", message: "两种发布方式", requiredAction: "选一个", options: ["覆盖", "保留"] },
      {} as never,
    );
    expect(result.output).toContain("不会自动继续");
    expect(result.output).toContain("两种发布方式");
    expect(result.output).toContain("覆盖 / 保留");
    expect(result.metadata).toMatchObject({ taskBlock: { kind: "choice" } });
  });

  it("已在内置工具表里注册（没注册的话运行时根本看不到它）", () => {
    expect(builtinTools.some((tool) => tool.id === TASK_BLOCK_TOOL_ID)).toBe(true);
  });
});

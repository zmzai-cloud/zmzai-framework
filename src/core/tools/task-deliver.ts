import { z } from "zod";

import type { ToolDef } from "./def.js";

/** 任务级「我交付了」的**显式声明**工具（规格 3 §9 / §14.1）。
 *
 * 【为什么必须有这个工具】Completion Gate 的五条条件里，「验收条件是否通过」
 * 这一条在运行时没有任何独立事实可依——验收条件写的是用户的目标，达成与否
 * 只有做事的那个人知道。在它之前，这一步是靠**推导**补上的：
 * `projectImplicitCriterion` 看「模型这轮有没有输出文本」，有文本就把隐式条件
 * 判 passed。那是一条从「文本非空」到「目标已实现」的跳跃，于是模型的任何
 * 一句收尾话都能换到 delivered。
 *
 * 真实事故的形状是这样的：用户发「继续执行」，模型回「继续。跑自检验证前面
 * 改动的正确性：」——**一句话停在冒号上、零工具调用、28 个输出 token**——
 * 然后框架照常发 `task.delivered`，交付卡上写着「完成了 0 个步骤、0 次工具
 * 调用」「剩余项：无」。任务进了终态，用户那句「继续执行」被彻底吞掉。
 *
 * 【为什么不是把启发式写得更聪明】在最终文本里找「已完成」「剩余项」之类的
 * 模式，会在正常交付里误判，也会被模型的口癖绕过。`task_block` 的注释里已经
 * 写过同一条判断：**不猜，让模型显式声明**。交付也一样——它是一次动作，不是
 * 一种可以被推断出来的语气。
 *
 * 【它不是逃生舱】声明交付不会绕过门：模型给的是**输入**（每条验收条件的结论、
 * 怎么验证的、还剩什么），门仍然独立检查阻塞、未完成步骤、证据是否对得上号、
 * 有没有最终文本。模型无法用一次 `task_deliver` 换来一个 delivered——它只能
 * 把「达成与否」这个只有它知道的事实说出来，然后由门决定能不能交付。
 *
 * 【四问答的来源】规格 §14.1 的交付卡固定回答四个问题，§18.7 要求「无剩余项时
 * 明确为『无』」。这里让模型直接按这四个问题填，而不是让框架事后从统计数字里
 * 编一段——旧实现里那句「完成了 0 个步骤、0 次工具调用。」就是这么编出来的。 */
export const TASK_DELIVER_TOOL_ID = "task_deliver";

/** 逐条验收条件的状态。与 `AcceptanceCriterionStatus` 同值域，但**不含**
 *  `pending`：交付声明里说「还没结论」是没有意义的。 */
export const taskDeliverCriterionStatuses = ["passed", "failed", "not_applicable"] as const;

export const taskDeliverInputSchema = z.object({
  /** 问 1：做成了什么。给用户看的一句话，不要复述目标。 */
  summary: z.string().trim().min(1).max(1200),
  /** 问 2：改了哪些主要内容。省略时框架用本轮实际编辑过的文件补。 */
  changes: z.array(z.string().trim().min(1).max(200)).max(12).optional(),
  /** 问 3：怎么验证的。**至少一条**——这正是旧实现里最容易空掉的一格：
   *  「有验证」是交付的底线，声明里连一句验证都写不出来，就不该交付。 */
  verification: z.array(z.string().trim().min(1).max(400)).min(1).max(12),
  /** 问 4：还有哪些没做完。**必须显式给**（空数组也算给了）——规格 §18.7
   *  禁止让「没写」和「没有」两种含义糊在一起。 */
  remaining: z.array(z.string().trim().min(1).max(200)).max(12).optional(),
  /** 逐条验收条件的结论。id 用任务契约里印出来的那一个
   *  （`<task-contract>` 的验收条件列表带方括号 id）。
   *
   *  【为什么 optional】任务只有隐式条件（`crit_implicit`，描述就是用户的
   *  目标）时，`summary` + `verification` 已经回答了同一个问题，再要求模型
   *  抄一遍 id 只是形式。省略即「隐式条件按 passed 处理」；给了就逐条按声明
   *  走，**未覆盖的 required 条件保持 pending**，门会因为「验收条件未通过」
   *  把它打回续跑，并在 advisory 里点名缺哪一条。 */
  criteria: z
    .array(
      z.object({
        id: z.string().trim().min(1).max(80),
        status: z.enum(taskDeliverCriterionStatuses),
        /** 这条结论的依据。写清「看到/跑了什么」，不要写「已完成」。 */
        evidence: z.string().trim().min(1).max(400),
      }),
    )
    .max(12)
    .optional(),
});

export type TaskDeliverInput = z.infer<typeof taskDeliverInputSchema>;

export const taskDeliverTool: ToolDef<typeof taskDeliverInputSchema> = {
  id: TASK_DELIVER_TOOL_ID,
  label: "提交交付",
  description:
    "声明这个任务已经完成，并按四个问题提交交付信息：做成了什么、改了哪些主要内容、怎么验证的、还有哪些没做完。**任务只有在你调用它之后才会结束**——结束本轮、给出一段收尾文字、把 todo 标记完成都不能交付。调用时机：验收条件真的都满足了，而且你能说清是怎么验证的。如果你的答复还没达到目标，不要调用它，继续做事或用 task_block 说明卡在哪里。",
  parameters: taskDeliverInputSchema,
  // 无副作用：它只提交一份结构化声明，真正的判定仍由 Completion Gate 做。
  permission: () => null,
  async execute(args) {
    const criteria = args.criteria?.length
      ? args.criteria.map((item) => `- [${item.id}] ${item.status}：${item.evidence}`).join("\n")
      : "（未逐条声明，隐式验收条件按通过处理）";
    const changes = args.changes?.length ? args.changes.join("、") : "（由框架按本轮实际改动的文件补）";
    const remaining = args.remaining?.length ? args.remaining.join("、") : "无";
    return {
      title: "提交交付信息",
      output: [
        "已提交交付信息。系统会独立核对验收条件、未完成步骤与证据，再决定任务是否结束。",
        `做成了什么：${args.summary}`,
        `改动：${changes}`,
        `验证：${args.verification.join("；")}`,
        `剩余项：${remaining}`,
        "验收结论：",
        criteria,
        "请用一段话把上面这些告诉用户，然后结束本轮。不要再启动新的大段工作——如果你发现还有没做完的，继续做，等做完再交付。",
      ].join("\n"),
      metadata: { taskDelivery: args },
    };
  },
};

/** 从工具调用参数里取回交付声明（runner 用；参数来自模型，必须过 schema）。
 *  非法参数按「没有声明」处理——一次格式不对的调用不该把任务判成已交付，
 *  也不该让这一轮白跑：门会继续要求交付，模型下一次调用时改正即可。 */
export function readTaskDelivery(args: unknown): TaskDeliverInput | null {
  const parsed = taskDeliverInputSchema.safeParse(args);
  return parsed.success ? parsed.data : null;
}

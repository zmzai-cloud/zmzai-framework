import { z } from "zod";

import type { ToolDef } from "./def.js";

/** 任务级「需要用户介入」的声明工具（规格 3 §11 / §17.3 场景 B）。
 *
 * 【为什么必须有这个工具】规格 §11 列了五种允许要求用户介入的场景，其中三种
 * （缺信息、要在两个不可逆方案里选、外部登录/验证码/付款）在实现上需要**模型
 * 自己说出来**。在此之前，`CompletionRuntimeState` 的 `inputRequired` /
 * `choiceRequired` / `externalAuthRequired` 三个字段只有单测会填，运行时一律写
 * null——任务契约里那句「只有确实需要用户…时才停下，并说明卡在哪里」因此是一句
 * **无法执行的指示**：模型照做，停下来说明，而运行时只看到「这一轮结束了、步骤
 * 还剩着」，于是把它当成续跑，再跑一遍，再停……一直到连续三轮无进展，用户收到
 * 的是一句「连续 3 轮没有实质进展」。真实原因（缺一个域名）被掩盖成了一个
 * 性能问题。
 *
 * 【为什么是个工具而不是对最终文本做启发式】在模型最后一段话里找问号、「请提供」
 * 之类的模式，会在正常交付里误判——「要不要我顺便加上移动端适配？」是一句礼貌的
 * 收尾，不是阻塞。误判的代价是把一个已经能继续的任务冻结住等用户，而用户可能
 * 根本没在看。工具调用是一个明确的、结构化的动作：模型**主动**声明「我卡住了，
 * 原因是 X，需要你做 Y」。§19 的精神也是这个方向——不许把「无法继续」包装成
 * 别的样子。
 *
 * 【它不是逃生舱】声明阻塞会让任务停下来等用户，是不便宜的。所以：
 * - description 里写清使用边界，并明确「不要为了让用户确认计划而调用」；
 * - 同一个任务里模型若反复用它来回避工作，用户会直接看到它在等什么——
 *   每次都要写 message 与 requiredAction，编不出理由就没法用；
 * - 它自己不产生任何副作用，因此不需要授权（`permission: () => null`）。 */
export const TASK_BLOCK_TOOL_ID = "task_block";

export const taskBlockKinds = ["input", "choice", "external_auth"] as const;

export const taskBlockInputSchema = z.object({
  kind: z.enum(taskBlockKinds),
  /** 卡在哪里——会原样显示在任务卡上，必须具体到「缺什么」。 */
  message: z.string().trim().min(1).max(600),
  /** 用户做完什么之后任务能继续。§14.4 禁止只说「请继续」。 */
  requiredAction: z.string().trim().min(1).max(400),
  /** `kind: "choice"` 时的候选项，会给界面用来渲染可选项。
   *
   *  【为什么是 `.optional()` 而不是 `.default([])`】`default` 在推导出的
   *  JSON Schema 里会变成**必填**字段，而模型在 `input` / `external_auth` 两种
   *  情况下根本不会传它——于是每一次声明都因为「缺少 options」被挡在工具校验，
   *  `task_block` 成了个永远调不通的工具。这正是它存在的意义所在，所以这里
   *  宁可让 `undefined` 一路传下来，在 `execute` 里归一。 */
  options: z.array(z.string().trim().min(1).max(200)).max(6).optional(),
});

export type TaskBlockInput = z.infer<typeof taskBlockInputSchema>;

/** 三类各自对应的用户动作，用来生成工具结果回执。 */
const KIND_HINT: Record<TaskBlockInput["kind"], string> = {
  input: "缺少必要信息",
  choice: "需要用户在两个方案之间选择",
  external_auth: "需要用户完成外部登录、验证码或付款",
};

export const taskBlockTool: ToolDef<typeof taskBlockInputSchema> = {
  id: TASK_BLOCK_TOOL_ID,
  contract: { effect: [], retrySafety: "read_only" },
  label: "声明任务受阻",
  description:
    "声明这个任务被卡住了，必须由用户介入才能继续。仅在以下情况调用：① 缺少的信息确实无法从工作区、工具或已有上下文中获得；② 有两个会产生明显不同且不可逆结果的方案，必须由用户选；③ 需要用户完成外部登录、验证码或付款。不要为了让用户确认计划而调用——计划默认直接执行。调用后本轮就结束，请用一句话说明卡在哪里以及需要用户做什么。",
  parameters: taskBlockInputSchema,
  // 无副作用：它只声明状态，让任务停在等待上——这不是一次写操作，不需要授权。
  permission: () => null,
  async execute(args) {
    const options = args.options?.length ? `\n候选方案：${args.options.join(" / ")}` : "";
    return {
      title: `任务受阻：${KIND_HINT[args.kind]}`,
      output: [
        "已记录这个阻塞。任务现在停在等待用户处理的状态，不会自动继续。",
        `原因：${args.message}`,
        `需要用户做：${args.requiredAction}${options}`,
        "请用一句话向用户说明卡在哪里以及需要他做什么，然后结束本轮。用户处理完之后任务会从当前步骤接着做，不必重做已经完成的部分。",
      ].join("\n"),
      metadata: { taskBlock: args },
    };
  },
};

/** 从工具调用参数里取回声明（runner 用；参数来自模型，必须过 schema）。
 *  非法参数按「没有声明」处理——一个格式不对的工具调用不该把任务冻住。 */
export function readTaskBlock(args: unknown): TaskBlockInput | null {
  const parsed = taskBlockInputSchema.safeParse(args);
  return parsed.success ? parsed.data : null;
}

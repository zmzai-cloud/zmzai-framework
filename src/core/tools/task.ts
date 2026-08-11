import { z } from "zod";

import type { ToolDef } from "../tools/def.js";

/** task tool (spec §6.4): spawns a subagent as a child session. Depth is
 *  capped, the child inherits the parent workspace + a permission ruleset
 *  merging parent session rules and the subagent preset, and the child runs
 *  to completion within this tool call. The rendered <task> result goes back
 *  to the parent model; a subtask part is recorded in the parent transcript. */
export const taskTool: ToolDef = {
  id: "task",
  label: "派生子代理",
  description:
    "把一个独立的子任务交给子代理在新会话中完成。用于并行探索（explore）或隔离的通用子任务（general）。子代理有自己的上下文；你只收到它的最终结论。available subagents 见系统提示或 registry。",
  parameters: z.object({
    description: z.string().min(3).max(60),
    prompt: z.string().min(1).max(8 * 1024),
    subagent_type: z.string().min(1).max(64),
  }),
  permission: (args) => ({ permission: "task", patterns: [args.subagent_type], always: ["*"], metadata: { subagent: args.subagent_type, description: args.description } }),
  executionMode: "sequential",
  async execute(args, ctx) {
    if (!ctx.spawnSubagent) throw new Error("当前环境不支持子代理");
    const result = await ctx.spawnSubagent({
      description: args.description,
      prompt: args.prompt,
      subagentType: args.subagent_type,
    });
    return {
      title: `子代理 ${args.subagent_type}：${args.description}`,
      output: result.summary,
      metadata: { childSessionId: result.childSessionId, subagent: args.subagent_type, state: result.state },
    };
  },
};

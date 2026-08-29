import { z } from "zod";

import { renderRepoMap } from "../repomap/repomap.js";
import type { ToolDef } from "./def.js";

/** repo_map 工具（R1，来源 Aider）：返回工作区的代码结构导航图。
 *  只读（permission 复用 read 类，基线 allow / explore 显式 allow）。
 *  用法建议已写进 default/explore prompt：大型探索任务先 repo_map 再精准 read。 */
export function createRepoMapTool(opts: { workspaceRoot: () => string }): ToolDef {
  return {
    id: "repo_map",
    label: "仓库地图",
    description:
      "获取当前 Workspace 的代码结构导航图：按重要性排序的文件 + 每文件的定义符号（函数/类/接口，带行号）。在开始大范围探索前先调用它，可以少走 glob/grep 弯路；用 focus 传入任务描述或关键符号名，地图会优先显示与任务最相关的文件。返回文本很紧凑（默认 ~1k tokens）。",
    parameters: z.object({
      focus: z.string().max(4000).optional().describe("当前任务描述或关键符号名（如类/函数名），地图会优先显示相关文件"),
      paths: z.array(z.string().max(512)).max(20).optional().describe("只索引这些目录前缀（相对工作区路径）"),
      tokenBudget: z.number().int().min(256).max(8192).optional().describe("渲染 token 预算，默认 1024"),
    }),
    permission: () => ({ permission: "read", patterns: ["**"] }),
    async execute(args) {
      const root = opts.workspaceRoot();
      const result = await renderRepoMap({
        root,
        focus: args.focus,
        paths: args.paths,
        tokenBudget: args.tokenBudget,
      });
      const header = `[仓库地图] 索引 ${result.stats.indexedFiles} 个代码文件，渲染 ${result.stats.fileCount} 个文件 / ${result.stats.symbolCount} 个符号（~${result.stats.tokenEstimate} tokens）${result.stats.hitCap ? "（文件数触顶，结果可能不完整）" : ""}`;
      return {
        title: "仓库地图",
        output: result.text ? `${header}\n\n${result.text}` : `${header}\n\n（工作区没有可索引的代码文件）`,
        metadata: { ...result.stats },
      };
    },
  };
}

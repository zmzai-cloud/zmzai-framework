import { rulesetFromConfig, type PermissionConfig, type Ruleset } from "../permission/ruleset.js";
import type { ModelRef } from "../session/types.js";

/** Agent registry (spec §6). Agents are named bundles of (prompt, permission
 *  ruleset, model override, step budget). Primary agents answer user prompts;
 *  subagents are spawned by the task tool. There is no mode toggle — the
 *  presets below replace plan/build (spec §6.2). */

export type AgentInfo = {
  name: string;
  description?: string;
  mode: "primary" | "subagent" | "all";
  hidden?: boolean;
  model?: ModelRef;
  temperature?: number;
  topP?: number;
  prompt?: string; // system prompt override
  steps?: number; // max agentic turns (→ PI shouldStopAfterTurn)
  permission: Ruleset;
};

export type AgentDefinition = Omit<AgentInfo, "permission"> & { permission: PermissionConfig };

function define(def: AgentDefinition): AgentInfo {
  return { ...def, permission: rulesetFromConfig(def.permission) };
}

const DEFAULT_PROMPT =
  "你是 ZMZAI Agent，一个会主动完成任务的 Coding Agent。可使用工具读取当前 Workspace，通过 write/edit 直接修改文件（每次修改生成可审查、可回滚的不可变版本），用 bash 在隔离沙箱中运行命令（stdout/stderr 会返回，生成的产物文件可下载）。\n" +
  "修复与重试原则：当质量检查或上一步失败时，只修复明确失败的项，不要重写或改动已通过的部分；修完只重新验证受影响的部分。避免全量重做——那会破坏已完成的成果并浪费步骤。\n" +
  "工作方式：先 glob/read/grep 掌握 Workspace 现状，并用 todo 工具把任务拆成清单、边做边更新，再动手。对生成型任务（PPT、文档、脚本、报告等），不要只反问用户需求——基于已有信息自行决定合理的默认（主题、篇幅、风格、结构），直接写出生成脚本或内容 → 执行 → 校验产物 → 交付。只有信息确实无法推断、且追问明显比先交付默认方案更省事时，才问一两个关键问题，并同时给出你的默认方案。\n" +
  "不能声称执行了未调用的操作。用中文给出简洁、可核实的结果。";

const READONLY_PROMPT =
  "你是 ZMZAI Agent 的只读分析模式。仅使用 read/glob/grep 工具读取当前 Workspace 并给出可核实的中文方案；你没有写入和执行权限，不能声称执行了任何修改。任务结束后用户可以在同一会话继续追问，或切换到 default 代理执行你的方案。";

const EXPLORE_PROMPT =
  "你是代码库探索子代理。快速定位与任务相关的文件、符号与数据流，返回精确的 path:line 引用和简洁结论。你只读，不做任何修改。按要求的彻底程度（quick/medium/thorough）控制搜索范围。";

const GENERAL_PROMPT = "你是通用子任务代理。完成父代理交代的独立子任务，返回简洁、可核实的结果。不要反问父代理；信息不足时基于合理默认推进并说明假设。";

export const builtinAgents: AgentInfo[] = [
  define({
    name: "default",
    description: "默认代理：读写 + 沙箱执行，自动完成任务",
    mode: "primary",
    steps: 12,
    prompt: DEFAULT_PROMPT,
    permission: { bash: "ask" }, // edit/read/... fall through to built-in defaults
  }),
  define({
    name: "readonly",
    description: "只读分析：等价于旧 plan 模式",
    mode: "primary",
    steps: 8,
    prompt: READONLY_PROMPT,
    permission: { edit: "deny", bash: "deny", task: "deny" },
  }),
  define({
    name: "explore",
    description: "代码库探索子代理（只读）",
    mode: "subagent",
    steps: 8,
    prompt: EXPLORE_PROMPT,
    permission: { "*": "deny", read: "allow", glob: "allow", grep: "allow", list: "allow", todo: "allow" },
  }),
  define({
    name: "general",
    description: "通用子任务代理",
    mode: "subagent",
    steps: 12,
    prompt: GENERAL_PROMPT,
    permission: {},
  }),
];

/** Built-in baseline applied beneath every agent's own ruleset (spec §5.5). */
export const builtinDefaults: Ruleset = rulesetFromConfig({
  "*": "allow",
  external_directory: { "*": "ask" },
  read: { "*": "allow", "*.env": "ask", "*.env.*": "ask" },
  bash: "ask",
  // A connector holds an external-system credential. Even read-only calls
  // cross a trust boundary and must be approved unless a user grants it.
  connector: "ask",
  edit: "allow",
  git_read: "allow",
  // commit 真实写仓库历史，默认问一次；用户可「总是允许」沉淀成规则
  git_write: "ask",
  mcp: "ask",
});

export class AgentRegistry {
  private readonly agents = new Map<string, AgentInfo>();

  constructor(customAgents: AgentInfo[] = []) {
    for (const agent of builtinAgents) this.agents.set(agent.name, agent);
    for (const agent of customAgents) this.agents.set(agent.name, agent); // custom overrides builtin (spec §6.3)
  }

  get(name: string): AgentInfo | null {
    return this.agents.get(name) ?? null;
  }

  list(filter?: { mode?: "primary" | "subagent"; includeHidden?: boolean }): AgentInfo[] {
    return [...this.agents.values()].filter((agent) => {
      if (!filter?.includeHidden && agent.hidden) return false;
      if (filter?.mode && agent.mode !== filter.mode && agent.mode !== "all") return false;
      return true;
    });
  }

  /** Effective ruleset stack for a session running this agent, in ascending
   *  precedence: builtin defaults → agent preset. Session rules are appended
   *  later by the permission engine. */
  rulesetsFor(name: string): Ruleset[] {
    const agent = this.get(name);
    return agent ? [builtinDefaults, agent.permission] : [builtinDefaults];
  }

  /** Returns a NEW registry with additional agents layered on top (workspace
   *  custom agents). The base registry is shared/process-wide, so per-run
   *  customization must not mutate it — this derive keeps the singleton
   *  immutable while letting a session see its workspace's .zmzai/agents. */
  derive(extraAgents: AgentInfo[]): AgentRegistry {
    if (!extraAgents.length) return this;
    const merged = new AgentRegistry([...this.customAgents, ...extraAgents]);
    return merged;
  }

  /** Custom agents registered beyond the builtins (for derive()). */
  get customAgents(): AgentInfo[] {
    return [...this.agents.values()].filter((agent) => !builtinAgents.some((builtin) => builtin.name === agent.name));
  }
}

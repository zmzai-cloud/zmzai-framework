import { rulesetFromConfig, type Action, type Ruleset } from "../permission/ruleset.js";
import type { WorkspaceFiles } from "../tools/context.js";
import type { AgentInfo } from "../agent/registry.js";

/** Custom agent loader (spec §6.3): workspace agents live at `.zmzai/agents/*.md`
 *  with YAML-ish frontmatter and the body as the system prompt. Frontmatter is
 *  parsed with a small zero-dependency reader (no js-yaml in the dep tree) —
 *  it supports the flat keys we need plus a nested `permission:` map. */

export type LoadedAgent = { fileName: string; agent: AgentInfo };

const FRONTMATTER_RE = /^---\s*\r?\n([\s\S]*?)\r?\n---\s*\r?\n?/;

type RawFrontmatter = {
  name?: string;
  description?: string;
  mode?: string;
  model?: string;
  temperature?: number;
  top_p?: number;
  steps?: number;
  hidden?: boolean;
  permission?: Record<string, string>;
};

/** Minimal frontmatter parser: `key: value` scalars + one level of
 *  `permission:\n  key: value` nesting. Values are strings, numbers, or
 *  booleans. Quoted strings are unwrapped. Not a general YAML parser. */
function parseFrontmatter(text: string): { data: RawFrontmatter; body: string } | null {
  const match = FRONTMATTER_RE.exec(text);
  if (!match) return null;
  const raw = match[1]!;
  const body = text.slice(match[0].length);
  const data: RawFrontmatter = {};
  const lines = raw.split(/\r?\n/);
  let inPermission = false;
  for (const line of lines) {
    if (!line.trim() || line.trimStart().startsWith("#")) continue;
    const indent = line.length - line.trimStart().length;
    if (indent === 0) {
      inPermission = false;
      const idx = line.indexOf(":");
      if (idx === -1) continue;
      const key = line.slice(0, idx).trim();
      const value = line.slice(idx + 1).trim();
      if (key === "permission") {
        if (value === "") {
          inPermission = true;
          data.permission = {};
        } else {
          // inline single action: `permission: ask`
          data.permission = { "*": unquote(value) };
        }
        continue;
      }
      assign(data, key, value);
    } else if (inPermission) {
      const idx = line.indexOf(":");
      if (idx === -1) continue;
      const key = line.slice(0, idx).trim();
      const value = line.slice(idx + 1).trim();
      (data.permission ??= {})[key] = unquote(value);
    }
  }
  return { data, body };
}

function unquote(value: string): string {
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    return value.slice(1, -1);
  }
  return value;
}

function assign(data: RawFrontmatter, key: string, value: string): void {
  const v = unquote(value);
  switch (key) {
    case "name":
      data.name = v;
      break;
    case "description":
      data.description = v;
      break;
    case "mode":
      data.mode = v;
      break;
    case "model":
      data.model = v;
      break;
    case "temperature":
      data.temperature = Number(v);
      break;
    case "top_p":
      data.top_p = Number(v);
      break;
    case "steps":
      data.steps = Number.parseInt(v, 10);
      break;
    case "hidden":
      data.hidden = v === "true" || v === "yes";
      break;
  }
}

const VALID_MODES = new Set(["primary", "subagent", "all"]);

function toAgentInfo(fileName: string, parsed: { data: RawFrontmatter; body: string }): LoadedAgent | { error: string } {
  const { data, body } = parsed;
  const name = data.name ?? fileName.replace(/\.md$/i, "");
  if (!data.description) return { error: `agent ${fileName} 缺少必填的 description` };
  const mode = data.mode && VALID_MODES.has(data.mode) ? (data.mode as AgentInfo["mode"]) : "primary";
  if (data.mode && !VALID_MODES.has(data.mode)) return { error: `agent ${fileName} 的 mode 必须是 primary|subagent|all` };

  let permission: Ruleset = [];
  if (data.permission) {
    const config: Record<string, Action | Record<string, Action>> = {};
    for (const [key, value] of Object.entries(data.permission)) {
      config[key] = value as Action;
    }
    permission = rulesetFromConfig(config);
  }

  const model = data.model ? parseModel(data.model) : undefined;
  const agent: AgentInfo = {
    name,
    description: data.description,
    mode,
    ...(data.hidden ? { hidden: true } : {}),
    ...(model ? { model } : {}),
    ...(typeof data.temperature === "number" && !Number.isNaN(data.temperature) ? { temperature: data.temperature } : {}),
    ...(typeof data.top_p === "number" && !Number.isNaN(data.top_p) ? { topP: data.top_p } : {}),
    ...(typeof data.steps === "number" && !Number.isNaN(data.steps) ? { steps: data.steps } : {}),
    prompt: body.trim(),
    permission,
  };
  return { fileName, agent };
}

function parseModel(value: string): { providerId: string; modelId: string } | undefined {
  const idx = value.indexOf("/");
  if (idx === -1) return { providerId: "relay", modelId: value };
  return { providerId: value.slice(0, idx), modelId: value.slice(idx + 1) };
}

/** Loads `.zmzai/agents/*.md` from the workspace. Unreadable files are skipped
 *  silently; malformed files raise a descriptive error (surfaced to the user). */
export async function loadCustomAgents(workspace: WorkspaceFiles): Promise<{ agents: AgentInfo[]; errors: string[] }> {
  const all = await workspace.list().catch(() => []);
  const agentFiles = all.filter((file) => /^\.zmzai\/agents\/[^/]+\.md$/i.test(file.path));
  const agents: AgentInfo[] = [];
  const errors: string[] = [];
  for (const file of agentFiles) {
    const fileName = file.path.split("/").pop()!;
    const content = await workspace.read(file.path).catch(() => null);
    if (!content) continue;
    const parsed = parseFrontmatter(content.content);
    if (!parsed) {
      errors.push(`${fileName} 缺少 frontmatter（--- 包裹的头部）`);
      continue;
    }
    const result = toAgentInfo(fileName, parsed);
    if ("error" in result) errors.push(result.error);
    else agents.push(result.agent);
  }
  return { agents, errors };
}

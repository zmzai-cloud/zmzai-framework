import { basename, dirname, isAbsolute, normalize, relative, resolve } from "node:path";

/** Agent Plugins 1.0 package reader. It intentionally implements only the
 *  portable package format: installation, trust, secrets, approval UX, and
 *  process execution remain the responsibility of the hosting product. */

export type PluginManifest = {
  $schema?: string;
  name: string;
  version?: string;
  description?: string;
  author?: string;
  homepage?: string;
  repository?: string;
  license?: string;
  keywords?: string[];
  extensions?: Record<string, unknown>;
};

export type PluginSkill = { id: string; path: string; markdown: string };

export type PluginMcpServer =
  | { type: "stdio"; command: string; args?: string[]; env?: Record<string, string>; cwd?: string }
  | { type: "streamable-http"; url: string; headers?: Record<string, string> }
  | { type: "sse"; url: string; headers?: Record<string, string> };

export type ParsedAgentPlugin = {
  root: string;
  manifest: PluginManifest;
  skills: PluginSkill[];
  mcpServers: Record<string, PluginMcpServer>;
  errors: string[];
};

export type PluginFileSystem = {
  read(path: string): Promise<string | null>;
  list(path: string): Promise<{ path: string; isDirectory: boolean }[]>;
};

const NAME_RE = /^(?!.*--)(?!.*\.\.)[a-z0-9](?:[a-z0-9.-]{0,62}[a-z0-9])?$/;

function json(value: string | null): unknown | null {
  if (!value) return null;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return null;
  }
}

function object(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function stringMap(value: unknown): Record<string, string> | undefined {
  const candidate = object(value);
  if (!candidate || Object.values(candidate).some((item) => typeof item !== "string")) return undefined;
  return candidate as Record<string, string>;
}

function pathInside(root: string, candidate: string): boolean {
  const target = resolve(root, candidate);
  return relative(resolve(root), target) === "" || !relative(resolve(root), target).startsWith("..");
}

function validateRelativePath(root: string, value: string | undefined): string | undefined {
  if (!value || !value.startsWith("./") || isAbsolute(value) || !pathInside(root, value)) return undefined;
  return value;
}

/** Agent Plugins 1.0 reserves these values for the hosting client. Parsing
 * validates their placement but deliberately does not expand them: expansion
 * happens only when a trusted host launches an authorized stdio connector. */
function validatePluginPath(root: string, value: string | undefined): string | undefined {
  if (!value) return undefined;
  if (value === "${PLUGIN_ROOT}" || value.startsWith("${PLUGIN_ROOT}/") || value === "${PLUGIN_DATA}" || value.startsWith("${PLUGIN_DATA}/")) return value;
  return validateRelativePath(root, value);
}

export function parsePluginManifest(value: unknown): PluginManifest | null {
  const raw = object(value);
  if (!raw || typeof raw.name !== "string" || !NAME_RE.test(raw.name)) return null;
  const allowed = new Set(["$schema", "name", "version", "description", "author", "homepage", "repository", "license", "keywords", "extensions"]);
  if (Object.keys(raw).some((key) => !allowed.has(key))) return null;
  if (raw.keywords !== undefined && (!Array.isArray(raw.keywords) || raw.keywords.some((word) => typeof word !== "string"))) return null;
  if (raw.extensions !== undefined && !object(raw.extensions)) return null;
  for (const key of ["$schema", "version", "description", "author", "homepage", "repository", "license"] as const) {
    if (raw[key] !== undefined && typeof raw[key] !== "string") return null;
  }
  return raw as PluginManifest;
}

export function parsePluginMcp(root: string, value: unknown): { servers: Record<string, PluginMcpServer>; errors: string[] } {
  const raw = object(value);
  const entries = object(raw?.mcpServers);
  const servers: Record<string, PluginMcpServer> = {};
  const errors: string[] = [];
  if (!entries) return { servers, errors };
  for (const [name, candidate] of Object.entries(entries)) {
    const server = object(candidate);
    if (!server || typeof server.type !== "string") {
      errors.push(`MCP ${name} 缺少 type`);
      continue;
    }
    if (server.type === "stdio") {
      const command = typeof server.command === "string" ? server.command : "";
      const commandValid = /^[^\s]+$/.test(command) && (!command.startsWith(".") || Boolean(validateRelativePath(root, command)));
      const args = Array.isArray(server.args) && server.args.every((arg) => typeof arg === "string") ? server.args as string[] : undefined;
      const cwd = server.cwd === undefined ? undefined : validatePluginPath(root, typeof server.cwd === "string" ? server.cwd : undefined);
      const env = stringMap(server.env);
      if (!commandValid || (server.args !== undefined && !args) || (server.cwd !== undefined && !cwd) || (server.env !== undefined && !env) || env?.PLUGIN_ROOT !== undefined || env?.PLUGIN_DATA !== undefined) {
        errors.push(`MCP ${name} 的 stdio 配置无效`);
        continue;
      }
      servers[name] = { type: "stdio", command, ...(args ? { args } : {}), ...(env ? { env } : {}), ...(cwd ? { cwd } : {}) };
      continue;
    }
    if (server.type === "streamable-http" || server.type === "sse") {
      const url = typeof server.url === "string" ? server.url : "";
      let parsed: URL | null = null;
      try { parsed = new URL(url); } catch { /* validation below */ }
      const remoteValid = parsed && (parsed.protocol === "https:" || ["localhost", "127.0.0.1", "::1"].includes(parsed.hostname));
      const headers = stringMap(server.headers);
      if (!remoteValid || (server.headers !== undefined && !headers)) {
        errors.push(`MCP ${name} 的 ${server.type} 配置无效`);
        continue;
      }
      servers[name] = { type: server.type, url, ...(headers ? { headers } : {}) };
      continue;
    }
    errors.push(`MCP ${name} 使用了不支持的 transport: ${server.type}`);
  }
  return { servers, errors };
}

export async function parseAgentPlugin(input: { root: string; files: PluginFileSystem }): Promise<ParsedAgentPlugin> {
  const root = normalize(input.root);
  const manifest = parsePluginManifest(json(await input.files.read(`${root}/plugin.json`)));
  if (!manifest) throw new Error("plugin.json 不合法或不符合 Agent Plugins 1.0 manifest 约束");
  const errors: string[] = [];
  const skills: PluginSkill[] = [];
  for (const entry of await input.files.list(`${root}/skills`).catch(() => [])) {
    if (!entry.isDirectory || dirname(entry.path) !== `${root}/skills`) continue;
    const skillPath = `${entry.path}/SKILL.md`;
    const markdown = await input.files.read(skillPath).catch(() => null);
    if (!markdown) {
      errors.push(`Skill ${basename(entry.path)} 缺少 SKILL.md`);
      continue;
    }
    skills.push({ id: `${manifest.name}/${basename(entry.path)}`, path: skillPath, markdown });
  }
  const mcp = parsePluginMcp(root, json(await input.files.read(`${root}/mcp.json`)));
  return { root, manifest, skills, mcpServers: mcp.servers, errors: [...errors, ...mcp.errors] };
}

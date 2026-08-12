import { describe, expect, it } from "vitest";

import { parseAgentPlugin, parsePluginMcp } from "./plugin.js";

function files(entries: Record<string, string | { isDirectory: true }>) {
  return {
    read: async (path: string) => typeof entries[path] === "string" ? entries[path] as string : null,
    list: async (path: string) => Object.entries(entries)
      .filter(([candidate]) => candidate.startsWith(`${path}/`) && candidate.slice(path.length + 1).split("/").length === 1)
      .map(([candidate, value]) => ({ path: candidate, isDirectory: typeof value !== "string" })),
  };
}

describe("Agent Plugins 1.0 parser", () => {
  it("discovers direct skill directories and explicit MCP transports", async () => {
    const plugin = await parseAgentPlugin({
      root: "/plugins/reports",
      files: files({
        "/plugins/reports/plugin.json": JSON.stringify({ name: "reports-plugin", description: "Reports" }),
        "/plugins/reports/skills": { isDirectory: true },
        "/plugins/reports/skills/report": { isDirectory: true },
        "/plugins/reports/skills/report/SKILL.md": "# Report\n",
        "/plugins/reports/mcp.json": JSON.stringify({ mcpServers: { deploy: { type: "streamable-http", url: "https://deploy.example.com/mcp" } } }),
      }),
    });
    expect(plugin.skills).toEqual([expect.objectContaining({ id: "reports-plugin/report" })]);
    expect(plugin.mcpServers.deploy).toEqual({ type: "streamable-http", url: "https://deploy.example.com/mcp" });
  });

  it("rejects manifest fields outside the closed schema", async () => {
    await expect(parseAgentPlugin({ root: "/plugin", files: files({ "/plugin/plugin.json": JSON.stringify({ name: "bad", commands: [] }) }) })).rejects.toThrow("plugin.json");
  });

  it("isolates invalid MCP entries without invalidating skills", async () => {
    const result = parsePluginMcp("/plugin", { mcpServers: { escaped: { type: "stdio", command: "../bin/server" } } });
    expect(result.servers).toEqual({});
    expect(result.errors).toHaveLength(1);
  });

  it("accepts host-owned plugin path placeholders without expanding them", () => {
    const result = parsePluginMcp("/plugin", {
      mcpServers: {
        validator: {
          type: "stdio",
          command: "./bin/validator",
          args: ["--data", "${PLUGIN_DATA}/validator"],
          env: { CONFIG: "${PLUGIN_ROOT}/config.json" },
          cwd: "${PLUGIN_ROOT}",
        },
      },
    });
    expect(result.errors).toEqual([]);
    expect(result.servers.validator).toEqual(expect.objectContaining({ cwd: "${PLUGIN_ROOT}", env: { CONFIG: "${PLUGIN_ROOT}/config.json" } }));
  });
});

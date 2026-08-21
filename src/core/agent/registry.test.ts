import { describe, expect, it } from "vitest";

import { AgentRegistry, builtinAgents, builtinDefaults } from "../agent/registry.js";
import { evaluateRules } from "../permission/ruleset.js";

describe("AgentRegistry", () => {
  it("ships the four builtin presets", () => {
    const registry = new AgentRegistry();
    expect(builtinAgents.map((agent) => agent.name)).toEqual(["default", "readonly", "explore", "general"]);
    expect(registry.list({ mode: "primary" }).map((agent) => agent.name)).toEqual(["default", "readonly"]);
    expect(registry.list({ mode: "subagent" }).map((agent) => agent.name)).toEqual(["explore", "general"]);
  });

  it("custom agents override builtins by name", () => {
    const registry = new AgentRegistry([{ name: "default", mode: "primary", permission: [], prompt: "覆盖" }]);
    expect(registry.get("default")?.prompt).toBe("覆盖");
  });

  it("hidden agents are excluded unless requested", () => {
    const registry = new AgentRegistry([{ name: "secret", mode: "primary", hidden: true, permission: [] }]);
    expect(registry.list().some((agent) => agent.name === "secret")).toBe(false);
    expect(registry.list({ includeHidden: true }).some((agent) => agent.name === "secret")).toBe(true);
  });
});

describe("preset permission semantics (replaces the plan/build toggle)", () => {
  const registry = new AgentRegistry();

  it("default preset: edit allowed directly, bash and connectors require approval", () => {
    const rulesets = registry.rulesetsFor("default");
    expect(evaluateRules(rulesets, "edit", "src/index.ts")).toBe("allow");
    expect(evaluateRules(rulesets, "bash", "npm run build")).toBe("ask");
    expect(evaluateRules(rulesets, "connector", "DeepWiki/read_wiki_structure")).toBe("ask");
    expect(evaluateRules(rulesets, "read", "src/index.ts")).toBe("allow");
    expect(evaluateRules(rulesets, "read", "config/.env")).toBe("ask");
  });

  it("readonly preset denies write and execution", () => {
    const rulesets = registry.rulesetsFor("readonly");
    expect(evaluateRules(rulesets, "edit", "src/index.ts")).toBe("deny");
    expect(evaluateRules(rulesets, "bash", "ls")).toBe("deny");
    expect(evaluateRules(rulesets, "task", "general")).toBe("deny");
    expect(evaluateRules(rulesets, "read", "src/index.ts")).toBe("allow");
  });

  it("explore subagent is read-only with everything else denied", () => {
    const rulesets = registry.rulesetsFor("explore");
    expect(evaluateRules(rulesets, "glob", "*")).toBe("allow");
    expect(evaluateRules(rulesets, "grep", "foo")).toBe("allow");
    expect(evaluateRules(rulesets, "edit", "a.ts")).toBe("deny");
    expect(evaluateRules(rulesets, "bash", "ls")).toBe("deny");
    expect(evaluateRules(rulesets, "task", "general")).toBe("deny");
  });

  it("unknown agent falls back to builtin defaults only", () => {
    const rulesets = registry.rulesetsFor("missing");
    expect(rulesets).toEqual([builtinDefaults]);
    expect(evaluateRules(rulesets, "edit", "a.ts")).toBe("allow");
  });
});

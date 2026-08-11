import { describe, expect, it } from "vitest";

import { evaluateRules, rulesetFromConfig, wildcardMatch } from "../permission/ruleset.js";

describe("wildcardMatch", () => {
  it("matches exact strings", () => {
    expect(wildcardMatch("git", "git")).toBe(true);
    expect(wildcardMatch("git", "git push")).toBe(false);
  });

  it("matches star across path separators", () => {
    expect(wildcardMatch("*.env", ".env")).toBe(true);
    expect(wildcardMatch("*.env", "config/prod.env")).toBe(true);
    expect(wildcardMatch("git push *", "git push origin main")).toBe(true);
    expect(wildcardMatch("server_*", "server_fs_read")).toBe(true);
    expect(wildcardMatch("*", "anything at all")).toBe(true);
  });

  it("matches question mark as single char", () => {
    expect(wildcardMatch("a?c", "abc")).toBe(true);
    expect(wildcardMatch("a?c", "ac")).toBe(false);
  });

  it("rejects non-matches", () => {
    expect(wildcardMatch("*.env", ".env.example")).toBe(false);
    expect(wildcardMatch("read", "write")).toBe(false);
  });
});

describe("rulesetFromConfig", () => {
  it("accepts a bare action string", () => {
    expect(rulesetFromConfig("allow")).toEqual([{ permission: "*", pattern: "*", action: "allow" }]);
  });

  it("flattens permission maps and pattern maps preserving key order", () => {
    const rules = rulesetFromConfig({
      edit: "deny",
      read: { "*": "allow", "*.env": "ask" },
    });
    expect(rules).toEqual([
      { permission: "edit", pattern: "*", action: "deny" },
      { permission: "read", pattern: "*", action: "allow" },
      { permission: "read", pattern: "*.env", action: "ask" },
    ]);
  });
});

describe("evaluateRules", () => {
  it("defaults to ask when nothing matches", () => {
    expect(evaluateRules([], "bash", "rm -rf /")).toBe("ask");
  });

  it("last matching rule wins within a ruleset", () => {
    const ruleset = rulesetFromConfig({ read: { "*": "allow", "*.env": "ask" } });
    expect(evaluateRules([ruleset], "read", "src/index.ts")).toBe("allow");
    expect(evaluateRules([ruleset], "read", "app/.env")).toBe("ask");
  });

  it("later rulesets take precedence over earlier ones", () => {
    const defaults = rulesetFromConfig({ bash: "ask" });
    const session = rulesetFromConfig({ bash: { "npm *": "allow" } });
    expect(evaluateRules([defaults, session], "bash", "npm run build")).toBe("allow");
    expect(evaluateRules([defaults, session], "bash", "curl example.com")).toBe("ask");
  });

  it("deny beats allow when it comes later", () => {
    const allowAll = rulesetFromConfig("allow");
    const denyPush = rulesetFromConfig({ bash: { "git push *": "deny" } });
    expect(evaluateRules([allowAll, denyPush], "bash", "git push origin main")).toBe("deny");
    expect(evaluateRules([allowAll, denyPush], "edit", "any/file.ts")).toBe("allow");
  });

  it("wildcard permission keys match tool-specific keys", () => {
    const mcp = rulesetFromConfig({ "mymcp_*": "deny" });
    expect(evaluateRules([mcp], "mymcp_delete", "*")).toBe("deny");
    expect(evaluateRules([mcp], "other_tool", "*")).toBe("ask");
  });
});

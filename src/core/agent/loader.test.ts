import { describe, expect, it, vi } from "vitest";

import { loadCustomAgents } from "../agent/loader.js";
import type { WorkspaceFiles } from "../tools/context.js";
import { evaluateRules } from "../permission/ruleset.js";

function workspace(files: Record<string, string>): WorkspaceFiles {
  return {
    list: vi.fn().mockResolvedValue(Object.keys(files).map((path) => ({ path, bytes: files[path]!.length }))),
    read: vi.fn().mockImplementation(async (path: string) => (path in files ? { path, content: files[path]! } : null)),
    write: vi.fn(),
    edit: vi.fn(),
  };
}

const REVIEWER_MD = `---
name: reviewer
description: 代码评审代理
mode: primary
model: relay/gpt-5.6-luna
steps: 6
temperature: 0.3
permission:
  edit: deny
  bash: deny
---
你是严格的代码评审员。只读，给出 actionable 反馈。
`;

describe("loadCustomAgents", () => {
  it("loads a valid agent md with frontmatter → AgentInfo", async () => {
    const { agents, errors } = await loadCustomAgents(workspace({ ".zmzai/agents/reviewer.md": REVIEWER_MD }));
    expect(errors).toEqual([]);
    expect(agents).toHaveLength(1);
    const agent = agents[0]!;
    expect(agent.name).toBe("reviewer");
    expect(agent.description).toBe("代码评审代理");
    expect(agent.mode).toBe("primary");
    expect(agent.model).toEqual({ providerId: "relay", modelId: "gpt-5.6-luna" });
    expect(agent.steps).toBe(6);
    expect(agent.temperature).toBe(0.3);
    expect(agent.prompt).toContain("严格的代码评审员");
    expect(evaluateRules([agent.permission], "edit", "a.ts")).toBe("deny");
    expect(evaluateRules([agent.permission], "bash", "ls")).toBe("deny");
  });

  it("derives name from filename when omitted", async () => {
    const md = `---\ndescription: 助手\n---\n正文`;
    const { agents } = await loadCustomAgents(workspace({ ".zmzai/agents/helper.md": md }));
    expect(agents[0]?.name).toBe("helper");
  });

  it("parses model without provider as relay/<model>", async () => {
    const md = `---\ndescription: x\nmodel: gpt-5.6-luna\n---\n正文`;
    const { agents } = await loadCustomAgents(workspace({ ".zmzai/agents/a.md": md }));
    expect(agents[0]?.model).toEqual({ providerId: "relay", modelId: "gpt-5.6-luna" });
  });

  it("reports missing description as an error and skips the file", async () => {
    const md = `---\nmode: primary\n---\n正文`;
    const { agents, errors } = await loadCustomAgents(workspace({ ".zmzai/agents/bad.md": md }));
    expect(agents).toEqual([]);
    expect(errors[0]).toContain("description");
  });

  it("rejects invalid mode", async () => {
    const md = `---\ndescription: x\nmode: superuser\n---\n正文`;
    const { errors } = await loadCustomAgents(workspace({ ".zmzai/agents/bad.md": md }));
    expect(errors[0]).toContain("mode");
  });

  it("requires frontmatter block", async () => {
    const { errors } = await loadCustomAgents(workspace({ ".zmzai/agents/plain.md": "no frontmatter here" }));
    expect(errors[0]).toContain("frontmatter");
  });

  it("ignores non-agent paths and unreadable files", async () => {
    const ws = workspace({ "src/index.ts": "code", "README.md": "doc" });
    const { agents, errors } = await loadCustomAgents(ws);
    expect(agents).toEqual([]);
    expect(errors).toEqual([]);
  });

  it("defaults mode to primary and hidden false", async () => {
    const md = `---\ndescription: x\n---\nbody`;
    const { agents } = await loadCustomAgents(workspace({ ".zmzai/agents/a.md": md }));
    expect(agents[0]?.mode).toBe("primary");
    expect(agents[0]?.hidden).toBeUndefined();
  });

  it("parses inline single-action permission", async () => {
    const md = `---\ndescription: x\npermission: ask\n---\nbody`;
    const { agents } = await loadCustomAgents(workspace({ ".zmzai/agents/a.md": md }));
    expect(evaluateRules([agents[0]!.permission], "anything", "x")).toBe("ask");
  });
});

import { describe, expect, it, vi } from "vitest";

import { PermissionEngine, RejectedError } from "../permission/engine.js";
import { rulesetFromConfig } from "../permission/ruleset.js";

const defaults = rulesetFromConfig({ "*": "allow", bash: "ask" });

function makeEngine(options: { sessionRules?: ReturnType<typeof rulesetFromConfig>; hooks?: ConstructorParameters<typeof PermissionEngine>[3] } = {}) {
  const asked = vi.fn();
  const replied = vi.fn();
  const ruleAdded = vi.fn();
  const engine = new PermissionEngine("ses_1", [defaults], options.sessionRules ?? [], {
    onAsked: asked,
    onReplied: replied,
    onSessionRuleAdded: ruleAdded,
    ...options.hooks,
  });
  return { engine, asked, replied, ruleAdded };
}

describe("PermissionEngine.ask", () => {
  it("short-circuits without events when every pattern is allowed", async () => {
    const { engine, asked } = makeEngine();
    const reply = await engine.ask({ sessionId: "ses_1", permission: "read", patterns: ["src/a.ts"] });
    expect(reply).toBe("once");
    expect(asked).not.toHaveBeenCalled();
  });

  it("suspends until reply() resolves, then returns once", async () => {
    const { engine, asked, replied } = makeEngine();
    const promise = engine.ask({ sessionId: "ses_1", permission: "bash", patterns: ["npm run build"] });
    await vi.waitFor(() => expect(asked).toHaveBeenCalledTimes(1));
    const request = asked.mock.calls[0]![0];
    expect(request.patterns).toEqual(["npm run build"]);
    expect(request.always).toEqual(["npm run build"]);
    expect(engine.reply(request.id, "once")).toBe(true);
    await expect(promise).resolves.toBe("once");
    expect(replied).toHaveBeenCalledWith(request, "once");
  });

  it("only asks for patterns not already allowed", async () => {
    const { engine, asked } = makeEngine({ sessionRules: rulesetFromConfig({ bash: { "npm *": "allow" } }) });
    const promise = engine.ask({ sessionId: "ses_1", permission: "bash", patterns: ["npm test", "rm file"] });
    await vi.waitFor(() => expect(asked).toHaveBeenCalledTimes(1));
    expect(asked.mock.calls[0]![0].patterns).toEqual(["rm file"]);
    engine.reply(asked.mock.calls[0]![0].id, "once");
    await promise;
  });

  it("always stamps session rules, persists them, and future asks short-circuit", async () => {
    const { engine, asked, ruleAdded } = makeEngine();
    const promise = engine.ask({ sessionId: "ses_1", permission: "bash", patterns: ["npm run build"], always: ["npm *"] });
    await vi.waitFor(() => expect(asked).toHaveBeenCalledTimes(1));
    engine.reply(asked.mock.calls[0]![0].id, "always");
    await expect(promise).resolves.toBe("always");
    expect(ruleAdded).toHaveBeenCalledWith("ses_1", { permission: "bash", pattern: "npm *", action: "allow" });
    expect(engine.sessionRuleset).toEqual([{ permission: "bash", pattern: "npm *", action: "allow" }]);

    const again = await engine.ask({ sessionId: "ses_1", permission: "bash", patterns: ["npm test"] });
    expect(again).toBe("once");
    expect(asked).toHaveBeenCalledTimes(1);
  });

  it("always auto-resolves other pending requests now covered", async () => {
    const { engine, asked } = makeEngine();
    const first = engine.ask({ sessionId: "ses_1", permission: "bash", patterns: ["npm run build"], always: ["npm *"] });
    const second = engine.ask({ sessionId: "ses_1", permission: "bash", patterns: ["npm test"] });
    await vi.waitFor(() => expect(asked).toHaveBeenCalledTimes(2));
    engine.reply(asked.mock.calls[0]![0].id, "always");
    await expect(first).resolves.toBe("always");
    await expect(second).resolves.toBe("always");
    expect(engine.pendingRequests).toHaveLength(0);
  });

  it("reject throws RejectedError with user feedback", async () => {
    const { engine, asked } = makeEngine();
    const promise = engine.ask({ sessionId: "ses_1", permission: "bash", patterns: ["rm -rf dist"] });
    await vi.waitFor(() => expect(asked).toHaveBeenCalledTimes(1));
    engine.reply(asked.mock.calls[0]![0].id, "reject", "先备份再删");
    await expect(promise).rejects.toThrow(RejectedError);
    await expect(promise).rejects.toThrow("先备份再删");
  });

  it("reply returns false for unknown ids", async () => {
    const { engine } = makeEngine();
    expect(engine.reply("per_missing", "once")).toBe(false);
  });

  it("dispose rejects everything pending and blocks new asks", async () => {
    const { engine, asked } = makeEngine();
    const promise = engine.ask({ sessionId: "ses_1", permission: "bash", patterns: ["sleep 100"] });
    await vi.waitFor(() => expect(asked).toHaveBeenCalledTimes(1));
    engine.dispose("服务重启");
    await expect(promise).rejects.toThrow("服务重启");
    await expect(engine.ask({ sessionId: "ses_1", permission: "bash", patterns: ["ls"] })).rejects.toThrow(RejectedError);
  });
});

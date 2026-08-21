import { describe, expect, it } from "vitest";

import { qaCheckResultSchema, qaCheckTool } from "./qa-check.js";
import type { ToolContext } from "./context.js";

function context(files: Record<string, string>): ToolContext {
  return {
    sessionId: "ses_1",
    userId: "usr_1",
    workspaceId: "ws_1",
    agent: "default",
    abort: new AbortController().signal,
    ask: async () => ({ id: "permission_1", reply: "once" }) as never,
    workspace: {
      list: async () => Object.entries(files).map(([path, content]) => ({ path, bytes: Buffer.byteLength(content) })),
      read: async (path) => files[path] === undefined ? null : { path, content: files[path]! },
      write: async () => ({ revisionId: "rev_1", diff: "" }),
      edit: async () => ({ revisionId: "rev_1", diff: "" }),
    },
    buildSnapshot: async () => ({ revisionId: null, files: [] }),
    runSandbox: async () => ({ ok: true, exitCode: 0, outputText: "", durationMs: 0, artifacts: [] }),
    setTodos: async () => undefined,
    emitFileEdited: async () => undefined,
    emitArtifact: async () => undefined,
  };
}

describe("qa-check tool", () => {
  it("returns a passing v1 result for a responsive web app", async () => {
    const result = await qaCheckTool.execute({ entryPath: "index.html", requiredText: ["Revenue"] }, context({ "index.html": "<html><body>Revenue</body><meta name=\"viewport\" content=\"width=device-width\"></html>", "styles.css": "@media (max-width: 600px){body{max-width:100%}}" }));
    expect(qaCheckResultSchema.parse(result.metadata?.qaCheck).status).toBe("passed");
  });

  it("reports missing mobile constraints instead of claiming success", async () => {
    const result = await qaCheckTool.execute({ entryPath: "index.html", requiredText: [] }, context({ "index.html": "<html><body>Revenue</body></html>", "styles.css": "body{width:900px}" }));
    expect(qaCheckResultSchema.parse(result.metadata?.qaCheck)).toMatchObject({ status: "failed", viewports: [{ overflow: true }, { overflow: true }] });
  });

  it("does not mistake a max-width media query for a fixed-width overflow", async () => {
    const result = await qaCheckTool.execute(
      { entryPath: "index.html", requiredText: ["Revenue"] },
      context({
        "index.html": "<html><head><meta name=\"viewport\" content=\"width=device-width\"></head><body>Revenue</body></html>",
        "styles.css": ".dashboard{width:100%;max-width:68rem}@media (max-width: 860px){.dashboard{padding:16px}}",
      }),
    );
    expect(qaCheckResultSchema.parse(result.metadata?.qaCheck)).toMatchObject({ status: "passed", viewports: [{ overflow: false }, { overflow: false }] });
  });
});

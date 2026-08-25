import { afterEach, describe, expect, it, vi } from "vitest";

import type { ToolContext } from "./context.js";
import { htmlToText, isPrivateHost, webfetchTool } from "./webfetch.js";

function context(): ToolContext {
  return {
    sessionId: "ses_1",
    userId: "usr_1",
    workspaceId: "ws_1",
    agent: "default",
    abort: new AbortController().signal,
    ask: async () => ({ id: "permission_1", reply: "once" }) as never,
    workspace: {
      list: async () => [],
      read: async () => null,
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

function mockFetch(status: number, body: string, contentType = "text/html; charset=utf-8") {
  const fn = vi.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? "OK" : "Error",
    headers: { get: () => contentType },
    text: async () => body,
  });
  vi.stubGlobal("fetch", fn);
  return fn;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("htmlToText", () => {
  it("strips scripts/styles and converts block elements to line breaks", () => {
    const html = "<html><head><title>X</title><style>body{}</style></head><body><script>alert(1)</script><h1>标题</h1><p>第一段</p><ul><li>项一</li><li>项二</li></ul></body></html>";
    expect(htmlToText(html)).toBe("标题\n第一段\n- 项一\n- 项二");
  });

  it("keeps link targets next to the link text", () => {
    expect(htmlToText('<a href="https://example.com/docs">文档</a>')).toBe("文档 (https://example.com/docs)");
  });

  it("decodes common entities", () => {
    expect(htmlToText("<p>A &amp; B &lt;C&gt; &quot;D&quot;</p>")).toBe("A & B <C> \"D\"");
  });
});

describe("isPrivateHost", () => {
  it("flags loopback, private and link-local hosts", () => {
    expect(isPrivateHost("127.0.0.1")).toBe(true);
    expect(isPrivateHost("localhost")).toBe(true);
    expect(isPrivateHost("10.0.0.1")).toBe(true);
    expect(isPrivateHost("192.168.1.1")).toBe(true);
    expect(isPrivateHost("172.16.0.1")).toBe(true);
    expect(isPrivateHost("169.254.169.254")).toBe(true);
    expect(isPrivateHost("::1")).toBe(true);
    expect(isPrivateHost("fe80::1")).toBe(true);
  });

  it("allows public hostnames", () => {
    expect(isPrivateHost("example.com")).toBe(false);
    expect(isPrivateHost("8.8.8.8")).toBe(false);
  });
});

describe("webfetch tool", () => {
  it("fetches a public HTML page and converts it to text", async () => {
    const fetchMock = mockFetch(200, "<html><body><h1>Hello</h1><p>World &amp; more</p></body></html>");
    const result = await webfetchTool.execute({ url: "https://example.com/page" }, context());
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(result.output).toBe("Hello\nWorld & more");
    expect(result.metadata).toMatchObject({ url: "https://example.com/page", truncated: false });
  });

  it("rejects loopback and private hosts (SSRF guard)", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    for (const url of ["http://127.0.0.1/admin", "http://localhost:3000", "http://10.0.0.1/", "http://192.168.1.1/", "http://172.16.0.1/", "http://[::1]/", "http://169.254.169.254/latest/meta-data/"]) {
      await expect(webfetchTool.execute({ url }, context())).rejects.toThrow("非公网地址");
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects non-http schemes at the schema level", async () => {
    await expect(webfetchTool.execute({ url: "file:///etc/passwd" }, context())).rejects.toThrow();
  });

  it("surfaces upstream HTTP errors", async () => {
    mockFetch(404, "not found");
    await expect(webfetchTool.execute({ url: "https://example.com/missing" }, context())).rejects.toThrow("HTTP 404");
  });

  it("returns plain text verbatim for non-HTML content types", async () => {
    mockFetch(200, '{"ok":true}', "application/json");
    const result = await webfetchTool.execute({ url: "https://api.example.com/health" }, context());
    expect(result.output).toBe('{"ok":true}');
  });

  it("truncates oversized responses and marks it in metadata", async () => {
    const big = "x".repeat(300 * 1024);
    mockFetch(200, big, "text/plain; charset=utf-8");
    const result = await webfetchTool.execute({ url: "https://example.com/big" }, context());
    expect(result.metadata?.truncated).toBe(true);
    expect(result.output).toContain("已截断");
  });
});

import { describe, expect, it } from "vitest";

import { createWebSearchTool, parseDuckDuckGoHtml } from "./websearch.js";
import type { ToolDef } from "./def.js";

const DDG_SAMPLE = `<html><body>
<div class="results"><div class="result">
<a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fa&amp;rut=xyz">Example A <b>bold</b></a>
<td class="result__snippet">First &amp; only <span>snippet</span>.</td>
</div>
<a class="result__a" href="https://direct.example.com/b">Direct Link</a>
<div class="result__snippet">plain snippet here</div>
</div></body></html>`;

function toolWith(opts: ConstructorParameters<typeof Object>[0] extends never ? never : Parameters<typeof createWebSearchTool>[0]) {
  return createWebSearchTool(opts) as ToolDef;
}

function stubContext() {
  return { sessionId: "s", userId: "u", workspaceId: "w", agent: "default", toolCallId: "c" } as never;
}

describe("parseDuckDuckGoHtml", () => {
  it("解出标题/还原 uddg 真实 URL/去标签摘要，兼容直接 https 链接", () => {
    const results = parseDuckDuckGoHtml(DDG_SAMPLE);
    expect(results).toHaveLength(2);
    expect(results[0]).toEqual({
      title: "Example A bold",
      url: "https://example.com/a",
      snippet: "First & only snippet.",
    });
    expect(results[1]).toMatchObject({ title: "Direct Link", url: "https://direct.example.com/b" });
  });

  it("空页返回空数组不抛错", () => {
    expect(parseDuckDuckGoHtml("<html><body>no results</body></html>")).toEqual([]);
  });
});

describe("createWebSearchTool（注入 fetch/env，零网络）", () => {
  const jsonFetch = (url: string | URL, status = 200, body: unknown) => {
    const impl = (async () =>
      new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })) as typeof fetch;
    void url;
    return impl;
  };

  it("默认 DuckDuckGo：返回格式化列表并带 provider 元数据", async () => {
    let capturedUrl = "";
    const htmlImpl = (async (input: string | URL) => {
      capturedUrl = String(input instanceof Request ? input.url : input);
      return new Response(DDG_SAMPLE, { status: 200 });
    }) as typeof fetch;
    const tool = toolWith({ fetchImpl: htmlImpl, envLoader: () => ({}) });
    const res = await tool.execute({ query: "zmzai harness" }, stubContext());
    expect(capturedUrl).toContain("html.duckduckgo.com/html/?q=");
    expect(res.output).toContain("https://example.com/a");
    expect(res.output).toContain("First & only");
    expect((res.metadata as { provider: string }).provider).toBe("duckduckgo");
  });

  it("配置 TAVILY_API_KEY 时优先 Tavily API 并映射结果", async () => {
    let calledUrl = "";
    let authHeader = "";
    const impl = (async (_input: string | URL, init?: RequestInit) => {
      calledUrl = String(_input);
      authHeader = (init?.headers as Record<string, string>)?.authorization ?? "";
      return new Response(
        JSON.stringify({ results: [{ title: "T", url: "https://t.example", content: "<b>cont</b>ent" }] }),
        { status: 200 },
      );
    }) as typeof fetch;
    const tool = toolWith({ fetchImpl: impl, envLoader: () => ({ TAVILY_API_KEY: "tvly-x" }) });
    const res = await tool.execute({ query: "q", maxResults: 3 }, stubContext());
    expect(calledUrl).toBe("https://api.tavily.com/search");
    expect(authHeader).toContain("Bearer tvly-x");
    expect(res.output).toContain("content");
    expect((res.metadata as { provider: string }).provider).toBe("tavily");
  });

  it("SERPER_API_KEY 走 serper 端点", async () => {
    let calledUrl = "";
    const impl = (async (input: string | URL) => {
      calledUrl = String(input);
      return new Response(JSON.stringify({ organic: [{ title: "S", link: "https://s.example", snippet: "snip" }] }), { status: 200 });
    }) as typeof fetch;
    void jsonFetch;
    const tool = toolWith({ fetchImpl: impl, envLoader: () => ({ SERPER_API_KEY: "sp-x" }) });
    await tool.execute({ query: "q" }, stubContext());
    expect(calledUrl).toBe("https://google.serper.dev/search");
  });

  it("上游非 2xx 报出真实 provider 与状态码", async () => {
    const impl = (async () => new Response("nope", { status: 503 })) as typeof fetch;
    const tool = toolWith({ fetchImpl: impl, envLoader: () => ({}) });
    await expect(tool.execute({ query: "x" }, stubContext())).rejects.toThrow(/duckduckgo.*503|503.*duckduckgo/s);
  });

  it("权限映射到 webfetch 分类并以 search: 前缀区分", () => {
    const tool = toolWith({ envLoader: () => ({}) });
    const mapped = tool.permission({ query: "hello world" }) as { permission: string; patterns: string[] };
    expect(mapped.permission).toBe("webfetch");
    expect(mapped.patterns).toEqual(["search:hello world"]);
  });
});

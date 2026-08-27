import { z } from "zod";

import type { ToolDef } from "../tools/def.js";

/** websearch（P0 补齐）：联网搜索工具。后端策略按可用凭据自动选择：
 *  TAVILY_API_KEY / SERPER_API_KEY 配置时走对应 API，否则回退
 *  DuckDuckGo Lite HTML 抓取（零依赖、无 key）。fetchImpl/envLoader 可注入，
 *  便于测试与产品侧统一代理。 */

export type WebSearchResult = { title: string; url: string; snippet: string };

const SEARCH_TIMEOUT_MS = 15_000;
const UA = "zmzai-agent/0.1 (websearch)";

export type WebSearchOptions = {
  fetchImpl?: typeof fetch;
  /** 注入点：默认读 process.env。返回任意 provider key 时优先对应 API。 */
  envLoader?: () => Record<string, string | undefined>;
};

/** 解析 DuckDuckGo Lite 结果页。href 常为 /l/?uddg=<encoded> 重定向，需还原真实 URL。 */
export function parseDuckDuckGoHtml(html: string): WebSearchResult[] {
  const results: WebSearchResult[] = [];
  const blockRe = /<a[^>]+class="[^"]*result__a[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>([\s\S]*?)(?=<div class="results_links|<a[^>]+class="[^"]*result__a|$)/gi;
  let match: RegExpExecArray | null;
  while ((match = blockRe.exec(html)) !== null) {
    const rawHref = match[1]!;
    const title = stripTags(match[2]!);
    const snippetSection = match[3] ?? "";
    const snippetMatch = /class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/(?:a|td|div)>/i.exec(snippetSection);
    const snippet = snippetMatch ? stripTags(snippetMatch[1]!) : "";
    const url = resolveDdgHref(rawHref);
    if (!url || !title) continue;
    results.push({ title, url, snippet });
  }
  return results;
}

function resolveDdgHref(href: string): string | null {
  // DuckDuckGo 的结果链接多为 /l/?uddg=<encodeURIComponent(target)> 重定向
  const uddgMatch = /[?&]uddg=([^&]+)/.exec(href);
  if (uddgMatch) {
    try {
      return decodeURIComponent(uddgMatch[1]!);
    } catch {
      return null;
    }
  }
  const value = href.startsWith("//") ? `https:${href}` : href;
  return /^https?:\/\//i.test(value) ? value : null;
}

function stripTags(fragment: string): string {
  return fragment
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#x27;|&#39;/gi, "'")
    .replace(/\s+/g, " ")
    .trim();
}

async function searchViaTavily(query: string, apiKey: string, maxResults: number, doFetch: typeof fetch): Promise<WebSearchResult[]> {
  const response = await doFetch("https://api.tavily.com/search", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}`, "user-agent": UA },
    body: JSON.stringify({ query, max_results: maxResults, search_depth: "basic" }),
    signal: AbortSignal.timeout(SEARCH_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`Tavily 搜索失败：HTTP ${response.status}`);
  const data = (await response.json()) as { results?: Array<{ title?: string; url?: string; content?: string }> };
  return (data.results ?? [])
    .filter((item) => item.url)
    .map((item) => ({ title: item.title ?? item.url!, url: item.url!, snippet: stripTags(item.content ?? "") }));
}

async function searchViaSerper(query: string, apiKey: string, maxResults: number, doFetch: typeof fetch): Promise<WebSearchResult[]> {
  const response = await doFetch("https://google.serper.dev/search", {
    method: "POST",
    headers: { "content-type": "application/json", "X-API-KEY": apiKey, "user-agent": UA },
    body: JSON.stringify({ q: query, num: maxResults }),
    signal: AbortSignal.timeout(SEARCH_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`Serper 搜索失败：HTTP ${response.status}`);
  const data = (await response.json()) as { organic?: Array<{ title?: string; link?: string; snippet?: string }> };
  return (data.organic ?? [])
    .filter((item) => item.link)
    .map((item) => ({ title: item.title ?? item.link!, url: item.link!, snippet: stripTags(item.snippet ?? "") }));
}

async function searchViaDuckDuckGo(query: string, maxResults: number, doFetch: typeof fetch): Promise<WebSearchResult[]> {
  const endpoint = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}&kl=wt-wt`;
  const response = await doFetch(endpoint, {
    headers: { "user-agent": UA, accept: "text/html" },
    signal: AbortSignal.timeout(SEARCH_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`DuckDuckGo 搜索失败：HTTP ${response.status}`);
  const html = await response.text();
  const all = parseDuckDuckGoHtml(html);
  return all.slice(0, maxResults);
}

export function createWebSearchTool(opts: WebSearchOptions = {}): ToolDef {
  const doFetch = opts.fetchImpl ?? globalThis.fetch.bind(globalThis);
  const envLoader =
    opts.envLoader ?? (() => ({ TAVILY_API_KEY: process.env.TAVILY_API_KEY, SERPER_API_KEY: process.env.SERPER_API_KEY }));

  return {
    id: "websearch",
    label: "联网搜索",
    description:
      "搜索互联网并返回标题+链接+摘要列表（多数结果无需再抓取即可判断相关性；需要全文时对结果 URL 用 webfetch）。查询用与目标资料相同的语言效果最好。",
    parameters: z.object({
      query: z.string().trim().min(1).max(400),
      maxResults: z.number().int().min(1).max(10).optional(),
    }),
    permission: (args) => ({ permission: "webfetch", patterns: [`search:${args.query}`] }),
    async execute(args) {
      const maxResults = args.maxResults ?? 6;
      const env = envLoader();
      const startedAt = Date.now();
      let provider = "duckduckgo";
      let results: WebSearchResult[];
      try {
        if (env.TAVILY_API_KEY) {
          provider = "tavily";
          results = await searchViaTavily(args.query, env.TAVILY_API_KEY, maxResults, doFetch);
        } else if (env.SERPER_API_KEY) {
          provider = "serper";
          results = await searchViaSerper(args.query, env.SERPER_API_KEY, maxResults, doFetch);
        } else {
          results = await searchViaDuckDuckGo(args.query, maxResults, doFetch);
        }
      } catch (error) {
        throw new Error(`搜索失败（provider=${provider}）：${error instanceof Error ? error.message : String(error)}`);
      }
      const output = results.length
        ? results.map((r, i) => `${i + 1}. ${r.title}\n   ${r.url}${r.snippet ? `\n   ${r.snippet.slice(0, 300)}` : ""}`).join("\n")
        : "（没有搜索结果）";
      return {
        title: `搜索「${args.query.slice(0, 30)}」：${results.length} 条`,
        output,
        metadata: { provider, count: results.length, durationMs: Date.now() - startedAt },
      };
    },
  };
}

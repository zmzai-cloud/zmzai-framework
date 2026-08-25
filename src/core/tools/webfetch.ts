import { z } from "zod";

import type { ToolDef } from "../tools/def.js";

/** 私网/回环/链路本地地址段（防 SSRF）：webfetch 只允许公网目标。 */
const BLOCKED_CIDRS: Array<[number, number]> = [
  [0x00000000, 8], // 0.0.0.0/8
  [0x0a000000, 8], // 10.0.0.0/8
  [0x7f000000, 8], // 127.0.0.0/8
  [0xac100000, 12], // 172.16.0.0/12
  [0xc0a80000, 16], // 192.168.0.0/16
  [0xa9fe0000, 16], // 169.254.0.0/16
  [0xc0000200, 24], // 192.0.2.0/24
];

function ipv4ToNumber(ip: string): number | null {
  const parts = ip.split(".").map((part) => Number.parseInt(part, 10));
  if (parts.length !== 4 || parts.some((part) => Number.isNaN(part) || part < 0 || part > 255)) return null;
  return ((parts[0]! << 24) | (parts[1]! << 16) | (parts[2]! << 8) | parts[3]!) >>> 0;
}

export function isPrivateHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/\.$/, "");
  if (host === "localhost" || host.endsWith(".localhost")) return true;
  if (host.includes(":")) {
    // IPv6：URL.hostname 会带方括号（如 [::1]），先去括号；只拦截回环与链路本地
    // （v0 不做完整 IPv6 私网段判定，标记已知简化）
    const ipv6 = host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
    return ipv6 === "::1" || ipv6 === "::" || ipv6.startsWith("fe80:");
  }
  const number = ipv4ToNumber(host);
  if (number === null) return false; // 域名按公网放行（DNS 解析层面不做二次校验，标记已知简化）
  return BLOCKED_CIDRS.some(([base, prefix]) => {
    const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
    return (number & mask) === (base & mask);
  });
}

/** 把 HTML 粗略转成纯文本：去 script/style、块级标签换行、超链接保留目标。
 *  不追求精确——webfetch 的目标是让模型拿到可读内容，不是渲染网页。 */
export function htmlToText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<head[\s\S]*?<\/head>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li|h[1-6]|tr|blockquote|pre|section|article)>/gi, "\n")
    .replace(/<li[^>]*>/gi, "\n- ")
    .replace(/<a[^>]+href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi, "$2 ($1)")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/g, "'")
    .replace(/\n{2,}/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .trim();
}

const MAX_RESPONSE_BYTES = 256 * 1024;
const FETCH_TIMEOUT_MS = 15_000;

/** webfetch（spec §7.2）：抓取公网 URL 并转为文本。v0 experimental：
 *  白名单域可后续在工具参数或产品配置层收紧，目前只有 SSRF 防护 +
 *  大小/超时上限。 */
export const webfetchTool: ToolDef = {
  id: "webfetch",
  label: "抓取网页",
  description:
    "（experimental）抓取一个公网网页并返回文本内容，供分析文档、查阅资料使用。只允许 http(s) 公网地址，私网/本机地址会被拒绝。响应超过 256KB 会被截断。",
  parameters: z.object({
    url: z.string().url().max(2048).refine((value) => /^https?:\/\//i.test(value), { message: "只支持 http/https URL" }),
  }),
  permission: (args) => ({ permission: "webfetch", patterns: [args.url] }),
  async execute(args) {
    const target = new URL(args.url);
    if (isPrivateHost(target.hostname)) {
      throw new Error(`拒绝访问非公网地址：${target.hostname}（webfetch 只允许公网目标）`);
    }

    let response: Response;
    try {
      response = await fetch(target, { redirect: "follow", signal: AbortSignal.timeout(FETCH_TIMEOUT_MS), headers: { "user-agent": "zmzai-agent/0.1 (webfetch)" } });
    } catch (error) {
      throw new Error(`抓取失败：${error instanceof Error ? error.message : "网络错误"}`);
    }
    if (!response.ok) throw new Error(`抓取失败：HTTP ${response.status} ${response.statusText}`);

    const contentType = response.headers.get("content-type") ?? "";
    const raw = await response.text();
    const bytes = Buffer.byteLength(raw, "utf8");
    const truncated = bytes > MAX_RESPONSE_BYTES;
    const text = truncated ? raw.slice(0, Math.floor(MAX_RESPONSE_BYTES / 2)) : raw;

    let output: string;
    if (/text\/html|application\/xhtml/i.test(contentType)) output = htmlToText(text);
    else output = text.trim();
    if (truncated) output += `\n\n…[内容超过 ${MAX_RESPONSE_BYTES} 字节已截断]…`;

    return {
      title: `抓取 ${target.hostname}`,
      output: output || "（页面无文本内容）",
      metadata: { url: args.url, contentType, bytes, truncated },
    };
  },
};

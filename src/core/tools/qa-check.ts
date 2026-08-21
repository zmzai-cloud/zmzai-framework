import { z } from "zod";

import type { ToolDef } from "./def.js";

export const qaCheckResultSchema = z.object({
  version: z.literal("v1"),
  status: z.enum(["passed", "failed"]),
  checks: z.array(z.object({ id: z.enum(["html_loads", "metrics_present", "desktop_viewport", "mobile_viewport"]), status: z.enum(["passed", "failed"]), message: z.string() })),
  viewports: z.array(z.object({ width: z.number().int().positive(), height: z.number().int().positive(), overflow: z.boolean() })),
});

export type QaCheckResult = z.infer<typeof qaCheckResultSchema>;

const qaCheckInputSchema = z.object({
  entryPath: z.string().trim().min(1).max(512).default("index.html"),
  requiredText: z.array(z.string().trim().min(1).max(120)).max(20).default([]),
});

function hasViewportMeta(html: string): boolean {
  return /<meta\s+[^>]*name=["']viewport["'][^>]*>/i.test(html) || /<meta\s+[^>]*content=["'][^"']*width=device-width/i.test(html);
}

function hasResponsiveStyles(styles: string): boolean {
  return /@media\s*\(/i.test(styles) || /\b(?:display\s*:\s*(?:grid|flex)|max-width\s*:|clamp\s*\()/i.test(styles);
}

function hasFixedOverflowRisk(styles: string): boolean {
  // `max-width` is commonly used in responsive media queries and containers;
  // it constrains a layout rather than forcing it wider. Only a literal width
  // or min-width declaration at a CSS declaration boundary is an overflow risk.
  return /(?:^|[;{]\s*)(?:width|min-width)\s*:\s*(?:[5-9]\d{2}|\d{4,})px\s*(?:;|})/im.test(styles) && !/max-width\s*:\s*100%/i.test(styles);
}

export const qaCheckTool: ToolDef = {
  id: "qa-check",
  label: "质量检查",
  description: "检查当前 Workspace 中的 web_app：HTML 是否可加载、核心内容是否存在、桌面和移动视口是否有明显布局风险。返回稳定的 v1 JSON；失败时请先修复再继续交付。",
  parameters: qaCheckInputSchema,
  permission: () => null,
  async execute(args, ctx) {
    const entry = await ctx.workspace.read(args.entryPath);
    const styles = (await Promise.all((await ctx.workspace.list()).filter((file) => file.path.endsWith(".css")).slice(0, 20).map((file) => ctx.workspace.read(file.path)))).filter((file): file is { path: string; content: string } => Boolean(file)).map((file) => file.content).join("\n");
    const html = entry?.content ?? "";
    const htmlLoads = Boolean(entry && /<html\b/i.test(html) && /<body\b/i.test(html));
    const missingText = args.requiredText.filter((text: string) => !html.includes(text));
    const responsive = hasViewportMeta(html) && hasResponsiveStyles(styles);
    const overflowRisk = hasFixedOverflowRisk(styles);
    const checks: QaCheckResult["checks"] = [
      { id: "html_loads", status: htmlLoads ? "passed" : "failed", message: htmlLoads ? `${args.entryPath} 可加载` : `${args.entryPath} 缺少有效 html/body` },
      { id: "metrics_present", status: missingText.length === 0 ? "passed" : "failed", message: missingText.length ? `缺少核心内容：${missingText.join(", ")}` : "核心内容已存在" },
      { id: "desktop_viewport", status: overflowRisk ? "failed" : "passed", message: overflowRisk ? "样式存在固定宽度溢出风险" : "桌面视口无明显固定宽度风险" },
      { id: "mobile_viewport", status: responsive && !overflowRisk ? "passed" : "failed", message: !hasViewportMeta(html) ? "缺少移动端 viewport meta" : !hasResponsiveStyles(styles) ? "缺少响应式样式" : overflowRisk ? "移动视口存在固定宽度溢出风险" : "移动视口具备基础响应式约束" },
    ];
    const result: QaCheckResult = {
      version: "v1",
      status: checks.every((check) => check.status === "passed") ? "passed" : "failed",
      checks,
      viewports: [{ width: 1280, height: 800, overflow: overflowRisk }, { width: 390, height: 844, overflow: !responsive || overflowRisk }],
    };
    return { title: `质量检查：${result.status === "passed" ? "通过" : "需要修复"}`, output: JSON.stringify(result, null, 2), metadata: { qaCheck: result } };
  },
};

---
"@zmzai/agent-framework": patch
---

`summarizeRun` 在任务终态不再静默跳过：即使 summary 模型缺失、本轮无可总结消息、生成失败、超时或返回空文本，也会兜底发一条带 `meta`（工具调用数/改动文件数/耗时）的 `session.summary` 事件。前端「任务完成卡」三态（完成/中断/失败）因此必然出现，而非生成端异常时悄无声息结束。AI 总结成功时仍用真实文本，失败时用结构化模板文案。

总结模型改为沿用**会话实际模型**（`modelFor(session.model)`），不再依赖 compaction 专用的 `summaryModel`——当宿主把 compaction 的 summaryModel 配成与主链路不一致的模型名（如硬编码 `gpt-4o`）时，总结陈词仍由当前会话正在用的模型生成，避免「模型名对不上 → 总结退化成兜底模板」。仅当 compaction 启用时才做 AI 总结，`modelFor` 抛错时回落 `compaction.summaryModel`。

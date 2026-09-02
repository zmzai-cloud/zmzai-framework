---
"@zmzai/agent-framework": minor
---

压缩阈值改用模型真实上下文窗口

自动压缩此前固定用 runtime 级 `compaction.contextWindow`（产品侧多为硬编码 128k），
而产品通常持有模型目录里的真实窗口，两者脱节：长窗口模型被提前压缩、小窗口
模型不压缩直到上游溢出报错。

- `createOpenAiModelProvider` 新增 `modelCaps` 选项：按 modelId 返回真实
  `{ contextWindow, maxTokens }`，未命中（或解析器抛错）回落原默认常量
  128k / 16k，与不配置时行为完全一致
- 导出 `DEFAULT_CONTEXT_WINDOW` / `DEFAULT_MAX_TOKENS` 常量供产品侧对齐
- runner 的 `contextWindowFor(session)` 优先取当前会话模型的 `contextWindow`，
  取不到再回落 runtime 级配置；解析失败不阻断压缩

---
"@zmzai/agent-framework": patch
---

`runLoop` 会把当轮实际使用的模型回写 `session.model`（仅在模型变化时写库）。此前 `input.model` / agent 声明的 model 只作用于当轮、从不落库，导致所有读 `session.model` 的旁路拿到的都是建会话时的旧模型甚至 env 兜底值——包括压缩阈值 `contextWindowFor`、总结陈词 `summarizeRun`、子代理继承、以及宿主侧的异步标题生成。回写在 `buildCompaction` 之前完成并同步内存引用，因此压缩阈值当轮即按新模型计算。

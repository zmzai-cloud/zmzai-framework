# @zmzai/agent-framework

## 0.2.2

### Patch Changes

- 67c9852: 事件总线 live fan-out 注册表挂 globalThis：Next dev 热重载后 runner（globalThis 缓存的旧实例）publish 的事件不再送达 SSE 订阅端（listeners map 随模块实例分裂），订阅端静默退化为 1s 轮询——表现为消息 1-2s 才回显。

## 0.2.1

### Patch Changes

- dc7c85d: runner 增加流空闲看门狗：上游 120s 无任何 agent 事件时发布 session.error（StreamIdleTimeout）并中止本次运行，避免对不支持该输入的模型（如非视觉模型收到图片）发送消息时 runLoop 无限挂起、UI 表现为「卡住」无反馈。

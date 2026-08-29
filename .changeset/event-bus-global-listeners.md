---
'@zmzai/agent-framework': patch
---

事件总线 live fan-out 注册表挂 globalThis：Next dev 热重载后 runner（globalThis 缓存的旧实例）publish 的事件不再送达 SSE 订阅端（listeners map 随模块实例分裂），订阅端静默退化为 1s 轮询——表现为消息 1-2s 才回显。

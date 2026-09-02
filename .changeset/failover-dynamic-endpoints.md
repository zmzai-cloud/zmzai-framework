---
"@zmzai/agent-framework": minor
---

`createOpenAiModelProvider` 的 `failoverEndpoints` 现在也接受函数形式（`FailoverEndpoint[] | (() => FailoverEndpoint[])`），与 `baseUrl` 一样每次请求重新求值——宿主可把降级端点做成可配置项，改动无需重建 provider 即时生效。求值抛错时回落空数组（降级是增强，绝不阻断主链路）；数组形式向后兼容。

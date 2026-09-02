# @zmzai/agent-framework

## 0.4.0

### Minor Changes

- d0ee2bd: `createOpenAiModelProvider` 的 `failoverEndpoints` 现在也接受函数形式（`FailoverEndpoint[] | (() => FailoverEndpoint[])`），与 `baseUrl` 一样每次请求重新求值——宿主可把降级端点做成可配置项，改动无需重建 provider 即时生效。求值抛错时回落空数组（降级是增强，绝不阻断主链路）；数组形式向后兼容。

## 0.2.5

### Minor Changes

- 回溯重发基座：`SessionStore.truncateFrom` + `session.rewound` 事件。消息可截断到指定位置重发，事件溯源保证 SSE 续传不复活已删消息。

## 0.2.4

### Minor Changes

- node-pty spawn-helper 执行位修复（darwin-arm64）
- 任务小结 + 运行中断点 + 会话状态字段
- 优雅退出原子能力：`listActiveSessions` + `SqliteSessionStore.checkpoint`
- 流空闲看门狗默认 5 分钟，超时文案引导一键继续
- 会话稳定性 P1：重试增强 + 看门狗软化
- SQLite 运行租约 + 持久化事件日志（会话稳定性 P0）

## 0.2.3

### Minor Changes

- `AgentFramework` 暴露 `modelFor` / `streamFor`：宿主侧 one-shot LLM 调用复用主链路
- `SessionStore` 增加 `deleteSession`：SQLite / JSONL 级联删除会话

## 0.3.0

### Minor Changes

- dc554d5: 压缩阈值改用模型真实上下文窗口
  
  自动压缩此前固定用 runtime 级 `compaction.contextWindow`（产品侧多为硬编码 128k），
  而产品通常持有模型目录里的真实窗口，两者脱节：长窗口模型被提前压缩、小窗口
  模型不压缩直到上游溢出报错。
  
  - `createOpenAiModelProvider` 新增 `modelCaps` 选项：按 modelId 返回真实
    `{ contextWindow, maxTokens }`，未命中（或解析器抛错）回落原默认常量
    128k / 16k，与不配置时行为完全一致
  - 导出 `DEFAULT_CONTEXT_WINDOW` / `DEFAULT_MAX_TOKENS` 常量供产品侧对齐
  - runner 的 `contextWindowFor(session)` 优先取当前会话模型的 `contextWindow`，
    取不到再回落 runtime 级配置；解析失败不阻断压缩
- 推理力度跟随模型白名单
  
  此前 `getModel` 硬编码 `supportsReasoningEffort: true`，无论模型目录是否声明了
  可用的推理档位，UI 都展示全部档位，用户选到白名单之外的档位时上游（relay）会
  返回 `REASONING_EFFORT_NOT_ALLOWED` 400。
  
  - `ModelCaps` 新增 `allowedReasoningEfforts?: string[]`，产品侧从模型目录灌入
  - `getModel` 据此构造 `thinkingLevelMap`（白名单内档位透传、其余为 `null`），
    `supportsReasoningEffort` 改为「白名单非空」而非硬编码 `true`；目录未覆盖时
    回落 `false`（等价 off 语义），pi-ai 的 `clampThinkingLevel` 会自动把用户所选
    档位钳制到模型可用范围，从源头杜绝 400

## 0.2.2

### Patch Changes

- 67c9852: 事件总线 live fan-out 注册表挂 globalThis：Next dev 热重载后 runner（globalThis 缓存的旧实例）publish 的事件不再送达 SSE 订阅端（listeners map 随模块实例分裂），订阅端静默退化为 1s 轮询——表现为消息 1-2s 才回显。

## 0.2.1

### Patch Changes

- dc7c85d: runner 增加流空闲看门狗：上游 120s 无任何 agent 事件时发布 session.error（StreamIdleTimeout）并中止本次运行，避免对不支持该输入的模型（如非视觉模型收到图片）发送消息时 runLoop 无限挂起、UI 表现为「卡住」无反馈。

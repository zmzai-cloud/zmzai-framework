# @zmzai/agent-framework

## 0.4.1

### Patch Changes

- c2bdb63: 修复权限「always」沉淀粒度（P0，对照 Claude Code v2.1.259 四类参数位置绕过自查后的直接修复）：
  
  - **bash**：复合/管道命令（归一为 `sh -c`）在「总是允许」时只沉淀精确整串规则，绝不再沉淀 `sh *` 程序级通配——此前一次批准任意无害复合命令 = 之后所有复合命令静默放行。简单单程序命令仍保留 `program *` 通配便利。
  - **terminal**：同构修复。含 `| > < ; & $()` 或反引号的命令只沉淀精确整串，不下沉首 token 通配（`npm run dev && rm -rf ~` 不再产生 `npm *`）。
  - **MCP**：「总是允许」从 `server/*` 收窄为精确 `server/tool`——批准一个工具不再隐式放行同服务器全部工具；服务器级信任应由宿主产品显式提供。
- b1d095a: `runLoop` 会把当轮实际使用的模型回写 `session.model`（仅在模型变化时写库）。此前 `input.model` / agent 声明的 model 只作用于当轮、从不落库，导致所有读 `session.model` 的旁路拿到的都是建会话时的旧模型甚至 env 兜底值——包括压缩阈值 `contextWindowFor`、总结陈词 `summarizeRun`、子代理继承、以及宿主侧的异步标题生成。回写在 `buildCompaction` 之前完成并同步内存引用，因此压缩阈值当轮即按新模型计算。
- 24c748d: 新增 `isSessionAwaitingPermission(sessionId)`：查询会话当前 run 是否挂起等待人工授权（HITL 待确认）。供宿主会话列表把「待确认」从笼统的「运行中」区分出来——后台会话被权限请求卡住时侧边栏能直接给出信号。
- 4c84c50: `summarizeRun` 在任务终态不再静默跳过：即使 summary 模型缺失、本轮无可总结消息、生成失败、超时或返回空文本，也会兜底发一条带 `meta`（工具调用数/改动文件数/耗时）的 `session.summary` 事件。前端「任务完成卡」三态（完成/中断/失败）因此必然出现，而非生成端异常时悄无声息结束。AI 总结成功时仍用真实文本，失败时用结构化模板文案。
  
  总结模型改为沿用**会话实际模型**（`modelFor(session.model)`），不再依赖 compaction 专用的 `summaryModel`——当宿主把 compaction 的 summaryModel 配成与主链路不一致的模型名（如硬编码 `gpt-4o`）时，总结陈词仍由当前会话正在用的模型生成，避免「模型名对不上 → 总结退化成兜底模板」。仅当 compaction 启用时才做 AI 总结，`modelFor` 抛错时回落 `compaction.summaryModel`。

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

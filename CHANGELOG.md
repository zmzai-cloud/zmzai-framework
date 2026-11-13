# @zmzai/agent-framework

## 0.19.9

### Patch Changes

- 埋点补全：submit-timing（task=任务建档 accept=workflow 事务）；runloop-timing 加 entry epoch 与 pre 段（registry/技能解析前置体）；firstEvent 改量首个 provider 流事件（原 subscribe 顶部量到本地事件，恒 1ms）。

## 0.19.8

### Patch Changes

- Review 修正：runloop-timing 加 t0 epoch + runner.prompt 入口 [prompt-enter] epoch（受理→runLoop 启动的建档/租约开销此前是盲区）；firstEvent 无事件时不再打负数。

## 0.19.7

### Patch Changes

- **runLoop 全链计时埋点**：runloop-phase（只打 >2s 段）改为 runloop-timing——ctx（上下文组装，含记忆召回）/ agent（Agent 构造）/ firstEvent（模型流首事件，含请求+TTFT）/ total 收尾一行输出。装配开销分散在多个 <2s 步骤时不再隐形。

## 0.19.6

### Patch Changes

- **推理档位 off 档映射为 minimal 下发**：pi 会把 thinkingLevel=off 折叠成「不带 reasoning_effort」，GLM 系上游收不到字段=默认开思考——off 的关闭语义必须以 minimal 形式到达 relay，由渠道侧（relay thinkingFormat=zai 翻译，2026-11-12 同步上线）转成 thinking:{type:"disabled"}。

## 0.19.5

### Patch Changes

- **纯问答轮跳过收尾 AI 总结**：summarizeRun 在 finally 里被 await，其 LLM 调用（15s 超时兜底）直接拖住 resolveDone → 任务交付判定（实测 hello 收尾多 3.4s）。零工作轮（Gate 4.5 回答即交付）答案正文就在消息流里、whisper 只消费 meta——stats 新增 workToolCalls，completed 且零工作轮不再调总结模型，兜底文案「本轮已直接回答。」。

## 0.19.4

### Patch Changes

- **纯问答轮「回答即交付」（Completion Gate 4.5）**：整轮零工作工具（不含 task_deliver/todo/task_block 簿记）= 零副作用 = 无可验收的工作项——正常跑完且写出最终回答即 delivered，不再被「必须显式 task_deliver」的单行道推进续跑循环（模型被迫为一句 hello 编造交付仪式，三轮后落 no_progress）。安全边界五条：零工作工具、正常跑完、有最终回答、无未收尾子代理、无未完成步骤（立了 todo 计划即宣告工作，必须做完或显式交付）。有过任何工作工具的轮次不变——显式交付不变量（条件 6）照旧。delivered verdict 新增可选 `result`（纯问答轮带干净四问结果，避免 fallback 的「0 个步骤、0 次工具调用」空话）。
- **任务契约提示词双通道**：工作轮必须显式交付（原文保留）；纯问答轮明确指示「直接把回答写完整即可，不要调用 task_deliver、不要提验收/交付——回答本身就是交付」。
- RunOutcome 新增 `workToolCalls`（attempt-executor 在 tool_execution_start 按工具名排除簿记累加），CompletionRuntimeState 透传同名字段。

## 0.19.2

### Patch Changes

- **修复 glob/list 在大工作区上 "Maximum call stack size exceeded"**：`createFsWorkspaceFiles().list()` 的目录遍历是递归 walk——深目录（node_modules 嵌套）爆调用栈；且逐文件 `readFile` 拿 bytes 把全部文件内容读进内存（用户实测 20 万文件工作区）。改为显式栈迭代 + `stat` 取大小（不读内容）+ 5 万条硬上限。符号链接去环语义不变。

## 0.19.1

### Patch Changes

- **修复停止请求到不了工具层（用户实测卡死）**：`ToolContext.abort` 此前挂着一个永不触发的占位信号，run 的真实中止信号从未接入——大工作区上的 grep 等长扫描工具无法中断（实测 15GB/20 万文件工作区 `grep spec/**` 无界挂死，停止无效）。现在 runLoop 建立的 `AbortController` 直接回填进工具上下文。
- **grep 扫描预算与逐文件中止**：最多读 2000 个文件、超 1MB 的文件跳过，逐文件检查中止信号；触顶如实报 `truncated`（此前无界逐文件全文读取，结果集上限之外的扫描永不停止）。
- **abort 强制收尾兜底**：不可中止的工具（MCP/挂起 bash）在停止后 5s 宽限耗尽时不再等待——attempt 按 cancelled 走完收尾（租约/事件/onRunEnd 照常），在飞工具部件标 `error(outcome=unknown)`；晚到的工具结果只追加审计事件，不再卡死会话。

## 0.19.0

### Minor Changes

- **升级 PI 运行时：`@earendil-works/pi-agent-core` / `pi-ai` 0.84.1 → 1.5.0**（跨上游 1.0）。随升级获得：流式工具参数 O(n²)→线性（大 write/edit 的 CPU/内存）、网关/瞬时错误自动重试大扫除（server_busy/upstream_error/stream disconnected 等，Zhipu 1308 用量超限不再无限重试）、消息与工具结果的真实 `durationMs`、`Usage.cost.totalFromProvider` 计费真值标记、输出预算按 15% 预留与 3.5 chars/token 估算防误压缩、MCP 外部工具参数统一 JSON Schema coerce、agent-core 瘦身（删实验 harness，1.8MB→0.27MB）。
- **迁移**（对宿主 API 无变化）：`shouldStopAfterTurn` → `finishTurn`（按上游迁移守卫保持「仅正常响应计数」语义，steps 上限不变）；自定义 streamFn 入参 `Context` → `TranscriptContext`；systemPrompt 观测改经 `getCurrentSystemPrompt`。
- **PI 1.5 能力接入（第一/二档）**：①assistant 消息投影 `durationMs`（响应耗时）、`thinkingLevel`（实际生效档位）、`cost{total,totalFromProvider}`（provider 计费真值 vs 目录估算），step-finish part 带费用，工具完成态带单调时钟执行耗时；②外层重试判定优先 pi-ai `isRetryableAssistantError`（server_busy 等网关瞬断判可重试、Zhipu 1308 用量超限判不可重试——本地字符串列表追不上的精度），本地列表保留为兜底；③新增 `RunnerDeps.onProviderStreamEvent`（createServer 同名透传）：归一化前的 provider 原始流事件观测，经 Agent 进流函数 options。
- **排队/steering 不迁移 pi 内存队列（决策）**：框架排队经 WorkflowStore 持久化（spec §4.2「内存队列仅缓存」），pi steering/followUp 是进程内 PendingMessageQueue 且语义为 run 中注入（框架为 run 间 drain 续跑）——迁移丢持久化契约。已采纳的官方钩子：finishTurn（本升级）。
- **修复 `streamOneText` 在 pi 1.x 下静默丢失系统提示**：旧实现给 provider 流函数传 `{ systemPrompt, messages }`、调用方 `as never` 硬转，pi ≥0.86 的 provider 只从 transcript 前导系统消息读系统提示——总结与标题生成会失去指令。现经 `normalizeContext` 折叠成正规 TranscriptContext，参数类型对齐 pi `StreamFn`（宿主侧强转可去）。
- **修复升级引入的基准偏移**：pi ≥0.86 把 systemPrompt+工具声明 unshift 成前导系统消息，run 收尾按 `agent.state.messages` 实际前导 system 条数补偿 baseline——否则切片左移一条，记忆注入段（内存态首条 user 消息）会混进 onRunEnd 的 newMessages 与总结素材。
- 含 0.18.1：repomap wasm 目录按依赖布局解析（pnpm 同级/npm 提升），加载失败不再伪装空地图。

## 0.18.1

### Patch Changes

- **修复 `resolveFrameworkVendorDirs` 在 pnpm / npm 去重布局下返回不存在的 wasm 目录**：旧实现只拼「framework 包内嵌套 node_modules」路径，而 pnpm 把依赖放在包同级（`.pnpm/<entry>/node_modules/`）、npm 去重会提升到祖先 node_modules——两种主流布局都会命中不存在的目录。消费方经 `setWasmDirs` 写入后，emscripten 加载失败会直接结束进程（Lectern Host 一次 `/api/repomap` 即崩）。现按 Node 依赖查找顺序（嵌套 → scope 同级 → 逐级祖先）逐候选并核对 wasm 文件真实存在；找不到仍按原契约抛错，签名不变。新增导出 `resolveVendorDirsFrom(frameworkRoot)` 便于宿主按自有锚点解析。
- **wasm 不可用不再伪装成空地图**：Parser/Language 加载失败统一包为 `WasmUnavailableError`；`renderRepoMap` 遇到它如实上抛，不再按「单文件解析失败」跳过后返回「工作区没有可索引的代码文件」。
- **repo_map 默认开启前探测资源**：fs 工作区默认注册 repo_map 时先确认 wasm 可用，不可用的环境不再注册一个必然失败的工具；显式对象形式（`capabilities.repoMap: { workspaceRoot }`）照常注册。

## 0.11.0

### Minor Changes

- **子代理持久协调（M3，spec §8）**：`SubagentCoordinator`（限额队列 perRoot 3/global 6、根间轮转根内 FIFO、spawn 幂等/agent_list/send/wait/cancel 五面、取消树）；SubagentRecord + mailbox 双 SQLite 表（CAS 状态机 11 态、messageId 去重、父消费水位）；parked/mailbox/父唤醒（水位幂等合并、终态父拒绝复活）；`agent_*` 五工具族 + 旧 task 兼容封装。
- **装配面**：`RunnerDeps.subagentCoordinator` 可选注入（注入即 agent_* 工具自动拼装、spawnSubagent 走持久协调）；coordinator.spawn 支持预建 childSessionId（runner 侧权限 stamp 路径）；TaskRecord 新增可选 parkedReason。
- `SubagentStore` 经 `SessionStore.subagents` 可选面提供；未提供时子代理能力明确降级（SUBAGENTS_UNSUPPORTED）。

## 0.10.0

### Minor Changes

- **Runner 拆分（M1-W6/W7，行为保持）**：2068 行的 `SessionRunner` 拆为六个具名单元——`CommandService`（prompt 提交链/任务归属/拒绝回滚）、`RunScheduler`（drain 驱动链/放行登记/停止协调/租约，`leaseOwner` 可注入）、`TaskLifecycle`（Attempt 循环/预算闸/投影/终态）、`ContextBuilder`（上下文组装唯一入口）、`AttemptExecutor`（单次 Attempt 执行）、`ActiveRunRegistry`（全局活跃 run 表）。对外 API 与导出路径全部不变；runner.ts 降至 545 行（spec §7 审查线 400）。实测踩坑两条已写入代码注释：委托层必须非 async 直通（`async return promise` 多一拍 microtask，翻转提交与 drain 交错）；executor 持原 `RunnerDeps` 引用而非构造时快照（测试会在构造后改 deps 字段）。
- **修复 runLoop 读偏斜竞态（TOCTOU）**：此前先读 `workflowRuns` 算排除集、下一拍才读消息，两拍之间 acceptPrompt 落库的排队消息会泄入运行中 run 的模型上下文。`WorkflowStore` 新增可选 `rebuildSnapshot`（sqlite 单事务同拍读两表），ContextBuilder 消费不可变快照——机制上消除窗口；未提供的后端回落两拍。
- **CompactionStore 跨 Attempt 复用（W7-S8）**：`store.compaction` 可选面持久化 `CompactionRecord{summary,anchor,tailTokensAtCompaction,prefixHash}`；前缀指纹逐字节一致才播种 transform，任何不一致（rewind/召回变化）放弃复用重新摘要——宁重复摘要不脏上下文。已知边界：`rebuildMessages` 尚不重建 toolResult 消息，工具密集会话回落每 Attempt 重摘（与旧版等价）。
- **ToolContract 声明 + toolCallId 执行台账（W8）**：`ToolDef/ExternalToolDef` 新增 `contract?: { effect, retrySafety, concurrency }`（spec §9.3 声明子集，缺失按保守语义）；全部内建工具已标注。adapter 双适配器按 toolCallId 去重——同一 callId 重复派发返回原执行记录、in-flight 共享 promise，修复重复 callId 重执行并留悬挂 running part 的缺陷。
- **破坏性变更：`modelCaps` 回调签名改为 `(ref: ModelRef)`**（W9）。只按 modelId 缓存会让同一 modelId 挂不同 provider 的能力串用（A32）；宿主接线需改为按 providerId+modelId 查目录。

## 0.9.0

### Minor Changes

- **交付改为模型显式声明（新增 `task_deliver` 工具），删掉从「本轮有输出文本」推导完成的那条放宽。**
  
  起因是一次真实事故：用户发「继续执行」，模型回「继续。跑自检验证前面改动的正确性：」——一句话停在冒号上、零工具调用、28 个输出 token。框架仍然发出了 `task.delivered`，交付卡写着「完成了 0 个步骤、0 次工具调用」「剩余项：无」，任务进终态，用户那句指令被吞掉。
  
  根因是 `projectImplicitCriterion`（已删除）：它把「本轮有没有输出文本」直接投影成「验收条件 passed」。这与规格 §3.1 那条根因是同一个错——「一次运行正常结束 ≠ 用户目标已实现」——只是把「运行结束」换成了「文本非空」。
  
  改动：
  
  - **新增内置工具 `task_deliver`**：四个问题（做成了什么、改了哪些主要内容、怎么验证的、还有哪些没做完）+ 逐条验收条件结论。`verification` 至少一条由 schema 强制。
  - **`delivered` 只由它触发**：Completion Gate 新增条件 6，要求 `TaskRecord.result` 存在，而 `TaskRecord.result` 的唯一生产者是 `applyDelivery`（由交付声明驱动）。这条同时补上了一个平凡漏洞：任务一条 required 验收条件都没有时，条件 1/2/3/5 会全部平凡通过，交付退回到「文本非空即完成」。
  - **删除导出 `projectImplicitCriterion`**，替代品是 `applyDelivery`（纯函数投影，输出验收条件终态 + `TaskResult` + 未覆盖/未知条件 id）。
  - **契约里印出验收条件的 id**（`- [crit_implicit] 用户的目标`），并在结尾明确「结束一轮、说一句『已完成』、把 todo 勾完都不能让任务结束」。不印 id 模型只能猜，猜错那条结论就落不到契约上。
  - **`task.delivered` 事件新增三个必填字段**：`delivery`（四问结构化）、`criteria`（逐条终态）、`evidenceCount`。刻意设为必填——缺失时宁可让帧解析失败，也不要让客户端静默退回一个恒错的默认值。宿主界面上「验收 x/y · 证据 n 条」此前只能拿 `task.started` 那一刻的快照（恒为全 pending）去拼，于是永远显示 0/n，与实际相反。
  - **证据来源的语义变更**：原来「本轮有最终文本」就记一条 `model_observation` 证据，等于把「文本非空」直接变成「有证据」；现在只在任务**一条工具证据都没有**时，用交付声明本身顶上（`ref` 固定为 `task_deliver`，避免重复交付不断新增证据而污染进度指纹）。纯解释 / 写作 / 问答类任务仍能一次交付，只是模型必须先说清「怎么验证的」。
  - `fallbackResult` 变为基本不可达（条件 6 要求 `result` 存在），措辞去掉了完成性描述，改为「这条任务没有留下交付说明（记录到 N 个已完成步骤、M 次工具调用）。」——保留它只为升级前的旧记录与宿主自写 result。

## 0.5.2

### Patch Changes

- Windows 终端后端修复：pty 探测不再硬编码 `/bin/sh -c true`。
  
  该探测在 Windows 上必然失败（没有 /bin/sh），导致 node-pty 加载成功也**永久静默降级 pipe 后端**——打包版在真实 Windows 上从未用过真 PTY，macOS 一直正常所以长期未暴露（CI 原生 Windows 冒烟首次跑到 `backend === "pty"` 断言才现形）。探测命令现跟随 `shellSpecFor` 的跨平台 shell 规格（pwsh/powershell/cmd 优先级与正式会话一致），`exit 0` 在三种 shell 下语义一致；新增纯函数 `probeCommandFor` 供单测钉住回归。
  
  另修复旧库迁移路径的启动崩溃：`DatabaseSync.serialize()` 在 node:sqlite 上不存在（better-sqlite3 专属 API），带旧库的用户首次启动会 TypeError 崩溃；改用 `VACUUM INTO ?`（参数绑定）生成迁移前备份。

## 0.5.1

### Patch Changes

- Windows 终端会话修复：pwsh/powershell 启动参数不再带 `-NoExit`。
  
  该参数会让 PowerShell 执行完命令后继续挂在交互提示符上，进程永不退出，而终端会话状态完全由进程退出事件驱动——结果是 Windows 上每个终端会话都永远停在 `running`，`terminal_read` 拿不到退出码，打包冒烟的 “Terminal did not exit” 断言与跨盘冒烟都会失败。现与 POSIX 的 `sh -c "<command>"` 语义对齐（命令跑完即退出），并把 shell 规格抽成纯函数 `shellSpecFor`，用单测钉住该回归。

## 0.5.0

### Minor Changes

- 会话工作流与消息体验（Lectern 0.5.x 已在用、此前只存在于本地 vendor 包，现坐实为版本）：
  
  - **会话工作流持久化**：`SessionStore.workflow` 提供 `acceptPrompt` / `claimPrompt` / `finishPrompt` / `recoverInterrupted`。请求、用户消息、附件 parts 与首批事件在单个 SQLite 事务内登记；相同 `requestId` 与载荷返回原 receipt，不同载荷返回 409；排队任务 FIFO，未开始的消息不进入当前模型上下文；`revision` 单调递增，rewind 后旧游标请求 409。
  - **消息快照与搜索**：`getMessageSnapshot` 支持 before/after/around 窗口并与状态事件、运行记录同事务返回；`searchMessages` 使用规范化搜索表与稳定游标，**仅索引正文、工具名/摘要、附件名**——推理、工具输入/完整输出、附件 URL 与正文一律不入索引，并遮蔽常见凭据格式。
  - **已读状态**：`getReadState` / `markRead` 持久化已读游标与未读数，绑定 `historyRevision`。
  - **输入附件校验**：新增导出 `validateAttachments`，限制 5 个文件、512KB、UTF-8 文本白名单，拒绝控制字符与路径分隔符，不抓取用户提供的 URL。
  - **事件订阅与租约**：订阅在缺口后保留后续事件并按 seq 去重，取消的订阅立即退出；过期租约回收与「中断运行」标记同事务完成。
  - **Windows 加固**：终端优先 `pwsh.exe` / `powershell.exe`（`cmd.exe` 仅作兜底），PTY/管道与 MCP stdio 子进程在 Windows 上改用进程树终止，避免遗留孤儿进程。
  - **`createFrameworkSession`**：`createSession` 接受 `id` 与 `creationRequestId` / `creationPayloadHash`，用于宿主侧幂等建会话。

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

## 0.17.1

### Patch Changes

- **fs-workspace `list()` 符号链接健壮性（生产事故修复）**：把 home 目录快照当本地项目打开时，快照里的坏符号链接（`agent -> /mnt/...`，目标在本机不存在）让 `readdir` 列得出、`readFile` 打不开，无守卫的遍历直接 ENOENT，`glob`/`grep` 每次调用整体失败。修复后遍历对符号链接先 `stat` 跟随归型（坏链接静默跳过）；目录链接仅当解析后仍在工作区根内才跟随（保证 list 出的路径都能被 `safeJoin`+read 读到）；`realpath` 去重防自环；单条目读取失败不再炸整个列表。回归测试覆盖坏链接/根内链接/越界链接/自环/文件链接与 list↔read 一致性。

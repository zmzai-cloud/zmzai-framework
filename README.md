# @zmzai/agent-framework

zmzai 生态的 coding agent 内核库——sessions、permissions、tools、runner、events（OpenCode 风格事件溯源）。

自 `zmzai-agent/packages/agent-framework` 经 `git subtree split` 抽出为独立仓库，git 历史完整保留。

## 消费方

- **zmzai-agent**（平台应用）：Mongo workspace / skills / memory recall 装配
- **zmzai-harness**（本地工作台）：fs workspace / 多项目 / terminal / checkpoints 装配

两端均以 `link:../zmzai-framework` 消费；开发 framework 时跑 `npx tsc -p tsconfig.build.json --watch`（或 `pnpm run build:watch`，如已配置），两端 dev server 重载即生效。

## 开发

```bash
pnpm install
pnpm run typecheck   # tsc --noEmit
pnpm test            # vitest run
pnpm run build       # tsc -p tsconfig.build.json → dist/
```

## 能力地图

| 模块 | 位置 | 说明 |
|---|---|---|
| 会话与消息 | `src/core/session/` | jsonl / SQLite（node:sqlite）双存储 |
| 事件流 | `src/core/events/` | 事件溯源 + seq 重放（manifest 定义 schema） |
| 工具集 | `src/core/tools/` | read/glob/grep/write/edit/bash/terminal/git/todo/apply_patch/web… |
| 权限引擎 | `src/core/permissions/` | ruleset LAST-match + approvalMode 档位 |
| 压缩 | `src/core/runtime/compaction.ts` | 投影式 compaction（不改历史） |
| 沙箱 | `src/adapters/subprocess-sandbox.ts` | 快照 + 产物回写（本机单用户形态） |
| 模型接入 | `src/adapters/openai-provider.ts` | relay/OpenAI 兼容 + failover + reasoningEffort |

## 版本策略

[changesets](./.changeset/README.md) 管理：feature → minor，fix → patch。合入 main 前跑 `pnpm changeset` 提交变更集；Release workflow 自动汇总版本、开 "Version Packages" PR，合并后自动 build + `npm publish` + 打 tag。

# 变更集（Changesets）

本仓库用 [changesets](https://github.com/changesets/changesets) 管理版本号与 CHANGELOG。

## 贡献者：提变更集

功能/修复合入 `main` 前，在仓库根目录运行：

```bash
pnpm changeset
```

按提示选择 bump 类型（feature → minor，fix → patch），补充一段面向用户的变更描述，提交生成的 `.changeset/<name>.md` 文件随 PR 一起合入。

## 发布：自动

push 到 `main` 后，`.github/workflows/release.yml` 里的 changesets bot 会：

1. 存在待发变更集 → 自动汇总 bump 版本、更新 CHANGELOG.md，开 "Version Packages" PR；
2. 该 PR 被合并 → 自动 `pnpm build` + `npm publish`，并打 `vX.Y.Z` tag。

## 本地手动发布（应急）

```bash
pnpm changeset version   # 消费变更集，bump 版本 + CHANGELOG
pnpm release             # build + publish（需要 npm 凭证）
```

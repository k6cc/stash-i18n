# UPSTREAM.md

汉化插件的**上游关联记账表**。每个插件记录它的上游仓库、上游目录与「已同步到的上游 commit」，作为增量 diff 的基线。

- **同步基线（base）** = 本仓库当前汉化内容所对应的上游 commit。该 commit 之后的改动即为待同步增量。
- 基线只记录 SHA 与日期，**不修改上游任何内容**；上游仓库以只读 remote 形式关联：

```
git remote add upstream https://github.com/sanjiswe/plugins.git
git fetch upstream
```

## 记账表

| 插件 | 上游仓库 | 上游路径 | 上游 License | 已同步 commit | 同步日期 |
|---|---|---|---|---|---|
| oStatsI18n | [sanjiswe/plugins](https://github.com/sanjiswe/plugins) | `plugins/ostats` | AGPL-3.0 | `323af04` | 2026-10-17 |

## 同步流程

1. 拉取上游：`powershell -File scripts/upstream-diff.ps1 -Fetch`
2. 查看某插件的上游增量：`powershell -File scripts/upstream-diff.ps1 -Plugin oStatsI18n`
   - 输出该插件基线的上游提交列表 + diff 全文（含 `git diff` 可读补丁）
3. 按增量把上游改动**手工套用**到汉化版，保留本地 i18n 改动（`tc()` 包裹、中文 displayName 等）
4. 原生新增文件（如 LICENSE）一并放进插件目录，并在插件 `README.md` 注明派生关系
5. 更新本表基线：`powershell -File scripts/upstream-diff.ps1 -Plugin oStatsI18n -Record`
   - 默认取上游 HEAD；也可 `-Base <sha>` 指定
6. 按 `AGENTS.md` 发版流程升版本、commit、打 tag

## 自动化检查

`.github/workflows/upstream-watch.yml` 每周一比对记账基线与上游 HEAD；发现上游有新提交时开/更新 issue（标题 `[upstream] <插件> 有新提交`），提醒按上面流程同步。

## 上游派生说明

本仓库各插件的**版权归上游作者所有**，License 见各插件目录内附的上游 LICENSE 文件；本仓库仅在文案层做本地化（i18n），功能逻辑沿用上游实现。

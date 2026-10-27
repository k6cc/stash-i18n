# UPSTREAM.md

汉化插件的**上游关联记账表**。每个插件记录它的上游仓库、上游目录与「已同步到的上游 commit」，作为增量 diff 的基线。

- **同步基线（base）** = 本仓库当前汉化内容所对应的上游 commit。该 commit 之后的改动即为待同步增量。
- 基线只记录 SHA 与日期，**不修改上游任何内容**；上游仓库以只读 remote 形式关联：

```
git remote add upstream-sanjiswe-plugins https://github.com/sanjiswe/plugins.git
git fetch upstream-sanjiswe-plugins
```

> remote 命名统一为 `upstream-<owner>-<repo>`（`upstream-diff.ps1` 按记账表 URL 自动解析/新增；手工添加时请沿用该命名，否则脚本会按 URL 复用旧名、命名不统一）。

## 记账表

| 插件 | 上游仓库 | 上游路径 | 上游 License | 已同步 commit | 同步日期 |
|---|---|---|---|---|---|
| oStatsI18n | [sanjiswe/plugins](https://github.com/sanjiswe/plugins) | `plugins/ostats` | AGPL-3.0 | `fb5e0e6` | 2026-10-23 |
| LockdownI18n | [allisless0/stash-plugins](https://gitlab.com/allisless0/stash-plugins) | `plugins/Lockdown` | MIT | `8d5b6d1` | 2026-10-23 |
| InsightsI18n | [allisless0/stash-plugins](https://gitlab.com/allisless0/stash-plugins) | `plugins/Insights` | MIT | `8d5b6d1` | 2026-10-23 |
| AscensionI18n | [Servbot91/Sakotos-Stash-Repo](https://github.com/Servbot91/Sakotos-Stash-Repo) | `plugins/Ascension/plugins/Ascension/Release` | GPL-3.0 | `07ef96d` | 2026-10-17 |
| XenithI18n | [gq1869/stashapp-xenith](https://github.com/gq1869/stashapp-xenith) | `.` | GPL-3.0 | `d7d06dc` | 2026-10-18 |
| CollapsablePluginSettingsI18n | [Jacksyy420/Stash-Plugins](https://github.com/Jacksyy420/Stash-Plugins) | `Plugins/collapsible-plugin-settings` | 上游未提供 LICENSE | `8e41d79` | 2026-10-27 |

> 注：CollapsablePluginSettingsI18n 的上游仓库未提供任何 LICENSE 文件（仓库内只有 README、构建脚本与 `Plugins/*`），
> 故本目录不附许可证；上游日后补上时按该许可证随附。

> 注：XenithI18n 的上游是**构建源仓库**（上游 CI 打包发布），基线取整仓库 HEAD（路径填 `.`），
> 产物对应上游 Release 的 `xenith.zip`。路径栏必须只写路径本身，说明文字不要混进表格单元格，
> 否则会被工具当成路径解析。

## 候选（未汉化）

后续打算汉化的插件，先登记来源备查。**尚未纳入上游跟踪**（不在上面的记账表里）；可汉化时按「新增汉化插件」流程处理，并移入记账表。

| 插件 | 上游仓库 | 上游路径 | 安装源 | 状态 |
|---|---|---|---|---|
| Stash Curator | [mrx-31415/stash-curator](https://github.com/mrx-31415/stash-curator) | `plugin` | <https://mrx-31415.github.io/stash-curator/index.yml> | 候选（JS + Python 后端 + `settings:` 段，体量最大） |

> 注：Stash Curator 为构建产物仓库（上游有 CI 打包），同步时取仓库内已发布的产物目录。

## 同步流程

1. 拉取上游：`pwsh -NoProfile -File scripts/upstream-diff.ps1 -Fetch`
2. 查看某插件的上游增量：`pwsh -NoProfile -File scripts/upstream-diff.ps1 -Plugin oStatsI18n`
   - 输出该插件基线的上游提交列表 + diff 全文（含 `git diff` 可读补丁）
3. 按增量把上游改动**手工套用**到汉化版，保留本地 i18n 改动（`tc()` 包裹、中文 displayName 等）
4. 原生新增文件（如 LICENSE）一并放进插件目录，并在插件 `README.md` 注明派生关系
5. 更新本表基线：`pwsh -NoProfile -File scripts/upstream-diff.ps1 -Plugin oStatsI18n -Record`
   - 默认取上游 HEAD；也可 `-Base <sha>` 指定
6. 按 `AGENTS.md` 发版流程升版本、commit、打 tag

## 自动化检查

`.github/workflows/upstream-watch.yml` 每周一比对记账基线与上游 HEAD；发现上游有新提交时开/更新 issue（标题 `[upstream] <插件> 有新提交`），提醒按上面流程同步。

## 上游派生说明

本仓库各插件的**版权归上游作者所有**，License 见各插件目录内附的上游 LICENSE 文件；本仓库仅在文案层做本地化（i18n），功能逻辑沿用上游实现。

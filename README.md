# stash-i18n

Stash 第三方插件汉化集（i18n）——只做**界面文案本地化**，不改动插件功能与数据行为。

> 自用汉化集：不发布 Discourse 论坛帖。功能问题、Bug 与维护反馈请直接找各插件上游作者。

## 包含插件

| 插件 | 版本 | 上游插件 | 说明 |
|------|------|---------|------|
| [oStatsI18n](./oStatsI18n/) | 1.1.0 | [O Stats](https://discourse.stashapp.cc/t/o-stats/4766/7)（sanjiswe） | 统计页 O 统计与观看时长追踪，UI 文案跟随 Stash 界面语言（中文/英文） |
| [LockdownI18n](./LockdownI18n/) | 2.7.0 | [Lockdown](https://gitlab.com/allisless0/stash-plugins)（allisless0） | 把 Stash 锁在演员/工作室/标签上直到脱身的「锁定游戏」，UI 文案跟随 Stash 界面语言（中文/英文） |
| [InsightsI18n](./InsightsI18n/) | 2.10.2 | [Insights](https://gitlab.com/allisless0/stash-plugins)（allisless0） | 统计页数据仪表盘：你/操作/库/文件与画质/元数据健康/收藏（装有 Movies Toolkit 时另有影片），UI 文案跟随 Stash 界面语言（中文/英文） |
| [AscensionI18n](./AscensionI18n/) | 1.4.1 | [Ascension](https://github.com/Servbot91/Sakotos-Stash-Repo)（Servbot91） | 演员与场景的评级/分档系统（对决）：基于 Elo 引擎实时对战评分并给出 S~F 分档，含对决、排位、冠军、场景四种模式，UI 文案跟随 Stash 界面语言（中文/英文） |

## 安装

### 通过插件源安装（推荐）

在 **Stash → 设置 → 插件 → 可用插件 → 添加源** 中添加统一插件源，从列表中选择本仓库插件安装：

```
https://k6cc.github.io/stash-plugins/plugins/main/index.yml
```

### 手动安装

从 [Releases](https://github.com/k6cc/stash-i18n/releases) 下载 `<插件>-vX.Y.Z.zip`，解压到 Stash 插件目录，zip 内文件放入以插件名命名的子目录。

- **Windows**: `%USERPROFILE%\.stash\plugins\`
- **Linux/macOS**: `~/.stash/plugins/`

## 与上游的关系

- 汉化版是上游插件在**文案层**的本地化分支，功能逻辑沿用上游实现；版权归上游作者，各插件目录内附上游 LICENSE
- 上游发布新版本后，本仓库在对应插件目录内按上游变更跟进同步：基线记账见 [UPSTREAM.md](./UPSTREAM.md)，增量查看用 `scripts/upstream-diff.ps1`
- 每周由 `upstream-watch` workflow 自动检测上游新提交并开 issue 提醒同步
- 与上游原版是否可共存，以各插件目录 `README.md` 的说明为准

各插件的详细说明见对应目录下的 `README.md`。

## License

各插件版权归上游作者所有。上游为 AGPL-3.0 等许可证时，许可证全文随对应插件目录一并附上（如 [oStatsI18n/LICENSE](./oStatsI18n/LICENSE)）。

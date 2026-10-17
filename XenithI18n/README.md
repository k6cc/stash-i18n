> v3.2.0：基于 gq1869 的 Xenith 插件（中文名「争锋」）的多语言（中/英）重构版，UI 文案跟随 Stash 界面语言；已同步上游 3.2.0。

# XenithI18n

把 Stash 的演员与场景当作选手两两对战、按 Elo 引擎实时评分并列出排行榜的评级系统（Xenith 的汉化版，中文名「争锋」）。汉化版只改界面文案（含中文文案宽度所需的 CSS 排版微调与列宽加权），功能与数据行为沿用上游。

## 依赖

- Stash 界面语言为中文时显示中文，否则英文（i18n 桥接失败降级英文）
- Python 后端 `backend/main.py`（含 `queries.py` / `tasks.py`）：批量任务（清空对局历史、重置评分、快照导出/导入、旧字段名迁移）由 Stash 调用 Python 执行，共 9 个任务；依赖 `stashapp-tools >= 0.2.59`（见 `requirements.txt`）
- 评分、战绩与账本写入 Stash 的 custom fields，另有 `runPluginOperation` 用于批量上报对局日志

## 安装

复制 `XenithI18n` 文件夹到 Stash 插件目录，重启 Stash。页面出现悬浮入口（争锋按钮），演员/场景卡片上出现排名徽章。

## 核心机制

- 三种模式：对决（Head to Head，1v1 择优选胜）、车轮战（Gauntlet，挑战者逐级落位）、挑战冠军（Champion，冠军连胜守擂）
- 评分与分档：按 Elo 引擎计分，按分数分布划分为 S/A/B/C/D/F 六档，各档占比随库规模自适应
- 匹配逻辑：按分数、近期出场、对战条数、种子与权重加权抽选，可叠加性别筛选与自定义胶囊显示
- 页面：悬浮按钮打开主面板，含对决、排行榜、对局统计、对局日志四个页签；演员/场景详情页与卡片注入排名徽章与悬停提示
- 记录：每次对局写入 custom fields 的战绩与账本，卡片徽章显示胜/负/平与分档
- 快照：可由 Stash 后台任务把全部评分与战绩导出为 JSON（`snapshots/`），或从最近的快照恢复

## 文件说明

| 文件 | 说明 |
|---|---|
| XenithI18n.js | UI 主逻辑与样式（含中英文案，插件 ID 为 `XenithI18n`） |
| XenithI18n.css | 上游样式表 |
| backend/main.py、queries.py、tasks.py | 上游 Python 后端（批量任务与日志上报，任务日志与快照文件名保留英文，本次未汉化） |
| requirements.txt | 后端依赖（`stashapp-tools>=0.2.59`） |
| XenithI18n.yml | 插件定义 |
| LICENSE | 上游 GPL-3.0 许可证（本目录为上游派生） |

## 上游同步

- 本目录是 [gq1869/stashapp-xenith](https://github.com/gq1869/stashapp-xenith)（GPL-3.0，基线 commit `d7d06dc`）在**文案层**的本地化派生，功能逻辑沿用上游实现，版权归上游作者
- 上游是构建源仓库（`src/` + vite），发布产物为 Release 中的 `xenith.zip`（内含 `dist/xenith.js`）；汉化改动落在 `src/`，重新构建得到与上游逐字节一致基线的产物后再叠加中文文案
- 上游发布新版后的同步流程与基线记账见仓库根 [UPSTREAM.md](../UPSTREAM.md) 与 `scripts/upstream-diff.ps1`

## 注意事项

- 与上游原版 Xenith **不建议同时启用**：两者共用同一批 Stash custom fields（`xenith_stats` / `xenith_record`，以及遗留的 `hotornot_stats` / `performer_record`）存评分与战绩，同时写入会互相冲突
- 插件 ID、全局钩子（`window.__XenithI18n*`）、localStorage 键（`XenithI18n:debug`）均以 `XenithI18n` 命名，与上游原版各自独立
- `runPluginOperation` 的 `plugin_id` 由 `xenith` 改为 `XenithI18n`：上游按插件 ID 路由到后端，沿用旧 ID 会打到未安装的上游插件，导致对局日志批量上报失效（属功能性例外）
- CSS 前缀（`hon-` / `xen-`）、DOM 根 id、`data-*` 属性、custom fields 键名属共享数据契约，与上游一致，故从原版切换到汉化版可沿用既有评分与战绩
- `snapshots/` 目录为后端运行时生成的数据产物，导出文件名保留英文

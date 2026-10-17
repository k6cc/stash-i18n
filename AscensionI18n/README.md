> v1.4.2：基于 Servbot91 的 Ascension 插件（中文名「对决」）的多语言（中/英）重构版，UI 文案跟随 Stash 界面语言；已同步上游 1.4.1（1.4.2 起为汉化自身的措辞修订）。

# AscensionI18n

把 Stash 的演员与场景当作选手两两对战、按 Elo 引擎实时评分并分档（S~F）的评级系统（Ascension 的汉化版，中文名「对决」）。汉化版只改界面文案，功能与数据行为沿用上游。

## 依赖

- Stash 界面语言为中文时显示中文，否则英文（i18n 桥接失败降级英文）
- Python 后端 `asc_taskmaster.py`：批量任务（初始评级、重置、擦除战绩、快照导出/导入）由 Stash 调用 Python 执行，共 9 个任务
- 评级、战绩与账本写入 Stash 的 custom fields，无 Suite Data 依赖

## 安装

复制 `AscensionI18n` 文件夹到 Stash 插件目录，重启 Stash。页面出现悬浮入口（对决按钮），演员/场景卡片上出现分档徽章。

## 核心机制

- 四种模式：对决（Head to Head，1v1 择优选胜）、排位（Placement，逐级对战落位）、冠军（Champion，胜者留场）、场景（Scene，按演员对场景评级）
- 评分与分档：胜者加分、败者扣分，累计为「对决评分」；按分数分布划分为 S/A/B/C/D/F 六档，各档占比随库规模自适应
- 匹配逻辑：按分数、近期出场、对战条数、种子与权重做加权抽选，另有选择修正、限额与加成选项
- 记录：每次对战写入 custom fields 的战绩与账本，卡片徽章显示 W/L/D 与分档
- 页面：悬浮按钮打开主面板；演员/场景详情页注入对战入口与分档徽章；`/stats` 统计页注入指标面板
- 快照：可由 Stash 后台任务把全部评级与战绩导出为 JSON，或从最近的快照恢复

## 文件说明

| 文件 | 说明 |
|---|---|
| AscensionI18n.js | UI 主逻辑与样式（含中英文案，插件 ID 为 `AscensionI18n`） |
| AscensionI18n.css | 上游样式表 |
| asc_taskmaster.py | 上游 Python 后端（批量任务，文件名与上游一致，本次未汉化） |
| AscensionI18n.yml | 插件定义 |
| LICENSE | 上游 GPL-3.0 许可证（本目录为上游派生） |

## 上游同步

- 本目录是 [Servbot91/Sakotos-Stash-Repo](https://github.com/Servbot91/Sakotos-Stash-Repo) 的 `plugins/Ascension/plugins/Ascension/Release`（GPL-3.0，基线 commit `07ef96d`）在**文案层**的本地化派生，功能逻辑沿用上游实现，版权归上游作者
- 该上游仓库是 CI 构建产物仓库，同步时取已发布的产物目录（勿用 `Beta-Builds`）
- 上游发布新版后的同步流程与基线记账见仓库根 [UPSTREAM.md](../UPSTREAM.md) 与 `scripts/upstream-diff.ps1`

## 注意事项

- 与上游原版 Ascension **不建议同时启用**：两者共用同一批 Stash custom fields（`hotornot_stats` / `performer_record` / `scene_record`）存评级与战绩，同时写入会互相冲突
- 插件 ID、全局钩子（`window.__AscensionI18n*`）、localStorage 键（`ascensionI18n_*`）、IndexedDB 库名（`ascensionI18n-badge-cache`）均以 `AscensionI18n` 命名，与上游原版各自独立
- custom fields 键名与上游保持一致（属共享数据契约），故从原版切换到汉化版可沿用既有评级与战绩
- 上游版本号随汉化版同步：上游 1.4.1 → 本仓库 1.4.2（补丁号用于汉化自身的措辞修订）

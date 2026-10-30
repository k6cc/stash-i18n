> v0.3.0-1：基于 sanjiswe 的 O Cheevs 插件（成就系统）的多语言（中/英）重构版，UI 文案跟随 Stash 界面语言；已同步上游 0.3。

# OCheevsI18n

为 Stash 添加成就（achievement）系统（O Cheevs 的汉化版）。按首次启用时 Stash 已有的总数起算，追踪观看时长、O 数与观看视频数三类成就，达成时弹出解锁提示，并自带一个独立成就页面与顶栏奖杯入口。汉化版只改界面文案，功能与数据行为沿用上游。

## 依赖

- Stash 界面语言为中文时显示中文，否则英文（i18n 桥接失败降级英文）
- Python（`cheevs_data.py`，由 `saveCheevsData` 任务调用，写入插件目录）

## 安装

复制 `OCheevsI18n` 文件夹到 Stash 插件目录，重启 Stash。顶栏「统计」旁出现奖杯按钮，点击进入成就页面（`/plugins/cheevs`）。

## 核心机制

- 起算基线：成就目标以首次启用时 Stash 的总播放时长 / O 总数 / 播放总数为基线，只统计之后的增量，因此不论此前看过多少都从零开始
- 分类与分档：观看时长（1 分钟 → 1 个月）、O 数（1 → 1,000）、观看视频数（1 → 1,000）三类共 22 项成就；每项分普通 / 精良 / 稀有 / 史诗 / 传说五档，对应 10 / 25 / 50 / 100 / 250 分
- 检查时机：每 30 秒后台检查一次，并在 O、播放、观看进度写入后 1 秒内立即检查；解锁即弹出提示，若成就页面开着则同时重绘
- 进度存盘：经 Stash 任务队列调用 `cheevs_data.py` 合并写入插件目录的 `cheevs_data.json`（临时文件 + 原子替换），页面再从插件 assets 读回；多标签页按 `startedAt` 判定重置、解锁时间取最早值合并
- 旧数据迁移：旧版存放在插件配置 `zz_data` 与 localStorage `ocheevs_state_v1` 的进度，首次加载时搬到 `cheevs_data.json`（两个键名保留原名，仅用于一次性迁移）
- 设置：隐藏顶栏奖杯按钮、隐藏解锁弹窗（键名与上游一致，仅显示名与描述为中文）

## 文件说明

| 文件 | 说明 |
|---|---|
| OCheevsI18n.js | UI 主逻辑（含中英文案，插件 ID 为 `OCheevsI18n`） |
| OCheevsI18n.css | 成就页与解锁弹窗样式（类名前缀 `ch-`，内容与上游一致） |
| OCheevsI18n.yml | 插件定义、设置项与 `saveCheevsData` 任务 |
| cheevs_data.py | Python 后端：合并写入 `cheevs_data.json`（文件名与 `args.cheevs_data` 参数保持上游契约） |
| LICENSE | 上游 AGPL-3.0 许可证（本目录为上游派生） |

## 上游同步

- 本目录是 [sanjiswe/plugins](https://github.com/sanjiswe/plugins) 的 `plugins/ocheevs`（AGPL-3.0，上游根目录许可证文件名 `LICENCE`）在**文案层**的本地化派生，功能逻辑沿用上游实现，版权归上游作者
- 上游发布新版后的同步流程与基线记账见仓库根 [UPSTREAM.md](../UPSTREAM.md) 与 `scripts/upstream-diff.ps1`

## 注意事项

- **不要与上游 O Cheevs 同时启用**：两者都注册 `/plugins/cheevs` 页面路由，会争同一地址
- `cheevs_data.json` 为运行时进度数据（不随仓库发布），删除后从零开始统计
- 插件 ID、`window.__OCheevsI18nLoaded` 守卫、新增的 localStorage / 配置键均以 `OCheevsI18n` / `ocheevsI18n` 命名，与上游原版各自独立

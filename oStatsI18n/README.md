> v2.0.0-3：基于 sanjiswe 的 O Stats 插件的多语言（中/英）重构版，UI 文案跟随 Stash 界面语言；已同步上游 2.0 系列（渲染层重写后的增量：新增 O 日历 / 观看日历热力图，统计行拆分为「今日」与「全部时间与纪录」）；插件任务描述亦已中文化。

# oStatsI18n

统计页 O 统计 + 观看时长追踪插件（O Stats 的多语言重构）。纯 UI + Python 任务：把今日 O 数、连续天数、今日观看时长/视频数等卡片，全部时间与纪录行，O 次数 / 观看时长柱状图与 O 日历 / 观看日历热力图，场景亮点、媒体库分区，以及「当日回顾」时间线注入统计页；观看时长按日记录并跨设备同步。

## 依赖

- Stash 界面语言为中文时 UI 显示中文，否则英文（i18n 桥接失败降级英文）
- Python（`saveWatchData` 任务，保存观看时长）

## 安装

复制 `oStatsI18n` 文件夹到 Stash 插件目录，重启 Stash，进入统计页即生效。

## 核心机制

- 观看时长：页面播放 10 秒采样、2 秒防抖，经 `saveWatchData` 任务写入 `watch_data.json`（简单格式：日期 → 当日总秒数）；跨标签页经 localStorage 合并，页面卸载用 sendBeacon 兜底
- O 统计：按 `o_history` 时间戳构建日期映射，一次遍历供全部卡片/图表复用
- 样式：随插件加载的 `oStatsI18n.css` 预先隐藏 Stash 自带的统计行，页面统计全部由插件绘制（类名前缀 `os-` 与上游一致）
- 插件设置：各区块（今日统计行、全部时间与纪录行、场景亮点、活动图表含两张日历热力图、当日回顾、媒体库）的显示/隐藏、当日回顾时间线与列表的展开、时间线是否显示观看标记等开关，在 Stash 插件设置页配置（键名与上游一致，仅 displayName/描述为中文）
- 导出格式：`{"version":"3.0","data":{"YYYY-MM-DD":{"seconds":N,"o_count":N}}}`（导入兼容 3.0、2.0 的 `"watchTime,oCount"` 与更早的纯数字格式）

## 文件说明

| 文件 | 说明 |
|---|---|
| oStatsI18n.js | UI 主逻辑（含中英文案，插件 ID 为 `oStatsI18n`） |
| oStatsI18n.css | 统计页样式（类名前缀 `os-`，内容与上游一致） |
| oStatsI18n.yml | 插件定义、设置项与任务声明 |
| save_watch_data.py | Python 任务：保存/读取观看数据（load 模式含旧格式迁移） |
| load_watch_data.py | 旧版独立读取脚本（未挂任务，保留兼容） |
| LICENSE | 上游 AGPL-3.0 许可证（本目录为上游派生） |

## 上游同步

- 本目录是 [sanjiswe/plugins](https://github.com/sanjiswe/plugins) 的 `plugins/ostats`（AGPL-3.0）在**文案层**的本地化派生，功能逻辑沿用上游实现，版权归上游作者
- 上游发布新版后的同步流程与基线记账见仓库根 [UPSTREAM.md](../UPSTREAM.md) 与 `scripts/upstream-diff.ps1`
- 上游 2.0 为渲染层重写：新增 `oStatsI18n.css`，把此前注入式的旧统计行改为整页 `#ostats-root` 重绘，并新增「全部时间」「媒体库」分区与两个设置项（`06a_hideAllTimeStats`、`21_showLibraryStats`）；后续增量新增 O 日历 / 观看日历热力图、把统计行拆分为「今日」与「全部时间与纪录」并把导出格式升到 3.0；本汉化版跟随

## 注意事项

- `watch_data.json` 为运行时数据（不随仓库发布），删除后从零开始记录
- 与官方 O Stats 并存时各自独立存储（localStorage 键、数据路径、任务 ID、设置键均以 `oStatsI18n` 命名）
- 中文界面下时间使用 24 小时制，日期使用中文格式；英文界面保持原 12 小时制与 `MM/DD/YYYY`

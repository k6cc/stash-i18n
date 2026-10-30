> v0.6.4-1：基于 allisless0 的 Tasks Toolkit 插件（中文名「任务工具包」）的多语言（中/英）重构版，UI 文案跟随 Stash 界面语言；已同步上游 0.6.4（Autopilot 自动巡检、调度器守护进程、工具包扫描任务、任务查看与历史）。

# TasksToolkitI18n

把 Stash 自己的任务（扫描、生成、识别、自动打标签、备份）和各工具包的只读扫描集中到一处（Tasks Toolkit 的汉化版，中文名「任务工具包」）。汉化版只改界面文案，功能与数据行为沿用上游。

## 依赖

- Stash 0.27 或更新版本
- Stash 服务端需要 Python 3（官方 Docker 镜像自带），用于在 Stash 内运行的例程、针对新增内容的 Auto tag 以及工具包扫描；调度器需要 Linux 上的 Stash（如 Docker），页面本身不依赖它
- 可选：Suite Data（推荐，例程、历史、运行器与限制会存入它的数据区，多标签页/多设备共享）；各工具包（Performers / Scenes / Studios / Tags / Galleries / Movies / Markers / Archive Toolkit）按各自的版本决定哪些扫描可用
- Stash 界面语言为中文时显示中文，否则英文（i18n 桥接失败降级英文）

## 安装

复制 `TasksToolkitI18n` 文件夹到 Stash 插件目录，重启 Stash。顶栏右侧「统计」旁出现「任务」按钮，打开 `/taskstoolkit` 即为插件页面（总览 / 例程 / 运行中三个标签页）。

## 核心机制

- Autopilot 自动巡检：顶栏开关打开后，Stash 会按固定顺序一次一项地跑完媒体库维护（扫描新文件、封面与 phash、识别、自动打标签、工具包扫描、备份、预览、清理与优化），每项到点执行并等待 Stash 队列空出；关闭后正在运行的任务停止、队列里的扫描类任务清空，写入类任务留到完成，重新打开时先把被打断的那项重跑并跳过已完成的部分
- 任务目录与固定顺序安全队列：所有步骤只取安全目录（不清理、不保存工具包的匹配结果、不合并、不删除），「跑一遍安全的」按扫描 → 生成 → 识别 → 自动打标签 → 工具包扫描 → 备份的固定顺序入队；运行器自己持有队列，一次只向 Stash 发送一项
- 限制（守卫）：Stash 队列最多同时 N 项（默认 3）、同一时刻只跑一个重任务、本浏览器有场景播放时暂停例程、可选只在 01:00–08:00 跑重任务；重任务包含扫描、生成、识别、优化
- 定时例程：步骤同样只来自安全目录，可每天 / 每周 / 每月第一个指定星期几运行，也可手动；支持「仅在 Stash 空闲时」「有场景播放时暂停」「失败后停止或继续」；内置推荐的 Nightly / Weekly / Monthly / After adding files 可一键采用
- 调度器守护进程：例程可选「在 Stash 里（自行运行）」，由 Python 后端在 Stash 容器内启动的守护进程到点执行，无需打开浏览器；打开任意 Stash 页面都会请求它运行（已在运行时立即应答），每步之前等待 Stash 队列为空并跟踪到任务结束；错过 6 小时以内的例程会在调度器恢复后补跑，更晚记为错过；Stash 没有插件启动钩子，容器重启后要等第一个打开的 Stash 页面，可用「重启后保持运行（可选）」给的 Unraid User Scripts / cron 脚本每小时敲一次
- 工具包扫描：每个工具包在服务端按自己页面上最后保留的选项规划扫描（Performers 0.18.0、Scenes 0.10.0、Galleries 0.6.0、Studios 0.4.0、Tags 1.7.0、Movies 1.6.0 起），旧版本会跳过并说明要更新；Scenes Toolkit 0.14.0 起还有「查找已更新的场景」
- 任务查看与历史：正在运行的任务含进度、剩余时间与停止；Stash 队列（只能停止，Stash 无法重排）；Tasks 内等待项可上移/下移、暂停、移出、全部暂停；历史保留最近 200 个任务（不论谁启动），可按来源与结果筛选，并显示每个插件耗时
- 安全识别：只用带 phash 且尚未关联 stash-box 的场景，按指纹一对一匹配，只填空字段、只添加已有的演员/工作室/标签，不覆盖、不创建、不动封面与「已整理」；使用自己设置的识别仍由你在 Stash 里启动
- 与 Suite Data 协作：安装并启用 Suite Data 时，例程/历史/运行器/限制写入它的数据区（`routines`、`history`、`runner`、`guards` 四个键），多标签页之间只有一个负责发送；写入基于版本号，两个设备不会重复发送同一步
- 键盘：`1` `2` `3` 切换标签页；例程编辑器里 `Enter` 保存、`Esc` 关闭、`Alt+Up` / `Alt+Down` 移动步骤

## 文件说明

| 文件 | 说明 |
|---|---|
| TasksToolkitI18n.js | UI 主逻辑与运行时注入的样式（含中英文案，插件 ID 为 `TasksToolkitI18n`） |
| TasksToolkitI18n.py | Python 后端（notes 上报、Auto tag 分批、调度器守护进程、Autopilot） |
| TasksToolkitI18n.yml | 插件定义（`Start scheduler` / `Stop scheduler` 两个任务） |
| LICENSE | 上游 MIT 许可证（本目录为上游派生） |

运行时生成的调度器状态与日志位于 `plugin-data/TasksToolkitI18n/_server/`（`scheduler.pid`、`scheduler.log` 等）。

## 上游同步

- 本目录是 [allisless0/stash-plugins](https://gitlab.com/allisless0/stash-plugins) 的 `plugins/TasksToolkit`（MIT）在**文案层**的本地化派生，功能逻辑沿用上游实现，版权归上游作者
- 上游发布新版后的同步流程与基线记账见仓库根 [UPSTREAM.md](../UPSTREAM.md) 与 `scripts/upstream-diff.ps1`
- 上游插件讨论帖：<https://discourse.stashapp.cc/t/tasks-toolkit/19700>

## 注意事项

- 与上游原版 Tasks Toolkit **不要同时启用**：两者注册同一个页面路由 `/taskstoolkit`，并在顶栏同一位置放按钮；并存会出现重复按钮与路由冲突。若要切换，先停用其中一个再启用另一个
- 插件 ID、Python 文件名、`plugin-data/<ID>/_server/` 下的调度器状态与日志、localStorage 键（`TasksToolkitI18nLock` / `…Playing` / `…View` / `…Prefs` / `…Ap`）均以 `TasksToolkitI18n` 命名，与上游原版各自独立，不会互相杀进程
- 版本号采用「上游版本-汉化修订号」：上游 0.6.4 → 本仓库 0.6.4-1

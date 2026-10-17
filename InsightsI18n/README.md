> v2.10.2：基于 allisless0 的 Insights 插件的多语言（中/英）重构版，UI 文案跟随 Stash 界面语言；已同步上游 2.10.0（2.10.1 起为汉化自身的措辞/描述修订）。

# InsightsI18n

Stash 统计页上的数据仪表盘（Insights 的汉化版），挂在 Stash 自带数据下方，共六个标签页：你、操作、库、文件与画质、元数据健康、收藏；装有 Movies Toolkit 时另有影片标签页。汉化版只改界面文案，功能与数据行为沿用上游。

## 依赖

- Stash 界面语言为中文时显示中文，否则英文（i18n 桥接失败降级英文）
- 无 Python 后端、无额外依赖；观看时长与导入标记可选地存入 Suite Data
- 可选联动：Lockdown（你标签页的对局）、Slideshow（图片观看时长）、Movies Toolkit（影片标签页）、Suite Data（数据存储与备份）、Scene/Movies/Performers/Studios/Galleries/Tags Toolkit（操作标签页的「媒体库待办」）

## 安装

复制 `InsightsI18n` 文件夹到 Stash 插件目录，重启 Stash。打开统计页即可看到本插件内容（无需注册独立页面或路由）。

## 核心机制

- 读取与同步：有上次的缓存时先立即呈现，再只读取自上次以来改动过的场景（按 updated_at / last_played_at）、演员与工作室；没有缓存时才完整分页读取整库
- 统计口径：以本地自然日为单位（不沿用 O Stats 的 UTC 解析）；观看时长在播放器中按秒累计，按天写入插件配置，因此各设备一致
- 库待办（操作标签页）：读取每个 toolkit 插件上一次扫描的结果并按可做/需要你/值得知道分组，「全部扫描」依次触发各插件的后台任务（Stash 会排队执行，可关闭浏览器），每个条目可一键执行其自身操作
- 重复文件清理：用 Stash 的 phash 匹配找出完全相同的一组副本，逐组选择保留项；可先合并（把 O 次数、播放记录、标签等转移给保留的场景）再删除其余文件
- 影片标签页：按播放/观看/O 排序、场景编号空缺、每部影片的观看进度与详情缺口、整部影片文件的章节设置；数据来自 Stash 的 Groups 与 Movies Toolkit
- 与 Stash 互通：每个条形、每一天、每一行都可跳转到对应的 Stash 页面或场景筛选器

## 文件说明

| 文件 | 说明 |
|---|---|
| InsightsI18n.js | UI 主逻辑与样式（含中英文案，插件 ID 为 `InsightsI18n`） |
| InsightsI18n.yml | 插件定义 |
| LICENSE | 上游 MIT 许可证（本目录为上游派生） |

## 上游同步

- 本目录是 [allisless0/stash-plugins](https://gitlab.com/allisless0/stash-plugins) 的 `plugins/Insights`（MIT，基线 commit `4befb2a`）在**文案层**的本地化派生，功能逻辑沿用上游实现，版权归上游作者
- 上游发布新版后的同步流程与基线记账见仓库根 [UPSTREAM.md](../UPSTREAM.md) 与 `scripts/upstream-diff.ps1`
- 该上游仓库同时托管多个插件（Lockdown、Slideshow、Suite Data 等），同步时只取 `plugins/Insights`

## 注意事项

- 与上游原版 Insights **不建议同时启用**：两者都会在统计页挂载内容并读取同一批数据
- 插件 ID、localStorage 键（`insightsI18n*`）、IndexedDB 库名（`insightsI18n`）与 Suite Data 中的存储命名均以 `InsightsI18n` 为前缀，与上游原版各自独立
- 上游版本号随汉化版同步：上游 2.10.0 → 本仓库 2.10.2（补丁号用于汉化自身的措辞/描述修订）
- Stash 的 Groups 采用官方中文「合集」；装有 Movies Toolkit 且未开启其 `keepGroupsName` 时，Stash 会把「合集」显示为「影片」，本插件同一处也会跟着显示「影片」

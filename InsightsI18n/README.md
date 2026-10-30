> v2.14.1-1：基于 allisless0 的 Insights 插件的多语言（中/英）重构版，UI 文案跟随 Stash 界面语言；已同步上游 2.14.1。

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
- 「什么对你有效」：按演员与场景特征对比其份额，可按演员性别筛选（媒体库中存在多种性别时才出现筛选按钮，演员特征旁也有同样的筛选）；年龄段自 18 岁起分组，18 岁以下不计入
- 异常时长：超过 6 小时（或 DVD 的 VOB 超过 4 小时，ffprobe 会误读这类文件）的时长不参与「最长」、总计与平均值，并在库标签页注明数量、可一键列出这些场景
- 国家名跟随 Stash 界面语言（设置 → 界面），而不是浏览器的语言
- 库待办（操作标签页）：读取每个 toolkit 插件上一次扫描的结果并按可做/需要你/值得知道分组，「全部扫描」依次触发各插件的后台任务（Stash 会排队执行，可关闭浏览器），每个条目可一键执行其自身操作
- 重复文件清理：用 Stash 的 phash 匹配找出完全相同的一组副本，逐组选择保留项。默认的「最佳（以 1080p 为目标）」按分辨率、画面信息量（码率与编码效率）、时长、帧率、整理状态与 stash-box 关联依次判定，并在每组说明取舍理由；可先合并（把 O 次数、播放记录、评分、标记、标签等转移给保留的场景，合并后自动补齐 Stash 漏掉的标记与次数）再删除其余文件，每次合并记入「合并历史」（装 Suite Data 时存入其中）
- 影片标签页：按播放/观看/O 排序、场景编号空缺、每部影片的观看进度与详情缺口、整部影片文件的章节设置；数据来自 Stash 的 Groups 与 Movies Toolkit
- 与 Stash 互通：每个条形、每一天、每一行都可跳转到对应的 Stash 页面或场景筛选器
- 记忆选择：是否显示过小的分组、演员性别、特征维度、收藏页性别与「女 + 男」搭档等选择存在浏览器中，并同时写入 Insights 自己的数据（插件配置或 Suite Data），换浏览器或本地存储不可用时依然保留
- 跟随主题：颜色取自 Stash 当前主题（装 Flexoki 主题时用 Flexoki 配色，否则从当前主题的背景/卡片/文字推导，浅色主题同样适用），随主题切换自动重算

## 文件说明

| 文件 | 说明 |
|---|---|
| InsightsI18n.js | UI 主逻辑与样式（含中英文案，插件 ID 为 `InsightsI18n`） |
| InsightsI18n.yml | 插件定义 |
| LICENSE | 上游 MIT 许可证（本目录为上游派生） |

## 上游同步

- 本目录是 [allisless0/stash-plugins](https://gitlab.com/allisless0/stash-plugins) 的 `plugins/Insights`（MIT，基线 commit `c660e7d`）在**文案层**的本地化派生，功能逻辑沿用上游实现，版权归上游作者
- 上游发布新版后的同步流程与基线记账见仓库根 [UPSTREAM.md](../UPSTREAM.md) 与 `scripts/upstream-diff.ps1`
- 该上游仓库同时托管多个插件（Lockdown、Slideshow、Suite Data 等），同步时只取 `plugins/Insights`

## 注意事项

- 与上游原版 Insights **不建议同时启用**：两者都会在统计页挂载内容并读取同一批数据
- 插件 ID、localStorage 键（`insightsI18n*`）、IndexedDB 库名（`insightsI18n`）与 Suite Data 中的存储命名均以 `InsightsI18n` 为前缀，与上游原版各自独立
- 版本号为「上游版本-汉化修订号」：上游 2.14.1 → 本仓库 2.14.1-1（修订号用于汉化自身的措辞/描述修订）
- Stash 的 Groups 采用官方中文「合集」；装有 Movies Toolkit 且未开启其 `keepGroupsName` 时，Stash 会把「合集」显示为「影片」，本插件同一处也会跟着显示「影片」

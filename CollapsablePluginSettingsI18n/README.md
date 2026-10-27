> v0.10.7-1：基于 Jacksyy420 的 Collapsable Plugin Settings 的多语言（中/英）重构版，UI 文案跟随 Stash 界面语言；已同步上游 0.10.7，另保留一处修复（工具栏悬浮在全屏弹窗之上）并新增一处窄屏适配（手机端工具栏超出屏幕右缘时自动换行收缩）。

# CollapsablePluginSettingsI18n

把「设置 → 插件」与「设置 → 任务 → 插件任务」里长长的插件列表变得好收拾：插件分组可折叠、可搜索、可排序，并可用滑块代替启用/禁用按钮（Collapsable Plugin Settings 的汉化版）。汉化版只改界面文案，功能逻辑沿用上游。

## 依赖

- Stash 界面语言为中文时显示中文，否则英文（i18n 桥接失败降级英文）
- 无 Python 后端、无额外依赖；折叠状态与排序选择存在浏览器 localStorage

## 安装

复制 `CollapsablePluginSettingsI18n` 文件夹到 Stash 插件目录，在「设置 → 插件」点「重载插件」，再 Ctrl+F5 硬刷新页面。

## 核心机制

- 折叠：点插件分组的标题即可折叠/展开；「插件」页用插件自带的箭头，「插件任务」页操作 Stash 自己的箭头按钮
- 默认状态：设置项取 `collapsed` / `expanded` / `remember`（默认记住上次状态），持久化在浏览器本地
- 搜索：工具栏搜索框按分组全文（名称、描述、设置项）过滤，右侧显示命中数，Esc 清空
- 排序：默认顺序 / 名称（A - Z）/ 名称（Z - A）/ 已启用优先 / 已禁用优先，选择会被记住
- 滑块：开启后「设置 → 插件」页的启用/禁用按钮改成滑块外观（启用金色、禁用红色，两色可分别配置）
- 工具栏右对齐在「插件」或「插件任务」标题的高度上，跟随滚动与上方分区折叠时的位移；标题滚出视野（被顶部导航栏或任务页粘性任务队列遮住）时工具栏自动隐藏；有全屏弹窗打开时自动避让，关闭后恢复；窄屏（手机）下工具栏自动换行收缩，不超出屏幕

## 与上游的差异

1. UI 文案中英双语，跟随 Stash 界面语言
2. **工具栏避让全屏弹窗**：上游 0.10.7 把工具栏 `z-index` 降为 1000，低于 Stash 自带弹窗，但第三方插件的全屏弹窗存在同为 1000 的情况（例如 Ascension 的 `.hon-modal`），此时由 DOM 顺序决定胜负，工具栏后插入因而仍浮在弹窗之上；汉化版在检测到全屏遮罩弹窗时自动隐藏工具栏，弹窗关闭后恢复
3. **窄屏适配**：窄屏（≤768px）下工具栏允许换行、搜索框自动收缩，且定位时按视口宽度钳制左边界，不再超出屏幕右缘

## 文件说明

| 文件 | 说明 |
|---|---|
| CollapsablePluginSettingsI18n.js | 主逻辑与双语文案（插件 ID 为 `CollapsablePluginSettingsI18n`） |
| CollapsablePluginSettingsI18n.css | 样式（沿用上游，另加窄屏媒体查询） |
| CollapsablePluginSettingsI18n.yml | 插件定义与中文设置项 |

## 上游同步

- 本目录是 [Jacksyy420/Stash-Plugins](https://github.com/Jacksyy420/Stash-Plugins) 的 `Plugins/collapsible-plugin-settings` 在**文案层**的本地化派生，功能逻辑沿用上游实现，版权归上游作者
- 上游仓库**未提供 LICENSE 文件**，故本目录不附许可证；上游日后补上许可证时按该许可证随附
- 同步流程与基线记账见仓库根 [UPSTREAM.md](../UPSTREAM.md) 与 `scripts/upstream-diff.ps1`

## 注意事项

- 与上游原版**不可同时启用**：两者都会往同一批 DOM 上写 `data-csp-*` 并各自插入一条工具栏，互相干扰
- 插件 ID 与 localStorage 键（`cspI18n_collapsedGroups` / `cspI18n_sortMode`）以本汉化版命名与前缀区分；CSS 类前缀、`data-*` 属性沿用上游，便于上游同步

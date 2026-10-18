> v0.10.1-2：基于 Jacksyy420 的 Collapsable Plugin Settings 的多语言（中/英）重构版，UI 文案跟随 Stash 界面语言；已同步上游 0.10.1。

# CollapsablePluginSettingsI18n

把「设置 → 插件」与「设置 → 任务 → 插件任务」里长长的插件列表变得好收拾：插件分组可折叠、可搜索、可排序，并可用滑块代替启用/禁用按钮（Collapsable Plugin Settings 的汉化版）。汉化版只改界面文案，功能逻辑沿用上游，另附带一处针对第三方插件违规 fetch 包装层的防御性加固。

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
- 工具栏右对齐在「插件」或「插件任务」标题的高度上，并跟随上方分区折叠时的位移

## 与上游的差异

1. UI 文案中英双语，跟随 Stash 界面语言
2. **防御性加固（规避第三方插件的违规包装层）**：读取插件设置时改用字符串 URL（`.href`），不再把 `URL` 对象传给 `fetch`。上游原写法**符合 WHATWG Fetch 规范**（首参合法类型为 `string | URL | Request`），本身没有问题；真正违规的是部分插件的 `window.fetch` 包装层——例如 Shinobi-Api 假定首参是字符串并直接 `url.includes(...)`，遇到 `URL` 对象就抛 `TypeError`，被上游的 `catch` 静默吞掉，导致设置读取失败、开关打开后毫无反应。改成字符串对包与不包的 `fetch` 都成立，行为完全等价
3. 补齐中文界面下的文本匹配：「插件任务」小节与「插件」标题（上游只认英文/德文；中文界面下前者整块不生效，后者退化为兜底位置）

## 文件说明

| 文件 | 说明 |
|---|---|
| CollapsablePluginSettingsI18n.js | 主逻辑与双语文案（插件 ID 为 `CollapsablePluginSettingsI18n`） |
| CollapsablePluginSettingsI18n.css | 样式（沿用上游，未改动） |
| CollapsablePluginSettingsI18n.yml | 插件定义与中文设置项 |

## 上游同步

- 本目录是 [Jacksyy420/Stash-Plugins](https://github.com/Jacksyy420/Stash-Plugins) 的 `Plugins/collapsible-plugin-settings` 在**文案层**的本地化派生，功能逻辑沿用上游实现，版权归上游作者
- 上游仓库**未提供 LICENSE 文件**，故本目录不附许可证；上游日后补上许可证时按该许可证随附
- 同步流程与基线记账见仓库根 [UPSTREAM.md](../UPSTREAM.md) 与 `scripts/upstream-diff.ps1`

## 注意事项

- 与上游原版**不可同时启用**：两者都会往同一批 DOM 上写 `data-csp-*` 并各自插入一条工具栏，互相干扰
- 插件 ID 与 localStorage 键（`cspI18n_collapsedGroups` / `cspI18n_sortMode`）以本汉化版命名与前缀区分；CSS 类前缀、`data-*` 属性沿用上游，便于上游同步

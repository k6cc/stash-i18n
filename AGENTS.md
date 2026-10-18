# AGENTS.md

本仓库是 Stash 第三方插件的**汉化集**（monorepo）：只做界面文案本地化（i18n），不改动插件功能与数据行为。每个子目录即一个插件，目录名 = 插件 ID。插件版本以各 `<name>.yml` 的 `version:` 为权威，Stash 实际读取该字段。

定位约束：

- 不发布 Discourse 论坛帖；yml 的 `url:` 指向上游插件帖子（维护与反馈归上游作者）
- 上游发布新版后按上游变更同步，不自行加功能

## 汉化实现约定（动手前先读这节）

完整流程见 [scripts/i18n-playbook.md](./scripts/i18n-playbook.md)。以下是**违反了会出静默故障**的硬约定：

- **脚手架**：全文内联 `tc(中文, 英文)`，**中文为第一参数**（渲染期取值）；含 `${}` 的整条模板整体包裹成 `` tc(`中文 ${x}`, `English ${x}`) ``。locale 桥接失败必须降级英文，绝不能出现空白文案。
- **身份隔离**：必须改 → 插件 ID、`window.__*Loaded` 全局守卫、localStorage / IndexedDB 库名、CustomEvent 名、调试与测试钩子。必须保留 → CSS 类前缀与 `<style>` id、DOM 根 id 与选择器、`data-*` 属性、Suite Data 共享契约、GraphQL `plugin_id`——改了会与上游原版冲突，或读不到 / 写不进既有数据。
  - **唯一例外**：上游用自身 ID 调 `runPluginOperation` 时（如 `XenithI18n` 的 `stash-log.js`），`plugin_id` 必须换成汉化版 ID，否则请求会打到未安装的上游插件上，批量日志上报静默失效。
- **模块级 `const` 表会被冻结**：模块加载时 `_intlLocale` 还是空串，表里所有 `tc()` 会定格成英文。处理方式：保留英文原表 + 另建 `*_ZH` 并列表，或给条目加 `labelZh`、或把表改成函数，在渲染期才取值。
- **时序**：静态 DOM 的构建早于 locale 就绪。导航入口、面板外壳这类一次性写入的文案，必须在「locale 到达」与「面板注入弹窗」两个时机各刷新一次，否则反复开关弹窗会变回英文。
- **中文宽度**：全角字约占 2ch。用 `label.length` 估列宽的表格（`table-layout: fixed` 下）必须改用 `displayWidth()` 加权。封面徽章**不要无条件改尺寸**：只有该插件的封面徽章会折行时才收紧（Ascension 用 `max-width: 80%` 限宽 + 折行，中文「N胜 N负 N平」比 `W/L/D` 宽会撑成两行），且只动封面缩略图、不动详情页大徽章；若上游封面档本身 `white-space: nowrap`（如 Xenith 的 `.xen-battle-rank-badge-compact`）就不折行，保持上游尺寸即可——小幅缩字号（如 0.72→0.68rem）既防不住横向溢出，又白白扩大与上游的差异（Xenith v3.2.1 已因此回退）。
- **扫描器有盲区**：`check_i18n.py` 看不见写死在 JSX 结构里的裸文本节点（`<span>History</span>`、`of {total}`、`{kind}`）、CSS `content:`、HTML 字符串、以 `` `${name}: `` 开头的模板字面量、部分 `throw new Error()`。发版前必须人工扫一遍全部 `.jsx`（`>[A-Za-z]…` 与行首裸文本两条正则）。

### 不译清单

JS 标识符、GraphQL 字段与枚举值、filter type、CSS 与 `<style>` 内容、SVG path、`e.key`、插件 ID 与插件名、品牌词（Stash）、console 日志、单字母 `O`、编码名与容器名、分辨率 / 帧率字面量、Stash 中已存在的标签名与数据值、写入 Suite Data 的 `note` 归因串（但 `tell()` / `notify()` 提示语要译）。

插件名不译的例外：中文侧可另起中文名，英文侧保留原名——Ascension →「对决」、Xenith →「争锋」、Lockdown →「锁局」。
Stash 的 Groups 用官方中文「合集」；国家名复用 Stash 现有翻译键，不单独翻译。

## 发版

### 版本号规则

**版本号 = `上游版本-汉化修订号`**（如 `1.4.1-1`）：汉化版永不抬高上游版本号，一眼看出「对应上游哪个版本 + 第几次汉化修订」。

- **上游版本**：本汉化版当前对应的上游发布版本（以 [UPSTREAM.md](./UPSTREAM.md) 基线为准）
- **汉化修订号**：从 `1` 起，只动汉化自身（措辞、排版、漏译修复、CSS 微调）时 +1；同步到上游新版本时**重置为 1**
- 例：上游 1.4.1 → 首发 `1.4.1-1` → 汉化微调 `1.4.1-2` → 上游发 1.4.2 → `1.4.2-1`
- 后缀只用 `-`，**不要用 `+`**（`+` 在 release 产物名与下载 URL 里易被转义）；修订号不补零（`-1` 而非 `-01`）
- Stash 判定「有更新」看的是 `index.yml` 的 `date`（`PackageManager.tsx` 的 `hasUpgrade`），`version` 只用于展示，故带后缀不影响安装与更新提示
- 历史版本不追溯改名：本规则生效前已发布的纯 `X.Y.Z` 保持不动，下次发版时切入本规则（如 AscensionI18n 1.4.4 对应上游 1.4.1，下次发版即 `1.4.1-4`）

**权威版本号 = 各插件 `<name>.yml` 的 `version:`**，其余位置必须与之一致：

- 根 `README.md` 插手表（含版本列）
- 各插件 `README.md` 头部 `> v<版本号>：` note（只保留最新一条）
- 代码内版本位置：

| 插件 | 代码内版本位置 |
|---|---|
| oStatsI18n | `oStatsI18n.js` 顶部 `PLUGIN_VERSION` |
| LockdownI18n | `LockdownI18n.js` 顶部 `PLUGIN_VERSION` |
| InsightsI18n | `InsightsI18n.js` 顶部 `PLUGIN_VERSION` |
| AscensionI18n | `AscensionI18n.js` 顶部 `PLUGIN_VERSION` |
| CollapsablePluginSettingsI18n | `CollapsablePluginSettingsI18n.js` 顶部 `PLUGIN_VERSION` |
| XenithI18n | 版本在 `src/i18n.js` 的 `PLUGIN_VERSION`（**`package.json` 的 `version` 不参与打包，改它无效**）；压缩后常量被改名，bundle 首行形如 `` var e=`3.2.1` `` 的模板字面量——搜 `X.Y.Z` 字面量核对 |

### 流程

1. 更新上表所有位置
2. 校验：`git grep -nE "[0-9]\.[0-9]+\.[0-9]+"` 逐项核对（压缩 bundle 的插件改用 Grep 工具在磁盘上搜字面量——未跟踪的新文件不在 `git grep` 范围内）
3. commit 风格：`fix(插件名): 描述, vX.Y.Z` / `feat(插件名): ...` / `docs(插件名): ...` / `chore: ...`
4. tag 命名：`<插件ID>-v<版本号>`（如 `AscensionI18n-v1.4.1-1`，白名单 `*-v*.*.*` 已兼容该后缀）；多插件联动发版时每个插件各打一个 tag
5. `git push; git push --tags`（分号分隔，勿用 `&&`）
6. 验证：`gh run list --limit 1` 找 Release workflow → `gh run watch <id> --exit-status`；`gh release view <tag> --json assets` 确认 zip 产物；最后回 `E:\Temp\stash-plugins` 执行 `git fetch; git show origin/main:plugins/main/index.yml` 确认该条目 `version`/`sha256`/`path` 已更新
- Windows：命令链用 `;`，勿用 `&&`；含中文的 commit message 建议写进临时文件后 `git commit -F <文件>`（commit 完删掉临时文件）；受限沙箱下 `git push` 可能因 schannel TLS 握手失败被拦，需在沙箱外执行
- 插件 ID 内不要出现 `-v`（如 `xxx-v2`）：release workflow 用 `${TAG%%-v*}` 解析插件名，会被截断
- **`release.yml` 打包必须用 `zip -r "...zip" *`，`-r` 不能省。** 插件目录含子目录时（如 `XenithI18n/backend/` 的 Python 后端），不带 `-r` 只会写入目录条目、丢掉里面的文件，插件装上是坏的（v3.2.0 曾因此发过一版坏包，后端任务全废）。`*` 不匹配点开头文件，正好排除 `.git`。
- 含子目录的插件发版后，务必 `gh release download <tag>` 解包，确认子目录里的文件真的在包里再收工。

## 新增汉化插件

1. 新建子目录 `<插件ID>/`，目录名 = 插件 ID，放入 `<插件ID>.js` / `<插件ID>.yml` / `README.md` 等
2. 在 `E:\Temp\stash-plugins`（远程 `k6cc/stash-plugins`）加**占位条目并推送**：`version: 0.0.0`、`sha256:` 全 0（**必须加引号**：全 0 不加引号会被 YAML 解析成整数 `0`，校验闸判为字段缺失）、`path:` 按 `https://github.com/k6cc/stash-i18n/releases/download/<插件ID>-v0.0.0/<插件ID>-v0.0.0.zip` 约定、`date:` 当前时间；`README.md` 插手表与依赖清单**手动加行**（`sync_readme.py` 只更新已有行）
   - 占位符不在远程时，release workflow 的 awk 找不到 `- id:` 会静默跳过，链接推不上
   - `description:` 等文本里含 ASCII 冒号+空格（`xxx: yyy`）时必须加引号，否则 YAML 非法、Stash 读不出整个插件源（报 `yaml: line N: mapping values are not allowed in this context`）；推送前先在 `stash-plugins` 仓库本地跑 `python scripts/validate_index.py plugins/main/index.yml` 自检（该脚本属 `stash-plugins`，不在本仓库），推送后 stash-plugins 的 `validate-index.yml` 会再校验一次，release workflow 推送前也有同款校验闸
3. `release.yml` 无需改动（tag 白名单为通用模式 `*-v*.*.*`）
4. 同步更新根 `README.md` 插手表与「上游插件」链接
5. 在根 `UPSTREAM.md` 记账表加一行（上游仓库 / 上游路径 / License / 基线 commit / 同步日期），并在插件目录内附上游 LICENSE、在插件 `README.md` 注明派生关系（见下节）
6. **先判断上游形态**：若上游是「构建源仓库」（`src/` + vite，如 Xenith）而不是发产物包的仓库，流程不同，见 [scripts/i18n-playbook.md](./scripts/i18n-playbook.md) 第 10 节。要点：
   - 仓库**只放构建产物 bundle**（`<插件ID>.js` = 上游 `dist/<name>.js`），**不放 `src/`**
   - 汉化方式是改 `src/` 再 `npm run build`
   - `src/` 的全部改动沉淀成 `scripts/<插件>.patch`（**不随插件 zip 发布**），可干净 clone 上游后 `git apply` 复现，所以临时工作目录用完即删
   - 校验改扫 `src/`：`python scripts/scan_src_i18n.py <上游目录>/src`——压缩产物里 `tc` 被改名、全压成一行，`check_i18n.py` 对它失效
   - **patch 必须保持 LF**：本仓库 `core.autocrlf=true`，靠 `.gitattributes` 的 `*.patch text eol=lf` 锁定；否则 fresh clone 检出成 CRLF，`git apply` 上下文不匹配，复现链路断裂

## 上游跟踪与同步

每个汉化插件都对应一个上游仓库，同步基线（「汉化版当前对应上游哪个 commit」）记在根 [UPSTREAM.md](./UPSTREAM.md)，**必须放在插件目录之外**（`release.yml` 用 `zip -r "*"` 打包插件目录，目录内任何文件都会进发布包）。

工具（都在本仓库 `scripts/`，属可复用工具，不随插件发布）：

| 脚本 | 用途 |
|---|---|
| `upstream-diff.ps1` | 拉取上游 + 查看指定插件的上游增量 + 推进基线 |
| `upstream_watch.py` | 检测各插件上游是否有新提交（供 workflow 与本地使用） |
| `check_i18n.py` | 复核漏译：剔除 `tc()` 包装与日志调用后，列出仍像界面文案的英文候选 |
| `scan_src_i18n.py` | 扫「构建源仓库」上游的 `src/`（用法见上节第 6 条） |
| `i18n-playbook.md` | 汉化手册：目录结构、脚手架、冻结表、校验清单、构建源仓库上游流程 |
| `<插件>.patch` | 各「构建源仓库」上游的汉化 patch，如 `xenith-i18n.patch` |

> **Windows 上必须用 `pwsh -NoProfile -File <脚本>` 运行本仓库的 `.ps1`**：`.ps1` 是无 BOM 的 UTF-8，Windows PowerShell 5.1 会按 ANSI 解码，脚本里的中文注释直接引发 `ParserError`（`Unexpected token`）；`pwsh`（PowerShell 7）默认按 UTF-8 读取，正常。

同步流程：

1. `pwsh -NoProfile -File scripts/upstream-diff.ps1 -Fetch` 拉取上游（按记账表里的仓库地址自动解析/新增 remote）
2. `pwsh -NoProfile -File scripts/upstream-diff.ps1 -Plugin <插件ID>` 看该插件自基线以来的上游提交与完整 diff
3. 套用上游改动：以「上游基线版本 = base、本地汉化版 = ours、上游新版 = theirs」做三方合并（`git merge-file`）最省事，冲突处保留本地 `tc()` 包裹与中文文案；上游原生新增的用户可见文案需补 `tc(zh, en)`，合并后用 `python scripts/check_i18n.py <插件ID>` 复核有无漏译
4. 上游新增/变更的 yml 段（如 `settings:`）照抄，`displayName` / `description` 走中文；上游删除的功能（如某开关）跟随删除，不自行保留
5. 插件目录内附上游 LICENSE，插件 `README.md` 注明派生关系
6. `pwsh -NoProfile -File scripts/upstream-diff.ps1 -Plugin <插件ID> -Record` 把基线推进到上游 HEAD
7. 按上节「发版」流程升版本（汉化同步属 `feat`/`fix`）：上游版本段换成同步到的上游版本，汉化修订号重置为 1（如上游 1.4.2 → `1.4.2-1`）

对「构建源仓库」上游（第 6 条那样），同步是重新 `git apply` patch → 处理冲突 → `npm run build` → 重新导出 patch，而不是三方合并产物 bundle。

`.github/workflows/upstream-watch.yml` 每周一检测一次，有新版则开/更新 label 为 `upstream-watch` 的 issue，全部同步后自动关闭。

# 第三方插件汉化手册（可复用）

汉化一个新上游插件时照此执行；权威流程见 [AGENTS.md](../AGENTS.md)、基线记账见 [UPSTREAM.md](../UPSTREAM.md)。
可从 `oStatsI18n`、`LockdownI18n`、`InsightsI18n` 三个已完成实现照抄写法。

## 1. 目录与文件

目录名 = 插件 ID（如 `InsightsI18n`），内含 `<插件ID>.js`、`<插件ID>.yml`、`README.md`、上游 `LICENSE`。
`README.md` 头部写 `> v<版本>：…已同步上游 <上游版本>。`，正文只讲主要模块与机制（不写按钮/交互细节），
并说明依赖、安装、与上游原版能否共存、上游同步方式。

## 2. i18n 脚手架

文件顶部加：

```js
var PLUGIN_VERSION = 'X.Y.Z-1';   // 上游版本-汉化修订号
var _intlLocale = '';
function tc(zh, en) { return _intlLocale.indexOf('zh') === 0 ? zh : en; }
function isZh() { return _intlLocale.indexOf('zh') === 0; }
function initIntlBridge() { /* api.patch.before('App') + api.libraries.Intl.useIntl()，失败 console.warn 降级英文 */ }
```

- 全文统一内联 `tc(中文, 英文)`，**中文为第一参数**
- 含 `${}` 的整条模板整体包裹：`` tc(`中文 ${x}`, `English ${x}`) ``
- 桥接失败必须降级英文（不能出现空白文案）

## 3. 身份隔离（与上游原版互不冲突）

要改：插件 ID、`window.__*Loaded` 全局守卫、localStorage / IndexedDB 库名、CustomEvent 名、调试与测试钩子。
按先例**保留**：CSS 类前缀与 `<style>` id、DOM 根 id 与选择器、`data-*` 属性、Suite Data 共享契约与 GraphQL `plugin_id`。

## 4. 不译清单

JS 标识符、GraphQL 字段与枚举值、filter type、CSS 与 `<style>` 内容、SVG path、`e.key`、角色/分组函数名、
插件 ID 与插件名（Movies Toolkit、Suite Data、Quick Tools 等）、品牌词（Stash）、console 日志、
单字母 `O` 与 `O's`、编码名与容器名、分辨率/帧率字面量、Stash 中已存在的标签名与数据值、
写入 Suite Data 的 `note` 归因串（但 `tell()`/`notify()` 提示语要译）。

专有名词口径：Stash 的 Groups 用官方中文「合集」；上游若按 `moviesName` 之类的开关跟随上游改名的，同一处也跟着改。

## 5. 模块级冻结表（最容易出错）

模块级 `const` 表在加载时求值，此时 `_intlLocale` 为空 → 表里的 `tc()` 会被**冻结成英文**。处理方式：

1. 首选：保留英文原表 + 另建 `*_ZH` 并列表（键与值一一对应），显示点取 `isZh() ? ZH[k] : 英文`
2. 或用惰性：把表改成函数 / 给条目加 `labelZh` 字段，在渲染期取
3. 若是渲染期才调用的函数（分组/分桶函数），返回值直接包 `tc()` 即可

同类改造（照 LockdownI18n 先例）：`plural(n,w,ws)` 配 `UNIT_ZH` 量词表；`os(n)` → `N 次 O`；
`WORDS` 改 `WORDS_ZH` + `wordsOf`；`TABS` 加 `tabLabel`；traits 表加 `labelZh` + `traitLabel`。

## 6. 映射脚本工作法

每译一块写一个「映射表 Python 脚本」：数组 `(old, new, 期望次数)`，逐条 `src.count(old)` 校验，
次数不符即打印 `FAIL` 并**中止不写盘**；全部通过才写文件并打印 `WRITTEN`。
先跑 `node --check`，再抽样复核。脚本放临时目录、用完即删，不留在仓库里。

## 7. 分块交付形式

每块译完：`node --check <插件ID>.js` → 给该块约 10 条中/英对照抽样 → 说明该块按规则不译的字符串。

## 8. 校验清单

1. `node --check <插件ID>.js`
2. `python scripts/check_i18n.py <插件ID>` → 逐条复核补漏，残留英文须能归入「英文源表 / 插件名 / GraphQL 类型 / 数据值 / 日志 / 归因串」之一；
   候选多时用 `--group` 按 bundle 模块聚类来切分区块，用 `--keep <行区间>`（如 `44-85,900-1230`）核对是否还有区间外的新增漏译
3. 版本四处一致（号形如 `上游版本-汉化修订号`，见 AGENTS.md）：JS `PLUGIN_VERSION`、yml `version`、根 README 插手表、插件 README 头部
4. yml 的 `description` 与各 `settings` 的 `displayName`/`description` 全中文

### 扫描器捞不到、必须人工扫的

- 写死在 JSX 结构里的英文文本节点（`<span>History</span>`、`of {total}` 这类裸文本，不经字符串）
- 以 `` `${name}: `` 之类插值开头的模板字面量（`tell`/`notify` 提示语）
- 部分 `throw new Error(...)` 文案（会显示给用户的才译）
- HTML 结构里写死的英文、CSS `content:` 里的英文

JSX 文本节点可用两条正则扫全部 `.jsx` 兜底：`>[A-Za-z][A-Za-z0-9 ,.'()/&%#!?:_-]{2,}` 与行首裸文本
（如 `History {x ? "▴" : "▾"}` 的 `History`）。

## 9. 发布

按 [AGENTS.md](../AGENTS.md) 的两节流程：先在 `stash-plugins` 推送占位条目（否则 release workflow 的 awk 找不到 `- id:` 会静默跳过），
再 commit → push → tag `<插件ID>-v<版本号>` → push tag → `gh run watch` → 核对 release 产物与 `stash-plugins` 的 `index.yml`/`README`；
最后把该插件从 `UPSTREAM.md` 的候选表移入记账表。

Windows：PowerShell 用 `;` 分隔命令（不用 `&&`）；含中文的 commit message 用 `git commit -F <文件>`；`git push`/`gh` 需在非沙箱下执行。

## 10. 构建源仓库上游（`src/` + vite，如 Xenith）

上游若提供构建源仓库（`src/` + vite，如 `gq1869/stashapp-xenith`），汉化方式是**改 `src/` 再 `npm run build`**，
仓库只放产物 bundle（`<插件ID>.js` = 上游 `dist/<name>.js`），**不放 `src/`**：

1. `git clone` 上游到临时目录，检出记账版本（见 UPSTREAM.md）
2. 照第 2–6 节改 `src/`（脚手架、冻结表、映射脚本）
3. `npm run build`（需先 `npm i`/复制 `node_modules`），产物覆盖到 `<插件ID>/`
4. 校验改扫 `src/` 而非压缩产物：`python scripts/scan_src_i18n.py <临时目录>/src`（压缩产物里 `tc` 被改名、全压成一行，`check_i18n.py` 会失效）
5. 把 `src/` 改动导出为 patch 沉进仓库：`scripts/<插件>.patch`
   （`git add -N <新增文件>` → `git diff --output=<patch> -- src`，不随插件 zip 发布）
6. 复现校验：干净 clone 上游 → `git apply <patch>` → 与工作区 `src` 逐文件 sha256 对比 → `npm run build` → 产物 sha256 与已发布一致

已验证：Xenith 的 `scripts/xenith-i18n.patch` 从上游 `d7d06dc` 干净 clone 直接 `git apply` 后构建，
所得 `xenith.js`/`xenith.css` 与已发布产物逐字节一致（sha256 相同）。

## 11. 大版本跳跃同步（三方合并 + 分区并行翻译）

判据：`upstream-diff.ps1 -Plugin <插件ID>` 的 diffstat 超过约 1000 行，或上游做了界面重设计
（例：LockdownI18n 2.11.0 → 2.20.0，`+4054/−373`，6820 → 10178 行）。此时不要「拿上游新版从头译」，
用三方合并把本地译文保留下来。

### 11.1 三方合并

```powershell
pwsh -NoProfile -File scripts\upstream-diff.ps1 -Fetch
python scripts\sync-threeway.py <插件ID> --theirs <上游HEAD sha>
```

产物在 `%TEMP%\stash-i18n-sync\<插件ID>\`：`base.js`/`theirs.js`/`ours.js`/`merged.js`/
`merged_conflicted.js`/`conflicts.txt`。共同祖先默认取 UPSTREAM.md 记账基线。

- 冲突**默认整段取上游（theirs）**：保留新功能结构，冲突区随后补译文
- 非冲突区会自动保留本地的 `tc()` 与函数式表——这是三方合并相对「重译」的唯一价值，别放弃
- 需要对照时看 `merged_conflicted.js`；`--markers` 可保留冲突标记不自动取 theirs

### 11.2 冻结表改造

把模块级 `const X = [...]` 改成 `const x = () => ([...])`，调用点全部改为 `x()`。两个必踩的坑：

1. 全局 token 替换会改坏**对象键**和**定义行**（`const goalInfo() = {`、导出对象里的 `CONDITIONS` 作键）→ 替换后立刻 `node --check`，再逐处核对定义行与导出对象
2. 冲突取 theirs 后 `tc(` 常只剩一个参数（中文侧整段被上游替换）→ 手动补中文参数并配平括号

### 11.3 分区并行翻译

```powershell
python scripts\sync-regions.py split <工作目录>\merged.js --outdir <工作目录> --max-lines 1500
```

按 `// ═══ …`、`// ── …` 段头把文件切成约 1500 行一段，每段一份**完整副本**（`m_A.js`…）+ `manifest.json`。
把每个副本交给一个子代理，只改自己副本的区段——越界编辑在回拼时会被忽略，天然免疫。

- 子代理提示词要写明：起止**段头注释原文**、只改两个段头之间、`node --check` 自查、术语表、不译清单
- 代理并发上限 5；区段过大再对半拆（改 `--max-lines` 重切最省事，别手工改 manifest）

### 11.4 回拼与自检

```powershell
python scripts\sync-regions.py splice --dir <工作目录>
python scripts\sync-verify.py <插件ID>
python scripts\sync-verify.py <插件ID> --js <工作目录>\merged.js   # 落盘前先校验产物
```

回拼按**段头锚点**定位（不用行号，行号必然漂移）。段头行本身绝不可编辑，否则脚本中止且不写盘——这是有意的保护。
`sync-verify.py` 一次跑完：`node --check`、版本四处一致、身份隔离（原版 ID/守卫残留）、`check_i18n` 残留统计。

### 11.5 人工扫的坑（实战记录）

- `plural()` 的中文量词表 `UNIT_ZH` 要补新单位（`card`、`performer` …），否则中文界面漏出 `2 card`、`前 8 performer 位`
- 中文侧模板里直接写英文 chip 名（`Neglected`/`Backlog`）→ 换成译名
- 引擎侧键名（`Spacebar`、`Configuration`）与 `DIFF_LABEL`/`LB_GOALS`/`REC_CHIPS` 这类「英中对照表」的另一半属**有意保留**，逐条写进汇报
- 测完浏览器用「页面文本扫描」代替逐页肉眼：遍历文本节点，挑出**含拉丁字母且无中日韩字符**的串（顺手把 `title`/`aria-label`/`placeholder` 一起扫）
- 临时工作目录（三方合并产物、区段副本、映射脚本）用完即删，不进仓库

收尾照第 9 节发版；`UPSTREAM.md` 基线用 `-Record` 推进。

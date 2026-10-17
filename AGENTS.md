# AGENTS.md

本仓库是 Stash 第三方插件的**汉化集**（monorepo）：只做界面文案本地化（i18n），不改动插件功能与数据行为。每个子目录即一个插件，目录名 = 插件 ID。插件版本以各 `<name>.yml` 的 `version:` 为权威，Stash 实际读取该字段。

定位约束：

- 不发布 Discourse 论坛帖；yml 的 `url:` 指向上游插件帖子（维护与反馈归上游作者）
- 上游发布新版后按上游变更同步，不自行加功能

## 发版

**权威版本号 = 各插件 `<name>.yml` 的 `version:`**，其余位置必须与之一致：

- 根 `README.md` 插手表（含版本列）
- 各插件 `README.md` 头部 `> vX.Y.Z：` note（只保留最新一条）
- 代码内版本位置：

| 插件 | 代码内版本位置 |
|---|---|
| oStatsI18n | `oStatsI18n.js` 顶部 `PLUGIN_VERSION` |

### 流程

1. 更新上表所有位置
2. 校验：`git grep -nE "[0-9]\.[0-9]+\.[0-9]+"` 逐项核对
3. commit 风格：`fix(插件名): 描述, vX.Y.Z` / `feat(插件名): ...` / `docs(插件名): ...` / `chore: ...`
4. tag 命名：`<插件ID>-vX.Y.Z`；多插件联动发版时每个插件各打一个 tag
5. `git push; git push --tags`（分号分隔，勿用 `&&`）
6. 验证：`gh run list --limit 1` 找 Release workflow → `gh run watch <id> --exit-status`；`gh release view <tag> --json assets` 确认 zip 产物；最后回 `E:\Temp\stash-plugins` 执行 `git fetch; git show origin/main:plugins/main/index.yml` 确认该条目 `version`/`sha256`/`path` 已更新
- Windows：commit 用 `-m "..."`、命令链用 `;`；受限沙箱下 `git push` 可能因 schannel TLS 握手失败被拦，需在沙箱外执行
- 插件 ID 内不要出现 `-v`（如 `xxx-v2`）：release workflow 用 `${TAG%%-v*}` 解析插件名，会被截断

## 新增汉化插件

1. 新建子目录 `<插件ID>/`，目录名 = 插件 ID，放入 `<插件ID>.js` / `<插件ID>.yml` / `README.md` 等
2. 在 `E:\Temp\stash-plugins`（远程 `k6cc/stash-plugins`）加**占位条目并推送**：`version: 0.0.0`、`sha256:` 全 0、`path:` 按 `https://github.com/k6cc/stash-i18n/releases/download/<插件ID>-v0.0.0/<插件ID>-v0.0.0.zip` 约定、`date:` 当前时间；`README.md` 插手表与依赖清单**手动加行**（`scripts/sync_readme.py` 只更新已有行）
   - 占位符不在远程时，release workflow 的 awk 找不到 `- id:` 会静默跳过，链接推不上
3. `release.yml` 无需改动（tag 白名单为通用模式 `*-v*.*.*`）
4. 同步更新根 `README.md` 插手表与「上游插件」链接

> v2.7.0：基于 allisless0 的 Lockdown 插件的多语言（中/英）重构版，UI 文案跟随 Stash 界面语言；已同步上游 2.7.0。

# LockdownI18n

把 Stash 锁定在一位演员、一个工作室或一个标签上，直到你「脱身」（Lockdown 的汉化版）。玩法接近 roguelike 一局：选锁定对象、选脱身方式、再叠加热度（heat）条件，条件越难分数越高。汉化版只改界面文案，功能与数据行为沿用上游。

## 依赖

- Stash 界面语言为中文时显示中文，否则英文（i18n 桥接失败降级英文）
- 无 Python 后端、无额外依赖；历史与排行榜可选地存入 Suite Data

## 安装

复制 `LockdownI18n` 文件夹到 Stash 插件目录，重启 Stash。顶栏出现锁定入口，打开即为插件自身的页面（新一局 / 排行榜 / 历史三个标签页）。

## 核心机制

- 锁定：目标（及其下属）的页面与场景/图片/图库可以访问，其他路径一律弹回；锁定状态保存在 Stash 插件配置里，跨设备生效，本机另存 localStorage 副本
- 脱身：Finish（O 即脱身）、Timer（计时，按观看时长或锁定时长）、Edge（看满设定时长且不 O）。Edge 到点后分数入账，可就此结束或进入「加时」
- 热度：跳过额度、轮盘随机、看到最后、禁止快进、盲跳、慢燃、严苛失误、单场景等条件；每点热度给分数加 20%
- 记录：每局的脱身方式、跳过/失误/加时、时长与分数进入历史与排行榜，可存为预设（preset）复用整套配置
- 与 Slideshow 联动可播放被锁定对象的图片

## 文件说明

| 文件 | 说明 |
|---|---|
| LockdownI18n.js | UI 主逻辑与样式（含中英文案，插件 ID 为 `LockdownI18n`） |
| LockdownI18n.yml | 插件定义 |
| LICENSE | 上游 MIT 许可证（本目录为上游派生） |

## 上游同步

- 本目录是 [allisless0/stash-plugins](https://gitlab.com/allisless0/stash-plugins) 的 `plugins/Lockdown`（MIT）在**文案层**的本地化派生，功能逻辑沿用上游实现，版权归上游作者
- 上游发布新版后的同步流程与基线记账见仓库根 [UPSTREAM.md](../UPSTREAM.md) 与 `scripts/upstream-diff.ps1`
- 该上游仓库同时托管多个插件（Insights、Slideshow、Suite Data 等），同步时只取 `plugins/Lockdown`

## 注意事项

- 与上游原版 Lockdown **不建议同时启用**：两者都会注册自己的页面路由并执行锁定逻辑。若并存，本汉化版的页面地址为 `/lockdown-i18n`（上游为 `/lockdown`）
- 插件 ID、localStorage 键（`lockdownI18n*`）、Suite Data 中的记录键均以 `LockdownI18n` 命名，与上游原版各自独立
- 上游版本号随汉化版同步：上游 2.7.0 → 本仓库 2.7.0

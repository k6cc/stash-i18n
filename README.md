# stash-i18n

Stash 第三方插件汉化集（i18n）——只做**界面文案本地化**，不改动插件功能与数据行为。

> 自用汉化集：不发布 Discourse 论坛帖。功能问题、Bug 与维护反馈请直接找各插件上游作者。

## 包含插件

| 插件 | 版本 | 上游插件 | 说明 |
|------|------|---------|------|
| [oStatsI18n](./oStatsI18n/) | 1.0.0 | [O Stats](https://discourse.stashapp.cc/t/o-stats/4766/7)（sanjiswe） | 统计页 O 统计与观看时长追踪，UI 文案跟随 Stash 界面语言（中文/英文） |

## 安装

### 通过插件源安装（推荐）

在 **Stash → 设置 → 插件 → 可用插件 → 添加源** 中添加统一插件源，从列表中选择本仓库插件安装：

```
https://k6cc.github.io/stash-plugins/plugins/main/index.yml
```

### 手动安装

从 [Releases](https://github.com/k6cc/stash-i18n/releases) 下载 `<插件>-vX.Y.Z.zip`，解压到 Stash 插件目录，zip 内文件放入以插件名命名的子目录。

- **Windows**: `%USERPROFILE%\.stash\plugins\`
- **Linux/macOS**: `~/.stash/plugins/`

## 与上游的关系

- 汉化版是上游插件在**文案层**的本地化分支，功能逻辑沿用上游实现
- 上游发布新版本后，本仓库在对应插件目录内按上游变更跟进同步
- 与上游原版是否可共存，以各插件目录 `README.md` 的说明为准

各插件的详细说明见对应目录下的 `README.md`。

## License

各插件版权归上游作者所有，License 见对应目录或上游仓库。

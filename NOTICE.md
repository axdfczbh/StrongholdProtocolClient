# 版权与使用声明（NOTICE）

本仓库是《卫戍协议：盟约》**端侧客户端打包壳**的**社区维护分支**。

- 上游（原作者）：[lilyco-42/StrongholdProtocolClient](https://github.com/lilyco-42/StrongholdProtocolClient)
- 游戏本体（另一个仓库，本仓库从不修改它）：[sganggs/Stronghold-Protocol](https://github.com/sganggs/Stronghold-Protocol)
- 本分支维护者：见仓库提交历史（`git log`）

**本分支不是原作者发布的版本**，与原作者的发布渠道、更新源、服务器都没有关系。遇到问题请提到本仓库的 Issues，不要去找原作者。

---

## 1. 代码许可证：GPL-3.0-or-later

本仓库的源代码与文档文字（`desktop/`、`shell/`、`tools/`、`scripts/`、`test/`、`docs/` 等）沿用上游的
**GNU 通用公共许可证第 3 版或（由你选择）任何更新版本**（GPL-3.0-or-later）发布，全文见 [LICENSE](LICENSE)。
Copyright (C) 2026 Stronghold-Protocol contributors。

你可以在该许可证的条件下使用、修改和再分发这些代码。再分发时请保留本文件、`LICENSE` 与代码里的版权头。

## 2. 本分支相对上游改了什么

依据 GPL-3.0 第 5 条（标注修改），改动与日期如下。

**2026-11-19 — 对齐游戏本体 v0.4.0（`sganggs/Stronghold-Protocol` @ `v0.4.0-1-g55f528e9`）**

- 新增 `tools/version-sets.mjs`、`tools/version-sets-child.mjs`：把各官方版本的
  `/cs/<cs16>/{index.json,bounds/official.json}` 生成进 payload。0.4.0 起大厅默认版本是「规程·序列Ⅰ」，
  客户端用**相对页面源**的 URL 取版本数据集，缺了它每个非默认版本都会「版本数据校验失败」。
- `tools/package-client.mjs`：调用上面两个工具；把 `webfonts/` 铺进 payload。
- 新增 `webfonts/google/**`：自托管字体镜像（`google.css` + 112 个 woff2），使出厂页面不请求任何第三方主机。
- `patches/game-client.patch`：按 0.4.0 的源码重新生成（5 文件 9 hunk），新增字体替换与 `mediaAliasEnabled()` 开关。
- `desktop/serve.mjs`：`/cs/` 兜底反代（本地没有的版本数据集向玩家实际连的服务器要一次）+
  同源的 `POST /sp/upstream`（选择页上报本次连的服务器）。
- `shell/picker.js`：启动时上报实际服务器地址。
- `desktop/main.mjs`：**自动更新默认关闭**，且必须同时配置 `SP_POINTER_URL` 才会查（见第 4 节）。
- 版本号对齐 0.4.0；测试与文档同步。

## 3. 打包产物里的《明日方舟》素材**不属于** GPL

Release 里发布的 exe / apk / payload **包含《明日方舟》的美术、音频、字体与派生数据**
（`public/assets/**`、`public/fonts/**`、由官方数据表生成的 `data/*.json` 等）。

这些内容的版权归**上海鹰角网络科技有限公司**及其授权方（Yostar 等）所有，
**不在 GPL-3.0 的授权范围内，本仓库也无权就它们向任何人授予任何权利。**

- 它们只用于**个人、非商业**的游玩；
- 本仓库不通过它们收取任何费用，不含广告、捐赠入口或任何形式的商业化；
- 若你要再分发这些素材，权利人是鹰角网络 / Yostar，不是本项目 —— 请自行确认你是否有权这么做。

《卫戍协议：盟约》是《明日方舟》的官方限时玩法。本项目是**非官方同人复刻**，
与鹰角网络、Yostar 及其关联方**没有任何关联，也未获得其授权或认可**。

## 4. 自动更新

本分支**不带更新源**：`desktop/main.mjs` 默认不检查更新，配置了自己的指针（`SP_UPDATE=1 SP_POINTER_URL=…`）
才会去查。这是刻意的 —— 上游内置的指针指向原作者自己的服务器，把它当成本分支的更新源会让玩家的客户端
被降级或换成与这份构建不配套的 payload。

## 5. 免责

本项目按「现状」提供，不附带任何明示或暗示的担保，包括但不限于适销性与特定用途适用性。
使用本软件产生的任何后果由使用者自行承担。作者与贡献者不对任何直接或间接损失负责。

本软件与任何商业实体无关；如权利人认为本项目侵犯其权益，请通过仓库 Issues 联系，我们会及时处理。

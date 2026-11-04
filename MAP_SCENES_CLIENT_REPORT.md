# 客户端地图场景图补齐报告（2026-11-04）

本次补齐文档列出的 **66 张**：59 张原来只有小地图，7 张店铺和室内原来没有图片。全部通过核对，未采用或核对失败的地图为 **0 张**。

新增 66 张完整场景、66 张手机版，以及 66 张卡片图（59 张替换小地图卡片，7 张新建）。原有 366 个场景条目及图片保持不变，场景索引现为 432 张。

## 渲染及坐标核对

- 使用本机 Classic World 客户端的拆分 `Map.wz`，通过仓库新增的 `tools/render_client_scenes.ps1` / `.cs` 调用 WzComparerR2 MapRender2。工具版本和下载校验值见 [任务文档](MAP_SCENES_FROM_CLIENT.md)。没有使用游戏窗口截图。
- 仅渲染背景、地块和物件，隐藏怪物、NPC、传送口、反应物、名字及编辑标记。室内的玩偶和机器属于物件层，保留场景装饰。
- 66 张原始尺寸和记录的世界矩形宽高比误差均为 0；59 张有小地图的地图逐张缩放叠图，平台、墙壁和边界对齐。7 张室内使用 VR，无小地图可叠。
- 20 张客户端 VR 会裁掉边缘地形，最终改用任务表中小地图的完整世界矩形；5 张体能测试地图没有有效 VR，也使用小地图矩形。没有修改任务的地图范围或名单。
- 原始 PNG、WZ 和工具二进制只保留在仓库外的 scratch。渲染前后客户端 Map 目录 42 个文件的大小及修改时间完全一致。

逐图尺寸、矩形和人工核对结果：[validation.json](design/client-scenes-20261104/validation.json)。

## 本地验证

- `client-scenes`：66 张导入，0 张拒绝；完整图不超过 1760×1040，手机版不超过 1100×650。
- 文档的 `thumbs` 命令：生成 66 张 480×300 卡片，未修改其他地图图片。
- 独立 dev 库 `client_scenes_verify_20261104` 重跑 `import_catalog` 和 `import_portals`；地图 453 张、场景 432 张、开放地图 331 张、开放但没有场景的地图 0 张，未开放地图仍为 122 张。
- 三张代表地图均检查电脑 1280px 和手机 390px 页面：场景正常显示，蚂蚁洞和地铁的怪物标记与平台对齐；全屏打开正常并请求完整场景，浏览器没有脚本错误。手机检查使用 Chrome 触屏视口模拟。
- Python 导入工具测试：4 项通过。网页 Node 测试：158 项通过。`cargo test --workspace`：465 项通过，0 失败，0 跳过；文档测试也通过。

浏览器资源与全屏检查记录：[browser-checks.json](design/client-scenes-20261104/browser-checks.json)。

| 地图 | 电脑截图 | 手机截图 |
|---|---|---|
| 蚂蚁洞Ⅰ 10005060 | [查看](design/client-scenes-20261104/10005060-desktop.png) | [查看](design/client-scenes-20261104/10005060-phone.png) |
| 地铁一号线〈第4地区〉10003065 | [查看](design/client-scenes-20261104/10003065-desktop.png) | [查看](design/client-scenes-20261104/10003065-phone.png) |
| 彩虹村杂货店 1013 | [查看](design/client-scenes-20261104/1013-desktop.png) | [查看](design/client-scenes-20261104/1013-phone.png) |

## 交付范围

提交作者为 Skymore，交付到功能分支 `feat/client-map-scenes-20261104`，基于最新 `gitlab/main`（`fb805ce`）。本次不推 main、不部署、不修改生产库。

以后合入 main 并部署后，仍须按 [BESTIARY_NIADB_UPDATE.md](BESTIARY_NIADB_UPDATE.md) 在生产库重跑 `import_catalog`，新场景才会写入页面数据。本次没有额外迁移或前端源码变更。

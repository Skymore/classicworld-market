# ClassicWorld Market

本地优先的冒险岛市场观察、报价统计与物品图鉴项目。默认使用 WinDivert 只读旁路采集；玩家手动逛摊，商品观察写入 SQLite，网页按商品聚合。

## 已实现

- 原始商品消息、摊位快照、历史观察及聚合报价。
- 频道/自由市场洞的自动识别，未知位置不猜填。
- 商品图标、分类、图鉴参考属性；装备包内属性的实验解析。
- 普通物品参考售价与依据；售光仅标为推定成交。
- 公开共享网页、结构化数据上传、多人快照去重与 Windows 采集器构建。
- 当前画面键鼠逛摊 MVP，尚未完成连续实机验证。
- 网页中英切换、商品特别关注与新报价提醒，包含 25 / 30 级弓弩预设。
- 背包清单、出售预设和定价计划；当前数量由玩家维护。

## Windows 朋友版

完整解压发行 ZIP，双击 ClassicWorldCollector.exe 并允许管理员权限。无需 Proxifier。首次使用前先退出旧代理和游戏，看到 capture_started 后重新进入游戏，手动逛摊即可；随机采集身份自动保存。具体步骤和限制见 [客户端指南](SHARED_CLIENT_GUIDE.md)。

旁路仅捕获游戏连接的网络包副本，使用官方 WinDivert 的 SNIFF | RECV_ONLY 模式。包含对应源码和许可，未调用发包接口。游戏连接必须从握手开始观察；遇到缺包停止解析，提示重连。

## 开发启动（Windows / Python 3.12）

```powershell
py -3.12 -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r requirements-market.txt
.\.venv\Scripts\python.exe market_dashboard.py
```

打开 http://127.0.0.1:8765/ 。初始无采集数据和物品数据库是正常情况。

另一个终端运行：

```powershell
.\.venv\Scripts\python.exe market_proxy.py --market-only --folder network_captures/market_live
```

在自备的 Proxifier 中配置 SOCKS5 `127.0.0.1:1088`，仅将 `MapleStory.exe` 的 TCP 8500–8599 端口导向它，其他连接直连。代理启动后重新建立游戏频道连接，再手动逛摊。停止代理前先退出游戏会话，避免断开正在转发的连接。项目不包含 Proxifier 安装程序、许可证或个人配置。

便捷启动器仍需要本机配置 `tools/MarketPassive.ppx`；新安装建议先按上述命令单独启动。自动点击另见 [说明](MARKET_BROWSER_MVP.md)，依赖在 `requirements-bot.txt`。旧截图 OCR 实验依赖在 `requirements.txt`。

## 数据与共享

`network_captures/`、`market_data/`、`item_database/`、`data/`、运行日志、临时截图及个人配置均不进入 Git。仓库只发布源码与项目说明，不包含市场或图鉴数据库。`market_snapshot.py` 可在本机导出、验证和恢复个人快照，生成的数据仍留在本地。图鉴源数据需另行获取；部分历史研究脚本依赖本机抓包，不属于开箱即用入口。

私人网页 8765 只供本机使用。公开共享站为 https://mxd.ruit.me ，独立共享服务监听 8766，经 Cloudflare Tunnel 提供 HTTPS 访问。采集器自动保存独立随机 ID，不需要访问码。共享库只接收结构化商品观察，原始网络文件留在采集者本机。GitHub 保存源码和构建发布；历史快照、实时数据库和成员凭据留在本机。

朋友使用见 [采集客户端指南](SHARED_CLIENT_GUIDE.md)，站长管理采集身份、撤销凭据和部署见 [共享部署说明](SHARED_DEPLOYMENT.md)。多人观察保留原始证据，当前报价采用同摊位最新完整快照，库存不累加；摊位 ID 重用和跨日期识别仍有限制，详见部署说明。

默认数据流为：朋友采集客户端 → `https://mxd.ruit.me/api/v1/observations` → Cloudflare Tunnel → 站长本机 `127.0.0.1:8766` → `shared_data/market.sqlite`。SQLite 使用 WAL 模式，由共享 HTTP 服务管理读写；无需向公网开放数据库端口。只启动市场网页不会上传数据。站长电脑与共享服务需要保持在线，客户端未成功上传的观察保留在本地并重试。GitHub 不接收这些实时观察数据。

## 验证

```powershell
.\.venv\Scripts\python.exe -m unittest test_market_dashboard test_market_health test_market_pricing test_market_location test_market_equipment
```

部分解码回归测试依赖未上传的个人抓包，应在本机运行。装备字段仍需同实例游戏截图验证；挂牌不等于成交，自动化也不保证符合运营方规则或不会被检测。

## 源码与许可

[第三方说明](THIRD_PARTY_NOTICES.md) 保留 MapleLib GPL 和 msnet MIT 来源。项目尚未选择统一的原创代码开源许可证；公开发布前应处理许可与游戏素材授权。

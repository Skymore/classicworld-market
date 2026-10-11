# ClassicWorld Market

本地优先的冒险岛市场观察、报价统计与物品图鉴项目。默认使用本机 SOCKS5 被动转发采集；玩家手动逛摊，商品观察写入 SQLite，网页按商品聚合。

## 已实现

- 原始商品消息、摊位快照、历史观察及聚合报价。
- 频道/自由市场洞的自动识别，未知位置不猜填。
- 商品图标、分类、图鉴参考属性；装备包内属性的实验解析。
- 普通物品参考售价与依据；售光仅标为推定成交。
- 邀请制共享网页、结构化数据上传、多人快照去重与 Windows 采集器构建。
- 当前画面键鼠逛摊 MVP，尚未完成连续实机验证。

## 快速开始（Windows / Python 3.12）

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

`network_captures/`、`market_data/`、`item_database/`、运行日志、临时截图及个人配置均不进入 Git。图鉴构建脚本保留，但源数据需另行获取；部分历史研究脚本依赖本机快照，不属于开箱即用入口。

私人网页 8765 只供本机使用。邀请制共享站为 https://mxd.ruit.me ，独立共享服务监听 8766，经 Cloudflare Tunnel 提供 HTTPS 访问。共享库只接收结构化商品观察，原始网络文件留在采集者本机。GitHub 仓库用于代码和构建发布，不存放实时商品数据库或成员凭据。

朋友使用见 [采集客户端指南](SHARED_CLIENT_GUIDE.md)，站长邀请成员、撤销凭据和部署见 [共享部署说明](SHARED_DEPLOYMENT.md)。多人观察保留原始证据，当前报价采用同摊位最新完整快照，库存不累加；摊位 ID 重用和跨日期识别仍有限制，详见部署说明。

## 验证

```powershell
.\.venv\Scripts\python.exe -m unittest test_market_dashboard test_market_health test_market_pricing test_market_location test_market_equipment
```

部分解码回归测试依赖未上传的个人抓包，应在本机运行。装备字段仍需同实例游戏截图验证；挂牌不等于成交，自动化也不保证符合运营方规则或不会被检测。

## 源码与许可

[第三方说明](THIRD_PARTY_NOTICES.md) 保留 MapleLib GPL 和 msnet MIT 来源。项目尚未选择统一的原创代码开源许可证；公开发布前应处理许可与游戏素材授权。

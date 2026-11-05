# 枫叶市集（ClassicWorld Market）

冒险岛经典世界（MapleStory Classic World）自由市场的报价采集、价格统计与图鉴网站。

- 公开站：<https://mxd.ruit.me>（别名 `meso.ruit.me`、`ms.ruit.me`、`mscw.ruit.me`）
- Windows 采集器：从[官网下载页](https://mxd.ruit.me/web/download.html?lang=zh)获取。当前版本以 `collector_update.py` 的 `VERSION` 为准（写本文时为 v0.6.89）。
- 源码托管在 GitLab（`main` 是网站唯一发布来源）；安装包发布在 Cloudflare R2（`download.ruit.me`）。市场数据库、凭据和个人配置不进入仓库。

玩家使用见 [采集客户端指南](SHARED_CLIENT_GUIDE.md)；参与开发前先读 [AGENTS.md](AGENTS.md) 的合并与发布规则。

## 组成

| 部分 | 位置 | 说明 |
|---|---|---|
| 网站服务 | `server/` | Rust 工作区：`market-core`（协议校验、定价、读取器算法，可编译为 WASM）、`market-reader-wasm`（浏览器屏幕读取器）、`market-web`（axum + sqlx + PostgreSQL，启动时执行 `migrations/`）。详见 [server/README.md](server/README.md)。 |
| 网页前端 | `frontend/` → `web/react/` | React + TypeScript + Vite，负责全部页面。构建产物随源码一起提交。详见 [frontend/README.md](frontend/README.md)。 |
| 共享网页资源 | `web/` | 主题样式、共享 JS 模块、Service Worker、浏览器采集页（`web/collect/`）及浏览器测试（`web/tests/`）。 |
| Windows 采集器 | 根目录 `unified_client.py`、`collector_*.py`、`market_*.py`、`sweep_*.py`、`desktop_ui/` | 只读收包、上传、自动扫描、扫货、自动更新、诊断上传。入口为 `ClassicWorldCollector.exe`。 |
| 自动扫描器 | `scanner/`（Git 子模块 `cwscreenscanner`） | 自由市场导航、开店/离店、频道切换。由采集器内嵌，单独说明见 [scanner/README.md](scanner/README.md)。 |
| 发布与部署 | `deploy_market.py`、`shared_supervisor.py`、`publish_collector_release.py`、`upload_collector_release.py`、`announce_collector_update.py` | 网站不可变发布包、本机 supervisor、采集器发行。详见 [共享部署说明](SHARED_DEPLOYMENT.md)。 |
| 游戏操作录制 | `record_gameplay.py`、`gameplay_*.py` | 独立的画面与按键示范录制器，见 [GAMEPLAY_RECORDER.md](GAMEPLAY_RECORDER.md)。 |
| 数据工具 | `tools/` | NiaDB 图鉴导入、中文名、地图场景渲染、接口性能抽样等。 |
| 旧版 Python 服务 | `market_dashboard.py`、`shared_server.py`、`market_proxy.py` | 早期 SQLite 共享站、8765 私人网页和 Proxifier 代理模式。生产已改用 Rust 服务，仅作兼容与回退保留。 |

## 数据流

```
采集器（玩家电脑，只读收包）
  └─ HTTPS ─▶ mxd.ruit.me/api/v1/… ─▶ Cloudflare Tunnel
                 └─▶ 站长本机 127.0.0.1:8766  market-web（Rust）
                        └─▶ PostgreSQL（shared_data/postgres）
```

`shared_supervisor.py` 在站长电脑上维持数据库、web、上传和 tunnel 子进程；数据库端口不对公网开放。共享库只接收结构化商品观察，原始网络数据留在采集者本机；上传失败的观察在本地保留并重试。站长电脑休眠或断网期间网站不可用。

## 获取源码

```powershell
git clone --recurse-submodules <GitLab 仓库地址>
# 已有克隆：
git submodule update --init --recursive
```

## 本地开发

### 网站服务

需要一个可用的 PostgreSQL。在 `server/` 下：

```powershell
$env:DATABASE_URL = "postgres://market:<密码>@127.0.0.1:5432/market"
$env:BIND = "127.0.0.1:8080"
cargo run -p market-web
curl.exe -s http://127.0.0.1:8080/readyz   # {"status":"ok","database":"ok"}
```

图鉴数据导入（`import_catalog`、`import_portals`）、WASM 读取器构建和测试见 [server/README.md](server/README.md)。

### 网页前端

```powershell
cd frontend
pnpm install --frozen-lockfile
pnpm dev      # 开发服务器
pnpm build    # 类型检查并输出到 web/react/
```

### Windows 采集器（Python 3.12）

```powershell
py -3.12 -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r requirements-shared.txt
.\scanner\fetch_windivert.ps1   # 下载并校验官方 WinDivert 2.2.2 驱动、签名与源码
.\build_shared_client.ps1 `
  -WinDivert scanner\vendor\windivert\WinDivert-2.2.2-A\x64 `
  -WinDivertSource scanner\vendor\downloads\WinDivert-2.2.2-source.zip
```

产物为 `dist/ClassicWorldCollector-windows-x64-v<版本>.zip`。构建会运行打包后程序的 `--version`、`--self-test` 和 `--scanner-self-test`，并把 `SHARED_CLIENT_GUIDE.md`、`COLLECTOR_QUICK_START.txt` 和许可文件放进安装包。发行步骤见 [共享部署说明](SHARED_DEPLOYMENT.md#采集器发行)。

依赖文件：

| 文件 | 用途 |
|---|---|
| `requirements-shared.txt` | 采集器与扫描器的完整运行和构建依赖（含 `requirements-market.txt` 与扫描器依赖） |
| `requirements-market.txt` | 收包解码的最小依赖 |
| `requirements-release.txt` | 仅维护者发布到 R2 使用 |
| `requirements-gameplay.txt` / `-build.txt` | 游戏操作录制器 |
| `requirements.txt` | 早期截图 OCR 实验 |

## 测试

```powershell
# Rust（集成测试需要指向可丢弃测试库的 DATABASE_URL）
cd server; cargo test --workspace; cd ..

# 前端与网页模块
cd frontend; pnpm check; cd ..
node --test web/tests/*.test.mjs

# 采集器与扫描器（PYTHONPATH 需包含仓库根目录和 scanner）
python -m unittest test_scanner_recovery test_scanner_desktop test_unified_client test_shared_bundle test_player_presence test_room_roster test_market_passive scanner.test_cloud_scan scanner.test_scanner_regressions scanner.test_fast_scanning
```

其余 `test_*.py` 按改动的模块运行。浏览器端到端用例为 `web/tests/*.e2e.mjs`，前端发布前必跑项见 [AGENTS.md](AGENTS.md)。部分解码回归依赖未提交的个人抓包，只能在本机运行。

## 发布

改动合入并推送 `gitlab/main` 后，由本机 supervisor 部署；GitLab CI 尚未配置，合入 `main` 不会自动上线。完整流程、校验要求和禁止事项见 [AGENTS.md](AGENTS.md) 与 [共享部署说明](SHARED_DEPLOYMENT.md)。

## 文档索引

**使用与运维**

- [SHARED_CLIENT_GUIDE.md](SHARED_CLIENT_GUIDE.md)：采集客户端指南（随安装包分发）
- [COLLECTOR_QUICK_START.txt](COLLECTOR_QUICK_START.txt)：安装包内的「开始使用」
- [SHARED_DEPLOYMENT.md](SHARED_DEPLOYMENT.md)：站长部署、域名、缓存、发行与远程调试运维
- [AGENTS.md](AGENTS.md)：仓库协作与发布规则

**服务端与网页**

- [server/README.md](server/README.md)：服务端运行、测试、图鉴导入、屏幕读取器
- [server/AGENT_API.md](server/AGENT_API.md)：冒险助手与只读数据工具
- [frontend/README.md](frontend/README.md)：React 前端结构与回归
- [WEB_PUSH.md](WEB_PUSH.md)：关注提醒的 Web Push
- [WATCH_LISTS.md](WATCH_LISTS.md)：关注清单
- [PRICE_TRENDS.md](PRICE_TRENDS.md)：价格走势口径
- [PLAYER_PRESENCE.md](PLAYER_PRESENCE.md)：玩家离场与报价失效

**采集、扫描与扫货**

- [SWEEP.md](SWEEP.md)：设备登录、多端同步与扫货（服务端、采集端、网页三方契约）
- [SWEEP_LIVE_PRIORITY.md](SWEEP_LIVE_PRIORITY.md)：扫货实时目标
- [SCANNER_COORDINATION.md](SCANNER_COORDINATION.md)：扫描任务分配协议
- [SCANNER_RECOVERY.md](SCANNER_RECOVERY.md)：扫描自动恢复与验证
- [SHOP_RECOVERY_V087.md](SHOP_RECOVERY_V087.md)：v0.6.87–0.6.88 商店恢复修复
- 扫描器子模块：[README](scanner/README.md)、[KEYBOARD_BINDINGS](scanner/KEYBOARD_BINDINGS.md)、[LOCAL_FIXES](scanner/LOCAL_FIXES.md)、[SHOP_ENTRY_RECOVERY](scanner/SHOP_ENTRY_RECOVERY.md)、[VMWARE_KEYBOARD](scanner/VMWARE_KEYBOARD.md)、[MARKET_BROWSER_MVP](scanner/MARKET_BROWSER_MVP.md)

**图鉴数据任务（给 Windows agent 的操作手册）**

- [BESTIARY_NIADB_UPDATE.md](BESTIARY_NIADB_UPDATE.md)：图鉴改用 NiaDB 后的生产库更新
- [EQUIPMENT_DATA_BACKFILL.md](EQUIPMENT_DATA_BACKFILL.md)：补装备暴击基础值
- [MAP_SCENES_FROM_CLIENT.md](MAP_SCENES_FROM_CLIENT.md)：从客户端渲染地图场景图；结果见 [MAP_SCENES_CLIENT_REPORT.md](MAP_SCENES_CLIENT_REPORT.md)

**其他**

- [GAMEPLAY_RECORDER.md](GAMEPLAY_RECORDER.md)：游戏操作录制器
- [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)：第三方来源与许可
- `network_research.md`：网络协议研究笔记，只保存在本机，不进入 Git

## 数据与隐私

仓库采用默认忽略（见 `.gitignore`），只提交源码和审查过的资源。`network_captures/`、`market_data/`、`item_database/`、`shared_data/`、`data/`（`data/reference/` 除外）、日志、截图、凭据和个人配置都不进入 Git。玩家个人配置保存在 `%LOCALAPPDATA%/ClassicWorldMarket`。

挂牌不等于成交；推定成交和装备属性解析都有已知边界，详见各功能文档。自动化不保证符合运营方规则或不被检测。

## 源码与许可

[第三方说明](THIRD_PARTY_NOTICES.md) 保留 MapleLib（GPL-3.0-or-later）、msnet（MIT）、meso.watch 读取器等来源。项目尚未为原创代码选择统一许可证；公开发布前须处理许可与游戏素材授权。

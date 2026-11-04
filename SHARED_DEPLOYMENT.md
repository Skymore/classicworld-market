# 共享部署：mxd.ruit.me

站长本机运行网站、数据库和 Cloudflare Tunnel。所有任务都须遵守的合并与发布规则在仓库根目录 [AGENTS.md](AGENTS.md)。

- [当前架构与启停](#当前架构与启停)
- [网站发布](#网站发布)
- [域名与 Cloudflare](#域名与-cloudflare)
- [采集器发行](#采集器发行)
- [远程调试运维](#远程调试运维)
- [网站流量统计](#网站流量统计)
- [采集身份与去重](#采集身份与去重)
- [数据库迁移说明](#数据库迁移说明)
- [历史部署（已停用）](#历史部署已停用)

## 当前架构与启停

`shared_supervisor.py` 是每个 Windows 用户一份的守护进程。`shared_data/native-runtime.json` 启用原生运行时后，它维持以下子进程，异常退出约 20 秒后重启：

| 子进程 | 说明 |
|---|---|
| `database` | 本机 PostgreSQL（`market_data/runtime/pgsql/bin/postgres.exe`，数据目录 `shared_data/postgres`） |
| `web` | Rust `market-web`，从 `shared_data/deploy/current.json` 指向的发布版本运行，监听 `127.0.0.1:8766` |
| `upload` | 站长本机采集结果上传（`shared_client.py --upload-only`，凭据 `shared_data/owner.json`） |
| `tunnel` | cloudflared，配置 `shared_data/tunnel.yml` |
| `dashboard` | 旧版 8765 私人网页，可在 `native-runtime.json` 中用 `legacy_dashboard_enabled: false` 关闭 |

Cloudflare Tunnel 只把指定域名的 HTTP 流量映射到 `127.0.0.1:8766`，其他 hostname 返回 404；数据库、8765 私人网页、1088 代理与游戏连接都不对公网开放，不需要 WSL 或端口转发。隧道凭据放在用户的 `.cloudflared` 目录，`shared_data/tunnel.yml` 指向该凭据。

Windows 登录计划任务可调用 supervisor，它只在该用户登录后运行；电脑休眠、关机或网络中断期间网站不可用。日志在 `shared_data/*.log`，进程状态在 `shared_data/supervisor_status.json`。生产库地址在 `native-runtime.json` 的 `database_url`（含密码，只放进环境变量，不要打印）。本机 Google 登录配置通过 `GOOGLE_OAUTH_CONFIG` 指向私有文件，不随产物发布。

启动、日常守护、发布、迁移及批量导入均不自动备份数据库，只有用户明确要求时才备份（见 [网站发布](#网站发布)）。

## 网站发布

### 基线与合并

网站更新统一合入 `gitlab/main`，推送成功后从该版本构建并上线。合并前先获取远端主分支，并核对 `shared_data/deploy/current.json` 指向的线上提交；主分支应包含完整线上更新历史，保留账号、图鉴、助手等已有改动。

本机共享目录可能包含多个任务的未提交草稿。网站发布以最新 `gitlab/main` 为起点，在独立工作目录中合并与验证；原工作区的未提交改动保留在原处，不要从较旧工作目录直接重新构建并覆盖当前前端。

同一次发布必须提交 React 源码、回归测试和匹配的 `web/react/` 构建产物。临时替换编译文件不能代替源码合并。保留此前发布的哈希资源，避免已打开的页面加载失败。

### 构建与切换

`deploy_market.py` 有两个子命令：

- `package --binary <market-web> --output <包> --commit <提交> [--base-release <线上提交>]`：生成不可变发布包。
- `deploy --artifact <包> --commit <提交> [--backup-database]`：核验 commit、文件清单和 SHA256，将新版本放入 `shared_data/deploy/releases/<sha>`，在 18766 端口启动候选服务并验证网页与 WASM。成功后原子更新 `current.json`，由 supervisor 只重启 web 子进程；数据库、上传和 Tunnel 继续运行。8766 健康检查失败时恢复上一版程序与网页。数据库迁移不自动逆向执行。

发布包必须声明 `source_branch: main` 和 `base_release`，发布提交必须与本地及已推送的主分支一致。切换前会校验当前版本仍是该基线，并在本地 Git 仓库可用时确认目标提交存在、包含当前线上提交。旧基线、仅有产物而无源码提交、遗漏当前历史的包都会在切换前被拒绝。切换前还会逐一对照 Git 提交中的 `web/` 文件，包括源码、测试、数据、WASM 和构建产物；允许 Windows 文本换行差异，其余内容必须一致。仅给旧文件包标上新的提交号也会被拒绝。

### 数据库备份

用户最新偏好（2026-11-04）：网站发布、数据库迁移、批量导入、修改或删除均不自动备份数据库。只有用户明确要求备份时才执行，届时使用 `deploy_market.py deploy --backup-database ...`（先用 `pg_dump` 备份到 `shared_data/backups/deploy-*.pgdump`）；不要因迁移或导入自行添加该参数。源码与发布版本仍须保留，以便回滚；既有数据库备份继续保留。

### 发布前回归

重新构建前端后，至少验证 `web/tests/quick-search.e2e.mjs` 的手机失焦点击、输入法、全部结果跳转和六条预览，并复核首页最新报价、价格排序、账号、关注和图鉴等现有功能。`web/tests/mobile-viewport.e2e.mjs` 回归页面缩放锁定与手机视口。

React 使用的 `web/js/` 共享模块随哈希资源一起构建，避免 CDN 或浏览器缓存的旧 `user-data.js` 缺少新接口而使账号、关注页加载失败。构建统一相对路径和旧查询版本，确保同一页面只有一个账号状态与 SSE 连接；原有独立脚本入口保留。`web/tests/sweep.e2e.mjs` 同时覆盖旧账户脚本缓存和设备、扫货页交互。

### 发布后核对

核对本地 `main`、`gitlab/main`、发布清单与线上提交号一致，并核对公网静态文件与发布清单一致。合入主分支不会自动触发本机部署；GitLab CI 尚未配置，`.github/workflows/` 中的旧配置不代表已恢复自动部署。

## 域名与 Cloudflare

### 别名域名

`meso.ruit.me`、`ms.ruit.me`、`mscw.ruit.me` 与 `mxd.ruit.me` 提供同一网站，保留各自域名、路径和查询参数，不跳转主站。这三个别名的 DNS 代理到同一个 Cloudflare Tunnel，并在本机 `shared_data/tunnel.yml` 中分别映射到 `http://127.0.0.1:8766`。Cloudflare 的 `Market domain aliases` 跳转规则应停用；下方图鉴缓存规则的 host 条件应包含这四个域名。修改本机 ingress 后只重启 tunnel 子进程，不重启数据库、上传服务或整个 supervisor。

服务只认可这四个域名的精确 HTTPS Origin；自定义 `PUBLIC_HOSTNAME` 的私有部署不接受这些别名。账号密码登录和账号写入支持各域名，登录 cookie 保持仅对当前主机有效。Google 登录沿用已注册的主站回调，别名页不显示 Google 账号操作；直接访问别名的 `/auth/google/start` 会转到主站完成认证，不共享 cookie 到整个 `ruit.me`。

### 图鉴页面缓存规则（需在 Cloudflare 后台设置）

图鉴页面由服务器渲染（Rust），对所有设备输出同一份 HTML，不再返回 `Vary: Sec-CH-UA-Mobile`；手机和桌面布局由 `boot.js` 在首次绘制前按窗口宽度设置。页面内嵌的数据只含公开图鉴和市场信息，不含账号内容。源站已经给这些页面发送缓存时间，但 Cloudflare 默认不缓存 HTML（`cf-cache-status: DYNAMIC`），所以要加一条缓存规则，这一步需要 Rui 在 Cloudflare 后台操作。

| 路径 | 源站 `Cache-Control` |
|---|---|
| `/item/<id>` | `public, max-age=0, s-maxage=60` |
| `/mob/<id>` | `public, s-maxage=600` |
| `/map/<id>`、`/npc/<id>`、`/world`、`/route` | `public, s-maxage=86400` |
| 不存在的页面（404） | `public, s-maxage=600` |
| `/search`、出错页面、`/item/<id>?part=market`、`?part=preview` | `no-store`（不缓存） |

设置步骤（mxd.ruit.me 所在的 zone → Caching → Cache Rules → Create rule）：

1. 规则名：`SSR pages`。
2. 表达式（Edit expression）：

   ```
   (http.host in {"mxd.ruit.me" "meso.ruit.me" "ms.ruit.me" "mscw.ruit.me"})
   and (starts_with(http.request.uri.path, "/item/") or starts_with(http.request.uri.path, "/mob/")
        or starts_with(http.request.uri.path, "/map/") or starts_with(http.request.uri.path, "/npc/")
        or http.request.uri.path in {"/world" "/route"})
   and not http.cookie contains "fm_session="
   and not http.cookie contains "cwm_account="
   ```

   带账号 cookie 的请求（已登录网页账号或采集器账号）直接回源。
3. Cache eligibility：Eligible for cache。
4. Edge TTL：Use cache-control header if present, bypass cache if not（遵守源站的 `s-maxage`）。
5. Browser TTL：Respect origin TTL（浏览器仍按 `max-age` 处理，物品页每次重新验证）。
6. Cache key：保持默认，包含完整查询字符串（`?lang=en`、`?hours=all`、路线的 `from`/`to` 都是不同页面）。不要开启 “Cache by device type”。
7. 保存并部署。

验证（每条请求两次，第二次应命中）：

```
curl -sI https://mxd.ruit.me/mob/9 | grep -iE 'cf-cache-status|age|cache-control'
curl -sI https://mxd.ruit.me/mob/9 | grep -iE 'cf-cache-status|age|cache-control'   # cf-cache-status: HIT，age 递增
curl -sI 'https://mxd.ruit.me/item/2000000?lang=en' | grep -i cf-cache-status        # 60 秒内第二次为 HIT
curl -sI -H 'Cookie: cwm_account=x' https://mxd.ruit.me/mob/9 | grep -i cf-cache-status   # 不应为 HIT（BYPASS 或 DYNAMIC）
curl -sI 'https://mxd.ruit.me/search?q=x' | grep -i cf-cache-status                  # DYNAMIC
```

React 接管页面后会按自己的时效重新读取数据（物品 15 秒、其他图鉴 60 秒），所以边缘缓存的物品页最多显示 60 秒前的首屏，随后自动更新。部署新前端后，缓存中的旧 HTML 最长 24 小时仍引用旧版资源（旧哈希文件保留，页面仍可用）；如需立即生效，部署后在 Caching → Configuration 里 Purge Everything，或只清除上表路径。

## 采集器发行

### 构建

安装 `requirements-shared.txt`，先运行 `scanner/fetch_windivert.ps1` 下载并校验官方 WinDivert 2.2.2 驱动、签名与源码，再运行：

```powershell
.\build_shared_client.ps1 `
  -WinDivert scanner\vendor\windivert\WinDivert-2.2.2-A\x64 `
  -WinDivertSource scanner\vendor\downloads\WinDivert-2.2.2-source.zip
```

生成独立的 Windows x64 目录和 `dist/ClassicWorldCollector-windows-x64-v<版本>.zip`，版本来自 `collector_update.py` 的 `VERSION`。构建会检查扫描器子模块与采集器模块不冲突，运行打包后程序的自检，并附带 SHA256 清单、第三方许可与 WinDivert 源码。安装包 ZIP 须小于 80 MiB、展开后小于 300 MiB，以兼容旧版自动更新。不要将本地凭据、游戏文件、截图、抓包或日志打包。

客户端默认 Windows 原生只读收包，并用只读 WinDivert 补充回环、IPv6 与虚拟网卡连接（驱动加载需管理员权限）；Proxifier 仅供可选旧代理模式。

### 发布通道与更新清单

v0.5.10 及以后的采集器从 `https://mxd.ruit.me/web/releases/stable.json` 获取更新清单。清单仅允许官网发布目录或 `https://download.ruit.me/collector/` 下版本号、文件名一致的 ZIP；下载后校验 SHA256。v0.5.9 及以前仍读取原 GitHub 地址，需要手动升级一次。

本机 `web/releases/` 是独立的公开发行目录，被 Git 忽略，不随网站版本打包。原生服务用 `COLLECTOR_RELEASE_DIR` 挂载它，避免网站切换版本时安装包或更新入口丢失。该目录只放经过审查的公开安装包、源码包和说明，不能放账号凭据或市场数据。

- `stable`：2026-10-29 用户已明确要求公开发布、自动更新并开放所有人使用。自 v0.6.25 起，完整采集器进入 `stable` 通道。升级本身不启动扫货，购买仍遵守账号的关注条件、预算和本机授权设置。
- `beta`：使用 `--channel beta` 写入独立的 `web/releases/beta.json`，不改 `stable.json`，不发送稳定升级通知。稳定更新器会拒绝 beta 清单；内测需手动下载对应版本，安装包仍遵守不可变版本与哈希验证。

### 发布步骤

从已推送的 `main` 构建，然后：

1. 安装 `requirements-release.txt`。R2 发布配置在本机 `shared_data/r2-publisher.json`，仅含 `account_id`、`access_key_id`、`secret_access_key`，令牌应只允许 `classicworld-releases` 桶的对象读写。
2. `python upload_collector_release.py --archive dist/ClassicWorldCollector-windows-x64-v<版本>.zip --source ClassicWorldCollector-v<版本>-source.zip`：先在 `web/releases/v<版本>/` 生成发行文件，上传不可变版本文件到 R2（已存在且内容不同的对象拒绝覆盖），核对公开下载的 SHA256 后才把 `stable.json` 切到 R2。加 `--stage-only` 只上传和核对、不启用自动更新。源码包必须只包含审查过的源码和项目资源。
3. `python announce_collector_update.py --version v<版本>`：确认它是最新的完整稳定版后，通过 PostgreSQL `pg_notify` 通知在线采集器（读取 `DATABASE_URL`，未设置时读取 `native-runtime.json`）。

内测版不走 R2 脚本：`python publish_collector_release.py --archive <ZIP> --channel beta` 只写官网发行目录和 `beta.json`。发布脚本会拒绝包含账号、凭据、抓包或 `shared_data/` 的安装包；密钥不写入 Git 或发行 ZIP。

## 远程调试运维

玩家在客户端主动授权后（流程见 [客户端指南](SHARED_CLIENT_GUIDE.md#远程调试需你主动授权)），运维只在服务器本机使用 `remote_debug_ops.py list/show/exec/stop`，不绑定网站账号。用 `--session <编号>` 指定玩家授权的会话；执行命令通过 `--script-file <UTF-8脚本文件>` 提交。

- 凭据仅保存在服务器私有文件 `shared_data/remote-debug-operator.key`，不得复制到客户端、源码或发行包。
- 接口同时检查本机连接、Host、代理转发标头及独立凭据；没有公开网页控制台。
- 审计仅保存在服务器 `shared_data/remote-debug`，记录会话、完整命令、结果和终止状态，保留 7 天。
- 客户端侧：命令启动前先进入不可脱离的 Job Object 进程作业，最长运行 60 秒，输出有界，单会话最多 32 条命令；不自动重跑交付结果不确定的命令。
- 命令可能输出敏感数据，运维应只读取排障所需内容，不打印凭据。

诊断日志与报 Bug 截图压缩保存在非公开目录 `shared_data/diagnostics`，每分钟清理超过接收时间 7 天的文件（服务停止期间在下次启动时清理），总容量上限 512 MiB；清理同时覆盖遗留临时文件。

## 网站流量统计

网站通过 `/api/v1/traffic/event` 记录匿名页面访问，PostgreSQL 的 `site_pageviews` 属于网站数据库；仅在用户明确要求备份时与网站数据一同备份。所有访客均可在主站 `https://mxd.ruit.me/traffic` 查看浏览量、今日访客、地区地图、来源域名与设备分布；首页页脚提供「网站流量」入口。流量页使用主站 React 导航、窗口样式与昼夜主题，不展示统计说明长文、每日明细或分页面排行。`/api/v1/traffic/summary` 公开汇总数字，不返回逐次访问、访客标识或账号数据。

每日 UTC 更换随机浏览器标识，只存当天哈希；不存 IP、账号、查询参数、完整来源 URL 或对话内容。记录保留最近 90 个 UTC 日期，每小时清理过期行。浏览器 Do Not Track / Global Privacy Control、已识别机器人及私有站点不计数。刷新和页面切换记 PV，筛选、预览、查询参数变化及 SSE 更新不额外记数。每日 UV 是当天浏览器估计值，跨天日访客合计不能解释为跨天独立人数。统计从上线后开始，不回填历史流量。

地区只读取 Cloudflare 的 `CF-IPCountry` 国家/地区代码，不保存精确位置或 IP，不接受浏览器提交的地区。旧记录及缺失、未知或 Tor 标记归入未知，不补造位置。地理位置功能依赖 Cloudflare IP Geolocation：https://developers.cloudflare.com/network/ip-geolocation/ 。地图边界来自 Natural Earth 公共领域数据，由 `tools/build_traffic_world.py` 生成。

## 采集身份与去重

### 采集身份

默认公开查看价格，不需要访问码。采集端通过 `/api/v1/register` 自动领取随机 ID 和上传凭据，并保存到本机 member.json，以后沿用。注册、读取和上传均有限流。随机 ID 代表设备配置，不是实名认证；换电脑或清空配置会产生新 ID，也不能阻止一个人注册多个身份。

已有上传身份继续有效。服务器只存凭据的 SHA256，自动凭据用于防止其他人冒用同一 ID 上传；用户无需手动复制。公开报表不返回凭据、原始抓包或本机路径。

### 去重边界

上传原文不可变，`member + observation_id` 唯一；同 ID 不同内容返回 409。同位置/摊位 ID/名称使用最新完整快照生成当前报价，跨 UTC 日期同样合并，不累加多人库存。没有位置时按采集者隔离；空快照撤下当前报价，不能推定成交。相同槽位库存变化形成状态转换：库存减少、变为 0、首次看到即为 0 各记一次推定成交，重复售光不重复计数。

目前缺少可靠的永久摊主标识；同位置的摊位 ID 若被重用且同名，仍可能合并。存储的摊位键仍含 UTC 日期，报表从上传内容另行计算不含日期的摊位身份。该限制必须保留，不能将其宣传为精确的订单或成交统计。装备属性为候选解析，相同已解析字段仅供比较，未知格式不参与可靠估价。外部成员上传的数据并非可信成交证明，仍应通过成员管理与异常样本审查控制质量。

## 数据库迁移说明

### 0044 账号累计贡献汇总

`0044_account_contribution_rollups.sql` 在写入采集记录时，只重算该账号受影响摊位的去重报价数。`contribution_account_shops` 分别保存全部绑定设备和公开榜单有效设备的累计汇总；报价身份仍由摊位、槽位、物品、装备属性版本、价格、数量及库存组成，多设备重复采集不重复计数。账号接口仍一次返回资料与贡献统计，读取累计汇总不再遍历每台设备的完整历史。未来记录到达首次有效时间时仅精确重算对应摊位，周/月窗口过期不使累计汇总失效。任意设备子集与周/月统计沿用原精确查询，绑定、解绑、设备停用及位置修复在同一事务更新汇总。

此迁移新增派生表并回填历史数据；按 2026-11-04 的用户规则不自动备份数据库。原始采集与逐设备贡献记录保持完整。旧二进制的 SQLx 会拒绝未知迁移，回滚时先执行 `server/tools/rollback_account_contribution_rollups.sql`，再切回保留版本；该脚本只撤销新派生表、触发器和对应迁移记录，不删除原始贡献。如已有后续迁移，脚本会停止，须先复核依赖。

其他迁移的说明见 [server/README.md](server/README.md)。

## 历史部署（已停用）

以下内容仅作记录，不代表当前流程。

### 2026-10-23 发行迁移

GitHub 账号不可用后，源码迁往 GitLab，安装包改在 Cloudflare R2 发布（公开下载域名 `download.ruit.me`），采集器更新入口迁到官网域名（见 [采集器发行](#采集器发行)）。

### GitHub RoomTalk 自动发布

GitHub 历史仓库为 `Skymore/classicworld-market`，此前房间协作使用 `deploy` 分支。该分支每次 push 自动执行 `.github/workflows/server.yml`：Linux 上完成 Rust 格式、Clippy、带临时 PostgreSQL 的测试与迁移冒烟；Windows 上运行 Python 合成回归和网页模块测试；全部通过后构建 Windows 服务和浏览器 WASM，上传绑定该 commit SHA 的完整产物。本机只下载这次 workflow 的产物，不运行 PR 测试。`.github/workflows/collector-update.yml` 在 GitHub Release 发布后通知在线采集器。

`install_market_deploy_runner.ps1` 使用本机已登录的 GitHub CLI 注册仓库级 `mxd-liwin` runner（标签 `mxd-production`），下载官方安装包并校验发布校验和。运行时目录、凭据和日志位于 Git 忽略的 `shared_data/actions-runner`；Windows 计划任务 `ClassicWorld Market Deploy Runner` 在当前用户登录时启动它。用户离线时部署 job 等待 runner 恢复，无需开放入站部署端口。

部署按分支串行，CI 失败不会进入 build/deploy，也没有房主审批步骤。能使用房间工作区的成员可以让 agent 提交并 push，进而发布该项目。RoomTalk 房主连接仅授权此仓库、`Contents: read/write` 的 GitHub token；常规修复不需要修改 workflow 的权限。

### Python / SQLite 旧部署

最初的共享站为 Windows 原生 Python + Waitress + SQLite WAL（`shared_server.py`，数据库 `shared_data/market.sqlite`），Cloudflare Tunnel 同样只映射 `127.0.0.1:8766`。`native-runtime.json` 未启用时 supervisor 仍按此方式运行。管理命令：

```powershell
python shared_server.py --revoke MEMBER_ID
python shared_server.py --backup shared_data/backups/manual.sqlite
```

站长旧凭据保存在 `shared_data/owner.json`，供本机上传使用，无需发给朋友。`--private` 可恢复邀请模式并关闭公开注册；该模式下保留旧的邀请管理命令。SQLite backup API 用于一致性备份，不能只复制运行中的主数据库而丢掉 WAL。数据库、凭据、日志、隧道配置和备份都被 Git 忽略。

# 本机共享部署：mxd.ruit.me

## 2026-10-23 发行迁移

GitHub 账号不可用后，v0.5.10 及以后的 Windows 采集器从
`https://mxd.ruit.me/web/releases/stable.json` 获取更新清单。清单仅允许官网发布目录
或 `https://download.ruit.me/collector/` 下版本号、文件名一致的 ZIP；下载后校验 SHA256。
v0.5.9 及以前仍读取原 GitHub 地址，需要手动升级一次。

本机 `web/releases/` 是独立的公开发行目录，被 Git 忽略，不随网站版本打包。
原生服务用 `COLLECTOR_RELEASE_DIR` 挂载它，避免网站切换版本时安装包或更新入口丢失。
该目录只放经过审查的公开安装包、源码包和说明，不能放账号凭据或市场数据。

构建后，维护者可运行：

```powershell
python publish_collector_release.py --archive dist/ClassicWorldCollector-windows-x64-v0.5.10.zip
```

R2 发布配置在本机 `shared_data/r2-publisher.json`，仅含 `account_id`、`access_key_id`、
`secret_access_key`，令牌应只允许 `classicworld-releases` 桶的对象读写。安装
`requirements-release.txt` 后用 `upload_collector_release.py --archive <ZIP> --source <源码ZIP>`
上传不可变版本文件；脚本核对公开下载的 SHA256 后才把官网清单切到 R2。
成功后运行 `announce_collector_update.py --version v0.5.10` 通知在线采集器。
源码包必须只包含审查过的源码和项目资源；密钥不写入 Git 或发行 ZIP。

源码迁往 GitLab，安装包已在 Cloudflare R2 发布，公开下载域名为 `download.ruit.me`。
下面的 GitHub Actions 发布链路是原部署记录；GitLab CI 流水线尚未配置，
不要把旧 Actions 的配置文件视为已经恢复自动部署。当前在线服务继续由本机 supervisor 维持。

## 当前网站更新约定（GitLab main）

网站更新统一合入 `gitlab/main`，推送成功后从该版本构建并上线。
合并前先获取远端主分支，并核对 `shared_data/deploy/current.json` 指向的线上提交；
主分支应包含完整线上更新历史，保留账号、图鉴、助手等已有改动。
原工作区的未提交改动保留在原处，独立工作目录用于合并与验证。
部署继续使用不可变产物、候选服务检查、数据库备份和 supervisor 原子切换；
上线后核对公网静态文件与发布清单一致。

## 历史 GitHub RoomTalk 自动发布（已停用）

GitHub 历史仓库为 `Skymore/classicworld-market`，此前房间协作使用 `deploy` 分支。
此前该分支每次 push 自动执行 `.github/workflows/server.yml`：Linux 上完成
Rust 格式、Clippy、带临时 PostgreSQL 的测试与迁移冒烟；Windows 上运行
Python 合成回归和网页模块测试；全部通过后构建 Windows 服务和浏览器 WASM，
上传绑定该 commit SHA 的完整产物。本机只下载这次 workflow 的产物，不运行 PR 测试。

`install_market_deploy_runner.ps1` 使用本机已登录的 GitHub CLI 注册仓库级
`mxd-liwin` runner（标签 `mxd-production`），下载官方安装包并校验发布校验和。
运行时目录、凭据和日志位于 Git 忽略的 `shared_data/actions-runner`；
Windows 计划任务 `ClassicWorld Market Deploy Runner` 在当前用户登录时启动它。
用户离线时部署 job 等待 runner 恢复，无需开放入站部署端口。

`deploy_market.py` 核验 commit、文件清单和 SHA256，将新版本放入
`shared_data/deploy/releases/<sha>`，先通过 `pg_dump` 备份 PostgreSQL，再在
18766 端口验证候选服务与网页/WASM。成功后原子更新 `current.json`，由
`shared_supervisor.py` 只重启 web 子进程；数据库、采集上传和 Cloudflare Tunnel
继续运行。8766 健康检查失败时恢复上一版程序与网页。
数据库迁移不自动逆向执行，备份保留在 `shared_data/backups/deploy-*.pgdump`。
本机 Google 登录配置通过 `GOOGLE_OAUTH_CONFIG` 指向原来的私有文件，不随产物发布。

部署按分支串行，CI 失败不会进入 build/deploy，也没有房主审批步骤。
能使用房间工作区的成员可以让 agent 提交并 push，进而发布该项目。
RoomTalk 房主连接仅授权此仓库、`Contents: read/write` 的 GitHub token；
常规修复不需要修改 workflow 的权限。

下面保留 Python/SQLite 旧部署的管理说明与采集身份约定。

Windows 原生 Python + Waitress + SQLite WAL，Cloudflare Tunnel 仅映射共享 HTTP 服务 `127.0.0.1:8766`。原本的 8765 私人网页、1088 代理与游戏连接不对公网开放。不需要 WSL 或端口转发。

## 采集身份与数据

默认公开查看价格，不需要访问码。采集端通过 `/api/v1/register` 自动领取随机 ID 和上传凭据，并保存到本机 member.json，以后沿用。注册、读取和上传均有限流。随机 ID 代表设备配置，不是实名认证；换电脑或清空配置会产生新 ID，也不能阻止一个人注册多个身份。

已有上传身份继续有效。服务器只存凭据的 SHA256，自动凭据用于防止其他人冒用同一 ID 上传；用户无需手动复制。公开报表不返回凭据、原始抓包或本机路径。

```powershell
python shared_server.py --revoke MEMBER_ID
python shared_server.py --backup shared_data/backups/manual.sqlite
```

站长旧凭据继续保存在 shared_data/owner.json，供本机上传使用，无需发给朋友。`--private` 可恢复邀请模式并关闭公开注册；该模式下保留旧的邀请管理命令。

数据库、凭据、日志、隧道配置和备份都被 Git 忽略。SQLite backup API 用于一致性备份，不能只复制运行中的主数据库而丢掉 WAL。

## 启停

`shared_supervisor.py` 维持 web、upload、tunnel 三个子进程，异常退出约 20 秒后重启，每天一份数据库备份。Windows 登录计划任务可调用它；仅在该 Windows 用户登录后运行。电脑休眠、关机或网络中断期间网站不可用。日志在 `shared_data/*.log`，进程状态在 `shared_data/supervisor_status.json`。

Cloudflare 隧道凭据放在用户 `.cloudflared`，项目的 `shared_data/tunnel.yml` 指向该凭据。仅指定域名的 HTTP 流量进入 8766，其他 hostname 返回 404。

## 去重边界

上传原文不可变，`member + observation_id` 唯一；同 ID 不同内容返回 409。同位置/摊位 ID/名称使用最新完整快照生成当前报价，跨 UTC 日期同样合并，不累加多人库存。没有位置时按采集者隔离；空快照撤下当前报价，不能推定成交。相同槽位库存变化形成状态转换：库存减少、变为 0、首次看到即为 0 各记一次推定成交，重复售光不重复计数。

目前缺少可靠的永久摊主标识；同位置的摊位 ID 若被重用且同名，仍可能合并。存储的摊位键仍含 UTC 日期，报表从上传内容另行计算不含日期的摊位身份。该限制必须保留，不能将其宣传为精确的订单或成交统计。装备属性为候选解析，相同已解析字段仅供比较，未知格式不参与可靠估价。

## 客户端构建

安装 `requirements-shared.txt`，运行 `build_shared_client.ps1`（自动调用 fetch_windivert.ps1 校验并准备官方驱动和源码）。生成独立 Windows x64 目录和 ZIP。发行时附 SHA256、对应 Git 标签源码和第三方许可；不要将本地凭据打包。客户端默认 WinDivert 旁路采集；Proxifier 仅供可选旧代理模式。驱动只读加载需管理员权限，默认只处理游戏 IPv4 连接。

## 容量与后续

此为小范围朋友使用的 MVP，报表短时缓存，数据库单机 WAL。大量用户需分页/增量接口、异步聚合和 PostgreSQL；外部成员上传的数据并非可信成交证明，仍应通过成员管理与异常样本审查控制质量。


## 网站改动合并与发布校验

本机共享目录可能包含多个任务的未提交草稿。网站发布以最新 `gitlab/main` 为起点，并确认它包含 `shared_data/deploy/current.json` 对应的线上提交，在独立目录中合并改动；不要从较旧工作目录直接重新构建并覆盖当前前端。

同一次发布必须提交 React 源码、回归测试和匹配的 `web/react/` 构建产物。临时替换编译文件不能代替源码合并。保留此前发布的哈希资源，避免已打开的页面加载失败。

本地发布包必须声明 `source_branch: main` 和 `base_release`，发布提交必须与本地及已推送的主分支一致。切换前会校验当前版本仍是该基线，并在本地 Git 仓库可用时确认目标提交存在、包含当前线上提交。旧基线、仅有产物而无源码提交、遗漏当前历史的包都会在切换前被拒绝。

重新构建前端后，至少验证 `web/tests/quick-search.e2e.mjs` 的手机失焦点击、输入法、全部结果跳转和六条预览，并复核首页最新报价、价格排序、账号、关注和图鉴等现有功能。

仓库根目录 `AGENTS.md` 记录所有任务须遵守的合并与发布规则。每次发布后核对 `main`、`gitlab/main`、发布清单与线上提交号一致；合入主分支不会自动触发本机部署。

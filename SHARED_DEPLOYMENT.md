# 本机共享部署：mxd.ruit.me

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

上传原文不可变，`member + observation_id` 唯一；同 ID 不同内容返回 409。同位置/摊位 ID/名称/UTC 日期使用最新完整快照生成当前报价，不累加多人库存。没有位置时按采集者隔离；空快照撤下当前报价，不能推定成交。相同槽位库存变化形成状态转换，重复售光不重复计数。

目前缺少可靠的永久摊主标识；同一天同位置的摊位 ID 若被重用且同名，仍可能合并。跨日期不合并可能短时重复显示旧摊位。该限制必须保留，不能将其宣传为精确的订单或成交统计。装备属性为候选解析，相同已解析字段仅供比较，未知格式不参与可靠估价。

## 客户端构建

安装 `requirements-shared.txt`，运行 `build_shared_client.ps1`（自动调用 fetch_windivert.ps1 校验并准备官方驱动和源码）。生成独立 Windows x64 目录和 ZIP。发行时附 SHA256、对应 Git 标签源码和第三方许可；不要将本地凭据打包。客户端默认 WinDivert 旁路采集；Proxifier 仅供可选旧代理模式。驱动只读加载需管理员权限，默认只处理游戏 IPv4 连接。

## 容量与后续

此为小范围朋友使用的 MVP，报表短时缓存，数据库单机 WAL。大量用户需分页/增量接口、异步聚合和 PostgreSQL；外部成员上传的数据并非可信成交证明，仍应通过成员管理与异常样本审查控制质量。

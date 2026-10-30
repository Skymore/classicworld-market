# 设备登录、多端同步与扫货

账号是唯一身份。网页和每台登录的采集端都是这个账号的一台设备，看同一份数据。网页决定买什么、什么时候开始；真实购买只在本机同意的采集端上执行。购买本身是一个接口，Windows 上由游戏内购买执行器实现；执行器未就绪的电脑不能参与扫货。

本文件是服务端、采集端和网页三方共同遵守的契约。错误一律返回 `{"error":"<code>"}`，沿用现有写法。

## 本机服务与网页登录地址（v0.6.23）

采集配置中的 `endpoint` 用于扫描任务、上传、设备 API 和令牌交换。可单独配置 `login_endpoint`，仅用于浏览器设备登录页；不设置时沿用 `endpoint`。两个地址都必须通过既有官网/本机地址校验，原生窗口也按相同登录地址验证返回链接。

正常客户端统一使用 `endpoint: https://mxd.ruit.me`，包括在网站服务器本机运行的客户端。`login_endpoint` 可以省略或设为同一官网地址。只有开发和本机诊断才单独配置本机 API；不能把改走本机服务当成公网连接故障的正式修复。浏览器确认后仍回到本机随机端口，保留 PKCE、state 校验、一次性授权码与 DPAPI 存储。

## 公网连接回退（v0.6.24）

`collector_network` 按解析顺序交错 IPv6/IPv4 地址，首个 TCP 尝试未完成时每隔 250 毫秒发起下一个地址，先连接成功者继续原有 HTTPS 流程，其余套接字立即关闭。单个地址族不可达不会再耗尽全部任务请求期限；两种地址族均可正常优先或回退，不改变系统 IPv6 配置。扫描、上传和设备 API 共用这个连接器，沿用代理、证书和主机名校验。外层独立进程仍执行原有 6 秒总期限、取消和回收策略。

本机故障实测为两个 IPv6 TCP 连接各等待 3 秒，然后 IPv4 很快成功；修复后同一公网健康请求从约 6.1 秒降至 0.36 秒。回归覆盖地址黑洞、双向回退、立即/延迟失败、超时资源回收，以及真实 HTTP 和扫描器故障恢复。

## 1. 采集端登录

采用桌面程序的浏览器登录流程（OAuth 授权码 + PKCE S256 + 本机回调，RFC 8252 / 7636）。

1. 采集端生成 `verifier`（43 个 base64url 字符，来自 32 字节随机数）和 `state`（同样长度），`challenge = base64url_nopad(sha256(verifier))`。
2. 采集端打开系统浏览器：
   `https://<host>/device?redirect_uri=http://127.0.0.1:<端口>/callback&state=<state>&challenge=<challenge>&name=<设备名>`。
   端口是本机面板 `collector_dashboard` 已经监听的 127.0.0.1 端口；`/callback` 只在有待完成的登录时响应。
3. 网页 `/device`：未登录先走现有登录；已登录显示“允许「设备名」登录 <昵称>？”和“允许 / 取消”。允许时调用 `POST /api/v1/device/authorize`，拿到 `code` 后 `location.replace(redirect_uri + "?code=" + code + "&state=" + state)`；取消时跳 `redirect_uri?error=access_denied&state=...`。
4. 采集端校验 `state`，调用 `POST /api/v1/device/token` 换设备令牌，回调页显示“已登录，可以关闭此页”。
5. 设备令牌只存在 Python 进程和本机加密存储里（Windows DPAPI），网页视图拿不到。

令牌格式：设备令牌 `cwd_` + 43 个 base64url 字符，服务器只存 sha256。90 天未使用自动失效；撤销后立即失效。

### 接口

`POST /api/v1/device/authorize`（网页会话 + Origin + CSRF，即 `writable`）
- 请求 `{"redirect_uri","challenge","name"}`。
- `redirect_uri` 必须完全匹配 `http://127.0.0.1:<1024-65535>/callback`；`challenge` 43 个 base64url 字符；`name` 1-40 字符，无控制字符。
- 每账号每分钟 10 次。生成 43 字符 `code`，存 sha256，5 分钟有效，只能用一次。
- 返回 `{"code"}`。错误：`invalid_request`、`rate_limited`、`login_required`。

`POST /api/v1/device/token`（无 Cookie；可选 `Authorization: Bearer <采集令牌>`）
- 请求 `{"code","verifier","redirect_uri","client_version"}`。`verifier` 43-128 个 `[A-Za-z0-9._~-]` 字符。
- 原子消费 code（未用、未过期），校验 `redirect_uri` 相同、`base64url(sha256(verifier)) == challenge`。失败一律 `invalid_grant`，code 已作废。
- 带了有效采集令牌时：该采集器未绑定账号则绑定到本账号，并按 `accept_link` 现有规则接管昵称；已绑定本账号则不变；绑定了别的账号则不改动贡献归属。设备行的 `collector_id` 只在采集器归属本账号时记录。
- 返回 `{"token","device":{"id","name"},"account":{"id","nickname"}}`。

`POST /api/v1/device/migrate`（`Authorization: Bearer <采集令牌>`）
- 老用户免登录：采集器有效、已绑定账号、且这个采集器从未换过设备令牌（含已撤销的）时，创建名为“采集器”的设备并返回与 `token` 相同的结构。否则 `login_required`。

`POST /api/v1/device/logout`（设备令牌）
- 撤销自身。若设备记录了 `collector_id` 且采集器仍归属本账号，解除采集器绑定（沿用现在“退出本机账号”的效果）。正在参与的扫货改为 `left`。

`GET /api/v1/device/account`（设备令牌）→ `{"account":{"id","nickname"},"device":{"id","name"}}`。

`GET /api/v1/account/devices`（网页会话）→ `{"devices":[Device]}`

```json
{"id":"<public id>","name":"书房电脑","created_at":"...","last_seen_at":"...","online":true,
 "client_version":"0.7.0","state":DeviceState|null}
```
`online` = `last_seen_at` 在 75 秒内。

`GET /api/v1/device/devices`（设备令牌）→ 同样的 `{"devices":[Device]}`。

`POST /api/v1/device/rename`（设备令牌）`{"name"}` → `{"device":{"id","name"}}`。只改本机；`name` 规则同 `authorize`（去掉首尾空白后 1-40 字符，无控制字符），否则 `invalid_request`。名字变了才发 `devices` 消息。其他设备的撤销只在网页上做。

`POST /api/v1/account/devices/revoke`（`writable`）`{"device"}` → `{"ok":true}`。撤销后该设备参与的扫货改为 `left`，原因 `revoked`；设备记录的采集器若仍归属本账号，同时解除绑定，和在设备上退出一样。

“退出所有设备”、修改密码和找回密码同时撤销全部设备令牌。

采集器只要换过一次设备令牌（无论是否因此绑定账号），服务器就记下 `collectors.device_token_issued_at`，之后 `migrate` 一律拒绝。

旧的 `/api/v1/collector/account-link`、`/collector/watch-data`、`/collector/watch-revision`、`/collector/account-disconnect` 保留给旧版客户端，新版不再调用。

## 2. 同步

### 设备读写账号数据

`GET /api/v1/device/data`（设备令牌）→ `{"account":{"id","nickname"},"records":[Record]}`，只含 `kind='watch'` 和 `kind='pref'` 且 `key` 以 `watch.` 开头的记录。

`POST /api/v1/device/data`（设备令牌）`{"operations":[Record]}`，范围同上，校验与版本冲突规则与 `/api/v1/account/data` 相同（`sync_conflict`、`watch_limit`）。返回同 GET。

采集端内嵌网页经本机网关访问 `/api/v1/account/data` 时，网关改为转发到这两个接口。

### 账号消息流

`GET /api/v1/account/events`，网页用 Cookie，采集端用 `Authorization: Bearer cwd_...`。SSE：
- 连上立即发 `event: hello`。
- `event: data`：账号数据变了。
- `event: sweep`：扫货任务、参与设备或购买记录变了。
- `event: devices`：设备登录、退出、撤销或状态变了。
- 每 15 秒一行注释保活。data 字段固定为 `{}`，客户端收到后重新拉取对应接口。

服务端在写入事务里执行 `pg_notify('account_changed', '<account_id> <topic>')`，现有 `realtime::listen` 增加这个频道，按账号分发。设备连接时及连接期间每 30 秒更新 `last_seen_at`。客户端断线后指数退避重连（1、2、4……最多 30 秒），断线期间每 30 秒拉取一次。

## 3. 扫货

### 名词

- 扫货规则：关注里勾了“扫货”的条件组，加每件物品的“本轮最多买”（`buyLimit`，件，默认 1）。支持固定最高价及最低 10% / 25% / 50%，装备条件不能为 `missing`。百分比沿用关注提醒的完整有效分组报价口径，在开始本轮时由服务端换算并冻结最高单价；无有效正价时返回 `sweep_price_unavailable`，不回退旧手动价格、不静默漏掉条件。运行中的 `watches` 保持执行器兼容的固定价格式（`reminder.percentile=all`），组内 `price_percentile` 保留展示用百分比，`source_watches` 保存原规则用于变更判断。行情变化不抬高本轮限价，下一轮重新计算；预算、数量和下单价格校验照常执行。
- 扫货任务：一轮扫货。包含规则快照（`plan`）、快照版本、总预算、参与设备、结束时间。一个账号同时最多一个运行中的任务。
- 预留：设备买之前向服务器申请占用预算和件数，30 秒内回报结果。
- 本机设置：只在采集端本机修改，网页只读。

### 规则快照

服务端从当前 `account_data` 生成：

```json
{"watches":[{"item_id":1302010,"limit":2,"groups":[<原样的条件组对象，仅 buy=true 且可扫货的>]}]}
```
没有可扫货的组时 `no_sweep_groups`。最多 100 件物品。采集端收到后补充物品名和基础属性（`/api/v1/watchlist/catalog`、`/api/v1/watchlist/listings`），再用 `collector_sweep.configuration()` 校验，校验失败就拒绝参加。

### 金额与件数

- 单价：飞镖、子弹（`item_id // 10000` 为 207 或 233）按组计价，其余为 `price / bundle`。
- 每次购买的件数 `units_per = 1`（飞镖子弹）或 `bundle`。
- 已用预算 = 已买的 `spent` + 持有中预留的 `cost` + 结果未知或过期预留的 `cost`。
- 已用件数同理（已买的按实际件数）。
- 持有中的预留超过 `expires_at` 视为过期，按未知计入。这样预算永远是花费上限。

### 状态

任务 `status`：`running` → `stopped`（有人停止）或 `finished`（`time_up`、`budget_spent`）。超过 `ends_at` 在下次读写时置为 `finished/time_up`；剩余预算为 0 时置为 `finished/budget_spent`。

参与设备 `state`：`invited` →（`join`）`active` 或（`refuse`）`refused`；`active` →（`leave`、撤销、结果未知）`left`。`left` 和 `refused` 在本任务内不可再加入；`active` 但租约过期的设备可以重新 `join`（采集端重启）。

租约：`join` 发 43 字符租约令牌，30 秒过期；设备每 5 秒心跳；本机从请求发出起 15 秒未续上就停止购买。

### 网页接口（网页会话）

`GET /api/v1/account/sweep` →

```json
{"run":Run|null,"devices":[Device]}
```
`Run`：

```json
{"id","status","stop_reason","budget","spent","reserved","unknown","remaining",
 "started_at","ends_at","stopped_at","started_by":"web|<device id>","plan_version","plan_stale":false,"bought",
 "items":[{"item_id","limit","units","bought"}],
 "devices":[{"id","name","state","message","online","spent","checked","pending","progress_at","leased"}],
 "purchases":[Purchase]}
```
`run` 是运行中的任务，没有时取 24 小时内最近结束的一个。`plan_stale` = 按当前规则重新生成的快照与任务快照不同。`purchases` 为最近 50 条预留，新的在前：

关注页左栏分“物品 | 扫货”两个页签（选中的记在用户设置 `watch.panelTab`）。物品页签是关注卡片，卡片上只有每组的“扫货”勾选；每件物品的“本轮最多买”在扫货页签的条件表里改（数字框加“不限”勾选，写 `buyLimit`，0 = 不限）。扫货页签空闲时显示“未开始 · N 件物品 · 在线设备”和“开始扫货”，以及 24 小时内最近一轮的结果；运行中显示已运行时长、结束时间、进度条、已花/剩余、每台设备的消息和已查店次，条件表改为“已买 / 上限”，买满的行标“已满”，下面是最近 5 条购买。关注里改了条件时提示“关注里的扫货条件已修改，下一轮生效”。停止在页签里就地确认；详情弹窗保留（进度、背包、设置、记录四个分页，SSE 更新保留当前分页），里面也能停止，结束后仍可查看记录。

“先买命中的”是扫货页签里的独立入口，不是开始弹窗里的方式：网页用右栏的命中列表算“N 条命中 · 合计约 X”（范围内、仍在售、价格达标，按每件物品的数量上限截断），确认框只有设备、预算（默认填合计）和密码，提交 `scan:{"mode":"recent","recent_minutes"}`，不传 `minutes`（用默认的 7 天）。运行中标题“正在买命中的”，第二行“剩 N 处待回访”取各设备 `pending` 之和；在线且已加入的设备都报 `pending=0` 时视为队列空，标题改为“命中的都看过了”，并提供“转为全市场扫货”：先停止本轮，再用剩余预算开一轮全市场（需要密码）。

开始弹窗只有设备（不可选的写原因）、预算（带 100K/1M/3M/10M 快捷值）、时长（1 小时/6 小时/24 小时/3 天/7 天，默认沿用上次）、当前密码，加一行摘要。设备可用性先按 `client_version` 判断，低于 0.6.19 显示“版本 X 过旧，请更新采集端”；网页不解析 `executor.reason` 的字样。购买记录地点中文写“12频道 3洞 · 店主”，英文“CH 12 FM3 · owner”，和站内报价行一致。

URL 带 `embed=1` 时（采集端内嵌）不显示站点头部、底栏、AI 助手和通知行；`mode: "collector"` 时扫货页签只有可编辑的条件表，不请求 `/api/v1/account/sweep`。

`bought` 与 `items[].bought` 是全轮实际成交数量，独立于最近 50 条记录及仍占用额度的 `units`。`checked` 保存采集器最近上报的检查店次，未上报为 null；这是当前采集进程的计数，重启会重新计数，不是去重商店数。`pending` 是买命中的时还要回访的店铺数，0 表示队列空、在等新命中，不在该模式或未上报为 null（迁移 `0035`）。`progress_at` 是最近有效扫货心跳时间；`leased` 表示当前有有效租约。任务处于运行中或设备已加入，不代表扫描器正在移动。界面单独显示设备消息，通用“扫货中”只显示“已加入任务”；离线和租约中断优先显示。

背包显示每台设备的目标物品和可展开的其他已读物品、金币及读取时间。不同角色不合并；离线、断开游戏和未读取类别显示“—”，只有完整读取的类别中没有物品时才显示 0。

```json
{"id","device","item_id","status":"held|bought|not_bought|unknown|expired","quantity","units","price","spent","reason","room","channel","owner","created_at","settled_at"}
```

`POST /api/v1/account/sweep/start`（`sensitive`：需当前密码，Google 账号需 15 分钟内登录过）
- `{"devices":[id],"budget":1000000,"minutes":120,"current_password":""}`
- 设备 1-8 台：属于本账号、未撤销、在线、`state.sweep.allow_web_start` 为真、`state.sweep.executor.ready` 为真，否则 `device_unavailable`。
- `budget` 1 到 10^12 整数，`minutes` 5 到 10080（7 天），可省略，省略时 10080；“先买命中的”不传。已有运行中任务 `sweep_running`。
- 返回同 `GET /api/v1/account/sweep`。

`POST /api/v1/account/sweep/stop`（`writable`，不需要密码）`{"run"}`，`stop_reason='stopped_on_web'`。

`POST /api/v1/account/sweep/apply`（`sensitive`）`{"run","current_password"}`：保留旧客户端兼容入口，但返回 409 `restart_required`。运行中的规则不允许原地替换。

### 设备接口（设备令牌）

`POST /api/v1/device/state` 上报本机状态，存为设备的 `state`：

```json
{"client_version":"0.7.0","sweep":{"allow_web_start":false,"max_spend":0,"max_order":0,"reserve_mesos":0,
 "executor":{"ready":false,"reason":"购买功能加载失败"},"game":{"connected":true}}}
```
即 `DeviceState`。数值为 0 到 10^12 的整数，`reason` 最多 80 字符。

`GET /api/v1/device/sweep` → `{"run":null}` 或

```json
{"run":{"id","status","budget","spent","remaining","started_at","ends_at","started_by","plan","plan_version","bought",
 "items":[{"item_id","limit","units","bought"}],
 "participant":{"state","message","plan_version"},"spent_here"}}
```
只返回本设备处于 `invited` 或 `active` 的运行中任务。`spent`、`bought`、`items` 与网页 `Run` 同义。

`GET /api/v1/device/sweep/plan` → `{"plan":{"watches":[...]}}`：按当前关注规则生成的快照，形状同“规则快照”；没有可扫货的组时 `watches` 为 `[]`，不报错。运行中的任务仍用自己的 `plan`。

`POST /api/v1/device/sweep/start` 本机发起：`{"budget","minutes"}`，参与设备只有本机，不需要密码（在电脑前操作即同意）。返回同上。

`POST /api/v1/device/sweep/join` `{"run","plan_version"}` → `{"lease","expires_in":30}`。`plan_version` 必须等于当前版本（`plan_changed`）。关注规则修改后需停止并重新开始；新一轮从最新关注规则生成快照。

`POST /api/v1/device/sweep/refuse` `{"run","reason"}`。

`POST /api/v1/device/sweep/heartbeat` `{"run","lease","status":{"message","checked","pending"}}` → `{"plan_version","remaining","spent"}`。`pending` 只在买命中的时发（0–100000，剩余待回访店铺数，等待时为 0），按发来的值存，不带就清空；任务已结束 `409 {"error":"sweep_stopped","reason":...}`；租约无效或过期 `409 lease_lost`。

`POST /api/v1/device/sweep/leave` `{"run","lease","reason"}`；`POST /api/v1/device/sweep/stop` `{"run"}` 停止整个任务，`stop_reason='stopped_on_device'`。

`POST /api/v1/device/sweep/reserve`

```json
{"run","lease","plan_version","listing":"<64 位十六进制>","item_id","price","bundle","stock","quantity",
 "location":{"room","channel","shop_id","owner","category","slot"}}
```
- 需要任务运行中、租约有效、`plan_version` 为当前版本、物品在快照内、单价不超过该物品可扫货组的最高价。
- `listing` 是本条挂单的身份（洞、频道、店主、类别、格子、物品、价格、包装、装备属性）的 sha256；同一任务同一挂单只批一次。
- `granted = min(quantity, stock, 剩余件数 // units_per, 剩余预算 // price)`。
- 返回 `{"reservation","granted","expires_in":30}`；批不了时 `{"granted":0,"reason":"budget|item_limit|duplicate"}`。

`POST /api/v1/device/sweep/settle`

```json
{"reservation","status":"bought|not_bought|unknown","quantity","spent","reason"}
```
- 不需要租约（买完后租约可能已失效，仍须回报）。只能回报本设备的预留；`held`，或创建 10 分钟内已过期的预留可回报；同样的回报重复提交返回成功。
- `bought`：`1 <= quantity <= granted`，`0 <= spent <= quantity * price`。`not_bought`：`quantity=0`、`spent=0`。`unknown`：结果不确定。

## 4. 购买接口

`sweep_purchase.py` 定义接口，采集端的扫货引擎调用，Windows 执行器在 `sweep_purchaser_windows.py`。

```python
PurchaserStatus(ready: bool, reason: str, mesos: int | None)
PurchaseOrder(reservation, item_id, name, category, slot, price, bundle, quantity,
              equipment, shop_id, owner, room, channel, deadline, can_buy)
PurchaseResult(status: 'bought'|'not_bought'|'unknown', quantity=0, spent=0, reason='')

class Purchaser(Protocol):
    def status(self) -> PurchaserStatus: ...
    def buy(self, order: PurchaseOrder, window: ShopWindow) -> PurchaseResult: ...
```

实现必须遵守：
1. 在扫描器输入线程上、该商店窗口打开时被调用。不打开、不关闭商店，返回时窗口保持打开。
2. 点击前确认 `(category, slot)` 这一行仍是同一物品、价格、包装和属性，否则返回 `not_bought/price_changed`。
3. 不买超过 `quantity` 份，不花超过 `quantity * price`。
4. 在 `deadline`（`time.monotonic()`）前返回；时限取服务器预留到期减 5 秒与当前本地租约时限的较早值。每次购买输入（尤其是最终确认）前调用 `order.can_buy()`，它同时检查当前任务、租约、规则版本和停止状态；未提供此回调时默认拒绝。最终确认已可能发出而无法确认结果时返回 `unknown`。
5. 只有确认买成（例如收到商店行更新或背包变化封包）才返回 `bought`。
6. `reason` 取值：`sold_out`、`price_changed`、`not_enough_mesos`、`inventory_full`、`shop_closed`、`window_lost`、`timeout`、`error`、`stopped`、`trade_locked`。
7. 取消或确认拒绝后仍需确认商店已恢复；无法恢复时抛 `PurchaseHalt(result)`。引擎先结算或持久化待回报，再退出本轮并把异常交给扫描器停止输入。`unknown` 即使作为普通返回值交回，也会在结算后转为停机异常，不再继续关店或扫描下一家。
8. 明确的 `trade_locked` 回报 `not_bought`、数量和花费均为 0，并退出本轮；本轮不重试其他商品。

`ShopWindow` 由扫描器提供：`bounds`、`capture()`、`click(x, y)`、`press(key)`、`pause(seconds)`、`vision`、`capture_file`（本次商店抓包文件路径）。

`load_purchaser()` 导入并创建 Windows 执行器；导入或创建失败都返回 `UnavailablePurchaser`，其状态为 `ready=False`、`reason='购买功能加载失败'`。

### 扫描器钩子

`market_browser_bot.run_live(..., shop_callback=None, capture_receipt=None)`：商店打开且价格抓到后、关闭前调用 `shop_callback(collected, window)`。

- 云端分洞扫描不传 `capture_folder`，所以由扫货引擎提供 `capture_receipt`：它把这次访问和同进程采集器的 `captured` 事件配对，2 秒内没有抓包就跳过回调；没有运行中的扫货时返回 None，扫描照旧。
- 回调里的异常包成 `ShopCallbackError`（不是 `RuntimeError`），频道重试和洞循环都不捕获它，扫描就此停止。窗口状态不确定时宁可停。
- `window.capture()` 返回 `(image, bounds)`；`window.click(x, y)` 用窗口内坐标，沿用扫描器的移动和点击，带窗口焦点和位置检查。

### 扫货引擎（采集端）

1. 收到 `sweep` 消息或每 15 秒拉取 `GET /api/v1/device/sweep`。
2. 被邀请时检查：由网页发起需 `allow_web_start`；执行器就绪；`max_spend > 0`；规则校验通过。不满足就 `refuse` 并写明原因，满足就 `join`。
3. 运行中每 5 秒心跳；规则版本变了先停止预留，拉新快照、校验、再 `join` 新版本。
4. 扫描器打开一家店时，引擎读取本次抓包，要求有洞和频道，按规则匹配。对每条命中：
   - 本机限额：本轮本机已花不超过 `max_spend`，单笔不超过 `max_order`（0 表示不限），已知金币时保留 `reserve_mesos`。
   - 申请预留（2 秒超时，失败不买）。
   - 调用 `buy`，按结果回报。回报失败存入本机待回报队列，后台重试。
   - 结果为 `unknown` 时本机离开本轮任务，并停止扫描输入。
5. 任何一步连不上服务器超过 30 秒、租约丢失、任务结束、退出账号：立即停止购买。
6. 拿到预留后、调用 `buy` 前再确认一次仍在扫货且租约未变；停止或退出恰好发生在预留途中时，不买，回报 `not_bought/stopped`。
7. 退出账号的顺序：停止购买 → 等正在进行的购买结束（最多 40 秒）→ 把待回报的结果报完 → 注销令牌。回报遇到 401 不丢弃，留在待回报队列里，24 小时后清除。
8. 桌面界面：空闲时每 60 秒、以及收到 `data` 消息后，读一次 `GET /api/v1/device/sweep/plan`，在“扫货条件”表里只读显示（物品名、条件、本轮最多买、背包）；运行中改为显示本轮的 `run.plan`，列为“已买 / 上限”。数量上限只能在网页的关注里改，采集端内嵌的关注页就能改。服务端没有返回 `spent`、`bought`、`items` 时显示为未知，不当作 0；`plan` 接口返回 404 时不显示条件表。买到东西时在扫描页的“动态”里记一条，只在本机显示。账号页用 `GET /api/v1/device/devices` 列出这个账号的设备（只读），用 `POST /api/v1/device/rename` 改本机名字，成功后同步更新本机保存的登录记录。
8. 离开任务时有租约用 `leave`；没有租约（执行器失效、租约丢失、重启后）或 `leave` 被拒时用 `refuse`，服务器对 `active` 的设备也接受 `refuse`，网页上这台设备显示为已拒绝并带原因。

本机文件（采集目录 `sweep/`）：`settings.json` 本机设置；`purchases.jsonl` 每次购买；`pending.json` 待回报。都不上传。重启后同一轮的本机已花和已处理的挂单从 `purchases.jsonl` 恢复。

本机购买记录（桌面端“扫货”页）比服务器多一种状态 `skipped`：没有向服务器申请预留就放弃了。原因取值：服务器的 `budget`、`item_limit`、`duplicate`，本机的 `max_spend`、`max_order`、`reserve_mesos`，以及 `stopped` 和上面的购买 `reason`。

## 5. 其他约定

- 错误码：未知或不属于本设备的任务、设备、预留 `404 not_found`；`409 not_invited`、`item_not_in_plan`、`price_over_cap`、`already_settled`、`reservation_expired`（过期超过 10 分钟）；设备令牌无效或已撤销 `401 login_required`；设备写入范围外的数据 `400 invalid_data`。
- 网页 `stop` 返回 `GET /api/v1/account/sweep` 的结构；设备的 `stop`、`refuse`、`leave` 返回 `{"ok":true}`。
- `Run.devices[].spent` 是该设备实际买到的花费；`spent_here` 是已买 + 持有中 + 未知/过期，作为本机 `max_spend` 的上限依据。`purchases[]` 里 `quantity`、`spent` 是计入本轮的数：已买为实际值，未买为 0，持有中、未知、过期为批准的全部。
- `settle` 的 `reason` 为 `[a-z_]{0,40}`；`location.owner` 为最多 24 字符的字符串或 null。
- 设备状态只在真正变化时发 `devices` 消息；心跳只在 `message` 变化时发 `sweep` 消息；消息流重连或积压后，所有已连接的客户端都收到全部三个主题，各自重新拉取。
- 采集端内嵌的账号页点“登录”时，本机网关返回 `/device` 授权地址并开始一次设备登录。
- 购买执行器随采集端一起打包。网页按 `client_version`（≥ 0.6.19）判断能否扫货，版本过旧时提示更新。

## 6. 实现情况（2026-10-29，主分支）

已完成：
- 服务端：迁移 `0033_devices_and_sweep.sql`、`0035_sweep_recent_pending.sql`；`devices.rs`（设备登录、令牌、迁移、数据、状态、我的设备）、`sweep.rs`（规则快照、预算与件数、租约、预留与回报、网页和设备接口）；账号消息流加在 `realtime.rs`。
- 采集端：`account_device.py`（浏览器登录与本机回调、令牌加密保存、设备接口、消息流）；`collector_sweep.py`（扫货引擎，模拟已删除）；`sweep_purchase.py`（购买接口，执行器加载失败时不可用）；`sweep_purchaser_windows.py` 与 `sweep_screen.py`（Windows 内测执行器）；本机网关映射与消息转发在 `collector_dashboard.py`；扫描器 `shop_callback` 钩子在子模块。
- 网页：`/device` 授权页；账号页“我的设备”；关注页“物品 | 扫货”页签、开始弹窗、“先买命中的”、嵌入模式；`web/js/lib/user-data.js` 共用一条账号消息流。
- 采集端桌面界面（`frontend/desktop/`）：合并头部、扫描页、扫货页（状态、本机开始、条件表、本轮进度、最近购买、本机设置）、账号页（改名、设备列表）；窗口可调大小，最小 880x740。

已验证：
- 服务端数据库测试 `tests/sweep.rs`（15 个），覆盖登录、迁移、撤销、两台设备共用预算、重复挂单、部分批准、过期与补报、规则版本、停止和到时、设备端的全轮数字与网页一致、规则快照接口、设备列表与改名。
- 采集端单元测试（引擎、登录、网关、桌面接口、扫描器钩子）。
- 网页 `web/tests/sweep.e2e.mjs`（桌面、390px 手机、嵌入采集端）、`desktop-workspace.e2e.mjs`、`scanner-desktop.e2e.mjs`（880x740）。
- `test_sweep_live_server.py`：在本机 127.0.0.1 启动服务端，用假执行器跑完整条链路：浏览器登录、改名、设备列表、空闲时的规则快照、同步关注、网页输入密码开始、采集端加入、预留、购买、回报，核对服务器账目和设备端拿到的全轮数字。

未验证（需要 Windows 真机和游戏）：
- 真实 pywebview 桌面窗口里的登录跳转和“扫货”页。
- 无边框窗口在 Windows 上能否拖边调整大小（pywebview 对 `frameless` 窗口可能不支持），所以头部另有“最大化/还原”按钮，双击头部空白也触发。
- 改名后 DPAPI 加密的登录记录更新。

## 7. 后续

### 2026-10-28 Windows 实机进展

已经在运行中的游戏完成选中一行、打开数量框、确认数量、读取总价并提交最终确认。测试商品为每份 1 个、价格 40 金币的红色药水；数量 1，最终确认总价 40，测试花费上限按总计 150 执行。游戏随后明确拒绝交易：账号内需有角色达到 15 级，且在此后经过 24 小时。当前角色 11 级，余额前后均为 412，库存前后均为 85。**未成交，花费 0；没有成功购买或背包变化样本。** 已停止购买重试，并关闭拒绝提示。

控制方面，游戏和采集器均以管理员权限运行，普通权限的输入脚本无法控制；通过标准管理员启动、前台线程关联与 `SendInput` 已实际操作成功。脚本每次输入前检查游戏进程、前台窗口和客户区边界，按键在 `finally` 释放。管理员权限不能解除游戏的交易条件。全屏取图在本机用 `ImageGrab` 成功，DXcam 当时未取得帧；这些结果不能外推为所有分辨率/客户端都兼容。

实机观察已落实为 `sweep_purchase_flow.py` 的购买状态机：
- 选择前及选择后核对完整挂单身份、价格、包装、装备属性、库存和可读余额；数量输入回读一致才继续，总价必须等于份数乘每份价格。
- 每个动作只发一次；旧画面、延迟确认不能重复点击。最终确认可能发出后，停止或超时也不能把结果改成“未买”。
- 识别到明确拒绝才回报未买；仅库存减少、弹窗消失或点击成功都不当成自己的成交。成功路径需要适配器提供与当前尝试及挂单对应的可靠成交证据。
- 取消/拒绝后必须看到同一商店恢复；超时、丢焦点或窗口无法确认就停止扫描。已经确认的成交/拒绝结果仍保留并结算。

`test_sweep_purchase_flow.py` 使用合成观察回归上述决策；这些测试不等于 Windows 画面识别或成功成交验证。引擎的 `test_collector_sweep.py` 覆盖未知结果停机、交易锁退出、不丢失已知结算，以及购买中停止/租约到期/规则改变的检查。

### Windows 内测执行器 v0.6.19

已接通真实设备、关注规则、共享预算、商店回调和 Windows 购买流程。设备令牌在此 Windows 电脑用 DPAPI 保存。真实巡店已经连续触发商店回调，读取本次新抓包后才执行匹配；网页与设备显示同一轮预算。网页 `trade_locked` 状态已补齐，账号共享模块进入带哈希的前端构建，避免旧 CDN 缓存使关注页无法打开。

支持默认位置的玩家商店及其分辨率缩放、非装备，按本次库存、剩余预算、每种剩余件数、本机单笔与总额限制计算购买份数。数量框输入并回读完整数字（含 0），单笔最多 9999 份；一份包含多个物品时，按包装内的实际件数扣减关注上限。每种累计数量和总预算由服务器核准；同一挂单本轮不重复买。

- 每次预留前读取当下余额，应用保留金币、本机总额与单笔上限。库存来自本次新抓包，屏幕显示售罄则不购买。最终数量和总价逐步回读，确认总价必须等于份数乘以每份价格，严格识别千位分隔符；点击前再查租约、截止时间和停止状态。
- 商品位置按本次封包原始顺序与屏幕六行的名称、包装和价格进行唯一对齐。需要滚动时先滚动、重新读取整页，再定位目标，不能用分类排序后的索引作为屏幕行号。
- 读取采用实际像素字模。陌生字形、重复页、窗口变化或未识别弹窗不会猜测。若购买前能确认标准商店和余额，但店名字形尚不支持，则不申请预留、直接跳过；购买开始后的识别失败仍停止。选中目标必须读到完整名称；其他行可用至少两个准确且有序的锚点定位。图鉴未收录的时装行不作名称锚点，但可读价格和包装仍须一致；它不影响其余已知行的唯一定位，也不能作为购买目标。店名和店主区域需持续一致。
- 只有本人余额恰好减少本次确认总价，同时对应行库存像素变化、同一商店恢复，才报告成交。单独库存下降或弹窗消失不能算成交。
- `PurchaseHalt` 穿过扫描器异常包装后仍持久关闭扫描意图，监督器不能把不确定购买当成网络错误自动重试。已发最终确认而无法确认结果按未知处理并占用预算；未发确认则未买。准备阶段失去窗口也离开本轮，防止自动重新加入。
- 扫描器位置/频道监听使用与采集器一致的接收后端。默认 Windows 只读收包；显式 WinDivert 配置仍可用。不需要修改驱动服务的启动方式。

Windows 已另行核对一笔小额手动成交：Stirge Wing 单价 22，买一份，库存 163→162，本人余额 463917→463895。该证据用于构建字模和校验成交判据，不能冒充自动药水成交。

真实关注药水运行：橙色最高价 149、蓝色 219、白色 299；每种累计上限 200，总预算 100000。巡店观察到售罄及白色 300 的挂单会跳过。v0.6.18 已确认橙色 7 件、白色 5 件，总花费 2473；重启新轮次时扣除旧成交，将预算设为 97527，橙色剩余 193、蓝色 200、白色 195。

2026-10-28 v0.6.19 实机验收：19 洞 5 频道同一家商店，封包原始第 8 行橙色药水位于首屏之外。执行器从首屏点击向下滚动，按已知行唯一对齐到偏移 6；同页未收录时装不再导致整页失败。选中第二屏第 2 行，输入并回读 100，识别总价 14,000，最终确认一次；库存 100→0，本人余额 461422→447422。随后第二屏第 1 行受剩余件数上限限制，输入并回读 93，确认总价 13,020；库存 100→7，余额 447422→434402。两笔服务端结算均为已买，总计 193 件、27020 金币；与旧成交累计橙色正好 200 件，总花费 29493，余额度 70507。多份购买和滚动后成交均有真实画面、实际扣款及服务端记录，不以合成测试替代。

数量框的数字 0、确认总价的千位逗号均由真实画面补齐字模。格式修复前的批量尝试全部在最终确认前取消，记录为未买、花费 0；不会误算作已成交。

原始画面、封包、设备凭据及购买日志仅留本机；仓库只包含控件模板和字模。`test_sweep_screen.py` 覆盖滚动重定位、缺失图鉴行、完整名称、多位份数、千位金额、错误数字、本人余额证据、停止、保留金币与最终确认只点击一次；合成测试不代替游戏成交。

### 待完成

1. **扩大 Windows 执行器支持**：装备、不同商店布局与低分辨率文字重建；背包满、账号交易锁、店主关闭等明确拒绝画面的专门识别。目前陌生弹窗按未知/停止处理，不臆测错误原因。
2. **真机联调**：一台电脑完整跑一轮小预算扫货；两台电脑同时参加同一轮，核对共享预算；退出账号、网页撤销、断网、关游戏各试一次，确认都会停止购买且回报不丢。
3. **发布**：
   - 先把扫描器子模块的提交推到 `cwscreenscanner`，再推主仓库，否则主仓库引用的子模块提交取不到。
   - 迁移 `0033` 已随服务端发布并备份。本次带迁移 `0035`（给 `sweep_run_devices` 加一列），发布时用 `--backup-database`；以后只有再次迁移或高风险数据变更才备份。
   - 服务端先上线，再推新版采集端；旧版采集端用的 `/api/v1/collector/*` 接口保留，可以继续同步关注。
   - 执行器首版使用 `publish_collector_release.py --channel beta`，只写 `beta.json`，保留稳定通道。稳定更新器拒绝 beta 清单；内测安装需手动选取版本。
4. 旧的绑定码接口 `/api/v1/collector/account-link` 等，在大部分采集器升级后删除。
5. 采集端“关注”页签上的命中数角标、账号页的“关注已同步 N 件”：采集端现有状态里拿不到这两个数，先没显示。

### 不限数量（v0.6.20）

关注卡片可选“数量不限”。`buyLimit: 0` 与计划 `limit: 0` 表示取消该物品的累计件数上限；缺省仍为 1，有限数量仍为 1–9999。同步、服务端预留和采集器统一保留显式的 0。预算、设备最高花费、保留金币、单笔额度、当前库存和价格校验仍生效，单个 Windows 数量框仍最多输入 9999。旧采集器不接受 limit=0 的计划，会停止购买；需使用 v0.6.20 或更新版本。变更关注条件后需停止并启动新轮次。


### 扫货确认与背包（v0.6.21）

网页确认页逐项列出本次关注扫货的最高单价、筛选条件和数量上限，默认运行 7 天；网站、采集器和 API 统一允许 5–10080 分钟。运行中可查看冻结的本轮条件，修改关注后显示“扫货条件已修改，停止后重新开始生效”。旧页面调用 apply 也不能改变本轮规则。原有预算和购买记录继续有效。

设备状态可携带 `sweep.holdings: null | {observed_at,mesos,categories,items:[{item_id,quantity}]}`。金币余额与扫货预算分开显示；多设备分别显示，不把不同角色的背包相加。缺失、离线或未验证的库存显示未知，不伪造 0。此数据只在所属账号的设备接口中返回，不进入公开报价、原始上传或市场统计。

`market_inventory.py` 使用现有只读 TCP 重组和解码结果，解析完整角色包 0x1a6/0x1a9 的金币及普通消耗、设置、其他背包连续记录（类别 2/3/4）。只接受唯一结构边界、顺序槽位、容量和完整终止符。装备、现金物品、空消耗背包及其他未验证布局暂不宣称已读到库存。0x72 的数量更新、移动、添加、删除按整包原子应用，0x7e 已验证的独立金币更新读绝对余额。未知库存或金币格式会清除相应当前数据，不由购买意图或预算估算余额。断线、重组缺口、关闭捕获会失效；读取端拒绝超过 15 秒没有心跳的本地文件。

已实测角色完整快照、背包整理、同种药水合并以及一笔 69 金币购买：金币 434402→434333，铜矿 2→3，三种药水总数保持橙 489、蓝 108、白 262。真实原始包和角色数据仅留本机，不纳入仓库或发布包。仓库测试使用合成协议夹具。

### 近期命中店铺与拒绝恢复（v0.6.22）

关注页分为“全市场扫货”和“近期命中扫货”。近期入口默认过去 1 小时，可选 10 分钟、30 分钟、1 小时、6 小时、24 小时。启动时把 `scan: {mode: "recent", recent_minutes: 60}` 与关注条件一起冻结；市场模式为 `{mode: "market"}`，旧请求默认市场模式。修改范围或条件仍需停止后重新开始。

仅上报 `sweep.recent_scan: true` 的新版采集器可接受网页近期任务。`GET /api/v1/device/sweep/targets` 验证账号和当前有效设备租约，读取所选窗口内仍有库存、满足最高价格的真实封包报价，不使用关注页的展示截断。客户端再次验证完整条件、累计库存与位置，并按最近命中排序、合并同洞同频道的导航。每个目标频道完成后即切换下一处，未完成的扫描不会计为完成。只允许目标店主参与该模式的购买，到店后的新封包、可见商品、数量和总价仍需全部验证。相同报价至少间隔 5 分钟再回访；报价变化或新命中可进入后续队列。队列为空时等待新命中，网页继续显示设备活动和实际已检查店次。

新接受的网页任务会启动实际扫描器；近期模式从原有全市场扫描切换时，先停止旧输入线程，确保同一时刻只有一名输入执行者。用户手动停止不会被同一轮任务立即重启。预算、未知结果预留和购买数量计费逻辑保持不变。

修复真实店铺标题 `CHEAP CHEAP EQUIPS N POTS` 缺少大写 Q 字形导致的跳过。非字库标题不猜文字：由本次前台访问关联的新封包建立身份，逐帧要求标题和店主像素不变，并保留整页唯一定位、完整商品名称/价格/份数、最终总价和实际扣款证据。已验证的游戏拒绝提示 `The room could not be found.` 识别为商店不可用，确认后只关闭一次，记未买并跳过该店余下商品；其他陌生弹窗仍停止，不能推测成交。模板只含错误提示和控件，不含角色截图。


## 统一扫货（0.6.26）

新入口仅保留开始扫货。网站及桌面均提交 priority 模式，同账号每轮共享物品条件、数量限制、总预算和结束时间；设备选择仅控制参与。旧本机金额限制和网页启动开关不影响新模式，旧模式运行中的任务保留原行为。

priority 固定取最近 180 分钟的有效命中，按频道及洞合并，一次扫描整个洞并按冻结条件购买所有店铺的符合项。目标扫完或没有命中时直接进入全市场；手动停止和购买停止仍立即生效。旧客户端不允许参与新模式，需更新后再开始。背包与金币按设备持续刷新，修改关注条件后须停止重开。

## 2026-10-30 背包确认

扫描建立抓包连接后，先打开背包，核对画面金币与完整的消耗、安装、其他栏抓包数据，再关闭背包。飞镖和子弹记录包含额外的 8 字节；已验证的现金宠物刷新不使普通栏失效，不含金币字段的角色状态更新不清空金币。未知布局仍保持未知。

每次确认购买并完成结算后，先验证商店关闭，再打开背包，检查金币和本次物品数量增量，关闭背包并立即上报。当前商品仍支持一次购买多份；背包核对后结束本次店铺访问，其余商品留待后续访问。核对失败停止输入，保留已经确认的成交，不能重复结算或补买。游戏窗口、前台或位置变化沿用扫描器输入保护。诊断仅保留本机一张失败画面，不上传。

背包窗口使用独立标题及金币标签识别，支持原始画布和全屏缩放。金币字形为 Windows Tahoma 11 的非抗锯齿数字模板，与商店字体分开。

### v0.6.31 购买分辨率适配

购买截图统一映射到 1366×768 参考画布，滚动、商品行、购买、数量确认、交易确认和取消的坐标通过同一变换映射回实际客户区。每次输入仍检查前台窗口及原始客户区边界；购买中改变分辨率立即停止，不使用旧坐标。

原尺寸保留逐像素控件和字形校验。缩放画面校验独立成对控件，数字采用多阈值和轻度锐化后的完整精确字形匹配，候选不唯一即拒绝；不采用最近数字、截断识别或从抓包价格补齐未知文字。1366×768、1600×900、1920×1080、2560×1440 覆盖数量和带千分位总价的合成缩放回归。真实 1920×1080 商店验证按钮、余额和可售商品读取；这不等同于各尺寸都已完成真实成交。1280×720 等缩小后丢失笔画的画面可能安全拒绝金额，不承诺任意缩放比例均可购买。

### v0.6.32 数量光标与超时恢复

真实 1920×1080 数量框显示 `54` 时，清除空白字形行会把末尾输入光标裁短，导致原本可排除的光标被当成未知数字。现在先识别独立单列长光标，清理边缘后保留其高度，继续完整回读数字。回归包含四个尺寸下光标显示/隐藏及 54、100、193、200；真实数量 54 和总价 21,546 均已核对。

付款前超时只允许取消已识别的数量框或总价框，随后最多两秒等待同一店铺恢复；成功恢复返回未买超时并继续扫描。未知弹窗、失焦、窗口移动或取消后仍未恢复继续停止。已发出付款确认的超时仍报告未知、停止，绝不重新提交。取消动作不再被购买额度截止时间拦截。

### v0.6.33 成交后关店回退

真实成交 45 个龙血后发现 Esc 关店助手会返回 False 请求按钮回退，但购买执行器将其直接视为失败。现在重新核对商店及无购买弹窗后，按缩放坐标点击离店按钮，仅在客户区不变、连续两帧无商店/菜单/提示框时才打开背包。真实核对龙血 8→53、金币 756,948→738,993；交易记录保留实际 45 个、17,955 金币。

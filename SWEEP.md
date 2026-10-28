# 设备登录、多端同步与扫货

账号是唯一身份。网页和每台登录的采集端都是这个账号的一台设备，看同一份数据。网页决定买什么、什么时候开始；真实购买只在本机同意的采集端上执行。购买本身是一个接口，Windows 上的游戏内购买执行器另行实现；没有执行器的电脑不能参与扫货。

本文件是服务端、采集端和网页三方共同遵守的契约。错误一律返回 `{"error":"<code>"}`，沿用现有写法。

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

- 扫货规则：关注里勾了“扫货”的条件组，加每件物品的“本轮最多买”（`buyLimit`，件，默认 1）。只有固定最高价、百分位为 `all`、装备条件不是 `missing` 的组可以扫货。
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
 "started_at","ends_at","started_by":"web|<device id>","plan_version","plan_stale":false,
 "items":[{"item_id","limit","units"}],
 "devices":[{"id","name","state","message","online","spent"}],
 "purchases":[Purchase]}
```
`run` 是运行中的任务，没有时取 24 小时内最近结束的一个。`plan_stale` = 按当前规则重新生成的快照与任务快照不同。`purchases` 为最近 50 条预留，新的在前：

```json
{"id","device","item_id","status":"held|bought|not_bought|unknown|expired","quantity","units","price","spent","reason","room","channel","owner","created_at","settled_at"}
```

`POST /api/v1/account/sweep/start`（`sensitive`：需当前密码，Google 账号需 15 分钟内登录过）
- `{"devices":[id],"budget":1000000,"minutes":120,"current_password":""}`
- 设备 1-8 台：属于本账号、未撤销、在线、`state.sweep.allow_web_start` 为真、`state.sweep.executor.ready` 为真，否则 `device_unavailable`。
- `budget` 1 到 10^12 整数，`minutes` 5 到 720。已有运行中任务 `sweep_running`。
- 返回同 `GET /api/v1/account/sweep`。

`POST /api/v1/account/sweep/stop`（`writable`，不需要密码）`{"run"}`，`stop_reason='stopped_on_web'`。

`POST /api/v1/account/sweep/apply`（`sensitive`）`{"run","current_password"}`：按当前规则重新生成快照，不同则 `plan_version + 1`。

### 设备接口（设备令牌）

`POST /api/v1/device/state` 上报本机状态，存为设备的 `state`：

```json
{"client_version":"0.7.0","sweep":{"allow_web_start":false,"max_spend":0,"max_order":0,"reserve_mesos":0,
 "executor":{"ready":false,"reason":"此电脑尚未安装购买执行器"},"game":{"connected":true}}}
```
即 `DeviceState`。数值为 0 到 10^12 的整数，`reason` 最多 80 字符。

`GET /api/v1/device/sweep` → `{"run":null}` 或

```json
{"run":{"id","status","budget","remaining","ends_at","started_by","plan","plan_version",
 "participant":{"state","message","plan_version"},"spent_here"}}
```
只返回本设备处于 `invited` 或 `active` 的运行中任务。

`POST /api/v1/device/sweep/start` 本机发起：`{"budget","minutes"}`，参与设备只有本机，不需要密码（在电脑前操作即同意）。返回同上。

`POST /api/v1/device/sweep/join` `{"run","plan_version"}` → `{"lease","expires_in":30}`。`plan_version` 必须等于当前版本（`plan_changed`）。规则更新后用新版本再调用一次 `join` 确认。

`POST /api/v1/device/sweep/refuse` `{"run","reason"}`。

`POST /api/v1/device/sweep/heartbeat` `{"run","lease","status":{"message","checked"}}` → `{"plan_version","remaining"}`；任务已结束 `409 {"error":"sweep_stopped","reason":...}`；租约无效或过期 `409 lease_lost`。

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

`sweep_purchase.py` 定义接口，采集端的扫货引擎调用，Windows 执行器以后实现。

```python
PurchaserStatus(ready: bool, reason: str, mesos: int | None)
PurchaseOrder(reservation, item_id, name, category, slot, price, bundle, quantity,
              equipment, shop_id, owner, room, channel, deadline)
PurchaseResult(status: 'bought'|'not_bought'|'unknown', quantity=0, spent=0, reason='')

class Purchaser(Protocol):
    def status(self) -> PurchaserStatus: ...
    def buy(self, order: PurchaseOrder, window: ShopWindow) -> PurchaseResult: ...
```

实现必须遵守：
1. 在扫描器输入线程上、该商店窗口打开时被调用。不打开、不关闭商店，返回时窗口保持打开。
2. 点击前确认 `(category, slot)` 这一行仍是同一物品、价格、包装和属性，否则返回 `not_bought/price_changed`。
3. 不买超过 `quantity` 份，不花超过 `quantity * price`。
4. 在 `deadline`（`time.monotonic()`）前返回。点了购买但无法确认结果时返回 `unknown`。
5. 只有确认买成（例如收到商店行更新或背包变化封包）才返回 `bought`。
6. `reason` 取值：`sold_out`、`price_changed`、`not_enough_mesos`、`inventory_full`、`shop_closed`、`window_lost`、`timeout`、`error`。

`ShopWindow` 由扫描器提供：`bounds`、`capture()`、`click(x, y)`、`press(key)`、`pause(seconds)`、`vision`、`capture_file`（本次商店抓包文件路径）。

`load_purchaser()` 尝试导入 Windows 执行器模块，失败返回 `UnavailablePurchaser`，其状态为 `ready=False`、`reason='此电脑尚未安装购买执行器'`。

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
   - 结果为 `unknown` 时本机离开本轮任务。
5. 任何一步连不上服务器超过 30 秒、租约丢失、任务结束、退出账号：立即停止购买。
6. 拿到预留后、调用 `buy` 前再确认一次仍在扫货且租约未变；停止或退出恰好发生在预留途中时，不买，回报 `not_bought/stopped`。
7. 退出账号的顺序：停止购买 → 等正在进行的购买结束（最多 40 秒）→ 把待回报的结果报完 → 注销令牌。回报遇到 401 不丢弃，留在待回报队列里，24 小时后清除。
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

## 6. 实现情况（2026-10-28，分支 `sweep-live-20261028`）

已完成：
- 服务端：迁移 `0033_devices_and_sweep.sql`；`devices.rs`（设备登录、令牌、迁移、数据、状态、我的设备）、`sweep.rs`（规则快照、预算与件数、租约、预留与回报、网页和设备接口）；账号消息流加在 `realtime.rs`。
- 采集端：`account_device.py`（浏览器登录与本机回调、令牌加密保存、设备接口、消息流）；`collector_sweep.py`（扫货引擎，模拟已删除）；`sweep_purchase.py`（购买接口，未安装执行器时不可用）；本机网关映射与消息转发在 `collector_dashboard.py`；扫描器 `shop_callback` 钩子在子模块。
- 网页：`/device` 授权页；账号页“我的设备”；关注页扫货面板；`web/js/lib/user-data.js` 共用一条账号消息流；桌面端“扫货”页。

已验证：
- 服务端数据库测试 `tests/sweep.rs`（10 个），覆盖登录、迁移、撤销、两台设备共用预算、重复挂单、部分批准、过期与补报、规则版本、停止和到时。
- 采集端单元测试（引擎、登录、网关、桌面接口、扫描器钩子）。
- 网页 `web/tests/sweep.e2e.mjs`、`desktop-workspace.e2e.mjs`，桌面与 390px 手机宽度。
- `test_sweep_live_server.py`：在本机 127.0.0.1 启动服务端，用假执行器跑完整条链路：浏览器登录、同步关注、网页输入密码开始、采集端加入、预留、购买、回报，核对服务器账目。

未验证（需要 Windows 真机和游戏）：
- DPAPI 令牌加密保存（只测了非 Windows 的文件回退和模拟的加密调用）。
- 真实 pywebview 桌面窗口里的登录跳转和“扫货”页。
- 扫描器接着游戏跑时，钩子在真实商店窗口里的调用时机。

## 7. 后续

1. **Windows 购买执行器** `sweep_purchaser_windows.py`，提供 `create()`，按第 4 节实现 `Purchaser`。要在游戏里确认：
   - 商店窗口里选中某一行、点购买、数量对话框、确认的完整操作，以及每一步的画面识别。
   - 判断买成的依据，例如商店行库存变化或背包变化的封包，以及没有收到确认时多久判为 `unknown`。
   - 读取当前金币（供 `reserve_mesos`）和背包空格（供 `inventory_full`）。
   - 价格或物品在点击前变化、店主关店、金币不足、背包满时各自的画面和处理。
2. **真机联调**：一台电脑完整跑一轮小预算扫货；两台电脑同时参加同一轮，核对共享预算；退出账号、网页撤销、断网、关游戏各试一次，确认都会停止购买且回报不丢。
3. **发布**：
   - 先把扫描器子模块的提交推到 `cwscreenscanner`，再推主仓库，否则主仓库引用的子模块提交取不到。
   - 有数据库迁移 `0033`，发布时加 `--backup-database`。
   - 服务端先上线，再推新版采集端；旧版采集端用的 `/api/v1/collector/*` 接口保留，可以继续同步关注。
   - 执行器完成前，新版采集端可以照常发布：没有执行器就不会参加扫货。执行器的第一版先在内测通道发布，不推稳定通道。
4. 旧的绑定码接口 `/api/v1/collector/account-link` 等，在大部分采集器升级后删除。

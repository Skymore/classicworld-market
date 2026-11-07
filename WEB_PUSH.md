# 关注提醒的手机推送（Web Push）

页面关着也能收到关注提醒：Android Chrome、iOS 16.4+ 主屏幕网页应用、桌面浏览器。用标准 Web Push（VAPID，RFC 8292；`aes128gcm` 加密，RFC 8291），不做原生 App。服务端代码在 `server/crates/market-web/src/push/`，表在迁移 `0036_web_push.sql`。

## 使用前提

- Android：Chrome，网页里点“开启推送”并允许通知。
- iOS / iPadOS 16.4+：Safari 打开网站 → 分享 → 添加到主屏幕 → 从主屏幕图标打开 → 在这个主屏幕应用里登录（和 Safari 的登录分开）→ 关注页点“开启推送”并允许 → 点“发送测试”确认。Safari 标签页里没有推送。
- 桌面：Chrome、Edge、Firefox、Safari 16+。
- 必须登录。推送随登录会话存在：在这台浏览器退出、退出所有设备、改密码、找回密码、会话过期（90 天），都会删掉对应订阅。在这台浏览器上改密码时，网页会用同一个 `PushSubscription` 自动重新订阅；其他情况需要重新登录后再点“开启推送”。

## 接口

错误统一为 `{"error":"<code>"}`：未登录 `401 login_required`；缺少或错误的 CSRF/Origin `403 invalid_request`；参数不对 `400 invalid_request`；未配置密钥 `503 push_unavailable`；超频 `429 rate_limited`。写接口沿用账号写接口的检查（会话 cookie、`Origin`、`X-CSRF-Token`）。

| 接口 | 请求 | 成功 |
|---|---|---|
| `GET /api/v1/push/config` | 无需登录 | `{"enabled":true,"public_key":"<base64url，65 字节未压缩 P-256 公钥>"}`；未配置 `{"enabled":false}` |
| `GET /api/v1/account/push` | 会话 | `{"subscriptions":[{"id","label","lang","created_at","last_sent_at"}]}`，时间为 RFC 3339 字符串，`last_sent_at` 可为 `null`；只列有效会话的订阅 |
| `POST /api/v1/account/push/subscribe` | `{"endpoint","keys":{"p256dh","auth"},"label","lang":"zh\|en"}`（`PushSubscription.toJSON()` 的其他字段忽略） | `{"id"}` |
| `POST /api/v1/account/push/unsubscribe` | `{"id"}` 或 `{"endpoint"}` | `{"ok":true}` |
| `POST /api/v1/account/push/test` | `{"id"}` | `{"ok":true}`；推送服务 404/410 或 id 不存在 → `410 push_expired`（订阅已删）；其他失败 → `502 push_failed` |

订阅规则：
- 按 `endpoint` 去重；同一 endpoint 已属于别的账号时改归当前账号（换新 id）。每账号最多 10 个，超出删最旧的。订阅绑定当前会话（外键 `ON DELETE CASCADE`）。
- 校验：`endpoint` 为 `https://`、≤ 1024 字符、默认端口、无用户名，主机是 `fcm.googleapis.com`、`push.apple.com`、`push.services.mozilla.com`、`notify.windows.com` 之一或其子域；`p256dh` base64url 解码为 65 字节且在 P-256 曲线上；`auth` 16 字节；`label` 去首尾空白后 ≤ 40 字符、无控制字符；`lang` 缺省 `zh`。
- 频率：订阅每账号每分钟 20 次；测试推送每订阅每分钟 3 次。
- 退订在未配置密钥时也可用，只删本账号的。

推送载荷（Service Worker 解密后）：`{"title","body","url","tag","icon":"/web/icons/icon-192.png"}`。

静态文件：`/sw.js`（`web/sw.js`，`text/javascript`）、`/manifest.webmanifest`（`web/manifest.webmanifest`，`application/manifest+json`），均 `Cache-Control: no-cache`。CSP 加了 `manifest-src 'self'`。

## 网页

- `frontend/src/lib/push.ts` 注册 `/sw.js`（scope `/`），判断支持情况，订阅和退订。`embed=1` 和本机网关（127.0.0.1/localhost）不注册，本机网关保留原来的“允许浏览器通知 / 发送测试通知”。
- 关注页通知栏按顺序判断：iOS 没从主屏幕打开 → 浏览器不支持或服务端没启用 → 已被阻止 → 未登录 → 已开启（“发送测试”“关闭”）或可以开启（“开启推送”，在点击里请求权限）。
- 本机在 `localStorage` 的 `push.subscription` 记下 `{id, endpoint}`。浏览器里已没有这个订阅、账号推送列表里没有这个 id、或未登录时清掉。有这条记录时，页面不再自己弹关注提醒的系统通知（站内提示照旧），避免和推送重复；`/alerts` 的采集提醒照常弹。
- 页面自己的系统通知也走 `registration.showNotification`（Android 只支持这种），没有 Service Worker 时才用 `new Notification`。
- `web/sw.js`：收到推送显示通知（带 tag 时 `renotify`），图标和跳转地址只接受本站路径；点击时聚焦已打开的窗口并跳到 `url`，没有就新开。没有离线缓存和 fetch 处理。
- 账号页“我的设备”列出推送订阅，可以移除；这台浏览器标“这台浏览器”。在这台浏览器上退出登录前先退订。
- `web/manifest.webmanifest`、`web/icons/`（192/512、maskable、180 apple-touch-icon、96 状态栏图标，从 `assets/app-icon.svg` 生成）。首页模板 `web/index.html` 和服务端直出页面（`bestiary/pages/shell.rs`）都带 manifest 和 apple-touch-icon，任何页面添加到主屏幕都有正确的名称和图标。

## 推送规则

后台每 30 秒一轮（`push::run`），只处理有效会话下有订阅的账号。多个进程同时运行时（例如发布时的候选进程）用 PostgreSQL advisory lock 保证只有一个在跑。

1. 关注来自 `account_data` 的 `kind='watch'`。只看 `notify` 为真的条件组；旧格式没有 `groups` 时用 `cap/notify/reminder` 组成默认组；`groups: []` 不提醒。
2. 对这些物品调用 `views::watch_listings`，在 `grouped_listings` 上按网页同一套规则找命中（`push/matching.rs`，移植 `watch-reminders.js` 的 `watchGroups`、`reminderSelection`、`prepareReminderRows` 和 `item-offer-filters.js` 的提醒条件；百分位只用 `percentile_caps`（服务端已向上取整），没有时不命中；加成用 `base_stats`）。
3. “新”报价：观察时间晚于 `max(账号开始时间, 上一轮游标 − 120 秒, 现在 − 10 分钟)`。120 秒重叠覆盖上传延迟。账号第一轮只记游标。游标存 `push_cursors`，重启不丢；账号没有订阅后删除游标，下次订阅重新从安静的第一轮开始。
4. 去重键：sha256(店铺、物品、单价、包装、装备属性)，不含时间和访问号。发送前写入 `push_deliveries` 占用，24 小时内同一账号不再推；每轮清理 24 小时前的记录。
5. 合并：一轮里每件物品一条，`tag` = `watch-<item_id>`，`url` = `/item/<item_id>`。
   - 一条报价：标题“关注提醒”，正文“红色药水 · 41 · 库存 100 · 12频道 3洞 · 店名”（价格同网页 K/M 写法；库存未知写“库存未知”）。
   - 多条：“红色药水 · 3 条新报价 · 最低 41”。
   - 超过 3 件物品：只发一条“5 件关注有新报价”，`url` = `/watch`，`tag` = `watch-summary`。
   - 英文订阅：“Watch alert”，“Red Potion · 41 · stock 100 · CH 12 room 3 · Shop”，“Red Potion · 3 new offers · from 41”，“5 watched items have new offers”。物品名取 items 表 zh/en。
6. 发送：不跟随重定向，超时 10 秒；`TTL: 600`、`Urgency: normal`、`Topic`（tag 的 sha256 base64url 前 32 字符）、`Content-Encoding: aes128gcm`；`Authorization: vapid t=<ES256 JWT>, k=<公钥>`，`aud` 为 endpoint 的 origin，`exp` 为 12 小时后，`sub` 来自配置。2xx 更新 `last_sent_at`；404/410 删除订阅；429/5xx/网络错误/其他状态本轮跳过该订阅的剩余消息。
7. 投递最多一次：报价已占用去重键后，即使这轮发送失败也不重推。

网页与服务端的匹配规则由共享样例 `web/tests/fixtures/watch-match.json` 保持一致：`web/tests/watch-match-parity.test.mjs` 用真实的 `watch-reminders.js` 计算，`push::matching` 的单测读同一文件。改任一边的规则时同时改样例。

## 密钥配置

- `WEB_PUSH_CONFIG`：JSON 文件 `{"private_key":"<base64url 32 字节>","subject":"https://mxd.ruit.me"}`。设置了路径但文件不存在时，服务启动生成新密钥写入（Unix 权限 0600，不覆盖已存在的文件）。`subject` 可省略，必须是 `https://` 或 `mailto:`。
- `WEB_PUSH_PRIVATE_KEY`：优先于文件里的密钥；此时不生成文件，`subject` 仍取文件（有的话）。
- 都没有：推送关闭，`/api/v1/push/config` 返回 `{"enabled":false}`。
- 配置文件损坏或密钥非法：服务启动失败（与 OpenRouter、Google 登录配置一致）。
- 换密钥会让所有现有订阅失效（推送服务会拒绝），用户需要重新开启。不要随意删除 `shared_data/web_push.json`。

## 部署

1. `deploy_market.py` 的 `web_environment` 默认传 `WEB_PUSH_CONFIG=shared_data/web_push.json`（文件不存在也传）；`shared_supervisor.py` 用同一函数，不需要单独配置。
   已在运行的 supervisor 会保留启动时导入的旧函数。首次发布推送功能时，须同步这两行环境配置到本机部署脚本，并用 `--adopt-running` 接管现有子进程重新启动 supervisor；只切换网站版本不会重新导入 Python 模块。接管前后核对数据库、网站和隧道的进程号保持一致，再执行网站发布。
2. 第一次发布时候选进程会生成 `shared_data/web_push.json`，之后正式进程读同一文件。该文件在 `shared_data/`，不进发布包（`test_market_deploy.py` 有断言）。
3. 这次发布含迁移 0036（只新建三张表）。按 `AGENTS.md`，含数据库迁移的发布使用 `--backup-database`。
4. 发布后检查：`curl https://mxd.ruit.me/api/v1/push/config` 返回 `enabled:true`；`/sw.js`、`/manifest.webmanifest` 返回 200 和正确类型；日志有 `web push enabled`。

## 表结构

- `push_subscriptions`：`id`、`public_id`（对外 id）、`account_id`、`session_hash`（→ `account_sessions`，级联删除）、`endpoint`（唯一）、`p256dh`（65 字节）、`auth`（16 字节）、`label`、`lang`、`created_at`、`last_sent_at`。
- `push_cursors`：`account_id`、`started_at`、`cursor_at`。
- `push_deliveries`：`account_id`、`offer_key`（32 字节）、`sent_at`。

## 实现情况

已完成并在本地验证：
- RFC 8291 附录 A 测试向量逐项一致（ECDH、CEK、nonce、86 字节头、密文）；随机加密可解密、篡改和错误 `auth` 被拒；VAPID JWT 用公钥（jsonwebtoken/ring）验签通过、换公钥失败。
- endpoint 白名单与密钥校验；订阅、去重、换账号、10 个上限、退订、列表、测试推送（成功、410、500/429/400、重定向不跟随、频率限制）；退出、退出所有设备、改密码、找回密码、会话过期后订阅被删。
- 匹配轮次：首轮只记游标；新报价推一条；同一报价重复观察不再推；`notify=false` 不推；同物品多条合并；超过 3 件发汇总；410 删订阅、其他订阅照常收到；超过 10 分钟的报价不推；另一进程持锁时本轮跳过；英文文案。测试用 127.0.0.1 上的假推送服务，用浏览器私钥解密载荷并验签。
- 网页规则对照样例 29 例，Node 与 Rust 结果一致。
- 网页：`web/tests/web-push.e2e.mjs`（打桩 Service Worker、PushManager 和接口，桌面与 390px 手机，覆盖各状态、订阅请求体、测试推送与 410、关闭、站内提醒不重复弹、退回 `new Notification`、账号页列表与移除、退出前退订）；`web/tests/sw.test.mjs`（Service Worker 的推送显示、只认本站路径、点击聚焦或新开）。
- 本机启动：密钥文件自动生成（0600），重启后公钥不变，配置接口返回公钥，两个根路径文件类型正确，监听仅 127.0.0.1。

未验证：
- 真实推送服务（FCM、APNs、Mozilla、WNS）的投递、`Topic` 替换和 VAPID 接受情况，需要上线后用真机（Android Chrome、iPhone 主屏幕应用）点“发送测试”确认。
- 真机上的 Service Worker、添加到主屏幕、开启/关闭和点击通知跳转：上线后在 Android Chrome 和 iPhone 主屏幕应用上各走一遍“使用前提”里的步骤。
- 个人采集器（本机 8780）尚未上传的报价服务端看不到，只有网页开着时才会提醒。

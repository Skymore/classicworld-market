# 枫叶市集服务（Rust）

## 页面数据传输

`/api/v1/market/overview?hours=72|all` 返回物品数量、涨跌榜和成交榜各前 8 项；
最新报价和成交继续使用各自的限量接口。`/api/v1/market/selected?ids=...&hours=72|all`
只返回指定物品，关注页不再下载全价格表。服务端每个周期仅保留一份当前版本的
解析结果与首页摘要，同一版本的并发请求复用计算。

图鉴快照、关注报价及上述小接口支持弱 ETag / 304，忽略响应生成时间和全站新鲜度
时钟，价格、库存、筛选结果和时段边界变化仍会改变验证器。物品修订号仍控制
服务端快照失效，原有 2 秒时效检查保持不变。HTML 首屏同时携带同一验证器；
缺省周期与 72h 使用相同前端缓存键，自动周期相同时不改写地址。
默认周期提示在内存中合并并发计算并缓存 5 分钟，不随全站上传版本失效。

回归包括 `http::page_delivery_revalidates_unchanged_items_and_limits_market_payloads`、
`delivery` 单元测试和 `web/tests/item-detail-loading.e2e.mjs` 的默认周期及初次 SSE 304 场景。

计划见 `../REDESIGN_PLAN_V2.md`。工作区三个 crate：

- `crates/market-core`：协议校验、定价、成交统计、读取器算法。无 IO，也编译成 WASM。
- `crates/market-reader-wasm`：把 `market-core` 的读取器包成浏览器用的 WASM（wasm-bindgen 只在 wasm32 目标下引入）。
- `crates/market-web`：axum 服务，sqlx + Postgres，嵌入 `migrations/` 并在启动时执行。

## 本地运行

```sh
cp .env.example .env            # 改 POSTGRES_PASSWORD
docker compose up --build web db
curl -s 127.0.0.1:8080/readyz   # {"status":"ok","database":"ok"}
```

不用容器跑服务时，只起数据库，再用 cargo：

```sh
docker compose up -d db
DATABASE_URL=postgres://market:<密码>@127.0.0.1:5432/market BIND=127.0.0.1:8080 cargo run -p market-web
```

端口只绑回环；对外走 `--profile tunnel`（cloudflared，token 放 `.env`）。

## 测试

接口性能抽样：`python tools/benchmark_api.py --base http://127.0.0.1:8766 --samples 3`
（从仓库根目录运行），可用 `--output` 保存结果、`--base https://mxd.ruit.me` 比较公网耗时。
它只访问公开读接口，不登录、不上传。服务为 API 返回 `Server-Timing`，超过 250ms 的请求
以路由模板记录为 `slow API request`，不记录查询参数、账号凭据或请求内容。
定向持续抽样可重复传入 `--path /api/...`，配合 `--samples 20 --interval 2.1`，
让采样跨过两秒快照缓存，检查服务运行一段时间后的延迟，避免只测缓存命中或刚重启的连接。
`python tools/summarize_api_performance.py --log <部署根目录>/shared_data/web.log --minutes 15`
汇总最近的缓存、慢请求与上传批次；支持带时区的 `--since` 和 `--output` 保存对比。
命中率按请求数加权，重建耗时除以重建数，其他平均耗时除以请求数。接口分位数只统计
已记录的慢请求，不代表全量流量的 P95；缓存区间按每分钟日志的结束时间纳入，边界最多相差一分钟。
旧日志没有记录的指标显示为 `null`，新增耗时指标只对实际记录该字段的区间求平均。
超过 100ms 的上传、完整名单和离场事务记录 `slow writer phases`：准备、写入连接等待、
全局锁等待、数据写入、统计重算、提交分别计时；未完成操作另记剩余耗时。只包含类型、
条数和耗时，没有采集者或物品标识。`slow watch phases` 同样拆分慢关注重建的报价读取、
分组和元数据读取。汇总脚本的阶段分位数仅覆盖这些慢操作，不能当作全量接口 P95。

贡献榜使用上传事务内维护的 `contribution_shop_rollups`：普通摊位读取汇总，关联设备
重复采集的摊位仍按完整报价状态去重；汇总过期后回退到精确窗口计算，后台分批续算。
账号合并、退出榜单、未来时间及滚动窗口边界仍立即生效。该表由 0030 迁移创建，
首次部署需数据库备份；旧程序回滚后，数据库触发器仍持续维护新增汇总。
0037 迁移将过期汇总的回退查询限制为逐摊位索引查找，避免规划器为少量过期摊位
扫描全部贡献状态并对时间窗口做哈希连接。保持精确去重及滚动窗口边界；
`expired_rollup_reads_only_its_shop_states` 用执行计划验证不会读取其他摊位的历史。

商品卡片使用 `/api/v1/catalog/page?preview=true&url=...` 的轻量快照，沿用价格表的
预计算价格口径和刷新周期，不查询历史曲线、完整在售列表或掉落地点。
周期统计每批 16 个商品释放写锁，不再每分钟重扫观察历史和重新计数；完整重建仍保留
在 `stats::refresh_all` 供导入和修复调用。

物品完整页在 HTML 中附带已读取的公共详情快照，前端复用它，避免首屏后立即重复查询。
快照保留服务端生成时间，旧 HTML 仍按 15 秒新鲜度和 SSE 更新；装备属性筛选使用独立
查询键，账号保存的筛选不会被未筛选快照覆盖。折叠频道和未展开的装备卡片按需渲染，
完整报价仍保留。`web/tests/item-detail-loading.e2e.mjs` 覆盖首屏复用、2000 条报价的
折叠渲染、展开操作、SSE 和旧快照刷新。

并发上传由服务端收集最多 20 毫秒的小批次，每批最多 16 次上传，报价行累计到 256 后
停止收集。原有单次上传协议不变；每批只获取一次写锁、重算一次受影响商品统计、发送
一次变更通知。各上传保留独立保存点，重复、冲突和单条数据库错误不影响同批其他记录；
统计失败则整批回滚，提交前不返回成功。队列最多等待 128 次上传，满时返回可重试的
503，避免无界堆积。压缩和指纹计算在获取写锁前完成。每日统计只写入实际变化的日期，
删除已消失的日期；重复观察不再删除并重插全部历史，减少 WAL 和自动清理负担。
`tests/upload_batches.rs` 对照逐条处理结果，覆盖库存变化、乱序、跨采集器去重、冲突、
部分写入回滚、统计失败与安全重试，并验证多个上传只重算一次同一商品。

持续采集时，上传、位置修复和离场处理使用独立的单连接写入池；写锁等待不占用公共
读取连接，统计维护和 LISTEN 也使用独立连接。0031 的成交覆盖索引配合按物品排序，
减少统计查询读取宽表和磁盘排序；新增索引的首次部署需数据库备份。
完整详情、制作价格和公共关注报价合并相同版本的并发查询；三类读取使用独立的缓存槽
和并发限制，分别最多重建两份、一份、一份快照，避免慢详情占用制作和关注的刷新名额。
每类仍最多保留 32 个完整查询键，按最近使用顺序淘汰空闲条目；不同物品或筛选条件不再
因为落到同一个哈希槽而互相挤掉缓存或排队。构建中和已有等待者的条目不能淘汰；
32 个键都在使用时，新键仅在并发限制内临时读取，不扩大缓存。取消请求后可正常重建。
0032 为 `item_stats` 添加事务内更新的 `read_revision`：完整详情只比较该物品版本，
关注报价比较所有关注物品的版本；其他物品上传和统计刷新不再导致无关快照重建。
序列避免删除重建后版本被复用，触发器兼容旧程序回滚。相关物品提交后新请求立即
失效，事务回滚不失效；缓存仍最多保留两秒，保持时间窗口与独立元数据的刷新边界。
同一批排队请求可复用每个物品版本均不早于各自读取版本的结果，避免持续上传造成逐个重算。
制作价格涉及全市场，继续使用全局版本；个人账号与提醒数据不进入该缓存。
图鉴接口直接序列化响应外层，避免每次缓存命中还复制一次完整历史 JSON 树。
SSE 每秒最多通知一次市场变更，前端保留进行中的请求并补一次后续刷新，避免连续
采集反复取消、重发请求。无制作配方的物品不请求制作价格。
`tests/read_isolation.rs` 覆盖写锁排队时的读取隔离、快照合并与失效，以及 SSE 突发通知；
详情页浏览器测试同时覆盖慢请求期间的连续更新和最后一次变更。
`tests/item_cache_revisions.rs` 覆盖真实上传的按物品失效、未提交写入与回滚、删除重建、
首次采集、时间过期，以及提交期间的 16 个并发请求合并。0032 首次发布须备份数据库。

服务每分钟记录 `public cache interval`，按 item / crafting / watch 汇总请求、命中、
重建、容量淘汰、满载绕过、条目数，以及首次读取/到期/版本失效三种重建原因。
记录版本查询、等待同键结果、等待重建名额和重建总耗时，不包含查询键、物品或用户标识。
`tests/cache_capacity.rs` 覆盖旧哈希冲突重现、互不阻塞、最近使用淘汰和满载并发边界。
当前单进程部署保留有界内存缓存；优先解决失效范围与查询成本。需要多实例共享热点
快照、且测得跨实例重复重建成为瓶颈时再评估 Redis。更换缓存介质不能自动修复
全局失效，也不能缩短 PostgreSQL 写事务；上传成功仍以数据库提交为准。

历史报价与关注报价的联表查询先使用物品索引，再通过关联主键读取采集记录和摊位。
关联子查询保留 `OFFSET 0`，避免 PostgreSQL 在重复执行后切换通用计划时，因日期、
属性或物品数组参数估算失真而读取全市场、产生磁盘哈希临时文件。完整历史仍按日期、
摊位和槽位去重，属性过滤在去重前执行。`tests/prepared_reads.rs` 强制通用计划，
用 5000 个无关摊位检查实际读取行数，并覆盖迟到记录、同时间排序、日期边界、
未来记录、售光和属性筛选；性能回归不依赖测试机器的毫秒阈值。
名单核对和离场下架按房间、主人或摊位生成独立的参数化查询，避免可空 OR 条件在通用
计划下扫描全部摊位。下架先限制有主人的摊位范围，再读取其库存、观察记录和最早有效
离场证据；该证据只查询一次，库存删除与归档仍在同一事务。`tests/prepared_presence.rs`
用 5000 个摊位验证实际写查询只访问相关记录；原有迟到上传、严格时间边界和跨房间隔离不变。
关注报价转移已有 JSON 字段，并在只需报价 ID 的路径直接计算 ID；分组键直接序列化
引用，减少大报价和装备属性的重复复制。ID、排序、完整分组库存和全量百分位统计保持不变。
公共关注先对全量报价建立轻量分组，再仅为可能进入前 200 条原始/合并结果的候选计算
展示 ID 和对象；时间并列的所有候选都参与 ID 排序。被选分组仍合并全部槽位，百分位
仍覆盖全部分组。单元测试对比完整旧算法，覆盖并列、重复槽、未知装备、空库存和溢出。

本机 PostgreSQL 缓存可用 `python tools/tune_postgres_cache.py --root <部署根目录>` 查看；
在有足够可用内存的机器上，显式加 `--apply --shared-buffers 1GB` 将共享缓存从默认
128MB 调到 1GB。脚本保存配置副本，验证主分支、线上版本、数据目录和 supervisor，
短暂停止数据库让 supervisor 按新配置重启；启动失败则恢复配置。此操作不修改市场数据。

```sh
cargo test --workspace
```

`/healthz` 只说明进程活着，不碰数据库；`/readyz` 查一次数据库。

设了 `DATABASE_URL` 时，`tests/write_path.rs` 和 `tests/http.rs` 每个测试建一个临时库跑；没设就跳过。`market-core/tests/python_vectors.rs` 回放 Python 参考实现生成的用例（协议校验、定价、尾数 9、成交统计），改了任一边就重新生成：

```sh
python tools/gen_core_vectors.py
```

## 市场写读路径

接口路径、状态码、错误文本、限流和 JSON 形状沿用 `shared_server.py`，现有页面、采集器面板和 WinDivert 采集器不用改。

| 接口 | 说明 |
|---|---|
| `POST /api/v1/observations`（别名 `/api/v1/upload`） | 上传 v1 观察；新建 201，重复 200 `duplicate: true`，同 ID 内容不同 409，格式错 400，无令牌 401。可带 `source: packet\|screen`（默认 packet）和 `reader_version` |
| `POST /api/v1/register`、`/login`、`/logout` | 自动注册采集身份；登录写 `fm_session` cookie |
| `GET /api/v1/market?view=list` | 价格表；`hours=72\|all` |
| `GET /api/v1/market?summary=1`、`?item_id=N` | 摘要（不带挂单）、单个物品的挂单、成交、历史 |
| `GET /api/v1/item/<id>` | 物品页数据：摘要、72 小时挂单、最近 50 笔成交、每日中位 |
| `GET /api/v1/sales/recent` | 最近成交，`limit`、`before`、`item_id`、`category` |
| `GET /api/v1/items/<id>`、`/watchlist/catalog`、`/watchlist/listings` | 图鉴记录、关注搜索、关注挂单 |

每次上传先校验，再在批次事务的独立保存点中写观察和行（gzip 原文进 `uploads_raw`），重放这个摊位（重写它的 `listings`，增删它的 `sales`），版本号加一。批末统一重算受影响物品的 `item_stats`、`item_stats_all`、`item_daily`，然后一并提交。列表 ETag 由版本号得出，没变就 304。

成交统计的窗口终点是最新观察的下一分钟，72 小时报价窗口跟着墙钟走；这两样变了，没被上传碰到的物品也得重算。服务每 `STATS_REFRESH_SECONDS`（默认 60）秒检查一次，分批刷新过期的物品统计。

环境变量：`DATABASE_URL`；`BIND`（默认 `127.0.0.1:8080`，compose 在容器里设 `0.0.0.0:8080`，宿主只发布到回环）；`PUBLIC_READ`（默认 `true`，`false` 时读接口要令牌或登录 cookie，注册关闭）；`PUBLIC_HOSTNAME`（默认 `mxd.ruit.me`）。

## 旧数据重放与对照

```sh
export DATABASE_URL=postgres://market:market@127.0.0.1:5432/replay
cargo run --release -p market-web --bin seed_items -- ../data/fixture/items.sqlite
cargo run --release -p market-web --bin replay_uploads -- ../data/fixture/shared/market.sqlite
python tools/parity.py --now 1792390000
```

- `seed_items`：从 `items.sqlite` 写 `items` 和 `item_records`。只供测试和对照；正式导入由 R3 的 `import_catalog` 负责。
- `replay_uploads`：读旧库 `members`（令牌哈希照搬，旧采集器令牌继续可用）和 `uploads`，按观察时间逐条走写路径。`uploads` 为空时（开发 fixture 只有 `visits`）从 `visits` 还原 v1 上传。
- `parity.py`：把 `time.time()` 固定为 `--now`，用 Python 的 `Repository.report` 生成 72 小时和全部记录两份报表，再运行 `parity_dump --now` 读 Rust 的接口输出，逐项比较：各类成交数、在售数、报表头、每个物品的成交价、快卖 / 正常卖建议价和其余字段、`?view=list` 每个字段、最近成交前 20 页。有任何不一致就退出码 1。
- `bench_http.py`：对运行中的服务测上传和读接口延迟。会写库，指向副本。

开发 fixture 上的结果（2026-10-20）：6997 次上传全部接受；成交 drop 103 / sold_out 546 / found_sold 14521，在售 26156（72 小时）/ 57874（全部），1001 个物品所有字段两边一致。

和 Python 的已知差别，均不影响对照项：

- 时间存到微秒，Python 是浮点秒；对照按 1 微秒容差比较。
- 同一次观察里的重复格位（`category*1000+slot+1000000`）：`SharedStore.upload` 把它排在第一行旁边，`dev_fixture.py` 还原的 `visits` 排在最后。只影响同一时刻几笔成交在最近成交里的先后。
- 两次上传在同一微秒发现同一物品的成交时，Rust 按到达顺序排，Python 按访问 ID 排；这会影响哪笔算“最近一笔”（`last_sale_price`、`last3_avg`）和“最近 10 笔”的截取。fixture 里没有这种情况（唯一一对同时刻观察内容相同，不产生成交）。
- 不带参数的 `GET /api/v1/market` 返回摘要，不再返回全量报表（Python 返回每条挂单、成交和历史，fixture 上 214 MB）。

## MesoWatch 原始数据合并

取得来源授权后，将单品原始导出放在 `data/reference/mesowatch-market/<snapshot>/items/`，同目录保留 `list.json`。`python mesowatch_points.py <snapshot>` 生成 `points-import.json`，只将 `sales[]` 和 `listings[]` 转成证据点；汇总报价、分位数、每日中位数均不充当数据样本。原始文件及来源声明留在本地，manifest 保存每个单品的版本和文件哈希。先用离线快照导入，不会自动定时访问来源站点。

在设置 `DATABASE_URL` 的 `server/` 目录运行 `cargo run --release -p market-web --bin import_mesowatch -- ../data/reference/mesowatch-market/<snapshot>/points-import.json`。导入在事务内完成，再从本地和外部原始证据重算价格、分位数、趋势、成交记录数和建议价；同一来源 ID 的重复导入不增加权重，同 ID 内容改变则报冲突。目标库再次校验物品编号和英文名，不猜配名称不同的记录。

采集上传 v1 保持完整快照校验。读取接口新增 `evidence_schema_version: 2`、行级 `source` 和 `unit_basis`。外部成交没有观察/摊位/格位外键，`bundle`、库存、实际售出数量和此前观察时间允许未知。飞镖两边统一按组报价，其余按个；源 `qty` 只留原文，不能用来猜实际售出数量。装备参考属性不写成单件装备变体。

外部挂牌仅覆盖来源公开的有限样本，`up` 表示其最近访问仍在售，库存未知仍可作为报价证据。新版单品导出会停用该单品旧版本的挂牌样本。跨来源没有共同成交 ID，不能证明两条记录就是同一交易；统计的是推定成交证据记录，保留来源便于核对，不能宣称全市场去重后的真实成交量。

## 图鉴（R3）

表在 `migrations/0010_bestiary.sql`；`0011_bestiary_data.sql` 给物品加了繁中名 `name_tw` 和 `gms_id`，给 NPC 商店加了价格来源 `source`。

### 数据导入

在 `server/` 下按顺序执行。每个工具连上就先跑迁移，所以空库可以直接用；在已经导入过的库（比如 `dev`）上重跑，结果和空库一样：图鉴表整表替换，物品只更新不删除，`catalog_versions` 记下每份数据的版本。

```sh
export DATABASE_URL=postgres://market:<密码>@127.0.0.1:5432/market
cargo run --release -p market-web --bin import_catalog      # 物品、Mapledex、NiaDB（默认路径见下）
python3 ../tools/niadb_portals.py ../data/reference/niadb/maps.json --output /tmp/portals.json
cargo run --release -p market-web --bin import_portals -- /tmp/portals.json
cargo run --release -p market-web --bin reachability        # 从射手村能到几张地图，列出到不了的
```

开发库还要市场数据时，在 `import_portals` 之后跑 `replay_uploads`（见上面「旧数据重放与对照」，它只需要物品表已经导入）。`dev` 就是这样播种的：`import_catalog` → `niadb_portals.py` → `import_portals` → `replay_uploads`。

`import_catalog` 的参数和默认值：`--items ../data/fixture/items.sqlite`（市场见过的 1001 个物品，字段原样保留）、`--mapledex ../data/reference/mapledex`（`items.json`、`equips.json`、`monsters.json`、`maps.json`、`npcs.json`）、`--niadb ../data/reference/niadb`（`items.json`、`maps.json`、`npc-shops.json`，以及图鉴用的 `monsters.json`、`drops.json`、`mesos.json`，见规则 7）、`--zh-names ../data/reference/zh-names.json`（地图和 NPC 的简体名，见规则 6）、`--mapledex-version`、`--niadb-version`（写进 `catalog_versions`；`zh-names` 的版本取文件里的 `version`）。

导入规则：

1. 物品：items.sqlite 里有的照原样；其余来自 Mapledex（三种名字、需求等级和职业、`src` 存为 `gms_id`），Mapledex 没有的来自 NiaDB（只有英文名）。`category` 按 ID 前缀分栏，`subcategory` 按前缀给槽位名（与 DVG 给 1001 个市场物品的标注逐个一致），图标都用 DVG CDN `https://mxdgcw.dvg.cn/dbsource/icon/item/<id>.png`。装备的 `item_records.record` 另加 `niadb_reference.stats`（NiaDB `items.json` 里这件装备的 `stats`），因为暴击率、暴击伤害的基础值只有 NiaDB 有；物品页的基础属性和"加了多少"从这里读暴击两项。导入结束时 `records` 一行打印写进 NiaDB 属性的装备数。装备详情（物品页的资料条、报价行的游戏格式属性卡、快速预览的"装备资料"）由 `bestiary::equipment` 从同一条记录读：要求等级/力量/敏捷/智力/运气、职业、攻击速度和可升级次数先用 Mapledex，没有时用 DVG 的 `requirements`，再没有用 NiaDB；武器分类按 ID 前缀。接口里是 `page.equipment`（`/api/v1/catalog/page` 的物品页和快速预览都有），非装备没有这个字段。
2. 掉落（2026-11-02 起被规则 7 取代，下面是 Mapledex 掉落表本身的处理，只在不加 NiaDB 时生效）：Mapledex 只给了 GMS ID 的掉落，先找唯一带这个 `gms_id` 的物品，再在没有 GMS 对应的物品里找同类（装备按 ID 前四位，其余按前三位）、同名（英文只比字母和数字，或简体名）的唯一一个。CW 改过一些英文名（Windshoes → Wind Shoes、Steal Pow → Steel Pow），Mapledex 因此没配上。有物品的掉落一律用物品的名字。还找不到的保留 `gms_item_id` 和 Mapledex 给的 GMS 名字，`item_id` 留空：这些是 GMS v83 掉落表里 CW 客户端没有的物品（同号的 CW 物品是别的东西，比如 2040002 在 GMS 是头盔防御卷轴 10%，在 CW 是帽子命中卷轴），不能按号码硬配。
3. NPC：名字来自 Mapledex `npcs.json`，它没有的用 NiaDB 的英文名；NPC 商店来自 NiaDB `npc-shops.json`，没有 `classicPrice` 的不导入，`priceSource` 存进 `npc_shops.source`。
4. 地图：Mapledex 没有、NiaDB 有的地图连同刷怪、NPC 位置和回城点一起导入，回城边记为 `source = 'niadb'`。传送口仍由 `import_portals` 写（`source = 'wz'`），它只替换输入里那些地图的传送口；`import_catalog` 不碰 `wz` 边，两个工具互不覆盖。
5. 路线：回城卷轴算 3 步，代价相同时少用非步行步骤的路线优先，所以走 1–3 个传送口能到时不用卷轴，4 个以上才用。射手村 → 废弃都市仍是 5 个传送口加回城卷轴：按 NiaDB 的传送口，废都森林I 没有通往废弃都市的传送口，全程步行最少 10 步（经逆恩森林和废都南方工地）。来源里没有带票价的船和出租车，没有导入这两类边。
6. 地图和 NPC 的简体名：Mapledex 有简体名（`cw`）的照用，从不覆盖。没有的按 `zh-names.json` 填 `name_zh`，这个文件由 `tools/zh_names.py` 离线生成，`import_catalog` 只读它：先用 DVG 的名字（物品中文名也来自 DVG，和本服中文玩家看到的一致），条件是同一 ID 的 DVG 英文名和我们的一致（只比字母和数字；三个 NPC 拼法不同但地图位置相同，人工核过）；DVG 没有、但 Mapledex 有繁体名（`zh`）的，用 OpenCC t2s（`opencc-python-reimplemented==0.1.7`）转简体。两边都没有的保持英文，不自己翻译。DVG 的名字不用的情况写在 `zh-names.json` 的 `dvg_not_used`：占位名（`地图 80003000`）、名字里有繁体字（20000055 `天空楼梯Ⅱ天空階梯`，改用 Mapledex 繁体名转换）、英文对不上（900000000 我们是 White Map，DVG 是 The Manager's Room「测试」）。10001008 的名字和街道在 NiaDB 与 DVG 里是反的，用 DVG 的街道名「黄蘑菇屋」。
7. 图鉴以 NiaDB 为准（`Dataset::add_niadb_bestiary`，取代规则 2，并在规则 4 之后执行）：Mapledex 的怪物表、掉落表是 GMS 时代的数据，和 Classic World 对不上（2026-11-02 对比：我们的 3025 条有物品号的掉落只有 528 条被 NiaDB 玩家确认）。
   - 怪物：只保留 NiaDB `monsters.json` 里的怪物；Mapledex 有、NiaDB 没有的测试怪和旧副本去掉。等级、HP、MP、经验、攻防、命中、回避用 NiaDB 的上线数值；名字、`gms_id`、图片用的 `link_id`、说明和移动速度仍用 Mapledex。同一编号在 Mapledex 是另一只怪时（英文名去掉 NiaDB 的"(alt)""(GM Event)"等后缀仍不同：39、42、800019–800023，例如 39 在 Mapledex 是 Nependeath，在 Classic World 是 Ghost Stump），不用 Mapledex 的任何字段。
   - 怪物简体名：用 DVG 怪物列表（`data/reference/dvg/mob-list.json`，`tools/dvg_mobs.py` 抓取，`--dvg-mobs`）的 `mobname`，这是中文玩家在游戏里看到的名字，替换 Mapledex 的（Mapledex 有错字，例如 700000 写作"mush妈妈"）。只在 DVG 的英文名是同一只怪时用（同上去后缀，长名允许 2 个字母不同）。2026-11-03：110 只用了 DVG 的名字，其中 11 只改了名。
   - 怪物图片：GMS v83 渲染器没有或画的是另一只怪的，用 `web/images/mobs/` 里的 DVG 客户端贴图（来源见 `sources.json`）；清单在 `bestiary/pages.rs` 的 `LOCAL_SPRITES` 和 `catalogue.tsx`，两边一致。
   - 地图和刷怪：只保留 NiaDB `maps.json` 里的地图（Mapledex 有、NiaDB 没有的 Up and Up、White Map 等去掉，连同它们的 NPC 位置和回城边）；刷怪点全部换成 NiaDB 每张地图的怪物列表。
   - 掉落：整张表换成 NiaDB `drops.json`（玩家报告、投票），只收赞成多于反对的，每只怪每种物品一行，按（赞成 − 反对）从高到低。没有掉率（`rate_pct` 为空，Classic World 不公布），存 `upvotes` / `downvotes`；页面显示"N 票"，不再估算"打多少只出一个"。金币：Mapledex 的金币掉落不再导入，改用 NiaDB `mesos.json`（玩家报告的每堆金币数和投票）：NiaDB 有可信报告（`summary.trustedCount > 0`）的怪物加一行金币，范围是它页面上显示的中位数（`medianMin`–`medianMax`），票数是这只怪所有报告的票数之和；没有可信报告的不加。
   - 未开放：NiaDB 区域为 `Ossyria`（天空之城、冰峰雪域，NiaDB 默认隐藏）的地图，以及 `OPENS_LATER` 里开放日之前的区域（遗忘洞穴 10006000–10006999，2026-11-18 开放），标 `unreleased`；所有刷怪地图都未开放的怪物、所有站位都在未开放地图的 NPC 也标 `unreleased`（没有刷怪记录的怪物按 NiaDB `regions` 是否全是 `Ossyria`）。数据留在表里，页面、搜索、区域筛选、掉落来源、NPC 价格、制作成本、路线和 AI 助手都不显示。开放日之后重跑 `import_catalog` 即可显示；天空之城开放时去掉 `UNRELEASED_REGION` 的判断，并在 `regions.rs` 和 `catalogue-search.tsx` 加回区域选项。

2026-11-02 NiaDB 图鉴（规则 7）的结果（2026-11-02 导入；之前 → 之后）：

| | 之前 | 之后 |
|---|---|---|
| `mobs` | 195 | 206（NiaDB 才有的 19 个，去掉 Mapledex 的 8 个）；未开放 52（天空之城、冰峰雪域 41，遗忘洞穴 11） |
| `maps` | 444 | 453（NiaDB 新增 36 张，去掉 Mapledex 的 15 张）；未开放 119（92 + 遗忘洞穴 27） |
| `mob_spawns` | 896 | 915 |
| `drops` | 4575（GMS 时代掉落表，带掉率；金币 142 行） | 1704：物品 1655（玩家确认，没有掉率；另有 106 条赞成不多于反对的报告没收），金币 49 行（有报告的怪物只有 49 个，其中 11 个在未开放地图） |
| `npcs` 未开放 | 0 | 62 |

2026-10-21 数据的结果（之前 → 之后）：

| | 之前 | 之后 |
|---|---|---|
| `items` | 1001 | 2962（1001 市场 + 1961 来自 Mapledex/NiaDB） |
| 有 `item_id` 的掉落（共 4575，其中金币 142） | 3026 | 3041（另 15 条按名字配上） |
| 物品在 `items` 里的掉落 | 1780 | 3041 |
| 自身带名字的掉落 | 1407 | 4433（金币以外全部） |
| 只有 GMS ID 的掉落 | 1407 | 1392 |
| `npcs` / 有名字的 | 253 / 0 | 273 / 273 |
| `npc_shops` | 0 | 877 |
| `maps` | 432 | 444；传送口指向的地图全部有名字（之前 7 个没有） |
| 从射手村可到达 | 193 / 432 | 198 / 444 |

加上 `zh-names.json`（2026-10-21 抓取的 DVG 数据）后的简体名（之前 → 之后）：

| | 之前 | 之后 | 来源 |
|---|---|---|---|
| 有 `name_zh` 的 `maps`（共 444） | 258 | 422 | 新增 163 来自 DVG，1 来自 Mapledex 繁体转换；仍是英文的 22 张：12 张 Up and Up、5 张只有编号的 80003xxx、900000000–900000002 三张测试图、88000000 Victoria Road、88001000 Backalley Semi-Basement（DVG 没有中文名或没有这张图） |
| 有 `name_zh` 的 `npcs`（共 273） | 221 | 272 | 新增 51 全部来自 DVG；仍是英文的只有 1024（Mapledex 和 DVG 都叫 `????`） |

以后用客户端 Map.wz 自己导出传送口时，`market_map_resources.py --wz Map.wz --map-id <id> --output portals/<id>.json` 的输出和 `niadb_portals.py` 是同一格式，用 `import_portals` 导入后对照。

更新参考数据（`data/reference/` 和下面的工具都在仓库里；在开发机上抓，核对后连同 `../THIRD_PARTY_NOTICES.md` 里的日期和 `src/bin/import_catalog.rs` 的 `NIADB_VERSION` 一起提交，生产机只用提交的数据）：

```sh
for f in items equips npcs meta monsters maps; do
  curl -fsS -o ../data/reference/mapledex/$f.json https://kafuffu20.com/classic-world/data/$f.json
done
python3 ../tools/niadb_items.py --output ../data/reference/niadb/items.json
python3 ../tools/niadb_bestiary.py --output ../data/reference/niadb   # monsters.json、maps.json、drops.json、mesos.json，约 25 分钟
python3 ../tools/niadb_portals.py ../data/reference/niadb/maps.json --output ../data/reference/niadb/portals.json
python3 ../tools/dvg_mobs.py --output ../data/reference/dvg/mob-list.json
```

`niadb_bestiary.py` 一次只发一个请求（默认间隔 3 秒），全部成功才写文件，中途被拒（403/429）就停下、旧文件不变。新地图的传送口要重新生成 `portals.json` 并跑 `import_portals`。

Mapledex、NiaDB 或 DVG 有更新时重新生成 `zh-names.json`（`fetch` 只用标准库；`build` 需要 OpenCC，装在临时 venv 里），然后重跑 `import_catalog`：

```sh
python3 ../tools/zh_names.py fetch --out ../data/reference/dvg          # DVG 地图/NPC 列表，列表里没有的 ID 再抓详情页标题
python3 -m venv /tmp/zh-names-venv
/tmp/zh-names-venv/bin/pip install opencc-python-reimplemented==0.1.7
/tmp/zh-names-venv/bin/python ../tools/zh_names.py build --output ../data/reference/zh-names.json
```

`build` 打印每类的来源计数和没采用的 DVG 名字；新出现的英文不一致要人工核过，确认是同一地图/NPC 再加进 `SAME_DESPITE_ENGLISH`。

`GET /api/v1/dex/dropped-items` 返回 `{"as_of": <导入时间>, "item_ids": [...]}`：至少一种怪物掉落的物品 ID（去重、升序），带 ETag，`Cache-Control: public, max-age=3600`。

页面（服务端渲染，`Cache-Control: public, s-maxage=86400`；导入新数据后清一次边缘缓存）：`/item/<id>`、`/mob/<id>`、`/map/<id>`、`/route?from=&to=`（地图名或 ID）、`/search?q=`（不缓存）。样式 `static/bestiary.css` 编进二进制，路径 `/static/bestiary.css`。

图鉴的数据库测试（`tests/bestiary_*.rs`）每个测试建一个独立 schema；市场的（`tests/write_path.rs`、`tests/http.rs`）每个测试建一个临时库。都在没有 `DATABASE_URL` 时跳过。

## 屏幕读取器（R4）

代码在 `crates/market-core/src/reader/`，算法照 meso.watch 的浏览器读取器用 Rust 重写，模板数据在 `crates/market-core/assets/`（来源见 `../THIRD_PARTY_NOTICES.md`；重新生成用 `node server/tools/convert_reader_assets.mjs`，在仓库根目录运行）。入口：

- `reader::read_frame(帧, 上次缩放)`：一帧 → 行（格位、物品 ID、每组价格、单价、每组数量、库存、已售、置信度）、标题区哈希、摊主、频道、地图。读不准的行进 `rejected` 并写原因，不猜。
- `reader::Session`：连续帧。合并滚动的列表，内容稳定 2 秒且看到列表末尾后给出一次上传体（schema v1，`source: "screen"`）。
- 频道菜单按实际行数读取，支持超过 20 个频道；当前频道和待切换频道分别跟踪。识别与会话上传共用协议频道上限。菜单缺失、遮挡或不完整时不猜位置。
- 屏幕来源的 `shop_id`：窗口标题区放回游戏像素后，取第一行文字的二值位图做 FNV-1a 32 位哈希（`pipeline::title_hash`）。同一标题在不同位置、不同缩放下一致；标题改一个字就变。
- `price` 是每组价格（"10 for 45,000 mesos" 的 45,000），`bundle` 是每组数量；屏幕看不到库存，已售行 `stock` 为 0，其余为 1。

测试和计时：

```sh
cargo test -p market-core --test reader_synthetic          # 合成帧：1x、1.5x、1080p 全屏、图集行、遮挡、乱码帧、频道、地图条、会话
cargo run --release -p market-core --example reader_bench # 1920x1080 每帧耗时
```

### 构建 WASM

```sh
rustup target add wasm32-unknown-unknown
cargo install wasm-bindgen-cli --version 0.2.129 --locked   # 装到 ~/.cargo/bin，版本须与 Cargo.lock 一致
server/tools/build_reader_wasm.sh                           # 输出 web/collect/pkg/（不入库）
```

导出：`version()`、`read_frame(rgba, width, height, prev_scale)`（流水线输出的 JSON）、`find_window(...)`（只找窗口，页面主线程用）、`Reader` 类（会话，`push(rgba, width, height, ts_ms)`）。

### 本地打开采集页

```sh
node server/tools/serve_collect.mjs                             # http://127.0.0.1:8000/collect/ ，只绑 127.0.0.1
API=http://127.0.0.1:8080 node server/tools/serve_collect.mjs   # 同时把 /api/* 转给本机的 market-web
```

`getDisplayMedia` 只在安全上下文可用，`127.0.0.1` 算安全上下文；对外必须走 HTTPS。页面的 CSP 要允许 `script-src 'wasm-unsafe-eval'`，否则浏览器拒绝编译 WASM（`serve_collect.mjs` 已带上，`market-web` 以后挂 `/collect` 时也要加）。上传用 `/api/v1/register` 发的令牌（存在 localStorage），POST `/api/v1/upload`；录像表单发往 `/api/v1/upload/video`，服务端还没做。

无头检查（模拟屏幕共享，验证页面和 Worker 都能加载 WASM、读出商店并上传）：

```sh
cargo run --release -p market-core --example reader_bench -- --dump /tmp/r4frames
PLAYWRIGHT_MODULE=/workplace/ruit/kirocrew/website/node_modules/playwright node server/tools/collect_e2e.mjs /tmp/r4frames
node server/tools/wasm_bench.mjs /tmp/r4frames                  # WASM 每帧耗时（Node）
```

频道回归（在仓库根目录运行；合成画面及 API 模拟仅用于测试，不写入真实市场）：

```sh
cargo run --manifest-path server/Cargo.toml --release -p market-core --example reader_channel_fixtures -- /tmp/channel-frames
node server/tools/collect_e2e.mjs /tmp/channel-frames 12
node server/tools/collect_e2e.mjs /tmp/channel-frames 33
node server/tools/collect_e2e.mjs /tmp/channel-frames 60
```

可设置 `PLAYWRIGHT_MODULE` 指定安装路径，`PLAYWRIGHT_CHANNEL=chrome` 使用本机 Chrome。发布读取器时需重新构建 `web/collect/pkg/`，同时更新页面脚本、Worker、JS 绑定及 WASM 的版本查询参数，防止浏览器混用旧文件。修改 Rust 源码本身不会更新官网 WASM。

## Contributor accounts and Google sign-in

Migrations `0017_contributors.sql` and `0018_temporary_nicknames.sql` retain existing collector IDs/tokens and add nicknames, Google accounts, expiring sessions and one-time collector links. Unnamed contributors receive a persistent random adjective-and-monster alias, including historical collectors. Custom names and explicit opt-outs are preserved. `/contributors` is public; `/account` supports Google sign-in on the website and nickname management through the loopback collector gateway.

Create a Google OAuth web client with redirect URI `https://mxd.ruit.me/auth/google/callback` (replace the hostname with `PUBLIC_HOSTNAME` for another deployment). The application requests only `openid`. Store `client_id`, `client_secret`, and `redirect_uri` in a private JSON file and set `GOOGLE_OAUTH_CONFIG` to its absolute path. When `WEB_DIR` is set, the fallback is `../shared_data/google-oauth.json` relative to that directory. Keep this file out of Git, logs, and release archives. Restart `market-web` after changing the configuration. Without it, nickname profiles and the leaderboard work; the account page clearly says Google sign-in is unavailable.

The callback verifies the Google signature, issuer, audience, expiry and nonce, and uses PKCE plus a browser-bound single-use state. Account writes require a secure session cookie, matching site Origin and CSRF token. Collector pairing expires after 10 minutes and requires an explicit confirmation in the signed-in website account. Upload credentials are never returned to the browser. The local gateway also requires its own Origin and CSRF token for profile writes. Application accounts and private watch/preference sync are described below.

Run `cargo test -p market-web --test contributors` with `DATABASE_URL` configured for the existing isolated-database test harness. JWT verification tests are in `contributors::tests`; the RSA key in `tests/fixtures/test-only-oidc.pem` is disposable test material, never a production credential. Python gateway tests: `python -m unittest test_contributor_profile test_collector_push`. Browser fixture tests: `node web/tests/contributors.e2e.mjs`.


## Application accounts and private synchronization

Migration `0019_application_accounts.sql` preserves all existing account IDs, Google subjects, collectors and contribution history. `account_identities` stores Google bindings; the nullable legacy `accounts.google_sub` column is mirrored for rollback compatibility. Application users can register a case-insensitive 3–32 character username and a 15–128 character password. Nicknames are separate from login usernames. New accounts do not join the contributor board until opted in.

Passwords use salted Argon2id PHC hashes (19 MiB, 2 iterations, 1 lane). Password hashing runs off the HTTP executor with a bounded global concurrency limit. Registration/login/recovery enforce the configured public Origin and rate limits; authenticated writes also require the session CSRF token. Sensitive changes require the current password, or a Google-only session authenticated within 15 minutes. Existing sessions are marked as old during the migration. Session creation rechecks its credential under the account lock, preventing password reset or Google unlink races from creating a new session with a revoked credential.

The initial deployment uses one-time recovery codes, without an outbound email dependency. Registration and password changes return a random 256-bit recovery code once; only its SHA256 hash is stored. Recovery consumes the old code, rotates it, and invalidates existing sessions. The account UI offers a deliberate download and never stores recovery codes in localStorage. There is no email-based password recovery in this release.

`POST /api/v1/account/register`, `/login`, `/recover`, `/password`, `/google/link`, `/google/unlink` and `/logout-all` implement the account lifecycle. Google linking requires the current account proof plus a single-use, browser- and session-bound OAuth state. A Google identity already owned by another account cannot be transferred or silently merged. Unlinking the last login method is rejected. Collector pairing works with either login method and does not grant collectors access to account preferences.

`GET /api/v1/account/data` returns the current account's versioned records. `POST` to the same endpoint accepts up to 120 operations `{kind,key,value,version}` atomically. Watches use `kind: watch`, a numeric item ID key and `{cap,notify,position}` values; `null` is a deletion tombstone. Preferences use `kind: pref` and allow only language, theme, the item/watch offer sorts and the explicit market period. Account identity always comes from the session. Version conflicts return 409, and both imports and updates enforce 100 active watches. `POST /api/v1/account/data/import` adds missing guest records; existing cloud records, including tombstones, win.

`web/js/lib/user-data.js` supplies a storage facade to all watch entry points and preference controls. Guest keys remain untouched, while account caches, pending operations and preserved conflicts are namespaced by the server-confirmed public account ID. Logging out restores guest data; switching users never uploads another user's queue. The client retries offline edits, refreshes when visible/online and every 30 seconds, and merges pending operations between tabs. A conflicting remote version is displayed while the local edit is retained for explicit reapplication. Account endpoints are excluded from public API caches. The localhost collector dashboard remains a separate device context; its pairing flow opens the website for account sign-in.

Validation:

```powershell
# DATABASE_URL must point to the local test-capable PostgreSQL runtime.
cargo test --workspace
cargo clippy --workspace --all-targets -- -D warnings
node --test web/tests/*.test.mjs
node web/tests/accounts.e2e.mjs
node web/tests/contributors.e2e.mjs
```

The PostgreSQL tests create isolated temporary databases. Browser tests use fixture users and never call real Google sign-in. Configure `PLAYWRIGHT_MODULE` and `PLAYWRIGHT_CHANNEL` when using a bundled Playwright installation.

Migration line endings are pinned in `.gitattributes` to match the existing PostgreSQL SQLx checksums: migrations 0001–0012 retain CRLF, and 0013 onward use LF. Do not normalize already-deployed migration bytes. Compare all existing database checksums before starting a deployment candidate.

市场助手入口 `/agent`，OpenRouter 免费模型调用站内只读工具，支持买入、卖出定价和行情查询。配置与接口见 [Agent API](AGENT_API.md)。

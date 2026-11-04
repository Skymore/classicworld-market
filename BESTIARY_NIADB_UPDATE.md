# 图鉴改用 NiaDB：生产库更新步骤（给 Windows agent）

## 要做什么

图鉴的怪物、地图、刷怪和掉落改以 NiaDB 为准（规则见 `server/README.md` 的"导入规则 7"）：

- 怪物只保留 NiaDB 列出的 206 个，属性用上线数值；地图只保留 NiaDB 的 453 张，刷怪点用 NiaDB 的。
- 掉落整张换成 NiaDB 玩家确认（赞成多于反对）的掉落，没有掉率，页面显示"N 票"。金币改用 NiaDB 玩家报告的每堆金币数（NiaDB 页面上的中位数范围）。
- 天空之城、冰峰雪域，以及 2026-11-18 之前的遗忘洞穴，标为未开放：数据在库里，网站不显示。
- 任务（迁移 `0039_quests.sql`）：物品页"来源"新增"任务奖励"和"任务要用"，怪物页新增"相关任务"。活动任务只在活动期间显示。
- 地图视图（迁移 `0040_map_view.sql`）：地图页显示小地图，怪物头像站在刷怪点上，传送口和 NPC 可点；路线页每一步圈出要走的传送口；新增 NPC 页。GM 活动和 alt 副本怪隐藏；Mapledex 写错的 7 张地图中文名改正。
- AI 助手不再返回遗忘洞穴的地图、任务和怪物（开放日后自动恢复，不用重跑）。
- 船、出租车和传送口类型（迁移 `0042_portal_types_and_transport.sql`）：南港坐船去明珠港，彩虹岛的地图终于能连上金银岛；路线可以勾选坐出租车；隐藏传送口在地图上画成虚线圈。`portals.json` 带上了传送口类型，所以第 4 步的 `import_portals` 必须重跑。
- 场景图和世界地图（迁移 `0041_world_map_and_scenes.sql`）：地图视图改画整张场景图；路线页把路线画在世界地图上；新增"找怪物"：输入怪物，给出离出发地最近的刷怪地图和路线。
- 地图列表（2026-11-04）：图鉴·地图页左边是世界地图，右边是带图的地图卡片（`web/images/map-thumbs/`），滚动加载，点世界地图上的地点只看那里的地图；`/world` 跳到这一页。黄蘑菇屋、后巷半地下室没有传送口能进的旧副本（10001008、10003008）标为未开放；椰子收获的 3 个场地、自由市场的 20 个房间各合成一张卡。地图名统一用国服名（DVG），同一系列叫法和编号写法一致（蜗牛狩猎场Ⅰ–Ⅲ、石巨人寺院Ⅰ–Ⅳ）；"城镇"只标回城点是自己、又没有怪的地图（开放地图里 17 张，商店、蘑菇山、借阅台不再算）。第 4 步重跑 `import_catalog` 就会写入，不需要迁移。
- 中文名（2026-11-03）：以前只有英文名的 689 件物品、8 个 NPC 和 59 个任务改用国服名（DVG 国服 Classic World 资料站，冰峰雪域任务用国服客户端的任务名），国服没有的少数几条用按国服用词写的译名。来源都在 `data/reference/zh-names.json`，第 4 步重跑 `import_catalog` 就会写入，不需要迁移。

需要三样东西：新代码（含迁移 `0038_niadb_bestiary.sql`、`0039_quests.sql`、`0040_map_view.sql`、`0041_world_map_and_scenes.sql`、`0042_portal_types_and_transport.sql`）、仓库里的参考数据和图片（`data/reference/`、`web/images/minimaps/`、`web/images/mobs/head/`、`web/images/scenes/`、`web/images/worldmap/`、`web/images/map-thumbs/`，随网站一起部署）、用新代码重跑 `import_catalog` 和 `import_portals`。

## 什么时候做

**先上线新网站，再重跑导入。** 重跑后 `drops.rate_pct` 为空，旧网站读到空值会让物品页和怪物页出错。

1. 包含这次改动的提交合入 `gitlab/main`，按 `AGENTS.md` 同步共享目录（含子模块），核对 `HEAD` 与 `gitlab/main` 一致。
2. 按 `SHARED_DEPLOYMENT.md` 上线这个提交。迁移 0038 只加列、放宽 `rate_pct` 的非空约束，0040 只加列和一张新表，旧数据照常显示（重跑导入前地图页没有小地图视图）。
3. 再做下面的步骤。

## 步骤

在共享目录根（`C:\Users\liwin\Documents\MapleStory`）打开 PowerShell。生产库地址在 `shared_data\native-runtime.json` 的 `database_url`，里面有密码：只放进环境变量，不要打印，不要写进报告。

```powershell
cd C:\Users\liwin\Documents\MapleStory
$env:DATABASE_URL = (Get-Content shared_data\native-runtime.json -Raw | ConvertFrom-Json).database_url
$pg = "market_data\runtime\pgsql\bin"
```

### 1. 核对参考数据

参考数据和生成它们的工具都在仓库里（`data/reference/`、`tools/`），同步到 `gitlab/main` 就有，不需要自己抓：

```powershell
python -c "import json;d=json.load(open('data/reference/niadb/drops.json',encoding='utf-8'));print(d['fetched_at'],len(d['monsters']))"
python -c "import json;print(len(json.load(open('data/reference/dvg/mob-list.json',encoding='utf-8'))['items']))"
```

预期：第一行打印 `2026-11-02T…` 和 `206`（或更新的日期和更多怪物），第二行 117 左右。文件不存在：停下，核对共享目录是否在 `gitlab/main`，然后报告用户。

不要在这一步重新抓数据。数据要更新时，按 `server/README.md` 的"更新参考数据"在开发机上抓、提交，再走这份文档。

### 2. 找到上一次生产导入用的参数

```powershell
& "$pg\psql.exe" $env:DATABASE_URL -c "SELECT dataset, version, source, imported_at FROM catalog_versions ORDER BY imported_at DESC LIMIT 10"
```

记下 `items`、`mapledex`、`niadb`、`zh-names` 四行的 `source` 和 `version`（`source` 是相对 `server/` 的路径）。缺任何一行，或者 `items` 的 `source` 指向的文件已经不在：停下，把查询结果报告用户。

### 3. 备份数据库

```powershell
$ts = Get-Date -Format yyyyMMdd-HHmmss
$backup = "shared_data\backups\catalog-$ts.pgdump"
& "$pg\pg_dump.exe" --format=custom --file $backup --dbname $env:DATABASE_URL
(Get-Item $backup).Length
```

文件存在、大小不为 0，再继续。

### 4. 重跑 import_catalog

路径和 `--mapledex-version` 用第 2 步记下的：

```powershell
cd server
cargo run --release -p market-web --bin import_catalog -- `
  --items "<items 的 source>" `
  --mapledex "<mapledex 的 source>" `
  --mapledex-version "<mapledex 的 version>" `
  --niadb "<niadb 的 source>" `
  --niadb-version "fetched <第 1 步 fetched_at 的日期，例如 2026-11-02>" `
  --zh-names "<zh-names 的 source>" `
  --dvg "..\data\reference\dvg"
```

- 导入在一个事务里，出错整体回滚。
- `--niadb-version` 写 `drops.json` 里 `fetched_at` 的日期（第 1 步第一行打印的）。
- 预期输出（2026-11-02 的数据，新抓的会略多）：`mobs 206 NiaDB (… 7 replace a different Mapledex mob … 63 unreleased; 110 simplified names from DVG …)`、`maps 453 NiaDB (… 122 unreleased; 452 with a simplified name, 272 from DVG …)`、`spawns 915 NiaDB (… spawn points with positions …)`、`world 134 world map spots`、`drops 1704 NiaDB: 1655 items … 49 meso ranges`、`portals 447`、`quests 401 NiaDB (…)`、`items` 与上一次相同。
- `mobs`、`maps` 少于 200、`drops` 少于 1000：按第 7 步恢复并报告用户。

接着导入传送口（新地图的传送口在仓库的 `portals.json` 里）：

```powershell
cargo run --release -p market-web --bin import_portals -- ..\data\reference\niadb\portals.json
cd ..
```

### 5. 核对结果

```powershell
& "$pg\psql.exe" $env:DATABASE_URL -c "SELECT (SELECT count(*) FROM maps WHERE unreleased) AS maps_hidden, (SELECT count(*) FROM mobs WHERE unreleased) AS mobs_hidden, (SELECT count(*) FROM drops WHERE rate_pct IS NULL) AS niadb_drops, (SELECT count(*) FROM drops) AS drops"
```

预期 `maps_hidden` 约 122、`mobs_hidden` 约 63，`niadb_drops` 等于 `drops`。

```powershell
& "$pg\psql.exe" $env:DATABASE_URL -c "SELECT (SELECT count(*) FROM map_spawn_points) AS spawn_points, (SELECT count(*) FROM maps WHERE minimap_w IS NOT NULL) AS maps_with_box, (SELECT count(*) FROM map_npcs WHERE x IS NOT NULL) AS npcs_placed"
& "$pg\psql.exe" $env:DATABASE_URL -c "SELECT (SELECT count(*) FROM world_spots) AS world_spots, (SELECT count(*) FROM maps WHERE scene_url IS NOT NULL) AS scenes"
Test-Path web\images\minimaps\1000.png, web\images\mobs\head\4.png, web\images\scenes\1000.webp, web\images\worldmap\victoria-island.webp, web\images\map-thumbs\1000.webp
```

预期 `spawn_points` 一万左右、`maps_with_box` 约 453、`npcs_placed` 三百左右，`world_spots` 134、`scenes` 约 366；五个 `Test-Path` 都是 `True`。

网站（首屏 HTML 最多缓存 60 秒，刷新即可）：

- [蓝蜗牛](https://mxd.ruit.me/mob/3)：掉落第一行是铁矿石，右边显示"N 票"，不再有百分比。
- [蜗牛](https://mxd.ruit.me/mob/2)：掉落最上面是金币 3–4。
- [古木妖](https://mxd.ruit.me/mob/39)：名字是古木妖（Ghost Stump），不是食人花，有图片。
- [天空之城](https://mxd.ruit.me/map/20000000)：显示"没有找到"（404）。
- [彩虹村西边草原](https://mxd.ruit.me/map/1000)：小地图上有蜗牛、蘑菇仔等头像，点下面的怪物标签只突出那一种；传送口"岔路"写的是中文。
- [希娜](https://mxd.ruit.me/npc/1)：NPC 页，小地图上金色标出她，任务里有"借来莎丽的镜子"。
- [射手村 → 遗迹发掘地I](https://mxd.ruit.me/route?from=10001000&to=10004130)：上面是画在世界地图上的路线，每一步下面有地图，紫圈是要走的传送口。
- [世界地图](https://mxd.ruit.me/world?map=10002000)：跳到图鉴·地图页，左边金银岛地图上选中魔法密林，右边只列那里的地图；没有天空之城。
- [图鉴·地图](https://mxd.ruit.me/search?kind=map)：写"共 310 张"，卡片有图，往下滚会继续加载；没有第二张黄蘑菇屋。
- [蘑菇镇 → 射手村](https://mxd.ruit.me/route?from=1&to=10001000)：中间有一步"找圈出的桑克斯坐船"。
- [射手村 → 勇士部落，坐出租车](https://mxd.ruit.me/route?from=10001000&to=10004000&taxi=1)：1 步。
- [找花蘑菇](https://mxd.ruit.me/route?from=10001000&mob=9)：给出最近的刷怪地图和路线，下面按步数列出所有刷怪地图。
- 图鉴搜索的区域筛选里没有天空之城和冰峰雪域。

### 6. 2026-11-18 之后

遗忘洞穴开放日之后，用第 4 步完全相同的参数再跑一次 `import_catalog`（不需要重新抓数据）。之后 `maps_hidden` 降为约 95，[遗忘洞穴](https://mxd.ruit.me/map/10006000) 能打开。

### 7. 出问题时

- 第 4 步失败：事务已回滚，不需要恢复。把命令输出发给用户。
- 第 4 步成功但数量或网站数据不对：先停 web 子进程，用备份恢复，再启动 web 子进程，然后报告用户。不要动数据库服务、上传服务和隧道。

```powershell
& "$pg\pg_restore.exe" --clean --if-exists --dbname $env:DATABASE_URL $backup
```

## 完成后报告

共享目录的提交号、第 1 步打印的内容、`import_portals` 打印的数量、第 2 步的四个来源和版本、备份文件名、第 4 步打印的数量、第 5 步查询结果，以及三个页面是否符合预期。

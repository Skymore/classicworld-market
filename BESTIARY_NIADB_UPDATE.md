# 图鉴改用 NiaDB：生产库更新步骤（给 Windows agent）

## 要做什么

图鉴的怪物、地图、刷怪和掉落改以 NiaDB 为准（规则见 `server/README.md` 的"导入规则 7"）：

- 怪物只保留 NiaDB 列出的 206 个，属性用上线数值；地图只保留 NiaDB 的 453 张，刷怪点用 NiaDB 的。
- 掉落整张换成 NiaDB 玩家确认（赞成多于反对）的掉落，没有掉率，页面显示"N 票"。金币改用 NiaDB 玩家报告的每堆金币数（NiaDB 页面上的中位数范围）。
- 天空之城、冰峰雪域，以及 2026-11-18 之前的遗忘洞穴，标为未开放：数据在库里，网站不显示。

需要三样东西：新代码（含迁移 `0038_niadb_bestiary.sql`）、新抓的 NiaDB 参考文件、用新代码重跑 `import_catalog`。

## 什么时候做

**先上线新网站，再重跑导入。** 重跑后 `drops.rate_pct` 为空，旧网站读到空值会让物品页和怪物页出错。

1. 包含这次改动的提交合入 `gitlab/main`，按 `AGENTS.md` 同步共享目录（含子模块），核对 `HEAD` 与 `gitlab/main` 一致。
2. 按 `SHARED_DEPLOYMENT.md` 上线这个提交。迁移 0038 只加列、放宽 `rate_pct` 的非空约束，旧数据照常显示。
3. 再做下面的步骤。

## 步骤

在共享目录根（`C:\Users\liwin\Documents\MapleStory`）打开 PowerShell。生产库地址在 `shared_data\native-runtime.json` 的 `database_url`，里面有密码：只放进环境变量，不要打印，不要写进报告。

```powershell
cd C:\Users\liwin\Documents\MapleStory
$env:DATABASE_URL = (Get-Content shared_data\native-runtime.json -Raw | ConvertFrom-Json).database_url
$pg = "market_data\runtime\pgsql\bin"
```

### 1. 抓 NiaDB 数据

```powershell
python tools\niadb_bestiary.py --output data\reference\niadb
```

- 大约 25 分钟（200 多个怪物，每个两次请求，一次一个，间隔 3 秒）。全部成功才写四个文件（`monsters.json`、`maps.json`、`drops.json`、`mesos.json`）。
- 结束时打印 `drops N, monsters with meso reports M`。预期 `monsters` 200 以上、`maps` 450 以上、`drops` 1500 以上、`M` 40 以上（2026-11-02 是 49）。
- 中途停下（403、429 或网络错误）：旧文件不变，不要改间隔重试，把输出报告用户。

如果 `tools\niadb_portals.py` 存在，重新生成传送口（新地图的传送口在里面）：

```powershell
python tools\niadb_portals.py data\reference\niadb\maps.json --output data\reference\niadb\portals.json
```

文件不存在就跳过这一步，在报告里写明。

再抓 DVG 怪物列表（怪物简体名，几秒钟）：

```powershell
python tools\dvg_mobs.py --output data\reference\dvg\mob-list.json
```

预期打印 `mobs 117` 左右。

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

路径和 `--mapledex-version` 用第 2 步记下的；`--niadb-version` 写第 1 步抓数据的日期：

```powershell
cd server
cargo run --release -p market-web --bin import_catalog -- `
  --items "<items 的 source>" `
  --mapledex "<mapledex 的 source>" `
  --mapledex-version "<mapledex 的 version>" `
  --niadb "<niadb 的 source>" `
  --niadb-version "fetched <第 1 步的日期，例如 2026-11-03>" `
  --zh-names "<zh-names 的 source>" `
  --dvg-mobs "..\data\reference\dvg\mob-list.json"
```

- 导入在一个事务里，出错整体回滚。
- 预期输出（2026-11-02 的数据，新抓的会略多）：`mobs 206 NiaDB (… 7 replace a different Mapledex mob … 52 unreleased; 110 simplified names from DVG …)`、`maps 453 NiaDB (… 119 unreleased …)`、`drops 1704 NiaDB: 1655 items … 49 meso ranges`、`items` 与上一次相同。
- `mobs`、`maps` 少于 200、`drops` 少于 1000：按第 7 步恢复并报告用户。

第 1 步生成了 `portals.json` 时，接着导入传送口：

```powershell
cargo run --release -p market-web --bin import_portals -- ..\data\reference\niadb\portals.json
cd ..
```

### 5. 核对结果

```powershell
& "$pg\psql.exe" $env:DATABASE_URL -c "SELECT (SELECT count(*) FROM maps WHERE unreleased) AS maps_hidden, (SELECT count(*) FROM mobs WHERE unreleased) AS mobs_hidden, (SELECT count(*) FROM drops WHERE rate_pct IS NULL) AS niadb_drops, (SELECT count(*) FROM drops) AS drops"
```

预期 `maps_hidden` 约 119、`mobs_hidden` 约 52，`niadb_drops` 等于 `drops`。

网站（首屏 HTML 最多缓存 60 秒，刷新即可）：

- [蓝蜗牛](https://mxd.ruit.me/mob/3)：掉落第一行是铁矿石，右边显示"N 票"，不再有百分比。
- [蜗牛](https://mxd.ruit.me/mob/2)：掉落最上面是金币 3–4。
- [古木妖](https://mxd.ruit.me/mob/39)：名字是古木妖（Ghost Stump），不是食人花，有图片。
- [天空之城](https://mxd.ruit.me/map/20000000)：显示"没有找到"（404）。
- 图鉴搜索的区域筛选里没有天空之城和冰峰雪域。

### 6. 2026-11-18 之后

遗忘洞穴开放日之后，用第 4 步完全相同的参数再跑一次 `import_catalog`（不需要重新抓数据）。之后 `maps_hidden` 降为约 92，[遗忘洞穴](https://mxd.ruit.me/map/10006000) 能打开。

### 7. 出问题时

- 第 4 步失败：事务已回滚，不需要恢复。把命令输出发给用户。
- 第 4 步成功但数量或网站数据不对：先停 web 子进程，用备份恢复，再启动 web 子进程，然后报告用户。不要动数据库服务、上传服务和隧道。

```powershell
& "$pg\pg_restore.exe" --clean --if-exists --dbname $env:DATABASE_URL $backup
```

## 完成后报告

共享目录的提交号、第 1 步打印的数量、是否导入了传送口、第 2 步的四个来源和版本、备份文件名、第 4 步打印的数量、第 5 步查询结果，以及三个页面是否符合预期。

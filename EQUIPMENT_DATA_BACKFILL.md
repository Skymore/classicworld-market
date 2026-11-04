# 装备详情：生产库补暴击基础值（给 Windows agent）

## 要做什么

网站的装备详情（物品页头部资料条、报价行的游戏格式属性卡、快速预览的"装备资料"）显示要求等级、要求力量/敏捷/智力/运气、可用职业、武器分类、攻击速度、基础属性和可升级次数。

- 除了暴击率和暴击伤害的基础值，这些字段生产库里都已经有了：在 `item_records.record -> mapledex_reference -> data` 里（`reqLevel`、`reqSTR`、`reqDEX`、`reqINT`、`reqLUK`、`reqJob`、`attackSpeed`、`tuc`、`inc*`），新网站代码直接读，不需要补。
- 暴击率、暴击伤害的基础值只有 NiaDB 有：`data/reference/niadb/items.json` 里每件装备的 `stats` 字符串（`critRate`、`critDamage`）。2026-10-21 的文件里，有暴击率的装备 109 件，有暴击伤害的 31 件。
- 新代码的 `import_catalog` 在写 `item_records` 时，把 NiaDB 这件装备的整份 `stats` 写进 `record.niadb_reference.stats`。生产库要用新代码重跑一次 `import_catalog` 才有这两个值。
- 不需要数据库迁移，不改表结构。没重跑之前网站照常工作，只是暴击率没有基础值：资料条的"基础"不显示暴击率，带暴击率 +1 的拳套仍会被当成"有加成"。

## 什么时候做

在包含装备详情的提交合入 `gitlab/main` 以后。按 `AGENTS.md`：先把共享目录同步到 `gitlab/main`（含子模块），核对 `HEAD` 与 `gitlab/main` 一致。网站是否已经上线新版本不影响这一步，先后都可以；旧网站会忽略 `niadb_reference`。

## 步骤

在共享目录根（`C:\Users\liwin\Documents\MapleStory`）打开 PowerShell。生产库地址在 `shared_data\native-runtime.json` 的 `database_url`，里面有密码：只放进环境变量，不要打印，不要写进报告。

```powershell
cd C:\Users\liwin\Documents\MapleStory
$env:DATABASE_URL = (Get-Content shared_data\native-runtime.json -Raw | ConvertFrom-Json).database_url
$pg = "market_data\runtime\pgsql\bin"
```

### 1. 核对参考数据在本机

```powershell
python -c "import json;d=json.load(open('data/reference/niadb/items.json',encoding='utf-8'));e=[x for x in d if x.get('type')=='Equip'];c=[x for x in e if 'critRate' in (x.get('stats') or '')];print(len(e),'equips',len(c),'with critRate');print([x['stats'] for x in e if x.get('iconKey')=='1472009'])"
```

预期：1194 件装备、109 件带 `critRate`，1472009 的 `stats` 里有 `"critRate":1`。

- 文件不存在或者没有 `critRate`：停下，向用户报告。不要自己抓新数据；更新参考数据是另一件事（`server/README.md` 的"更新参考数据"）。

### 2. 找到上一次生产导入用的参数

`import_catalog` 把每个来源记在 `catalog_versions` 表里。重跑时 `--items`、`--mapledex`、`--niadb`、`--zh-names` 的路径和 `--mapledex-version`、`--niadb-version` 必须和上一次一致，否则会换掉物品目录。

```powershell
& "$pg\psql.exe" $env:DATABASE_URL -c "SELECT dataset, version, source, imported_at FROM catalog_versions ORDER BY imported_at DESC LIMIT 10"
```

记下 `items`、`mapledex`、`niadb`、`zh-names` 四行的 `source`（文件路径）和 `version`。`source` 是相对 `server/` 的路径（例如 `../data/reference/mapledex`）。

- 四行里缺任何一行，或者 `items` 的 `source` 指向的文件已经不在：停下，把查询结果报告用户，不要猜参数。

### 3. 数据库备份规则

重跑会重写 `items`、`item_records`、怪物、地图、掉落、NPC、NPC 商店等表，属于批量修改。按用户 2026-11-04 的最新要求（见 `AGENTS.md`），批量导入不自动备份数据库，直接继续第 4 步。只有用户明确要求备份时才执行；既有备份继续保留。记下第 2 步的四个来源和版本，出问题时用它们重新导入。

### 4. 重跑 import_catalog

在 `server\` 下运行，把第 2 步记下的路径和版本填进去（`zh-names` 的版本来自文件本身，只填路径）：

```powershell
cd server
cargo run --release -p market-web --bin import_catalog -- `
  --items "<items 的 source>" `
  --mapledex "<mapledex 的 source>" `
  --mapledex-version "<mapledex 的 version>" `
  --niadb "<niadb 的 source>" `
  --niadb-version "<niadb 的 version>" `
  --zh-names "<zh-names 的 source>"
cd ..
```

- 第一次运行要编译 release 版，需要几分钟。它只写 `server\target`，不影响正在运行的网站（网站从 `shared_data\deploy\releases\<提交>\bin` 运行）。
- 导入在一个事务里完成，出错会整体回滚，生产库保持原样。
- 结束时打印各表的数量。`items`、`drops`、`npcs`、`shops` 的数量应该和第 2 步 `counts` 里上一次的一样。新的一行 `records  N  item records (M with NiaDB equipment stats)` 里的 M 记下来，第 5 步要用。数量明显变少时不要继续，按第 6 步恢复并报告用户。

### 5. 核对结果

```powershell
& "$pg\psql.exe" $env:DATABASE_URL -c "SELECT count(*) FROM item_records WHERE record ? 'niadb_reference'"
& "$pg\psql.exe" $env:DATABASE_URL -c "SELECT record->'niadb_reference' FROM item_records WHERE item_id=1472009"
```

预期：第一条等于第 4 步的 M（大于 0）；第二条里有 `"critRate": 1`。

然后打开 [锂矿斗拳](https://mxd.ruit.me/item/1472009)（需要新网站已上线）：头部资料条的"基础"一行应有"暴击率 +1"，报价行悬停出的属性卡里暴击率后面没有绿色的"(+1)"。物品接口的缓存不超过 2 秒，首屏 HTML 最多 60 秒，刷新页面即可，不需要重启 web 子进程。

### 6. 出问题时

- 第 4 步失败：事务已回滚，不需要恢复。把命令输出发给用户。
- 第 4 步成功但数量或网站数据不对：用第 2 步记下的参数和上一版参考数据重跑导入，核对后报告用户。若需恢复已有数据库备份，先确认它的时间和影响范围，避免覆盖之后的采集或账号数据。不要动数据库服务、上传服务和隧道。

## 完成后报告

向用户报告：共享目录的提交号、第 2 步的四个来源和版本、第 4 步打印的数量（含 `records` 一行）、第 5 步两条查询的结果，以及页面上是否看到暴击率基础值。说明本次按用户规则未备份；仅在用户明确要求并实际备份时附备份文件名。

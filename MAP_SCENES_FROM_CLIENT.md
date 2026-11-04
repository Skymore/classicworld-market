# 补地图场景图：从客户端渲染（给 Windows agent）

## 要做什么

地图页和地图列表的图优先用场景图（整张地图的背景、地块和物件，不含怪物和 NPC）。现有 267 张场景图来自 NiaDB 的渲染。下面 66 张没有：58 张不在 NiaDB 的场景索引里，1 张 NiaDB 只有带 NPC 的版本，7 张店铺和室内连小地图都没有。现在这些地图的地图页只能显示小地图，列表里是深色底上的小地图或"无图"。

要做的是用游戏客户端的 Map.wz 自己渲染这 66 张，处理成和现有场景图一样的文件，写进 `data/reference/niadb/scenes.json`。

## 步骤

### 1. 找客户端数据

在游戏客户端安装目录里找 `Map.wz`（新版客户端可能是 `Data\Map\` 下拆开的 `.img`/`.wz`）。不确定装在哪就问 Rui。只读，不改客户端文件。

地图在 WZ 里的名字是补零到 9 位的 id，放在 `Map\Map<第一位>\` 下，例如 10005060（蚂蚁洞Ⅰ）是 `Map\Map0\010005060.img`。

### 2. 渲染

用 WzComparerR2（或 HaCreator）打开 Map.wz，逐张导出整张地图：背景、地块、物件都要，关掉怪物、NPC、角色、传送口标记和界面。保存到 scratch 目录：

- `client-scenes\<地图 id>.png`：渲染图，原始大小，不要缩放。
- `client-scenes\<地图 id>.json`：这张图覆盖的世界矩形，`{"x": 左, "y": 上, "w": 宽, "h": 高}`（世界坐标）。一般就是该地图 `info` 节点的 `VRLeft`、`VRTop`、`VRRight - VRLeft`、`VRBottom - VRTop`；地图没有 VR 时，用下表"小地图覆盖的世界矩形"。

### 3. 核对

每张图都要过两项，不过的不用，在报告里列出：

- 宽高比和第 2 步记录的矩形一致（误差 2% 以内）。
- 有小地图的地图：把渲染图缩到 `web/images/minimaps/<id>.png` 的大小叠上去，平台和墙的位置对得上。怪物头像是按刷怪点的世界坐标画的，矩形错了头像会悬空。

### 4. 写成场景图

给 `tools/niadb_map_assets.py` 加子命令 `client-scenes <目录>`，复用现有的 `fitted`、`save_scene`、`save_small_scene`：

- 写 `web/images/scenes/<id>.webp`（缩到 1760x1040 以内）和 `web/images/scenes/small/<id>.webp`（1100x650 以内），WebP 质量和现有一样（`SCENE_QUALITY`）。
- 在 `data/reference/niadb/scenes.json` 的 `maps` 里加条目：`key` 写 `"client"`，`x`、`y`、`w`、`h` 用第 2 步的矩形，`source_size`、`size` 和现有条目同样含义，再加 `"source": "client Map.wz"`。`web/images/scenes/sources.json` 的 `maps` 列表也加上这些 id，`note` 里写明部分来自客户端渲染。
- 已经有 NiaDB 场景图的地图不要覆盖。
- 在文件开头的说明里补上这个子命令。

### 5. 本地验证

- dev 库重跑 `import_catalog`（会读 `scenes.json`），打开几张地图页看：蚂蚁洞Ⅰ（10005060）、一张废弃都市地铁、彩虹村杂货店（1013）。场景图要显示，怪物头像要站在平台上。手机宽度也看一下。
- 跑 `cargo test --workspace`、`node --test web/tests/*.test.mjs`。
- 如果地图列表缩略图已经上线，重新生成这些地图的缩略图。

### 6. 提交和上线

- 作者 Skymore。图片、`scenes.json`、`sources.json` 和工具改动一起提交，推功能分支，不推 main。
- 合入并上线后，按 `BESTIARY_NIADB_UPDATE.md` 第 4 步在生产库重跑 `import_catalog`。

## 完成后报告

补上了几张，哪几张核对没过及原因，三张代表地图的截图（电脑和手机各一）。

## 缺场景图的地图

### 只有小地图（59 张）

| 地图 id | 中文名 | 英文名 | 地区 | 小地图覆盖的世界矩形 x, y, w, h |
|---|---|---|---|---|
| 10002022 | 猴林迷宫I | Tree Dungeon, Monkey Forest I | 金银岛 | -580, -2189, 1166, 3058 |
| 10002024 | 猴子迷宫Ⅱ | Tree Dungeon, Monkey Forest II | 金银岛 | -496, -2189, 1082, 2878 |
| 10002031 | 南部森林训练场Ⅰ | Dungeon, Southern Forest I | 金银岛 | -496, -2189, 1082, 2878 |
| 10002032 | 南部森林训练场Ⅱ | Dungeon, Southern Forest II | 金银岛 | -496, -2189, 1082, 2878 |
| 10002033 | 南部森林训练场Ⅲ | Dungeon, Southern Forest III | 金银岛 | -496, -2189, 1082, 2878 |
| 10002034 | 南部森林训练场Ⅳ | Dungeon, Southern Forest IV | 金银岛 | -496, -2189, 1082, 2878 |
| 10002072 | 北部森林训练场Ⅰ | Tree Dungeon, Forest Up North I | 金银岛 | -496, -2849, 1082, 3538 |
| 10002073 | 北部森林训练场Ⅱ | Tree Dungeon, Forest Up North II | 金银岛 | -496, -2249, 1082, 2938 |
| 10002074 | 北部森林训练场Ⅲ | Tree Dungeon, Forest Up North III | 金银岛 | -496, -2189, 1082, 2878 |
| 10002075 | 北部森林训练场Ⅳ | Tree Dungeon, Forest Up North IV | 金银岛 | -496, -2189, 1082, 2878 |
| 10002076 | 北部森林训练场Ⅴ | Tree Dungeon, Forest Up North V | 金银岛 | -496, -2249, 1082, 2938 |
| 10002080 | 北部森林训练场Ⅵ | Tree Dungeon, Forest Up North VI | 金银岛 | -496, -2189, 1082, 2878 |
| 10002081 | 北部森林训练场Ⅶ | Tree Dungeon, Forest Up North VII | 金银岛 | -496, -2189, 1082, 2878 |
| 10002082 | 树洞迷宫：北部森林 VIII | Tree Dungeon, Forest Up North VIII | 金银岛 | -496, -2189, 1082, 2878 |
| 10002083 | 北部森林训练场Ⅸ | Tree Dungeon, Forest Up North IX | 金银岛 | -496, -2189, 1082, 2878 |
| 10003000 | 废弃都市 | Kerning City | 金银岛 | -2500, -1443, 5180, 2119 |
| 10003065 | 地铁一号线<第4地区> | Line 1 <Area 4> | 废弃都市 地铁 | -694, -464, 4090, 1060 |
| 10003067 | 地铁二号线<第2地区> | Line 2 <Area 2> | 废弃都市 地铁 | -694, -464, 4090, 1060 |
| 10003068 | 地铁二号线<第3地区> | Line 2 <Area 3> | 废弃都市 地铁 | -694, -464, 4090, 1060 |
| 10005010 | 黑森林通道 | Swampy Land in a Deep Forest | 迷宫 | -1373, -2700, 1756, 3475 |
| 10005011 | 黑森林打猎场I | Hunting Ground in the Deep Forest I | 迷宫 | -653, -1620, 1666, 2095 |
| 10005012 | 黑森林打猎场II | Hunting Ground in the Deep Forest II | 迷宫 | -743, -1455, 1846, 1990 |
| 10005020 | 黑森林 | Deep Forest | 迷宫 | -1733, -2943, 2116, 3298 |
| 10005030 | 黑森林西入口 | Damp Tree-Forest | 迷宫 | -563, -1993, 2206, 2528 |
| 10005031 | 黑森林沼泽 | Damp Forest | 迷宫 | -563, -1993, 1486, 2528 |
| 10005051 | 森林迷宫II | Sleepy Dungeon II | 迷宫 | -698, -300, 1396, 2785 |
| 10005052 | 森林迷宫III | Sleepy Dungeon III | 迷宫 | -608, -870, 1396, 3355 |
| 10005053 | 森林迷宫IV | Sleepy Dungeon IV | 迷宫 | -428, -150, 1396, 2635 |
| 10005054 | 森林迷宫V | Sleepy Dungeon V | 迷宫 | -608, -450, 2026, 3535 |
| 10005060 | 蚂蚁洞Ⅰ | Ant Tunnel I | 迷宫 | -630, -240, 3240, 2460 |
| 10005061 | 蚂蚁洞Ⅱ | Ant Tunnel II | 迷宫 | -450, -540, 2880, 2400 |
| 10005062 | 蚂蚁洞Ⅲ | Ant Tunnel III | 迷宫 | -405, -510, 3600, 2280 |
| 10005063 | 蚂蚁洞Ⅳ | Ant Tunnel IV | 迷宫 | -900, -540, 3510, 2760 |
| 10005064 | 黑暗通道 | Dark Cave | 迷宫 | -450, -900, 3510, 1380 |
| 10005065 | 蝙蝠洞 | Dangerous Steam | 迷宫 | -540, -360, 3330, 3120 |
| 10005066 | 幽深蚂蚁洞1 | Deep Ant Tunnel I | 迷宫 | -720, -300, 3330, 2520 |
| 10005067 | 幽深蚂蚁洞2 | Deep Ant Tunnel II | 迷宫 | -450, -1140, 3330, 2640 |
| 10005071 | 火独眼兽洞穴Ⅰ | The Cave of Evil Eye I | 迷宫 | -810, -300, 1710, 2760 |
| 10005072 | 火独眼兽洞穴Ⅱ | The Cave of Evil Eye II | 迷宫 | -900, -600, 1620, 2520 |
| 10005073 | 火独眼兽洞穴Ⅲ | The Cave of Evil Eye III | 迷宫 | -810, -420, 1710, 2340 |
| 10005074 | 火独眼兽洞穴Ⅳ | The Cave of Evil Eye IV | 迷宫 | -540, -720, 1440, 2640 |
| 10005075 | 龙族打猎场 | Drake Hunting Ground | 迷宫 | -450, -420, 2340, 1860 |
| 10005076 | 冰独眼兽洞穴Ⅰ | The Tunnel That Lost Light I | 迷宫 | -585, -840, 2969, 4530 |
| 10005077 | 冰独眼兽洞穴Ⅱ | The Tunnel That Lost Light II | 迷宫 | -720, -660, 2880, 3060 |
| 10005078 | 蘑菇王之墓 | The Grave of Mushmom | 金银岛 | -270, -1200, 1440, 1980 |
| 10005080 | 另外的入口 | Another Entrance | 迷宫 | -920, -499, 1836, 1800 |
| 10005090 | 龙穴 | Drake's Meal Table | 迷宫 | -450, -2640, 2250, 3300 |
| 10005091 | 野生卡古的地盘 | Wild Kargo's Area | 金银岛 | -381, -571, 1390, 1941 |
| 10005100 | 寺院入口 | Another Path | 迷宫 | -585, -930, 1710, 3120 |
| 10005101 | 寺院通道1 | Sanctuary Entrance I | 迷宫 | -573, -600, 2226, 1190 |
| 10005102 | 寺院通道2 | Sanctuary Entrance II | 迷宫 | -393, -1260, 2046, 1730 |
| 10005103 | 寺院通道3 | Sanctuary Entrance III | 迷宫 | -400, -900, 2510, 1320 |
| 10005104 | 寺院通道4 | Sanctuary Entrance IV | 迷宫 | -490, -960, 2150, 1380 |
| 10005105 | 被孽咒的寺院 | The Cursed Sanctuary | 迷宫 | -424, -1058, 1566, 1378 |
| 90040000 | 彩虹岛体能测试 <等候室> | Physical Fitness Test <Waiting Room> | Hidden Street | -745, -780, 1757, 1291 |
| 90040001 | 彩虹岛体能挑战 <等级 1> | Physical Fitness Test <Level 1> | Hidden Street | -1195, -2446, 2027, 2837 |
| 90040002 | 彩虹岛体能挑战 <等级 2> | Physical Fitness Test <Level 2> | Hidden Street | -475, -1004, 3467, 1335 |
| 90040003 | 彩虹岛体能挑战 <等级 3> | Physical Fitness Test <Level 3> | Hidden Street | -1015, -2257, 2567, 1988 |
| 90040004 | 彩虹岛体能挑战 <等级 4> | Physical Fitness Test <Level 4> | Hidden Street | -745, -2492, 2297, 2883 |

### 连小地图也没有（7 张，都是店铺和室内，没有怪物）

| 地图 id | 中文名 | 英文名 | 地区 | 小地图覆盖的世界矩形 x, y, w, h |
|---|---|---|---|---|
| 1013 | 彩虹村杂货店 | Amherst Department Store | 彩虹岛 | 无 |
| 10000002 | 明珠港杂货店 | Lith Harbor Department Store | 金银岛 | 无 |
| 10001042 | 射手村杂货店 | Henesys Department Store | 金银岛 | 无 |
| 10001045 | 射手村护肤中心 | Henesys Skin-Care | 金银岛 | 无 |
| 10001051 | 弓箭手培训中心 | Bowman Instructional School | 金银岛 | 无 |
| 10002002 | 魔法密林杂货店 | Ellinia Department Store | 金银岛 | 无 |
| 10002003 | 魔法密林图书馆 | Magic Library | 金银岛 | 无 |

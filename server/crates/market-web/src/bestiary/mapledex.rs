//! Mapledex `monsters.json`, `maps.json` and `npcs.json` -> bestiary rows,
//! plus the NiaDB bundles that fill Mapledex's gaps (`add_niadb`): maps it
//! does not list, names of NPCs it does not know, and NPC shops; and
//! `zh-names.json` (`add_zh_names`): simplified names it lacks.
//!
//! Mapledex files are `{"items": [...]}`, NiaDB files plain arrays. Bad
//! references are skipped and reported in `Dataset::warnings` rather than
//! failing the whole import.

use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};
use std::path::Path;

use anyhow::{Context, Result};
use chrono::NaiveDate;
use serde::{Deserialize, Serialize};

use super::rows::{
    DropRow, MapNpcRow, MapRow, MobRow, NpcRow, PortalRow, QuestNeedRow, QuestRewardRow, QuestRow,
    SpawnPointRow, SpawnRow,
};

pub const DEFAULT_VERSION: &str = "CW GMS_COT2_2026-08-11";

/// Map id the client uses for "no map" (`returnMap`, portal targets).
const NO_MAP: i32 = 999_999_999;

/// Mapledex's trilingual name object.
#[derive(Debug, Default, Deserialize)]
pub(super) struct Names {
    en: Option<String>,
    zh: Option<String>,
    cw: Option<String>,
}

impl Names {
    pub(super) fn en(&self) -> Option<String> {
        clean(self.en.as_deref())
    }
    /// Classic World simplified name.
    pub(super) fn cw(&self) -> Option<String> {
        clean(self.cw.as_deref())
    }
    /// GMS-TW traditional name.
    pub(super) fn tw(&self) -> Option<String> {
        clean(self.zh.as_deref())
    }
    /// Text for a Chinese page: simplified, then traditional, then English.
    fn chinese_first(&self) -> Option<String> {
        self.cw().or_else(|| self.tw()).or_else(|| self.en())
    }
}

#[derive(Deserialize)]
struct List<T> {
    items: Vec<T>,
}

#[derive(Deserialize)]
struct RawMob {
    id: i32,
    n: Names,
    level: Option<i16>,
    hp: Option<i64>,
    mp: Option<i64>,
    exp: Option<i64>,
    pad: Option<i32>,
    pdd: Option<i32>,
    mad: Option<i32>,
    mdd: Option<i32>,
    acc: Option<i32>,
    eva: Option<i32>,
    speed: Option<i32>,
    #[serde(default)]
    maps: Vec<i32>,
    src: Option<i32>,
    link: Option<i32>,
    #[serde(rename = "dropSrc")]
    drop_src: Option<String>,
    #[serde(default)]
    drops: Vec<RawDrop>,
    d: Option<Names>,
    boss: Option<i64>,
    undead: Option<i64>,
}

#[derive(Deserialize)]
struct RawDrop {
    p: f64,
    id: Option<i32>,
    src: Option<i32>,
    n: Option<Names>,
    meso: Option<(i32, i32)>,
    quest: Option<i32>,
}

#[derive(Deserialize)]
struct RawMap {
    id: i32,
    n: Names,
    street: Option<Names>,
    d: Option<Names>,
    town: Option<i64>,
    bgm: Option<String>,
    #[serde(rename = "returnMap")]
    return_map: Option<i32>,
    src: Option<i32>,
    #[serde(default)]
    mobs: Vec<(i32, i32)>,
    #[serde(rename = "mobRate")]
    mob_rate: Option<f64>,
    #[serde(default)]
    npcs: Vec<i32>,
}

/// Everything `import_catalog` writes from Mapledex and NiaDB.
#[derive(Debug, Default)]
pub struct Dataset {
    pub mobs: Vec<MobRow>,
    pub maps: Vec<MapRow>,
    pub spawns: Vec<SpawnRow>,
    /// Every spawn point with its position, from NiaDB.
    pub spawn_points: Vec<SpawnPointRow>,
    pub drops: Vec<DropRow>,
    pub npcs: Vec<NpcRow>,
    pub map_npcs: Vec<MapNpcRow>,
    pub npc_shops: Vec<NpcShopRow>,
    /// Return-map links; Mapledex has no walking portals.
    pub portals: Vec<PortalRow>,
    pub quests: Vec<QuestRow>,
    pub quest_rewards: Vec<QuestRewardRow>,
    pub quest_needs: Vec<QuestNeedRow>,
    pub warnings: Vec<String>,
}

/// One `npc_shops` row (0010 + `source` from 0011).
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct NpcShopRow {
    pub npc_id: i32,
    pub item_id: i32,
    pub price: i64,
    /// Where the price was seen (NiaDB `priceSource`).
    pub source: Option<String>,
}

fn read(dir: &Path, name: &str) -> Result<String> {
    let path = dir.join(name);
    std::fs::read_to_string(&path).with_context(|| format!("reading {}", path.display()))
}

impl Dataset {
    /// Reads `monsters.json`, `maps.json` and `npcs.json` from a Mapledex directory.
    pub fn from_dir(dir: &Path) -> Result<Self> {
        let mut data = Self::from_json(&read(dir, "monsters.json")?, &read(dir, "maps.json")?)?;
        data.add_npc_names(&read(dir, "npcs.json")?)?;
        Ok(data)
    }

    pub fn from_json(monsters: &str, maps: &str) -> Result<Self> {
        let monsters: List<RawMob> =
            serde_json::from_str(monsters).context("parsing monsters.json")?;
        let maps: List<RawMap> = serde_json::from_str(maps).context("parsing maps.json")?;
        let mut data = Dataset::default();
        data.add_mobs(&monsters.items)?;
        data.add_maps(&maps.items)?;
        data.check_mob_maps(&monsters.items);
        Ok(data)
    }

    fn add_mobs(&mut self, raw: &[RawMob]) -> Result<()> {
        let mut seen = HashSet::new();
        for mob in raw {
            if !seen.insert(mob.id) {
                self.warnings
                    .push(format!("mob {} listed twice; kept the first", mob.id));
                continue;
            }
            let name_en = mob
                .n
                .en()
                .with_context(|| format!("mob {} has no English name", mob.id))?;
            self.mobs.push(MobRow {
                id: mob.id,
                gms_id: mob.src,
                link_id: mob.link,
                name_en,
                name_zh: mob.n.cw(),
                name_tw: mob.n.tw(),
                level: mob.level,
                hp: mob.hp,
                mp: mob.mp,
                exp: mob.exp,
                pad: mob.pad,
                pdd: mob.pdd,
                mad: mob.mad,
                mdd: mob.mdd,
                acc: mob.acc,
                eva: mob.eva,
                speed: mob.speed,
                is_boss: mob.boss.is_some_and(|v| v != 0),
                is_undead: mob.undead.is_some_and(|v| v != 0),
                description: mob.d.as_ref().and_then(Names::chinese_first),
                drop_source: mob.drop_src.clone(),
                unreleased: false,
            });
            for (ord, drop) in mob.drops.iter().enumerate() {
                if let Some(row) = self.drop_row(mob, ord, drop) {
                    self.drops.push(row);
                }
            }
        }
        Ok(())
    }

    fn drop_row(&mut self, mob: &RawMob, ord: usize, drop: &RawDrop) -> Option<DropRow> {
        let Ok(ord) = i16::try_from(ord) else {
            self.warnings
                .push(format!("mob {}: more than {} drops", mob.id, i16::MAX));
            return None;
        };
        if !(drop.p > 0.0 && drop.p <= 100.0) {
            self.warnings.push(format!(
                "mob {} drop {ord}: rate {} out of range",
                mob.id, drop.p
            ));
            return None;
        }
        // `id` is the Classic World item id; `src` alone is a GMS id with no CW match.
        let gms_item_id = if drop.id.is_none() { drop.src } else { None };
        if drop.id.is_none() && gms_item_id.is_none() && drop.meso.is_none() {
            self.warnings
                .push(format!("mob {} drop {ord}: no item and no meso", mob.id));
            return None;
        }
        let names = drop.n.as_ref();
        Some(DropRow {
            mob_id: mob.id,
            ord,
            item_id: drop.id,
            gms_item_id,
            name_en: names.and_then(Names::en),
            name_zh: names.and_then(Names::cw),
            name_tw: names.and_then(Names::tw),
            meso_min: drop.meso.map(|(lo, _)| lo),
            meso_max: drop.meso.map(|(_, hi)| hi),
            rate_pct: Some(drop.p),
            quest_id: drop.quest,
            source: mob.drop_src.clone(),
            upvotes: None,
            downvotes: None,
        })
    }

    fn add_maps(&mut self, raw: &[RawMap]) -> Result<()> {
        let map_ids: HashSet<i32> = raw.iter().map(|m| m.id).collect();
        let mob_ids: HashSet<i32> = self.mobs.iter().map(|m| m.id).collect();
        let mut seen = HashSet::new();
        let mut npc_ids = BTreeSet::new();
        for map in raw {
            if !seen.insert(map.id) {
                self.warnings
                    .push(format!("map {} listed twice; kept the first", map.id));
                continue;
            }
            let return_map_id = self.return_map(map, &map_ids);
            if let Some(to) = return_map_id {
                self.portals.push(PortalRow {
                    from_map_id: map.id,
                    to_map_id: to,
                    kind: "return",
                    portal_name: None,
                    target_portal: None,
                    x: None,
                    y: None,
                    source: "mapledex",
                });
            }
            let street = map.street.as_ref();
            self.maps.push(MapRow {
                id: map.id,
                gms_id: map.src,
                name_en: map
                    .n
                    .en()
                    .with_context(|| format!("map {} has no English name", map.id))?,
                name_zh: map.n.cw(),
                name_tw: map.n.tw(),
                street_en: street.and_then(Names::en),
                street_zh: street.and_then(Names::cw),
                street_tw: street.and_then(Names::tw),
                description: map.d.as_ref().and_then(Names::chinese_first),
                is_town: map.town.is_some_and(|v| v != 0),
                return_map_id,
                mob_rate: map.mob_rate,
                bgm: clean(map.bgm.as_deref()),
                minimap_url: None,
                unreleased: false,
                minimap_w: None,
                minimap_h: None,
                minimap_cx: None,
                minimap_cy: None,
                spawn_x: None,
                spawn_y: None,
            });
            self.add_spawns(map, &mob_ids);
            for npc_id in map.npcs.iter().copied().collect::<BTreeSet<_>>() {
                npc_ids.insert(npc_id);
                self.map_npcs.push(MapNpcRow {
                    map_id: map.id,
                    npc_id,
                    x: None,
                    y: None,
                });
            }
        }
        // maps.json only carries NPC ids; `add_npc_names` adds the names.
        self.npcs = npc_ids.into_iter().map(unnamed_npc).collect();
        Ok(())
    }

    fn return_map(&mut self, map: &RawMap, map_ids: &HashSet<i32>) -> Option<i32> {
        let to = map.return_map.filter(|&to| to != map.id)?;
        if map_ids.contains(&to) {
            Some(to)
        } else {
            self.warnings
                .push(format!("map {}: return map {to} is not listed", map.id));
            None
        }
    }

    fn add_spawns(&mut self, map: &RawMap, mob_ids: &HashSet<i32>) {
        let mut seen = HashSet::new();
        for &(mob_id, count) in &map.mobs {
            if !mob_ids.contains(&mob_id) {
                self.warnings
                    .push(format!("map {}: unknown mob {mob_id}", map.id));
                continue;
            }
            if !seen.insert(mob_id) {
                self.warnings
                    .push(format!("map {}: mob {mob_id} listed twice", map.id));
                continue;
            }
            let Ok(spawn_count) = i16::try_from(count) else {
                self.warnings
                    .push(format!("map {}: spawn count {count} out of range", map.id));
                continue;
            };
            self.spawns.push(SpawnRow {
                map_id: map.id,
                mob_id,
                spawn_count,
            });
        }
    }

    /// `monsters.json` repeats the spawn list from the mob side; report pairs
    /// the map side does not have.
    fn check_mob_maps(&mut self, raw: &[RawMob]) {
        let spawns: HashSet<(i32, i32)> =
            self.spawns.iter().map(|s| (s.map_id, s.mob_id)).collect();
        for mob in raw {
            for &map_id in &mob.maps {
                if !spawns.contains(&(map_id, mob.id)) {
                    self.warnings.push(format!(
                        "mob {} lists map {map_id}, which does not list the mob",
                        mob.id
                    ));
                }
            }
        }
    }

    /// Names from Mapledex `npcs.json`. NPCs it lists without a map
    /// placement are added too, so shops and quests can name them.
    pub fn add_npc_names(&mut self, npcs: &str) -> Result<()> {
        #[derive(Deserialize)]
        struct RawNpc {
            id: i32,
            n: Names,
        }
        let npcs: List<RawNpc> = serde_json::from_str(npcs).context("parsing npcs.json")?;
        let mut rows = self.take_npcs();
        let mut seen = HashSet::new();
        for npc in npcs.items {
            if !seen.insert(npc.id) {
                self.warnings
                    .push(format!("npc {} listed twice; kept the first", npc.id));
                continue;
            }
            let row = rows.entry(npc.id).or_insert_with(|| unnamed_npc(npc.id));
            row.name_en = npc.n.en();
            row.name_zh = npc.n.cw();
            row.name_tw = npc.n.tw();
        }
        self.npcs = rows.into_values().collect();
        Ok(())
    }

    fn take_npcs(&mut self) -> BTreeMap<i32, NpcRow> {
        self.npcs.drain(..).map(|n| (n.id, n)).collect()
    }
}

fn unnamed_npc(id: i32) -> NpcRow {
    NpcRow {
        id,
        name_en: None,
        name_zh: None,
        name_tw: None,
        unreleased: false,
    }
}

// ---------- NiaDB ----------

/// An entry of NiaDB `maps.json`. Ids are zero-padded strings.
#[derive(Deserialize)]
struct NiaMap {
    id: String,
    name: Option<String>,
    #[serde(rename = "streetName")]
    street: Option<String>,
    /// MapleIsland, VictoriaIsland, Ossyria, Other, Event.
    region: Option<String>,
    #[serde(rename = "isTown", default)]
    is_town: bool,
    bgm: Option<String>,
    #[serde(rename = "returnMap")]
    return_map: Option<String>,
    #[serde(rename = "mobRate")]
    mob_rate: Option<f64>,
    #[serde(default)]
    npcs: Vec<NiaNpc>,
    #[serde(default)]
    monsters: Vec<NiaMob>,
    #[serde(default)]
    spawns: Vec<NiaSpawn>,
    #[serde(rename = "playerSpawns", default)]
    player_spawns: Vec<NiaPoint>,
    #[serde(rename = "minimapWidth")]
    minimap_w: Option<i32>,
    #[serde(rename = "minimapHeight")]
    minimap_h: Option<i32>,
    #[serde(rename = "miniMapCenterX")]
    minimap_cx: Option<i32>,
    #[serde(rename = "miniMapCenterY")]
    minimap_cy: Option<i32>,
    #[serde(rename = "hasMinimapImage", default)]
    has_minimap: bool,
}

#[derive(Deserialize)]
struct NiaNpc {
    id: String,
    name: Option<String>,
    x: Option<i32>,
    y: Option<i32>,
}

#[derive(Deserialize)]
struct NiaSpawn {
    #[serde(rename = "mobId")]
    mob_id: String,
    x: i32,
    y: i32,
    #[serde(rename = "mobTime", default)]
    mob_time: i32,
}

#[derive(Deserialize)]
struct NiaPoint {
    x: i32,
    y: i32,
}

#[derive(Deserialize)]
struct NiaMob {
    id: String,
    count: Option<i64>,
}

/// An entry of NiaDB `npc-shops.json`.
#[derive(Deserialize)]
struct NiaShop {
    #[serde(rename = "npcId")]
    npc_id: i32,
    #[serde(rename = "npcName")]
    npc_name: Option<String>,
    #[serde(rename = "priceSource")]
    price_source: Option<String>,
    #[serde(default)]
    items: Vec<NiaShopItem>,
}

#[derive(Deserialize)]
struct NiaShopItem {
    /// Classic World item id.
    #[serde(rename = "iconKey")]
    icon_key: String,
    #[serde(rename = "classicPrice")]
    classic_price: Option<i64>,
}

/// What `add_niadb` added.
#[derive(Debug, Default, Clone, PartialEq, Eq, Serialize)]
pub struct NiaDbCounts {
    /// Maps Mapledex does not list.
    pub maps: usize,
    pub spawns: usize,
    pub return_links: usize,
    /// Map placements Mapledex does not have.
    pub npc_placements: usize,
    /// NPCs named from NiaDB because Mapledex has no name for them.
    pub npc_names: usize,
    pub shop_rows: usize,
}

pub(super) fn nia_id(raw: &str) -> Option<i32> {
    raw.trim().parse().ok()
}

impl Dataset {
    /// Reads `maps.json` and `npc-shops.json` from a NiaDB directory.
    pub fn add_niadb_dir(&mut self, dir: &Path) -> Result<NiaDbCounts> {
        self.add_niadb(&read(dir, "maps.json")?, &read(dir, "npc-shops.json")?)
    }

    /// Fills Mapledex's gaps from NiaDB: the maps it lacks (with their
    /// spawns and return links), NPC placements and names it lacks, and the
    /// NPC shops. Mapledex rows are never changed. Call after `add_npc_names`.
    pub fn add_niadb(&mut self, maps: &str, shops: &str) -> Result<NiaDbCounts> {
        let maps: Vec<NiaMap> = serde_json::from_str(maps).context("parsing NiaDB maps.json")?;
        let shops: Vec<NiaShop> =
            serde_json::from_str(shops).context("parsing NiaDB npc-shops.json")?;
        let mut counts = NiaDbCounts::default();
        let mut npcs = self.take_npcs();
        let maps = self.parse_nia_maps(&maps);
        self.add_nia_maps(&maps, &mut counts);
        self.add_nia_placements(&maps, &mut npcs, &mut counts);
        self.add_nia_shops(&shops, &mut npcs, &mut counts);
        self.npcs = npcs.into_values().collect();
        Ok(counts)
    }

    fn parse_nia_maps<'a>(&mut self, maps: &'a [NiaMap]) -> Vec<(i32, &'a NiaMap)> {
        let mut seen = HashSet::new();
        let mut out = Vec::with_capacity(maps.len());
        for map in maps {
            match nia_id(&map.id) {
                Some(id) if seen.insert(id) => out.push((id, map)),
                Some(id) => self
                    .warnings
                    .push(format!("NiaDB map {id} listed twice; kept the first")),
                None => self
                    .warnings
                    .push(format!("NiaDB map id {:?} is not a number", map.id)),
            }
        }
        out
    }

    fn add_nia_maps(&mut self, maps: &[(i32, &NiaMap)], counts: &mut NiaDbCounts) {
        let mut listed: HashSet<i32> = self.maps.iter().map(|m| m.id).collect();
        let new: Vec<(i32, &NiaMap, String)> = maps
            .iter()
            .filter(|(id, _)| !listed.contains(id))
            .filter_map(|&(id, map)| match clean(map.name.as_deref()) {
                Some(name) => Some((id, map, name)),
                None => {
                    self.warnings.push(format!("NiaDB map {id} has no name"));
                    None
                }
            })
            .collect();
        listed.extend(new.iter().map(|(id, _, _)| *id));
        let mob_ids: HashSet<i32> = self.mobs.iter().map(|m| m.id).collect();
        for (id, map, name) in new {
            let return_map_id = map
                .return_map
                .as_deref()
                .and_then(nia_id)
                .filter(|&to| to != id && to != NO_MAP && listed.contains(&to));
            if let Some(to) = return_map_id {
                self.portals.push(PortalRow {
                    from_map_id: id,
                    to_map_id: to,
                    kind: "return",
                    portal_name: None,
                    target_portal: None,
                    x: None,
                    y: None,
                    source: "niadb",
                });
                counts.return_links += 1;
            }
            self.maps.push(MapRow {
                id,
                gms_id: None,
                name_en: name,
                name_zh: None,
                name_tw: None,
                street_en: clean(map.street.as_deref()),
                street_zh: None,
                street_tw: None,
                description: None,
                is_town: map.is_town,
                return_map_id,
                mob_rate: map.mob_rate,
                bgm: clean(map.bgm.as_deref()),
                minimap_url: None,
                unreleased: false,
                minimap_w: None,
                minimap_h: None,
                minimap_cx: None,
                minimap_cy: None,
                spawn_x: None,
                spawn_y: None,
            });
            counts.maps += 1;
            counts.spawns += self.add_nia_spawns(id, &map.monsters, &mob_ids);
        }
    }

    fn add_nia_spawns(&mut self, map_id: i32, mobs: &[NiaMob], mob_ids: &HashSet<i32>) -> usize {
        let mut per_mob: BTreeMap<i32, i64> = BTreeMap::new();
        for mob in mobs {
            match nia_id(&mob.id) {
                Some(id) if mob_ids.contains(&id) => {
                    *per_mob.entry(id).or_default() += mob.count.unwrap_or(0);
                }
                _ => self
                    .warnings
                    .push(format!("NiaDB map {map_id}: unknown mob {:?}", mob.id)),
            }
        }
        let before = self.spawns.len();
        for (mob_id, count) in per_mob {
            match i16::try_from(count) {
                Ok(spawn_count) if spawn_count > 0 => self.spawns.push(SpawnRow {
                    map_id,
                    mob_id,
                    spawn_count,
                }),
                _ => self.warnings.push(format!(
                    "NiaDB map {map_id}: spawn count {count} out of range"
                )),
            }
        }
        self.spawns.len() - before
    }

    fn add_nia_placements(
        &mut self,
        maps: &[(i32, &NiaMap)],
        npcs: &mut BTreeMap<i32, NpcRow>,
        counts: &mut NiaDbCounts,
    ) {
        let listed: HashSet<i32> = self.maps.iter().map(|m| m.id).collect();
        let mut placed: HashSet<(i32, i32)> =
            self.map_npcs.iter().map(|p| (p.map_id, p.npc_id)).collect();
        for &(map_id, map) in maps.iter().filter(|(id, _)| listed.contains(id)) {
            for npc in &map.npcs {
                let Some(npc_id) = nia_id(&npc.id) else {
                    self.warnings
                        .push(format!("NiaDB map {map_id}: NPC id {:?}", npc.id));
                    continue;
                };
                counts.npc_names += name_if_unnamed(npcs, npc_id, npc.name.as_deref());
                if placed.insert((map_id, npc_id)) {
                    self.map_npcs.push(MapNpcRow {
                        map_id,
                        npc_id,
                        x: npc.x,
                        y: npc.y,
                    });
                    counts.npc_placements += 1;
                }
            }
        }
    }

    fn add_nia_shops(
        &mut self,
        shops: &[NiaShop],
        npcs: &mut BTreeMap<i32, NpcRow>,
        counts: &mut NiaDbCounts,
    ) {
        let mut prices: HashMap<(i32, i32), i64> = HashMap::new();
        for shop in shops {
            counts.npc_names += name_if_unnamed(npcs, shop.npc_id, shop.npc_name.as_deref());
            for item in &shop.items {
                let Some(item_id) = nia_id(&item.icon_key) else {
                    self.warnings.push(format!(
                        "NiaDB shop of NPC {}: item {:?} is not an id",
                        shop.npc_id, item.icon_key
                    ));
                    continue;
                };
                let Some(price) = item.classic_price.filter(|&p| p >= 0) else {
                    self.warnings.push(format!(
                        "NiaDB shop of NPC {}: item {item_id} has no Classic price",
                        shop.npc_id
                    ));
                    continue;
                };
                if let Some(&kept) = prices.get(&(shop.npc_id, item_id)) {
                    if kept != price {
                        self.warnings.push(format!(
                            "NiaDB shop of NPC {}: item {item_id} at {kept} and {price}; kept {kept}",
                            shop.npc_id
                        ));
                    }
                    continue;
                }
                prices.insert((shop.npc_id, item_id), price);
                self.npc_shops.push(NpcShopRow {
                    npc_id: shop.npc_id,
                    item_id,
                    price,
                    source: clean(shop.price_source.as_deref()),
                });
            }
        }
        counts.shop_rows = self.npc_shops.len();
    }
}

// ---------- NiaDB bestiary (what exists in Classic World) ----------

/// The NiaDB region that is in the client but not open yet (Orbis, El Nath).
/// NiaDB hides it by default on its map and monster lists.
const UNRELEASED_REGION: &str = "Ossyria";

/// An area NiaDB lists that opens on a known day. Its maps and quests stay
/// unreleased when imported before that day; re-run `import_catalog` after it.
struct OpensLater {
    maps: std::ops::RangeInclusive<i32>,
    /// NiaDB `quests.json` `area` of its quests.
    quest_area: i32,
    day: (i32, u32, u32),
}

const OPENS_LATER: &[OpensLater] = &[
    // Forgotten Hollow (NiaDB: opens November 18).
    OpensLater {
        maps: 10_006_000..=10_006_999,
        quest_area: 17,
        day: (2026, 11, 18),
    },
];

fn before(day: (i32, u32, u32), today: NaiveDate) -> bool {
    NaiveDate::from_ymd_opt(day.0, day.1, day.2).is_some_and(|day| today < day)
}

pub(crate) fn opens_later(map_id: i32, today: NaiveDate) -> bool {
    OPENS_LATER
        .iter()
        .any(|a| a.maps.contains(&map_id) && before(a.day, today))
}

/// "Mano (alt) (GM Event)", "Flyeye (alt2)".
fn copy_name(name: &str) -> bool {
    let name = name.to_ascii_lowercase();
    name.contains("(gm event)") || name.contains("(alt)") || name.contains("(alt2)")
}

/// NiaDB names the map. A Mapledex English name that differs belongs to
/// something else (Mapledex has 88000000's name and street swapped), so its
/// Chinese names go too.
fn take_nia_name(map: &mut MapRow, source: &NiaMap) {
    let Some(name) = clean(source.name.as_deref()) else {
        return;
    };
    if fold_name(&name) == fold_name(&map.name_en) {
        return;
    }
    map.name_en = name;
    map.name_zh = None;
    map.name_tw = None;
    map.street_en = clean(source.street.as_deref());
    map.street_zh = None;
    map.street_tw = None;
}

fn fold_name(name: &str) -> String {
    name.chars()
        .filter(char::is_ascii_alphanumeric)
        .map(|c| c.to_ascii_lowercase())
        .collect()
}

/// NiaDB names maps the client leaves unnamed by their id ("080003500").
fn placeholder_name(name: &str) -> bool {
    !name.is_empty() && name.chars().all(|c| c.is_ascii_digit())
}

/// Minimap box, image and player spawn from NiaDB.
fn set_view(map: &mut MapRow, source: &NiaMap) {
    let size = source
        .minimap_w
        .zip(source.minimap_h)
        .filter(|&(w, h)| w > 0 && h > 0);
    let center = source.minimap_cx.zip(source.minimap_cy);
    if let (Some((w, h)), Some((cx, cy))) = (size, center) {
        map.minimap_w = Some(w);
        map.minimap_h = Some(h);
        map.minimap_cx = Some(cx);
        map.minimap_cy = Some(cy);
        map.minimap_url = source
            .has_minimap
            .then(|| format!("/web/images/minimaps/{}.png", map.id));
    }
    if let Some(spawn) = source.player_spawns.first() {
        map.spawn_x = Some(spawn.x);
        map.spawn_y = Some(spawn.y);
    }
}

/// A quest of an area that is not open yet.
pub(crate) fn quest_area_opens_later(area: i32, today: NaiveDate) -> bool {
    OPENS_LATER
        .iter()
        .any(|a| a.quest_area == area && before(a.day, today))
}

/// An entry of NiaDB `monsters.json`: launch stats and the regions it spawns in.
#[derive(Deserialize)]
struct NiaMonster {
    id: i32,
    name: Option<String>,
    level: Option<i16>,
    hp: Option<i64>,
    mp: Option<i64>,
    exp: Option<i64>,
    pdmg: Option<i32>,
    mdmg: Option<i32>,
    pdef: Option<i32>,
    mdef: Option<i32>,
    acc: Option<i32>,
    avoid: Option<i32>,
    #[serde(default)]
    tags: Vec<String>,
    #[serde(default)]
    regions: Vec<String>,
}

/// NiaDB `drops.json` (written by `tools/niadb_bestiary.py`).
#[derive(Deserialize)]
struct NiaDrops {
    monsters: BTreeMap<String, NiaMobDrops>,
}

#[derive(Deserialize)]
struct NiaMobDrops {
    #[serde(default)]
    drops: Vec<NiaDrop>,
}

/// One item players reported for a monster, with its community votes.
#[derive(Deserialize)]
struct NiaDrop {
    /// Classic World item id.
    #[serde(rename = "itemIconKey")]
    icon_key: String,
    #[serde(rename = "itemName")]
    item_name: Option<String>,
    #[serde(default)]
    upvotes: f64,
    #[serde(default)]
    downvotes: f64,
}

/// NiaDB `mesos.json` (written by `tools/niadb_bestiary.py`).
#[derive(Deserialize)]
struct NiaMesos {
    monsters: BTreeMap<String, NiaMobMesos>,
}

#[derive(Deserialize)]
struct NiaMobMesos {
    summary: Option<NiaMesoSummary>,
    #[serde(default)]
    reports: Vec<NiaMesoReport>,
}

/// NiaDB's median over the reports it trusts, as its monster pages show it.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct NiaMesoSummary {
    #[serde(default)]
    trusted_count: i64,
    median_min: Option<i32>,
    median_max: Option<i32>,
}

/// One meso amount a player saw per pile, with its votes.
#[derive(Deserialize)]
struct NiaMesoReport {
    #[serde(default)]
    upvotes: f64,
    #[serde(default)]
    downvotes: f64,
}

/// What `apply_niadb_bestiary` changed.
#[derive(Debug, Default, Clone, PartialEq, Eq, Serialize)]
pub struct NiaBestiaryCounts {
    pub mobs: usize,
    /// Mobs only NiaDB lists.
    pub mobs_added: usize,
    /// Ids where Mapledex has a different mob (its GMS-era list): NiaDB's
    /// mob replaces it, without Mapledex's names, GMS id or description.
    pub mobs_replaced: usize,
    /// Mapledex mobs NiaDB does not list (test and unused copies), dropped.
    pub mobs_removed: usize,
    pub mobs_unreleased: usize,
    /// GM-event and "(alt)" copies of other mobs that spawn nowhere, hidden
    /// like unreleased mobs (counted in `mobs_unreleased` too).
    pub mob_copies: usize,
    pub maps: usize,
    /// Mapledex maps NiaDB does not list, dropped.
    pub maps_removed: usize,
    pub maps_unreleased: usize,
    pub npcs_unreleased: usize,
    pub spawns: usize,
    /// Drops with more up than down votes.
    pub drops: usize,
    /// Reported drops left out: no more up than down votes.
    pub drops_unconfirmed: usize,
    /// Mobs with a meso range (NiaDB's median over its trusted reports).
    pub mesos: usize,
    /// Mobs with meso reports NiaDB does not trust yet, left out.
    pub mesos_untrusted: usize,
}

impl Dataset {
    /// Everything `import_catalog` takes from a NiaDB directory: `add_niadb`
    /// (`maps.json`, `npc-shops.json`) and the bestiary (`monsters.json`,
    /// `maps.json`, `drops.json`, `mesos.json`). `today` decides which areas in
    /// `OPENS_LATER` are open.
    pub fn add_niadb_bestiary_dir(
        &mut self,
        dir: &Path,
        today: NaiveDate,
    ) -> Result<(NiaDbCounts, NiaBestiaryCounts)> {
        self.add_niadb_bestiary(
            &read(dir, "monsters.json")?,
            &read(dir, "maps.json")?,
            &read(dir, "npc-shops.json")?,
            &read(dir, "drops.json")?,
            &read(dir, "mesos.json")?,
            today,
        )
    }

    /// Makes NiaDB the source of what exists: its mobs with their launch stats
    /// (Mapledex keeps the names it has; mobs NiaDB does not list are dropped),
    /// its maps (other Mapledex maps are dropped), its spawns, only the drops
    /// players confirmed (more up than down votes), and NiaDB's meso range per
    /// mob (Mapledex's drop table, rates and mesos are replaced). Content that is not open yet is marked unreleased:
    /// Orbis / El Nath, areas in `OPENS_LATER` before their day, mobs that only
    /// spawn there, and NPCs that only stand there. Runs `add_niadb` in between,
    /// once the mob list is NiaDB's. Call after `add_npc_names`, before `add_zh_names`.
    pub fn add_niadb_bestiary(
        &mut self,
        monsters: &str,
        maps: &str,
        shops: &str,
        drops: &str,
        mesos: &str,
        today: NaiveDate,
    ) -> Result<(NiaDbCounts, NiaBestiaryCounts)> {
        let monsters: Vec<NiaMonster> =
            serde_json::from_str(monsters).context("parsing NiaDB monsters.json")?;
        let drops: NiaDrops = serde_json::from_str(drops).context("parsing NiaDB drops.json")?;
        let mesos: NiaMesos = serde_json::from_str(mesos).context("parsing NiaDB mesos.json")?;
        let mut counts = NiaBestiaryCounts::default();
        self.apply_nia_mobs(&monsters, &mut counts);
        let added = self.add_niadb(maps, shops)?;
        let maps: Vec<NiaMap> = serde_json::from_str(maps).context("parsing NiaDB maps.json")?;
        let reported = self.warnings.len();
        let maps = self.parse_nia_maps(&maps);
        self.warnings.truncate(reported); // `add_niadb` already reported bad map ids
        self.apply_nia_maps(&maps, today, &mut counts);
        self.mark_mobs_without_open_maps(&mut counts);
        self.hide_mob_copies(&monsters, &mut counts);
        self.apply_nia_drops(&drops, &mut counts);
        self.apply_nia_mesos(&mesos, &mut counts);
        Ok((added, counts))
    }

    fn apply_nia_mobs(&mut self, monsters: &[NiaMonster], counts: &mut NiaBestiaryCounts) {
        let mut mapledex: HashMap<i32, MobRow> = self.mobs.drain(..).map(|m| (m.id, m)).collect();
        let mut seen = HashSet::new();
        for nia in monsters {
            if !seen.insert(nia.id) {
                self.warnings.push(format!(
                    "NiaDB monster {} listed twice; kept the first",
                    nia.id
                ));
                continue;
            }
            let mapledex_row = mapledex.remove(&nia.id);
            let same = mapledex_row
                .as_ref()
                .is_some_and(|row| same_mob_name(&row.name_en, nia.name.as_deref().unwrap_or("")));
            let existed = mapledex_row.is_some();
            counts.mobs_replaced += usize::from(existed && !same);
            let mut row = match mapledex_row.filter(|_| same) {
                Some(row) => row,
                None => {
                    let Some(name_en) = clean(nia.name.as_deref()) else {
                        self.warnings
                            .push(format!("NiaDB monster {} has no name", nia.id));
                        continue;
                    };
                    counts.mobs_added += usize::from(!existed);
                    MobRow {
                        id: nia.id,
                        gms_id: None,
                        link_id: None,
                        name_en,
                        name_zh: None,
                        name_tw: None,
                        level: None,
                        hp: None,
                        mp: None,
                        exp: None,
                        pad: None,
                        pdd: None,
                        mad: None,
                        mdd: None,
                        acc: None,
                        eva: None,
                        speed: None,
                        is_boss: false,
                        is_undead: false,
                        description: None,
                        drop_source: None,
                        unreleased: false,
                    }
                }
            };
            row.level = nia.level.or(row.level);
            row.hp = nia.hp.or(row.hp);
            row.mp = nia.mp.or(row.mp);
            row.exp = nia.exp.or(row.exp);
            row.pad = nia.pdmg.or(row.pad);
            row.mad = nia.mdmg.or(row.mad);
            row.pdd = nia.pdef.or(row.pdd);
            row.mdd = nia.mdef.or(row.mdd);
            row.acc = nia.acc.or(row.acc);
            row.eva = nia.avoid.or(row.eva);
            row.is_boss |= nia.tags.iter().any(|t| t == "boss");
            row.is_undead |= nia.tags.iter().any(|t| t == "undead");
            row.drop_source = Some("niadb".into());
            // Mobs without spawns keep this; the others follow their maps.
            row.unreleased =
                !nia.regions.is_empty() && nia.regions.iter().all(|r| r == UNRELEASED_REGION);
            self.mobs.push(row);
        }
        counts.mobs_removed = mapledex.len();
        counts.mobs = self.mobs.len();
        self.mobs.sort_by_key(|m| m.id);
    }

    fn apply_nia_maps(
        &mut self,
        maps: &[(i32, &NiaMap)],
        today: NaiveDate,
        counts: &mut NiaBestiaryCounts,
    ) {
        let nia: HashMap<i32, &NiaMap> = maps.iter().copied().collect();
        let before = self.maps.len();
        self.maps.retain(|m| nia.contains_key(&m.id));
        counts.maps_removed = before - self.maps.len();
        let listed: HashSet<i32> = self.maps.iter().map(|m| m.id).collect();
        let mut unreleased = HashSet::new();
        for map in &mut self.maps {
            let source = nia[&map.id];
            take_nia_name(map, source);
            map.unreleased = source.region.as_deref() == Some(UNRELEASED_REGION)
                || opens_later(map.id, today)
                || placeholder_name(&map.name_en);
            if map.unreleased {
                unreleased.insert(map.id);
            }
            map.mob_rate = source.mob_rate.or(map.mob_rate);
            map.return_map_id = map.return_map_id.filter(|to| listed.contains(to));
            set_view(map, source);
        }
        counts.maps = self.maps.len();
        counts.maps_unreleased = unreleased.len();
        self.add_spawn_points(maps);
        self.place_nia_npcs(maps);
        self.portals
            .retain(|p| listed.contains(&p.from_map_id) && listed.contains(&p.to_map_id));
        self.map_npcs.retain(|p| listed.contains(&p.map_id));
        // NPCs whose every placement is on an unreleased map are not reachable.
        let mut placements: HashMap<i32, (usize, usize)> = HashMap::new();
        for p in &self.map_npcs {
            let entry = placements.entry(p.npc_id).or_default();
            entry.0 += 1;
            entry.1 += usize::from(unreleased.contains(&p.map_id));
        }
        for npc in &mut self.npcs {
            npc.unreleased =
                matches!(placements.get(&npc.id), Some(&(all, hidden)) if all == hidden);
            counts.npcs_unreleased += usize::from(npc.unreleased);
        }
        // Spawns: NiaDB's per-map monster lists replace Mapledex's.
        self.spawns.clear();
        let mob_ids: HashSet<i32> = self.mobs.iter().map(|m| m.id).collect();
        let mut ids: Vec<i32> = listed.into_iter().collect();
        ids.sort_unstable();
        for id in ids {
            counts.spawns += self.add_nia_spawns(id, &nia[&id].monsters, &mob_ids);
        }
    }

    /// One row per NiaDB spawn point of a listed mob, in NiaDB's order.
    fn add_spawn_points(&mut self, maps: &[(i32, &NiaMap)]) {
        let listed: HashSet<i32> = self.maps.iter().map(|m| m.id).collect();
        let mob_ids: HashSet<i32> = self.mobs.iter().map(|m| m.id).collect();
        self.spawn_points.clear();
        for &(map_id, map) in maps.iter().filter(|(id, _)| listed.contains(id)) {
            let mut ord: i16 = 0;
            for spawn in &map.spawns {
                let Some(mob_id) = nia_id(&spawn.mob_id).filter(|id| mob_ids.contains(id)) else {
                    continue; // `add_nia_spawns` reports unknown mobs
                };
                self.spawn_points.push(SpawnPointRow {
                    map_id,
                    ord,
                    mob_id,
                    x: spawn.x,
                    y: spawn.y,
                    mob_time: spawn.mob_time.max(0),
                });
                ord = ord.saturating_add(1);
            }
        }
    }

    /// Where each NPC stands, from NiaDB (Mapledex placements carry no position).
    fn place_nia_npcs(&mut self, maps: &[(i32, &NiaMap)]) {
        let mut at: HashMap<(i32, i32), (i32, i32)> = HashMap::new();
        for &(map_id, map) in maps {
            for npc in &map.npcs {
                if let (Some(id), Some(x), Some(y)) = (nia_id(&npc.id), npc.x, npc.y) {
                    at.entry((map_id, id)).or_insert((x, y));
                }
            }
        }
        for placement in &mut self.map_npcs {
            if let Some(&(x, y)) = at.get(&(placement.map_id, placement.npc_id)) {
                placement.x = Some(x);
                placement.y = Some(y);
            }
        }
    }

    /// NiaDB lists GM-event and "(alt)" copies of mobs ("Mano (alt) (GM
    /// Event)", "Stirge (alt2)"). Ones that spawn on no open map are hidden;
    /// instance copies with spawns (party quests) stay.
    fn hide_mob_copies(&mut self, monsters: &[NiaMonster], counts: &mut NiaBestiaryCounts) {
        let copies: HashSet<i32> = monsters
            .iter()
            .filter(|m| m.name.as_deref().is_some_and(copy_name))
            .map(|m| m.id)
            .collect();
        let open: HashSet<i32> = self
            .maps
            .iter()
            .filter(|m| !m.unreleased)
            .map(|m| m.id)
            .collect();
        let spawning: HashSet<i32> = self
            .spawns
            .iter()
            .filter(|s| open.contains(&s.map_id))
            .map(|s| s.mob_id)
            .collect();
        for mob in &mut self.mobs {
            if copies.contains(&mob.id) && !spawning.contains(&mob.id) {
                counts.mob_copies += 1;
                if !mob.unreleased {
                    mob.unreleased = true;
                    counts.mobs_unreleased += 1;
                }
            }
        }
    }

    /// A mob is unreleased when every map it spawns on is.
    fn mark_mobs_without_open_maps(&mut self, counts: &mut NiaBestiaryCounts) {
        let hidden: HashSet<i32> = self
            .maps
            .iter()
            .filter(|m| m.unreleased)
            .map(|m| m.id)
            .collect();
        let mut maps: HashMap<i32, (usize, usize)> = HashMap::new();
        for spawn in &self.spawns {
            let entry = maps.entry(spawn.mob_id).or_default();
            entry.0 += 1;
            entry.1 += usize::from(hidden.contains(&spawn.map_id));
        }
        for mob in &mut self.mobs {
            if let Some(&(all, unreleased)) = maps.get(&mob.id) {
                mob.unreleased = all == unreleased;
            }
            counts.mobs_unreleased += usize::from(mob.unreleased);
        }
    }

    fn apply_nia_drops(&mut self, drops: &NiaDrops, counts: &mut NiaBestiaryCounts) {
        let mob_ids: HashSet<i32> = self.mobs.iter().map(|m| m.id).collect();
        self.drops.clear();
        for (mob, list) in &drops.monsters {
            let Some(mob_id) = nia_id(mob).filter(|id| mob_ids.contains(id)) else {
                if !list.drops.is_empty() {
                    self.warnings
                        .push(format!("NiaDB drops of unknown monster {mob:?}"));
                }
                continue;
            };
            // One row per item: the report with the best score.
            let mut best: BTreeMap<i32, &NiaDrop> = BTreeMap::new();
            for drop in &list.drops {
                let Some(item_id) = nia_id(&drop.icon_key) else {
                    self.warnings.push(format!(
                        "NiaDB drop of monster {mob_id}: item {:?} is not an id",
                        drop.icon_key
                    ));
                    continue;
                };
                if drop.upvotes <= drop.downvotes {
                    counts.drops_unconfirmed += 1;
                    continue;
                }
                let score = |d: &NiaDrop| d.upvotes - d.downvotes;
                if best
                    .get(&item_id)
                    .is_none_or(|kept| score(drop) > score(kept))
                {
                    best.insert(item_id, drop);
                }
            }
            let mut rows: Vec<(i32, &NiaDrop)> = best.into_iter().collect();
            rows.sort_by(|(a_id, a), (b_id, b)| {
                (b.upvotes - b.downvotes)
                    .total_cmp(&(a.upvotes - a.downvotes))
                    .then(a_id.cmp(b_id))
            });
            for (ord, (item_id, drop)) in rows.into_iter().enumerate() {
                let Ok(ord) = i16::try_from(ord) else {
                    break;
                };
                self.drops.push(DropRow {
                    mob_id,
                    ord,
                    item_id: Some(item_id),
                    gms_item_id: None,
                    name_en: clean(drop.item_name.as_deref()),
                    name_zh: None,
                    name_tw: None,
                    meso_min: None,
                    meso_max: None,
                    rate_pct: None,
                    quest_id: None,
                    source: Some("niadb".into()),
                    upvotes: Some(drop.upvotes),
                    downvotes: Some(drop.downvotes),
                });
            }
        }
        counts.drops = self.drops.len();
    }

    /// One meso row per mob NiaDB has a trusted range for: its median min and
    /// max per pile. The votes are the sums over the mob's reports.
    fn apply_nia_mesos(&mut self, mesos: &NiaMesos, counts: &mut NiaBestiaryCounts) {
        let mob_ids: HashSet<i32> = self.mobs.iter().map(|m| m.id).collect();
        let mut next_ord: HashMap<i32, i16> = HashMap::new();
        for drop in &self.drops {
            let next = next_ord.entry(drop.mob_id).or_default();
            *next = (*next).max(drop.ord.saturating_add(1));
        }
        for (mob, list) in &mesos.monsters {
            let Some(mob_id) = nia_id(mob).filter(|id| mob_ids.contains(id)) else {
                if !list.reports.is_empty() {
                    self.warnings
                        .push(format!("NiaDB meso reports of unknown monster {mob:?}"));
                }
                continue;
            };
            let range = list
                .summary
                .as_ref()
                .filter(|s| s.trusted_count > 0)
                .and_then(|s| s.median_min.zip(s.median_max))
                .filter(|&(min, max)| 0 <= min && min <= max && max > 0);
            let Some((min, max)) = range else {
                counts.mesos_untrusted += usize::from(!list.reports.is_empty());
                continue;
            };
            let ord = next_ord.get(&mob_id).copied().unwrap_or(0);
            self.drops.push(DropRow {
                mob_id,
                ord,
                item_id: None,
                gms_item_id: None,
                name_en: None,
                name_zh: None,
                name_tw: None,
                meso_min: Some(min),
                meso_max: Some(max),
                rate_pct: None,
                quest_id: None,
                source: Some("niadb".into()),
                upvotes: Some(list.reports.iter().map(|r| r.upvotes).sum()),
                downvotes: Some(list.reports.iter().map(|r| r.downvotes).sum()),
            });
            counts.mesos += 1;
        }
    }
}

/// The same mob under two sources' English names: NiaDB marks variants with
/// a trailing "(alt)", "(KPQ)", "(GM Event)"...; one or two letters may differ
/// in a long name (DVG's "Straw Traning Dummy").
pub(super) fn same_mob_name(a: &str, b: &str) -> bool {
    let fold = |s: &str| -> Vec<char> {
        let mut s = s.trim();
        while let Some(rest) = s
            .strip_suffix(')')
            .and_then(|r| r.rfind('(').map(|at| &r[..at]))
        {
            s = rest.trim_end();
        }
        s.chars()
            .filter(char::is_ascii_alphanumeric)
            .map(|c| c.to_ascii_lowercase())
            .collect()
    };
    let (a, b) = (fold(a), fold(b));
    if a == b {
        return true;
    }
    if a.len().min(b.len()) < 8 || a.len().abs_diff(b.len()) > 2 {
        return false;
    }
    // Levenshtein distance, at most 2.
    let mut row: Vec<usize> = (0..=b.len()).collect();
    for (i, ca) in a.iter().enumerate() {
        let mut prev = row[0];
        row[0] = i + 1;
        for (j, cb) in b.iter().enumerate() {
            let next = (row[j + 1] + 1)
                .min(row[j] + 1)
                .min(prev + usize::from(ca != cb));
            prev = row[j + 1];
            row[j + 1] = next;
        }
    }
    row[b.len()] <= 2
}

// ---------- DVG mob-list.json ----------

/// `data/reference/dvg/mob-list.json` (written by `tools/dvg_lists.py`).
#[derive(Deserialize)]
pub struct DvgMobs {
    pub fetched: String,
    items: Vec<DvgMob>,
}

#[derive(Deserialize)]
struct DvgMob {
    mobid: i32,
    mobname: Option<String>,
    name_en: Option<String>,
}

/// What `add_dvg_mob_names` changed.
#[derive(Debug, Default, Clone, PartialEq, Eq, Serialize)]
pub struct DvgMobCounts {
    /// Mobs whose simplified name now comes from DVG.
    pub named: usize,
    /// Of those, mobs that had another simplified name (Mapledex's).
    pub renamed: usize,
}

impl DvgMobs {
    pub fn from_file(path: &Path) -> Result<Self> {
        let text =
            std::fs::read_to_string(path).with_context(|| format!("reading {}", path.display()))?;
        serde_json::from_str(&text).with_context(|| format!("parsing {}", path.display()))
    }
}

impl Dataset {
    /// Simplified mob names from DVG, the names Chinese Classic World players
    /// see (item names come from DVG too). They replace Mapledex's, which are
    /// GMS-TW era and sometimes wrong ("mush妈妈"). A DVG row is used only when
    /// its English name is the same mob's.
    pub fn add_dvg_mob_names(&mut self, dvg: &DvgMobs) -> DvgMobCounts {
        let rows: HashMap<i32, &DvgMob> = dvg.items.iter().map(|m| (m.mobid, m)).collect();
        let mut counts = DvgMobCounts::default();
        for mob in &mut self.mobs {
            let Some(row) = rows.get(&mob.id) else {
                continue;
            };
            let Some(name) = clean(row.mobname.as_deref()) else {
                continue;
            };
            if !same_mob_name(&mob.name_en, row.name_en.as_deref().unwrap_or("")) {
                self.warnings.push(format!(
                    "DVG mob {}: {:?} is not {:?}; name not used",
                    mob.id, row.name_en, mob.name_en
                ));
                continue;
            }
            counts.named += 1;
            if mob.name_zh.as_ref().is_some_and(|old| *old != name) {
                counts.renamed += 1;
            }
            mob.name_zh = Some(name);
        }
        counts
    }
}

// ---------- zh-names.json ----------

/// `data/reference/zh-names.json` (written by `tools/zh_names.py`):
/// simplified names for the maps and NPCs Mapledex gives none.
#[derive(Debug, Deserialize)]
pub struct ZhNames {
    pub version: String,
    maps: BTreeMap<i32, ZhName>,
    npcs: BTreeMap<i32, ZhName>,
}

#[derive(Debug, Deserialize)]
struct ZhName {
    zh: String,
    source: ZhSource,
    /// Mapledex's simplified name for this id is another map's; replace it.
    #[serde(default)]
    replaces_mapledex: bool,
}

#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(rename_all = "kebab-case")]
enum ZhSource {
    /// DVG's GCW catalogue, the names Chinese players of this server see.
    Dvg,
    /// Mapledex's GMS-TW traditional name, converted with OpenCC t2s.
    MapledexTw,
}

/// Names `add_zh_names` set, per source.
#[derive(Debug, Default, Clone, PartialEq, Eq, Serialize)]
pub struct ZhSourceCounts {
    pub dvg: usize,
    pub mapledex_tw: usize,
}

#[derive(Debug, Default, Clone, PartialEq, Eq, Serialize)]
pub struct ZhNameCounts {
    pub maps: ZhSourceCounts,
    pub npcs: ZhSourceCounts,
}

impl ZhNames {
    pub fn from_file(path: &Path) -> Result<Self> {
        let text =
            std::fs::read_to_string(path).with_context(|| format!("reading {}", path.display()))?;
        Self::from_json(&text)
    }

    pub fn from_json(json: &str) -> Result<Self> {
        serde_json::from_str(json).context("parsing zh-names.json")
    }
}

impl Dataset {
    /// Sets `name_zh` on maps and NPCs that have none, and on the ones whose
    /// Mapledex name `tools/zh_names.py` found wrong. Call after `add_niadb`,
    /// which adds most of those rows; other existing names are kept.
    pub fn add_zh_names(&mut self, names: &ZhNames) -> ZhNameCounts {
        let maps = self.maps.iter_mut().map(|m| (m.id, &mut m.name_zh));
        let maps = fill_zh("map", maps, &names.maps, &mut self.warnings);
        let npcs = self.npcs.iter_mut().map(|n| (n.id, &mut n.name_zh));
        let npcs = fill_zh("NPC", npcs, &names.npcs, &mut self.warnings);
        ZhNameCounts { maps, npcs }
    }
}

fn fill_zh<'a>(
    kind: &str,
    rows: impl Iterator<Item = (i32, &'a mut Option<String>)>,
    names: &BTreeMap<i32, ZhName>,
    warnings: &mut Vec<String>,
) -> ZhSourceCounts {
    let mut counts = ZhSourceCounts::default();
    let mut used = HashSet::new();
    for (id, name_zh) in rows {
        let Some(entry) = names.get(&id) else {
            continue;
        };
        used.insert(id);
        if name_zh.is_some() && !entry.replaces_mapledex {
            warnings.push(format!(
                "zh-names: {kind} {id} already has a simplified name; kept"
            ));
            continue;
        }
        let Some(zh) = clean(Some(&entry.zh)) else {
            warnings.push(format!("zh-names: {kind} {id} has an empty name"));
            continue;
        };
        *name_zh = Some(zh);
        match entry.source {
            ZhSource::Dvg => counts.dvg += 1,
            ZhSource::MapledexTw => counts.mapledex_tw += 1,
        }
    }
    for id in names.keys().filter(|id| !used.contains(*id)) {
        warnings.push(format!("zh-names: {kind} {id} is not in the bestiary"));
    }
    counts
}

/// Adds the NPC if needed and gives it `name` when it has none; returns 1
/// when a name was set.
fn name_if_unnamed(npcs: &mut BTreeMap<i32, NpcRow>, id: i32, name: Option<&str>) -> usize {
    let row = npcs.entry(id).or_insert_with(|| unnamed_npc(id));
    let unnamed = row.name_en.is_none() && row.name_zh.is_none() && row.name_tw.is_none();
    match clean(name) {
        Some(name) if unnamed => {
            row.name_en = Some(name);
            1
        }
        _ => 0,
    }
}

/// Trims, decodes the HTML entities Mapledex leaves in names, drops empties.
pub(super) fn clean(text: Option<&str>) -> Option<String> {
    let text = text?.trim();
    if text.is_empty() {
        return None;
    }
    Some(
        text.replace("&lt;", "<")
            .replace("&gt;", ">")
            .replace("&quot;", "\"")
            .replace("&#39;", "'")
            .replace("&amp;", "&"),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    const MONSTERS: &str = r#"{"items": [
        {"id": 1, "n": {"en": "Snail", "zh": "嫩寶", "cw": "蜗牛"}, "level": 1, "hp": 8,
         "maps": [10], "src": 100100, "dropSrc": "book", "boss": 1,
         "drops": [{"p": 60, "id": 4000019}, {"meso": [4, 6], "p": 40},
                   {"p": 0.03, "src": 2040002, "n": {"en": "Scroll"}},
                   {"p": 0, "id": 1}, {"p": 5}]},
        {"id": 2, "n": {"en": "Pig"}, "maps": [10, 99]}
    ]}"#;
    const MAPS: &str = r#"{"items": [
        {"id": 10, "n": {"en": "Field", "zh": "組隊&lt;1>", "cw": "组队&lt;1>"}, "street": {"en": "Road"},
         "returnMap": 20, "mobs": [[1, 4], [3, 1]], "npcs": [7, 7, 8]},
        {"id": 20, "n": {"en": "Town"}, "town": 1, "returnMap": 20, "npcs": [8]},
        {"id": 30, "n": {"en": "Lost"}, "returnMap": 999}
    ]}"#;

    #[test]
    fn builds_rows_and_reports_bad_references() {
        let data = Dataset::from_json(MONSTERS, MAPS).unwrap();
        assert_eq!(data.mobs.len(), 2);
        assert!(data.mobs[0].is_boss);
        assert_eq!(data.mobs[0].name_zh.as_deref(), Some("蜗牛"));
        assert_eq!(data.mobs[0].name_tw.as_deref(), Some("嫩寶"));

        // Rate 0 and the drop with no target are skipped.
        assert_eq!(data.drops.len(), 3);
        assert_eq!(data.drops[0].item_id, Some(4000019));
        assert_eq!(
            (data.drops[1].meso_min, data.drops[1].meso_max),
            (Some(4), Some(6))
        );
        assert_eq!(data.drops[2].item_id, None);
        assert_eq!(data.drops[2].gms_item_id, Some(2040002));
        assert_eq!(data.drops[2].ord, 2);

        assert_eq!(data.maps[0].name_zh.as_deref(), Some("组队<1>"));
        assert_eq!(
            data.maps[1].return_map_id, None,
            "self return is not an edge"
        );
        assert!(data.maps[1].is_town);
        assert_eq!(data.maps[2].return_map_id, None, "unknown target dropped");
        assert_eq!(data.portals.len(), 1);
        assert_eq!(
            (data.portals[0].from_map_id, data.portals[0].to_map_id),
            (10, 20)
        );

        assert_eq!(data.spawns.len(), 1, "unknown mob 3 skipped");
        assert_eq!(data.npcs.len(), 2);
        assert_eq!(data.map_npcs.len(), 3, "duplicate npc on a map collapsed");

        let warnings = data.warnings.join("\n");
        assert!(warnings.contains("unknown mob 3"), "{warnings}");
        assert!(warnings.contains("return map 999"), "{warnings}");
        assert!(warnings.contains("lists map 99"), "{warnings}");
        assert!(
            warnings.contains("lists map 10"),
            "pig is not on map 10: {warnings}"
        );
    }

    #[test]
    fn missing_english_name_fails() {
        let err = Dataset::from_json(
            r#"{"items": [{"id": 5, "n": {"zh": "x"}}]}"#,
            r#"{"items": []}"#,
        )
        .unwrap_err();
        assert!(err.to_string().contains("mob 5"));
    }

    const NPCS: &str = r#"{"items": [
        {"id": 7, "n": {"en": "Heena", "zh": "希娜", "cw": "希娜"}, "maps": [10]},
        {"id": 9, "n": {"en": "Unplaced"}}
    ]}"#;
    const NIA_MAPS: &str = r#"[
        {"id": "000000010", "name": "Field (NiaDB)", "isTown": false, "returnMap": "000000020",
         "npcs": [{"id": "7", "name": "Heena (NiaDB)"}, {"id": "8", "name": "Rina"}], "monsters": []},
        {"id": "000000040", "name": "Hidden House", "streetName": "Hidden Street", "isTown": false,
         "returnMap": "000000020", "mobRate": 1.5, "bgm": "Bgm00/Hidden",
         "npcs": [{"id": "11", "name": "Slade"}],
         "monsters": [{"id": "1", "count": 3}, {"id": "1", "count": 2}, {"id": "77", "count": 1}]},
        {"id": "000000050", "name": "Island", "isTown": true, "returnMap": "999999999", "npcs": []},
        {"id": "000000060", "name": "", "returnMap": "000000020"}
    ]"#;
    const NIA_SHOPS: &str = r#"[
        {"npcId": 8, "npcName": "Rina", "priceSource": " Screenshots 2026-08-12 ", "items": [
            {"iconKey": "2000000", "classicPrice": 50}, {"iconKey": "2000000", "classicPrice": 50},
            {"iconKey": "2000001", "classicPrice": null}]},
        {"npcId": 12, "npcName": "Lucy", "priceSource": "Video", "items": [
            {"iconKey": "2000000", "classicPrice": 45}, {"iconKey": "2000002", "classicPrice": 60},
            {"iconKey": "2000002", "classicPrice": 70}]}
    ]"#;

    #[test]
    fn npc_names_from_npcs_json() {
        let mut data = Dataset::from_json(MONSTERS, MAPS).unwrap();
        data.add_npc_names(NPCS).unwrap();
        let ids: Vec<i32> = data.npcs.iter().map(|n| n.id).collect();
        assert_eq!(ids, vec![7, 8, 9], "unplaced NPC 9 added, sorted");
        assert_eq!(data.npcs[0].name_zh.as_deref(), Some("希娜"));
        assert_eq!(data.npcs[1].name_en, None, "8 is not in npcs.json");
        assert_eq!(data.map_npcs.len(), 3, "placements unchanged");
    }

    #[test]
    fn niadb_fills_gaps_without_touching_mapledex_rows() {
        let mut data = Dataset::from_json(MONSTERS, MAPS).unwrap();
        data.add_npc_names(NPCS).unwrap();
        data.warnings.clear();
        let counts = data.add_niadb(NIA_MAPS, NIA_SHOPS).unwrap();
        assert_eq!(
            counts,
            NiaDbCounts {
                maps: 2,
                spawns: 1,
                return_links: 1,
                npc_placements: 1,
                npc_names: 3,
                shop_rows: 3,
            }
        );
        let map = |id: i32| data.maps.iter().find(|m| m.id == id).unwrap();
        assert_eq!(map(10).name_en, "Field", "Mapledex map unchanged");
        let house = map(40);
        assert_eq!(
            (house.name_en.as_str(), house.street_en.as_deref()),
            ("Hidden House", Some("Hidden Street"))
        );
        assert_eq!(house.return_map_id, Some(20));
        assert_eq!(map(50).return_map_id, None, "999999999 is no map");
        assert!(data.maps.iter().all(|m| m.id != 60), "nameless map skipped");
        let link = data.portals.last().unwrap();
        assert_eq!(
            (link.from_map_id, link.to_map_id, link.source),
            (40, 20, "niadb")
        );
        let spawn = data.spawns.last().unwrap();
        assert_eq!((spawn.map_id, spawn.mob_id, spawn.spawn_count), (40, 1, 5));

        let npc = |id: i32| data.npcs.iter().find(|n| n.id == id).unwrap();
        assert_eq!(
            npc(7).name_en.as_deref(),
            Some("Heena"),
            "Mapledex name kept"
        );
        assert_eq!(npc(8).name_en.as_deref(), Some("Rina"));
        assert_eq!(npc(11).name_en.as_deref(), Some("Slade"));
        assert_eq!(npc(12).name_en.as_deref(), Some("Lucy"), "shop-only NPC");
        assert!(data
            .map_npcs
            .iter()
            .any(|p| (p.map_id, p.npc_id) == (40, 11)));

        let shops: Vec<(i32, i32, i64)> = data
            .npc_shops
            .iter()
            .map(|s| (s.npc_id, s.item_id, s.price))
            .collect();
        assert_eq!(
            shops,
            vec![(8, 2000000, 50), (12, 2000000, 45), (12, 2000002, 60)]
        );
        assert_eq!(
            data.npc_shops[0].source.as_deref(),
            Some("Screenshots 2026-08-12")
        );
        let warnings = data.warnings.join("\n");
        assert!(warnings.contains("unknown mob \"77\""), "{warnings}");
        assert!(warnings.contains("map 60 has no name"), "{warnings}");
        assert!(
            warnings.contains("2000001 has no Classic price"),
            "{warnings}"
        );
        assert!(warnings.contains("at 60 and 70; kept 60"), "{warnings}");
        assert_eq!(data.warnings.len(), 4, "{warnings}");
    }

    #[test]
    fn zh_names_fill_only_missing_names() {
        let mut data = Dataset::from_json(MONSTERS, MAPS).unwrap();
        data.add_npc_names(NPCS).unwrap();
        data.add_niadb(NIA_MAPS, NIA_SHOPS).unwrap();
        data.warnings.clear();
        let names = ZhNames::from_json(
            r#"{"version": "test", "sources": {},
                "maps": {"10": {"zh": "不用", "source": "dvg"}, "20": {"zh": "城镇", "source": "dvg"},
                         "40": {"zh": " 隐藏之屋 ", "source": "mapledex-tw", "tw": "隱藏之屋"},
                         "77": {"zh": "没有", "source": "dvg"}},
                "npcs": {"7": {"zh": "不用", "source": "dvg"}, "11": {"zh": "斯莱德", "source": "dvg"}},
                "dvg_not_used": []}"#,
        )
        .unwrap();
        let counts = data.add_zh_names(&names);
        assert_eq!(
            counts,
            ZhNameCounts {
                maps: ZhSourceCounts {
                    dvg: 1,
                    mapledex_tw: 1
                },
                npcs: ZhSourceCounts {
                    dvg: 1,
                    mapledex_tw: 0
                },
            }
        );
        let map = |id: i32| data.maps.iter().find(|m| m.id == id).unwrap();
        assert_eq!(map(10).name_zh.as_deref(), Some("组队<1>"), "Mapledex kept");
        assert_eq!(map(20).name_zh.as_deref(), Some("城镇"));
        assert_eq!(map(40).name_zh.as_deref(), Some("隐藏之屋"));
        let npc = |id: i32| data.npcs.iter().find(|n| n.id == id).unwrap();
        assert_eq!(npc(7).name_zh.as_deref(), Some("希娜"), "Mapledex kept");
        assert_eq!(npc(11).name_zh.as_deref(), Some("斯莱德"));
        assert_eq!(npc(11).name_en.as_deref(), Some("Slade"));
        assert_eq!(
            data.warnings,
            vec![
                "zh-names: map 10 already has a simplified name; kept",
                "zh-names: map 77 is not in the bestiary",
                "zh-names: NPC 7 already has a simplified name; kept",
            ]
        );

        // A second pass changes nothing.
        assert_eq!(data.add_zh_names(&names), ZhNameCounts::default());
        assert!(ZhNames::from_json(
            r#"{"version": "x", "maps": {"1": {"zh": "a", "source": "guess"}}, "npcs": {}}"#
        )
        .is_err());
    }
}

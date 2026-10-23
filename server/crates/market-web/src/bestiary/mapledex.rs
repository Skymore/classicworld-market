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
use serde::{Deserialize, Serialize};

use super::rows::{DropRow, MapNpcRow, MapRow, MobRow, NpcRow, PortalRow, SpawnRow};

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
    pub drops: Vec<DropRow>,
    pub npcs: Vec<NpcRow>,
    pub map_npcs: Vec<MapNpcRow>,
    pub npc_shops: Vec<NpcShopRow>,
    /// Return-map links; Mapledex has no walking portals.
    pub portals: Vec<PortalRow>,
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
            rate_pct: drop.p,
            quest_id: drop.quest,
            source: mob.drop_src.clone(),
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
            });
            self.add_spawns(map, &mob_ids);
            for npc_id in map.npcs.iter().copied().collect::<BTreeSet<_>>() {
                npc_ids.insert(npc_id);
                self.map_npcs.push(MapNpcRow {
                    map_id: map.id,
                    npc_id,
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
}

#[derive(Deserialize)]
struct NiaNpc {
    id: String,
    name: Option<String>,
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

fn nia_id(raw: &str) -> Option<i32> {
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
                    self.map_npcs.push(MapNpcRow { map_id, npc_id });
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
    /// Sets `name_zh` on maps and NPCs that have none. Call after
    /// `add_niadb`, which adds most of those rows; existing names are kept.
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
        if name_zh.is_some() {
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

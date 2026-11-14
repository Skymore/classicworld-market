//! What each page shows. `queries` fills these from Postgres; `pages`
//! renders them. Names carry both page languages; `pages` picks one.

use market_core::sales::SaleKind;
use sqlx::types::chrono::{DateTime, NaiveDate, Utc};

use super::format::Lang;
use super::route::EdgeKind;

/// A name in both page languages: `zh` is the Classic World simplified name
/// (then traditional, then English), `en` the English one (then `zh`).
#[derive(Debug, Clone, PartialEq, Eq, Default, sqlx::FromRow, serde::Serialize)]
pub struct Names {
    #[sqlx(rename = "name")]
    pub zh: String,
    #[sqlx(rename = "name_en")]
    pub en: String,
}

impl Names {
    pub fn new(zh: impl Into<String>, en: impl Into<String>) -> Self {
        let (zh, en) = (zh.into(), en.into());
        match (zh.is_empty(), en.is_empty()) {
            (true, false) => Self { zh: en.clone(), en },
            (false, true) => Self { en: zh.clone(), zh },
            _ => Self { zh, en },
        }
    }

    pub fn get(&self, lang: Lang) -> &str {
        match lang {
            Lang::Zh => &self.zh,
            Lang::En => &self.en,
            // The client's Korean name, by the Chinese or English one.
            Lang::Ko => lang.t(&self.zh, &self.en),
        }
    }

    /// The other language's name, when it says something the main one does not.
    pub fn secondary(&self, lang: Lang) -> Option<&str> {
        let other = self.get(lang.other());
        (other != self.get(lang)).then_some(other)
    }
}

#[derive(Debug, Clone, PartialEq, sqlx::FromRow, serde::Serialize)]
pub struct MapRef {
    pub id: i32,
    #[sqlx(flatten)]
    pub names: Names,
}

impl MapRef {
    pub fn new(id: i32, zh: impl Into<String>, en: impl Into<String>) -> Self {
        Self {
            id,
            names: Names::new(zh, en),
        }
    }

    /// A map known only from portal data.
    pub fn unlisted(id: i32) -> Self {
        Self::new(id, format!("地图 #{id}"), format!("Map #{id}"))
    }
}

#[derive(Debug, Clone, PartialEq, sqlx::FromRow, serde::Serialize)]
pub struct MobRef {
    pub id: i32,
    #[sqlx(flatten)]
    pub names: Names,
    pub level: Option<i16>,
    /// GMS id for the maplestory.io render, via the link mob if needed.
    pub image_id: Option<i32>,
}

#[derive(Debug, Clone, PartialEq, serde::Serialize)]
pub struct NpcRef {
    pub id: i32,
    pub names: Option<Names>,
}

impl NpcRef {
    /// NPC names may be missing until the data import fills them; show the id then.
    pub fn label(&self, lang: Lang) -> String {
        self.names
            .as_ref()
            .map(|n| n.get(lang).to_string())
            .unwrap_or_else(|| format!("NPC #{}", self.id))
    }
}

// ---------- item ----------

#[derive(Debug, Clone, PartialEq, serde::Serialize)]
pub struct ItemPage {
    pub item: ItemSummary,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub selected_variant: Option<Variant>,
    pub stats: Option<MarketStats>,
    pub droppers: Vec<Dropper>,
    pub npc_offers: Vec<NpcOffer>,
    /// What an NPC pays for one (DVG `npc_price`, else Mapledex `price`).
    pub npc_sell: Option<i64>,
    /// The game tooltip's requirements, jobs and type; equipment only.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub equipment: Option<super::equipment::EquipmentReference>,
    /// The game tooltip of a use, etc, set-up or cash item (`item_tip`).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tip: Option<serde_json::Value>,
    /// Quests that give the item (open, inside their event window).
    pub quest_rewards: Vec<QuestReward>,
    /// Quests that ask for it.
    pub quest_needs: Vec<QuestNeed>,
    pub market: ItemMarket,
}

/// A quest as item and monster pages list it (NiaDB, DVG's simplified name).
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
pub struct QuestRef {
    pub id: i32,
    pub names: Names,
    pub npc: Option<NpcRef>,
    pub level_min: Option<i16>,
    /// `daily` or `weekly`.
    pub repeats: Option<String>,
    /// When an event quest ends.
    pub ends_at: Option<DateTime<Utc>>,
}

#[derive(Debug, Clone, PartialEq, serde::Serialize)]
pub struct QuestReward {
    pub quest: QuestRef,
    pub quantity: i32,
    /// `fixed`, `choice` (pick one) or `random` (one is drawn).
    pub kind: String,
    /// The job or gender the reward is for.
    pub job: Option<String>,
    pub chance_pct: Option<f32>,
}

/// How many of an item to bring, or of a monster to defeat.
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
pub struct QuestNeed {
    pub quest: QuestRef,
    pub quantity: i32,
}

#[derive(Debug, Clone, PartialEq, sqlx::FromRow, serde::Serialize)]
pub struct ItemSummary {
    pub id: i32,
    pub name_zh: Option<String>,
    pub name_en: String,
    pub category: String,
    pub subcategory: Option<String>,
    pub req_level: Option<i16>,
    /// Job bits (1 warrior, 2 magician, 4 bowman, 8 thief, 16 pirate); 0 for every job.
    pub req_job_mask: Option<i16>,
    pub icon_url: Option<String>,
    pub is_cash: bool,
}

impl ItemSummary {
    pub fn names(&self) -> Names {
        Names::new(
            self.name_zh.clone().unwrap_or_default(),
            self.name_en.clone(),
        )
    }
}

#[derive(Debug, Clone, PartialEq, sqlx::FromRow, serde::Serialize)]
pub struct MarketStats {
    pub typical: Option<i64>,
    pub typical_low: Option<i64>,
    pub typical_high: Option<i64>,
    pub sales_24h: i32,
    pub change_24h: Option<f32>,
    pub lowest_ask: Option<i64>,
    pub listings_count: i32,
    pub shops_count: i32,
    pub as_of: DateTime<Utc>,
}

#[derive(Debug, Clone, PartialEq, serde::Serialize)]
pub struct Dropper {
    pub mob: MobRef,
    /// NiaDB players who confirmed the drop (weighted votes, rounded).
    pub votes: Option<i64>,
    pub maps: Vec<MapRef>,
}

#[derive(Debug, Clone, PartialEq, serde::Serialize)]
pub struct NpcOffer {
    pub npc: NpcRef,
    pub price: i64,
}

/// The item's market rows, read from the same tables as `/api/v1/item/<id>`
/// (72-hour listings, latest 50 sales) plus the 7-day ladder inputs.
#[derive(Debug, Clone, PartialEq, Default, serde::Serialize)]
pub struct ItemMarket {
    pub expired_listings: Vec<Listing>,
    /// Latest observation in the market; relative times are measured from it.
    pub as_of: Option<DateTime<Utc>>,
    /// Cheapest unit price first.
    pub listings: Vec<Listing>,
    /// Newest first.
    pub sales: Vec<Sale>,
    /// Seven UTC calendar days ending on the `as_of` day, oldest first.
    pub days: Vec<Day>,
    /// Daily observed asking prices, one latest positive-stock quote per shop/slot/day.
    pub listing_days: Vec<Day>,
    /// Unit price of every sale detected on `days`.
    pub sale_points: Vec<SalePoint>,
    /// Reference stats of the item, to tell bonus stats on a listed instance.
    pub base_stats: Vec<(String, i64)>,
}

#[derive(Debug, Clone, PartialEq, serde::Serialize)]
pub struct ListingIdentity {
    pub shop_key: String,
    pub slot: i32,
    pub visit_id: String,
    pub bundle: i32,
    pub source: String,
}

#[derive(Debug, Clone, PartialEq, serde::Serialize)]
pub struct Listing {
    pub owner_name: Option<String>,
    pub invalidated_at: Option<DateTime<Utc>>,
    #[serde(flatten)]
    pub grouping: Option<ListingIdentity>,
    pub shop: String,
    pub channel: Option<i16>,
    pub room: Option<i16>,
    pub unit_price: f64,
    pub stock: Option<i32>,
    pub seen_at: DateTime<Utc>,
    pub variant: Option<Variant>,
}

#[derive(Debug, Clone, PartialEq, serde::Serialize)]
pub struct Sale {
    pub owner_name: Option<String>,
    pub observed_location: Option<String>,
    pub kind: SaleKind,
    pub unit_price: f64,
    pub quantity: Option<i64>,
    pub shop: String,
    pub channel: Option<i16>,
    pub room: Option<i16>,
    pub detected_at: DateTime<Utc>,
    pub variant: Option<Variant>,
    /// Shop slots read as this one sale (see `merge_shop_sales`); 1 for a single slot.
    pub merged_count: i64,
}

#[derive(Debug, Clone, PartialEq, serde::Serialize)]
pub struct Day {
    pub date: NaiveDate,
    pub median: Option<f64>,
    pub low: Option<f64>,
    pub high: Option<f64>,
    pub count: i32,
}

#[derive(Debug, Clone, Copy, PartialEq, serde::Serialize)]
pub struct SalePoint {
    /// Index into `ItemMarket::days`.
    pub day: usize,
    pub price: f64,
}

/// One equipment instance's decoded stats (`equipment_variants.stats`).
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
pub struct Variant {
    pub id: i64,
    pub stats: Vec<Stat>,
    pub remaining_upgrades: Option<i64>,
    pub enhancements: Option<i64>,
    pub unknown_fields: usize,
}

#[derive(Debug, Clone, PartialEq, serde::Serialize)]
pub struct Stat {
    pub key: String,
    pub label: String,
    pub value: i64,
}

// ---------- mob ----------

#[derive(Debug, Clone, PartialEq, serde::Serialize)]
pub struct MobPage {
    pub mob: MobDetail,
    pub spawns: Vec<Spawn>,
    pub drops: Vec<MobDrop>,
    /// Quests that ask to defeat it.
    pub quests: Vec<QuestNeed>,
}

#[derive(Debug, Clone, PartialEq, sqlx::FromRow, serde::Serialize)]
pub struct MobDetail {
    pub id: i32,
    #[sqlx(flatten)]
    pub names: Names,
    pub level: Option<i16>,
    pub image_id: Option<i32>,
    pub hp: Option<i64>,
    pub mp: Option<i64>,
    pub exp: Option<i64>,
    pub pad: Option<i32>,
    pub pdd: Option<i32>,
    pub mad: Option<i32>,
    pub mdd: Option<i32>,
    pub acc: Option<i32>,
    pub eva: Option<i32>,
    pub speed: Option<i32>,
    pub is_boss: bool,
    pub is_undead: bool,
    pub description: Option<String>,
}

#[derive(Debug, Clone, PartialEq, serde::Serialize)]
pub struct Spawn {
    pub map: MapRef,
    pub street: Option<Names>,
    pub spawn_count: i16,
}

#[derive(Debug, Clone, PartialEq, serde::Serialize)]
pub struct MobDrop {
    pub what: DropTarget,
    /// NiaDB players who confirmed the drop (weighted votes, rounded).
    pub votes: Option<i64>,
    pub quest_id: Option<i32>,
}

#[derive(Debug, Clone, PartialEq, serde::Serialize)]
pub enum DropTarget {
    /// In the catalogue: links to its page.
    Item {
        id: i32,
        names: Names,
        icon_url: Option<String>,
        typical: Option<i64>,
        lowest_ask: Option<i64>,
    },
    /// Not in the catalogue; Mapledex may or may not give a name.
    Unlisted {
        id: Option<i32>,
        names: Option<Names>,
    },
    Meso {
        min: i32,
        max: i32,
    },
}

// ---------- map ----------

#[derive(Debug, Clone, PartialEq, serde::Serialize)]
pub struct MapPage {
    pub map: MapDetail,
    pub return_map: Option<MapRef>,
    pub mobs: Vec<MapMob>,
    pub npcs: Vec<NpcRef>,
    pub exits: Vec<Link>,
    pub entrances: Vec<Link>,
    /// The minimap with spawn points, portals and NPCs, when NiaDB has its box.
    pub view: Option<MapView>,
    /// Quests the NPCs here give.
    pub quests_given: Vec<QuestRef>,
    /// Quests that ask to defeat monsters that spawn here.
    pub quests_hunted: Vec<QuestHunt>,
    /// The maps from Henesys to here (both ends included), when there is a way.
    pub from_henesys: Option<Vec<MapRef>>,
    /// The map's spot on the world map, which the map list opens
    /// (`/search?kind=map&spot=<key>`).
    pub world_spot: Option<String>,
}

/// A quest that asks to defeat a monster found on the map.
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
pub struct QuestHunt {
    pub quest: QuestRef,
    pub mob: MobRef,
    pub quantity: i32,
}

/// The minimap and what is drawn over it, in the minimap's own units: the
/// box is `width` x `height`, and every point is already inside it (world
/// x + minimap centre). The image covers the whole box.
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
pub struct MapView {
    pub width: i32,
    pub height: i32,
    /// Size on screen in CSS pixels at full width; markers are sized for it.
    pub shown_width: i32,
    pub shown_height: i32,
    /// A mob icon's side in box units (24 px when shown at full size).
    pub icon: i32,
    pub image_url: Option<String>,
    /// The rendered scene, drawn instead of the minimap when present.
    pub scene: Option<SceneImage>,
    pub spawns: Vec<SpawnPoint>,
    pub portals: Vec<PortalPoint>,
    pub npcs: Vec<NpcPoint>,
    /// Where a player arrives without a portal.
    pub player_spawn: Option<Point>,
}

/// A scene picture and where it sits in the view's box (it may reach past it).
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
pub struct SceneImage {
    pub url: String,
    pub x: i32,
    pub y: i32,
    pub width: i32,
    pub height: i32,
    /// The picture's width in pixels.
    pub px: i32,
    /// The copy for phones and its width, when it is smaller.
    pub small_url: Option<String>,
    pub small_px: Option<i32>,
}

/// `tools/niadb_map_assets.py scenes` scales each scene picture to fit these
/// boxes, never up: the full-size picture, and the copy for phones under
/// `small/`. Keep them in step with the tool.
const SCENE_FIT: (f64, f64) = (1760.0, 1040.0);
const SCENE_SMALL_FIT: (f64, f64) = (1100.0, 650.0);

impl SceneImage {
    /// `width` x `height` is the scene's rectangle in world pixels, which is
    /// the size of the picture the tool scaled.
    pub fn new(url: String, x: i32, y: i32, width: i32, height: i32) -> Self {
        let fitted = |fit: (f64, f64)| {
            let (w, h) = (f64::from(width.max(1)), f64::from(height.max(1)));
            let scale = (fit.0 / w).min(fit.1 / h).min(1.0);
            (w * scale).round().max(1.0) as i32
        };
        let (px, small_px) = (fitted(SCENE_FIT), fitted(SCENE_SMALL_FIT));
        let small_url = (small_px < px)
            .then(|| {
                url.rsplit_once('/')
                    .map(|(dir, file)| format!("{dir}/small/{file}"))
            })
            .flatten();
        Self {
            small_px: small_url.as_ref().map(|_| small_px),
            small_url,
            url,
            x,
            y,
            width,
            height,
            px,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
pub struct Point {
    pub x: i32,
    pub y: i32,
}

/// `y` is where the monster's feet are.
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
pub struct SpawnPoint {
    pub mob_id: i32,
    pub x: i32,
    pub y: i32,
    /// Seconds before it returns when the map sets a timer (bosses); 0 for
    /// the normal wave respawn.
    pub mob_time: i32,
    /// The picture's size in box units, standing on (`x`, `y`).
    pub w: i32,
    pub h: i32,
    /// Whether the picture is the standing sprite (`/web/images/mobs/stand/`)
    /// rather than the head icon, for monsters without one.
    pub stand: bool,
}

/// Standing sprite sizes in game pixels, from `tools/niadb_map_assets.py stands`.
static STAND_SIZES: std::sync::LazyLock<std::collections::HashMap<i32, (i32, i32)>> =
    std::sync::LazyLock::new(|| {
        #[derive(serde::Deserialize)]
        struct Table {
            sizes: std::collections::HashMap<String, (i32, i32)>,
        }
        let table: Table = serde_json::from_str(include_str!("mob-stands.json"))
            .expect("mob-stands.json is valid");
        table
            .sizes
            .into_iter()
            .filter_map(|(id, size)| Some((id.parse().ok()?, size)))
            .collect()
    });

impl SpawnPoint {
    /// Box units are world pixels, so monsters stand at game size, the same
    /// scale as the scene; `icon` is a head icon's side in box units, for
    /// monsters without a standing sprite.
    pub fn new(mob_id: i32, x: i32, y: i32, mob_time: i32, icon: i32) -> Self {
        let (w, h, stand) = match STAND_SIZES.get(&mob_id) {
            Some(&(w, h)) => (w, h, true),
            None => (icon, icon, false),
        };
        Self {
            mob_id,
            x,
            y,
            mob_time,
            w,
            h,
            stand,
        }
    }
}

#[derive(Debug, Clone, PartialEq, serde::Serialize)]
pub struct PortalPoint {
    pub x: i32,
    pub y: i32,
    pub to: MapRef,
    pub name: Option<String>,
    /// 1 hidden (no picture; stand on it and press up), 2 visible, 3 entered
    /// by walking into it.
    pub portal_type: Option<i16>,
}

#[derive(Debug, Clone, PartialEq, serde::Serialize)]
pub struct NpcPoint {
    pub npc: NpcRef,
    pub x: i32,
    pub y: i32,
}

// ---------- world map ----------

#[derive(Debug, Clone, PartialEq, serde::Serialize)]
pub struct WorldPage {
    pub regions: Vec<WorldRegion>,
    /// The map asked for (`?map=`) and the spots that cover it.
    pub here: Option<MapRef>,
    pub here_spots: Vec<String>,
}

/// A region picture of the client's world map, in its own pixels.
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
pub struct WorldRegion {
    pub id: String,
    pub names: Names,
    pub image_url: String,
    pub width: i32,
    pub height: i32,
    pub spots: Vec<WorldSpot>,
}

#[derive(Debug, Clone, PartialEq, serde::Serialize)]
pub struct WorldSpot {
    pub key: String,
    pub x: i32,
    pub y: i32,
    /// 0 town, 1 spot, 2 cluster, 3 field, 4 facility (the marker sprite).
    pub kind: i16,
    /// The map the spot is named after and links to.
    pub map: MapRef,
    /// Open maps the spot covers.
    pub map_count: i64,
    /// Levels of the monsters on those maps.
    pub level_min: Option<i16>,
    pub level_max: Option<i16>,
}

/// A route drawn over the world map: per region, the spots it passes in order.
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
pub struct RouteOverview {
    pub regions: Vec<OverviewRegion>,
}

#[derive(Debug, Clone, PartialEq, serde::Serialize)]
pub struct OverviewRegion {
    pub id: String,
    pub names: Names,
    pub image_url: String,
    pub width: i32,
    pub height: i32,
    pub stops: Vec<OverviewStop>,
}

#[derive(Debug, Clone, PartialEq, serde::Serialize)]
pub struct OverviewStop {
    pub x: i32,
    pub y: i32,
    pub map: MapRef,
}

/// One map a monster spawns on, for the monster finder.
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
pub struct MobPlace {
    pub map: MapRef,
    pub spawn_count: i16,
    /// Steps from the start; `None` when no known route reaches it.
    pub steps: Option<usize>,
}

/// The world map region's name in both languages.
pub fn region_names(id: &str) -> Names {
    match id {
        "MapleIsland" => Names::new("彩虹岛", "Maple Island"),
        "VictoriaIsland" => Names::new("金银岛", "Victoria Island"),
        "OssyriaElNathMts" => Names::new("冰峰雪域山脉", "El Nath Mountains"),
        "OssyriaDeadMine" => Names::new("废矿区", "Dead Mine"),
        other => Names::new(other, other),
    }
}

// ---------- NPC ----------

#[derive(Debug, Clone, PartialEq, serde::Serialize)]
pub struct NpcPage {
    pub npc: NpcRef,
    /// The maps it stands on; `view` marks it among the map's other NPCs.
    pub places: Vec<NpcPlace>,
    pub quests: Vec<QuestRef>,
    pub shop: Vec<NpcShopItem>,
}

#[derive(Debug, Clone, PartialEq, serde::Serialize)]
pub struct NpcPlace {
    pub map: MapRef,
    pub view: Option<MapView>,
}

/// An item the NPC sells; every item in `npc_shops` is in the catalogue.
#[derive(Debug, Clone, PartialEq, sqlx::FromRow, serde::Serialize)]
pub struct NpcShopItem {
    pub id: i32,
    #[sqlx(flatten)]
    pub names: Names,
    pub icon_url: Option<String>,
    pub price: i64,
}

#[derive(Debug, Clone, PartialEq, serde::Serialize)]
pub struct MapDetail {
    pub id: i32,
    pub names: Names,
    pub street: Option<Names>,
    pub description: Option<String>,
    pub is_town: bool,
    pub mob_rate: Option<f32>,
    pub minimap_url: Option<String>,
}

#[derive(Debug, Clone, PartialEq, serde::Serialize)]
pub struct MapMob {
    pub mob: MobRef,
    pub spawn_count: i16,
}

/// One edge seen from a map page: `other` is where it leads (exits) or where
/// it comes from (entrances).
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
pub struct Link {
    pub other: MapRef,
    pub kind: EdgeKind,
    pub portal_name: Option<String>,
}

// ---------- route ----------

#[derive(Debug, Clone, PartialEq, serde::Serialize)]
pub struct RoutePage {
    pub from_input: String,
    pub to_input: String,
    /// The monster finder: a monster name or id instead of a destination.
    pub mob_input: String,
    /// Routes may take the taxi (`taxi=1`).
    pub taxi: bool,
    /// Show the monster finder's form (`mode=mob` or a monster given).
    pub mob_mode: bool,
    pub known_edges: usize,
    pub outcome: RouteOutcome,
}

#[derive(Debug, Clone, PartialEq, serde::Serialize)]
pub enum RouteEnd {
    From,
    To,
}

#[derive(Debug, Clone, PartialEq, serde::Serialize)]
pub enum RouteOutcome {
    /// No query yet.
    Form,
    /// An end did not name exactly one map; `candidates` may be empty.
    Unresolved {
        end: RouteEnd,
        query: String,
        candidates: Vec<MapChoice>,
    },
    Same(MapRef),
    NoPath {
        from: MapRef,
        to: MapRef,
    },
    Found {
        from: MapRef,
        to: MapRef,
        steps: Vec<Step>,
        overview: Option<RouteOverview>,
    },
    /// The monster finder could not name exactly one monster.
    MobUnresolved {
        query: String,
        candidates: Vec<MobRef>,
    },
    /// No open map with this monster can be reached from the start.
    MobNoPath {
        from: MapRef,
        mob: MobRef,
    },
    /// The way to the nearest map where the monster spawns (`steps` is empty
    /// when the start is one), and every map it spawns on by distance.
    MobFound {
        from: MapRef,
        mob: MobRef,
        to: MapRef,
        steps: Vec<Step>,
        overview: Option<RouteOverview>,
        places: Vec<MobPlace>,
    },
}

#[derive(Debug, Clone, PartialEq, serde::Serialize)]
pub struct Step {
    pub from: MapRef,
    pub to: MapRef,
    pub kind: EdgeKind,
    pub portal_name: Option<String>,
    /// `from`'s minimap with its portals (no monsters or NPCs), when known.
    pub view: Option<MapView>,
    /// The portal to take on `view`, or the NPC to talk to for a ship or
    /// taxi, when its position is known.
    pub exit: Option<Point>,
    /// The NPC for a ship or taxi step.
    pub npc: Option<NpcRef>,
    /// The exit portal is hidden (no picture in game).
    pub exit_hidden: bool,
    /// Where the player is when the step starts: the portal they came in by,
    /// or the map's spawn point.
    pub arrival: Option<Point>,
}

// ---------- search ----------

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
pub enum SearchKind {
    Item,
    Mob,
    Map,
}

impl SearchKind {
    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "item" => Some(Self::Item),
            "mob" => Some(Self::Mob),
            "map" => Some(Self::Map),
            _ => None,
        }
    }

    pub fn key(self) -> &'static str {
        match self {
            Self::Item => "item",
            Self::Mob => "mob",
            Self::Map => "map",
        }
    }
}

/// Item categories: URL key and both page languages.
pub const ITEM_CATEGORIES: &[(&str, &str, &str)] = &[
    ("", "全部", "All"),
    ("equip", "装备", "Equip"),
    ("use", "消耗", "Use"),
    ("setup", "装饰", "Setup"),
    ("etc", "其他", "Etc"),
    ("cash", "商城", "Cash"),
];

/// Jobs: URL key, `req_job_mask` bit and both page languages. Classic World
/// has no pirates.
pub const JOBS: &[(&str, i16, &str, &str)] = &[
    ("warrior", 1, "战士", "Warrior"),
    ("magician", 2, "法师", "Magician"),
    ("bowman", 4, "弓箭手", "Bowman"),
    ("thief", 8, "飞侠", "Thief"),
];

/// Equipment types: URL key and `items.subcategory`, in the order of
/// `equipmentTypes` in `web/js/lib/price-filters.js`.
pub const EQUIPMENT_TYPES: &[(&str, &str, &str)] = &[
    ("weapon", "武器", "Weapon"),
    ("hat", "帽子", "Hat"),
    ("overall", "套服", "Overall"),
    ("top", "上衣", "Top"),
    ("bottom", "裤裙", "Bottom"),
    ("gloves", "手套", "Gloves"),
    ("shoes", "鞋子", "Shoes"),
    ("shield", "盾牌", "Shield"),
    ("cape", "披风", "Cape"),
    ("face", "脸饰", "Face accessory"),
    ("eye", "眼饰", "Eye accessory"),
    ("earrings", "耳环", "Earrings"),
    ("ring", "戒指", "Ring"),
    ("pendant", "项链", "Pendant"),
    ("belt", "腰带", "Belt"),
    ("medal", "勋章", "Medal"),
    ("pet", "宠物装备", "Pet equipment"),
];

/// Weapon types by item id prefix (`id / 10000`).
pub const WEAPON_TYPES: &[(i32, &str, &str)] = &[
    (130, "单手剑", "One-handed sword"),
    (131, "单手斧", "One-handed axe"),
    (132, "单手钝器", "One-handed mace"),
    (133, "短刀", "Dagger"),
    (137, "短杖", "Wand"),
    (138, "长杖", "Staff"),
    (140, "双手剑", "Two-handed sword"),
    (141, "双手斧", "Two-handed axe"),
    (142, "双手钝器", "Two-handed mace"),
    (143, "枪", "Spear"),
    (144, "矛", "Polearm"),
    (145, "弓", "Bow"),
    (146, "弩", "Crossbow"),
    (147, "拳套", "Claw"),
];

/// Use-item types; `queries` matches them on the id prefix.
pub const USE_TYPES: &[(&str, &str, &str)] = &[
    ("potion", "药水", "Potions"),
    ("return", "回城卷轴", "Return scrolls"),
    ("scroll", "卷轴", "Scrolls"),
    ("arrow", "箭矢", "Arrows"),
    ("star", "飞镖", "Throwing stars"),
    ("other", "其他", "Other"),
];

/// The use-item type of an item id prefix (`id / 10000`, 200-299).
pub fn use_type(prefix: i32) -> &'static str {
    match prefix {
        200..=202 => "potion",
        203 => "return",
        204 => "scroll",
        206 => "arrow",
        207 => "star",
        _ => "other",
    }
}

/// Item filters as the URL spells them (`cat`, `job`, `lmin`, `lmax`,
/// `type`, `weapon`, `use`, `shared`, `sort`).
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
pub struct ItemFilters {
    pub cat: String,
    /// A `JOBS` key, or empty for every job.
    pub job: String,
    pub lmin: Option<i16>,
    pub lmax: Option<i16>,
    /// An `EQUIPMENT_TYPES` key.
    #[serde(rename = "type")]
    pub slot: String,
    /// A `WEAPON_TYPES` prefix; only with the weapon type.
    pub weapon: Option<i32>,
    /// A `USE_TYPES` key; only with the use category.
    #[serde(rename = "use")]
    pub use_type: String,
    /// Keep gear every job can wear (`shared=0` drops it).
    pub shared: bool,
    /// Empty (popular first), `level`, `level_desc` or `name`.
    pub sort: String,
}

impl Default for ItemFilters {
    fn default() -> Self {
        Self {
            cat: String::new(),
            job: String::new(),
            lmin: None,
            lmax: None,
            slot: String::new(),
            weapon: None,
            use_type: String::new(),
            shared: true,
            sort: String::new(),
        }
    }
}

/// Clamped to 0-300 and in order; a lone minimum of 0 filters nothing.
fn level_range(lo: Option<i16>, hi: Option<i16>) -> (Option<i16>, Option<i16>) {
    let (mut lo, mut hi) = (lo.map(|n| n.clamp(0, 300)), hi.map(|n| n.clamp(0, 300)));
    if let (Some(a), Some(b)) = (lo, hi) {
        if a > b {
            (lo, hi) = (Some(b), Some(a));
        }
    }
    if lo == Some(0) && hi.is_none() {
        lo = None;
    }
    (lo, hi)
}

fn push_level(out: &mut String, lo: Option<i16>, hi: Option<i16>) {
    if let Some(n) = lo {
        out.push_str(&format!("&lmin={n}"));
    }
    if let Some(n) = hi {
        out.push_str(&format!("&lmax={n}"));
    }
}

impl ItemFilters {
    /// The job from `job=warrior` or an old `job=1` link; pirates (16) are
    /// not in Classic World.
    pub fn parse_job(raw: &str) -> String {
        JOBS.iter()
            .find(|(key, bit, _, _)| *key == raw || bit.to_string() == raw)
            .map(|(key, ..)| key.to_string())
            .unwrap_or_default()
    }

    pub fn job_bit(&self) -> i16 {
        JOBS.iter()
            .find(|(key, ..)| *key == self.job)
            .map_or(0, |(_, bit, ..)| *bit)
    }

    /// `items.subcategory` of the equipment type.
    pub fn subcategory(&self) -> &'static str {
        EQUIPMENT_TYPES
            .iter()
            .find(|(key, ..)| *key == self.slot)
            .map_or("", |(_, zh, _)| zh)
    }

    /// Filters that only equipment has.
    pub fn equipment_only(&self) -> bool {
        !self.job.is_empty()
            || !self.shared
            || !self.slot.is_empty()
            || self.lmin.is_some()
            || self.lmax.is_some()
    }

    /// Drops unknown values; equipment-only filters select 装备, and the
    /// use-item type needs 消耗.
    pub fn normalize(&mut self) {
        if !ITEM_CATEGORIES.iter().any(|(key, ..)| *key == self.cat) {
            self.cat.clear();
        }
        if !JOBS.iter().any(|(key, ..)| *key == self.job) {
            self.job.clear();
        }
        (self.lmin, self.lmax) = level_range(self.lmin, self.lmax);
        if !EQUIPMENT_TYPES.iter().any(|(key, ..)| *key == self.slot) {
            self.slot.clear();
        }
        self.weapon = self
            .weapon
            .filter(|w| WEAPON_TYPES.iter().any(|(id, ..)| id == w));
        if self.weapon.is_some() && self.slot.is_empty() {
            self.slot = "weapon".into();
        }
        if self.slot != "weapon" {
            self.weapon = None;
        }
        if !["", "level", "level_desc", "name"].contains(&self.sort.as_str()) {
            self.sort.clear();
        }
        if self.equipment_only() {
            self.cat = "equip".into();
        }
        if self.cat != "use" || !USE_TYPES.iter().any(|(key, ..)| *key == self.use_type) {
            self.use_type.clear();
        }
    }

    /// `&key=value` pairs of the set filters, in a fixed order.
    pub fn query(&self) -> String {
        let mut out = String::new();
        if !self.cat.is_empty() {
            out.push_str(&format!("&cat={}", self.cat));
        }
        if !self.job.is_empty() {
            out.push_str(&format!("&job={}", self.job));
        }
        if !self.shared {
            out.push_str("&shared=0");
        }
        if !self.slot.is_empty() {
            out.push_str(&format!("&type={}", self.slot));
        }
        if let Some(w) = self.weapon {
            out.push_str(&format!("&weapon={w}"));
        }
        if !self.use_type.is_empty() {
            out.push_str(&format!("&use={}", self.use_type));
        }
        push_level(&mut out, self.lmin, self.lmax);
        if !self.sort.is_empty() {
            out.push_str(&format!("&sort={}", self.sort));
        }
        out
    }
}

/// Monster filters (`lmin`, `lmax`, `boss`, `sort`); region and area sit on
/// the page because maps share them.
#[derive(Debug, Clone, PartialEq, Default, serde::Serialize)]
pub struct MobFilters {
    pub lmin: Option<i16>,
    pub lmax: Option<i16>,
    pub boss: bool,
    /// Empty (level, low to high), `level_desc` or `name`.
    pub sort: String,
}

impl MobFilters {
    pub fn normalize(&mut self) {
        (self.lmin, self.lmax) = level_range(self.lmin, self.lmax);
        if !["", "level_desc", "name"].contains(&self.sort.as_str()) {
            self.sort.clear();
        }
    }

    pub fn query(&self) -> String {
        let mut out = String::new();
        push_level(&mut out, self.lmin, self.lmax);
        if self.boss {
            out.push_str("&boss=1");
        }
        if !self.sort.is_empty() {
            out.push_str(&format!("&sort={}", self.sort));
        }
        out
    }
}

/// What `/search` was asked, after normalization.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct SearchRequest {
    pub query: String,
    /// `None`: a typed query over all three catalogues, without filters.
    pub kind: Option<SearchKind>,
    pub offset: i64,
    pub items: ItemFilters,
    pub mobs: MobFilters,
    /// Maps: towns only.
    pub town: bool,
    pub region: String,
    pub area: String,
    /// Maps: only those on this world map spot (`WorldSpot::key`).
    pub spot: String,
    /// Maps: the world map island shown (`regions::ISLANDS`).
    pub island: String,
}

#[derive(Debug, Clone, PartialEq, Default, serde::Serialize)]
pub struct SearchPage {
    pub region: String,
    pub area: String,
    pub areas: Vec<AreaChoice>,
    pub filters: ItemFilters,
    pub mob_filters: MobFilters,
    pub town: bool,
    pub query: String,
    pub offset: i64,
    /// Rows per page and group: 60 for one kind, 20 for each of three.
    pub page_size: i64,
    /// `?kind=`: only that group, with a longer list and filters.
    pub kind: Option<SearchKind>,
    /// Item counts for the filter bar; only when browsing items.
    pub facets: Option<ItemFacets>,
    pub items: Hits<ItemHit>,
    pub mobs: Hits<MobRef>,
    pub maps: Hits<MapHit>,
    /// Browsing maps: the world map spot the list is narrowed to.
    pub spot: String,
    /// Browsing maps: the world map island shown (`regions::ISLANDS`).
    pub island: String,
    /// Browsing maps: maps per region chip (`regions::MAP_REGIONS`, `""` is
    /// all) under the query and the towns filter.
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub map_regions: Vec<Facet>,
    /// Browsing maps: the world map beside the list.
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub world: Vec<WorldRegion>,
}

/// Counts behind the item filter bar and dialog.
#[derive(Debug, Clone, PartialEq, Default, serde::Serialize)]
pub struct ItemFacets {
    /// Items per category (`ITEM_CATEGORIES` keys, `""` is all) matching the
    /// query; the other item filters are not applied.
    pub categories: Vec<Facet>,
    /// Equipment per type under the job, all-class and level filters.
    pub types: Vec<Facet>,
    /// Weapons per weapon type under the same filters.
    pub weapons: Vec<Facet>,
    /// Use items per use type matching the query.
    pub uses: Vec<Facet>,
}

/// One filter value that has items, or the selected one.
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
pub struct Facet {
    pub key: String,
    pub names: Names,
    pub count: i64,
}

#[derive(Debug, Clone, PartialEq, sqlx::FromRow, serde::Serialize)]
pub struct AreaChoice {
    pub region: String,
    pub key: String,
    #[sqlx(flatten)]
    pub names: Names,
}

#[derive(Debug, Clone, PartialEq, serde::Serialize)]
pub struct Hits<T> {
    pub rows: Vec<T>,
    /// More matched than `rows` holds.
    pub more: bool,
    /// Everything the query and filters match, on all pages.
    pub total: i64,
}

impl<T> Default for Hits<T> {
    fn default() -> Self {
        Self {
            rows: Vec::new(),
            more: false,
            total: 0,
        }
    }
}

#[derive(Debug, Clone, PartialEq, sqlx::FromRow, serde::Serialize)]
pub struct ItemHit {
    pub level: Option<i16>,
    pub id: i32,
    #[sqlx(flatten)]
    pub names: Names,
    pub icon_url: Option<String>,
    pub subcategory: Option<String>,
}

#[derive(Debug, Clone, PartialEq, serde::Serialize)]
pub struct MapHit {
    pub id: i32,
    pub names: Names,
    pub street: Option<Names>,
    /// Set when another open map has the same name (`queries::map_hints`).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub hint: Option<MapHint>,
    pub town: bool,
    /// The map list's card picture (`tools/niadb_map_assets.py thumbs`).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub thumb: Option<String>,
    /// Levels of the monsters here.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub level_min: Option<i16>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub level_max: Option<i16>,
    /// A card for several rooms of one place (`map_list::ROOMS`): "20 个房间".
    #[serde(skip_serializing_if = "Option::is_none")]
    pub copies: Option<Names>,
    /// The world map spot the map is on, the first when on two.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub spot: Option<String>,
}

/// What tells a map apart from open maps of the same name, per language
/// ("通往 蘑菇镇 - 西入口"); `None` in a language where its name is unique.
#[derive(Debug, Clone, Default, PartialEq, serde::Serialize)]
pub struct MapHint {
    pub zh: Option<String>,
    pub en: Option<String>,
}

impl MapHint {
    pub fn get(&self, lang: Lang) -> Option<&str> {
        match lang {
            Lang::Zh => self.zh.as_deref(),
            Lang::En | Lang::Ko => self.en.as_deref(),
        }
    }
}

/// A map offered as one of several matches, with its hint when its name is
/// shared.
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
pub struct MapChoice {
    #[serde(flatten)]
    pub map: MapRef,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub hint: Option<MapHint>,
}

impl From<MapRef> for MapChoice {
    fn from(map: MapRef) -> Self {
        Self { map, hint: None }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn names_fall_back_across_languages() {
        let both = Names::new("射手村", "Henesys");
        assert_eq!(both.get(Lang::En), "Henesys");
        assert_eq!(both.secondary(Lang::Zh), Some("Henesys"));
        let en_only = Names::new("", "Snail");
        assert_eq!(en_only.get(Lang::Zh), "Snail");
        assert_eq!(en_only.secondary(Lang::Zh), None);
        assert_eq!(MapRef::unlisted(7).names.get(Lang::En), "Map #7");
        let npc = NpcRef { id: 9, names: None };
        assert_eq!(npc.label(Lang::Zh), "NPC #9");
    }
}

#[cfg(test)]
mod item_filter_tests {
    use super::*;
    #[test]
    fn normalize_equipment_filters_and_reversed_levels() {
        let mut f = ItemFilters {
            cat: "etc".into(),
            job: ItemFilters::parse_job("4"),
            lmin: Some(30),
            lmax: Some(20),
            ..Default::default()
        };
        f.normalize();
        assert_eq!(f.cat, "equip", "equipment-only filters select 装备");
        assert_eq!((f.lmin, f.lmax), (Some(20), Some(30)));
        assert_eq!(f.job_bit(), 4);
        assert_eq!(f.query(), "&cat=equip&job=bowman&lmin=20&lmax=30");
        let mut f = ItemFilters {
            cat: "invalid".into(),
            job: ItemFilters::parse_job("99"),
            slot: "<b>".into(),
            sort: "price".into(),
            ..Default::default()
        };
        f.normalize();
        assert_eq!(f, ItemFilters::default());
    }

    #[test]
    fn jobs_accept_old_bits_but_not_pirates() {
        assert_eq!(ItemFilters::parse_job("1"), "warrior");
        assert_eq!(ItemFilters::parse_job("magician"), "magician");
        assert_eq!(ItemFilters::parse_job("16"), "");
        assert_eq!(ItemFilters::parse_job("pirate"), "");
    }

    #[test]
    fn weapon_types_belong_to_weapons_and_use_types_to_use_items() {
        let mut f = ItemFilters {
            weapon: Some(140),
            use_type: "potion".into(),
            ..Default::default()
        };
        f.normalize();
        assert_eq!((f.cat.as_str(), f.slot.as_str()), ("equip", "weapon"));
        assert_eq!(f.subcategory(), "武器");
        assert_eq!(f.use_type, "", "a use type does not survive 装备");
        let mut f = ItemFilters {
            slot: "hat".into(),
            weapon: Some(140),
            ..Default::default()
        };
        f.normalize();
        assert_eq!(f.weapon, None);
        let mut f = ItemFilters {
            cat: "use".into(),
            use_type: "scroll".into(),
            weapon: Some(999),
            ..Default::default()
        };
        f.normalize();
        assert_eq!((f.cat.as_str(), f.use_type.as_str()), ("use", "scroll"));
        assert_eq!(f.query(), "&cat=use&use=scroll");
        assert_eq!(use_type(201), "potion");
        assert_eq!(use_type(243), "other");
    }

    #[test]
    fn all_class_toggle_and_lone_zero_minimum() {
        let mut f = ItemFilters {
            shared: false,
            lmin: Some(0),
            sort: "level_desc".into(),
            ..Default::default()
        };
        f.normalize();
        assert_eq!(f.lmin, None, "a lone minimum of 0 filters nothing");
        assert_eq!(f.query(), "&cat=equip&shared=0&sort=level_desc");
        let mut m = MobFilters {
            lmin: Some(70),
            lmax: Some(61),
            boss: true,
            sort: "level".into(),
        };
        m.normalize();
        assert_eq!(m.query(), "&lmin=61&lmax=70&boss=1");
    }
}

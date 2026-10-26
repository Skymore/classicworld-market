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
    pub market: ItemMarket,
}

#[derive(Debug, Clone, PartialEq, sqlx::FromRow, serde::Serialize)]
pub struct ItemSummary {
    pub id: i32,
    pub name_zh: Option<String>,
    pub name_en: String,
    pub category: String,
    pub subcategory: Option<String>,
    pub req_level: Option<i16>,
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
    pub rate_pct: f64,
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
    pub observed_location: Option<String>,
    pub kind: SaleKind,
    pub unit_price: f64,
    pub quantity: Option<i64>,
    pub shop: String,
    pub channel: Option<i16>,
    pub room: Option<i16>,
    pub detected_at: DateTime<Utc>,
    pub variant: Option<Variant>,
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
    pub rate_pct: f64,
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
        candidates: Vec<MapRef>,
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
    },
}

#[derive(Debug, Clone, PartialEq, serde::Serialize)]
pub struct Step {
    pub from: MapRef,
    pub to: MapRef,
    pub kind: EdgeKind,
    pub portal_name: Option<String>,
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

#[derive(Debug, Clone, PartialEq, Default, serde::Deserialize, serde::Serialize)]
#[serde(default)]
pub struct ItemFilters {
    pub cat: String,
    pub job: i16,
    pub min_level: Option<i16>,
    pub max_level: Option<i16>,
}
impl ItemFilters {
    pub fn normalize(&mut self) {
        if ![0, 1, 2, 4, 8, 16].contains(&self.job) {
            self.job = 0;
        }
        if !["", "equip", "use", "setup", "etc", "cash"].contains(&self.cat.as_str()) {
            self.cat.clear();
        }
        self.min_level = self.min_level.map(|n| n.clamp(0, 300));
        self.max_level = self.max_level.map(|n| n.clamp(0, 300));
        if let (Some(lo), Some(hi)) = (self.min_level, self.max_level) {
            if lo > hi {
                self.min_level = Some(hi);
                self.max_level = Some(lo);
            }
        }
        if self.job != 0 || self.min_level.is_some() || self.max_level.is_some() {
            self.cat = "equip".into();
        }
    }
    pub fn query(&self) -> String {
        let mut out = String::new();
        if !self.cat.is_empty() {
            out.push_str(&format!("&cat={}", self.cat));
        }
        if self.job != 0 {
            out.push_str(&format!("&job={}", self.job));
        }
        if let Some(n) = self.min_level {
            out.push_str(&format!("&min_level={n}"));
        }
        if let Some(n) = self.max_level {
            out.push_str(&format!("&max_level={n}"));
        }
        out
    }
}

#[derive(Debug, Clone, PartialEq, Default, serde::Serialize)]
pub struct SearchPage {
    pub region: String,
    pub area: String,
    pub areas: Vec<AreaChoice>,
    pub filters: ItemFilters,
    pub query: String,
    pub offset: i64,
    /// `?kind=`: only that group, with a longer list.
    pub kind: Option<SearchKind>,
    pub items: Hits<ItemHit>,
    pub mobs: Hits<MobRef>,
    pub maps: Hits<MapHit>,
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
}

impl<T> Default for Hits<T> {
    fn default() -> Self {
        Self {
            rows: Vec::new(),
            more: false,
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
            job: 4,
            min_level: Some(30),
            max_level: Some(20),
        };
        f.normalize();
        assert_eq!(f.cat, "equip");
        assert_eq!((f.min_level, f.max_level), (Some(20), Some(30)));
        assert_eq!(f.query(), "&cat=equip&job=4&min_level=20&max_level=30");
        let mut f = ItemFilters {
            cat: "invalid".into(),
            job: 99,
            ..Default::default()
        };
        f.normalize();
        assert_eq!(f, ItemFilters::default());
    }
}

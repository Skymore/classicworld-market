//! Rows as the importers write them. Field names are column names: the
//! importer sends each table as one JSON array to `jsonb_populate_recordset`.

use serde::Serialize;

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct ItemRow {
    pub id: i32,
    pub name_en: String,
    pub name_zh: Option<String>,
    pub category: String,
    pub subcategory: Option<String>,
    pub req_level: Option<i16>,
    pub req_job_mask: Option<i16>,
    pub icon_url: Option<String>,
    pub is_cash: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct MobRow {
    pub id: i32,
    pub gms_id: Option<i32>,
    pub link_id: Option<i32>,
    pub name_en: String,
    pub name_zh: Option<String>,
    pub name_tw: Option<String>,
    pub level: Option<i16>,
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
    pub drop_source: Option<String>,
    /// In the client but not open yet; never shown.
    pub unreleased: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct MapRow {
    pub id: i32,
    pub gms_id: Option<i32>,
    pub name_en: String,
    pub name_zh: Option<String>,
    pub name_tw: Option<String>,
    pub street_en: Option<String>,
    pub street_zh: Option<String>,
    pub street_tw: Option<String>,
    pub description: Option<String>,
    pub is_town: bool,
    pub return_map_id: Option<i32>,
    pub mob_rate: Option<f64>,
    pub bgm: Option<String>,
    pub minimap_url: Option<String>,
    /// In the client but not open yet; never shown.
    pub unreleased: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct SpawnRow {
    pub map_id: i32,
    pub mob_id: i32,
    pub spawn_count: i16,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct DropRow {
    pub mob_id: i32,
    pub ord: i16,
    pub item_id: Option<i32>,
    pub gms_item_id: Option<i32>,
    pub name_en: Option<String>,
    pub name_zh: Option<String>,
    pub name_tw: Option<String>,
    pub meso_min: Option<i32>,
    pub meso_max: Option<i32>,
    /// Mapledex's rate; NiaDB drops have none.
    pub rate_pct: Option<f64>,
    pub quest_id: Option<i32>,
    pub source: Option<String>,
    /// NiaDB community votes (weighted, so fractional).
    pub upvotes: Option<f64>,
    pub downvotes: Option<f64>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct NpcRow {
    pub id: i32,
    pub name_en: Option<String>,
    pub name_zh: Option<String>,
    pub name_tw: Option<String>,
    /// Every map the NPC stands on is unreleased.
    pub unreleased: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct MapNpcRow {
    pub map_id: i32,
    pub npc_id: i32,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct PortalRow {
    pub from_map_id: i32,
    pub to_map_id: i32,
    pub kind: &'static str,
    pub portal_name: Option<String>,
    pub target_portal: Option<String>,
    pub x: Option<i32>,
    pub y: Option<i32>,
    pub source: &'static str,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct QuestRow {
    pub id: i32,
    pub name_en: Option<String>,
    pub name_zh: Option<String>,
    pub name_tw: Option<String>,
    pub npc_id: Option<i32>,
    pub level_min: Option<i16>,
    /// `daily` or `weekly`.
    pub repeats: Option<&'static str>,
    /// RFC 3339; the event's window.
    pub starts_at: Option<String>,
    pub ends_at: Option<String>,
    pub unreleased: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct QuestRewardRow {
    pub quest_id: i32,
    pub item_id: i32,
    pub quantity: i32,
    /// `fixed`, `choice` or `random`.
    pub kind: &'static str,
    /// The job (or gender) the reward is for, when not everyone's.
    pub job: Option<String>,
    pub chance_pct: Option<f64>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct QuestNeedRow {
    pub quest_id: i32,
    pub ord: i16,
    pub item_id: Option<i32>,
    pub mob_id: Option<i32>,
    pub quantity: i32,
}

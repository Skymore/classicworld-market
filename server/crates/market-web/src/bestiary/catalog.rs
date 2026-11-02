//! The item catalogue. `items.sqlite` (written by `build_item_database.py`)
//! holds the items seen on the market; Mapledex (`items.json`, `equips.json`)
//! and NiaDB (`items.json`) list every other Classic World item.
//! `ItemReferences::extend` adds those to the `Catalog` read from SQLite.
//!
//! Columns follow 0001 / 0011: `category` is the inventory tab from the id
//! prefix, `subcategory` the slot label (帽子, 消耗品, ...), `name_tw` and
//! `gms_id` come from Mapledex.

use std::collections::{BTreeMap, HashMap};
use std::path::Path;

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use sqlx::sqlite::SqliteConnectOptions;
use sqlx::{Connection, SqliteConnection};

use super::mapledex::{clean, Names};
use super::rows::{DropRow, ItemRow};

pub struct Catalog {
    pub items: Vec<ItemRow>,
    /// (item id, full catalogue record) for `item_records`, which
    /// `/api/v1/items/<id>` serves as-is.
    pub records: Vec<(i32, serde_json::Value)>,
    /// Distinct `source_version` values, joined.
    pub version: String,
    pub warnings: Vec<String>,
}

/// One `items` row of the SQLite catalogue.
pub struct SourceItem {
    pub id: i64,
    pub name_zh: Option<String>,
    pub name_en: Option<String>,
    pub category: Option<String>,
    pub icon_url: Option<String>,
    pub record_json: Option<String>,
}

#[derive(Default, Deserialize)]
struct Record {
    level: Option<i64>,
    cash: Option<bool>,
    mapledex_reference: Option<Reference>,
}

#[derive(Deserialize)]
struct Reference {
    data: Option<ReferenceData>,
}

#[derive(Deserialize)]
struct ReferenceData {
    #[serde(rename = "reqJob")]
    req_job: Option<i64>,
}

/// Inventory tab by id prefix, as the game's shop window groups items.
pub fn category_for(id: i32) -> &'static str {
    match id / 1_000_000 {
        1 => "装备",
        2 => "消耗",
        5 => "商城",
        _ => "其他",
    }
}

/// Slot label by id prefix. These are the labels DVG's catalogue gives the
/// market's items; all 1001 rows of items.sqlite agree with this table.
pub fn subcategory_for(id: i32) -> Option<&'static str> {
    let label = match (id / 1_000_000, id / 10_000) {
        (1, 100) => "帽子",
        (1, 101) => "脸饰",
        (1, 102) => "眼饰",
        (1, 103) => "耳环",
        (1, 104) => "上衣",
        (1, 105) => "套服",
        (1, 106) => "裤裙",
        (1, 107) => "鞋子",
        (1, 108) => "手套",
        (1, 109) => "盾牌",
        (1, 110) => "披风",
        (1, 111) => "戒指",
        (1, 130..=170) => "武器",
        (1, 180..=183) => "宠物装备",
        (2, _) => "消耗品",
        (3, 301) => "椅子",
        (3, _) => "设置道具",
        (4, _) => "其他道具",
        (5, 500) => "宠物",
        (5, _) => "现金道具",
        _ => return None,
    };
    Some(label)
}

/// DVG's icon CDN, keyed by the Classic World id. It has an icon for every
/// Classic World item and none for GMS-only ids.
pub fn icon_url(id: i32) -> String {
    format!("https://mxdgcw.dvg.cn/dbsource/icon/item/{id}.png")
}

/// Non-equipment carries level 0 for "no requirement"; 0 is a real
/// requirement only on equipment.
fn level_requirement(category: &str, level: Option<i64>) -> Option<i16> {
    level
        .filter(|&lv| category == "装备" || lv > 0)
        .and_then(|lv| i16::try_from(lv).ok())
}

impl SourceItem {
    /// Maps one catalogue row. `Err` is a warning: the row is skipped.
    pub fn to_row(&self) -> std::result::Result<ItemRow, String> {
        let id = i32::try_from(self.id).map_err(|_| format!("item id {} out of range", self.id))?;
        let record: Record = match self.record_json.as_deref() {
            Some(json) => serde_json::from_str(json)
                .map_err(|e| format!("item {id}: bad record_json: {e}"))?,
            None => Record::default(),
        };
        let category = category_for(id);
        let req_job_mask = record
            .mapledex_reference
            .and_then(|r| r.data)
            .and_then(|d| d.req_job)
            .and_then(|mask| i16::try_from(mask).ok());
        Ok(ItemRow {
            id,
            name_en: non_empty(self.name_en.as_deref()).unwrap_or_default(),
            name_zh: non_empty(self.name_zh.as_deref()),
            category: category.to_string(),
            subcategory: non_empty(self.category.as_deref()),
            req_level: level_requirement(category, record.level),
            req_job_mask,
            icon_url: non_empty(self.icon_url.as_deref()),
            is_cash: record.cash.unwrap_or(false) || category == "商城",
        })
    }
}

/// Reads every item from the SQLite catalogue.
pub async fn read_sqlite(path: &Path) -> Result<Catalog> {
    let options = SqliteConnectOptions::new().filename(path).read_only(true);
    let mut conn = SqliteConnection::connect_with(&options)
        .await
        .with_context(|| format!("opening {}", path.display()))?;
    #[derive(sqlx::FromRow)]
    struct Row {
        item_id: i64,
        name_zh: Option<String>,
        name_en: Option<String>,
        category: Option<String>,
        icon_url: Option<String>,
        record_json: Option<String>,
    }
    let rows: Vec<Row> = sqlx::query_as(
        "SELECT item_id, name_zh, name_en, category, icon_url, record_json FROM items ORDER BY item_id",
    )
    .fetch_all(&mut conn)
    .await
    .context("reading items")?;
    let versions: Vec<String> = sqlx::query_scalar(
        "SELECT DISTINCT source_version FROM items WHERE source_version IS NOT NULL ORDER BY 1",
    )
    .fetch_all(&mut conn)
    .await
    .context("reading source_version")?;
    conn.close().await.ok();

    let mut items = Vec::with_capacity(rows.len());
    let mut records = Vec::with_capacity(rows.len());
    let mut warnings = Vec::new();
    for row in rows {
        let record = row
            .record_json
            .as_deref()
            .and_then(|json| serde_json::from_str::<serde_json::Value>(json).ok());
        let source = SourceItem {
            id: row.item_id,
            name_zh: row.name_zh,
            name_en: row.name_en,
            category: row.category,
            icon_url: row.icon_url,
            record_json: row.record_json,
        };
        match source.to_row() {
            Ok(row) => {
                if row.name_en.is_empty() {
                    warnings.push(format!("item {}: no English name", row.id));
                }
                if let Some(record) = record {
                    records.push((row.id, record));
                }
                items.push(row);
            }
            Err(warning) => warnings.push(warning),
        }
    }
    let version = if versions.is_empty() {
        "unknown".to_string()
    } else {
        versions.join("; ")
    };
    Ok(Catalog {
        items,
        records,
        version,
        warnings,
    })
}

fn non_empty(text: Option<&str>) -> Option<String> {
    text.map(str::trim)
        .filter(|t| !t.is_empty())
        .map(str::to_string)
}

// ---------- Mapledex and NiaDB item lists ----------

#[derive(Deserialize)]
struct MapledexList {
    items: Vec<MapledexItem>,
}

/// An entry of Mapledex `items.json` or `equips.json`.
#[derive(Deserialize)]
struct MapledexItem {
    id: i32,
    #[serde(default)]
    n: Names,
    /// GMS v83 id; missing when Mapledex found no GMS counterpart.
    src: Option<i32>,
    #[serde(rename = "reqLevel")]
    req_level: Option<i64>,
    #[serde(rename = "reqJob")]
    req_job: Option<i64>,
    cash: Option<i64>,
}

/// An entry of NiaDB's `/msclassic/api/items` list.
#[derive(Deserialize)]
struct NiaDbItem {
    name: Option<String>,
    #[serde(rename = "type")]
    tab: Option<String>,
    #[serde(rename = "levelReq")]
    level_req: Option<i64>,
    /// The Classic World item id (NiaDB's own `id` is unrelated).
    #[serde(rename = "iconKey")]
    icon_key: String,
    /// A JSON object in a string: `{"watk":23,"critRate":1,"slots":7,...}`.
    stats: Option<String>,
}

/// What the reference lists say about one Classic World item.
#[derive(Debug, Default, Clone)]
struct Known {
    name_en: Option<String>,
    name_zh: Option<String>,
    name_tw: Option<String>,
    gms_id: Option<i32>,
    req_level: Option<i64>,
    req_job: Option<i64>,
    cash: bool,
    /// NiaDB's stats of an equipment item; the only source of its base
    /// critical rate and critical damage.
    niadb_stats: Option<serde_json::Map<String, serde_json::Value>>,
}

impl Known {
    fn to_row(&self, id: i32) -> ItemRow {
        let category = category_for(id);
        ItemRow {
            id,
            name_en: self.name_en.clone().unwrap_or_default(),
            name_zh: self.name_zh.clone(),
            category: category.to_string(),
            subcategory: subcategory_for(id).map(str::to_string),
            req_level: level_requirement(category, self.req_level),
            req_job_mask: self.req_job.and_then(|mask| i16::try_from(mask).ok()),
            icon_url: Some(icon_url(id)),
            is_cash: self.cash || category == "商城",
        }
    }
}

/// Every Classic World item Mapledex or NiaDB lists, by id. Mapledex wins
/// where both have a value: its English, simplified and traditional names
/// come from one client snapshot, the same one its drop tables use.
#[derive(Debug, Default)]
pub struct ItemReferences {
    items: BTreeMap<i32, Known>,
    pub mapledex_items: usize,
    pub niadb_items: usize,
    pub warnings: Vec<String>,
}

/// One `items` row as `import` writes it.
#[derive(Serialize)]
pub struct ItemColumns<'a> {
    #[serde(flatten)]
    pub row: &'a ItemRow,
    pub name_tw: Option<&'a str>,
    pub gms_id: Option<i32>,
}

impl ItemReferences {
    /// Reads Mapledex `items.json` and `equips.json` from `mapledex_dir`
    /// and NiaDB `items.json` from `niadb_dir`.
    pub fn from_dirs(mapledex_dir: &Path, niadb_dir: &Path) -> Result<Self> {
        let read = |path: std::path::PathBuf| {
            std::fs::read_to_string(&path).with_context(|| format!("reading {}", path.display()))
        };
        Self::from_json(
            &read(mapledex_dir.join("items.json"))?,
            &read(mapledex_dir.join("equips.json"))?,
            &read(niadb_dir.join("items.json"))?,
        )
    }

    pub fn from_json(
        mapledex_items: &str,
        mapledex_equips: &str,
        niadb_items: &str,
    ) -> Result<Self> {
        let mut out = Self::default();
        for (name, json) in [
            ("items.json", mapledex_items),
            ("equips.json", mapledex_equips),
        ] {
            let list: MapledexList =
                serde_json::from_str(json).with_context(|| format!("parsing Mapledex {name}"))?;
            for item in list.items {
                out.add_mapledex(item);
            }
        }
        let niadb: Vec<NiaDbItem> =
            serde_json::from_str(niadb_items).context("parsing NiaDB items.json")?;
        for item in niadb {
            out.add_niadb(item);
        }
        Ok(out)
    }

    fn add_mapledex(&mut self, item: MapledexItem) {
        if self.items.contains_key(&item.id) {
            self.warnings.push(format!(
                "Mapledex item {} listed twice; kept the first",
                item.id
            ));
            return;
        }
        self.mapledex_items += 1;
        self.items.insert(
            item.id,
            Known {
                name_en: item.n.en(),
                name_zh: item.n.cw(),
                name_tw: item.n.tw(),
                gms_id: item.src,
                req_level: item.req_level,
                req_job: item.req_job,
                cash: item.cash.is_some_and(|v| v != 0),
                niadb_stats: None,
            },
        );
    }

    fn add_niadb(&mut self, item: NiaDbItem) {
        let Ok(id) = item.icon_key.trim().parse::<i32>() else {
            self.warnings.push(format!(
                "NiaDB item {:?}: iconKey is not an id",
                item.icon_key
            ));
            return;
        };
        self.niadb_items += 1;
        let known = self.items.entry(id).or_default();
        if known.name_en.is_none() {
            known.name_en = clean(item.name.as_deref());
        }
        if known.req_level.is_none() {
            known.req_level = item.level_req;
        }
        known.cash |= item.tab.as_deref() == Some("Cash");
        if id / 1_000_000 == 1 && known.niadb_stats.is_none() {
            match item
                .stats
                .as_deref()
                .map(serde_json::from_str::<serde_json::Value>)
            {
                Some(Ok(serde_json::Value::Object(stats))) if !stats.is_empty() => {
                    known.niadb_stats = Some(stats);
                }
                Some(Ok(_)) | None => {}
                Some(Err(e)) => self
                    .warnings
                    .push(format!("NiaDB item {id}: bad stats: {e}")),
            }
        }
    }

    /// Adds NiaDB's stats to the catalogue record of every equipment item
    /// NiaDB lists, as `niadb_reference.stats`, and returns how many records
    /// got them. `queries::reference_stats` reads the base critical rate and
    /// damage from there. Records are replaced on every import, so a re-run
    /// leaves the same result.
    pub fn annotate_records(&self, catalog: &mut Catalog) -> usize {
        let mut annotated = 0;
        for (id, record) in &mut catalog.records {
            let stats = self.items.get(id).and_then(|k| k.niadb_stats.as_ref());
            if let (Some(stats), Some(object)) = (stats, record.as_object_mut()) {
                object.insert(
                    "niadb_reference".to_string(),
                    serde_json::json!({ "stats": stats }),
                );
                annotated += 1;
            }
        }
        annotated
    }

    pub fn len(&self) -> usize {
        self.items.len()
    }

    pub fn is_empty(&self) -> bool {
        self.items.is_empty()
    }

    pub fn gms_id(&self, id: i32) -> Option<i32> {
        self.items.get(&id).and_then(|k| k.gms_id)
    }

    pub fn name_tw(&self, id: i32) -> Option<&str> {
        self.items.get(&id).and_then(|k| k.name_tw.as_deref())
    }

    /// Adds a row for every listed item the catalogue lacks and returns how
    /// many. Rows already there (the market's items) keep every field.
    pub fn extend(&self, catalog: &mut Catalog) -> usize {
        let have: std::collections::HashSet<i32> = catalog.items.iter().map(|i| i.id).collect();
        let before = catalog.items.len();
        for (&id, known) in &self.items {
            if have.contains(&id) {
                continue;
            }
            if known.name_en.is_none() {
                catalog.warnings.push(format!("item {id}: no English name"));
            }
            catalog.items.push(known.to_row(id));
        }
        catalog.items.sort_by_key(|i| i.id);
        catalog.items.len() - before
    }

    /// The `items` rows of `catalog` with the columns only the reference lists carry.
    pub fn columns<'a>(&'a self, catalog: &'a Catalog) -> Vec<ItemColumns<'a>> {
        catalog
            .items
            .iter()
            .map(|row| ItemColumns {
                row,
                name_tw: self.name_tw(row.id),
                gms_id: self.gms_id(row.id),
            })
            .collect()
    }

    /// Gives GMS-only drops a Classic World id where one can be found, and
    /// every drop of a catalogued item that item's names.
    pub fn resolve_drops(&self, catalog: &Catalog, drops: &mut [DropRow]) -> DropResolution {
        let by_gms = self.unique_gms_ids();
        let names = NameIndex::unpaired(catalog, self);
        let items: HashMap<i32, &ItemRow> = catalog.items.iter().map(|i| (i.id, i)).collect();
        let mut out = DropResolution::default();
        for drop in drops.iter_mut() {
            if let (None, Some(gms)) = (drop.item_id, drop.gms_item_id) {
                if let Some(&id) = by_gms.get(&gms) {
                    drop.item_id = Some(id);
                    out.by_gms_id += 1;
                } else if let Some(id) = names.find(gms, drop) {
                    drop.item_id = Some(id);
                    out.by_name += 1;
                } else {
                    out.unresolved += 1;
                }
            }
            if let Some(item) = drop.item_id.and_then(|id| items.get(&id)) {
                drop.name_en = non_empty(Some(item.name_en.as_str())).or(drop.name_en.take());
                drop.name_zh = item.name_zh.clone().or(drop.name_zh.take());
                drop.name_tw = self
                    .name_tw(item.id)
                    .map(str::to_string)
                    .or(drop.name_tw.take());
            }
        }
        out
    }

    /// GMS id -> Classic World id, for GMS ids that only one item carries.
    fn unique_gms_ids(&self) -> HashMap<i32, i32> {
        let mut by_gms: HashMap<i32, Vec<i32>> = HashMap::new();
        for (&id, known) in &self.items {
            if let Some(gms) = known.gms_id {
                by_gms.entry(gms).or_default().push(id);
            }
        }
        by_gms
            .into_iter()
            .filter_map(|(gms, ids)| <[i32; 1]>::try_from(ids).ok().map(|[id]| (gms, id)))
            .collect()
    }
}

/// How `resolve_drops` treated the drops Mapledex lists by GMS id only.
#[derive(Debug, Default, Clone, PartialEq, Eq, Serialize)]
pub struct DropResolution {
    /// Resolved through an item's `gms_id`.
    pub by_gms_id: usize,
    /// Resolved through an unpaired item of the same name.
    pub by_name: usize,
    /// Left without a Classic World id: no item carries that GMS id or name.
    pub unresolved: usize,
}

/// Names of the catalogue items that have no GMS id. Classic World fixed
/// some English names ("Windshoes" -> "Wind Shoes", "Steal" -> "Steel"), so
/// Mapledex could not pair them and lists their drops by GMS id. A drop
/// matches when its English name (letters and digits only) or its
/// simplified name names exactly one such item of the same item family.
struct NameIndex {
    en: HashMap<(i32, String), Vec<i32>>,
    zh: HashMap<(i32, String), Vec<i32>>,
}

impl NameIndex {
    fn unpaired(catalog: &Catalog, refs: &ItemReferences) -> Self {
        let mut index = NameIndex {
            en: HashMap::new(),
            zh: HashMap::new(),
        };
        for item in catalog.items.iter().filter(|i| refs.gms_id(i.id).is_none()) {
            let family = family(item.id);
            if let Some(key) = fold_en(&item.name_en) {
                index.en.entry((family, key)).or_default().push(item.id);
            }
            if let Some(key) = item.name_zh.as_deref().and_then(fold_zh) {
                index.zh.entry((family, key)).or_default().push(item.id);
            }
        }
        index
    }

    fn find(&self, gms_id: i32, drop: &DropRow) -> Option<i32> {
        let family = family(gms_id);
        let lookup = |map: &HashMap<(i32, String), Vec<i32>>, key: Option<String>| {
            key.and_then(|key| match map.get(&(family, key))?.as_slice() {
                [id] => Some(*id),
                _ => None,
            })
        };
        let en = lookup(&self.en, drop.name_en.as_deref().and_then(fold_en));
        let zh = lookup(&self.zh, drop.name_zh.as_deref().and_then(fold_zh));
        match (en, zh) {
            (Some(a), Some(b)) if a != b => None,
            (a, b) => a.or(b),
        }
    }
}

/// Item family: equipment slot (1072xxx shoes), or type for the rest (204xxxx scrolls).
fn family(id: i32) -> i32 {
    if id / 1_000_000 == 1 {
        id / 1_000
    } else {
        id / 10_000
    }
}

fn fold_en(name: &str) -> Option<String> {
    let folded: String = name
        .chars()
        .filter(char::is_ascii_alphanumeric)
        .map(|c| c.to_ascii_lowercase())
        .collect();
    (!folded.is_empty()).then_some(folded)
}

fn fold_zh(name: &str) -> Option<String> {
    let folded: String = name.chars().filter(|c| !c.is_whitespace()).collect();
    (!folded.is_empty()).then_some(folded)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn source(id: i64, category: &str, record: &str) -> SourceItem {
        SourceItem {
            id,
            name_zh: Some("名字".into()),
            name_en: Some(" Name ".into()),
            category: Some(category.into()),
            icon_url: Some("https://example.invalid/i.png".into()),
            record_json: Some(record.into()),
        }
    }

    #[test]
    fn equipment_keeps_level_zero_and_job_mask() {
        let row = source(
            1002000,
            "帽子",
            r#"{"level": 0, "cash": false, "mapledex_reference": {"data": {"reqJob": 9}}}"#,
        )
        .to_row()
        .unwrap();
        assert_eq!(row.category, "装备");
        assert_eq!(row.subcategory.as_deref(), Some("帽子"));
        assert_eq!(row.req_level, Some(0));
        assert_eq!(row.req_job_mask, Some(9));
        assert_eq!(row.name_en, "Name");
        assert!(!row.is_cash);
    }

    #[test]
    fn non_equipment_level_zero_is_no_requirement() {
        let row = source(4010001, "其他道具", r#"{"level": 0}"#)
            .to_row()
            .unwrap();
        assert_eq!(row.category, "其他");
        assert_eq!(row.req_level, None);
        assert_eq!(row.req_job_mask, None);
    }

    #[test]
    fn cash_flag_and_prefix() {
        let cash_hat = source(1002140, "帽子", r#"{"level": 0, "cash": true}"#)
            .to_row()
            .unwrap();
        assert!(cash_hat.is_cash);
        assert_eq!(cash_hat.category, "装备");
        let coupon = source(5680001, "现金道具", "{}").to_row().unwrap();
        assert!(coupon.is_cash);
        assert_eq!(coupon.category, "商城");
        assert_eq!(category_for(2000000), "消耗");
        assert_eq!(category_for(3010000), "其他");
    }

    #[test]
    fn bad_record_is_a_warning() {
        let err = source(2000000, "消耗品", "{not json").to_row().unwrap_err();
        assert!(err.contains("item 2000000"));
    }

    #[test]
    fn subcategory_by_prefix() {
        assert_eq!(subcategory_for(1072049), Some("鞋子"));
        assert_eq!(subcategory_for(1302000), Some("武器"));
        assert_eq!(subcategory_for(1702005), Some("武器"));
        assert_eq!(subcategory_for(3010000), Some("椅子"));
        assert_eq!(subcategory_for(3994000), Some("设置道具"));
        assert_eq!(subcategory_for(5000015), Some("宠物"));
        assert_eq!(subcategory_for(5150000), Some("现金道具"));
        assert_eq!(subcategory_for(1902000), None, "mounts have no DVG label");
    }

    const MDX_ITEMS: &str = r#"{"items": [
        {"id": 2000000, "n": {"en": "Red Potion", "zh": "紅色藥水", "cw": "红色药水"}, "type": "consume", "src": 2000000},
        {"id": 2040002, "n": {"en": "Hat Accuracy Scroll: Greater"}, "type": "consume"},
        {"id": 5000015, "n": {"en": "Pet"}, "type": "cash"}
    ]}"#;
    const MDX_EQUIPS: &str = r#"{"items": [
        {"id": 1002000, "n": {"en": "Brown Skullcap", "zh": "褐色皮帽", "cw": "褐色皮帽"}, "slot": "Cap", "reqLevel": 5, "src": 1002008},
        {"id": 1072049, "n": {"en": "Yellow Wind Shoes"}, "slot": "Shoes", "reqLevel": 0, "reqJob": 2},
        {"id": 1082086, "n": {"en": "Steel Pow"}, "slot": "Gloves", "reqLevel": 30},
        {"id": 1002140, "n": {"en": "Cash Hat"}, "slot": "Cap", "reqLevel": 0, "cash": 1, "src": 1002140},
        {"id": 1040007, "n": {"en": "Twin A"}, "slot": "Top", "reqLevel": 10, "src": 1040900},
        {"id": 1041007, "n": {"en": "Twin B"}, "slot": "Top", "reqLevel": 10, "src": 1040900}
    ]}"#;
    const NIADB: &str = r#"[
        {"id": 1, "name": "Red Potion (NiaDB)", "type": "Use", "levelReq": 0, "iconKey": "2000000"},
        {"id": 2, "name": "Snail Package", "type": "Use", "levelReq": 0, "iconKey": "2430017"},
        {"id": 3, "name": "Gachapon Ticket", "type": "Cash", "levelReq": 0, "iconKey": "5220000"},
        {"id": 4, "name": "Broken", "type": "Etc", "levelReq": 0, "iconKey": "x"}
    ]"#;

    fn refs() -> ItemReferences {
        ItemReferences::from_json(MDX_ITEMS, MDX_EQUIPS, NIADB).unwrap()
    }

    fn market_catalog() -> Catalog {
        let mut hat = source(1002000, "帽子", r#"{"level": 5}"#).to_row().unwrap();
        hat.name_zh = Some("褐色皮帽".into());
        // The market's own subcategory and icon stay as items.sqlite has them.
        hat.icon_url = Some("https://example.invalid/hat.png".into());
        Catalog {
            items: vec![hat],
            records: Vec::new(),
            version: "test".into(),
            warnings: Vec::new(),
        }
    }

    #[test]
    fn niadb_stats_go_into_equipment_records() {
        let niadb = r#"[
            {"id": 690, "name": "Mithril Guards", "type": "Equip", "iconKey": "1472009",
             "stats": "{\"reqDex\":30,\"watk\":23,\"critRate\":1,\"slots\":7}"},
            {"id": 691, "name": "Hat", "type": "Equip", "iconKey": "1002000", "stats": "{not json"},
            {"id": 692, "name": "Red Potion", "type": "Use", "iconKey": "2000000", "stats": "{\"hp\":50}"}
        ]"#;
        let refs = ItemReferences::from_json(MDX_ITEMS, MDX_EQUIPS, niadb).unwrap();
        assert!(
            refs.warnings
                .iter()
                .any(|w| w.contains("NiaDB item 1002000: bad stats")),
            "{:?}",
            refs.warnings
        );
        let mut catalog = market_catalog();
        catalog.records = vec![
            (1472009, serde_json::json!({"level": 30})),
            (1002000, serde_json::json!({"level": 5})),
            (2000000, serde_json::json!({})),
        ];
        assert_eq!(refs.annotate_records(&mut catalog), 1);
        assert_eq!(
            catalog.records[0].1["niadb_reference"]["stats"]["critRate"],
            serde_json::json!(1)
        );
        assert_eq!(catalog.records[0].1["level"], serde_json::json!(30));
        assert!(catalog.records[1].1.get("niadb_reference").is_none());
        assert!(
            catalog.records[2].1.get("niadb_reference").is_none(),
            "equipment only"
        );
    }

    #[test]
    fn extend_adds_missing_items_and_keeps_market_rows() {
        let refs = refs();
        assert_eq!((refs.mapledex_items, refs.niadb_items), (9, 3));
        assert!(refs.warnings[0].contains("\"x\""), "{:?}", refs.warnings);
        let mut catalog = market_catalog();
        assert_eq!(refs.extend(&mut catalog), 10);
        let ids: Vec<i32> = catalog.items.iter().map(|i| i.id).collect();
        assert!(ids.windows(2).all(|w| w[0] < w[1]), "sorted: {ids:?}");

        let get = |id| catalog.items.iter().find(|i| i.id == id).unwrap();
        assert_eq!(
            get(1002000).icon_url.as_deref(),
            Some("https://example.invalid/hat.png")
        );
        let potion = get(2000000);
        assert_eq!(potion.name_en, "Red Potion", "Mapledex name wins");
        assert_eq!(potion.name_zh.as_deref(), Some("红色药水"));
        assert_eq!(potion.subcategory.as_deref(), Some("消耗品"));
        assert_eq!(
            potion.icon_url.as_deref(),
            Some("https://mxdgcw.dvg.cn/dbsource/icon/item/2000000.png")
        );
        let shoes = get(1072049);
        assert_eq!((shoes.req_level, shoes.req_job_mask), (Some(0), Some(2)));
        assert!(get(1002140).is_cash);
        assert!(get(5220000).is_cash, "NiaDB Cash tab");
        assert_eq!(get(2430017).name_en, "Snail Package", "NiaDB-only item");

        let columns = refs.columns(&catalog);
        let hat = serde_json::to_value(&columns[0]).unwrap();
        assert_eq!(hat["id"], 1002000);
        assert_eq!(hat["name_tw"], "褐色皮帽");
        assert_eq!(hat["gms_id"], 1002008);
    }

    fn gms_drop(gms: i32, en: &str, zh: Option<&str>) -> DropRow {
        DropRow {
            mob_id: 1,
            ord: 0,
            item_id: None,
            gms_item_id: Some(gms),
            name_en: Some(en.into()),
            name_zh: zh.map(Into::into),
            name_tw: None,
            meso_min: None,
            meso_max: None,
            rate_pct: 1.0,
            quest_id: None,
            source: None,
        }
    }

    #[test]
    fn resolves_drops_by_gms_id_and_unpaired_names() {
        let refs = refs();
        let mut catalog = market_catalog();
        refs.extend(&mut catalog);
        let mut known = gms_drop(0, "x", None);
        known.item_id = Some(2000000);
        known.gms_item_id = None;
        known.name_en = None;
        let mut drops = vec![
            known,
            gms_drop(1002008, "Brown Skullcap (GMS)", None),
            gms_drop(1072073, "Yellow Windshoes", Some("黄飘风鞋")),
            gms_drop(1082093, "Steal Pow", Some("钢铁柔丝手套")),
            gms_drop(1040900, "Twin", None),
            gms_drop(1492000, "Pistol", Some("短枪")),
            // Same name, other family (hat vs shoes): no match.
            gms_drop(1002999, "Yellow Wind Shoes", None),
        ];
        // Steel Pow's simplified name only comes from items.sqlite in practice.
        catalog
            .items
            .iter_mut()
            .find(|i| i.id == 1082086)
            .unwrap()
            .name_zh = Some("钢铁柔丝手套".into());
        let resolution = refs.resolve_drops(&catalog, &mut drops);
        assert_eq!(
            resolution,
            DropResolution {
                by_gms_id: 1,
                by_name: 2,
                unresolved: 3
            }
        );
        let ids: Vec<Option<i32>> = drops.iter().map(|d| d.item_id).collect();
        assert_eq!(
            ids,
            vec![
                Some(2000000),
                Some(1002000),
                Some(1072049),
                Some(1082086),
                None,
                None,
                None
            ]
        );
        assert_eq!(drops[0].name_zh.as_deref(), Some("红色药水"));
        assert_eq!(drops[0].name_tw.as_deref(), Some("紅色藥水"));
        assert_eq!(
            drops[2].name_en.as_deref(),
            Some("Yellow Wind Shoes"),
            "item's names replace the GMS ones"
        );
        assert_eq!(drops[4].gms_item_id, Some(1040900), "ambiguous GMS id kept");
        assert_eq!(drops[5].name_en.as_deref(), Some("Pistol"));
    }
}

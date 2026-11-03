//! Postgres reads for the bestiary pages. Runtime queries only (CI builds
//! without a database).

use std::collections::HashMap;

use market_core::protocol::equipment_for_display;
use market_core::report::Window;
use market_core::sales::SaleKind;
use serde_json::Value;
use sqlx::types::chrono::{DateTime, NaiveDate, Utc};
use sqlx::{FromRow, PgPool};

use super::model::*;
use super::route::{Edge, EdgeKind};

// Apply before pagination and counts, retaining imported test data privately.
macro_rules! public_mob {
    () => { "NOT m.unreleased AND m.id NOT BETWEEN 9990000 AND 9990005 AND m.name_en !~* '^test([[:space:]]|[(]|$)' AND COALESCE(m.name_zh, '') NOT LIKE '测试%'" };
}
pub(crate) const PUBLIC_MOB_FILTER: &str = public_mob!();

/// Chinese display name of a mobs / maps / npcs row: Classic World
/// simplified, then traditional, then English.
macro_rules! name {
    ($t:literal) => {
        concat!(
            "COALESCE(NULLIF(",
            $t,
            ".name_zh, ''), NULLIF(",
            $t,
            ".name_tw, ''), ",
            $t,
            ".name_en)"
        )
    };
}

/// English display name of the same rows, falling back to Chinese.
macro_rules! name_en {
    ($t:literal) => {
        concat!(
            "COALESCE(NULLIF(",
            $t,
            ".name_en, ''), NULLIF(",
            $t,
            ".name_zh, ''), ",
            $t,
            ".name_tw)"
        )
    };
}

/// A map's street ("金银岛") in both languages. In Chinese, maps on Maple
/// Island are always 彩虹岛 (some carry a wrong or missing street_zh), and
/// Victoria maps without a Chinese street fall back to 金银岛, not English.
macro_rules! streets {
    ($t:literal) => {
        concat!(
            "CASE WHEN ",
            $t,
            ".id BETWEEN 0 AND 9999999 THEN '彩虹岛' ELSE COALESCE(NULLIF(",
            $t,
            ".street_zh, ''), CASE WHEN ",
            $t,
            ".id BETWEEN 10000000 AND 19999999 THEN '金银岛' END, NULLIF(",
            $t,
            ".street_tw, ''), ",
            $t,
            ".street_en) END AS street, ",
            "COALESCE(NULLIF(",
            $t,
            ".street_en, ''), NULLIF(",
            $t,
            ".street_zh, ''), ",
            $t,
            ".street_tw) AS street_en"
        )
    };
}

/// `None` when neither language has a (non-empty) name.
fn optional_names(zh: Option<String>, en: Option<String>) -> Option<Names> {
    let zh = zh.filter(|s| !s.is_empty());
    let en = en.filter(|s| !s.is_empty());
    match (zh, en) {
        (None, None) => None,
        (zh, en) => Some(Names::new(zh.unwrap_or_default(), en.unwrap_or_default())),
    }
}

// ---------- item ----------

/// The quick card only needs catalogue fields and the already-computed market
/// summary. Do not load listings, charts, sales history or drop locations here.
pub async fn item_preview(db: &PgPool, id: i32, all: bool) -> sqlx::Result<Option<Value>> {
    let item = sqlx::query_as::<_, ItemSummary>(
        "SELECT id,name_zh,name_en,category,subcategory,req_level,req_job_mask,icon_url,is_cash FROM items WHERE id=$1",
    ).bind(id).fetch_optional(db).await?;
    let Some(item) = item else { return Ok(None) };
    let summary = sqlx::query_as::<_, (Value, Option<i64>, i32, i32, DateTime<Utc>)>(
        "SELECT ('{' || CASE WHEN $2 THEN a.list_fields ELSE s.list_fields END || '}')::jsonb,
            round(s.lowest_ask)::bigint,s.listings_count,s.shops_count,s.as_of
         FROM item_stats s JOIN item_stats_all a USING(item_id) WHERE item_id=$1",
    ).bind(id).bind(all).fetch_optional(db);
    let record = sqlx::query_scalar::<_, Value>("SELECT record FROM item_records WHERE item_id=$1")
        .bind(id).fetch_optional(db);
    let (summary, record, offers) = tokio::try_join!(summary, record, npc_offers(db, id))?;
    let stats = summary.map(|(fields, low, listings, shops, as_of)| {
        let price = |key: &str| fields[key].as_f64().map(|v| v.round() as i64);
        serde_json::json!({"typical":price("typical_window"),
            "typical_low":price("typical_window_low"),"typical_high":price("typical_window_high"),
            "lowest_ask":low,"sales_24h":fields["sales_window"],
            "listings_count":listings,"shops_count":shops,"as_of":as_of,"change_24h":null})
    });
    let equipment = super::equipment::equipment_reference(&item, record.as_ref());
    Ok(Some(serde_json::json!({"item":item,"stats":stats,"npc_offers":offers,
        "npc_sell":record.as_ref().and_then(npc_sell_price),"equipment":equipment,
        "market":{"as_of":stats.as_ref().map(|s| &s["as_of"]),
            "base_stats":record.as_ref().map(reference_stats).unwrap_or_default()}})))
}

/// `now` sets the 72-hour listing window, as `/api/v1/item/<id>` does. The
/// reads are independent, so they run concurrently on the pool.
pub async fn item_page_window(
    db: &PgPool,
    id: i32,
    now: f64,
    all: bool,
) -> sqlx::Result<Option<ItemPage>> {
    item_page_selected(db, id, now, all, &ItemSelection::default()).await
}

#[derive(Default)]
pub struct ItemSelection {
    pub variant: Option<i64>,
    pub attributes: Vec<(String, i64)>,
    pub equipment: String,
}

fn equipment_group_key(variant: &Variant) -> (Vec<(&str, i64)>, Option<i64>, usize) {
    let mut stats: Vec<_> = variant
        .stats
        .iter()
        .filter(|s| {
            !matches!(
                s.key.as_str(),
                "weapon_defense" | "magic_defense" | "pdd" | "mdd"
            )
        })
        .map(|s| (s.key.as_str(), s.value))
        .collect();
    stats.sort_unstable();
    (
        stats,
        variant.remaining_upgrades,
        variant.unknown_fields,
    )
}

pub async fn item_page_selected(
    db: &PgPool,
    id: i32,
    now: f64,
    all: bool,
    selection: &ItemSelection,
) -> sqlx::Result<Option<ItemPage>> {
    let mut selected_variant = None;
    let scoped = selection.variant.is_some()
        || !selection.attributes.is_empty()
        || matches!(
            selection.equipment.as_str(),
            "captured" | "missing" | "bonus"
        );
    let variant_ids = if scoped {
        let variants: Vec<(i64, Value)> =
            sqlx::query_as("SELECT id, stats FROM equipment_variants WHERE item_id=$1")
                .bind(id)
                .fetch_all(db)
                .await?;
        let variants: Vec<_> = variants
            .iter()
            .map(|(id, value)| parse_variant(*id, value))
            .collect();
        if let Some(wanted) = selection.variant {
            let Some(found) = variants.iter().find(|v| v.id == wanted) else {
                return Ok(None);
            };
            selected_variant = Some(found.clone());
        }
        let record: Option<Value> =
            sqlx::query_scalar("SELECT record FROM item_records WHERE item_id=$1")
                .bind(id)
                .fetch_optional(db)
                .await?;
        let base = record.as_ref().map(reference_stats).unwrap_or_default();
        let mut ids: Vec<i64> = variants
            .iter()
            .filter(|variant| {
                selected_variant.as_ref().is_none_or(|selected| {
                    equipment_group_key(selected) == equipment_group_key(variant)
                }) && selection.attributes.iter().all(|(key, minimum)| {
                    variant
                        .stats
                        .iter()
                        .any(|s| &s.key == key && s.value >= *minimum)
                }) && selection.equipment != "missing"
                    && (selection.equipment != "bonus" || super::pages::has_bonus(variant, &base))
            })
            .map(|v| v.id)
            .collect();
        if selected_variant.is_none()
            && selection.attributes.is_empty()
            && !matches!(selection.equipment.as_str(), "captured" | "bonus")
        {
            ids.push(0); // Unknown equipment has no variant id.
        }
        Some(ids)
    } else {
        None
    };
    let summary = sqlx::query_as::<_, (i64, Option<f64>, Option<f64>, Option<f64>)>(
        "SELECT count(*), percentile_cont(0.5) WITHIN GROUP (ORDER BY unit_price),
         percentile_cont(0.25) WITHIN GROUP (ORDER BY unit_price),
         percentile_cont(0.75) WITHIN GROUP (ORDER BY unit_price)
         FROM market_sales WHERE item_id=$1 AND detected_at<=to_timestamp($4) AND ($2::bool OR detected_at>=to_timestamp($3))
         AND ($5::bigint[] IS NULL OR coalesce(variant_id,0)=ANY($5))")
        .bind(id).bind(all).bind(now-72.0*3600.0).bind(now).bind(variant_ids.as_deref()).fetch_one(db);
    let (mut page, row) = tokio::try_join!(
        item_page_scoped(db, id, now, variant_ids.as_deref()), summary,
    )?;
    if let Some(p) = &mut page {
        p.selected_variant = selected_variant;
        if !all {
            p.market
                .sales
                .retain(|sale| sale.detected_at.timestamp() as f64 >= now - 72.0 * 3600.0);
        }
        if scoped {
            let shops: std::collections::HashSet<_> = p
                .market
                .listings
                .iter()
                .map(|l| {
                    l.grouping
                        .as_ref()
                        .map(|g| g.shop_key.clone())
                        .unwrap_or_else(|| format!("{:?}:{:?}:{}", l.channel, l.room, l.shop))
                })
                .collect();
            p.stats = Some(MarketStats {
                typical: None,
                typical_low: None,
                typical_high: None,
                sales_24h: 0,
                change_24h: None,
                lowest_ask: p
                    .market
                    .listings
                    .first()
                    .map(|l| l.unit_price.round() as i64),
                listings_count: p.market.listings.len().min(i32::MAX as usize) as i32,
                shops_count: shops.len().min(i32::MAX as usize) as i32,
                as_of: p.market.as_of.unwrap_or_else(Utc::now),
            });
        }
        if let Some(s) = &mut p.stats {
            s.sales_24h = row.0.min(i32::MAX as i64) as i32;
            s.typical = row.1.map(|v| v.round() as i64);
            s.typical_low = row.2.map(|v| v.round() as i64);
            s.typical_high = row.3.map(|v| v.round() as i64);
            // A 24h change is not a change over the selected window.
            s.change_24h = None;
        }
    }
    Ok(page)
}

pub async fn item_page(db: &PgPool, id: i32, now: f64) -> sqlx::Result<Option<ItemPage>> {
    item_page_scoped(db, id, now, None).await
}

async fn item_page_scoped(
    db: &PgPool,
    id: i32,
    now: f64,
    variant_ids: Option<&[i64]>,
) -> sqlx::Result<Option<ItemPage>> {
    let item = sqlx::query_as::<_, ItemSummary>(
        "SELECT id, name_zh, name_en, category, subcategory, req_level, req_job_mask, icon_url, is_cash
         FROM items WHERE id = $1",
    )
    .bind(id)
    .fetch_optional(db);
    let stats = sqlx::query_as::<_, MarketStats>(
        // Prices are double precision since 0002 (Python parity); pages show whole mesos.
        "SELECT round(typical)::bigint AS typical, round(typical_low)::bigint AS typical_low,
                round(typical_high)::bigint AS typical_high, sales_24h, change_24h::real AS change_24h,
                round(lowest_ask)::bigint AS lowest_ask, listings_count, shops_count, as_of
         FROM item_stats WHERE item_id = $1",
    )
    .bind(id)
    .fetch_optional(db);
    let record =
        sqlx::query_scalar::<_, Value>("SELECT record FROM item_records WHERE item_id = $1")
            .bind(id)
            .fetch_optional(db);
    let (item, stats, droppers, npc_offers, record, mut market) = tokio::try_join!(
        item,
        stats,
        droppers(db, id),
        npc_offers(db, id),
        record,
        item_market(db, id, now, variant_ids),
    )?;
    let (quest_rewards, quest_needs) =
        tokio::try_join!(quest_rewards(db, id), quest_needs(db, id, true))?;
    let Some(item) = item else {
        return Ok(None);
    };
    market.base_stats = record.as_ref().map(reference_stats).unwrap_or_default();
    Ok(Some(ItemPage {
        equipment: super::equipment::equipment_reference(&item, record.as_ref()),
        item,
        selected_variant: None,
        stats,
        droppers,
        npc_offers,
        npc_sell: record.as_ref().and_then(npc_sell_price),
        quest_rewards,
        quest_needs,
        market,
    }))
}

/// Quests a player can do now: open, and inside their event window.
macro_rules! visible_quest {
    () => {
        "NOT q.unreleased AND (q.starts_at IS NULL OR q.starts_at <= now())
         AND (q.ends_at IS NULL OR q.ends_at > now())"
    };
}

#[derive(FromRow)]
struct QuestColumns {
    quest_id: i32,
    quest_name: String,
    quest_name_en: String,
    level_min: Option<i16>,
    repeats: Option<String>,
    ends_at: Option<DateTime<Utc>>,
    npc_id: Option<i32>,
    npc_name: Option<String>,
    npc_name_en: Option<String>,
}

impl QuestColumns {
    fn quest(self) -> QuestRef {
        QuestRef {
            id: self.quest_id,
            names: Names::new(self.quest_name, self.quest_name_en),
            npc: self.npc_id.map(|id| NpcRef {
                id,
                names: optional_names(self.npc_name, self.npc_name_en),
            }),
            level_min: self.level_min,
            repeats: self.repeats,
            ends_at: self.ends_at,
        }
    }
}

const QUEST_COLUMNS: &str = concat!(
    "q.id AS quest_id, COALESCE(NULLIF(q.name_zh, ''), q.name_en, '') AS quest_name,
     COALESCE(NULLIF(q.name_en, ''), q.name_zh, '') AS quest_name_en, q.level_min, q.repeats,
     q.ends_at, n.id AS npc_id, ",
    name!("n"),
    " AS npc_name, ",
    name_en!("n"),
    " AS npc_name_en"
);

/// Shown quests per item or monster.
const QUESTS_SHOWN: i64 = 60;

async fn quest_rewards(db: &PgPool, item_id: i32) -> sqlx::Result<Vec<QuestReward>> {
    #[derive(FromRow)]
    struct Row {
        #[sqlx(flatten)]
        quest: QuestColumns,
        quantity: i32,
        kind: String,
        job: Option<String>,
        chance_pct: Option<f32>,
    }
    let rows: Vec<Row> = sqlx::query_as(&format!(
        "SELECT {QUEST_COLUMNS}, r.quantity, r.kind, r.job, r.chance_pct
         FROM quest_rewards r JOIN quests q ON q.id = r.quest_id LEFT JOIN npcs n ON n.id = q.npc_id
         WHERE r.item_id = $1 AND {visible}
         ORDER BY q.level_min NULLS FIRST, q.id LIMIT {QUESTS_SHOWN}",
        visible = visible_quest!()
    ))
    .bind(item_id)
    .fetch_all(db)
    .await?;
    Ok(rows
        .into_iter()
        .map(|r| QuestReward {
            quest: r.quest.quest(),
            quantity: r.quantity,
            kind: r.kind,
            job: r.job,
            chance_pct: r.chance_pct,
        })
        .collect())
}

/// Quests that ask for an item (`item = true`) or to defeat a monster.
async fn quest_needs(db: &PgPool, id: i32, item: bool) -> sqlx::Result<Vec<QuestNeed>> {
    #[derive(FromRow)]
    struct Row {
        #[sqlx(flatten)]
        quest: QuestColumns,
        quantity: i64,
    }
    let column = if item { "item_id" } else { "mob_id" };
    let rows: Vec<Row> = sqlx::query_as(&format!(
        "SELECT {QUEST_COLUMNS}, sum(x.quantity) AS quantity
         FROM quest_needs x JOIN quests q ON q.id = x.quest_id LEFT JOIN npcs n ON n.id = q.npc_id
         WHERE x.{column} = $1 AND {visible}
         GROUP BY q.id, n.id
         ORDER BY q.level_min NULLS FIRST, q.id LIMIT {QUESTS_SHOWN}",
        visible = visible_quest!()
    ))
    .bind(id)
    .fetch_all(db)
    .await?;
    Ok(rows
        .into_iter()
        .map(|r| QuestNeed {
            quest: r.quest.quest(),
            quantity: i32::try_from(r.quantity).unwrap_or(i32::MAX),
        })
        .collect())
}

async fn npc_offers(db: &PgPool, item_id: i32) -> sqlx::Result<Vec<NpcOffer>> {
    let rows = sqlx::query_as::<_, (i32, Option<String>, Option<String>, i64)>(concat!(
        "SELECT n.id, ",
        name!("n"),
        ", ",
        name_en!("n"),
        ", s.price FROM npc_shops s JOIN npcs n ON n.id = s.npc_id
         WHERE s.item_id = $1 AND NOT n.unreleased ORDER BY s.price, n.id"
    ))
    .bind(item_id)
    .fetch_all(db)
    .await?;
    Ok(rows
        .into_iter()
        .map(|(id, zh, en, price)| NpcOffer {
            npc: NpcRef {
                id,
                names: optional_names(zh, en),
            },
            price,
        })
        .collect())
}

/// DVG's `npc_price` when it has one, else Mapledex's shop `price`.
fn npc_sell_price(record: &Value) -> Option<i64> {
    let positive = |v: Option<&Value>| v.and_then(Value::as_f64).filter(|p| *p > 0.0);
    positive(record.get("npc_price"))
        .or_else(|| positive(record.pointer("/mapledex_reference/data/price")))
        .map(|p| p.round() as i64)
}

/// Mapledex / DVG stat names -> `equipment_variants` stat keys.
const REFERENCE_KEYS: [(&str, &str); 14] = [
    ("incPAD", "weapon_attack"),
    ("incMAD", "magic_attack"),
    ("incPDD", "weapon_defense"),
    ("incMDD", "magic_defense"),
    ("incSTR", "str"),
    ("incDEX", "dex"),
    ("incINT", "int"),
    ("incLUK", "luk"),
    ("incACC", "accuracy"),
    ("incEVA", "avoid"),
    ("incSpeed", "speed"),
    ("incJump", "jump"),
    ("incMHP", "hp"),
    ("incMMP", "mp"),
];

/// NiaDB stat names -> variant keys, for the stats only NiaDB lists.
const NIADB_KEYS: [(&str, &str); 2] = [
    ("critRate", "critical_rate"),
    ("critDamage", "critical_damage"),
];

/// The item's reference stats in variant keys: Mapledex first (it has weapon
/// attack), then DVG `base_stats` for keys Mapledex lacks, then NiaDB's
/// critical rate and damage (`import_catalog` stores them as `niadb_reference`).
pub(crate) fn reference_stats(record: &Value) -> Vec<(String, i64)> {
    let mut out: Vec<(String, i64)> = Vec::new();
    let mut put = |source: &str, value: Option<i64>| {
        let key = REFERENCE_KEYS.iter().find(|(from, _)| *from == source);
        if let (Some((_, key)), Some(value)) = (key, value) {
            if !out.iter().any(|(k, _)| k == key) {
                out.push((key.to_string(), value));
            }
        }
    };
    if let Some(data) = record
        .pointer("/mapledex_reference/data")
        .and_then(Value::as_object)
    {
        for (source, _) in REFERENCE_KEYS {
            put(source, data.get(source).and_then(Value::as_i64));
        }
    }
    for stat in record
        .get("base_stats")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
    {
        if let Some(key) = stat.get("key").and_then(Value::as_str) {
            put(key, stat.get("value").and_then(Value::as_i64));
        }
    }
    if let Some(stats) = record
        .pointer("/niadb_reference/stats")
        .and_then(Value::as_object)
    {
        for (source, key) in NIADB_KEYS {
            if let Some(value) = stats.get(source).and_then(Value::as_i64) {
                if !out.iter().any(|(k, _)| k == key) {
                    out.push((key.to_string(), value));
                }
            }
        }
    }
    out
}

async fn droppers(db: &PgPool, item_id: i32) -> sqlx::Result<Vec<Dropper>> {
    #[derive(FromRow)]
    struct Row {
        #[sqlx(flatten)]
        mob: MobRef,
        votes: Option<f64>,
    }
    // A mob can list the same item twice; show it once.
    let rows: Vec<Row> = sqlx::query_as(concat!(
        "SELECT m.id, ",
        name!("m"),
        " AS name, ",
        name_en!("m"),
        " AS name_en, m.level, COALESCE(m.gms_id, l.gms_id) AS image_id, max(d.upvotes)::float8 AS votes
         FROM drops d JOIN mobs m ON m.id = d.mob_id LEFT JOIN mobs l ON l.id = m.link_id
         WHERE d.item_id = $1 AND ", public_mob!(), "
         GROUP BY m.id, l.gms_id
         ORDER BY votes DESC NULLS LAST, m.level NULLS LAST, m.id"
    ))
    .bind(item_id)
    .fetch_all(db)
    .await?;
    let ids: Vec<i32> = rows.iter().map(|r| r.mob.id).collect();
    let mut maps = maps_of_mobs(db, &ids).await?;
    let droppers = rows
        .into_iter()
        .map(|r| Dropper {
            maps: maps.remove(&r.mob.id).unwrap_or_default(),
            mob: r.mob,
            votes: r.votes.map(|v| v.round() as i64),
        })
        .collect();
    Ok(merge_variants(droppers))
}

/// Mapledex lists event and park variants of a mob (`link_id`, ids 800xxx)
/// under the same name with a copy of its drop table, so an item page showed
/// e.g. 红蜗牛王 twice. Keep one row per name: the one that spawns on the most
/// maps (ties keep the query order), with the other rows' maps appended.
fn merge_variants(rows: Vec<Dropper>) -> Vec<Dropper> {
    let mut out: Vec<Dropper> = Vec::with_capacity(rows.len());
    let mut by_name: HashMap<String, usize> = HashMap::new();
    for row in rows {
        let Some(&at) = by_name.get(&row.mob.names.zh) else {
            by_name.insert(row.mob.names.zh.clone(), out.len());
            out.push(row);
            continue;
        };
        let kept = &mut out[at];
        let (mut first, second) = if row.maps.len() > kept.maps.len() {
            let old = std::mem::replace(kept, row);
            (kept.maps.clone(), old.maps)
        } else {
            (kept.maps.clone(), row.maps)
        };
        for map in second {
            if !first.iter().any(|m| m.id == map.id) {
                first.push(map);
            }
        }
        kept.maps = first;
    }
    out
}

/// Maps each mob spawns on, busiest first.
async fn maps_of_mobs(db: &PgPool, mob_ids: &[i32]) -> sqlx::Result<HashMap<i32, Vec<MapRef>>> {
    let rows: Vec<(i32, i32, String, String)> = sqlx::query_as(concat!(
        "SELECT s.mob_id, mp.id, ",
        name!("mp"),
        ", ",
        name_en!("mp"),
        " FROM mob_spawns s JOIN maps mp ON mp.id = s.map_id
         WHERE s.mob_id = ANY($1) AND NOT mp.unreleased
         ORDER BY s.mob_id, s.spawn_count DESC, mp.id"
    ))
    .bind(mob_ids)
    .fetch_all(db)
    .await?;
    let mut out: HashMap<i32, Vec<MapRef>> = HashMap::new();
    for (mob_id, id, zh, en) in rows {
        out.entry(mob_id).or_default().push(MapRef::new(id, zh, en));
    }
    Ok(out)
}

/// Shown sales, as many as `/api/v1/item/<id>` returns.
const SALES_SHOWN: i64 = 50;
/// Days on the price ladder and the trend chart.
pub const MARKET_DAYS: i64 = 7;

#[derive(FromRow)]
struct VariantColumns {
    variant_id: Option<i64>,
    stats: Option<Value>,
}

impl VariantColumns {
    fn variant(self) -> Option<Variant> {
        Some(parse_variant(self.variant_id?, &self.stats?))
    }
}

fn parse_variant(id: i64, value: &Value) -> Variant {
    let value = equipment_for_display(value.clone());
    let stats = value
        .get("stats")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|s| {
            Some(Stat {
                key: s.get("key")?.as_str()?.to_string(),
                label: s.get("label")?.as_str()?.to_string(),
                value: s.get("value")?.as_i64()?,
            })
        })
        .collect();
    Variant {
        id,
        stats,
        remaining_upgrades: value.get("remaining_upgrades").and_then(Value::as_i64),
        enhancements: value.get("enhancements").and_then(Value::as_i64),
        unknown_fields: value
            .get("unknown_fields")
            .and_then(Value::as_array)
            .map_or(0, Vec::len),
    }
}

/// Listings, sales and the 7-day inputs of one item. Same windows and order
/// as `views::item_page`, so the page and the poll it refreshes from agree.
async fn item_market(
    db: &PgPool,
    id: i32,
    now: f64,
    variant_ids: Option<&[i64]>,
) -> sqlx::Result<ItemMarket> {
    #[derive(FromRow)]
    struct ListingRow {
        owner_name: Option<String>,
        invalidated_at: Option<DateTime<Utc>>,
        shop_key: String,
        slot: i32,
        visit_key: String,
        bundle: i32,
        source: String,
        title: String,
        channel: Option<i16>,
        room: Option<i16>,
        unit_price: f64,
        stock: i32,
        observed_at: DateTime<Utc>,
        #[sqlx(flatten)]
        variant: VariantColumns,
    }
    #[derive(FromRow)]
    struct SaleRow {
        observed_location: Option<String>,
        kind: String,
        unit_price: f64,
        quantity: Option<i64>,
        title: String,
        channel: Option<i16>,
        room: Option<i16>,
        observed_at: DateTime<Utc>,
        observation_id: Option<i64>,
        shop_id: Option<i64>,
        bundle: Option<i32>,
        window_start: Option<DateTime<Utc>>,
        #[sqlx(flatten)]
        variant: VariantColumns,
    }
    let as_of = sqlx::query_scalar::<_, Option<DateTime<Utc>>>("SELECT as_of FROM market_state")
        .fetch_optional(db);
    let listings = sqlx::query_as::<_, ListingRow>(
        "SELECT sh.public_key AS shop_key, l.slot, o.visit_key, l.bundle, o.source,
                sh.owner_name, NULL::timestamptz AS invalidated_at, sh.title, sh.channel, sh.room, market_unit_price(l.item_id,l.price,l.bundle) AS unit_price, l.stock,
                o.observed_at, l.variant_id, v.stats
         FROM listings l
         JOIN shops sh ON sh.id = l.shop_id JOIN observations o ON o.id = l.observation_id
         LEFT JOIN equipment_variants v ON v.id = l.variant_id
         WHERE l.item_id = $1 AND l.stock > 0 AND sh.last_seen_at >= to_timestamp($2)
           AND ($3::bigint[] IS NULL OR coalesce(l.variant_id,0)=ANY($3))
         ORDER BY l.price::float8 / l.bundle, sh.public_key, l.slot",
    )
    .bind(id)
    .bind(Window::recent(now).cutoff)
    .bind(variant_ids)
    .fetch_all(db);
    let expired = sqlx::query_as::<_, ListingRow>(
        "SELECT sh.public_key AS shop_key,l.slot,o.visit_key,l.bundle,o.source,sh.owner_name,
          l.invalidated_at,sh.title,sh.channel,sh.room,market_unit_price(l.item_id,l.price,l.bundle) AS unit_price,
          l.stock,o.observed_at,l.variant_id,v.stats FROM (
            SELECT * FROM expired_listings WHERE item_id=$1 AND invalidated_at>=to_timestamp($2)
              AND ($3::bigint[] IS NULL OR coalesce(variant_id,0)=ANY($3))
            ORDER BY invalidated_at DESC,observation_id DESC,slot LIMIT 200
          ) l
          JOIN shops sh ON sh.id=l.shop_id JOIN observations o ON o.id=l.observation_id
          LEFT JOIN equipment_variants v ON v.id=l.variant_id
          ORDER BY l.invalidated_at DESC,l.observation_id DESC,l.slot LIMIT 200"
    ).bind(id).bind(Window::recent(now).cutoff).bind(variant_ids).fetch_all(db);
    let sales = sqlx::query_as::<_, SaleRow>(
        "SELECT s.kind, s.unit_price, s.quantity,
                COALESCE(sh.title,s.source_seller,'') AS title,
                COALESCE(sh.channel,o.map_channel,(s.source_location->>'channel')::int2) AS channel,
                COALESCE(sh.room,(s.source_location->>'room')::int2) AS room,
                CASE WHEN s.source='mesowatch' THEN s.source_location->>'text'
                WHEN sh.room IS NULL AND o.map_id IS NOT NULL THEN
                  COALESCE((SELECT COALESCE(name_zh,name_en) FROM maps WHERE id=o.map_id),o.map_id::text)
                END AS observed_location, s.detected_at AS observed_at,
                s.observation_id, s.shop_id, s.bundle, s.window_start, s.variant_id, v.stats
         FROM (SELECT * FROM market_sales
           WHERE item_id = $1 AND detected_at <= to_timestamp($3)
             AND ($4::bigint[] IS NULL OR coalesce(variant_id,0)=ANY($4))
           ORDER BY detected_at DESC, observation_id, position LIMIT $2) s
         LEFT JOIN observations o ON o.id = s.observation_id LEFT JOIN shops sh ON sh.id = s.shop_id
         LEFT JOIN equipment_variants v ON v.id = s.variant_id
         ORDER BY s.detected_at DESC, s.observation_id, s.position LIMIT $2",
    )
    .bind(id)
    .bind(SALES_SHOWN)
    .bind(now)
    .bind(variant_ids)
    .fetch_all(db);
    let history = async {
        let as_of = as_of.await?.flatten();
        let (days, sale_points) = if as_of.is_some() {
            seven_days(
                db, id,
                DateTime::from_timestamp(now as i64, 0).expect("valid current time").date_naive(),
                variant_ids,
            ).await?
        } else {
            (Vec::new(), Vec::new())
        };
        Ok::<_, sqlx::Error>((as_of, days, sale_points))
    };
    let item_ids = [id];
    let ((as_of, days, sale_points), listings, sales, expired, external, listing_days) = tokio::try_join!(
        history, listings, sales, expired,
        crate::external::quote_rows(db, &item_ids, Window::recent(now).cutoff),
        listing_days(db, id, now, variant_ids),
    )?;
    let listing = |r: ListingRow| Listing {
            owner_name: r.owner_name,
            invalidated_at: r.invalidated_at,
            grouping: Some(ListingIdentity {
                shop_key: r.shop_key,
                slot: r.slot,
                visit_id: r.visit_key,
                bundle: r.bundle,
                source: r.source,
            }),
            shop: r.title,
            channel: r.channel,
            room: r.room,
            unit_price: r.unit_price,
            stock: Some(r.stock),
            seen_at: r.observed_at,
            variant: r.variant.variant(),
        };
    let expired_listings = expired.into_iter().map(listing).collect();
    let mut listings: Vec<Listing> = listings.into_iter().map(listing).collect();
    for row in external {
        if variant_ids.is_some_and(|ids| !ids.contains(&0)) {
            continue;
        }
        if let Some(seen_at) =
            DateTime::from_timestamp(row["time"].as_f64().unwrap_or(0.) as i64, 0)
        {
            listings.push(Listing {
                owner_name: None,
                invalidated_at: None,
                grouping: None,
                shop: row["shop"].as_str().unwrap_or("").to_owned(),
                channel: row["location"]["channel"].as_i64().map(|v| v as i16),
                room: row["location"]["room"].as_i64().map(|v| v as i16),
                unit_price: row["unit_price"].as_f64().unwrap_or(0.),
                stock: None,
                seen_at,
                variant: None,
            });
        }
    }
    listings.sort_by(|a, b| a.unit_price.total_cmp(&b.unit_price));
    let gear = id / 1_000_000 == 1;
    let sales = merge_shop_sales(
        sales
            .into_iter()
            .filter_map(|r| {
                let kind = SaleKind::parse(&r.kind)?;
                let variant = r.variant.variant();
                // Gear merges only when its attributes are known and identical.
                let known = !gear || variant.as_ref().is_some_and(|v| v.unknown_fields == 0);
                let key = r
                    .observation_id
                    .filter(|_| known)
                    .map(|observation| SaleGroup {
                        observation,
                        shop: r.shop_id,
                        kind,
                        price: r.unit_price.to_bits(),
                        bundle: r.bundle,
                        variant: variant.as_ref().map(|v| v.id),
                        previous: r.window_start,
                    });
                Some((
                    key,
                    Sale {
                        observed_location: r.observed_location,
                        kind,
                        unit_price: r.unit_price,
                        quantity: r.quantity,
                        shop: r.title,
                        channel: r.channel,
                        room: r.room,
                        detected_at: r.observed_at,
                        variant,
                        merged_count: 1,
                    },
                ))
            })
            .collect(),
    );
    Ok(ItemMarket {
        expired_listings,
        as_of,
        listings,
        sales,
        days,
        listing_days,
        sale_points,
        base_stats: Vec::new(),
    })
}

/// One shop's sale of an item seen at one visit: same price, evidence, bundle,
/// attributes and previous visit.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
struct SaleGroup {
    observation: i64,
    shop: Option<i64>,
    kind: SaleKind,
    price: u64,
    bundle: Option<i32>,
    variant: Option<i64>,
    previous: Option<DateTime<Utc>>,
}

/// A sale is one shop slot. Slots in the same group read as one sale: six sold-out
/// slots of 100 become one sale of 600. A quantity stays unknown if any slot's is;
/// rows without a group (other sources, unknown gear) are kept as they are.
fn merge_shop_sales(rows: Vec<(Option<SaleGroup>, Sale)>) -> Vec<Sale> {
    let mut out: Vec<Sale> = Vec::with_capacity(rows.len());
    let mut groups: HashMap<SaleGroup, usize> = HashMap::new();
    for (key, sale) in rows {
        if let Some(&at) = key.as_ref().and_then(|k| groups.get(k)) {
            let group = &mut out[at];
            group.quantity = group
                .quantity
                .zip(sale.quantity)
                .and_then(|(a, b)| a.checked_add(b));
            group.merged_count += 1;
            continue;
        }
        if let Some(k) = key {
            groups.insert(k, out.len());
        }
        out.push(sale);
    }
    out
}

/// Historical observed quotes remain history when a shop later disappears.
/// Deduplicate repeated scans so frequent collectors do not skew the median.
// Keep the lookup correlated even after PostgreSQL chooses a generic prepared
// plan. A normal join estimates the date/variant parameters as selective, then
// hashes the entire observation window (and spills it) for every item request.
// OFFSET 0 prevents flattening; the item index bounds the observation lookups.
const LISTING_DAYS_SQL: &str =
    "WITH quotes AS (
       SELECT DISTINCT ON ((o.observed_at AT TIME ZONE 'UTC')::date,o.shop_id,r.slot)
         (o.observed_at AT TIME ZONE 'UTC')::date AS day,
         market_unit_price(r.item_id,r.price,r.bundle) AS price
       FROM observation_rows r
       JOIN LATERAL (
         SELECT observed_at,shop_id,visit_key FROM observations
         WHERE id=r.observation_id OFFSET 0
       ) o ON true
       WHERE r.item_id=$1 AND r.stock>0 AND r.price>0 AND r.bundle>0
         AND o.observed_at >= ($2::date)::timestamp AT TIME ZONE 'UTC'
         AND o.observed_at <= to_timestamp($3)
         AND ($4::bigint[] IS NULL OR coalesce(r.variant_id,0)=ANY($4))
       ORDER BY (o.observed_at AT TIME ZONE 'UTC')::date,o.shop_id,r.slot,
                o.observed_at DESC,o.visit_key DESC
     ) SELECT day,percentile_cont(0.5) WITHIN GROUP (ORDER BY price),
       min(price),max(price),count(*)::int FROM quotes GROUP BY day";

async fn listing_days(
    db: &PgPool, id: i32, now: f64, variant_ids: Option<&[i64]>,
) -> sqlx::Result<Vec<Day>> {
    let last = DateTime::from_timestamp(now as i64, 0).expect("valid current time").date_naive();
    let first = (1..MARKET_DAYS).fold(last, |d, _| d.pred_opt().unwrap_or(d));
    type Row = (NaiveDate, Option<f64>, Option<f64>, Option<f64>, i32);
    let rows: Vec<Row> = sqlx::query_as(LISTING_DAYS_SQL)
        .bind(id).bind(first).bind(now).bind(variant_ids).fetch_all(db).await?;
    Ok(first.iter_days().take(MARKET_DAYS as usize).map(|date| {
        let row = rows.iter().find(|r| r.0 == date);
        Day { date, median: row.and_then(|r| r.1), low: row.and_then(|r| r.2),
            high: row.and_then(|r| r.3), count: row.map_or(0, |r| r.4) }
    }).collect())
}

/// `item_daily` and the single sale prices of the seven days ending `last`.
/// Days without sales are present with a zero count.
async fn seven_days(
    db: &PgPool,
    id: i32,
    last: NaiveDate,
    variant_ids: Option<&[i64]>,
) -> sqlx::Result<(Vec<Day>, Vec<SalePoint>)> {
    let first = (1..MARKET_DAYS).fold(last, |d, _| d.pred_opt().unwrap_or(d));
    type DailyRow = (NaiveDate, Option<f64>, Option<f64>, Option<f64>, i32);
    let rows: Vec<DailyRow> = if let Some(ids) = variant_ids {
        sqlx::query_as(
            "SELECT (detected_at AT TIME ZONE 'UTC')::date,
             percentile_cont(0.5) WITHIN GROUP (ORDER BY unit_price),
             min(unit_price), max(unit_price), count(*)::int
             FROM market_sales WHERE item_id=$1 AND unit_price>0
             AND detected_at >= ($2::date)::timestamp AT TIME ZONE 'UTC'
             AND detected_at < (($3::date)+1)::timestamp AT TIME ZONE 'UTC'
             AND coalesce(variant_id,0)=ANY($4) GROUP BY 1",
        )
        .bind(id)
        .bind(first)
        .bind(last)
        .bind(ids)
        .fetch_all(db)
        .await?
    } else {
        sqlx::query_as(
            "SELECT day, median, low, high, count FROM item_daily
         WHERE item_id = $1 AND day BETWEEN $2 AND $3",
        )
        .bind(id)
        .bind(first)
        .bind(last)
        .fetch_all(db)
        .await?
    };
    let days: Vec<Day> = first
        .iter_days()
        .take(MARKET_DAYS as usize)
        .map(|date| {
            let row = rows.iter().find(|r| r.0 == date);
            Day {
                date,
                median: row.and_then(|r| r.1),
                low: row.and_then(|r| r.2),
                high: row.and_then(|r| r.3),
                count: row.map_or(0, |r| r.4),
            }
        })
        .collect();
    // Same grouping as item_daily: UTC day of detection, positive prices.
    let points: Vec<(NaiveDate, f64)> = sqlx::query_as(
        "SELECT (s.detected_at AT TIME ZONE 'UTC')::date, s.unit_price
         FROM market_sales s
         WHERE s.item_id = $1 AND s.unit_price > 0
           AND s.detected_at >= ($2::date)::timestamp AT TIME ZONE 'UTC'
           AND s.detected_at < (($3::date) + 1)::timestamp AT TIME ZONE 'UTC'
           AND ($4::bigint[] IS NULL OR coalesce(s.variant_id,0)=ANY($4))",
    )
    .bind(id)
    .bind(first)
    .bind(last)
    .bind(variant_ids)
    .fetch_all(db)
    .await?;
    let sale_points = points
        .into_iter()
        .filter_map(|(date, price)| {
            let day = (date - first).num_days();
            (0..MARKET_DAYS).contains(&day).then_some(SalePoint {
                day: day as usize,
                price,
            })
        })
        .collect();
    Ok((days, sale_points))
}

// ---------- mob ----------

pub async fn mob_page(db: &PgPool, id: i32) -> sqlx::Result<Option<MobPage>> {
    let Some(mob) = sqlx::query_as::<_, MobDetail>(concat!(
        "SELECT m.id, ",
        name!("m"),
        " AS name, ",
        name_en!("m"),
        " AS name_en, m.level, COALESCE(m.gms_id, l.gms_id) AS image_id,
                m.hp, m.mp, m.exp, m.pad, m.pdd, m.mad, m.mdd, m.acc, m.eva, m.speed,
                m.is_boss, m.is_undead, m.description
         FROM mobs m LEFT JOIN mobs l ON l.id = m.link_id WHERE m.id = $1 AND ",
        public_mob!()
    ))
    .bind(id)
    .fetch_optional(db)
    .await?
    else {
        return Ok(None);
    };
    #[allow(clippy::type_complexity)]
    let rows: Vec<(i32, String, String, Option<String>, Option<String>, i16)> =
        sqlx::query_as(concat!(
            "SELECT mp.id, ",
            name!("mp"),
            ", ",
            name_en!("mp"),
            ", ",
            streets!("mp"),
            ", s.spawn_count
         FROM mob_spawns s JOIN maps mp ON mp.id = s.map_id
         WHERE s.mob_id = $1 AND NOT mp.unreleased ORDER BY s.spawn_count DESC, mp.id"
        ))
        .bind(id)
        .fetch_all(db)
        .await?;
    let spawns = rows
        .into_iter()
        .map(|(id, zh, en, street, street_en, spawn_count)| Spawn {
            map: MapRef::new(id, zh, en),
            street: optional_names(street, street_en),
            spawn_count,
        })
        .collect();
    Ok(Some(MobPage {
        mob,
        spawns,
        drops: mob_drops(db, id).await?,
        quests: quest_needs(db, id, false).await?,
    }))
}

async fn mob_drops(db: &PgPool, mob_id: i32) -> sqlx::Result<Vec<MobDrop>> {
    #[derive(FromRow)]
    struct Row {
        item_id: Option<i32>,
        in_catalog: bool,
        item_name: Option<String>,
        item_name_en: Option<String>,
        icon_url: Option<String>,
        typical: Option<i64>,
        lowest_ask: Option<i64>,
        drop_name: Option<String>,
        drop_name_en: Option<String>,
        gms_item_id: Option<i32>,
        meso_min: Option<i32>,
        meso_max: Option<i32>,
        votes: Option<f64>,
        quest_id: Option<i32>,
    }
    let rows: Vec<Row> = sqlx::query_as(concat!(
        "SELECT d.item_id, i.id IS NOT NULL AS in_catalog, NULLIF(i.name_zh, '') AS item_name,
                i.name_en AS item_name_en, i.icon_url, round(st.typical)::bigint AS typical,
                round(st.lowest_ask)::bigint AS lowest_ask, ",
        name!("d"),
        " AS drop_name, ",
        name_en!("d"),
        " AS drop_name_en, d.gms_item_id, d.meso_min, d.meso_max, d.upvotes::float8 AS votes, d.quest_id
         FROM drops d
         LEFT JOIN items i ON i.id = d.item_id
         LEFT JOIN item_stats st ON st.item_id = i.id
         WHERE d.mob_id = $1
         ORDER BY d.meso_max IS NULL, d.upvotes DESC NULLS LAST, d.ord"
    ))
    .bind(mob_id)
    .fetch_all(db)
    .await?;
    let mut drops: Vec<MobDrop> = rows
        .into_iter()
        .map(|r| {
            let what = match (r.in_catalog, r.item_id, r.meso_min.zip(r.meso_max)) {
                (true, Some(id), _) => DropTarget::Item {
                    id,
                    names: Names::new(
                        r.item_name.unwrap_or_default(),
                        r.item_name_en.unwrap_or_default(),
                    ),
                    icon_url: r.icon_url,
                    typical: r.typical,
                    lowest_ask: r.lowest_ask,
                },
                (_, None, Some((min, max))) if r.gms_item_id.is_none() => {
                    DropTarget::Meso { min, max }
                }
                (_, id, _) => DropTarget::Unlisted {
                    id: id.or(r.gms_item_id),
                    names: optional_names(r.drop_name, r.drop_name_en),
                },
            };
            MobDrop {
                what,
                votes: r.votes.map(|v| v.round() as i64),
                quest_id: r.quest_id,
            }
        })
        .collect();
    drops.dedup();
    // Mesos, then drops with a market price, then the rest; vote order inside each.
    drops.sort_by_key(|drop| drop_rank(&drop.what));
    Ok(drops)
}

/// Where a drop sits in the list: what a player can price comes first.
fn drop_rank(what: &DropTarget) -> u8 {
    match what {
        DropTarget::Meso { .. } => 0,
        DropTarget::Item {
            typical: Some(_), ..
        } => 1,
        DropTarget::Item {
            lowest_ask: Some(_),
            ..
        } => 2,
        DropTarget::Item { .. } => 3,
        DropTarget::Unlisted { .. } => 4,
    }
}

// ---------- map ----------

pub async fn map_page(db: &PgPool, id: i32) -> sqlx::Result<Option<MapPage>> {
    #[derive(FromRow)]
    struct Row {
        id: i32,
        #[sqlx(flatten)]
        names: Names,
        street: Option<String>,
        street_en: Option<String>,
        description: Option<String>,
        is_town: bool,
        mob_rate: Option<f32>,
        minimap_url: Option<String>,
        return_id: Option<i32>,
        return_name: Option<String>,
        return_name_en: Option<String>,
    }
    let Some(row) = sqlx::query_as::<_, Row>(concat!(
        "SELECT m.id, ",
        name!("m"),
        " AS name, ",
        name_en!("m"),
        " AS name_en, ",
        streets!("m"),
        ", m.description, m.is_town, m.mob_rate, m.minimap_url, r.id AS return_id, ",
        name!("r"),
        " AS return_name, ",
        name_en!("r"),
        " AS return_name_en
         FROM maps m LEFT JOIN maps r ON r.id = m.return_map_id AND NOT r.unreleased
         WHERE m.id = $1 AND NOT m.unreleased"
    ))
    .bind(id)
    .fetch_optional(db)
    .await?
    else {
        return Ok(None);
    };
    let mobs = sqlx::query_as::<_, MapMobRow>(concat!(
        "SELECT m.id, ",
        name!("m"),
        " AS name, ",
        name_en!("m"),
        " AS name_en, m.level, COALESCE(m.gms_id, l.gms_id) AS image_id, s.spawn_count
         FROM mob_spawns s JOIN mobs m ON m.id = s.mob_id LEFT JOIN mobs l ON l.id = m.link_id
         WHERE s.map_id = $1 AND ",
        public_mob!(),
        " ORDER BY m.level NULLS LAST, m.id"
    ))
    .bind(id)
    .fetch_all(db)
    .await?
    .into_iter()
    .map(|r| MapMob {
        mob: r.mob,
        spawn_count: r.spawn_count,
    })
    .collect();
    let npcs = sqlx::query_as::<_, (i32, Option<String>, Option<String>)>(concat!(
        "SELECT n.id, ",
        name!("n"),
        ", ",
        name_en!("n"),
        " FROM map_npcs mn JOIN npcs n ON n.id = mn.npc_id
         WHERE mn.map_id = $1 ORDER BY n.id"
    ))
    .bind(id)
    .fetch_all(db)
    .await?
    .into_iter()
    .map(|(id, zh, en)| NpcRef {
        id,
        names: optional_names(zh, en),
    })
    .collect();
    let return_map = row.return_id.map(|id| match row.return_name {
        Some(zh) => MapRef::new(id, zh, row.return_name_en.unwrap_or_default()),
        None => MapRef::unlisted(id),
    });
    Ok(Some(MapPage {
        map: MapDetail {
            id: row.id,
            names: row.names,
            street: optional_names(row.street, row.street_en),
            description: row.description,
            is_town: row.is_town,
            mob_rate: row.mob_rate,
            minimap_url: row.minimap_url,
        },
        return_map,
        mobs,
        npcs,
        exits: links(db, id, Direction::Out).await?,
        entrances: links(db, id, Direction::In).await?,
        view: map_view(db, id, Layers::ALL).await?,
        quests_given: quests_given_on(db, id).await?,
        quests_hunted: quests_hunted_on(db, id).await?,
        from_henesys: None,
        on_world_map: !world_spots_of(db, &[id]).await?.is_empty(),
    }))
}

// ---------- world map ----------

/// A shown spot: its main map is open.
#[derive(FromRow)]
struct SpotRow {
    key: String,
    region_id: String,
    x: i32,
    y: i32,
    kind: i16,
    #[sqlx(flatten)]
    map: MapRef,
    map_count: i64,
    level_min: Option<i16>,
    level_max: Option<i16>,
}

pub async fn world_page(db: &PgPool, here: Option<i32>) -> sqlx::Result<WorldPage> {
    let regions: Vec<(String, String, i32, i32)> =
        sqlx::query_as("SELECT id, image_url, width, height FROM world_regions ORDER BY ord, id")
            .fetch_all(db)
            .await?;
    let spots: Vec<SpotRow> = sqlx::query_as(&format!(
        "SELECT s.key, s.region_id, s.x, s.y, s.kind, mp.id, {name} AS name, {name_en} AS name_en,
                (SELECT count(*) FROM world_spot_maps w JOIN maps o ON o.id = w.map_id AND NOT o.unreleased
                 WHERE w.spot_key = s.key) AS map_count,
                l.level_min, l.level_max
         FROM world_spots s JOIN maps mp ON mp.id = s.map_id AND NOT mp.unreleased
         LEFT JOIN LATERAL (
             SELECT min(m.level) AS level_min, max(m.level) AS level_max
             FROM world_spot_maps w JOIN maps o ON o.id = w.map_id AND NOT o.unreleased
             JOIN mob_spawns sp ON sp.map_id = w.map_id JOIN mobs m ON m.id = sp.mob_id
             WHERE w.spot_key = s.key AND {public}) l ON true
         ORDER BY s.region_id, s.ord",
        name = name!("mp"),
        name_en = name_en!("mp"),
        public = public_mob!(),
    ))
    .fetch_all(db)
    .await?;
    let mut out: Vec<WorldRegion> = regions
        .into_iter()
        .map(|(id, image_url, width, height)| WorldRegion {
            names: region_names(&id),
            id,
            image_url,
            width,
            height,
            spots: Vec::new(),
        })
        .collect();
    for spot in spots {
        if let Some(region) = out.iter_mut().find(|r| r.id == spot.region_id) {
            region.spots.push(WorldSpot {
                key: spot.key,
                x: spot.x,
                y: spot.y,
                kind: spot.kind,
                map: spot.map,
                map_count: spot.map_count,
                level_min: spot.level_min,
                level_max: spot.level_max,
            });
        }
    }
    // Regions with nothing open (Ossyria) are not shown.
    out.retain(|r| !r.spots.is_empty());
    let (here, here_spots) = match here {
        Some(id) => {
            let spots: Vec<String> = world_spots_of(db, &[id])
                .await?
                .into_iter()
                .map(|s| s.key)
                .collect();
            let refs = map_refs(db, &[id]).await?;
            (refs.get(&id).cloned().filter(|_| !spots.is_empty()), spots)
        }
        None => (None, Vec::new()),
    };
    Ok(WorldPage {
        regions: out,
        here,
        here_spots,
    })
}

/// A map's place on the world map.
#[derive(Debug, Clone, FromRow)]
pub struct MapSpot {
    pub map_id: i32,
    pub key: String,
    pub region_id: String,
    pub x: i32,
    pub y: i32,
}

/// The shown spots covering each of `map_ids` (a map can be on two).
pub async fn world_spots_of(db: &PgPool, map_ids: &[i32]) -> sqlx::Result<Vec<MapSpot>> {
    sqlx::query_as(
        "SELECT w.map_id, s.key, s.region_id, s.x, s.y
         FROM world_spot_maps w JOIN world_spots s ON s.key = w.spot_key
         JOIN maps mp ON mp.id = s.map_id AND NOT mp.unreleased
         WHERE w.map_id = ANY($1) ORDER BY w.map_id, s.key",
    )
    .bind(map_ids)
    .fetch_all(db)
    .await
}

/// The route's maps in order (start first) over the world map: each map's
/// spot, consecutive repeats merged, split where the route changes region.
/// `None` when fewer than two spots are passed.
pub async fn route_overview(db: &PgPool, path: &[MapRef]) -> sqlx::Result<Option<RouteOverview>> {
    let ids: Vec<i32> = path.iter().map(|m| m.id).collect();
    let spots = world_spots_of(db, &ids).await?;
    let regions: Vec<(String, String, i32, i32)> =
        sqlx::query_as("SELECT id, image_url, width, height FROM world_regions")
            .fetch_all(db)
            .await?;
    let mut out: Vec<OverviewRegion> = Vec::new();
    let mut last_key: Option<String> = None;
    for map in path {
        // Stay on the current region when the map is on two.
        let mine: Vec<&MapSpot> = spots.iter().filter(|s| s.map_id == map.id).collect();
        let current = out.last().map(|r| r.id.clone());
        let Some(spot) = mine
            .iter()
            .find(|s| Some(&s.region_id) == current.as_ref())
            .or(mine.first())
        else {
            continue; // not on the world map (a hidden street, an instance)
        };
        if last_key.as_deref() == Some(spot.key.as_str()) {
            continue;
        }
        last_key = Some(spot.key.clone());
        let stop = OverviewStop {
            x: spot.x,
            y: spot.y,
            map: map.clone(),
        };
        match out.last_mut() {
            Some(region) if region.id == spot.region_id => region.stops.push(stop),
            _ => {
                let Some((id, image_url, width, height)) =
                    regions.iter().find(|r| r.0 == spot.region_id).cloned()
                else {
                    continue;
                };
                out.push(OverviewRegion {
                    names: region_names(&id),
                    id,
                    image_url,
                    width,
                    height,
                    stops: vec![stop],
                });
            }
        }
    }
    let stops: usize = out.iter().map(|r| r.stops.len()).sum();
    Ok((stops >= 2).then_some(RouteOverview { regions: out }))
}

// ---------- monster finder ----------

pub enum MobResolution {
    One(MobRef),
    /// Zero or several candidates.
    Many(Vec<MobRef>),
}

/// Mob id, exact name (either language), or a unique name fragment. Only
/// shown monsters; ones that spawn on an open map come first.
pub async fn resolve_mob(db: &PgPool, input: &str) -> sqlx::Result<MobResolution> {
    let input = input.trim();
    let select = |filter: &str| {
        format!(
            "SELECT m.id, {name} AS name, {name_en} AS name_en, m.level,
                    COALESCE(m.gms_id, l.gms_id) AS image_id
             FROM mobs m LEFT JOIN mobs l ON l.id = m.link_id
             WHERE ({filter}) AND {public}
             ORDER BY NOT EXISTS (SELECT 1 FROM mob_spawns sp JOIN maps mp ON mp.id = sp.map_id
                                  WHERE sp.mob_id = m.id AND NOT mp.unreleased),
                      m.level NULLS LAST, m.id
             LIMIT 12",
            name = name!("m"),
            name_en = name_en!("m"),
            public = public_mob!(),
        )
    };
    if let Ok(id) = input.parse::<i32>() {
        let found: Vec<MobRef> = sqlx::query_as(&select("m.id = $1"))
            .bind(id)
            .fetch_all(db)
            .await?;
        if let [one] = found.as_slice() {
            return Ok(MobResolution::One(one.clone()));
        }
    }
    let exact: Vec<MobRef> = sqlx::query_as(&select(
        "lower(m.name_en) = lower($1) OR m.name_zh = $1 OR m.name_tw = $1",
    ))
    .bind(input)
    .fetch_all(db)
    .await?;
    if let Some(first) = exact.first() {
        // Party-quest copies share a name; the one on an open map comes first.
        return Ok(MobResolution::One(first.clone()));
    }
    let escaped = input
        .replace('\\', "\\\\")
        .replace('%', "\\%")
        .replace('_', "\\_");
    let fuzzy: Vec<MobRef> = sqlx::query_as(&select(
        "m.name_en ILIKE $1 OR m.name_zh LIKE $1 OR m.name_tw LIKE $1",
    ))
    .bind(format!("%{escaped}%"))
    .fetch_all(db)
    .await?;
    Ok(match fuzzy.as_slice() {
        [one] => MobResolution::One(one.clone()),
        _ => MobResolution::Many(fuzzy),
    })
}

/// Open maps a monster spawns on, with its spawn points there.
pub async fn mob_spawn_maps(db: &PgPool, mob_id: i32) -> sqlx::Result<Vec<(MapRef, i16)>> {
    #[derive(FromRow)]
    struct Row {
        #[sqlx(flatten)]
        map: MapRef,
        spawn_count: i16,
    }
    let rows: Vec<Row> = sqlx::query_as(concat!(
        "SELECT mp.id, ",
        name!("mp"),
        " AS name, ",
        name_en!("mp"),
        " AS name_en, s.spawn_count FROM mob_spawns s JOIN maps mp ON mp.id = s.map_id
         WHERE s.mob_id = $1 AND NOT mp.unreleased ORDER BY mp.id"
    ))
    .bind(mob_id)
    .fetch_all(db)
    .await?;
    Ok(rows.into_iter().map(|r| (r.map, r.spawn_count)).collect())
}

/// Quests the NPCs on a map give.
async fn quests_given_on(db: &PgPool, map_id: i32) -> sqlx::Result<Vec<QuestRef>> {
    let rows: Vec<QuestColumns> = sqlx::query_as(&format!(
        "SELECT {QUEST_COLUMNS} FROM quests q JOIN npcs n ON n.id = q.npc_id
         WHERE q.npc_id IN (SELECT npc_id FROM map_npcs WHERE map_id = $1) AND {visible}
         ORDER BY q.level_min NULLS FIRST, q.id LIMIT {QUESTS_SHOWN}",
        visible = visible_quest!()
    ))
    .bind(map_id)
    .fetch_all(db)
    .await?;
    Ok(rows.into_iter().map(QuestColumns::quest).collect())
}

/// Quests that ask to defeat a monster spawning on the map.
async fn quests_hunted_on(db: &PgPool, map_id: i32) -> sqlx::Result<Vec<QuestHunt>> {
    #[derive(FromRow)]
    struct Row {
        #[sqlx(flatten)]
        quest: QuestColumns,
        #[sqlx(flatten)]
        mob: MobRef,
        quantity: i64,
    }
    let rows: Vec<Row> = sqlx::query_as(&format!(
        "SELECT {QUEST_COLUMNS}, m.id, {mob_name} AS name, {mob_name_en} AS name_en, m.level,
                COALESCE(m.gms_id, l.gms_id) AS image_id, sum(x.quantity) AS quantity
         FROM quest_needs x JOIN quests q ON q.id = x.quest_id LEFT JOIN npcs n ON n.id = q.npc_id
         JOIN mobs m ON m.id = x.mob_id LEFT JOIN mobs l ON l.id = m.link_id
         WHERE x.mob_id IN (SELECT mob_id FROM mob_spawns WHERE map_id = $1) AND {visible} AND {public}
         GROUP BY q.id, n.id, m.id, l.gms_id
         ORDER BY q.level_min NULLS FIRST, q.id, m.id LIMIT {QUESTS_SHOWN}",
        mob_name = name!("m"),
        mob_name_en = name_en!("m"),
        visible = visible_quest!(),
        public = public_mob!(),
    ))
    .bind(map_id)
    .fetch_all(db)
    .await?;
    Ok(rows
        .into_iter()
        .map(|r| QuestHunt {
            quest: r.quest.quest(),
            mob: r.mob,
            quantity: i32::try_from(r.quantity).unwrap_or(i32::MAX),
        })
        .collect())
}

// ---------- map view ----------

const ICON_PX: f64 = 24.0;

/// What `map_view` loads besides the box and the portals, and the CSS-pixel
/// box it is sized to fit at full width (markers follow the scale).
#[derive(Debug, Clone, Copy)]
pub struct Layers {
    pub spawns: bool,
    pub npcs: bool,
    pub fit: (f64, f64),
    /// Icon size in CSS pixels.
    pub icon_px: f64,
}

impl Layers {
    /// The map page.
    pub const ALL: Self = Self {
        spawns: true,
        npcs: true,
        fit: (880.0, 520.0),
        icon_px: ICON_PX,
    };
    /// A route step: small, portals only.
    pub const PORTALS: Self = Self {
        spawns: false,
        npcs: false,
        fit: (560.0, 220.0),
        icon_px: 20.0,
    };
    /// A ship or taxi step: small, with the NPCs.
    pub const STEP_NPCS: Self = Self {
        spawns: false,
        npcs: true,
        fit: (560.0, 220.0),
        icon_px: 20.0,
    };
    /// Where an NPC stands.
    pub const NPCS: Self = Self {
        spawns: false,
        npcs: true,
        fit: (560.0, 260.0),
        icon_px: 20.0,
    };
}

/// Screen size and icon size (in box units) for a `w` x `h` box.
pub fn view_size(w: i32, h: i32, layers: Layers) -> (i32, i32, i32) {
    let (wf, hf) = (f64::from(w.max(1)), f64::from(h.max(1)));
    let scale = (layers.fit.0 / wf).min(layers.fit.1 / hf).min(1.5);
    let shown = |v: f64| (v * scale).round().max(1.0) as i32;
    (
        shown(wf),
        shown(hf),
        (layers.icon_px / scale).round().max(1.0) as i32,
    )
}

/// World point to box point, `None` when it falls well outside the box.
fn in_box(x: i32, y: i32, cx: i32, cy: i32, w: i32, h: i32, margin: i32) -> Option<Point> {
    let (bx, by) = (x + cx, y + cy);
    let inside = |v: i32, max: i32| (-margin..=max + margin).contains(&v);
    (inside(bx, w) && inside(by, h)).then(|| Point {
        x: bx.clamp(0, w),
        y: by.clamp(0, h),
    })
}

/// The map's minimap with the chosen layers, `None` when NiaDB gives no box.
pub async fn map_view(db: &PgPool, map_id: i32, layers: Layers) -> sqlx::Result<Option<MapView>> {
    #[derive(FromRow)]
    struct Box {
        minimap_w: i32,
        minimap_h: i32,
        minimap_cx: i32,
        minimap_cy: i32,
        minimap_url: Option<String>,
        spawn_x: Option<i32>,
        spawn_y: Option<i32>,
        scene_url: Option<String>,
        scene_x: Option<i32>,
        scene_y: Option<i32>,
        scene_w: Option<i32>,
        scene_h: Option<i32>,
    }
    let row: Option<Box> = sqlx::query_as(
        "SELECT minimap_w, minimap_h, minimap_cx, minimap_cy, minimap_url, spawn_x, spawn_y,
                scene_url, scene_x, scene_y, scene_w, scene_h
         FROM maps WHERE id = $1 AND NOT unreleased AND minimap_w IS NOT NULL
           AND minimap_h IS NOT NULL AND minimap_cx IS NOT NULL AND minimap_cy IS NOT NULL",
    )
    .bind(map_id)
    .fetch_optional(db)
    .await?;
    let Some(row) = row else {
        return Ok(None);
    };
    let (w, h, cx, cy) = (row.minimap_w, row.minimap_h, row.minimap_cx, row.minimap_cy);
    let (image_url, spawn_x, spawn_y) = (row.minimap_url, row.spawn_x, row.spawn_y);
    let scene = match (
        row.scene_url,
        row.scene_x,
        row.scene_y,
        row.scene_w,
        row.scene_h,
    ) {
        (Some(url), Some(x), Some(y), Some(width), Some(height)) => Some(SceneImage {
            url,
            x: x + cx,
            y: y + cy,
            width,
            height,
        }),
        _ => None,
    };
    let (shown_width, shown_height, icon) = view_size(w, h, layers);
    let place = |x: i32, y: i32| in_box(x, y, cx, cy, w, h, icon);
    let mut spawns = Vec::new();
    if layers.spawns {
        let rows: Vec<(i32, i32, i32, i32)> = sqlx::query_as(concat!(
            "SELECT p.mob_id, p.x, p.y, p.mob_time FROM map_spawn_points p JOIN mobs m ON m.id = p.mob_id
             WHERE p.map_id = $1 AND ",
            public_mob!(),
            " ORDER BY p.ord"
        ))
        .bind(map_id)
        .fetch_all(db)
        .await?;
        for (mob_id, x, y, mob_time) in rows {
            if let Some(p) = place(x, y) {
                spawns.push(SpawnPoint {
                    mob_id,
                    x: p.x,
                    y: p.y,
                    mob_time,
                });
            }
        }
    }
    #[allow(clippy::type_complexity)]
    let rows: Vec<(
        i32,
        i32,
        i32,
        Option<String>,
        Option<String>,
        Option<String>,
        Option<i16>,
    )> = sqlx::query_as(concat!(
        "SELECT p.x, p.y, p.to_map_id, ",
        name!("m"),
        ", ",
        name_en!("m"),
        ", p.portal_name, p.portal_type FROM map_portals p JOIN maps m ON m.id = p.to_map_id
             WHERE p.from_map_id = $1 AND p.kind = 'portal' AND p.x IS NOT NULL AND p.y IS NOT NULL
               AND NOT m.unreleased
             ORDER BY p.id"
    ))
    .bind(map_id)
    .fetch_all(db)
    .await?;
    let mut portals: Vec<PortalPoint> = Vec::new();
    for (x, y, to, zh, en, name, portal_type) in rows {
        let Some(p) = place(x, y) else { continue };
        if portals
            .iter()
            .any(|q| q.to.id == to && (q.x, q.y) == (p.x, p.y))
        {
            continue;
        }
        portals.push(PortalPoint {
            x: p.x,
            y: p.y,
            to: MapRef::new(to, zh.unwrap_or_default(), en.unwrap_or_default()),
            name,
            portal_type,
        });
    }
    let mut npcs = Vec::new();
    if layers.npcs {
        #[allow(clippy::type_complexity)]
        let rows: Vec<(i32, Option<String>, Option<String>, i32, i32)> = sqlx::query_as(concat!(
            "SELECT n.id, ",
            name!("n"),
            ", ",
            name_en!("n"),
            ", mn.x, mn.y FROM map_npcs mn JOIN npcs n ON n.id = mn.npc_id
             WHERE mn.map_id = $1 AND mn.x IS NOT NULL AND mn.y IS NOT NULL AND NOT n.unreleased
             ORDER BY n.id"
        ))
        .bind(map_id)
        .fetch_all(db)
        .await?;
        for (id, zh, en, x, y) in rows {
            if let Some(p) = place(x, y) {
                npcs.push(NpcPoint {
                    npc: NpcRef {
                        id,
                        names: optional_names(zh, en),
                    },
                    x: p.x,
                    y: p.y,
                });
            }
        }
    }
    Ok(Some(MapView {
        width: w,
        height: h,
        shown_width,
        shown_height,
        icon,
        image_url,
        scene,
        spawns,
        portals,
        npcs,
        player_spawn: spawn_x.zip(spawn_y).and_then(|(x, y)| place(x, y)),
    }))
}

// ---------- NPC ----------

pub async fn npc_page(db: &PgPool, id: i32) -> sqlx::Result<Option<NpcPage>> {
    let row: Option<(i32, Option<String>, Option<String>)> = sqlx::query_as(concat!(
        "SELECT n.id, ",
        name!("n"),
        ", ",
        name_en!("n"),
        " FROM npcs n WHERE n.id = $1 AND NOT n.unreleased"
    ))
    .bind(id)
    .fetch_optional(db)
    .await?;
    let Some((id, zh, en)) = row else {
        return Ok(None);
    };
    let maps: Vec<MapRef> = sqlx::query_as(concat!(
        "SELECT m.id, ",
        name!("m"),
        " AS name, ",
        name_en!("m"),
        " AS name_en FROM map_npcs mn JOIN maps m ON m.id = mn.map_id
         WHERE mn.npc_id = $1 AND NOT m.unreleased ORDER BY m.id"
    ))
    .bind(id)
    .fetch_all(db)
    .await?;
    let mut places = Vec::with_capacity(maps.len());
    for map in maps {
        let view = map_view(db, map.id, Layers::NPCS).await?;
        places.push(NpcPlace { map, view });
    }
    let quests: Vec<QuestColumns> = sqlx::query_as(&format!(
        "SELECT {QUEST_COLUMNS} FROM quests q JOIN npcs n ON n.id = q.npc_id
         WHERE q.npc_id = $1 AND {visible}
         ORDER BY q.level_min NULLS FIRST, q.id LIMIT {QUESTS_SHOWN}",
        visible = visible_quest!()
    ))
    .bind(id)
    .fetch_all(db)
    .await?;
    let shop: Vec<NpcShopItem> = sqlx::query_as(concat!(
        "SELECT i.id, ",
        name!("i"),
        " AS name, ",
        name_en!("i"),
        " AS name_en, i.icon_url, s.price
         FROM npc_shops s JOIN items i ON i.id = s.item_id
         WHERE s.npc_id = $1 ORDER BY i.category, s.price, i.id"
    ))
    .bind(id)
    .fetch_all(db)
    .await?;
    Ok(Some(NpcPage {
        npc: NpcRef {
            id,
            names: optional_names(zh, en),
        },
        places,
        quests: quests.into_iter().map(QuestColumns::quest).collect(),
        shop,
    }))
}

#[derive(FromRow)]
struct MapMobRow {
    #[sqlx(flatten)]
    mob: MobRef,
    spawn_count: i16,
}

enum Direction {
    Out,
    In,
}

/// Edges leaving or entering a map, one per (other map, kind).
async fn links(db: &PgPool, map_id: i32, direction: Direction) -> sqlx::Result<Vec<Link>> {
    let sql = match direction {
        Direction::Out => concat!(
            "SELECT p.to_map_id, ",
            name!("m"),
            ", ",
            name_en!("m"),
            ", p.kind, p.portal_name FROM map_portals p LEFT JOIN maps m ON m.id = p.to_map_id
             WHERE p.from_map_id = $1 AND m.unreleased IS NOT TRUE
             ORDER BY p.kind, p.to_map_id, p.portal_name"
        ),
        Direction::In => concat!(
            "SELECT p.from_map_id, ",
            name!("m"),
            ", ",
            name_en!("m"),
            ", p.kind, p.portal_name FROM map_portals p LEFT JOIN maps m ON m.id = p.from_map_id
             WHERE p.to_map_id = $1 AND m.unreleased IS NOT TRUE
             ORDER BY p.kind, p.from_map_id, p.portal_name"
        ),
    };
    #[allow(clippy::type_complexity)]
    let rows: Vec<(i32, Option<String>, Option<String>, String, Option<String>)> =
        sqlx::query_as(sql).bind(map_id).fetch_all(db).await?;
    let mut out: Vec<Link> = Vec::new();
    for (other, zh, en, kind, portal_name) in rows {
        let Some(kind) = EdgeKind::parse(&kind) else {
            continue;
        };
        if out.iter().any(|l| l.other.id == other && l.kind == kind) {
            continue;
        }
        out.push(Link {
            other: match zh {
                Some(zh) => MapRef::new(other, zh, en.unwrap_or_default()),
                None => MapRef::unlisted(other),
            },
            kind,
            portal_name,
        });
    }
    Ok(out)
}

// ---------- route ----------

pub async fn load_edges(db: &PgPool) -> sqlx::Result<Vec<Edge>> {
    let rows: Vec<(i32, i32, String, Option<String>)> = sqlx::query_as(
        "SELECT p.from_map_id, p.to_map_id, p.kind, p.portal_name FROM map_portals p
         WHERE NOT EXISTS (SELECT 1 FROM maps m WHERE m.id IN (p.from_map_id, p.to_map_id) AND m.unreleased)
         ORDER BY p.id",
    )
    .fetch_all(db)
    .await?;
    Ok(rows
        .into_iter()
        .filter_map(|(from, to, kind, portal_name)| {
            Some(Edge {
                from,
                to,
                kind: EdgeKind::parse(&kind)?,
                portal_name,
            })
        })
        .collect())
}

/// Display names for map ids; ids not in `maps` get a placeholder.
pub async fn map_refs(db: &PgPool, ids: &[i32]) -> sqlx::Result<HashMap<i32, MapRef>> {
    let rows: Vec<MapRef> = sqlx::query_as(concat!(
        "SELECT m.id, ",
        name!("m"),
        " AS name, ",
        name_en!("m"),
        " AS name_en FROM maps m WHERE m.id = ANY($1) AND NOT m.unreleased"
    ))
    .bind(ids)
    .fetch_all(db)
    .await?;
    let mut out: HashMap<i32, MapRef> = rows.into_iter().map(|m| (m.id, m)).collect();
    for &id in ids {
        out.entry(id).or_insert_with(|| MapRef::unlisted(id));
    }
    Ok(out)
}

pub enum Resolution {
    One(MapRef),
    /// Zero or several candidates.
    Many(Vec<MapRef>),
}

/// Map id, exact name (any language), or a unique name fragment.
pub async fn resolve_map(db: &PgPool, input: &str) -> sqlx::Result<Resolution> {
    let input = input.trim();
    if let Ok(id) = input.parse::<i32>() {
        let known: bool = sqlx::query_scalar(
            "SELECT EXISTS (SELECT 1 FROM maps WHERE id = $1 AND NOT unreleased)
                 OR (NOT EXISTS (SELECT 1 FROM maps WHERE id = $1)
                     AND EXISTS (SELECT 1 FROM map_portals WHERE from_map_id = $1 OR to_map_id = $1))",
        )
        .bind(id)
        .fetch_one(db)
        .await?;
        if !known {
            return Ok(Resolution::Many(Vec::new()));
        }
        let mut refs = map_refs(db, &[id]).await?;
        return Ok(Resolution::One(
            refs.remove(&id).unwrap_or_else(|| MapRef::unlisted(id)),
        ));
    }
    let exact: Vec<MapRef> = sqlx::query_as(concat!(
        "SELECT m.id, ",
        name!("m"),
        " AS name, ",
        name_en!("m"),
        " AS name_en FROM maps m
         WHERE (lower(m.name_zh) = lower($1) OR lower(m.name_tw) = lower($1) OR lower(m.name_en) = lower($1))
           AND NOT m.unreleased
         ORDER BY m.id LIMIT 8"
    ))
    .bind(input)
    .fetch_all(db)
    .await?;
    let candidates = if exact.is_empty() {
        search_maps(db, input, 8, 0)
            .await?
            .rows
            .into_iter()
            .map(|m| MapRef {
                id: m.id,
                names: m.names,
            })
            .collect()
    } else {
        exact
    };
    Ok(match <[MapRef; 1]>::try_from(candidates) {
        Ok([one]) => Resolution::One(one),
        Err(many) => Resolution::Many(many),
    })
}

// ---------- search ----------

pub const SEARCH_LIMIT: i64 = 20;
/// With `?kind=` one group gets the room of three.
pub const SEARCH_KIND_LIMIT: i64 = 60;

pub async fn search(
    db: &PgPool,
    query: &str,
    kind: Option<SearchKind>,
) -> sqlx::Result<SearchPage> {
    search_at(db, query, kind, 0).await
}

pub async fn search_at(
    db: &PgPool,
    query: &str,
    kind: Option<SearchKind>,
    offset: i64,
) -> sqlx::Result<SearchPage> {
    search_filtered(db, query, kind, offset, ItemFilters::default()).await
}

pub async fn search_filtered(
    db: &PgPool,
    query: &str,
    kind: Option<SearchKind>,
    offset: i64,
    filters: ItemFilters,
) -> sqlx::Result<SearchPage> {
    let request = SearchRequest {
        query: query.to_string(),
        kind,
        offset,
        items: filters,
        ..Default::default()
    };
    search_page(db, &request).await
}

/// The regions and areas `/search` offers: static game data, which the
/// server caches per catalogue import (`catalog_cache`).
pub async fn search_areas(db: &PgPool) -> sqlx::Result<Vec<AreaChoice>> {
    let region_expr = super::regions::region_sql("m");
    let area_expr = super::regions::area_sql("m");
    sqlx::query_as(&format!(
        "SELECT {region_expr} AS region, {area_expr} AS key,
         COALESCE(max(NULLIF(m.street_zh,'')),max(m.street_en)) AS name,
         COALESCE(max(NULLIF(m.street_en,'')),max(m.street_zh)) AS name_en
         FROM maps m WHERE {area_expr}<>'' AND NOT m.unreleased GROUP BY 1,2 ORDER BY region,key"
    ))
    .fetch_all(db)
    .await
}

/// One page of `/search`. The filters are used as given (`http` normalizes
/// them); region and area are checked against the area list here.
pub async fn search_page(db: &PgPool, request: &SearchRequest) -> sqlx::Result<SearchPage> {
    let areas = search_areas(db).await?;
    search_page_in(db, request, areas).await
}

/// `search_page` with the area list already read.
pub async fn search_page_in(
    db: &PgPool,
    request: &SearchRequest,
    areas: Vec<AreaChoice>,
) -> sqlx::Result<SearchPage> {
    let region = super::regions::normalize(&request.region);
    let area = if !region.is_empty()
        && areas
            .iter()
            .any(|a| a.key == request.area && a.region == region)
    {
        request.area.clone()
    } else {
        String::new()
    };
    let kind = request.kind;
    let limit = |k: SearchKind| match kind {
        None => Some(SEARCH_LIMIT),
        Some(only) if only == k => Some(SEARCH_KIND_LIMIT),
        Some(_) => None,
    };
    let text = Text::new(&request.query);
    let offset = request.offset;
    let mut page = SearchPage {
        region: region.clone(),
        area: area.clone(),
        areas,
        filters: request.items.clone(),
        mob_filters: request.mobs.clone(),
        town: request.town,
        query: request.query.clone(),
        offset,
        page_size: if kind.is_some() {
            SEARCH_KIND_LIMIT
        } else {
            SEARCH_LIMIT
        },
        kind,
        ..Default::default()
    };
    if let Some(n) = limit(SearchKind::Item) {
        page.items = search_items(db, &text, n, offset, &request.items).await?;
        if kind == Some(SearchKind::Item) {
            page.facets = Some(item_facets(db, &text, &request.items).await?);
        }
    }
    if let Some(n) = limit(SearchKind::Mob) {
        page.mobs = search_mobs(db, &text, n, offset, &request.mobs, &region, &area).await?;
    }
    if let Some(n) = limit(SearchKind::Map) {
        page.maps =
            search_maps_in_region(db, &text, n, offset, request.town, &region, &area).await?;
    }
    Ok(page)
}

/// The search text as bound: `$1` raw, `$2` prefix and `$3` substring LIKE
/// patterns, `$4` keyword patterns (see `matcher`).
struct Text {
    raw: String,
    prefix: String,
    substring: String,
    patterns: Vec<String>,
}

impl Text {
    fn new(query: &str) -> Self {
        let escaped = like_escape(query);
        Self {
            raw: query.to_string(),
            prefix: format!("{escaped}%"),
            substring: format!("%{escaped}%"),
            patterns: crate::search::patterns(query),
        }
    }

    fn bind<'q, O>(&self, query: PgQueryAs<'q, O>) -> PgQueryAs<'q, O> {
        query
            .bind(self.raw.clone())
            .bind(self.prefix.clone())
            .bind(self.substring.clone())
            .bind(self.patterns.clone())
    }
}

type PgQueryAs<'q, O> = sqlx::query::QueryAs<'q, sqlx::Postgres, O, sqlx::postgres::PgArguments>;

/// SQL fragments matching `$1` (raw query), `$2` (prefix pattern) and `$3`
/// (substring pattern) against name columns. Inputs are constants.
fn matcher(id: &str, columns: &[&str], patterns: &str) -> (String, String) {
    let any = |op: &dyn Fn(&str) -> String| {
        columns
            .iter()
            .map(|c| op(c))
            .collect::<Vec<_>>()
            .join(" OR ")
    };
    let filter = format!(
        "({} OR {id}::text = $1 OR {})",
        any(&|c| format!("{c} ILIKE $3")),
        crate::search::filter_sql(id, columns, patterns),
    );
    let rank = format!(
        "CASE WHEN {id}::text = $1 OR {} THEN 0 WHEN {} THEN 1 ELSE 2 END",
        any(&|c| format!("lower({c}) = lower($1)")),
        any(&|c| format!("{c} ILIKE $2")),
    );
    (filter, rank)
}

/// `\`, `%` and `_` are LIKE metacharacters (backslash is the default escape).
fn like_escape(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for c in text.chars() {
        if matches!(c, '\\' | '%' | '_') {
            out.push('\\');
        }
        out.push(c);
    }
    out
}

/// One page of rows and the count of every match, run together.
async fn page_of<T>(
    db: &PgPool,
    rows: PgQueryAs<'_, T>,
    count: PgQueryAs<'_, (i64,)>,
    offset: i64,
) -> sqlx::Result<Hits<T>>
where
    T: for<'r> FromRow<'r, sqlx::postgres::PgRow> + Send + Unpin,
{
    let (rows, (total,)) = tokio::try_join!(rows.fetch_all(db), count.fetch_one(db))?;
    Ok(Hits {
        more: offset + (rows.len() as i64) < total,
        rows,
        total,
    })
}

/// `$5` category code.
const ITEM_CATEGORY: &str = "($5=0 OR ($5=5 AND (i.is_cash OR i.id/1000000=5))
    OR ($5 BETWEEN 1 AND 4 AND i.id/1000000=$5 AND NOT i.is_cash))";
/// `$6` job bit, `$7` keep gear for every job (mask 0 or NULL), `$8`/`$9`
/// required level range.
const ITEM_JOB_LEVEL: &str = "($6::smallint=0 OR (COALESCE(i.req_job_mask,0) & $6::smallint)>0
      OR ($7 AND COALESCE(i.req_job_mask,0)=0))
    AND ($7 OR COALESCE(i.req_job_mask,0)<>0)
    AND ($8::smallint IS NULL OR i.req_level >= $8) AND ($9::smallint IS NULL OR i.req_level <= $9)";
/// `$10` equipment subcategory, `$11` weapon id prefix, `$12` use-item type
/// (the prefixes of `model::use_type`).
const ITEM_TYPE: &str = "($10='' OR i.subcategory=$10) AND ($11=0 OR i.id/10000=$11)
    AND ($12='' OR CASE $12 WHEN 'potion' THEN i.id/10000 BETWEEN 200 AND 202
      WHEN 'return' THEN i.id/10000=203 WHEN 'scroll' THEN i.id/10000=204
      WHEN 'arrow' THEN i.id/10000=206 WHEN 'star' THEN i.id/10000=207
      ELSE i.id/10000 NOT IN (200, 201, 202, 203, 204, 206, 207) END)";

fn category_code(cat: &str) -> i32 {
    match cat {
        "equip" => 1,
        "use" => 2,
        "setup" => 3,
        "etc" => 4,
        "cash" => 5,
        _ => 0,
    }
}

/// Binds `$5`-`$12`.
fn bind_item_filters<'q, O>(query: PgQueryAs<'q, O>, filters: &ItemFilters) -> PgQueryAs<'q, O> {
    query
        .bind(category_code(&filters.cat))
        .bind(filters.job_bit())
        .bind(filters.shared)
        .bind(filters.lmin)
        .bind(filters.lmax)
        .bind(filters.subcategory())
        .bind(filters.weapon.unwrap_or(0))
        .bind(filters.use_type.clone())
}

async fn search_items(
    db: &PgPool,
    text: &Text,
    limit: i64,
    offset: i64,
    filters: &ItemFilters,
) -> sqlx::Result<Hits<ItemHit>> {
    let (filter, rank) = matcher("i.id", &["i.name_zh", "i.name_en"], "$4");
    let condition = format!("{filter} AND {ITEM_CATEGORY} AND {ITEM_JOB_LEVEL} AND {ITEM_TYPE}");
    // A blank search browses the catalogue: traded items first (most sales, then
    // most listings), so the first page is not skins and faces in id order.
    let order = match filters.sort.as_str() {
        "level" => format!("i.req_level NULLS LAST, {rank}, -COALESCE(st.sales_24h, 0), i.id"),
        "level_desc" => {
            format!("i.req_level DESC NULLS LAST, {rank}, -COALESCE(st.sales_24h, 0), i.id")
        }
        "name" => "COALESCE(NULLIF(i.name_zh, ''), i.name_en), i.id".to_string(),
        _ => format!(
            "CASE WHEN $1='' THEN 0 ELSE {rank} END,
           CASE WHEN $1='' THEN -COALESCE(st.sales_24h, 0) ELSE 0 END,
           CASE WHEN $1='' THEN -COALESCE(st.listings_count, 0) ELSE 0 END,
           CASE WHEN $1='' THEN i.id ELSE 0 END, length(COALESCE(i.name_zh, i.name_en)), i.id"
        ),
    };
    let rows_sql = format!(
        "SELECT i.id, COALESCE(NULLIF(i.name_zh, ''), i.name_en) AS name, i.name_en, i.icon_url, i.subcategory, i.req_level AS level
         FROM items i LEFT JOIN item_stats st ON st.item_id = i.id WHERE {condition}
         ORDER BY {order} LIMIT $13 OFFSET $14"
    );
    let count_sql = format!("SELECT count(*) FROM items i WHERE {condition}");
    let rows = bind_item_filters(text.bind(sqlx::query_as(&rows_sql)), filters)
        .bind(limit)
        .bind(offset);
    let count = bind_item_filters(text.bind(sqlx::query_as(&count_sql)), filters);
    page_of(db, rows, count, offset).await
}

/// Category counts under the query alone; type and weapon counts under the
/// job, all-class and level filters too, so the dialog offers only types
/// that have items. The selected values stay listed with a count of 0.
async fn item_facets(db: &PgPool, text: &Text, filters: &ItemFilters) -> sqlx::Result<ItemFacets> {
    let (filter, _) = matcher("i.id", &["i.name_zh", "i.name_en"], "$4");
    let categories_sql = format!(
        "SELECT count(*), count(*) FILTER (WHERE i.id/1000000=1 AND NOT i.is_cash),
           count(*) FILTER (WHERE i.id/1000000=2 AND NOT i.is_cash),
           count(*) FILTER (WHERE i.id/1000000=3 AND NOT i.is_cash),
           count(*) FILTER (WHERE i.id/1000000=4 AND NOT i.is_cash),
           count(*) FILTER (WHERE i.is_cash OR i.id/1000000=5)
         FROM items i WHERE {filter}"
    );
    let groups_sql = format!(
        "SELECT i.id/10000 AS prefix, COALESCE(i.subcategory, '') AS sub, count(*) AS n
         FROM items i WHERE {filter} AND NOT i.is_cash
           AND ((i.id/1000000=1 AND {ITEM_JOB_LEVEL}) OR i.id/1000000=2)
         GROUP BY 1, 2"
    );
    let categories = text.bind(sqlx::query_as::<_, (i64, i64, i64, i64, i64, i64)>(
        &categories_sql,
    ));
    let groups = bind_item_filters(
        text.bind(sqlx::query_as::<_, (i32, String, i64)>(&groups_sql)),
        filters,
    );
    let (counts, groups) = tokio::try_join!(categories.fetch_one(db), groups.fetch_all(db))?;
    let (all, equip, use_, setup, etc, cash) = counts;
    let names = |zh: &str, en: &str| Names::new(zh, en);
    let categories = ITEM_CATEGORIES
        .iter()
        .zip([all, equip, use_, setup, etc, cash])
        .map(|((key, zh, en), count)| Facet {
            key: key.to_string(),
            names: names(zh, en),
            count,
        })
        .collect();
    let sum = |keep: &dyn Fn(i32, &str) -> bool| -> i64 {
        groups
            .iter()
            .filter(|(prefix, sub, _)| keep(*prefix, sub))
            .map(|(_, _, n)| n)
            .sum()
    };
    let equipment = |prefix: i32| (100..200).contains(&prefix);
    let types = EQUIPMENT_TYPES
        .iter()
        .map(|(key, zh, en)| Facet {
            key: key.to_string(),
            names: names(zh, en),
            count: sum(&|prefix, sub| equipment(prefix) && sub == *zh),
        })
        .filter(|f| f.count > 0 || f.key == filters.slot)
        .collect();
    let weapons = WEAPON_TYPES
        .iter()
        .map(|(id, zh, en)| Facet {
            key: id.to_string(),
            names: names(zh, en),
            count: sum(&|prefix, sub| prefix == *id && sub == "武器"),
        })
        .filter(|f| f.count > 0 || filters.weapon.is_some_and(|w| w.to_string() == f.key))
        .collect();
    let uses = USE_TYPES
        .iter()
        .map(|(key, zh, en)| Facet {
            key: key.to_string(),
            names: names(zh, en),
            count: sum(&|prefix, _| (200..300).contains(&prefix) && use_type(prefix) == *key),
        })
        .filter(|f| f.count > 0 || f.key == filters.use_type)
        .collect();
    Ok(ItemFacets {
        categories,
        types,
        weapons,
        uses,
    })
}

async fn search_mobs(
    db: &PgPool,
    text: &Text,
    limit: i64,
    offset: i64,
    filters: &MobFilters,
    region: &str,
    area: &str,
) -> sqlx::Result<Hits<MobRef>> {
    let (filter, rank) = matcher("m.id", &["m.name_zh", "m.name_tw", "m.name_en"], "$4");
    let condition = format!(
        "({filter}) AND {PUBLIC_MOB_FILTER}
         AND (($5='' AND $6='') OR EXISTS (
             SELECT 1 FROM mob_spawns sp JOIN maps mp ON mp.id=sp.map_id
             WHERE sp.mob_id=m.id AND NOT mp.unreleased AND ($5='' OR {region_expr}=$5) AND ($6='' OR {area_expr}=$6)))
         AND ($7::smallint IS NULL OR m.level >= $7) AND ($8::smallint IS NULL OR m.level <= $8)
         AND (NOT $9 OR m.is_boss)",
        region_expr = super::regions::region_sql("mp"),
        area_expr = super::regions::area_sql("mp"),
    );
    let order = match filters.sort.as_str() {
        "level_desc" => format!("m.level DESC NULLS LAST, {rank}, m.id"),
        "name" => format!("{}, m.id", name!("m")),
        _ => format!("{rank}, m.level NULLS LAST, m.id"),
    };
    let rows_sql = format!(
        "SELECT m.id, {name} AS name, {name_en} AS name_en, m.level, COALESCE(m.gms_id, l.gms_id) AS image_id
         FROM mobs m LEFT JOIN mobs l ON l.id = m.link_id WHERE {condition}
         ORDER BY {order} LIMIT $10 OFFSET $11",
        name = name!("m"),
        name_en = name_en!("m"),
    );
    let count_sql = format!("SELECT count(*) FROM mobs m WHERE {condition}");
    let rows = bind_place(text.bind(sqlx::query_as(&rows_sql)), region, area)
        .bind(filters.lmin)
        .bind(filters.lmax)
        .bind(filters.boss)
        .bind(limit)
        .bind(offset);
    let count = bind_place(text.bind(sqlx::query_as(&count_sql)), region, area)
        .bind(filters.lmin)
        .bind(filters.lmax)
        .bind(filters.boss);
    page_of(db, rows, count, offset).await
}

/// Binds `$5` region and `$6` area.
fn bind_place<'q, O>(query: PgQueryAs<'q, O>, region: &str, area: &str) -> PgQueryAs<'q, O> {
    query.bind(region.to_string()).bind(area.to_string())
}

async fn search_maps(
    db: &PgPool,
    query: &str,
    limit: i64,
    offset: i64,
) -> sqlx::Result<Hits<MapHit>> {
    search_maps_in_region(db, &Text::new(query), limit, offset, false, "", "").await
}

async fn search_maps_in_region(
    db: &PgPool,
    text: &Text,
    limit: i64,
    offset: i64,
    town: bool,
    region: &str,
    area: &str,
) -> sqlx::Result<Hits<MapHit>> {
    #[derive(FromRow)]
    struct Row {
        id: i32,
        #[sqlx(flatten)]
        names: Names,
        street: Option<String>,
        street_en: Option<String>,
    }
    let (filter, rank) = matcher("m.id", &["m.name_zh", "m.name_tw", "m.name_en"], "$4");
    let condition = format!(
        "{filter} AND NOT m.unreleased
         AND ($5='' OR {region_expr}=$5) AND ($6='' OR {area_expr}=$6) AND (NOT $7 OR m.is_town)",
        region_expr = super::regions::region_sql("m"),
        area_expr = super::regions::area_sql("m"),
    );
    let rows_sql = format!(
        "SELECT m.id, {name} AS name, {name_en} AS name_en, {streets}
         FROM maps m WHERE {condition}
         ORDER BY {rank}, length({name}), m.id LIMIT $8 OFFSET $9",
        name = name!("m"),
        name_en = name_en!("m"),
        streets = streets!("m"),
    );
    let count_sql = format!("SELECT count(*) FROM maps m WHERE {condition}");
    let rows = bind_place(text.bind(sqlx::query_as(&rows_sql)), region, area)
        .bind(town)
        .bind(limit)
        .bind(offset);
    let count = bind_place(text.bind(sqlx::query_as(&count_sql)), region, area).bind(town);
    let hits: Hits<Row> = page_of(db, rows, count, offset).await?;
    Ok(Hits {
        more: hits.more,
        total: hits.total,
        rows: hits
            .rows
            .into_iter()
            .map(|r| MapHit {
                id: r.id,
                names: r.names,
                street: optional_names(r.street, r.street_en),
            })
            .collect(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn variants_merge_into_the_mob_with_most_maps() {
        let mob = |id, zh: &str, maps: &[i32]| Dropper {
            mob: MobRef {
                id,
                names: Names::new(zh, "x"),
                level: Some(20),
                image_id: None,
            },
            votes: Some(20),
            maps: maps.iter().map(|&m| MapRef::new(m, "m", "m")).collect(),
        };
        let out = merge_variants(vec![
            mob(800018, "红蜗牛王", &[]),
            mob(2, "蜗牛", &[1]),
            mob(700004, "红蜗牛王", &[5, 6]),
            mob(800099, "红蜗牛王", &[6, 7]),
        ]);
        let ids: Vec<i32> = out.iter().map(|d| d.mob.id).collect();
        assert_eq!(ids, [700004, 2]);
        let maps: Vec<i32> = out[0].maps.iter().map(|m| m.id).collect();
        assert_eq!(maps, [5, 6, 7]);
    }

    #[test]
    fn escapes_like_metacharacters() {
        assert_eq!(like_escape(r"50%_a\b"), r"50\%\_a\\b");
        assert_eq!(like_escape("射手村"), "射手村");
    }

    #[test]
    fn slots_one_shop_sold_at_one_visit_read_as_one_sale() {
        let at = DateTime::from_timestamp(1_793_152_700, 0).unwrap();
        let sale = |quantity| Sale {
            observed_location: None,
            kind: SaleKind::SoldOut,
            unit_price: 190.0,
            quantity,
            shop: "1111".into(),
            channel: Some(22),
            room: Some(10),
            detected_at: at,
            variant: None,
            merged_count: 1,
        };
        let key = |observation, price: f64| {
            Some(SaleGroup {
                observation,
                shop: Some(7),
                kind: SaleKind::SoldOut,
                price: price.to_bits(),
                bundle: Some(1),
                variant: None,
                previous: None,
            })
        };
        let mut rows: Vec<_> = (0..6).map(|_| (key(1, 190.0), sale(Some(100)))).collect();
        rows.push((key(1, 195.0), sale(Some(50)))); // another price
        rows.push((key(2, 190.0), sale(Some(100)))); // another visit
        rows.push((None, sale(Some(1)))); // no group: kept apart
        rows.push((None, sale(Some(1))));
        let out = merge_shop_sales(rows);
        let summary: Vec<_> = out.iter().map(|s| (s.quantity, s.merged_count)).collect();
        assert_eq!(
            summary,
            [
                (Some(600), 6),
                (Some(50), 1),
                (Some(100), 1),
                (Some(1), 1),
                (Some(1), 1)
            ]
        );
        let unknown = merge_shop_sales(vec![
            (key(3, 190.0), sale(Some(100))),
            (key(3, 190.0), sale(None)),
        ]);
        assert_eq!((unknown[0].quantity, unknown[0].merged_count), (None, 2));
    }

    #[test]
    fn drops_with_market_prices_come_first() {
        let item = |id, typical, lowest_ask| MobDrop {
            what: DropTarget::Item {
                id,
                names: Names::new(String::new(), String::new()),
                icon_url: None,
                typical,
                lowest_ask,
            },
            votes: Some(1),
            quest_id: None,
        };
        let unlisted = MobDrop {
            what: DropTarget::Unlisted {
                id: Some(9),
                names: None,
            },
            votes: Some(50),
            quest_id: None,
        };
        let meso = MobDrop {
            what: DropTarget::Meso { min: 1, max: 2 },
            votes: None,
            quest_id: None,
        };
        let mut drops = [
            unlisted,
            item(1, None, None),
            item(2, Some(10), None),
            item(3, None, Some(5)),
            meso,
            item(4, Some(20), Some(15)),
        ];
        drops.sort_by_key(|drop| drop_rank(&drop.what));
        let order: Vec<_> = drops
            .iter()
            .map(|drop| match &drop.what {
                DropTarget::Item { id, .. } => *id,
                DropTarget::Meso { .. } => 0,
                DropTarget::Unlisted { .. } => -1,
            })
            .collect();
        assert_eq!(order, vec![0, 2, 4, 3, 1, -1], "stable inside each group");
    }

    #[test]
    fn matcher_covers_every_column() {
        let (filter, rank) = matcher("m.id", &["m.name_zh", "m.name_en"], "$8");
        assert!(filter.contains("m.name_zh ILIKE $3 OR m.name_en ILIKE $3 OR m.id::text = $1"));
        assert!(filter.contains("~ ALL($8::text[])"));
        assert!(rank.contains("lower(m.name_en) = lower($1)"));
        assert!(rank.contains("m.name_zh ILIKE $2"));
    }

    #[test]
    fn npc_price_prefers_dvg_then_mapledex() {
        let dvg = json!({"npc_price": 1590, "mapledex_reference": {"data": {"price": 9}}});
        assert_eq!(npc_sell_price(&dvg), Some(1590));
        let zero = json!({"npc_price": 0, "mapledex_reference": {"data": {"price": 20}}});
        assert_eq!(npc_sell_price(&zero), Some(20));
        assert_eq!(npc_sell_price(&json!({"npc_price": 0})), None);
    }

    #[test]
    fn reference_stats_in_variant_keys() {
        let record = json!({
            "base_stats": [{"key": "incPDD", "value": 18}, {"key": "incSTR", "value": 1}],
            "mapledex_reference": {"data": {"incPAD": 17, "incPDD": 20, "slot": "1H Sword"}},
        });
        assert_eq!(
            reference_stats(&record),
            vec![
                ("weapon_attack".to_string(), 17),
                ("weapon_defense".to_string(), 20),
                ("str".to_string(), 1),
            ]
        );
    }

    #[test]
    fn reference_stats_add_niadb_critical() {
        let record = json!({
            "mapledex_reference": {"data": {"incPAD": 23}},
            "niadb_reference": {"stats": {"watk": 23, "critRate": 1, "critDamage": 2, "slots": 7}},
        });
        assert_eq!(
            reference_stats(&record),
            vec![
                ("weapon_attack".to_string(), 23),
                ("critical_rate".to_string(), 1),
                ("critical_damage".to_string(), 2),
            ]
        );
    }

    #[test]
    fn variants_parse_the_decoder_output() {
        let v = parse_variant(
            3,
            &json!({"stats": [{"key": "dex", "label": "敏捷", "value": 2}], "remaining_upgrades": 7,
                    "enhancements": 0, "unknown_fields": [{"bit": 14, "value": 1}]}),
        );
        assert_eq!(v.stats.len(), 1);
        assert_eq!(v.stats[0].label, "敏捷");
        assert_eq!(
            (v.remaining_upgrades, v.enhancements, v.unknown_fields),
            (Some(7), Some(0), 1)
        );
    }

    #[test]
    fn variants_display_critical_damage_from_legacy_captures() {
        let value = json!({"status":"candidate", "stats":[
            {"key":"int","label":"智力","value":6},
            {"key":"magic_defense","label":"魔法防御","value":27}],
            "remaining_upgrades":0,"enhancements":3,
            "unknown_fields":[{"bit":15,"value":2}]});
        let variant = parse_variant(3, &value);
        assert_eq!(variant.stats[0].key, "critical_damage");
        assert_eq!(variant.stats[0].value, 2);
        assert_eq!(variant.unknown_fields, 0);
        assert_eq!(value["unknown_fields"][0]["bit"], 15);
    }
}

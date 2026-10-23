//! Postgres reads for the bestiary pages. Runtime queries only (CI builds
//! without a database).

use std::collections::HashMap;

use market_core::report::Window;
use market_core::sales::SaleKind;
use serde_json::Value;
use sqlx::types::chrono::{DateTime, NaiveDate, Utc};
use sqlx::{FromRow, PgPool};

use super::model::*;
use super::route::{Edge, EdgeKind};

// Apply before pagination and counts, retaining imported test data privately.
macro_rules! public_mob {
    () => { "m.id NOT BETWEEN 9990000 AND 9990005 AND m.name_en !~* '^test([[:space:]]|[(]|$)' AND COALESCE(m.name_zh, '') NOT LIKE '测试%'" };
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

/// A map's street ("金银岛") in both languages.
macro_rules! streets {
    ($t:literal) => {
        concat!(
            "COALESCE(NULLIF(",
            $t,
            ".street_zh, ''), NULLIF(",
            $t,
            ".street_tw, ''), ",
            $t,
            ".street_en) AS street, ",
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

/// `now` sets the 72-hour listing window, as `/api/v1/item/<id>` does. The
/// reads are independent, so they run concurrently on the pool.
pub async fn item_page_window(
    db: &PgPool,
    id: i32,
    now: f64,
    all: bool,
) -> sqlx::Result<Option<ItemPage>> {
    let mut page = item_page(db, id, now).await?;
    if let Some(p) = &mut page {
        if !all {
            p.market
                .sales
                .retain(|sale| sale.detected_at.timestamp() as f64 >= now - 72.0 * 3600.0);
        }
        let row: (i64, Option<f64>, Option<f64>, Option<f64>) = sqlx::query_as(
            "SELECT count(*), percentile_cont(0.5) WITHIN GROUP (ORDER BY unit_price),
             percentile_cont(0.25) WITHIN GROUP (ORDER BY unit_price),
             percentile_cont(0.75) WITHIN GROUP (ORDER BY unit_price)
             FROM market_sales WHERE item_id=$1 AND detected_at<=to_timestamp($4) AND ($2::bool OR detected_at>=to_timestamp($3))")
            .bind(id).bind(all).bind(now-72.0*3600.0).bind(now).fetch_one(db).await?;
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
    let item = sqlx::query_as::<_, ItemSummary>(
        "SELECT id, name_zh, name_en, category, subcategory, req_level, icon_url, is_cash
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
        item_market(db, id, now),
    )?;
    let Some(item) = item else {
        return Ok(None);
    };
    market.base_stats = record.as_ref().map(reference_stats).unwrap_or_default();
    Ok(Some(ItemPage {
        item,
        stats,
        droppers,
        npc_offers,
        npc_sell: record.as_ref().and_then(npc_sell_price),
        market,
    }))
}

async fn npc_offers(db: &PgPool, item_id: i32) -> sqlx::Result<Vec<NpcOffer>> {
    let rows = sqlx::query_as::<_, (i32, Option<String>, Option<String>, i64)>(concat!(
        "SELECT n.id, ",
        name!("n"),
        ", ",
        name_en!("n"),
        ", s.price FROM npc_shops s JOIN npcs n ON n.id = s.npc_id
         WHERE s.item_id = $1 ORDER BY s.price, n.id"
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

/// The item's reference stats in variant keys: Mapledex first (it has weapon
/// attack), then DVG `base_stats` for keys Mapledex lacks.
fn reference_stats(record: &Value) -> Vec<(String, i64)> {
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
    out
}

async fn droppers(db: &PgPool, item_id: i32) -> sqlx::Result<Vec<Dropper>> {
    #[derive(FromRow)]
    struct Row {
        #[sqlx(flatten)]
        mob: MobRef,
        rate_pct: f64,
    }
    // A mob can list the same item twice (quest copies); show it once.
    let rows: Vec<Row> = sqlx::query_as(concat!(
        "SELECT m.id, ",
        name!("m"),
        " AS name, ",
        name_en!("m"),
        " AS name_en, m.level, COALESCE(m.gms_id, l.gms_id) AS image_id, max(d.rate_pct) AS rate_pct
         FROM drops d JOIN mobs m ON m.id = d.mob_id LEFT JOIN mobs l ON l.id = m.link_id
         WHERE d.item_id = $1 AND ", public_mob!(), "
         GROUP BY m.id, l.gms_id
         ORDER BY rate_pct DESC, m.level NULLS LAST, m.id"
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
            rate_pct: r.rate_pct,
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
         WHERE s.mob_id = ANY($1)
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
async fn item_market(db: &PgPool, id: i32, now: f64) -> sqlx::Result<ItemMarket> {
    #[derive(FromRow)]
    struct ListingRow {
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
        #[sqlx(flatten)]
        variant: VariantColumns,
    }
    let as_of = sqlx::query_scalar::<_, Option<DateTime<Utc>>>("SELECT as_of FROM market_state")
        .fetch_optional(db);
    let listings = sqlx::query_as::<_, ListingRow>(
        "SELECT sh.title, sh.channel, sh.room, market_unit_price(l.item_id,l.price,l.bundle) AS unit_price, l.stock,
                o.observed_at, l.variant_id, v.stats
         FROM listings l
         JOIN shops sh ON sh.id = l.shop_id JOIN observations o ON o.id = l.observation_id
         LEFT JOIN equipment_variants v ON v.id = l.variant_id
         WHERE l.item_id = $1 AND l.stock > 0 AND sh.last_seen_at >= to_timestamp($2)
         ORDER BY l.price::float8 / l.bundle, sh.public_key, l.slot",
    )
    .bind(id)
    .bind(Window::recent(now).cutoff)
    .fetch_all(db);
    let sales = sqlx::query_as::<_, SaleRow>(
        "SELECT s.kind, s.unit_price, s.quantity,
                COALESCE(sh.title,s.source_seller,'') AS title,
                COALESCE(sh.channel,o.map_channel,(s.source_location->>'channel')::int2) AS channel,
                COALESCE(sh.room,(s.source_location->>'room')::int2) AS room,
                CASE WHEN s.source='mesowatch' THEN s.source_location->>'text'
                WHEN sh.room IS NULL AND o.map_id IS NOT NULL THEN
                  COALESCE((SELECT COALESCE(name_zh,name_en) FROM maps WHERE id=o.map_id),o.map_id::text)
                END AS observed_location, s.detected_at AS observed_at, s.variant_id, v.stats
         FROM market_sales s
         LEFT JOIN observations o ON o.id = s.observation_id LEFT JOIN shops sh ON sh.id = s.shop_id
         LEFT JOIN equipment_variants v ON v.id = s.variant_id
         WHERE s.item_id = $1
         ORDER BY s.detected_at DESC, s.observation_id, s.position LIMIT $2",
    )
    .bind(id)
    .bind(SALES_SHOWN)
    .fetch_all(db);
    let (as_of, listings, sales) = tokio::try_join!(as_of, listings, sales)?;
    let as_of = as_of.flatten();
    let mut listings: Vec<Listing> = listings
        .into_iter()
        .map(|r| Listing {
            shop: r.title,
            channel: r.channel,
            room: r.room,
            unit_price: r.unit_price,
            stock: Some(r.stock),
            seen_at: r.observed_at,
            variant: r.variant.variant(),
        })
        .collect();
    for row in crate::external::quote_rows(db, &[id], Window::recent(now).cutoff).await? {
        if let Some(seen_at) =
            DateTime::from_timestamp(row["time"].as_f64().unwrap_or(0.) as i64, 0)
        {
            listings.push(Listing {
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
    let sales = sales
        .into_iter()
        .filter_map(|r| {
            Some(Sale {
                observed_location: r.observed_location,
                kind: SaleKind::parse(&r.kind)?,
                unit_price: r.unit_price,
                quantity: r.quantity,
                shop: r.title,
                channel: r.channel,
                room: r.room,
                detected_at: r.observed_at,
                variant: r.variant.variant(),
            })
        })
        .collect();
    let (days, sale_points) = match as_of {
        Some(_) => {
            seven_days(
                db,
                id,
                sqlx::types::chrono::DateTime::from_timestamp(now as i64, 0)
                    .expect("valid current time")
                    .date_naive(),
            )
            .await?
        }
        None => (Vec::new(), Vec::new()),
    };
    Ok(ItemMarket {
        as_of,
        listings,
        sales,
        days,
        sale_points,
        base_stats: Vec::new(),
    })
}

/// `item_daily` and the single sale prices of the seven days ending `last`.
/// Days without sales are present with a zero count.
async fn seven_days(
    db: &PgPool,
    id: i32,
    last: NaiveDate,
) -> sqlx::Result<(Vec<Day>, Vec<SalePoint>)> {
    let first = (1..MARKET_DAYS).fold(last, |d, _| d.pred_opt().unwrap_or(d));
    type DailyRow = (NaiveDate, Option<f64>, Option<f64>, Option<f64>, i32);
    let rows: Vec<DailyRow> = sqlx::query_as(
        "SELECT day, median, low, high, count FROM item_daily
         WHERE item_id = $1 AND day BETWEEN $2 AND $3",
    )
    .bind(id)
    .bind(first)
    .bind(last)
    .fetch_all(db)
    .await?;
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
           AND s.detected_at < (($3::date) + 1)::timestamp AT TIME ZONE 'UTC'",
    )
    .bind(id)
    .bind(first)
    .bind(last)
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
         WHERE s.mob_id = $1 ORDER BY s.spawn_count DESC, mp.id"
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
        rate_pct: f64,
        quest_id: Option<i32>,
    }
    let rows: Vec<Row> = sqlx::query_as(concat!(
        "SELECT d.item_id, i.id IS NOT NULL AS in_catalog, NULLIF(i.name_zh, '') AS item_name,
                i.name_en AS item_name_en, i.icon_url, round(st.typical)::bigint AS typical,
                round(st.lowest_ask)::bigint AS lowest_ask, ",
        name!("d"),
        " AS drop_name, ",
        name_en!("d"),
        " AS drop_name_en, d.gms_item_id, d.meso_min, d.meso_max, d.rate_pct, d.quest_id
         FROM drops d
         LEFT JOIN items i ON i.id = d.item_id
         LEFT JOIN item_stats st ON st.item_id = i.id
         WHERE d.mob_id = $1
         ORDER BY d.meso_max IS NULL, d.rate_pct DESC, d.ord"
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
                rate_pct: r.rate_pct,
                quest_id: r.quest_id,
            }
        })
        .collect();
    drops.dedup();
    Ok(drops)
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
         FROM maps m LEFT JOIN maps r ON r.id = m.return_map_id WHERE m.id = $1"
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
             WHERE p.from_map_id = $1 ORDER BY p.kind, p.to_map_id, p.portal_name"
        ),
        Direction::In => concat!(
            "SELECT p.from_map_id, ",
            name!("m"),
            ", ",
            name_en!("m"),
            ", p.kind, p.portal_name FROM map_portals p LEFT JOIN maps m ON m.id = p.from_map_id
             WHERE p.to_map_id = $1 ORDER BY p.kind, p.from_map_id, p.portal_name"
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
        "SELECT from_map_id, to_map_id, kind, portal_name FROM map_portals ORDER BY id",
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
        " AS name_en FROM maps m WHERE m.id = ANY($1)"
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
            "SELECT EXISTS (SELECT 1 FROM maps WHERE id = $1)
                 OR EXISTS (SELECT 1 FROM map_portals WHERE from_map_id = $1 OR to_map_id = $1)",
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
         WHERE lower(m.name_zh) = lower($1) OR lower(m.name_tw) = lower($1) OR lower(m.name_en) = lower($1)
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
    search_places(db, query, kind, offset, filters, "", "").await
}

pub async fn search_places(
    db: &PgPool,
    query: &str,
    kind: Option<SearchKind>,
    offset: i64,
    filters: ItemFilters,
    region: &str,
    area: &str,
) -> sqlx::Result<SearchPage> {
    let region = super::regions::normalize(region);
    let region_expr = super::regions::region_sql("m");
    let area_expr = super::regions::area_sql("m");
    let areas: Vec<AreaChoice> = sqlx::query_as(&format!(
        "SELECT {region_expr} AS region, {area_expr} AS key,
         COALESCE(max(NULLIF(m.street_zh,'')),max(m.street_en)) AS name,
         COALESCE(max(NULLIF(m.street_en,'')),max(m.street_zh)) AS name_en
         FROM maps m WHERE {area_expr}<>'' GROUP BY 1,2 ORDER BY region,key"
    ))
    .fetch_all(db)
    .await?;
    let area = if !region.is_empty() && areas.iter().any(|a| a.key == area && a.region == region) {
        area.to_string()
    } else {
        String::new()
    };
    let limit = |k: SearchKind| match kind {
        None => Some(SEARCH_LIMIT),
        Some(only) if only == k => Some(SEARCH_KIND_LIMIT),
        Some(_) => None,
    };
    let mut page = SearchPage {
        region: region.clone(),
        area: area.clone(),
        areas,
        filters: filters.clone(),
        query: query.to_string(),
        offset,
        kind,
        ..Default::default()
    };
    if let Some(n) = limit(SearchKind::Item) {
        page.items = search_items(db, query, n, offset, &filters).await?;
    }
    if let Some(n) = limit(SearchKind::Mob) {
        page.mobs = search_mobs(db, query, n, offset, &region, &area).await?;
    }
    if let Some(n) = limit(SearchKind::Map) {
        page.maps = search_maps_in_region(db, query, n, offset, &region, &area).await?;
    }
    Ok(page)
}

/// SQL fragments matching `$1` (raw query), `$2` (prefix pattern) and `$3`
/// (substring pattern) against name columns. Inputs are constants.
fn matcher(id: &str, columns: &[&str]) -> (String, String) {
    let any = |op: &dyn Fn(&str) -> String| {
        columns
            .iter()
            .map(|c| op(c))
            .collect::<Vec<_>>()
            .join(" OR ")
    };
    let filter = format!("({} OR {id}::text = $1)", any(&|c| format!("{c} ILIKE $3")));
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

async fn run_search<T>(
    db: &PgPool,
    sql: &str,
    query: &str,
    limit: i64,
    offset: i64,
    region: &str,
    area: &str,
) -> sqlx::Result<Hits<T>>
where
    T: for<'r> FromRow<'r, sqlx::postgres::PgRow> + Send + Unpin,
{
    let escaped = like_escape(query);
    let mut rows: Vec<T> = sqlx::query_as(sql)
        .bind(query)
        .bind(format!("{escaped}%"))
        .bind(format!("%{escaped}%"))
        .bind(limit + 1)
        .bind(offset)
        .bind(region)
        .bind(area)
        .fetch_all(db)
        .await?;
    let more = rows.len() as i64 > limit;
    rows.truncate(limit as usize);
    Ok(Hits { rows, more })
}

async fn search_items(
    db: &PgPool,
    query: &str,
    limit: i64,
    offset: i64,
    filters: &ItemFilters,
) -> sqlx::Result<Hits<ItemHit>> {
    let (filter, rank) = matcher("i.id", &["i.name_zh", "i.name_en"]);
    let cat: i32 = match filters.cat.as_str() {
        "equip" => 1,
        "use" => 2,
        "setup" => 3,
        "etc" => 4,
        "cash" => 5,
        _ => 0,
    };
    let sql = format!(
        "SELECT i.id, COALESCE(NULLIF(i.name_zh, ''), i.name_en) AS name, i.name_en, i.icon_url, i.subcategory, i.req_level AS level
         FROM items i WHERE {filter}
         AND ($6=0 OR ($6=5 AND (i.is_cash OR i.id/1000000=5)) OR ($6 BETWEEN 1 AND 4 AND i.id/1000000=$6 AND NOT i.is_cash))
         AND ($7::smallint=0 OR i.req_job_mask=0 OR (i.req_job_mask & $7::smallint)>0)
         AND ($8::smallint IS NULL OR i.req_level >= $8) AND ($9::smallint IS NULL OR i.req_level <= $9)
         ORDER BY CASE WHEN $1='' THEN 0 ELSE {rank} END, CASE WHEN $1='' THEN i.id ELSE 0 END, length(COALESCE(i.name_zh, i.name_en)), i.id LIMIT $4 OFFSET $5"
    );
    let escaped = like_escape(query);
    let mut rows: Vec<ItemHit> = sqlx::query_as(&sql)
        .bind(query)
        .bind(format!("{escaped}%"))
        .bind(format!("%{escaped}%"))
        .bind(limit + 1)
        .bind(offset)
        .bind(cat)
        .bind(filters.job)
        .bind(filters.min_level)
        .bind(filters.max_level)
        .fetch_all(db)
        .await?;
    let more = rows.len() as i64 > limit;
    rows.truncate(limit as usize);
    Ok(Hits { rows, more })
}

async fn search_mobs(
    db: &PgPool,
    query: &str,
    limit: i64,
    offset: i64,
    region: &str,
    area: &str,
) -> sqlx::Result<Hits<MobRef>> {
    let (filter, rank) = matcher("m.id", &["m.name_zh", "m.name_tw", "m.name_en"]);
    let sql = format!(
        "SELECT m.id, {name} AS name, {name_en} AS name_en, m.level, COALESCE(m.gms_id, l.gms_id) AS image_id
         FROM mobs m LEFT JOIN mobs l ON l.id = m.link_id WHERE ({filter}) AND {PUBLIC_MOB_FILTER}
         AND (($6='' AND $7='') OR EXISTS (
             SELECT 1 FROM mob_spawns sp JOIN maps mp ON mp.id=sp.map_id
             WHERE sp.mob_id=m.id AND ($6='' OR {region_expr}=$6) AND ($7='' OR {area_expr}=$7)))
         ORDER BY {rank}, m.level NULLS LAST, m.id LIMIT $4 OFFSET $5",
        region_expr=super::regions::region_sql("mp"),
        area_expr=super::regions::area_sql("mp"),
        name = name!("m"),
        name_en = name_en!("m"),
    );
    run_search(db, &sql, query, limit, offset, region, area).await
}

async fn search_maps(
    db: &PgPool,
    query: &str,
    limit: i64,
    offset: i64,
) -> sqlx::Result<Hits<MapHit>> {
    search_maps_in_region(db, query, limit, offset, "", "").await
}

async fn search_maps_in_region(
    db: &PgPool,
    query: &str,
    limit: i64,
    offset: i64,
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
    let (filter, rank) = matcher("m.id", &["m.name_zh", "m.name_tw", "m.name_en"]);
    let sql = format!(
        "SELECT m.id, {name} AS name, {name_en} AS name_en, {streets}
         FROM maps m WHERE {filter}
         AND ($6='' OR {region_expr}=$6) AND ($7='' OR {area_expr}=$7)
         ORDER BY {rank}, length({name}), m.id LIMIT $4 OFFSET $5",
        name = name!("m"),
        name_en = name_en!("m"),
        streets = streets!("m"),
        region_expr = super::regions::region_sql("m"),
        area_expr = super::regions::area_sql("m"),
    );
    let hits: Hits<Row> = run_search(db, &sql, query, limit, offset, region, area).await?;
    Ok(Hits {
        more: hits.more,
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
            rate_pct: 20.0,
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
    fn matcher_covers_every_column() {
        let (filter, rank) = matcher("m.id", &["m.name_zh", "m.name_en"]);
        assert_eq!(
            filter,
            "(m.name_zh ILIKE $3 OR m.name_en ILIKE $3 OR m.id::text = $1)"
        );
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
}

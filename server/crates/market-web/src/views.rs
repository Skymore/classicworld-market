//! Read path. Response shapes follow `shared_server.py` / `market_views.py`
//! so the existing pages and the collector dashboard keep working. Every
//! request reads precomputed rows; the list is one `item_stats` query.

use market_core::item::{category_kinds, category_name, equipment_jobs, is_equipment};
use market_core::protocol::{Equipment, MARKET_MAP_BASE, WORLD};
use market_core::pyjson::{self, floordiv, sha256_hex, Dumps};
use market_core::report::{Window, RECENT_HOURS};
use market_core::sales::{sale_id, SaleKind};
use serde::Serialize;
use serde_json::{json, Map, Value};
use sqlx::{postgres::PgRow, PgPool, Row};

pub const LIMITATION: &str = "仅覆盖采集器和外部来源已观察到的摊位；不是全市场。外部记录保留来源，未知库存与数量为空。装备属性未完整解析。售光是推定，不是成交回执。";
pub const DEDUP_NOTE: &str =
    "采集器按同位置/摊位ID/名称合并最新快照；外部记录按来源成交ID去重。跨来源缺少共同成交ID，保留各自观察，不以同价同时判定重复。";
const CATEGORY_NAMES: [&str; 5] = ["装备", "消耗品", "装饰", "其他", "商城物品"];
const ARCHER_PRESET: [i32; 4] = [1_452_003, 1_452_004, 1_462_003, 1_462_004];
const CATALOG_LIMIT: i64 = 40;
const WATCH_LIMIT: usize = 200;

/// `?hours=72|all`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Hours {
    Recent,
    All,
}

impl Hours {
    pub fn parse(value: Option<&str>) -> Option<Self> {
        match value.unwrap_or("72") {
            "72" => Some(Self::Recent),
            "all" => Some(Self::All),
            _ => None,
        }
    }

    pub fn window(self, now: f64) -> Window {
        match self {
            Self::Recent => Window::recent(now),
            Self::All => Window::ALL,
        }
    }

    fn json(self) -> Value {
        match self {
            Self::Recent => json!(RECENT_HOURS),
            Self::All => Value::Null,
        }
    }

    pub fn key(self) -> &'static str {
        match self {
            Self::Recent => "72",
            Self::All => "all",
        }
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct Header {
    pub version: i64,
    pub as_of: Option<f64>,
    pub visits: i64,
    pub observations: i64,
    pub observed_shops: i64,
    pub active_shops: i64,
    pub item_count: i64,
}

pub async fn version(db: &PgPool) -> sqlx::Result<i64> {
    sqlx::query_scalar("SELECT version FROM market_state")
        .fetch_one(db)
        .await
}

pub async fn header(db: &PgPool, hours: Hours, now: f64) -> sqlx::Result<Header> {
    let row = sqlx::query(
        "SELECT version, extract(epoch FROM as_of)::float8, visits, observation_rows, shops,
                (SELECT count(*) FROM shops WHERE last_seen_at >= to_timestamp($1)),
                (SELECT count(*) FROM item_stats)
         FROM market_state",
    )
    .bind(hours.window(now).cutoff)
    .fetch_one(db)
    .await?;
    Ok(Header {
        version: row.get(0),
        as_of: row.get(1),
        visits: row.get(2),
        observations: row.get(3),
        observed_shops: row.get(4),
        active_shops: row.get(5),
        item_count: row.get(6),
    })
}

/// Report fields around `products` (`Repository.report` + `SharedStore.report`).
pub fn header_json(h: &Header, hours: Hours, now: f64, public_read: bool) -> Map<String, Value> {
    let value = json!({
        "schema_version": 1, "evidence_schema_version": 2, "generated_at": now, "as_of": h.as_of, "hours": hours.json(),
        "visits": h.visits, "manual_visits": h.visits, "experimental_visits": 0,
        "observations": h.observations, "manual_observations": h.observations,
        "observed_shops": h.observed_shops, "active_shops": h.active_shops, "item_count": h.item_count,
        "limitation": LIMITATION, "health": {"errors": []}, "capture": null,
        "connection_health": {"state": "ready", "message": "共享市场 · 成员观察数据"},
        "shared": true, "dedup_note": DEDUP_NOTE, "public_read": public_read,
    });
    match value {
        Value::Object(map) => map,
        _ => unreachable!("json! object"),
    }
}

/// One `item_stats` row joined with its item and quote window.
#[derive(Debug, Clone)]
struct ProductRow {
    item_id: i32,
    name_zh: String,
    name_en: String,
    icon_url: Option<String>,
    subcategory: Option<String>,
    level: Option<i16>,
    jobs: Vec<&'static str>,
    last_seen: Option<f64>,
    low: Option<f64>,
    median: Option<f64>,
    high: Option<f64>,
    listings: i32,
    shops: i32,
    variant_count: i32,
    sold_out_count: i32,
    sold_out_median: Option<f64>,
    sales_count: i32,
    recommendation: Option<Value>,
    typical: Option<f64>,
    typical_low: Option<f64>,
    typical_high: Option<f64>,
    typical_basis: String,
    typical_count: i32,
    low_data: bool,
    sales_24h: i32,
    sales_prev_24h: i32,
    change_24h: Option<f64>,
    sales_10d: i32,
    last_sale_at: Option<f64>,
    last_sale_price: Option<f64>,
    last3_avg: Option<f64>,
    trend: Value,
}

async fn products(
    db: &PgPool,
    hours: Hours,
    item: Option<i32>,
    with_recommendation: bool,
) -> sqlx::Result<Vec<ProductRow>> {
    let (w, join) = match hours {
        Hours::Recent => ("st", ""),
        Hours::All => ("w", "JOIN item_stats_all w ON w.item_id = st.item_id"),
    };
    let recommendation = if with_recommendation {
        format!("{w}.recommendation")
    } else {
        "NULL::jsonb".into()
    };
    let filter = if item.is_some() {
        "WHERE st.item_id = $1"
    } else {
        ""
    };
    let sql = format!(
        "SELECT st.item_id, COALESCE(NULLIF(i.name_zh, ''), st.item_id::text), i.name_en, i.icon_url, i.subcategory,
                i.req_level, i.req_job_mask, extract(epoch FROM st.last_seen_at)::float8,
                {w}.lowest_ask, {w}.median_ask, {w}.highest_ask, {w}.listings_count, {w}.shops_count,
                {w}.variant_count, {w}.sold_out_count, {w}.sold_out_median, {w}.sales_count,
                {recommendation}, st.typical, st.typical_low, st.typical_high, st.typical_basis, st.sample_size,
                st.low_data, st.sales_24h, st.sales_prev_24h, st.change_24h, st.sales_10d,
                extract(epoch FROM st.last_sale_at)::float8, st.last_sale_price, st.last3_avg, st.trend
         FROM item_stats st JOIN items i ON i.id = st.item_id {join} {filter}
         ORDER BY st.item_id"
    );
    let rows = sqlx::query(&sql).bind(item).fetch_all(db).await?;
    Ok(rows
        .into_iter()
        .map(|r| ProductRow {
            item_id: r.get(0),
            name_zh: r.get(1),
            name_en: r.get(2),
            icon_url: r.get(3),
            subcategory: r.get(4),
            level: r.get(5),
            jobs: equipment_jobs(r.get::<Option<i16>, _>(6).map(i64::from)),
            last_seen: r.get(7),
            low: r.get(8),
            median: r.get(9),
            high: r.get(10),
            listings: r.get(11),
            shops: r.get(12),
            variant_count: r.get(13),
            sold_out_count: r.get(14),
            sold_out_median: r.get(15),
            sales_count: r.get(16),
            recommendation: r.get(17),
            typical: r.get(18),
            typical_low: r.get(19),
            typical_high: r.get(20),
            typical_basis: r.get(21),
            typical_count: r.get(22),
            low_data: r.get(23),
            sales_24h: r.get(24),
            sales_prev_24h: r.get(25),
            change_24h: r.get(26),
            sales_10d: r.get(27),
            last_sale_at: r.get(28),
            last_sale_price: r.get(29),
            last3_avg: r.get(30),
            trend: r.get(31),
        })
        .collect())
}

/// Product dict without quotes/sales/variants/trend_7d (`view(summary=True)`).
fn summary_product(p: &ProductRow, hours: Hours) -> Map<String, Value> {
    let value = json!({
        "world": WORLD, "item_id": p.item_id, "name_zh": p.name_zh, "name_en": p.name_en,
        "unit_basis": crate::external::unit(p.item_id),
        "category": category_name(i64::from(p.item_id)), "icon_url": p.icon_url, "level": p.level,
        "jobs": p.jobs, "subcategory": p.subcategory, "last_seen": p.last_seen,
        "low": p.low, "median": p.median, "high": p.high, "listings": p.listings, "shops": p.shops,
        "sold_out_count": p.sold_out_count, "sold_out_median": p.sold_out_median, "sales_count": p.sales_count,
        "typical": p.typical, "typical_low": p.typical_low, "typical_high": p.typical_high,
        "typical_basis": p.typical_basis, "typical_count": p.typical_count, "low_data": p.low_data,
        "sales_24h": p.sales_24h, "sales_prev_24h": p.sales_prev_24h, "change_24h": p.change_24h,
        "sales_10d": p.sales_10d, "last_sale_at": p.last_sale_at, "last_sale_price": p.last_sale_price,
        "last3_avg": p.last3_avg, "hours": hours.json(), "recommendation": p.recommendation,
        "variant_count": p.variant_count,
    });
    match value {
        Value::Object(map) => map,
        _ => unreachable!("json! object"),
    }
}

/// `?view=list`: `market_views.list_view`. Each entry is the item's
/// catalogue fields followed by the `list_fields` the write path stored, so
/// a request decodes eight columns per item and copies the rest as text.
pub async fn market_list(
    db: &PgPool,
    hours: Hours,
    now: f64,
    public_read: bool,
) -> sqlx::Result<(i64, Vec<u8>)> {
    let head = header(db, hours, now).await?;
    let (fields, join) = match hours {
        Hours::Recent => ("st.list_fields", ""),
        Hours::All => (
            "w.list_fields",
            "JOIN item_stats_all w ON w.item_id = st.item_id",
        ),
    };
    let rows = sqlx::query(&format!(
        "SELECT st.item_id, COALESCE(NULLIF(i.name_zh, ''), st.item_id::text), i.name_en, i.icon_url,
                i.subcategory, i.req_level, i.req_job_mask, extract(epoch FROM st.last_seen_at)::float8, {fields}
         FROM item_stats st JOIN items i ON i.id = st.item_id {join} ORDER BY st.item_id"
    ))
    .fetch_all(db)
    .await?;

    let mut body = serde_json::to_vec(&Value::Object(header_json(&head, hours, now, public_read)))
        .expect("serialisable");
    body.pop(); // reopen the header object
    body.extend_from_slice(b",\"products\":[");
    #[derive(Serialize)]
    struct Catalogue<'a> {
        item_id: i32,
        name_zh: &'a str,
        name_en: &'a str,
        icon_url: Option<&'a str>,
        category: &'static str,
        subcategory: Option<&'a str>,
        level: Option<i16>,
        jobs: Vec<&'static str>,
        last_seen: Option<f64>,
    }
    for (n, r) in rows.iter().enumerate() {
        let item_id: i32 = r.get(0);
        let mask: Option<i16> = r.get(6);
        let catalogue = Catalogue {
            item_id,
            name_zh: r.get(1),
            name_en: r.get(2),
            icon_url: r.get(3),
            category: category_name(i64::from(item_id)),
            subcategory: r.get(4),
            level: r.get(5),
            jobs: equipment_jobs(mask.map(i64::from)),
            last_seen: r.get(7),
        };
        if n > 0 {
            body.push(b',');
        }
        serde_json::to_writer(&mut body, &catalogue).expect("serialisable");
        body.pop();
        let fields: &str = r.get(8);
        if !fields.is_empty() {
            body.push(b',');
            body.extend_from_slice(fields.as_bytes());
        }
        body.push(b'}');
    }
    body.extend_from_slice(b"]}");
    Ok((head.version, body))
}

/// `?summary=1`; also the answer to a bare `/api/v1/market`.
pub async fn market_summary(
    db: &PgPool,
    hours: Hours,
    now: f64,
    public_read: bool,
) -> sqlx::Result<(i64, Value)> {
    let head = header(db, hours, now).await?;
    let rows = products(db, hours, None, true).await?;
    let mut body = header_json(&head, hours, now, public_read);
    body.insert(
        "products".into(),
        rows.iter()
            .map(|p| Value::Object(summary_product(p, hours)))
            .collect(),
    );
    Ok((head.version, Value::Object(body)))
}

/// `?item_id=N`: the full product (quotes, sales, trend) and its history.
pub async fn market_item(
    db: &PgPool,
    item: i32,
    hours: Hours,
    now: f64,
    public_read: bool,
) -> sqlx::Result<Value> {
    let window = hours.window(now);
    let mut found = Vec::new();
    let mut history = Vec::new();
    if let Some(p) = products(db, hours, Some(item), true).await?.pop() {
        let quotes = quotes(db, &[item], window.cutoff).await?;
        let mut variants: Vec<Value> = Vec::new();
        for q in &quotes {
            if !variants.contains(&q["variant"]) {
                variants.push(q["variant"].clone());
            }
        }
        let mut product = summary_product(&p, hours);
        product.remove("variant_count");
        product.insert(
            "quotes".into(),
            quotes.into_iter().map(Value::Object).collect(),
        );
        product.insert("variants".into(), Value::Array(variants));
        product.insert(
            "sales".into(),
            item_sales(db, item, window.cutoff, None)
                .await?
                .into_iter()
                .map(Value::Object)
                .collect(),
        );
        product.insert("trend_7d".into(), p.trend.clone());
        found.push(Value::Object(product));
        history = item_history(db, item).await?;
    }
    Ok(json!({"products": found, "history": history, "public_read": public_read}))
}

/// `/api/v1/item/<id>`: the item page's data in one response.
pub async fn item_page(db: &PgPool, item: i32, now: f64) -> sqlx::Result<Option<Value>> {
    let Some(p) = products(db, Hours::Recent, Some(item), true).await?.pop() else {
        return Ok(None);
    };
    let listings = quotes(db, &[item], Window::recent(now).cutoff).await?;
    let sales = item_sales(db, item, f64::NEG_INFINITY, Some(50)).await?;
    let daily: Vec<Value> = sqlx::query(
        "SELECT to_char(day, 'YYYY-MM-DD'), median, low, high, count FROM item_daily WHERE item_id = $1 ORDER BY day",
    )
    .bind(item)
    .fetch_all(db)
    .await?
    .into_iter()
    .map(|r| {
        json!({"day": r.get::<String, _>(0), "median": r.get::<Option<f64>, _>(1), "low": r.get::<Option<f64>, _>(2),
               "high": r.get::<Option<f64>, _>(3), "count": r.get::<i32, _>(4)})
    })
    .collect();
    let mut product = summary_product(&p, Hours::Recent);
    product.insert("trend_7d".into(), p.trend.clone());
    Ok(Some(json!({
        "product": product, "listings": listings, "sales": sales, "daily": daily, "generated_at": now,
    })))
}

/// Columns every row builder reads. `{r}` is the table holding the row.
fn row_columns(r: &str) -> String {
    format!(
        "o.visit_key, extract(epoch FROM o.observed_at)::float8 AS time, sh.title, sh.shop_id AS game_shop_id,
         COALESCE(sh.channel, o.map_channel) AS channel, sh.room, o.map_id AS observed_map_id,
         (SELECT name_zh FROM maps WHERE id=o.map_id) AS map_name_zh,
         (SELECT name_en FROM maps WHERE id=o.map_id) AS map_name_en, sh.public_key, {r}.slot, {r}.item_id, {r}.variant_id, v.stats_hash,
         v.stats AS equipment, {r}.price, {r}.bundle, {r}.stock,
         COALESCE(NULLIF(i.name_zh, ''), i.id::text) AS name_zh, i.name_en, i.icon_url, i.subcategory,
         i.req_level, i.req_job_mask, o.source, NULL::text AS source_key,
         market_unit_price({r}.item_id,{r}.price,{r}.bundle) AS unit_price,
         market_price_unit({r}.item_id) AS unit_basis,NULL::jsonb AS source_location"
    )
}

fn location_json(channel: Option<i16>, room: Option<i16>) -> Value {
    match (channel, room) {
        (Some(channel), Some(room)) => {
            json!({"channel": channel, "room": room, "map_id": MARKET_MAP_BASE as i64 + i64::from(room)})
        }
        _ => Value::Null,
    }
}

/// A history/quote row as `Repository.report` builds it (private fields removed).
fn row_json(r: &PgRow) -> Map<String, Value> {
    let item: i32 = r.get("item_id");
    let equipment_item = is_equipment(i64::from(item));
    let hash: Option<Vec<u8>> = r.get("stats_hash");
    let variant = match hash {
        Some(hash) => hex::encode(&hash[..8]),
        None if equipment_item => "unknown".into(),
        None => "standard".into(),
    };
    let equipment: Option<Value> = r.get("equipment");
    let equipment = equipment.unwrap_or_else(|| {
        if equipment_item {
            Equipment::Unsupported.to_json()
        } else {
            Value::Null
        }
    });
    let (price, bundle): (Option<i64>, Option<i32>) = (r.get("price"), r.get("bundle"));
    let mask: Option<i16> = r.get("req_job_mask");
    let mut location = location_json(r.get("channel"), r.get("room"));
    if location.is_null() {
        if let (Some(channel), Some(map)) = (
            r.get::<Option<i16>, _>("channel"),
            r.get::<Option<i32>, _>("observed_map_id"),
        ) {
            location = json!({"channel":channel,"room":null,"map_id":map,
                "map_name_zh":r.get::<Option<String>,_>("map_name_zh"),
                "map_name_en":r.get::<Option<String>,_>("map_name_en")});
        }
    }
    if location.is_null() {
        location = r
            .get::<Option<Value>, _>("source_location")
            .unwrap_or(Value::Null);
    }
    let value = json!({
        "visit_id": r.get::<Option<String>, _>("visit_key"), "world": WORLD, "time": r.get::<f64, _>("time"),
        "shop": r.get::<String, _>("title"), "shop_id": r.get::<Option<i64>, _>("game_shop_id"), "item_id": item,
        "category": category_name(i64::from(item)), "variant": variant, "slot": r.get::<Option<i32>, _>("slot"),
        "price": price, "bundle": bundle, "unit_price": r.get::<f64,_>("unit_price"),
        "source": r.get::<String,_>("source"), "unit_basis": r.get::<String,_>("unit_basis"),
        "stock": r.get::<Option<i32>, _>("stock"), "name_zh": r.get::<String, _>("name_zh"),
        "name_en": r.get::<String, _>("name_en"), "icon_url": r.get::<Option<String>, _>("icon_url"),
        "level": r.get::<Option<i16>, _>("req_level"), "jobs": equipment_jobs(mask.map(i64::from)),
        "subcategory": r.get::<Option<String>, _>("subcategory"), "experimental": false,
        "requires_validation": true, "raw_available": false, "shop_key": r.get::<String, _>("public_key"),
        "equipment": equipment, "location": location,
    });
    match value {
        Value::Object(map) => map,
        _ => unreachable!("json! object"),
    }
}

const SALE_COLUMNS: &str = "s.kind, s.price AS sale_price, s.bundle AS sale_bundle, s.quantity,
    extract(epoch FROM s.window_start)::float8 AS previous_time";

fn sale_json(r: &PgRow) -> Map<String, Value> {
    let mut row = row_json(r);
    let kind = SaleKind::parse(r.get("kind")).expect("sales.kind check constraint");
    let (price, bundle): (Option<i64>, Option<i32>) = (r.get("sale_price"), r.get("sale_bundle"));
    let id = if let Some(key) = r.get::<Option<String>, _>("source_key") {
        format!("mesowatch:{key}")
    } else {
        sale_id(
            row["visit_id"].as_str().expect("collector visit_id"),
            r.get("slot"),
        )
    };
    for (key, value) in [
        ("kind", json!(kind.as_str())),
        ("id", json!(id)),
        ("method", json!(kind.method())),
        ("sale_price", json!(price)),
        ("bundle", json!(bundle)),
        ("sale_unit_price", json!(r.get::<f64, _>("sale_unit_price"))),
        ("quantity", json!(r.get::<Option<i64>, _>("quantity"))),
        (
            "previous_time",
            json!(r.get::<Option<f64>, _>("previous_time")),
        ),
        ("evidence", json!(kind.evidence())),
    ] {
        row.insert(key.into(), value);
    }
    row
}

/// Live listings of `items` whose shop was seen at or after `cutoff`.
async fn quotes(db: &PgPool, items: &[i32], cutoff: f64) -> sqlx::Result<Vec<Map<String, Value>>> {
    let sql = format!(
        "SELECT {} FROM listings l
         JOIN shops sh ON sh.id = l.shop_id JOIN observations o ON o.id = l.observation_id
         JOIN items i ON i.id = l.item_id LEFT JOIN equipment_variants v ON v.id = l.variant_id
         WHERE l.item_id = ANY($1) AND l.stock > 0 AND sh.last_seen_at >= to_timestamp($2)
         ORDER BY market_unit_price(l.item_id,l.price,l.bundle), sh.public_key, l.slot",
        row_columns("l")
    );
    let rows = sqlx::query(&sql)
        .bind(items)
        .bind(cutoff)
        .fetch_all(db)
        .await?;
    let mut result: Vec<_> = rows.iter().map(row_json).collect();
    result.extend(crate::external::quote_rows(db, items, cutoff).await?);
    result.sort_by(|a, b| {
        a["unit_price"]
            .as_f64()
            .partial_cmp(&b["unit_price"].as_f64())
            .unwrap_or(std::cmp::Ordering::Equal)
    });
    Ok(result)
}

/// Every observation row of the item, newest first.
async fn item_history(db: &PgPool, item: i32) -> sqlx::Result<Vec<Value>> {
    let sql = format!(
        "SELECT {} FROM observation_rows r
         JOIN observations o ON o.id = r.observation_id JOIN shops sh ON sh.id = o.shop_id
         JOIN items i ON i.id = r.item_id LEFT JOIN equipment_variants v ON v.id = r.variant_id
         WHERE r.item_id = $1 ORDER BY o.observed_at DESC, o.visit_key DESC, r.position DESC",
        row_columns("r")
    );
    let rows = sqlx::query(&sql).bind(item).fetch_all(db).await?;
    Ok(rows.iter().map(|r| Value::Object(row_json(r))).collect())
}

fn sales_from() -> String {
    format!(
        "SELECT o.visit_key,extract(epoch FROM s.detected_at)::float8 AS time,
         COALESCE(sh.title,s.source_seller,'') AS title,sh.shop_id AS game_shop_id,
         COALESCE(sh.channel,o.map_channel,(s.source_location->>'channel')::int2) AS channel,
         COALESCE(sh.room,(s.source_location->>'room')::int2) AS room,o.map_id AS observed_map_id,
         (SELECT name_zh FROM maps WHERE id=o.map_id) AS map_name_zh,
         (SELECT name_en FROM maps WHERE id=o.map_id) AS map_name_en,
         COALESCE(sh.public_key,'mesowatch:'||s.external_shop_id::text) AS public_key,
         r.slot,s.item_id,s.variant_id,v.stats_hash,v.stats AS equipment,r.price,r.bundle,r.stock,
         COALESCE(NULLIF(i.name_zh,''),i.id::text) AS name_zh,i.name_en,i.icon_url,i.subcategory,
         i.req_level,i.req_job_mask,COALESCE(o.source,s.source) AS source,s.source_key,
         COALESCE(market_unit_price(r.item_id,r.price,r.bundle),s.unit_price) AS unit_price,
         s.unit_basis,s.source_location,s.unit_price AS sale_unit_price,{SALE_COLUMNS}
         FROM market_sales s
         LEFT JOIN observation_rows r ON r.observation_id=s.observation_id AND r.slot=s.slot
         LEFT JOIN observations o ON o.id=s.observation_id LEFT JOIN shops sh ON sh.id=s.shop_id
         JOIN items i ON i.id=s.item_id LEFT JOIN equipment_variants v ON v.id=s.variant_id"
    )
}

/// The item's sales since `cutoff`, newest first; equal times keep detection
/// order, as Python's stable reverse sort does.
async fn item_sales(
    db: &PgPool,
    item: i32,
    cutoff: f64,
    limit: Option<i64>,
) -> sqlx::Result<Vec<Map<String, Value>>> {
    let sql = format!(
        "{} WHERE s.item_id = $1 AND s.detected_at >= to_timestamp($2)
         ORDER BY s.detected_at DESC, s.observation_id, s.position LIMIT $3",
        sales_from()
    );
    let rows = sqlx::query(&sql)
        .bind(item)
        .bind(cutoff)
        .bind(limit)
        .fetch_all(db)
        .await?;
    Ok(rows.iter().map(sale_json).collect())
}

/// Validated `/api/v1/sales/recent` arguments (`market_sales.sales_query`).
#[derive(Debug, Clone, PartialEq)]
pub struct SalesQuery {
    pub limit: i64,
    pub before: Option<f64>,
    pub item_id: Option<i32>,
    pub category: Option<&'static str>,
}

impl SalesQuery {
    pub fn parse(get: impl Fn(&str) -> Option<String>) -> Option<Self> {
        let field = |name: &str| get(name).filter(|v| !v.is_empty());
        let decimal = |v: &str| v.chars().all(|c| c.is_ascii_digit());
        let limit = match field("limit") {
            None => 50,
            Some(v) if decimal(&v) => v.parse().ok().filter(|l| (1..=100).contains(l))?,
            Some(_) => return None,
        };
        let before = match field("before") {
            None => None,
            Some(v) => Some(
                v.trim()
                    .parse::<f64>()
                    .ok()
                    .filter(|b| 0.0 < *b && *b < 1e11)?,
            ),
        };
        let item_id = match field("item_id") {
            None => None,
            Some(v) if decimal(&v) => Some(
                v.parse()
                    .ok()
                    .filter(|i| (1_000_000..=5_999_999).contains(i))?,
            ),
            Some(_) => return None,
        };
        let category = match field("category") {
            None => None,
            Some(v) => Some(*CATEGORY_NAMES.iter().find(|c| **c == v)?),
        };
        Some(Self {
            limit,
            before,
            item_id,
            category,
        })
    }

    pub fn etag_key(&self) -> String {
        format!(
            "sales|{}|{:?}|{:?}|{:?}",
            self.limit, self.before, self.item_id, self.category
        )
    }
}

/// `recent_sales`: newest first; a page never splits sales found at the same
/// moment, so `before=next_before` continues without gaps.
pub async fn recent_sales(db: &PgPool, q: &SalesQuery, now: f64) -> sqlx::Result<Value> {
    // Only the filters in use appear in the SQL, so Postgres can keep one
    // generic plan per shape instead of planning every request.
    let mut filters = String::from("s.detected_at < to_timestamp($1)");
    if q.item_id.is_some() {
        filters.push_str(" AND s.item_id = $3");
    }
    let kinds: Vec<i32> = q
        .category
        .map(|c| category_kinds(c).iter().map(|&k| k as i32).collect())
        .unwrap_or_default();
    if q.category.is_some() {
        let n = if q.item_id.is_some() { 4 } else { 3 };
        filters.push_str(&format!(" AND s.item_id / 1000000 = ANY(${n})"));
    }
    // The page is the first `limit` sales plus any sharing the last one's
    // time; `more` says whether older sales exist past it.
    let sql = format!(
        "WITH edge AS (
             SELECT s.detected_at FROM market_sales s WHERE {filters}
             ORDER BY s.detected_at DESC, s.observation_id DESC, s.position DESC OFFSET $2 - 1 LIMIT 1
         ), more AS (
             SELECT EXISTS (SELECT 1 FROM market_sales s WHERE {filters} AND s.detected_at < (SELECT detected_at FROM edge)) AS more
         )
         {} CROSS JOIN more
         WHERE {filters} AND s.detected_at >= COALESCE((SELECT detected_at FROM edge), '-infinity')
         ORDER BY s.detected_at DESC, s.observation_id DESC, s.position DESC",
        sales_from().replacen(" FROM market_sales s", ", more.more FROM market_sales s", 1)
    );
    let mut query = sqlx::query(&sql)
        .bind(q.before.unwrap_or(f64::INFINITY))
        .bind(q.limit);
    if let Some(item) = q.item_id {
        query = query.bind(item);
    }
    if q.category.is_some() {
        query = query.bind(&kinds);
    }
    let rows = query.fetch_all(db).await?;
    let next_before = rows
        .last()
        .filter(|r| r.get::<bool, _>("more"))
        .map(|r| r.get::<f64, _>("time"));
    const FIELDS: [&str; 20] = [
        "source",
        "unit_basis",
        "id",
        "time",
        "kind",
        "item_id",
        "name_zh",
        "name_en",
        "icon_url",
        "category",
        "subcategory",
        "variant",
        "sale_price",
        "sale_unit_price",
        "bundle",
        "quantity",
        "previous_time",
        "shop",
        "location",
        "equipment",
    ];
    let sales: Vec<Value> = rows
        .iter()
        .map(|r| {
            let full = sale_json(r);
            Value::Object(
                FIELDS
                    .iter()
                    .map(|k| (k.to_string(), full[*k].clone()))
                    .collect(),
            )
        })
        .collect();
    // `as_of` is the last upload's observation time: the clock pages count
    // "ago" and the time range from, since the public site can lag by days.
    let as_of: Option<f64> =
        sqlx::query_scalar("SELECT extract(epoch FROM as_of)::float8 FROM market_state")
            .fetch_one(db)
            .await?;
    Ok(json!({"sales": sales, "next_before": next_before, "generated_at": now, "as_of": as_of}))
}

/// `market_watchlist.listing`: ids stay stable while only stock changes.
fn watch_listing(row: &Value) -> Value {
    let observed = row["time"].as_f64().expect("time");
    let day = floordiv(observed, 86400.0) as i64;
    let identity = json!([
        WORLD,
        row["shop_key"],
        day,
        row["item_id"],
        row["slot"],
        row["variant"]
    ]);
    let key = sha256_hex(pyjson::dumps(&identity, Dumps::ASCII).as_bytes())[..24].to_string();
    let offer_identity = json!([key, row["price"], row["bundle"]]);
    let offer =
        sha256_hex(pyjson::dumps(&offer_identity, Dumps::ASCII).as_bytes())[..24].to_string();
    json!({
        "id": offer, "listing_key": key, "world": WORLD, "item_id": row["item_id"], "slot": row["slot"],
        "observed": observed, "shop": row["shop"], "location": row["location"], "price": row["price"],
        "bundle": row["bundle"], "unit_price": row["unit_price"], "stock": row["stock"],
        "equipment": row["equipment"], "name_zh": row["name_zh"], "name_en": row["name_en"],
        "shop_key": row["shop_key"], "visit_id": row["visit_id"], "source": row["source"],
        "variant": row["variant"], "unit_basis": row["unit_basis"], "icon_url": row["icon_url"],
        "requires_validation": true,
    })
}

/// Group presentation rows before applying the public list limit. Raw rows stay
/// available to the notification deduplicator and market statistics unchanged.
fn grouped_quotes(rows: &[Value], limit: usize) -> Vec<Value> {
    use std::collections::{HashMap, HashSet};
    let mut groups: HashMap<String, (usize, HashSet<i64>)> = HashMap::new();
    let mut output: Vec<Value> = Vec::new();
    for row in rows {
        let equipment = &row["equipment"];
        let gear = row["item_id"]
            .as_i64()
            .is_some_and(|id| id / 1_000_000 == 1);
        let known_gear = equipment["status"] == "candidate"
            && equipment["stats"].is_array()
            && equipment["unknown_fields"]
                .as_array()
                .is_none_or(Vec::is_empty);
        let valid = row["shop_key"].as_str().is_some_and(|s| !s.is_empty())
            && row["visit_id"].as_str().is_some_and(|s| !s.is_empty())
            && row["slot"].is_i64()
            && row["observed"].as_f64().is_some_and(|v| v > 0.)
            && row["unit_price"]
                .as_f64()
                .is_some_and(|v| v.is_finite() && v >= 0.)
            && row["bundle"].as_i64().is_some_and(|v| v > 0)
            && (!gear || known_gear);
        if !valid {
            output.push(row.clone());
            continue;
        }
        let key = json!([
            row["world"],
            row["source"],
            row["shop_key"],
            row["visit_id"],
            row["observed"],
            row["item_id"],
            row["unit_price"],
            row["bundle"],
            row["unit_basis"],
            if gear { equipment.clone() } else { Value::Null }
        ])
        .to_string();
        let slot = row["slot"].as_i64().unwrap();
        if let Some((index, slots)) = groups.get_mut(&key) {
            if !slots.insert(slot) {
                continue;
            }
            let target = &mut output[*index];
            target["stock"] = match (target["stock"].as_i64(), row["stock"].as_i64()) {
                (Some(a), Some(b)) if a >= 0 && b >= 0 => {
                    a.checked_add(b).map_or(Value::Null, Value::from)
                }
                _ => Value::Null,
            };
            target["merged_count"] = json!(slots.len());
        } else {
            groups.insert(key, (output.len(), HashSet::from([slot])));
            let mut first = row.clone();
            first["merged_count"] = json!(1);
            output.push(first);
        }
    }
    output.truncate(limit);
    output
}

/// `report_listings` over the 72-hour window.
pub async fn watch_listings(db: &PgPool, items: &[i32], now: f64) -> sqlx::Result<Value> {
    let mut found: Vec<Value> = quotes(db, items, Window::recent(now).cutoff)
        .await?
        .into_iter()
        .map(|row| watch_listing(&Value::Object(row)))
        .collect();
    found.sort_by(|a, b| {
        let t = |v: &Value| v["observed"].as_f64().unwrap_or(0.0);
        t(b).total_cmp(&t(a))
            .then_with(|| a["id"].as_str().cmp(&b["id"].as_str()))
    });
    let total = found.len();
    let grouped = grouped_quotes(&found, WATCH_LIMIT);
    found.truncate(WATCH_LIMIT);
    Ok(
        json!({"listings": found, "grouped_listings": grouped, "total": total, "truncated": total > WATCH_LIMIT,
              "generated_at": now, "hours": RECENT_HOURS}),
    )
}

/// One actual latest observation per item for the price table's two recent sorts.
pub async fn latest_records(
    db: &PgPool,
    hours: Hours,
    sales: bool,
    now: f64,
) -> sqlx::Result<Value> {
    let cutoff = hours.window(now).cutoff;
    let rows = if sales {
        let sql = format!(
            "WITH latest AS MATERIALIZED (
              SELECT pick.id FROM item_stats st CROSS JOIN LATERAL (
                SELECT id FROM sales WHERE item_id=st.item_id AND detected_at>=to_timestamp($1)
                ORDER BY detected_at DESC,observation_id DESC NULLS LAST,
                  position DESC NULLS LAST,source_key LIMIT 1
              ) pick
            ) {}",
            sales_from().replacen(
                "FROM market_sales s",
                "FROM latest JOIN market_sales s ON s.id=latest.id",
                1
            )
        );
        sqlx::query(&sql)
            .bind(cutoff)
            .fetch_all(db)
            .await?
            .iter()
            .map(sale_json)
            .collect::<Vec<_>>()
    } else {
        let sql = format!(
            "WITH latest AS MATERIALIZED (
            SELECT pick.* FROM item_stats st CROSS JOIN LATERAL (
              SELECT l.* FROM listings l WHERE l.item_id=st.item_id
                AND l.stock>0 AND l.last_seen_at>=to_timestamp($1)
              ORDER BY l.last_seen_at DESC,l.observation_id DESC,l.slot LIMIT 1
            ) pick
          ) SELECT {} FROM latest l JOIN shops sh ON sh.id=l.shop_id
          JOIN observations o ON o.id=l.observation_id JOIN items i ON i.id=l.item_id
          LEFT JOIN equipment_variants v ON v.id=l.variant_id",
            row_columns("l")
        );
        let mut rows = sqlx::query(&sql)
            .bind(cutoff)
            .fetch_all(db)
            .await?
            .iter()
            .map(row_json)
            .collect::<Vec<_>>();
        rows.extend(crate::external::latest_quote_rows(db, cutoff).await?);
        rows
    };
    let mut latest = std::collections::BTreeMap::<i64, Value>::new();
    for mut row in rows {
        let item = row["item_id"].as_i64().expect("item id");
        let time = row["time"].as_f64().expect("observation time");
        if latest
            .get(&item)
            .is_some_and(|old| old["time"].as_f64().unwrap_or(0.0) >= time)
        {
            continue;
        }
        if !sales {
            let listing = watch_listing(&Value::Object(row.clone()));
            row.insert("id".into(), listing["id"].clone());
            row.insert("observed".into(), json!(time));
        }
        row.retain(|key, _| {
            matches!(
                key.as_str(),
                "id" | "item_id"
                    | "name_zh"
                    | "name_en"
                    | "icon_url"
                    | "shop"
                    | "source"
                    | "location"
                    | "time"
                    | "observed"
                    | "unit_price"
                    | "sale_unit_price"
                    | "unit_basis"
                    | "stock"
                    | "bundle"
                    | "kind"
                    | "quantity"
                    | "equipment"
            )
        });
        latest.insert(item, Value::Object(row));
    }
    Ok(
        json!({"records":latest.into_values().collect::<Vec<_>>(),"hours":hours.json(),"generated_at":now}),
    )
}

/// Latest active observations, not per-item minimum prices. Narrowing to the
/// newest `limit` item ids still contains the newest `limit` individual quotes.
pub async fn recent_quotes(db: &PgPool, hours: Hours, limit: i64, now: f64) -> sqlx::Result<Value> {
    let cutoff = hours.window(now).cutoff;
    let items: Vec<i32> = sqlx::query_scalar(
        "SELECT item_id FROM (
            SELECT st.item_id,pick.last_seen_at AS seen FROM item_stats st CROSS JOIN LATERAL (
              SELECT last_seen_at FROM listings WHERE item_id=st.item_id
                AND stock>0 AND last_seen_at>=to_timestamp($1)
              ORDER BY last_seen_at DESC,observation_id DESC,slot LIMIT 1
            ) pick
            UNION ALL
            SELECT item_id, max(seen_at) AS seen FROM external_market_listings
            WHERE up AND seen_at>=to_timestamp($1) GROUP BY item_id
         ) latest GROUP BY item_id ORDER BY max(seen) DESC, item_id LIMIT $2",
    )
    .bind(cutoff)
    .bind(limit)
    .fetch_all(db)
    .await?;
    let mut rows: Vec<_> = quotes(db, &items, cutoff)
        .await?
        .into_iter()
        .filter(|row| row["time"].as_f64().is_some_and(|time| time >= cutoff))
        .map(|mut row| {
            let listing = watch_listing(&Value::Object(row.clone()));
            row.insert("id".into(), listing["id"].clone());
            row.insert("observed".into(), row["time"].clone());
            Value::Object(row)
        })
        .collect();
    rows.sort_by(|a, b| {
        b["observed"]
            .as_f64()
            .unwrap_or(0.0)
            .total_cmp(&a["observed"].as_f64().unwrap_or(0.0))
            .then_with(|| a["id"].as_str().cmp(&b["id"].as_str()))
    });
    let grouped = grouped_quotes(&rows, limit as usize);
    rows.truncate(limit as usize);
    Ok(json!({"listings":rows,"grouped_listings":grouped,"generated_at":now,"hours":hours.json()}))
}

/// Fresh observations received from the signed-in collector.
pub async fn personal_watch_listings(
    db: &PgPool,
    collector: i64,
    items: &[i32],
    now: f64,
) -> sqlx::Result<Value> {
    let sql = format!(
        "SELECT {} FROM observation_rows r
        JOIN observations o ON o.id=r.observation_id JOIN shops sh ON sh.id=o.shop_id
        JOIN items i ON i.id=r.item_id LEFT JOIN equipment_variants v ON v.id=r.variant_id
        WHERE o.collector_id=$1 AND r.item_id=ANY($2) AND r.stock>0
          AND o.observed_at>=to_timestamp($3) AND o.observed_at<=to_timestamp($4)
          AND o.received_at>=to_timestamp($3)
        ORDER BY o.observed_at DESC,o.id DESC,r.position LIMIT 2000",
        row_columns("r")
    );
    let rows = sqlx::query(&sql)
        .bind(collector)
        .bind(items)
        .bind(now - 120.0)
        .bind(now)
        .fetch_all(db)
        .await?;
    let mut ids = std::collections::HashSet::new();
    let mut found = Vec::new();
    for row in &rows {
        let value = watch_listing(&Value::Object(row_json(row)));
        if ids.insert(value["id"].as_str().unwrap_or_default().to_string()) {
            found.push(value);
        }
    }
    let total = found.len();
    found.truncate(WATCH_LIMIT);
    Ok(
        json!({"personal":true,"listings":found,"total":total,"truncated":total>WATCH_LIMIT||rows.len()==2000,"generated_at":now}),
    )
}

/// `parse_item_ids`: at most 100 comma-separated item ids.
pub fn parse_item_ids(value: &str) -> Option<Vec<i32>> {
    if value.is_empty() {
        return Some(vec![]);
    }
    let parts: Vec<&str> = value.split(',').collect();
    if parts.len() > 100 {
        return None;
    }
    let mut ids: Vec<i32> = parts
        .iter()
        .map(|p| {
            p.chars()
                .all(|c| c.is_ascii_digit())
                .then(|| p.parse().ok())
                .flatten()
                .filter(|id| (1_000_000..=5_999_999).contains(id))
        })
        .collect::<Option<_>>()?;
    ids.sort_unstable();
    ids.dedup();
    Some(ids)
}

/// `search_catalog`: ID lookup or unordered keywords across both names.
pub async fn search_catalog(db: &PgPool, query: &str) -> sqlx::Result<Value> {
    let query = crate::search::normalize(&query.trim().chars().take(100).collect::<String>());
    let select = "SELECT id, COALESCE(NULLIF(name_zh, ''), id::text), COALESCE(name_en, ''), icon_url, req_level, subcategory FROM items";
    let item = |r: &PgRow| {
        json!({"item_id": r.get::<i32, _>(0), "name_zh": r.get::<String, _>(1), "name_en": r.get::<String, _>(2),
               "icon_url": r.get::<Option<String>, _>(3), "level": r.get::<Option<i16>, _>(4),
               "subcategory": r.get::<Option<String>, _>(5)})
    };
    let rows = if !query.is_empty() && query.chars().all(|c| c.is_ascii_digit()) {
        match query.parse::<i32>() {
            Ok(id) if (1_000_000..=5_999_999).contains(&id) => {
                sqlx::query(&format!("{select} WHERE id = $1"))
                    .bind(id)
                    .fetch_all(db)
                    .await?
            }
            _ => vec![],
        }
    } else if !query.is_empty() {
        let prefix = format!(
            "{}%",
            query
                .replace('\\', "\\\\")
                .replace('%', "\\%")
                .replace('_', "\\_")
        );
        let filter = crate::search::filter_sql("id", &["name_zh", "name_en"], "$3");
        sqlx::query(&format!(
            "{select} WHERE {filter}
             ORDER BY CASE WHEN lower(name_zh)=$1 OR lower(name_en)=$1 THEN 0
             WHEN name_zh ILIKE $2 OR name_en ILIKE $2 THEN 1 ELSE 2 END, id LIMIT $4"
        ))
        .bind(&query)
        .bind(prefix)
        .bind(crate::search::patterns(&query))
        .bind(CATALOG_LIMIT)
        .fetch_all(db)
        .await?
    } else {
        vec![]
    };
    let presets = sqlx::query(&format!("{select} WHERE id = ANY($1) ORDER BY id"))
        .bind(&ARCHER_PRESET[..])
        .fetch_all(db)
        .await?;
    Ok(json!({
        "items": rows.iter().map(item).collect::<Vec<_>>(),
        "presets": [{"id": "archer_25_30", "name_zh": "25 / 30级弓与弩", "name_en": "Level 25 / 30 bows & crossbows",
                     "items": presets.iter().map(item).collect::<Vec<_>>()}],
    }))
}

/// `/api/v1/items/<id>`: the catalogue record.
pub async fn agent_listings(
    db: &PgPool,
    item: i32,
    limit: i64,
    channel: Option<i16>,
    max_price: Option<f64>,
    now: f64,
) -> sqlx::Result<Value> {
    let sql = format!(
        "SELECT {} FROM listings l
         JOIN shops sh ON sh.id=l.shop_id JOIN observations o ON o.id=l.observation_id
         JOIN items i ON i.id=l.item_id LEFT JOIN equipment_variants v ON v.id=l.variant_id
         WHERE l.item_id=$1 AND l.stock>0 AND sh.last_seen_at>=to_timestamp($2)
         AND o.observed_at<=to_timestamp($6)
         AND ($4::int2 IS NULL OR COALESCE(sh.channel,o.map_channel)=$4)
         AND ($5::float8 IS NULL OR market_unit_price(l.item_id,l.price,l.bundle)<=$5)
         ORDER BY market_unit_price(l.item_id,l.price,l.bundle),o.observed_at DESC,sh.public_key,l.slot LIMIT $3",
        row_columns("l"));
    let rows = sqlx::query(&sql)
        .bind(item)
        .bind(now - 72.0 * 3600.0)
        .bind(limit + 1)
        .bind(channel)
        .bind(max_price)
        .bind(now)
        .fetch_all(db)
        .await?;
    let mut found: Vec<Value> = rows.iter().map(|r| Value::Object(row_json(r))).collect();
    let external: Vec<Value> = sqlx::query_scalar(
        "SELECT to_jsonb(x) FROM (SELECT item_id,source,unit_basis,unit_price,seller AS shop,
         location,extract(epoch FROM seen_at)::float8 AS time,NULL::int AS stock,NULL::jsonb AS equipment
         FROM external_market_listings WHERE item_id=$1 AND up AND seen_at>=to_timestamp($2)
         AND seen_at<=to_timestamp($6)
         AND ($4::int2 IS NULL OR (location->>'channel')::int2=$4)
         AND ($5::float8 IS NULL OR unit_price<=$5)
         ORDER BY unit_price,seen_at DESC,source_key LIMIT $3) x")
        .bind(item).bind(now-72.0*3600.0).bind(limit+1).bind(channel).bind(max_price).bind(now)
        .fetch_all(db).await?;
    found.extend(external);
    found.sort_by(|a, b| {
        a["unit_price"]
            .as_f64()
            .unwrap_or(f64::INFINITY)
            .total_cmp(&b["unit_price"].as_f64().unwrap_or(f64::INFINITY))
    });
    let truncated = found.len() > limit as usize;
    found.truncate(limit as usize);
    Ok(
        json!({"item_id":item,"listings":found,"truncated":truncated,"hours":72,
        "order":"unit_price_ascending","item_url":format!("/item/{item}")}),
    )
}

pub async fn agent_sales(
    db: &PgPool,
    item: Option<i32>,
    limit: i64,
    hours: i32,
    now: f64,
) -> sqlx::Result<Value> {
    let sql = format!(
        "{} WHERE ($1::int IS NULL OR s.item_id=$1)
        AND s.detected_at>=to_timestamp($2) AND s.detected_at<=to_timestamp($4)
        ORDER BY s.detected_at DESC,s.id DESC LIMIT $3",
        sales_from()
    );
    let rows = sqlx::query(&sql)
        .bind(item)
        .bind(now - f64::from(hours) * 3600.0)
        .bind(limit + 1)
        .bind(now)
        .fetch_all(db)
        .await?;
    let truncated = rows.len() > limit as usize;
    let sales: Vec<Value> = rows
        .iter()
        .take(limit as usize)
        .map(|r| Value::Object(sale_json(r)))
        .collect();
    Ok(json!({"sales":sales,"hours":hours,"truncated":truncated}))
}

pub async fn agent_advice(db: &PgPool, item: i32, hours: i32, now: f64) -> sqlx::Result<Value> {
    let product = products(db, Hours::Recent, Some(item), true)
        .await?
        .pop()
        .map(|p| summary_product(&p, Hours::Recent));
    let period: Value = sqlx::query_scalar(
        "SELECT to_jsonb(x) FROM (SELECT count(*) AS evidence_count,
         percentile_cont(0.5) WITHIN GROUP (ORDER BY unit_price) AS median,
         percentile_cont(0.25) WITHIN GROUP (ORDER BY unit_price) AS low_quartile,
         percentile_cont(0.75) WITHIN GROUP (ORDER BY unit_price) AS high_quartile,
         max(extract(epoch FROM detected_at)::float8) AS latest_evidence_at
         FROM market_sales WHERE item_id=$1 AND detected_at>=to_timestamp($2)
         AND detected_at<=to_timestamp($3)) x",
    )
    .bind(item)
    .bind(now - f64::from(hours) * 3600.0)
    .bind(now)
    .fetch_one(db)
    .await?;
    let as_of: Option<f64> =
        sqlx::query_scalar("SELECT extract(epoch FROM as_of)::float8 FROM market_state")
            .fetch_one(db)
            .await?;
    Ok(
        json!({"item_id":item,"product":product,"sale_evidence":period,"hours":hours,
        "as_of":as_of,"recommendation_hours":72,"unit_basis":crate::external::unit(item),
        "item_url":format!("/item/{item}")}),
    )
}

pub async fn item_record(db: &PgPool, item: i32) -> sqlx::Result<Option<Value>> {
    sqlx::query_scalar("SELECT record FROM item_records WHERE item_id = $1")
        .bind(item)
        .fetch_optional(db)
        .await
}

#[cfg(test)]
mod tests {
    use super::*;

    fn query(pairs: &[(&str, &str)]) -> Option<SalesQuery> {
        SalesQuery::parse(|name| {
            pairs
                .iter()
                .find(|(k, _)| *k == name)
                .map(|(_, v)| v.to_string())
        })
    }

    #[test]
    fn sales_query_matches_python_validation() {
        assert_eq!(query(&[]).unwrap().limit, 50);
        let q = query(&[
            ("limit", "5"),
            ("before", "1.5"),
            ("item_id", "4000000"),
            ("category", "装备"),
        ])
        .unwrap();
        assert_eq!(
            q,
            SalesQuery {
                limit: 5,
                before: Some(1.5),
                item_id: Some(4_000_000),
                category: Some("装备")
            }
        );
        for bad in [
            [("limit", "0")],
            [("limit", "101")],
            [("limit", "-1")],
            [("before", "nan")],
            [("before", "x")],
            [("item_id", "42")],
            [("category", "weapons")],
        ] {
            assert_eq!(query(&bad), None, "{bad:?}");
        }
    }

    #[test]
    fn item_ids_are_bounded() {
        assert_eq!(
            parse_item_ids("4010001,1452003"),
            Some(vec![1_452_003, 4_010_001])
        );
        assert_eq!(parse_item_ids(""), Some(vec![]));
        assert_eq!(parse_item_ids("evil"), None);
        assert_eq!(parse_item_ids(&vec!["4010001"; 101].join(",")), None);
    }

    #[test]
    fn quote_groups_sum_all_slots_before_limiting_and_preserve_raw_rows() {
        let row = json!({"shop_key":"shop","visit_id":"visit","observed":12345.,"item_id":5680001,
            "slot":1,"id":"one","unit_price":40000.,"stock":1,"bundle":1});
        let mut second = row.clone();
        second["slot"] = json!(2);
        second["id"] = json!("two");
        let mut other = row.clone();
        other["shop_key"] = json!("other");
        let raw = vec![row.clone(), other, second.clone(), row.clone()];
        let grouped = grouped_quotes(&raw, 1);
        assert_eq!(grouped.len(), 1);
        assert_eq!(grouped[0]["stock"], 2);
        assert_eq!(grouped[0]["merged_count"], 2);
        assert_eq!(raw[0]["stock"], 1);
        for (key, value) in [
            ("visit_id", json!("new")),
            ("unit_price", json!(45000.)),
            ("bundle", json!(2)),
        ] {
            let mut changed = second.clone();
            changed[key] = value;
            assert_eq!(grouped_quotes(&[row.clone(), changed], 200).len(), 2);
        }
        let mut gear = row.clone();
        gear["item_id"] = json!(1452003);
        let mut gear2 = gear.clone();
        gear2["slot"] = json!(2);
        assert_eq!(grouped_quotes(&[gear.clone(), gear2.clone()], 200).len(), 2);
        let eq = json!({"status":"candidate","stats":[{"key":"weapon_attack","value":50}],"unknown_fields":[]});
        gear["equipment"] = eq.clone();
        gear2["equipment"] = eq;
        assert_eq!(
            grouped_quotes(&[gear.clone(), gear2.clone()], 200)[0]["stock"],
            2
        );
        gear2["equipment"]["stats"][0]["value"] = json!(51);
        assert_eq!(grouped_quotes(&[gear, gear2], 200).len(), 2);
    }

    #[test]
    fn watch_listing_ids_match_python() {
        // market_watchlist.listing(dict(world=..., shop_key='k', time=86400.5, item_id=4010001, slot=4001,
        //   variant='standard', price=500, bundle=1, stock=8, shop='Shop'))['id' / 'listing_key']
        let row = json!({"shop_key": "k", "time": 86400.5, "item_id": 4010001, "slot": 4001, "variant": "standard",
                         "price": 500, "bundle": 1, "stock": 8, "shop": "Shop", "unit_price": 500.0,
                         "visit_id": "visit", "source": "packet"});
        let listing = watch_listing(&row);
        assert_eq!(listing["listing_key"], "ce2a01ff19180d0cbf9e9c9b");
        assert_eq!(listing["id"], "718651cd4234c9a7c142fbf6");
        assert_eq!(listing["shop_key"], "k");
        assert_eq!(listing["visit_id"], "visit");
        assert_eq!(listing["slot"], 4001);
        assert_eq!(listing["source"], "packet");
    }
}

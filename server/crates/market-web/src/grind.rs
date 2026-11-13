//! Grind tracker: run summaries uploaded by collectors, the prices and names
//! the tracker needs, and per-map results by level band and job.
use std::collections::{BTreeMap, HashMap, HashSet};

use axum::{
    body::Bytes,
    extract::{Path, RawQuery, State},
    http::{header, HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    routing::{get, post},
    Json, Router,
};
use serde::Deserialize;
use serde_json::{json, Value};
use sqlx::PgPool;

use crate::api::{bearer, error, internal, reader, ClientAddr};
use crate::{auth, unix_now, AppState};

/// Segments shorter than this are kept but not shown in map results.
pub const MIN_SHOWN_SECONDS: i32 = 300;
const RESULT_DAYS: f64 = 90.0;
const SALE_DAYS: f64 = 30.0;

/// id, Chinese name, English name, median sale, cheapest NPC shop price.
type ItemRow = (
    i32,
    Option<String>,
    Option<String>,
    Option<f64>,
    Option<i64>,
);
/// id, Chinese name, English name, quantity, runs that saw it.
type DropRow = (i32, Option<String>, Option<String>, i64, i64);

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/api/v1/collector/grind-session", post(upload))
        .route("/api/v1/grind/prices", get(prices))
        .route("/api/v1/grind/map/{id}", get(map_results))
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Upload {
    pub event_id: String,
    pub started_at: f64,
    pub ended_at: f64,
    pub segments: Vec<SegmentIn>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SegmentIn {
    pub map_id: i32,
    pub job: Option<i32>,
    pub level: Option<i16>,
    pub active_seconds: i32,
    pub exp: i64,
    pub kills: i32,
    pub kills_estimated: bool,
    pub mesos: i64,
    pub item_value: i64,
    pub consume_cost: i64,
    #[serde(default)]
    pub drops: Vec<Count>,
    #[serde(default)]
    pub mobs: Vec<MobCount>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Count {
    pub item_id: i32,
    pub quantity: i32,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct MobCount {
    pub mob_id: i32,
    pub kills: i32,
}

impl Upload {
    pub fn valid(&self, now: f64) -> bool {
        let span = self.ended_at - self.started_at;
        self.event_id.len() == 32
            && self.event_id.bytes().all(|b| b.is_ascii_hexdigit())
            && self.started_at.is_finite()
            && self.ended_at.is_finite()
            && self.started_at >= now - 30. * 86400.
            && self.ended_at <= now + 120.
            && span >= 0.
            && (1..=50).contains(&self.segments.len())
            && self
                .segments
                .iter()
                .map(|s| f64::from(s.active_seconds))
                .sum::<f64>()
                <= span + 120.
            && self.segments.iter().all(SegmentIn::valid)
    }
}

impl SegmentIn {
    fn valid(&self) -> bool {
        let unique_drops = self
            .drops
            .iter()
            .map(|d| d.item_id)
            .collect::<HashSet<_>>()
            .len()
            == self.drops.len();
        let unique_mobs = self
            .mobs
            .iter()
            .map(|m| m.mob_id)
            .collect::<HashSet<_>>()
            .len()
            == self.mobs.len();
        (0..1_000_000_000).contains(&self.map_id)
            && self.job.is_none_or(|j| (0..10_000).contains(&j))
            && self.level.is_none_or(|l| (1..=250).contains(&l))
            && (60..=86_400).contains(&self.active_seconds)
            && (0..=10_000_000_000_000).contains(&self.exp)
            && (0..=1_000_000).contains(&self.kills)
            && (0..=1_000_000_000_000).contains(&self.mesos)
            && (0..=10_000_000_000_000).contains(&self.item_value)
            && (0..=10_000_000_000_000).contains(&self.consume_cost)
            && self.drops.len() <= 200
            && self.mobs.len() <= 50
            && unique_drops
            && unique_mobs
            && self.drops.iter().all(|d| {
                (1..100_000_000).contains(&d.item_id) && (1..=1_000_000).contains(&d.quantity)
            })
            && self
                .mobs
                .iter()
                .all(|m| (1..100_000_000).contains(&m.mob_id) && (1..=1_000_000).contains(&m.kills))
    }
}

/// Stores one run; a repeated event ID from the same collector is a no-op.
pub async fn ingest(db: &PgPool, collector: i64, run: &Upload) -> sqlx::Result<bool> {
    let mut tx = db.begin().await?;
    let id: Option<i64> = sqlx::query_scalar(
        "INSERT INTO grind_sessions (collector_id, event_id, started_at, ended_at)
         VALUES ($1, $2, to_timestamp($3), to_timestamp($4))
         ON CONFLICT (collector_id, event_id) DO NOTHING RETURNING id",
    )
    .bind(collector)
    .bind(&run.event_id)
    .bind(run.started_at)
    .bind(run.ended_at)
    .fetch_optional(&mut *tx)
    .await?;
    let Some(id) = id else {
        return Ok(false);
    };
    for (idx, s) in run.segments.iter().enumerate() {
        let idx = idx as i16;
        sqlx::query(
            "INSERT INTO grind_segments (session_id, idx, map_id, job, level, active_seconds, exp, kills,
             kills_estimated, mesos, item_value, consume_cost) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)",
        )
        .bind(id)
        .bind(idx)
        .bind(s.map_id)
        .bind(s.job)
        .bind(s.level)
        .bind(s.active_seconds)
        .bind(s.exp)
        .bind(s.kills)
        .bind(s.kills_estimated)
        .bind(s.mesos)
        .bind(s.item_value)
        .bind(s.consume_cost)
        .execute(&mut *tx)
        .await?;
        if !s.drops.is_empty() {
            let items: Vec<i32> = s.drops.iter().map(|d| d.item_id).collect();
            let counts: Vec<i32> = s.drops.iter().map(|d| d.quantity).collect();
            sqlx::query(
                "INSERT INTO grind_drops (session_id, idx, item_id, quantity)
                 SELECT $1, $2, * FROM unnest($3::int[], $4::int[])",
            )
            .bind(id)
            .bind(idx)
            .bind(&items)
            .bind(&counts)
            .execute(&mut *tx)
            .await?;
        }
        if !s.mobs.is_empty() {
            let mobs: Vec<i32> = s.mobs.iter().map(|m| m.mob_id).collect();
            let kills: Vec<i32> = s.mobs.iter().map(|m| m.kills).collect();
            sqlx::query(
                "INSERT INTO grind_mobs (session_id, idx, mob_id, kills)
                 SELECT $1, $2, * FROM unnest($3::int[], $4::int[])",
            )
            .bind(id)
            .bind(idx)
            .bind(&mobs)
            .bind(&kills)
            .execute(&mut *tx)
            .await?;
        }
    }
    tx.commit().await?;
    Ok(true)
}

async fn upload(State(state): State<AppState>, headers: HeaderMap, body: Bytes) -> Response {
    let collector = match auth::authenticate(&state.db, bearer(&headers)).await {
        Ok(Some(c)) => c,
        Ok(None) => return error(StatusCode::UNAUTHORIZED, "Collector token required"),
        Err(e) => return internal(e),
    };
    if !state
        .limiter
        .allow(&format!("grind-session:{}", collector.id), 30)
    {
        return error(StatusCode::TOO_MANY_REQUESTS, "Rate limited");
    }
    let run = match serde_json::from_slice::<Upload>(&body) {
        Ok(run) if run.valid(unix_now()) => run,
        _ => return error(StatusCode::BAD_REQUEST, "Invalid grind session"),
    };
    match ingest(&state.db, collector.id, &run).await {
        Ok(created) => Json(json!({"ok": true, "created": created})).into_response(),
        Err(e) => internal(e),
    }
}

fn ids_param(query: &Option<String>, name: &str) -> Option<Vec<i32>> {
    let raw = query
        .as_deref()?
        .split('&')
        .find_map(|pair| pair.strip_prefix(name).and_then(|v| v.strip_prefix('=')))
        .unwrap_or("");
    if raw.is_empty() {
        return Some(vec![]);
    }
    let ids: Option<Vec<i32>> = raw
        .split("%2C")
        .flat_map(|part| part.split(','))
        .map(|v| v.parse().ok().filter(|id| (1..1_000_000_000).contains(id)))
        .collect();
    ids.filter(|ids| ids.len() <= 100)
}

/// `{"prices": {"<item>": {name, typical, npc_shop, npc_sell, groups}},
///   "maps": {"<map>": {name, is_town}}, "mobs": {"<mob>": {name}}}`.
/// Loot is priced from the last 72 hours of sales only: prices move fast, and
/// a 30-day median kept old prices (2026-11-12: a 73-attack 九龙刀 at 750 000
/// from late October, while it sold for 350 000 to 550 000 that week).
const RECENT_SECONDS: f64 = 72.0 * 3600.0;

fn recent_prices(newest_first: &[(f64, f64)], now: f64) -> Vec<f64> {
    newest_first
        .iter()
        .filter(|(at, _)| now - at <= RECENT_SECONDS)
        .map(|(_, price)| *price)
        .collect()
}

pub async fn price_rows(
    db: &PgPool,
    items: &[i32],
    maps: &[i32],
    mobs: &[i32],
    now: f64,
) -> sqlx::Result<Value> {
    let rows: Vec<ItemRow> = sqlx::query_as(
        "SELECT i.id, COALESCE(NULLIF(i.name_zh, ''), i.name_en), i.name_en, s.typical::float8,
         (SELECT min(sh.price)::int8 FROM npc_shops sh JOIN npcs np ON np.id = sh.npc_id
           WHERE sh.item_id = i.id AND sh.price >= 0 AND NOT np.unreleased)
         FROM items i LEFT JOIN item_stats s ON s.item_id = i.id WHERE i.id = ANY($1)",
    )
    .bind(items)
    .fetch_all(db)
    .await?;
    let sell: HashMap<i32, i64> = crate::bestiary::queries::npc_sell_prices(db, items)
        .await?
        .into_iter()
        .collect();
    let equipment: Vec<i32> = items
        .iter()
        .copied()
        .filter(|id| id / 1_000_000 == 1)
        .collect();
    let sales: Vec<(i32, Value, f64, f64)> = if equipment.is_empty() {
        vec![]
    } else {
        sqlx::query_as(
            "SELECT s.item_id, v.stats, s.unit_price::float8, extract(epoch FROM s.detected_at)::float8 FROM market_sales s
             JOIN equipment_variants v ON v.id = s.variant_id
             WHERE s.item_id = ANY($1) AND s.detected_at >= to_timestamp($2) AND s.unit_price > 0
             ORDER BY s.detected_at DESC",
        )
        .bind(&equipment)
        .bind(now - SALE_DAYS * 86400.)
        .fetch_all(db)
        .await?
    };
    // Current stock per attribute group: its lowest ask prices a drop whose group
    // did not sell in the last 72 hours better than the whole item's median.
    let asks: Vec<(i32, Value, f64)> = if equipment.is_empty() {
        vec![]
    } else {
        sqlx::query_as(
            "SELECT l.item_id, v.stats, market_unit_price(l.item_id, l.price, l.bundle)::float8 FROM listings l
             JOIN equipment_variants v ON v.id = l.variant_id
             WHERE l.item_id = ANY($1) AND l.stock > 0 AND l.price > 0 AND l.last_seen_at >= to_timestamp($2)",
        )
        .bind(&equipment)
        .bind(now - RECENT_SECONDS)
        .fetch_all(db)
        .await?
    };
    let mut lowest: HashMap<(i32, String), f64> = HashMap::new();
    for (item, stats, price) in asks {
        let slot = lowest.entry((item, crate::bestiary::queries::equipment_group_json(&stats))).or_insert(price);
        *slot = slot.min(price);
    }
    let mut groups: HashMap<i32, BTreeMap<String, Vec<(f64, f64)>>> = HashMap::new();
    for (item, stats, price, at) in sales {
        groups
            .entry(item)
            .or_default()
            .entry(crate::bestiary::queries::equipment_group_json(&stats))
            .or_default()
            .push((at, price));
    }
    // Every item's own median over the same 72 hours; the site's figure only
    // when it did not sell in that time.
    let recent: HashMap<i32, f64> = sqlx::query_as::<_, (i32, f64)>(
        "SELECT item_id, percentile_cont(0.5) WITHIN GROUP (ORDER BY unit_price)::float8 FROM market_sales
         WHERE item_id = ANY($1) AND detected_at >= to_timestamp($2) AND unit_price > 0 GROUP BY item_id",
    )
    .bind(items)
    .bind(now - RECENT_SECONDS)
    .fetch_all(db)
    .await?
    .into_iter()
    .collect();
    let mut prices = serde_json::Map::new();
    for (id, zh, en, typical, shop) in rows {
        let typical = recent.get(&id).copied().or(typical);
        let mut sold = groups.remove(&id).unwrap_or_default();
        let mut keys: Vec<String> = sold.keys().cloned().collect();
        keys.extend(lowest.keys().filter(|(item, _)| *item == id).map(|(_, key)| key.clone()));
        keys.sort();
        keys.dedup();
        let item_groups: Vec<Value> = keys
            .into_iter()
            .filter_map(|key| {
                let mut values = recent_prices(&sold.remove(&key).unwrap_or_default(), now);
                values.sort_by(f64::total_cmp);
                let ask = lowest.get(&(id, key.clone())).copied();
                (!values.is_empty() || ask.is_some()).then(|| json!({"key": key,
                    "median": median(&values), "sales": values.len(), "lowest_ask": ask}))
            })
            .collect();
        prices.insert(
            id.to_string(),
            json!({"name": zh, "name_en": en, "typical": typical, "npc_shop": shop,
                   "npc_sell": sell.get(&id), "groups": item_groups}),
        );
    }
    let map_rows: Vec<(i32, String, String, bool)> = sqlx::query_as(
        "SELECT id, COALESCE(NULLIF(name_zh, ''), NULLIF(name_tw, ''), name_en), name_en, is_town
         FROM maps WHERE id = ANY($1)",
    )
    .bind(maps)
    .fetch_all(db)
    .await?;
    let mob_rows: Vec<(i32, String, String)> = sqlx::query_as(
        "SELECT id, COALESCE(NULLIF(name_zh, ''), NULLIF(name_tw, ''), name_en), name_en FROM mobs WHERE id = ANY($1)",
    )
    .bind(mobs)
    .fetch_all(db)
    .await?;
    Ok(json!({
        "prices": prices,
        "maps": map_rows.into_iter().map(|(id, zh, en, town)| (id.to_string(), json!({"name": zh, "name_en": en, "is_town": town}))).collect::<serde_json::Map<_, _>>(),
        "mobs": mob_rows.into_iter().map(|(id, zh, en)| (id.to_string(), json!({"name": zh, "name_en": en}))).collect::<serde_json::Map<_, _>>(),
    }))
}

fn median(sorted: &[f64]) -> Option<f64> {
    match sorted.len() {
        0 => None,
        n if n % 2 == 1 => Some(sorted[n / 2]),
        n => Some((sorted[n / 2 - 1] + sorted[n / 2]) / 2.0),
    }
}

async fn prices(
    State(state): State<AppState>,
    ClientAddr(addr): ClientAddr,
    headers: HeaderMap,
    RawQuery(query): RawQuery,
) -> Response {
    if let Err(response) = reader(&state, &headers, &addr, "grind-prices").await {
        return response;
    }
    let (Some(items), Some(maps), Some(mobs)) = (
        ids_param(&query, "ids"),
        ids_param(&query, "maps"),
        ids_param(&query, "mobs"),
    ) else {
        return error(StatusCode::BAD_REQUEST, "Invalid IDs");
    };
    match price_rows(&state.db, &items, &maps, &mobs, unix_now()).await {
        Ok(value) => (
            [(header::CACHE_CONTROL, "private, max-age=300")],
            Json(value),
        )
            .into_response(),
        Err(err) => internal(err),
    }
}

/// Map results: one row per (level band of 5, job) with the middle half of
/// per-segment hourly rates, plus drops per thousand kills.
pub async fn map_summary(db: &PgPool, map: i32, now: f64) -> sqlx::Result<Value> {
    type Row = (
        i16,
        Option<i32>,
        i64,
        i64,
        f64,
        f64,
        f64,
        f64,
        f64,
        f64,
        f64,
        f64,
    );
    let rows: Vec<Row> = sqlx::query_as(
        "WITH s AS (
           SELECT ((g.level - 1) / 5) * 5 + 1 AS band, g.job, g.session_id, g.active_seconds,
                  g.exp * 3600.0 / g.active_seconds AS exp_h,
                  (g.mesos + g.item_value - g.consume_cost) * 3600.0 / g.active_seconds AS net_h,
                  g.mesos * 3600.0 / g.active_seconds AS mesos_h,
                  g.kills * 3600.0 / g.active_seconds AS kills_h, g.kills
           FROM grind_segments g JOIN grind_sessions x ON x.id = g.session_id
           WHERE g.map_id = $1 AND g.level IS NOT NULL AND g.active_seconds >= $2
             AND x.ended_at >= to_timestamp($3))
         SELECT band::int2, job, count(DISTINCT session_id), sum(active_seconds)::int8,
           percentile_cont(0.25) WITHIN GROUP (ORDER BY exp_h), percentile_cont(0.5) WITHIN GROUP (ORDER BY exp_h),
           percentile_cont(0.75) WITHIN GROUP (ORDER BY exp_h),
           percentile_cont(0.25) WITHIN GROUP (ORDER BY net_h), percentile_cont(0.5) WITHIN GROUP (ORDER BY net_h),
           percentile_cont(0.75) WITHIN GROUP (ORDER BY net_h),
           percentile_cont(0.5) WITHIN GROUP (ORDER BY mesos_h), percentile_cont(0.5) WITHIN GROUP (ORDER BY kills_h)
         FROM s GROUP BY band, job ORDER BY band, job",
    )
    .bind(map)
    .bind(MIN_SHOWN_SECONDS)
    .bind(now - RESULT_DAYS * 86400.)
    .fetch_all(db)
    .await?;
    let drops: Vec<DropRow> = sqlx::query_as(
        "WITH seg AS (
           SELECT g.session_id, g.idx, g.kills FROM grind_segments g JOIN grind_sessions x ON x.id = g.session_id
           WHERE g.map_id = $1 AND g.active_seconds >= $2 AND x.ended_at >= to_timestamp($3))
         SELECT d.item_id, COALESCE(NULLIF(i.name_zh, ''), i.name_en), i.name_en, sum(d.quantity)::int8,
           count(DISTINCT d.session_id)::int8
         FROM grind_drops d JOIN seg ON seg.session_id = d.session_id AND seg.idx = d.idx
         LEFT JOIN items i ON i.id = d.item_id
         GROUP BY d.item_id, i.name_zh, i.name_en ORDER BY sum(d.quantity) DESC LIMIT 40",
    )
    .bind(map)
    .bind(MIN_SHOWN_SECONDS)
    .bind(now - RESULT_DAYS * 86400.)
    .fetch_all(db)
    .await?;
    let total_kills: i64 = sqlx::query_scalar(
        "SELECT COALESCE(sum(g.kills), 0)::int8 FROM grind_segments g JOIN grind_sessions x ON x.id = g.session_id
         WHERE g.map_id = $1 AND g.active_seconds >= $2 AND x.ended_at >= to_timestamp($3)",
    )
    .bind(map)
    .bind(MIN_SHOWN_SECONDS)
    .bind(now - RESULT_DAYS * 86400.)
    .fetch_one(db)
    .await?;
    let groups: Vec<Value> = rows
        .into_iter()
        .map(
            |(band, job, sessions, seconds, e25, e50, e75, n25, n50, n75, mesos, kills)| {
                json!({"level_from": band, "level_to": band + 4, "job": job, "sessions": sessions,
                   "hours": seconds as f64 / 3600.0,
                   "exp_per_hour": [e25, e50, e75], "net_per_hour": [n25, n50, n75],
                   "mesos_per_hour": mesos, "kills_per_hour": kills})
            },
        )
        .collect();
    Ok(json!({
        "map_id": map, "days": RESULT_DAYS, "groups": groups, "kills": total_kills,
        "drops": drops.into_iter().map(|(id, zh, en, quantity, sessions)| json!({
            "item_id": id, "name": zh, "name_en": en, "quantity": quantity, "sessions": sessions,
            "per_1000_kills": if total_kills > 0 { Some(quantity as f64 * 1000.0 / total_kills as f64) } else { None }
        })).collect::<Vec<_>>(),
    }))
}

async fn map_results(
    State(state): State<AppState>,
    ClientAddr(addr): ClientAddr,
    headers: HeaderMap,
    Path(id): Path<String>,
) -> Response {
    if let Err(response) = reader(&state, &headers, &addr, "grind-map").await {
        return response;
    }
    let Some(map) = id
        .parse::<i32>()
        .ok()
        .filter(|id| (0..1_000_000_000).contains(id))
    else {
        return error(StatusCode::NOT_FOUND, "Not found");
    };
    match map_summary(&state.db, map, unix_now()).await {
        Ok(value) => (
            [(header::CACHE_CONTROL, "public, max-age=300")],
            Json(value),
        )
            .into_response(),
        Err(err) => internal(err),
    }
}

#[cfg(test)]
mod recent_price_tests {
    use super::recent_prices;

    #[test]
    fn only_the_last_72_hours_price_a_group() {
        let day = 86400.0;
        let now = 100.0 * day;
        let sales = [(now - 1.0 * day, 500.0), (now - 2.9 * day, 480.0), (now - 3.1 * day, 520.0), (now - 20.0 * day, 800.0)];
        assert_eq!(recent_prices(&sales, now), vec![500.0, 480.0]);
        assert!(recent_prices(&[(now - 4.0 * day, 700.0)], now).is_empty());
    }
}

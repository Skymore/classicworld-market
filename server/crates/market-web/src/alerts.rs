//! `GET /api/v1/collector/alerts`: the caller's own deal alerts, as
//! `shared_server.personal_alerts`. The bearer token picks the collector;
//! its observations received in the last two minutes are the candidates and
//! everyone's listings and sales of the same items are the comparison. The
//! rules live in `market_core::opportunities`; this module loads their input.
//!
//! Python compares against a full report cached for 30 s. Here only the
//! candidate items are read, straight from `listings` and `sales`, so the
//! reference is always current and costs a few indexed queries.

use std::collections::HashMap;

use axum::{
    extract::{rejection::QueryRejection, Query, State},
    http::{header, HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    Json,
};
use market_core::item::is_equipment;
use market_core::opportunities::{
    self, ItemReference, Opportunity, Place, RefQuote, RefSale, Reference, Visit, VisitRow,
    CANDIDATE_SECONDS,
};
use market_core::protocol::MarketLocation;
use market_core::report::Window;
use serde_json::json;
use sqlx::{postgres::PgRow, PgPool, Row};

use crate::auth::{self, Collector};
use crate::views::Hours;
use crate::{unix_now, AppState};

/// `shared_server.py`: 60 requests a minute per collector.
const RATE_LIMIT: usize = 60;
/// `SharedStore.personal_alerts` reads at most this many recent uploads.
const MAX_VISITS: i64 = 256;

fn error(status: StatusCode, message: &str) -> Response {
    (status, Json(json!({"error": message}))).into_response()
}

fn bearer(headers: &HeaderMap) -> Option<&str> {
    headers
        .get(header::AUTHORIZATION)?
        .to_str()
        .ok()?
        .strip_prefix("Bearer ")
}

pub async fn personal(
    State(state): State<AppState>,
    headers: HeaderMap,
    query: Result<Query<Vec<(String, String)>>, QueryRejection>,
) -> Response {
    // Bearer only: the login cookie is a reader session, not a collector.
    let collector = match auth::authenticate(&state.db, bearer(&headers)).await {
        Ok(Some(c)) => c,
        Ok(None) => return error(StatusCode::UNAUTHORIZED, "Collector token required"),
        Err(err) => return internal(err),
    };
    if !state.limiter.allow(
        &format!("personal-alerts:{}", collector.public_id),
        RATE_LIMIT,
    ) {
        return error(StatusCode::TOO_MANY_REQUESTS, "Rate limited");
    }
    let hours = query.ok().and_then(|Query(pairs)| {
        let value = pairs
            .into_iter()
            .find(|(k, _)| k == "hours")
            .map(|(_, v)| v);
        Hours::parse(value.as_deref())
    });
    let Some(hours) = hours else {
        return error(StatusCode::BAD_REQUEST, "hours must be 72 or all");
    };
    // Queue before loading reference rows, without occupying a DB connection.
    // Move the permit into the calculation so a disconnected client cannot
    // release it while its blocking worker is still using CPU.
    let permit = state
        .alert_calculations
        .clone()
        .acquire_owned()
        .await
        .expect("alerts gate open");
    let now = unix_now();
    match calculate_alerts(&state.db, &collector, hours, now, Some(permit)).await {
        Ok(found) => {
            Json(json!({"personal_alerts": true, "collector_id": collector.public_id, "generated_at": now, "opportunities": found}))
                .into_response()
        }
        Err(err) => internal(err),
    }
}

fn internal(err: impl std::fmt::Display) -> Response {
    tracing::error!(error = %err, "personal alerts failed");
    error(StatusCode::INTERNAL_SERVER_ERROR, "Internal error")
}

/// Watched offers from this collector's own fresh visits, independently of
/// whether another collector already observed the same shared listing.
pub async fn watch_listings(
    State(state): State<AppState>,
    headers: HeaderMap,
    query: Result<Query<Vec<(String, String)>>, QueryRejection>,
) -> Response {
    let collector = match auth::authenticate(&state.db, bearer(&headers)).await {
        Ok(Some(c)) => c,
        Ok(None) => return error(StatusCode::UNAUTHORIZED, "Collector token required"),
        Err(err) => return internal(err),
    };
    if !state.limiter.allow(
        &format!("personal-watch:{}", collector.public_id),
        RATE_LIMIT,
    ) {
        return error(StatusCode::TOO_MANY_REQUESTS, "Rate limited");
    }
    let Ok(Query(pairs)) = query else {
        return error(StatusCode::BAD_REQUEST, "Invalid query");
    };
    let ids = pairs
        .into_iter()
        .find(|(key, _)| key == "ids")
        .map(|(_, value)| value)
        .unwrap_or_default();
    let Some(ids) = crate::views::parse_item_ids(&ids) else {
        return error(StatusCode::BAD_REQUEST, "Invalid item IDs");
    };
    match crate::views::personal_watch_listings(&state.db, collector.id, &ids, unix_now()).await {
        Ok(mut value) => {
            value["collector_id"] = json!(collector.public_id);
            Json(value).into_response()
        }
        Err(err) => internal(err),
    }
}

/// The collector's alerts at `now` against the `hours` window.
pub async fn personal_alerts(
    db: &PgPool,
    collector: &Collector,
    hours: Hours,
    now: f64,
) -> sqlx::Result<Vec<Opportunity>> {
    calculate_alerts(db, collector, hours, now, None).await
}

async fn calculate_alerts(
    db: &PgPool,
    collector: &Collector,
    hours: Hours,
    now: f64,
    permit: Option<tokio::sync::OwnedSemaphorePermit>,
) -> sqlx::Result<Vec<Opportunity>> {
    let visits = recent_visits(db, collector.id, now).await?;
    let items = candidate_items(&visits, now);
    if items.is_empty() {
        return Ok(vec![]);
    }
    let reference = reference(db, &items, hours.window(now), now).await?;
    tokio::task::spawn_blocking(move || {
        let _permit = permit;
        opportunities::personal_alerts(&reference, &visits, now)
    })
    .await
    .map_err(|err| sqlx::Error::Io(std::io::Error::other(err)))
}

fn place(row: &PgRow, offset: usize) -> Place {
    let (channel, room): (Option<i16>, Option<i16>) = (row.get(offset + 2), row.get(offset + 3));
    Place {
        shop_id: row.get(offset),
        title: row.get(offset + 1),
        location: channel.zip(room).map(|(channel, room)| MarketLocation {
            channel: channel as u16,
            room: room as u16,
        }),
    }
}

/// Observations received in the last two minutes, most recent first, with
/// their rows in upload order.
async fn recent_visits(db: &PgPool, collector: i64, now: f64) -> sqlx::Result<Vec<Visit>> {
    let heads = sqlx::query(
        "SELECT o.id, extract(epoch FROM o.observed_at)::float8, sh.shop_id, sh.title, sh.channel, sh.room
         FROM observations o JOIN shops sh ON sh.id = o.shop_id
         WHERE o.collector_id = $1 AND o.received_at >= to_timestamp($2)
           AND NOT EXISTS (SELECT 1 FROM player_departures d WHERE d.world=sh.world
             AND d.character_id=sh.owner_character_id AND d.channel=sh.channel AND d.room=sh.room
             AND d.observed_at>=o.observed_at AND (d.evidence_kind='player_departure' OR d.observed_at>o.observed_at))
         ORDER BY o.received_at DESC, o.id DESC LIMIT $3",
    )
    .bind(collector)
    .bind(now - CANDIDATE_SECONDS)
    .bind(MAX_VISITS)
    .fetch_all(db)
    .await?;
    if heads.is_empty() {
        return Ok(vec![]);
    }
    let ids: Vec<i64> = heads.iter().map(|r| r.get(0)).collect();
    let mut rows: HashMap<i64, Vec<VisitRow>> = HashMap::new();
    for r in sqlx::query(
        "SELECT observation_id, slot, item_id, price, bundle, stock FROM observation_rows
         WHERE observation_id = ANY($1) ORDER BY observation_id, position",
    )
    .bind(&ids)
    .fetch_all(db)
    .await?
    {
        rows.entry(r.get(0)).or_default().push(VisitRow {
            slot: r.get(1),
            item_id: i64::from(r.get::<i32, _>(2)),
            price: r.get(3),
            bundle: i64::from(r.get::<i32, _>(4)),
            stock: i64::from(r.get::<i32, _>(5)),
        });
    }
    Ok(heads
        .iter()
        .map(|r| Visit {
            time: r.get(1),
            place: place(r, 2),
            rows: rows.remove(&r.get::<i64, _>(0)).unwrap_or_default(),
        })
        .collect())
}

/// Items that could alert: rows of a fresh visit that are not equipment and
/// have something to buy. Only these need a reference.
fn candidate_items(visits: &[Visit], now: f64) -> Vec<i32> {
    let mut items: Vec<i32> = visits
        .iter()
        .filter(|v| (0.0..=CANDIDATE_SECONDS).contains(&(now - v.time)))
        .flat_map(|v| &v.rows)
        .filter(|r| !is_equipment(r.item_id) && r.bundle > 0 && r.stock > 0)
        .map(|r| r.item_id as i32)
        .collect();
    items.sort_unstable();
    items.dedup();
    items
}

/// Live listings and sales of `items` inside the window, with each shop's
/// identity for `same_shop`.
async fn reference(
    db: &PgPool,
    items: &[i32],
    window: Window,
    now: f64,
) -> sqlx::Result<Reference> {
    let mut reference = Reference {
        hours: window.hours,
        generated_at: now,
        ..Reference::default()
    };
    for r in sqlx::query(
        "SELECT id, COALESCE(NULLIF(name_zh, ''), id::text) FROM items WHERE id = ANY($1)",
    )
    .bind(items)
    .fetch_all(db)
    .await?
    {
        let item = ItemReference {
            name: r.get(1),
            ..ItemReference::default()
        };
        reference.items.insert(i64::from(r.get::<i32, _>(0)), item);
    }
    // A listing's last_seen_at is its shop's latest observation, which
    // decides the quote window as in Python's report.
    let quotes = sqlx::query(
        "SELECT l.item_id, l.shop_id, extract(epoch FROM l.last_seen_at)::float8, l.price, l.bundle, l.stock,
                sh.shop_id, sh.title, sh.channel, sh.room
         FROM listings l JOIN shops sh ON sh.id = l.shop_id
         WHERE l.item_id = ANY($1) AND l.stock > 0 AND l.last_seen_at >= to_timestamp($2)",
    )
    .bind(items)
    .bind(window.cutoff)
    .fetch_all(db)
    .await?;
    for r in &quotes {
        let shop: i64 = r.get(1);
        reference.shops.entry(shop).or_insert_with(|| place(r, 6));
        if let Some(item) = reference.items.get_mut(&i64::from(r.get::<i32, _>(0))) {
            item.quotes.push(RefQuote {
                shop,
                time: r.get(2),
                unit_price: r.get::<i64, _>(3) as f64 / f64::from(r.get::<i32, _>(4)),
                stock: i64::from(r.get::<i32, _>(5)),
            });
        }
    }
    let sales = sqlx::query(
        "SELECT s.item_id, s.shop_id, extract(epoch FROM s.detected_at)::float8, s.slot, s.variant_id,
                s.price, s.bundle, sh.shop_id, sh.title, sh.channel, sh.room
         FROM sales s JOIN shops sh ON sh.id = s.shop_id
         WHERE s.item_id = ANY($1) AND s.detected_at >= to_timestamp($2)",
    )
    .bind(items)
    .bind(window.cutoff)
    .fetch_all(db)
    .await?;
    for r in &sales {
        let shop: i64 = r.get(1);
        reference.shops.entry(shop).or_insert_with(|| place(r, 7));
        if let Some(item) = reference.items.get_mut(&i64::from(r.get::<i32, _>(0))) {
            item.sales.push(RefSale {
                shop,
                time: r.get(2),
                slot: r.get(3),
                variant: r.get(4),
                unit_price: r.get::<i64, _>(5) as f64 / f64::from(r.get::<i32, _>(6)),
            });
        }
    }
    Ok(reference)
}

/// Only the authenticated collector's receive history. This never claims that
/// the client driver is running based on a server-side upload timestamp.
pub async fn status(State(state): State<AppState>, headers: HeaderMap) -> Response {
    let collector = match auth::authenticate(&state.db, bearer(&headers)).await {
        Ok(Some(value)) => value,
        Ok(None) => return error(StatusCode::UNAUTHORIZED, "Collector token required"),
        Err(err) => return internal(err),
    };
    if !state
        .limiter
        .allow(&format!("collector-status:{}", collector.public_id), 60)
    {
        return error(StatusCode::TOO_MANY_REQUESTS, "Rate limited");
    }
    let row=sqlx::query("SELECT extract(epoch FROM o.observed_at)::float8 AS observed, extract(epoch FROM o.received_at)::float8 AS received, sh.channel, sh.room, o.map_channel, o.map_id FROM observations o JOIN shops sh ON sh.id=o.shop_id WHERE o.collector_id=$1 ORDER BY o.received_at DESC,o.id DESC LIMIT 1")
        .bind(collector.id).fetch_optional(&state.db).await;
    match row {
        Err(err) => internal(err),
        Ok(row) => {
            let mut result = json!({"collector_id":collector.public_id,"local_collector":false,"checked_at":unix_now(),"last_shop_at":null,"last_upload_at":null,"location":null,"connection_health":{"state":"no_observations"}});
            if let Some(row) = row {
                let channel: Option<i16> = row.get("channel");
                let room: Option<i16> = row.get("room");
                result["last_shop_at"] = json!(row.get::<f64, _>("observed"));
                result["last_upload_at"] = json!(row.get::<f64, _>("received"));
                result["connection_health"] = json!({"state":"observed"});
                if let (Some(channel), Some(room)) = (channel, room) {
                    result["location"] = json!({"channel":channel,"room":room});
                }
            }
            Json(result).into_response()
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn visit(time: f64, item_id: i64, bundle: i64, stock: i64) -> Visit {
        Visit {
            time,
            place: Place {
                shop_id: 1,
                title: "Shop".into(),
                location: None,
            },
            rows: vec![VisitRow {
                slot: 4001,
                item_id,
                price: 10,
                bundle,
                stock,
            }],
        }
    }

    #[test]
    fn only_fresh_buyable_non_equipment_rows_need_a_reference() {
        let now = 1_000.0;
        let visits = [
            visit(now - 10.0, 4_010_001, 1, 1),
            visit(now - 10.0, 4_010_001, 1, 1),
            visit(now - 10.0, 1_452_003, 1, 1),
            visit(now - 10.0, 2_000_000, 1, 0),
            visit(now - 300.0, 2_000_001, 1, 1),
            visit(now - 10.0, 5_000_000, 10, 2),
        ];
        assert_eq!(candidate_items(&visits, now), vec![4_010_001, 5_000_000]);
    }
}

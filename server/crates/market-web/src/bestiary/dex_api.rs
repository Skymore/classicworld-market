//! `GET /api/v1/dex/dropped-items`: every item id some mob drops, for the
//! prices page's "monster drops only" filter. `GET /api/v1/dex/counts`: how
//! many mobs, maps and items the bestiary holds, for the home page portals.
//! `GET /api/v1/dex/maps?ids=1,2`: the monsters on each map and what they
//! drop, for area pages (`/hollow`).
//! Public game data like the bestiary pages; it only changes when
//! `import_catalog` runs.

use std::collections::{HashMap, HashSet};

use axum::{
    body::Body,
    extract::{Query, State},
    http::{header, HeaderMap, HeaderValue, StatusCode},
    response::{IntoResponse, Response},
};
use serde::Serialize;
use sha2::{Digest, Sha256};
use sqlx::PgPool;

use crate::AppState;

const CACHE: &str = "public, max-age=3600";

pub async fn period_default(State(state): State<AppState>, headers: HeaderMap) -> Response {
    // Build in a detached task: a dropped request must not release the
    // coalescing lock while its query keeps running, or every retry stacks
    // another full scan of market_sales.
    let lists = state.market_lists.clone();
    let db = state.db.clone();
    let body = tokio::spawn(async move {
        lists
            .period_hint(async {
                // The per-item statistics already hold these counts (at most
                // one clock refresh behind). Counting market_sales directly
                // scanned every sale: ~35 s of disk reads (2026-11-18).
                let row: sqlx::Result<(i64, i64, i64)> = sqlx::query_as(
                    "SELECT (SELECT count(*) FROM item_stats WHERE sales_count > 0),
                            (SELECT COALESCE(sum(sales_count), 0)::int8 FROM item_stats),
                            (SELECT count(*) FROM item_stats_all WHERE sales_count > 0)",
                )
                .fetch_one(&db)
                .await;
                row.map(|(recent, sales, total)| {
                    serde_json::to_vec(&serde_json::json!({
            "recent_priced_items":recent,"recent_sales":sales,"historical_priced_items":total,
            "threshold":30,"default_hours":if recent<30 && total>recent {"all"} else {"72"}
        }))
        .expect("period hint serialize")
                })
            })
            .await
    })
    .await
    .unwrap_or_else(|e| Err(sqlx::Error::Protocol(format!("period hint task: {e}"))));
    let mut response = json_response(body, &headers, "period default");
    response
        .headers_mut()
        .insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    response
}

#[derive(Debug, Serialize)]
pub struct DroppedItems {
    /// When the drop tables were imported (unix seconds); 0 before any import.
    pub as_of: i64,
    pub item_ids: Vec<i32>,
}

pub async fn load(db: &PgPool) -> sqlx::Result<DroppedItems> {
    let item_ids = sqlx::query_scalar(&format!(
        "SELECT DISTINCT d.item_id FROM drops d JOIN mobs m ON m.id = d.mob_id
         WHERE d.item_id IS NOT NULL AND {} ORDER BY d.item_id",
        super::queries::PUBLIC_MOB_FILTER
    ))
    .fetch_all(db)
    .await?;
    let as_of: Option<i64> = sqlx::query_scalar(
        "SELECT extract(epoch FROM max(imported_at))::bigint FROM catalog_versions WHERE dataset = 'mapledex'",
    )
    .fetch_one(db)
    .await?;
    Ok(DroppedItems {
        as_of: as_of.unwrap_or(0),
        item_ids,
    })
}

#[derive(Debug, Serialize, sqlx::FromRow)]
pub struct Counts {
    pub mobs: i64,
    pub maps: i64,
    pub items: i64,
}

pub async fn load_counts(db: &PgPool) -> sqlx::Result<Counts> {
    sqlx::query_as(
        &format!("SELECT (SELECT count(*) FROM mobs m WHERE {}) AS mobs, (SELECT count(*) FROM maps WHERE NOT unreleased) AS maps,
                (SELECT count(*) FROM items) AS items", super::queries::PUBLIC_MOB_FILTER),
    )
    .fetch_one(db)
    .await
}

pub async fn counts(State(state): State<AppState>, headers: HeaderMap) -> Response {
    let body = load_counts(&state.db)
        .await
        .map(|c| serde_json::to_vec(&c).expect("counts serialize"));
    json_response(body, &headers, "dex counts")
}

pub async fn dropped_items(State(state): State<AppState>, headers: HeaderMap) -> Response {
    let body = load(&state.db)
        .await
        .map(|items| serde_json::to_vec(&items).expect("ids serialize"));
    json_response(body, &headers, "dropped-items")
}

/// At most this many maps per `/api/v1/dex/maps` request.
const MAX_MAPS: usize = 60;

#[derive(Debug, serde::Deserialize)]
pub struct MapsRequest {
    ids: String,
}

#[derive(Debug, Serialize, PartialEq)]
pub struct MapOverview {
    pub id: i32,
    pub mobs: Vec<MapOverviewMob>,
    /// Items the map's monsters drop (confirmed drops only): ones with a
    /// market price first, dearest first; quest items last.
    pub drops: Vec<MapOverviewDrop>,
}

#[derive(Debug, Serialize, PartialEq, sqlx::FromRow)]
pub struct MapOverviewMob {
    #[serde(skip)]
    pub map_id: i32,
    pub id: i32,
    #[sqlx(flatten)]
    pub names: super::model::Names,
    pub level: Option<i16>,
    pub spawn_count: i16,
}

#[derive(Debug, Clone, Serialize, PartialEq, sqlx::FromRow)]
pub struct MapOverviewDrop {
    #[serde(skip)]
    pub mob_id: i32,
    pub id: i32,
    #[sqlx(flatten)]
    pub names: super::model::Names,
    pub icon_url: Option<String>,
    pub typical: Option<i64>,
    pub quest: bool,
}

/// The ids in `1,2,3`: positive, unique, at most `MAX_MAPS`.
fn parse_ids(raw: &str) -> Option<Vec<i32>> {
    let mut ids = Vec::new();
    for part in raw.split(',').filter(|p| !p.is_empty()) {
        let id: i32 = part.trim().parse().ok().filter(|id| *id > 0)?;
        if !ids.contains(&id) {
            ids.push(id);
        }
    }
    (!ids.is_empty() && ids.len() <= MAX_MAPS).then_some(ids)
}

pub async fn load_maps(db: &PgPool, ids: &[i32]) -> sqlx::Result<Vec<MapOverview>> {
    let filter = super::queries::PUBLIC_MOB_FILTER;
    let mobs: Vec<MapOverviewMob> = sqlx::query_as(&format!(
        "SELECT s.map_id, m.id,
                COALESCE(NULLIF(m.name_zh, ''), NULLIF(m.name_tw, ''), m.name_en) AS name,
                COALESCE(NULLIF(m.name_en, ''), NULLIF(m.name_zh, ''), m.name_tw) AS name_en,
                m.level, s.spawn_count
         FROM mob_spawns s JOIN maps mp ON mp.id = s.map_id AND NOT mp.unreleased
         JOIN mobs m ON m.id = s.mob_id
         WHERE s.map_id = ANY($1) AND {filter}
         ORDER BY s.map_id, m.level NULLS LAST, m.id"
    ))
    .bind(ids)
    .fetch_all(db)
    .await?;
    let mob_ids: Vec<i32> = mobs.iter().map(|m| m.id).collect();
    let drops: Vec<MapOverviewDrop> = sqlx::query_as(
        "SELECT DISTINCT ON (d.mob_id, i.id) d.mob_id, i.id,
                COALESCE(NULLIF(i.name_zh, ''), i.name_en) AS name,
                COALESCE(NULLIF(i.name_en, ''), i.name_zh) AS name_en,
                i.icon_url, round(st.typical)::bigint AS typical, d.quest_id IS NOT NULL AS quest
         FROM drops d JOIN items i ON i.id = d.item_id
         LEFT JOIN item_stats st ON st.item_id = i.id
         WHERE d.mob_id = ANY($1)
         ORDER BY d.mob_id, i.id, d.quest_id NULLS FIRST",
    )
    .bind(&mob_ids)
    .fetch_all(db)
    .await?;
    let mut by_mob: HashMap<i32, Vec<&MapOverviewDrop>> = HashMap::new();
    for drop in &drops {
        by_mob.entry(drop.mob_id).or_default().push(drop);
    }
    let mut out: Vec<MapOverview> = ids
        .iter()
        .map(|&id| MapOverview {
            id,
            mobs: Vec::new(),
            drops: Vec::new(),
        })
        .collect();
    for mob in mobs {
        let map = out
            .iter_mut()
            .find(|m| m.id == mob.map_id)
            .expect("requested map");
        let mut seen: HashSet<i32> = map.drops.iter().map(|d| d.id).collect();
        for drop in by_mob.get(&mob.id).into_iter().flatten() {
            if seen.insert(drop.id) {
                map.drops.push((*drop).clone());
            }
        }
        map.mobs.push(mob);
    }
    for map in &mut out {
        map.drops.sort_by_key(|d| {
            (
                d.quest,
                d.typical.is_none(),
                std::cmp::Reverse(d.typical),
                d.id,
            )
        });
    }
    Ok(out)
}

pub async fn maps(
    State(state): State<AppState>,
    Query(request): Query<MapsRequest>,
    headers: HeaderMap,
) -> Response {
    let Some(ids) = parse_ids(&request.ids) else {
        return (
            StatusCode::BAD_REQUEST,
            [(header::CACHE_CONTROL, "no-store")],
            axum::Json(serde_json::json!({ "error": "invalid_ids" })),
        )
            .into_response();
    };
    let body = load_maps(&state.db, &ids).await.map(|maps| {
        serde_json::to_vec(&serde_json::json!({ "maps": maps })).expect("maps serialize")
    });
    json_response(body, &headers, "dex maps")
}

/// JSON body with an ETag, 304 on a matching `If-None-Match`, 500 on a
/// query error.
fn json_response(body: sqlx::Result<Vec<u8>>, headers: &HeaderMap, what: &str) -> Response {
    let body = match body {
        Ok(body) => body,
        Err(err) => {
            tracing::error!(error = %err, "{what} query failed");
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                [(header::CACHE_CONTROL, "no-store")],
                axum::Json(serde_json::json!({ "error": "database error" })),
            )
                .into_response();
        }
    };
    let tag = etag(&body);
    let mut response = if matches(headers, &tag) {
        StatusCode::NOT_MODIFIED.into_response()
    } else {
        let mut ok = Response::new(Body::from(body));
        ok.headers_mut().insert(
            header::CONTENT_TYPE,
            HeaderValue::from_static("application/json; charset=utf-8"),
        );
        ok
    };
    let out = response.headers_mut();
    out.insert(header::ETAG, HeaderValue::from_str(&tag).expect("hex tag"));
    out.insert(header::CACHE_CONTROL, HeaderValue::from_static(CACHE));
    response
}

/// Tag of the body: it changes when the ids or the import time do.
fn etag(body: &[u8]) -> String {
    format!("\"{}\"", &hex::encode(Sha256::digest(body))[..32])
}

/// `If-None-Match` lists the tag (weak or strong) or is `*`.
fn matches(headers: &HeaderMap, tag: &str) -> bool {
    headers
        .get(header::IF_NONE_MATCH)
        .and_then(|v| v.to_str().ok())
        .is_some_and(|v| {
            v.split(',')
                .map(|t| t.trim().trim_start_matches("W/"))
                .any(|t| t == tag || t == "*")
        })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn map_ids() {
        assert_eq!(
            parse_ids("10006020,10006030,10006020"),
            Some(vec![10006020, 10006030])
        );
        assert_eq!(parse_ids(""), None);
        assert_eq!(parse_ids("1,x"), None);
        assert_eq!(parse_ids("-5"), None);
        let many = (1..=61)
            .map(|i| i.to_string())
            .collect::<Vec<_>>()
            .join(",");
        assert_eq!(parse_ids(&many), None);
    }

    #[test]
    fn tags_and_revalidation() {
        let tag = etag(br#"{"as_of":1,"item_ids":[2000000]}"#);
        assert_eq!(tag.len(), 34);
        assert_ne!(tag, etag(br#"{"as_of":2,"item_ids":[2000000]}"#));
        let mut headers = HeaderMap::new();
        assert!(!matches(&headers, &tag));
        headers.insert(
            header::IF_NONE_MATCH,
            HeaderValue::from_str(&format!("\"x\", W/{tag}")).unwrap(),
        );
        assert!(matches(&headers, &tag));
        headers.insert(header::IF_NONE_MATCH, HeaderValue::from_static("*"));
        assert!(matches(&headers, &tag));
    }
}

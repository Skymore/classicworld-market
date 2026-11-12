//! `GET /api/v1/dex/dropped-items`: every item id some mob drops, for the
//! prices page's "monster drops only" filter. `GET /api/v1/dex/counts`: how
//! many mobs, maps and items the bestiary holds, for the home page portals.
//! Public game data like the bestiary pages; it only changes when
//! `import_catalog` runs.

use axum::{
    body::Body,
    extract::State,
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
                let now = crate::unix_now();
                let row: sqlx::Result<(i64, i64, i64)> = sqlx::query_as(
                    "SELECT count(DISTINCT item_id) FILTER (WHERE detected_at>=to_timestamp($1)),
         count(*) FILTER (WHERE detected_at>=to_timestamp($1)), count(DISTINCT item_id)
         FROM market_sales WHERE detected_at<=to_timestamp($2)",
                )
                .bind(now - 72.0 * 3600.0)
                .bind(now)
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

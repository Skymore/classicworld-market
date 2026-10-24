//! Authenticated, short room leases. No expired lease can be revived.
use crate::{auth, AppState};
use axum::{
    extract::State,
    http::{HeaderMap, StatusCode},
    routing::post,
    Json, Router,
};
use serde::Deserialize;
use serde_json::{json, Value};

type Error = (StatusCode, Json<Value>);
fn error(status: StatusCode, message: &str) -> Error {
    (status, Json(json!({"error":message})))
}
fn db_error(_: sqlx::Error) -> Error {
    error(
        StatusCode::INTERNAL_SERVER_ERROR,
        "Task service unavailable",
    )
}

#[derive(Deserialize)]
pub struct Request {
    session_id: String,
    lease_id: Option<String>,
    channel: Option<i16>,
}
async fn identity(state: &AppState, headers: &HeaderMap, request: &Request) -> Result<i64, Error> {
    if request.session_id.len() < 16
        || request.session_id.len() > 64
        || !request
            .session_id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-')
        || request.channel.is_some_and(|n| !(1..=40).contains(&n))
    {
        return Err(error(StatusCode::BAD_REQUEST, "Invalid scanner session"));
    }
    let token = headers
        .get("authorization")
        .and_then(|s| s.to_str().ok())
        .and_then(|s| s.strip_prefix("Bearer "));
    let collector = auth::authenticate(&state.db, token)
        .await
        .map_err(db_error)?
        .ok_or_else(|| {
            error(
                StatusCode::UNAUTHORIZED,
                "Collector authentication required",
            )
        })?;
    if !state.limiter.allow(&format!("scan:{}", collector.id), 120) {
        return Err(error(StatusCode::TOO_MANY_REQUESTS, "Please slow down"));
    }
    Ok(collector.id)
}
pub fn router() -> Router<AppState> {
    Router::new()
        .route("/api/v1/scanner/claim", post(claim))
        .route("/api/v1/scanner/heartbeat", post(heartbeat))
        .route("/api/v1/scanner/complete", post(complete))
        .route("/api/v1/scanner/release", post(release))
}
async fn claim(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(r): Json<Request>,
) -> Result<Json<Value>, Error> {
    let id = identity(&state, &headers, &r).await?;
    let mut tx = state.db.begin().await.map_err(db_error)?;
    // Serializes the tiny allocation transaction, including expiry and same-worker claims.
    sqlx::query("SELECT pg_advisory_xact_lock(82739122)")
        .execute(&mut *tx)
        .await
        .map_err(db_error)?;
    sqlx::query("UPDATE scan_rooms SET collector_id=NULL,session_id=NULL,lease_id=NULL,expires_at=NULL,channel=NULL WHERE expires_at<=clock_timestamp() OR NOT enabled")
        .execute(&mut *tx).await.map_err(db_error)?;
    let existing: Option<(i16, String, String)> =
        sqlx::query_as("SELECT room,lease_id,session_id FROM scan_rooms WHERE collector_id=$1")
            .bind(id)
            .fetch_optional(&mut *tx)
            .await
            .map_err(db_error)?;
    if existing
        .as_ref()
        .is_some_and(|(_, _, session)| session != &r.session_id)
    {
        return Err(error(
            StatusCode::CONFLICT,
            "Another scanner is already running",
        ));
    }
    sqlx::query("INSERT INTO scan_workers VALUES($1,$2,clock_timestamp()+interval '30 seconds') ON CONFLICT(collector_id) DO UPDATE SET session_id=EXCLUDED.session_id,expires_at=EXCLUDED.expires_at")
        .bind(id).bind(&r.session_id).execute(&mut *tx).await.map_err(db_error)?;
    let assigned = if let Some((room, lease, _)) = existing {
        Some((room, lease))
    } else {
        let room: Option<(i16,)> = sqlx::query_as("SELECT room FROM scan_rooms WHERE enabled AND collector_id IS NULL ORDER BY last_completed NULLS FIRST, room LIMIT 1 FOR UPDATE")
            .fetch_optional(&mut *tx).await.map_err(db_error)?;
        room.map(|(room,)| (room, auth::new_credentials().public_id))
    };
    if let Some((room, ref lease)) = assigned {
        sqlx::query("UPDATE scan_rooms SET collector_id=$1,session_id=$2,lease_id=$3,expires_at=clock_timestamp()+interval '30 seconds' WHERE room=$4")
            .bind(id).bind(&r.session_id).bind(lease).bind(room).execute(&mut *tx).await.map_err(db_error)?;
    }
    let (online,): (i64,) =
        sqlx::query_as("SELECT count(*) FROM scan_workers WHERE expires_at>clock_timestamp()")
            .fetch_one(&mut *tx)
            .await
            .map_err(db_error)?;
    tx.commit().await.map_err(db_error)?;
    Ok(Json(
        json!({"assignment":assigned.map(|(room,lease)|json!({"room":room,"lease_id":lease,"ttl_seconds":30})),
        "online_scanners":online,"retry_after_seconds":5,"plan":{"first_channel":1,"last_channel":40,"empty_channels":3,"strategy":"both_ends"}}),
    ))
}
async fn change(
    state: AppState,
    headers: HeaderMap,
    r: Request,
    action: &str,
) -> Result<Json<Value>, Error> {
    let id = identity(&state, &headers, &r).await?;
    let lease = r
        .lease_id
        .as_deref()
        .filter(|s| !s.is_empty() && s.len() <= 64)
        .ok_or_else(|| error(StatusCode::BAD_REQUEST, "Lease required"))?;
    let mut tx = state.db.begin().await.map_err(db_error)?;
    // Same global lock as claim prevents expiry/reassignment racing renewal/release.
    sqlx::query("SELECT pg_advisory_xact_lock(82739122)")
        .execute(&mut *tx)
        .await
        .map_err(db_error)?;
    let changed = sqlx::query(if action == "heartbeat" {
        "UPDATE scan_rooms SET expires_at=clock_timestamp()+interval '30 seconds',channel=COALESCE($4,channel) WHERE collector_id=$1 AND session_id=$2 AND lease_id=$3 AND expires_at>clock_timestamp() AND enabled"
    } else if action == "complete" {
        "UPDATE scan_rooms SET last_completed=clock_timestamp(),collector_id=NULL,session_id=NULL,lease_id=NULL,expires_at=NULL,channel=$4 WHERE collector_id=$1 AND session_id=$2 AND lease_id=$3 AND expires_at>clock_timestamp() AND enabled"
    } else {
        "UPDATE scan_rooms SET collector_id=NULL,session_id=NULL,lease_id=NULL,expires_at=NULL,channel=$4 WHERE collector_id=$1 AND session_id=$2 AND lease_id=$3 AND expires_at>clock_timestamp()"
    }).bind(id).bind(&r.session_id).bind(lease).bind(r.channel).execute(&mut *tx).await.map_err(db_error)?;
    if changed.rows_affected() != 1 {
        return Err(error(
            StatusCode::CONFLICT,
            "Task expired; stop scanning and claim again",
        ));
    }
    sqlx::query("UPDATE scan_workers SET expires_at=CASE WHEN $3 THEN clock_timestamp() ELSE clock_timestamp()+interval '30 seconds' END WHERE collector_id=$1 AND session_id=$2")
        .bind(id).bind(&r.session_id).bind(action=="release").execute(&mut *tx).await.map_err(db_error)?;
    tx.commit().await.map_err(db_error)?;
    Ok(Json(json!({"ok":true,"ttl_seconds":30})))
}
async fn heartbeat(
    State(s): State<AppState>,
    h: HeaderMap,
    Json(r): Json<Request>,
) -> Result<Json<Value>, Error> {
    change(s, h, r, "heartbeat").await
}
async fn complete(
    State(s): State<AppState>,
    h: HeaderMap,
    Json(r): Json<Request>,
) -> Result<Json<Value>, Error> {
    change(s, h, r, "complete").await
}
async fn release(
    State(s): State<AppState>,
    h: HeaderMap,
    Json(r): Json<Request>,
) -> Result<Json<Value>, Error> {
    change(s, h, r, "release").await
}

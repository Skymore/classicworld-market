//! `/api/v1/*` handlers. Paths, status codes, error texts and rate limits
//! follow `shared_server.py`, so the WinDivert collector, the collector
//! dashboard and the existing pages work against this service unchanged.

// Access checks return the final HTTP response directly, without extra boxing.
#![allow(clippy::result_large_err)]

use std::convert::Infallible;
use std::net::SocketAddr;
use std::time::Instant;

use axum::{
    body::{Body, Bytes},
    extract::{ConnectInfo, DefaultBodyLimit, FromRequestParts, Path, RawQuery, State},
    http::{header, request::Parts, HeaderMap, HeaderValue, StatusCode},
    response::{IntoResponse, Response},
    routing::{get, post},
    Json, Router,
};
use market_core::protocol::validate;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

use crate::auth::{self, Collector};
use crate::ingest::{IngestError, IngestOutcome, Received};
use crate::views::{self, Hours, SalesQuery};
use crate::{unix_now, AppState};

/// Python's MAX_CONTENT_LENGTH.
pub const MAX_BODY: usize = 256 * 1024;
const SESSION_COOKIE: &str = "fm_session";
const SESSION_SECONDS: u32 = 30 * 86400;

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/api/v1/register", post(register))
        .route("/api/v1/remote-debug/client", post(crate::remote_debug::client))
        .route("/api/v1/remote-debug/operator", post(crate::remote_debug::operator))
        .route("/api/v1/login", post(login))
        .route("/api/v1/logout", post(logout))
        // The collector posts to /observations; /upload is the plan's name.
        .route("/api/v1/observations", post(upload))
        .route("/api/v1/upload", post(upload))
        .route("/api/v1/collector/diagnostics", post(crate::diagnostics::upload)
            .layer(DefaultBodyLimit::max(crate::diagnostics::MAX_REPORT)))
        .route(
            "/api/v1/collector/player-departure",
            post(crate::presence::upload),
        )
        .route("/api/v1/collector/room-roster", post(crate::roster::upload))
        .route(
            "/api/v1/collector/missing-locations",
            get(missing_locations),
        )
        .route("/api/v1/collector/repair-location", post(repair_location))
        .route("/api/v1/collector/repair-owner", post(repair_owner))
        .route("/api/v1/events", get(crate::realtime::events))
        .route(
            "/api/v1/collector/updates",
            get(crate::collector_updates::events),
        )
        .route("/api/v1/market", get(market))
        .route("/api/v1/market/overview", get(market_overview))
        .route("/api/v1/market/selected", get(market_selected))
        .route("/api/v1/sales/recent", get(sales_recent))
        .route("/api/v1/quotes/recent", get(quotes_recent))
        .route("/api/v1/market/records", get(market_records))
        .route("/api/v1/items/{id}", get(item_record))
        .route("/api/v1/enhancement/scrolls/{id}", get(enhancement_scrolls))
        .route("/api/v1/crafting/prices", get(crafting_prices))
        .route("/api/v1/item/{id}", get(item_page))
        .route("/api/v1/watchlist/catalog", get(watch_catalog))
        .route("/api/v1/watchlist/listings", get(watch_listings))
        .route("/api/v1/collector/alerts", get(crate::alerts::personal))
        .route("/api/v1/collector/status", get(crate::alerts::status))
        .route(
            "/api/v1/collector/watch-listings",
            get(crate::alerts::watch_listings),
        )
        .layer(DefaultBodyLimit::max(MAX_BODY))
}

pub(crate) fn error(status: StatusCode, message: &str) -> Response {
    (status, Json(json!({"error": message}))).into_response()
}

pub(crate) fn internal(err: impl std::fmt::Display) -> Response {
    tracing::error!(error = %err, "request failed");
    error(StatusCode::INTERNAL_SERVER_ERROR, "Internal error")
}

/// Client address: Cloudflare's header (the service is only reachable
/// through the tunnel or loopback), else the socket peer.
pub struct ClientAddr(pub String);

impl<S: Send + Sync> FromRequestParts<S> for ClientAddr {
    type Rejection = Infallible;

    async fn from_request_parts(parts: &mut Parts, _: &S) -> Result<Self, Self::Rejection> {
        let forwarded = parts
            .headers
            .get("cf-connecting-ip")
            .and_then(|v| v.to_str().ok())
            .map(str::to_string);
        let peer = || {
            parts
                .extensions
                .get::<ConnectInfo<SocketAddr>>()
                .map(|c| c.0.ip().to_string())
        };
        Ok(Self(
            forwarded.or_else(peer).unwrap_or_else(|| "unknown".into()),
        ))
    }
}

pub(crate) fn bearer(headers: &HeaderMap) -> Option<&str> {
    headers
        .get(header::AUTHORIZATION)?
        .to_str()
        .ok()?
        .strip_prefix("Bearer ")
}

fn session_cookie(headers: &HeaderMap) -> Option<&str> {
    headers
        .get_all(header::COOKIE)
        .iter()
        .filter_map(|v| v.to_str().ok())
        .flat_map(|v| v.split(';'))
        .find_map(|pair| pair.trim().strip_prefix(SESSION_COOKIE)?.strip_prefix('='))
}

/// Bearer token, else the login cookie.
async fn member(state: &AppState, headers: &HeaderMap) -> Result<Option<Collector>, Response> {
    auth::authenticate(
        &state.db,
        bearer(headers).or_else(|| session_cookie(headers)),
    )
    .await
    .map_err(internal)
}

/// Reads per reader and minute that may query or rebuild.
const READ_LIMIT: usize = 60;
/// Reads per reader and minute answered from an unchanged in-memory market
/// snapshot: list hits, 304s, `ids` rows, overview and selected rows. Each
/// market event makes every open page refresh, so these must not spend
/// `READ_LIMIT`; a rebuild still does.
const CACHED_READ_LIMIT: usize = 600;

/// Read access: sign-in unless public. The rate-limit key of this reader.
async fn read_key(
    state: &AppState,
    headers: &HeaderMap,
    addr: &str,
    scope: &str,
) -> Result<String, Response> {
    let who = member(state, headers).await?;
    if !state.settings.public_read && who.is_none() {
        return Err(error(StatusCode::UNAUTHORIZED, "请登录"));
    }
    Ok(format!(
        "{scope}:{}",
        who.map_or(addr.to_string(), |c| c.public_id)
    ))
}

fn spend(state: &AppState, key: &str, limit: usize) -> Result<(), Response> {
    if state.limiter.allow(key, limit) {
        Ok(())
    } else {
        Err(error(StatusCode::TOO_MANY_REQUESTS, "Rate limited"))
    }
}

/// From the cached budget when `cached`, else from the regular one.
fn spend_read(state: &AppState, key: &str, cached: bool) -> Result<(), Response> {
    if cached {
        spend(state, &format!("{key}|cached"), CACHED_READ_LIMIT)
    } else {
        spend(state, key, READ_LIMIT)
    }
}

/// Read access: sign-in unless public, then a per-reader limit.
pub(crate) async fn reader(
    state: &AppState,
    headers: &HeaderMap,
    addr: &str,
    scope: &str,
) -> Result<(), Response> {
    let key = read_key(state, headers, addr, scope).await?;
    spend(state, &key, READ_LIMIT)
}

fn query_param(query: &Option<String>, name: &str) -> Option<String> {
    let query = query.as_deref()?;
    url_decode_pairs(query)
        .into_iter()
        .find(|(k, _)| k == name)
        .map(|(_, v)| v)
}

fn url_decode_pairs(query: &str) -> Vec<(String, String)> {
    query
        .split('&')
        .filter(|p| !p.is_empty())
        .map(|pair| {
            let (k, v) = pair.split_once('=').unwrap_or((pair, ""));
            (percent_decode(k), percent_decode(v))
        })
        .collect()
}

fn percent_decode(text: &str) -> String {
    let bytes = text.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        let escaped = (bytes[i] == b'%')
            .then(|| bytes.get(i + 1..i + 3))
            .flatten()
            .and_then(|hex| std::str::from_utf8(hex).ok())
            .and_then(|hex| u8::from_str_radix(hex, 16).ok());
        match (bytes[i], escaped) {
            (_, Some(byte)) => {
                out.push(byte);
                i += 3;
            }
            (b'+', None) => {
                out.push(b' ');
                i += 1;
            }
            (byte, None) => {
                out.push(byte);
                i += 1;
            }
        }
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// Tag derived from the market version, so an unchanged market revalidates.
fn etag(version: i64, key: &str) -> String {
    let digest = Sha256::digest(format!("{version}|{key}").as_bytes());
    format!("\"{}\"", &hex::encode(digest)[..32])
}

/// `market_views.not_modified`.
pub(crate) fn not_modified(headers: &HeaderMap, tag: &str) -> bool {
    headers
        .get(header::IF_NONE_MATCH)
        .and_then(|v| v.to_str().ok())
        .is_some_and(|v| {
            v.split(',')
                .map(|t| t.trim().trim_start_matches("W/"))
                .any(|t| t == tag.trim_start_matches("W/") || t == "*")
        })
}

pub(crate) fn json_response(tag: Option<&str>, body: Vec<u8>) -> Response {
    let mut response = Response::new(Body::from(body));
    let headers = response.headers_mut();
    headers.insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static("application/json; charset=utf-8"),
    );
    if let Some(tag) = tag {
        headers.insert(header::ETAG, HeaderValue::from_str(tag).expect("hex tag"));
    }
    response
}

pub(crate) fn unchanged(tag: &str) -> Response {
    let mut response = StatusCode::NOT_MODIFIED.into_response();
    response
        .headers_mut()
        .insert(header::ETAG, HeaderValue::from_str(tag).expect("hex tag"));
    response
}

async fn register(State(state): State<AppState>, ClientAddr(addr): ClientAddr) -> Response {
    if !state.settings.public_read {
        return error(StatusCode::FORBIDDEN, "Registration disabled");
    }
    if !state.limiter.allow(&format!("register:{addr}"), 5)
        || !state.limiter.allow("register:global", 60)
    {
        return error(StatusCode::TOO_MANY_REQUESTS, "稍后再试");
    }
    match auth::register(&state.db, "anonymous").await {
        Ok(c) => (
            StatusCode::CREATED,
            Json(
                json!({"endpoint": format!("https://{}", state.settings.hostname),
                        "member_id": c.public_id, "token": c.token}),
            ),
        )
            .into_response(),
        Err(err) => internal(err),
    }
}

async fn login(
    State(state): State<AppState>,
    ClientAddr(addr): ClientAddr,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    if let Some(origin) = headers.get(header::ORIGIN).and_then(|v| v.to_str().ok()) {
        if !state.settings.public_origin_matches(origin) && origin != "http://127.0.0.1:8766" {
            return error(StatusCode::FORBIDDEN, "Invalid origin");
        }
    }
    if !state.limiter.allow(&format!("login:{addr}"), 10) {
        return error(StatusCode::TOO_MANY_REQUESTS, "稍后再试");
    }
    let data: Value = serde_json::from_slice(&body).unwrap_or(Value::Null);
    let token = data.get("token").and_then(Value::as_str).unwrap_or("");
    match auth::authenticate(&state.db, Some(token)).await {
        Ok(Some(_)) => {
            let mut response = Json(json!({"ok": true})).into_response();
            let cookie = format!("{SESSION_COOKIE}={token}; Secure; HttpOnly; SameSite=Strict; Max-Age={SESSION_SECONDS}; Path=/");
            match HeaderValue::from_str(&cookie) {
                Ok(value) => {
                    response.headers_mut().insert(header::SET_COOKIE, value);
                    response
                }
                Err(_) => error(StatusCode::UNAUTHORIZED, "访问码无效或已撤销"),
            }
        }
        Ok(None) => error(StatusCode::UNAUTHORIZED, "访问码无效或已撤销"),
        Err(err) => internal(err),
    }
}

async fn logout() -> Response {
    let mut response = Json(json!({"ok": true})).into_response();
    response.headers_mut().insert(
        header::SET_COOKIE,
        HeaderValue::from_static("fm_session=; Expires=Thu, 01 Jan 1970 00:00:00 GMT; Max-Age=0; Secure; HttpOnly; SameSite=Strict; Path=/"),
    );
    response
}

async fn upload(
    State(state): State<AppState>,
    ClientAddr(addr): ClientAddr,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let started = Instant::now();
    if !state.limiter.allow(&format!("upload-ip:{addr}"), 240) {
        return error(StatusCode::TOO_MANY_REQUESTS, "Rate limited");
    }
    let collector = match auth::authenticate(&state.db, bearer(&headers)).await {
        Ok(Some(c)) => c,
        Ok(None) => return error(StatusCode::UNAUTHORIZED, "Collector token required"),
        Err(err) => return internal(err),
    };
    if !state
        .limiter
        .allow(&format!("upload:{}", collector.public_id), 120)
    {
        return error(StatusCode::TOO_MANY_REQUESTS, "Rate limited");
    }
    let now = unix_now();
    let parsed = serde_json::from_slice::<Value>(&body)
        .ok()
        .map(|v| validate(&v, now));
    let upload = match parsed {
        Some(Ok(upload)) => upload,
        Some(Err(err)) => {
            tracing::debug!(error = %err, "upload rejected");
            return error(StatusCode::BAD_REQUEST, "Invalid observation schema");
        }
        None => return error(StatusCode::BAD_REQUEST, "Invalid observation schema"),
    };
    let outcome = match state.uploads.submit(collector, upload, body, now).await {
        Ok(outcome) => Ok(outcome),
        Err(crate::upload_queue::QueueError::Ingest(error)) => Err(error),
        Err(crate::upload_queue::QueueError::Full) => {
            let mut response = error(StatusCode::SERVICE_UNAVAILABLE, "Upload queue busy; retry later");
            response.headers_mut().insert(header::RETRY_AFTER, HeaderValue::from_static("1"));
            return response;
        }
    };
    let elapsed_ms = started.elapsed().as_secs_f64() * 1000.0;
    match outcome {
        Ok(IngestOutcome::Created(done)) => {
            tracing::info!(
                elapsed_ms,
                items = done.touched_items,
                sales = done.sales_added,
                "upload stored"
            );
            (
                StatusCode::CREATED,
                Json(json!({"ok": true, "duplicate": false})),
            )
                .into_response()
        }
        Ok(IngestOutcome::Duplicate) => {
            (StatusCode::OK, Json(json!({"ok": true, "duplicate": true}))).into_response()
        }
        Err(IngestError::Conflict) => {
            error(StatusCode::CONFLICT, "Observation ID content conflict")
        }
        Err(IngestError::Db(err)) => internal(err),
    }
}

async fn missing_locations(
    State(state): State<AppState>,
    headers: HeaderMap,
    RawQuery(query): RawQuery,
) -> Response {
    let collector = match auth::authenticate(&state.db, bearer(&headers)).await {
        Ok(Some(c)) => c,
        Ok(None) => return error(StatusCode::UNAUTHORIZED, "Collector token required"),
        Err(err) => return internal(err),
    };
    if !state
        .limiter
        .allow(&format!("missing-locations:{}", collector.id), 30)
    {
        return error(StatusCode::TOO_MANY_REQUESTS, "Rate limited");
    }
    let after = query_param(&query, "after")
        .and_then(|s| s.parse::<i64>().ok())
        .unwrap_or(0)
        .max(0);
    let rows: Vec<(i64,String)> = match sqlx::query_as("SELECT o.id,o.observation_id FROM observations o JOIN shops s ON s.id=o.shop_id
        WHERE o.collector_id=$1 AND s.channel IS NULL AND s.room IS NULL AND o.id>$2 ORDER BY o.id LIMIT 500")
        .bind(collector.id).bind(after).fetch_all(&state.db).await {
        Ok(rows)=>rows, Err(err)=>return internal(err),
    };
    Json(
        json!({"observations": rows.iter().map(|(_,id)|id).collect::<Vec<_>>(),
        "next": if rows.len()==500 {rows.last().map(|(id,_)|*id)} else {None}}),
    )
    .into_response()
}

async fn repair_location(
    State(state): State<AppState>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let collector = match auth::authenticate(&state.db, bearer(&headers)).await {
        Ok(Some(c)) => c,
        Ok(None) => return error(StatusCode::UNAUTHORIZED, "Collector token required"),
        Err(err) => return internal(err),
    };
    if !state
        .limiter
        .allow(&format!("repair-location:{}", collector.id), 120)
    {
        return error(StatusCode::TOO_MANY_REQUESTS, "Rate limited");
    }
    let now = unix_now();
    let upload = match serde_json::from_slice::<Value>(&body)
        .ok()
        .and_then(|v| validate(&v, now).ok())
    {
        Some(u) => u,
        None => return error(StatusCode::BAD_REQUEST, "Invalid observation schema"),
    };
    match crate::ingest::repair_location(
        &state.write_db,
        Received {
            collector: &collector,
            upload: &upload,
            raw: &body,
            received_at: now,
            now,
        },
    )
    .await
    {
        Ok(repaired) => Json(json!({"ok":true,"repaired":repaired})).into_response(),
        Err(IngestError::Conflict) => error(
            StatusCode::CONFLICT,
            "Only a missing location can be filled; original observation must match",
        ),
        Err(IngestError::Db(err)) => internal(err),
    }
}

async fn repair_owner(State(state): State<AppState>, headers: HeaderMap, body: Bytes) -> Response {
    let collector = match auth::authenticate(&state.db, bearer(&headers)).await {
        Ok(Some(c)) => c,
        Ok(None) => return error(StatusCode::UNAUTHORIZED, "Collector token required"),
        Err(err) => return internal(err),
    };
    if !state
        .limiter
        .allow(&format!("repair-owner:{}", collector.id), 120)
    {
        return error(StatusCode::TOO_MANY_REQUESTS, "Rate limited");
    }
    let now = unix_now();
    // Historical enrichment may be older than the new-upload acceptance window.
    // repair_owner still requires an exact existing observation owned by this caller.
    let upload = serde_json::from_slice::<Value>(&body).ok().and_then(|v| {
        let observed = v.get("observed_at")?.as_f64()?;
        if !observed.is_finite() || observed > now + 120.0 {
            return None;
        }
        validate(&v, observed).ok()
    });
    let Some(upload) = upload else {
        return error(StatusCode::BAD_REQUEST, "Invalid observation schema");
    };
    match crate::ingest::repair_owner(
        &state.write_db,
        Received {
            collector: &collector,
            upload: &upload,
            raw: &body,
            received_at: now,
            now,
        },
    )
    .await
    {
        Ok(repaired) => Json(json!({"ok":true,"repaired":repaired})).into_response(),
        Err(IngestError::Conflict) => error(
            StatusCode::CONFLICT,
            "Owner enrichment requires matching original observation",
        ),
        Err(IngestError::Db(err)) => internal(err),
    }
}

async fn market_overview(State(state): State<AppState>, ClientAddr(addr): ClientAddr,
    headers: HeaderMap, RawQuery(query): RawQuery) -> Response {
    market_projection(state, addr, headers, query, true).await
}

async fn market_selected(State(state): State<AppState>, ClientAddr(addr): ClientAddr,
    headers: HeaderMap, RawQuery(query): RawQuery) -> Response {
    market_projection(state, addr, headers, query, false).await
}

async fn market_projection(state: AppState, addr: String, headers: HeaderMap, query: Option<String>, overview: bool) -> Response {
    let key = match read_key(&state, &headers, &addr, "read").await { Ok(key) => key, Err(response) => return response };
    let Some(hours) = Hours::parse(query_param(&query, "hours").as_deref()) else {
        return error(StatusCode::BAD_REQUEST, "hours must be 72 or all");
    };
    let version = match views::version(&state.db).await { Ok(v) => v, Err(err) => return internal(err) };
    if let Err(response) = spend_read(&state, &key, state.market_lists.projection_ready(hours, version)) {
        return response;
    }
    let Some(ids) = views::parse_item_ids(&query_param(&query, "ids").unwrap_or_default()) else {
        return error(StatusCode::BAD_REQUEST, "Invalid item IDs");
    };
    match state.market_lists.projection(&state.db, hours, state.settings.public_read, if overview {None} else {Some(&ids)}).await {
        Ok(value) => {
            crate::delivery::revalidate(&headers, &format!("projection:{overview}:{}:{ids:?}", hours.key()), value)
        }
        Err(err) => internal(err),
    }
}

/// `ids=` of `view=list`: at most `MAX_CHANGED_ITEMS` decimal ids, sorted.
fn list_ids(value: &str) -> Option<Vec<i32>> {
    if value.is_empty() {
        return Some(Vec::new());
    }
    let mut ids: Vec<i32> = value
        .split(',')
        .map(|id| {
            id.bytes()
                .all(|b| b.is_ascii_digit())
                .then(|| id.parse().ok())
                .flatten()
        })
        .collect::<Option<_>>()?;
    ids.sort_unstable();
    ids.dedup();
    (ids.len() <= crate::realtime::MAX_CHANGED_ITEMS).then_some(ids)
}

/// `view=list`, whole or `ids=` rows. Every committed upload changes the
/// version, so browsers keep the list and revalidate it (`no-cache`).
async fn market_list(
    state: &AppState,
    key: &str,
    headers: &HeaderMap,
    hours: Hours,
    ids: Option<String>,
) -> Response {
    let ids = match ids.as_deref().map(list_ids) {
        None => None,
        Some(Some(ids)) => Some(ids),
        Some(None) => return error(StatusCode::BAD_REQUEST, "ids must be at most 200 item IDs"),
    };
    let scope = match &ids {
        None => format!("market|list|{}", hours.key()),
        Some(ids) => format!("market|list|{}|ids|{ids:?}", hours.key()),
    };
    let private = |mut response: Response, encoded: bool| {
        let headers = response.headers_mut();
        headers.insert(
            header::CACHE_CONTROL,
            HeaderValue::from_static("private, no-cache"),
        );
        if encoded {
            headers.insert(header::VARY, HeaderValue::from_static("accept-encoding"));
        }
        response
    };
    let version = match views::version(&state.db).await {
        Ok(version) => version,
        Err(err) => return internal(err),
    };
    let tag = etag(version, &scope);
    if not_modified(headers, &tag) {
        if let Err(response) = spend_read(state, key, true) {
            return response;
        }
        return private(unchanged(&tag), ids.is_none());
    }
    let list = match state.market_lists.peek(hours, version) {
        Some(list) => match spend_read(state, key, true) {
            Ok(()) => list,
            Err(response) => return response,
        },
        None => {
            if let Err(response) = spend_read(state, key, false) {
                return response;
            }
            match state
                .market_lists
                .get(&state.db, hours, state.settings.public_read)
                .await
            {
                Ok(list) => list,
                Err(err) => return internal(err),
            }
        }
    };
    let tag = etag(list.version, &scope);
    if let Some(ids) = ids {
        // Small: `CompressionLayer` compresses it per response.
        return private(json_response(Some(&tag), list.select(&ids)), false);
    }
    let coding = crate::encoding::Accepted::from_headers(headers).preferred();
    let body = match coding {
        Some(coding) => list.encoded(coding).await,
        None => list.body(),
    };
    let mut response = Response::new(Body::from(body));
    let response_headers = response.headers_mut();
    response_headers.insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static("application/json; charset=utf-8"),
    );
    response_headers.insert(header::ETAG, HeaderValue::from_str(&tag).expect("hex tag"));
    if let Some(coding) = coding {
        response_headers.insert(header::CONTENT_ENCODING, coding.header());
    }
    private(response, true)
}

async fn market(
    State(state): State<AppState>,
    ClientAddr(addr): ClientAddr,
    headers: HeaderMap,
    RawQuery(query): RawQuery,
) -> Response {
    let key = match read_key(&state, &headers, &addr, "read").await {
        Ok(key) => key,
        Err(response) => return response,
    };
    let Some(hours) = Hours::parse(query_param(&query, "hours").as_deref()) else {
        return error(StatusCode::BAD_REQUEST, "hours must be 72 or all");
    };
    let layout = query_param(&query, "view").unwrap_or_default();
    if !layout.is_empty() && layout != "list" {
        return error(StatusCode::BAD_REQUEST, "view must be list");
    }
    let item = query_param(&query, "item_id").unwrap_or_default();
    let item_id = item
        .chars()
        .all(|c| c.is_ascii_digit())
        .then(|| item.parse::<i32>().ok())
        .flatten();
    let summary = query_param(&query, "summary").as_deref() == Some("1");
    let (db, public, now) = (&state.db, state.settings.public_read, unix_now());

    if layout == "list" && item.is_empty() {
        return market_list(&state, &key, &headers, hours, query_param(&query, "ids")).await;
    }
    if let Err(response) = spend_read(&state, &key, false) {
        return response;
    }

    let version = match views::version(db).await {
        Ok(v) => v,
        Err(err) => return internal(err),
    };
    let key = match (layout.as_str(), item.is_empty(), item_id) {
        ("list", true, _) => format!("market|list|{}", hours.key()),
        (_, _, Some(id)) => format!("market|item|{id}|{}", hours.key()),
        _ => format!("market|summary|{}|{summary}", hours.key()),
    };
    let tag = etag(version, &key);
    if not_modified(&headers, &tag) {
        return unchanged(&tag);
    }
    let body = match (layout.as_str(), item.is_empty(), item_id) {
        ("list", true, _) => views::market_list(db, hours, now, public)
            .await
            .map(|(_, body)| body),
        (_, _, Some(id)) => views::market_item(db, id, hours, now, public)
            .await
            .map(|v| serde_json::to_vec(&v).expect("serialisable")),
        // The full report (every quote, sale and history row) is not served;
        // a bare request gets the summary.
        _ => views::market_summary(db, hours, now, public)
            .await
            .map(|(_, v)| serde_json::to_vec(&v).expect("serialisable")),
    };
    match body {
        Ok(body) => json_response(Some(&tag), body),
        Err(err) => internal(err),
    }
}

async fn sales_recent(
    State(state): State<AppState>,
    ClientAddr(addr): ClientAddr,
    headers: HeaderMap,
    RawQuery(query): RawQuery,
) -> Response {
    if let Err(response) = reader(&state, &headers, &addr, "sales").await {
        return response;
    }
    let Some(q) = SalesQuery::parse(|name| query_param(&query, name)) else {
        return error(StatusCode::BAD_REQUEST, "Invalid sales query");
    };
    let version = match views::version(&state.db).await {
        Ok(v) => v,
        Err(err) => return internal(err),
    };
    let tag = etag(version, &q.etag_key());
    if not_modified(&headers, &tag) {
        return unchanged(&tag);
    }
    match views::recent_sales(&state.db, &q, unix_now()).await {
        Ok(value) => json_response(
            Some(&tag),
            serde_json::to_vec(&value).expect("serialisable"),
        ),
        Err(err) => internal(err),
    }
}

async fn market_records(
    State(state): State<AppState>,
    ClientAddr(addr): ClientAddr,
    headers: HeaderMap,
    RawQuery(query): RawQuery,
) -> Response {
    if let Err(response) = reader(&state, &headers, &addr, "market-records").await {
        return response;
    }
    let Some(hours) = Hours::parse(query_param(&query, "hours").as_deref()) else {
        return error(StatusCode::BAD_REQUEST, "Invalid hours");
    };
    let sales = match query_param(&query, "kind").as_deref() {
        Some("quotes") => false,
        Some("sales") => true,
        _ => return error(StatusCode::BAD_REQUEST, "Invalid record kind"),
    };
    let version = match views::version(&state.db).await {
        Ok(v) => v,
        Err(err) => return internal(err),
    };
    let tag = etag(version, &format!("records|{}|{sales}", hours.key()));
    if not_modified(&headers, &tag) {
        return unchanged(&tag);
    }
    match state
        .market_lists
        .report(
            &state.db,
            crate::market_cache::Report::Records(hours, sales),
        )
        .await
    {
        Ok((version, body)) => json_response(
            Some(&etag(version, &format!("records|{}|{sales}", hours.key()))),
            body,
        ),
        Err(err) => internal(err),
    }
}

async fn quotes_recent(
    State(state): State<AppState>,
    ClientAddr(addr): ClientAddr,
    headers: HeaderMap,
    RawQuery(query): RawQuery,
) -> Response {
    if let Err(response) = reader(&state, &headers, &addr, "quotes").await {
        return response;
    }
    let Some(hours) = Hours::parse(query_param(&query, "hours").as_deref()) else {
        return error(StatusCode::BAD_REQUEST, "Invalid hours");
    };
    let limit = query_param(&query, "limit").unwrap_or_else(|| "8".into());
    let Some(limit) = limit
        .chars()
        .all(|c| c.is_ascii_digit())
        .then(|| limit.parse::<i64>().ok())
        .flatten()
        .filter(|n| (1..=100).contains(n))
    else {
        return error(StatusCode::BAD_REQUEST, "Invalid limit");
    };
    let version = match views::version(&state.db).await {
        Ok(value) => value,
        Err(err) => return internal(err),
    };
    let tag = etag(version, &format!("quotes|{}|{limit}", hours.key()));
    if not_modified(&headers, &tag) {
        return unchanged(&tag);
    }
    match state
        .market_lists
        .report(&state.db, crate::market_cache::Report::Quotes(hours, limit))
        .await
    {
        Ok((version, body)) => json_response(
            Some(&etag(version, &format!("quotes|{}|{limit}", hours.key()))),
            body,
        ),
        Err(err) => internal(err),
    }
}

fn item_id(path: &str) -> Option<i32> {
    path.chars()
        .all(|c| c.is_ascii_digit())
        .then(|| path.parse().ok())
        .flatten()
}

async fn require_member_unless_public(
    state: &AppState,
    headers: &HeaderMap,
    message: &str,
) -> Result<(), Response> {
    if state.settings.public_read || member(state, headers).await?.is_some() {
        Ok(())
    } else {
        Err(error(StatusCode::UNAUTHORIZED, message))
    }
}

async fn item_record(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<String>,
) -> Response {
    if let Err(response) = require_member_unless_public(&state, &headers, "请登录").await {
        return response;
    }
    let Some(id) = item_id(&id) else {
        return error(StatusCode::NOT_FOUND, "Not found");
    };
    match views::item_record(&state.db, id).await {
        Ok(Some(record)) => Json(record).into_response(),
        Ok(None) => error(StatusCode::NOT_FOUND, "Not found"),
        Err(err) => internal(err),
    }
}

async fn enhancement_scrolls(
    State(state): State<AppState>,
    ClientAddr(addr): ClientAddr,
    headers: HeaderMap,
    Path(id): Path<String>,
) -> Response {
    if let Err(response) = reader(&state, &headers, &addr, "enhancement").await {
        return response;
    }
    let Some(id) = item_id(&id).filter(|id| (1_000_000..2_000_000).contains(id)) else {
        return error(StatusCode::BAD_REQUEST, "Choose an equipment item");
    };
    match views::enhancement_scrolls(&state.db, id).await {
        Ok(records) => Json(json!({"scrolls": records})).into_response(),
        Err(err) => internal(err),
    }
}

async fn crafting_prices(
    State(state): State<AppState>,
    ClientAddr(addr): ClientAddr,
    headers: HeaderMap,
) -> Response {
    if let Err(response) = reader(&state, &headers, &addr, "crafting").await {
        return response;
    }
    match state.public_reads.get(&state.db, "crafting", async {
        let now = unix_now();
        let prices = crate::crafting::prices(&state.db, now).await?;
        Ok(Some(json!({"as_of": now, "prices": prices})))
    }).await {
        Ok(Some(value)) => Json(value).into_response(),
        Ok(None) => unreachable!("crafting snapshot always exists"),
        Err(err) => internal(err),
    }
}

async fn item_page(
    State(state): State<AppState>,
    ClientAddr(addr): ClientAddr,
    headers: HeaderMap,
    Path(id): Path<String>,
) -> Response {
    if let Err(response) = reader(&state, &headers, &addr, "item").await {
        return response;
    }
    let Some(id) = item_id(&id) else {
        return error(StatusCode::NOT_FOUND, "Not found");
    };
    let version = match views::version(&state.db).await {
        Ok(v) => v,
        Err(err) => return internal(err),
    };
    let tag = etag(version, &format!("item|{id}"));
    if not_modified(&headers, &tag) {
        return unchanged(&tag);
    }
    match views::item_page(&state.db, id, unix_now()).await {
        Ok(Some(value)) => json_response(
            Some(&tag),
            serde_json::to_vec(&value).expect("serialisable"),
        ),
        Ok(None) => error(StatusCode::NOT_FOUND, "Not found"),
        Err(err) => internal(err),
    }
}

async fn watch_catalog(
    State(state): State<AppState>,
    ClientAddr(addr): ClientAddr,
    headers: HeaderMap,
    RawQuery(query): RawQuery,
) -> Response {
    if let Err(response) = require_member_unless_public(&state, &headers, "Please sign in").await {
        return response;
    }
    if !state.limiter.allow(&format!("watch-catalog:{addr}"), 60) {
        return error(StatusCode::TOO_MANY_REQUESTS, "Rate limited");
    }
    let q = query_param(&query, "q").unwrap_or_default();
    match views::search_catalog(&state.db, &q).await {
        Ok(value) => Json(value).into_response(),
        Err(err) => internal(err),
    }
}

async fn watch_listings(
    State(state): State<AppState>,
    ClientAddr(addr): ClientAddr,
    headers: HeaderMap,
    RawQuery(query): RawQuery,
) -> Response {
    if let Err(response) = require_member_unless_public(&state, &headers, "Please sign in").await {
        return response;
    }
    if !state.limiter.allow(&format!("watch-listings:{addr}"), 60) {
        return error(StatusCode::TOO_MANY_REQUESTS, "Rate limited");
    }
    let Some(ids) = views::parse_item_ids(&query_param(&query, "ids").unwrap_or_default()) else {
        return error(StatusCode::BAD_REQUEST, "Invalid item IDs");
    };
    let mut ids = ids;
    ids.sort_unstable();
    let key = format!("watch:{ids:?}");
    match state.public_reads.get_items(&state.db, &key, &ids, async {
        views::watch_listings(&state.db, &ids, unix_now()).await.map(Some)
    }).await {
        Ok(Some(value)) => crate::delivery::revalidate(&headers, &key, value),
        Ok(None) => unreachable!("watch snapshot always exists"),
        Err(err) => internal(err),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn query_decoding_and_cookies() {
        assert_eq!(
            url_decode_pairs("category=%E5%85%B6%E4%BB%96&q=a+b&x"),
            vec![
                ("category".into(), "其他".into()),
                ("q".into(), "a b".into()),
                ("x".into(), "".into())
            ]
        );
        assert_eq!(percent_decode("100%"), "100%");
        assert_eq!(percent_decode("%zz"), "%zz");
        let mut headers = HeaderMap::new();
        headers.insert(
            header::COOKIE,
            HeaderValue::from_static("a=1; fm_session=tok; b=2"),
        );
        assert_eq!(session_cookie(&headers), Some("tok"));
    }

    #[test]
    fn etag_revalidation_accepts_weak_and_star() {
        let tag = etag(3, "market|list|72");
        let mut headers = HeaderMap::new();
        headers.insert(
            header::IF_NONE_MATCH,
            HeaderValue::from_str(&format!("\"x\", W/{tag}")).unwrap(),
        );
        assert!(not_modified(&headers, &tag));
        headers.insert(header::IF_NONE_MATCH, HeaderValue::from_static("*"));
        assert!(not_modified(&headers, &tag));
        assert_ne!(etag(4, "market|list|72"), tag);
    }
}

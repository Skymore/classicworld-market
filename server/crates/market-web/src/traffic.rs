//! First-party anonymous page views and a loopback-only operator dashboard.
use std::net::SocketAddr;

use axum::{
    extract::{ConnectInfo, DefaultBodyLimit, Query, State},
    http::{header, HeaderMap, StatusCode},
    response::{Html, IntoResponse, Response},
    routing::{get, post},
    Extension, Json, Router,
};
use serde::Deserialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use sqlx::{types::chrono::Utc, PgPool};

use crate::{api::ClientAddr, AppState};

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/api/v1/traffic/event", post(event))
        .route("/api/v1/traffic/summary", get(summary))
        .route("/traffic", get(dashboard))
        .layer(DefaultBodyLimit::max(4096))
}

// The tunnel connects over loopback too: require a local Host and reject all
// proxy metadata, as well as requiring the actual socket peer to be local.
fn local(headers: &HeaderMap, peer: Option<Extension<ConnectInfo<SocketAddr>>>) -> bool {
    peer.is_some_and(|Extension(ConnectInfo(address))| address.ip().is_loopback())
        && ![
            "cf-connecting-ip",
            "forwarded",
            "x-forwarded-for",
            "x-forwarded-host",
            "x-forwarded-proto",
        ]
        .iter()
        .any(|key| headers.contains_key(*key))
        && headers
            .get(header::HOST)
            .and_then(|v| v.to_str().ok())
            .and_then(|v| v.parse::<axum::http::uri::Authority>().ok())
            .is_some_and(|v| matches!(v.host(), "localhost" | "127.0.0.1" | "[::1]"))
}

async fn dashboard(
    headers: HeaderMap,
    peer: Option<Extension<ConnectInfo<SocketAddr>>>,
) -> Response {
    if !local(&headers, peer) {
        return StatusCode::NOT_FOUND.into_response();
    }
    (
        [
            (header::CONTENT_SECURITY_POLICY, crate::web::CSP),
            (header::CACHE_CONTROL, "no-store"),
            (header::X_FRAME_OPTIONS, "DENY"),
        ],
        Html(include_str!("../../../../web/traffic.html")),
    )
        .into_response()
}

#[derive(Deserialize)]
struct Event {
    event_id: String,
    visitor: String,
    path: String,
    #[serde(default)]
    referrer: String,
    device: String,
}

fn hex_id(value: &str) -> bool {
    value.len() == 32
        && value
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

fn page_path(value: &str) -> Option<String> {
    let path = value.split(['?', '#']).next()?.trim_end_matches('/');
    let path = if path.is_empty() { "/" } else { path };
    if [
        "/",
        "/prices",
        "/watch",
        "/alerts",
        "/account",
        "/privacy",
        "/contributors",
        "/selling",
        "/agent",
        "/search",
        "/route",
        "/collect",
        "/web/download.html",
    ]
    .contains(&path)
    {
        return Some(path.to_owned());
    }
    let (kind, id) = path.strip_prefix('/')?.split_once('/')?;
    if ["item", "mob", "map", "prices"].contains(&kind)
        && !id.is_empty()
        && id.len() <= 10
        && id.bytes().all(|b| b.is_ascii_digit())
    {
        return Some(path.to_owned());
    }
    // Conversation and account subroutes never expose their identifiers.
    ["agent", "account", "watch", "alerts", "selling"]
        .contains(&kind)
        .then(|| format!("/{kind}"))
}

fn source(referrer: &str, hostname: &str) -> String {
    url::Url::parse(referrer)
        .ok()
        .filter(|url| matches!(url.scheme(), "http" | "https"))
        .and_then(|url| match url.host() {
            Some(url::Host::Domain(host)) => Some(host.to_owned()),
            _ => None,
        })
        .filter(|host| host != hostname && host.len() <= 253)
        .unwrap_or_default()
}

async fn event(
    State(state): State<AppState>,
    ClientAddr(address): ClientAddr,
    headers: HeaderMap,
    peer: Option<Extension<ConnectInfo<SocketAddr>>>,
    Json(input): Json<Event>,
) -> Response {
    let public_origin = format!("https://{}", state.settings.hostname);
    let origin = headers.get(header::ORIGIN).and_then(|v| v.to_str().ok());
    let local_origin = local(&headers, peer)
        && origin.is_some_and(|origin| {
            url::Url::parse(origin).ok().is_some_and(|url| {
                matches!(url.scheme(), "http" | "https")
                    && matches!(url.host_str(), Some("localhost" | "127.0.0.1" | "[::1]"))
            })
        });
    if origin != Some(public_origin.as_str()) && !local_origin {
        return StatusCode::FORBIDDEN.into_response();
    }
    if !state.settings.public_read
        || headers.get("dnt").is_some_and(|v| v == "1")
        || headers.get("sec-gpc").is_some_and(|v| v == "1")
    {
        return StatusCode::NO_CONTENT.into_response();
    }
    let agent = headers
        .get(header::USER_AGENT)
        .and_then(|v| v.to_str().ok())
        .unwrap_or_default()
        .to_ascii_lowercase();
    if ["bot", "spider", "crawler", "headless", "uptime", "monitor"]
        .iter()
        .any(|word| agent.contains(word))
    {
        return StatusCode::NO_CONTENT.into_response();
    }
    if !hex_id(&input.event_id)
        || !hex_id(&input.visitor)
        || !["phone", "tablet", "desktop"].contains(&input.device.as_str())
    {
        return StatusCode::BAD_REQUEST.into_response();
    }
    let Some(path) = page_path(&input.path) else {
        return StatusCode::NO_CONTENT.into_response();
    };
    if !state.limiter.allow(&format!("traffic:{address}"), 120) {
        return StatusCode::TOO_MANY_REQUESTS.into_response();
    }
    let day = Utc::now().date_naive();
    let hash = Sha256::digest(format!("{day}:{}", input.visitor)).to_vec();
    let result = sqlx::query(
        "INSERT INTO site_pageviews(event_id,day,visitor_hash,path,source,device)
        VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT(event_id) DO NOTHING",
    )
    .bind(input.event_id)
    .bind(day)
    .bind(hash)
    .bind(path)
    .bind(source(&input.referrer, &state.settings.hostname))
    .bind(input.device)
    .execute(&state.db)
    .await;
    match result {
        Ok(_) => StatusCode::NO_CONTENT.into_response(),
        Err(error) => {
            tracing::warn!(%error, "traffic recording failed");
            StatusCode::SERVICE_UNAVAILABLE.into_response()
        }
    }
}

#[derive(Default, Deserialize)]
struct Period {
    days: Option<i32>,
}

async fn summary(
    State(state): State<AppState>,
    headers: HeaderMap,
    peer: Option<Extension<ConnectInfo<SocketAddr>>>,
    Query(period): Query<Period>,
) -> Response {
    if !local(&headers, peer) {
        return StatusCode::NOT_FOUND.into_response();
    }
    match report(&state.db, period.days.unwrap_or(30).clamp(1, 90)).await {
        Ok(value) => Json(value).into_response(),
        Err(error) => {
            tracing::warn!(%error, "traffic summary failed");
            StatusCode::SERVICE_UNAVAILABLE.into_response()
        }
    }
}

pub async fn report(db: &PgPool, days: i32) -> sqlx::Result<Value> {
    let days = days.clamp(1, 90);
    let today = Utc::now().date_naive();
    let start = today - chrono::Duration::days(i64::from(days - 1));
    let daily: Vec<(String, i64, i64)> = sqlx::query_as(
        "SELECT d::date::text,count(p.event_id),count(DISTINCT p.visitor_hash)
         FROM generate_series($1::date,$2::date,interval '1 day') d
         LEFT JOIN site_pageviews p ON p.day=d::date GROUP BY d ORDER BY d",
    )
    .bind(start)
    .bind(today)
    .fetch_all(db)
    .await?;
    let pages: Vec<(String, i64)> = sqlx::query_as(
        "SELECT path,count(*) FROM site_pageviews WHERE day BETWEEN $1 AND $2
         GROUP BY path ORDER BY count(*) DESC,path LIMIT 20",
    )
    .bind(start)
    .bind(today)
    .fetch_all(db)
    .await?;
    let sources: Vec<(String, i64)> = sqlx::query_as(
        "SELECT source,count(*) FROM site_pageviews WHERE day BETWEEN $1 AND $2
         GROUP BY source ORDER BY count(*) DESC,source LIMIT 20",
    )
    .bind(start)
    .bind(today)
    .fetch_all(db)
    .await?;
    let devices: Vec<(String, i64)> = sqlx::query_as(
        "SELECT device,count(*) FROM site_pageviews WHERE day BETWEEN $1 AND $2
         GROUP BY device ORDER BY count(*) DESC,device",
    )
    .bind(start)
    .bind(today)
    .fetch_all(db)
    .await?;
    let pageviews: i64 = daily.iter().map(|v| v.1).sum();
    let daily_visitors: i64 = daily.iter().map(|v| v.2).sum();
    let last = daily.last().expect("at least one day");
    Ok(
        json!({"days":days,"timezone":"UTC","pageviews":pageviews,"daily_visitors":daily_visitors,
        "today":{"pageviews":last.1,"visitors":last.2},
        "daily":daily.iter().map(|(day,pv,uv)|json!({"day":day,"pageviews":pv,"visitors":uv})).collect::<Vec<_>>(),
        "pages":pages.iter().map(|(path,count)|json!({"name":path,"count":count})).collect::<Vec<_>>(),
        "sources":sources.iter().map(|(host,count)|json!({"name":host,"count":count})).collect::<Vec<_>>(),
        "devices":devices.iter().map(|(device,count)|json!({"name":device,"count":count})).collect::<Vec<_>>() }),
    )
}

/// Run hourly; only the most recent 90 UTC dates are retained.
pub async fn prune(db: PgPool) {
    let mut interval = tokio::time::interval(std::time::Duration::from_secs(3600));
    loop {
        interval.tick().await;
        if let Err(error) = sqlx::query(
            "DELETE FROM site_pageviews WHERE day < (now() AT TIME ZONE 'UTC')::date - 89",
        )
        .execute(&db)
        .await
        {
            tracing::warn!(%error, "traffic retention cleanup failed");
        }
    }
}

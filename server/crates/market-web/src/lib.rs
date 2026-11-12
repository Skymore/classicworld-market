//! Router and shared state. `main.rs` wires config and the listener; tests
//! and the tools build the router or call the modules directly.

use std::sync::Arc;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use axum::{
    extract::State,
    http::{header, HeaderName, HeaderValue, StatusCode},
    response::IntoResponse,
    routing::get,
    Json, Router,
};
use serde::Serialize;
use sqlx::{postgres::PgPoolOptions, PgPool};
use tower_http::{
    compression::CompressionLayer,
    set_header::SetResponseHeaderLayer,
    trace::{DefaultOnResponse, TraceLayer},
    CompressionLevel, LatencyUnit,
};

pub mod accounts;
pub mod agent;
pub mod alerts;
pub mod api;
pub mod auth;
pub mod bestiary;
pub mod catalog_cache;
pub mod collector_updates;
pub mod config;
pub mod contributors;
pub mod crafting;
mod delivery;
pub mod devices;
pub mod diagnostics;
mod encoding;
pub mod external;
pub mod grind;
pub mod i18n;
pub mod ingest;
pub mod legacy;
pub mod market_cache;
pub mod presence;
pub mod push;
pub mod realtime;
pub mod remote_debug;
pub mod roster;
pub mod sale_matching;
pub mod scan_assignments;
pub mod search;
mod static_files;
pub mod stats;
pub mod sweep;
pub mod traffic;
pub mod upload_queue;
pub mod views;
pub mod web;
mod write_timing;

/// Behaviour switches of `shared_server.create_app`.
#[derive(Debug, Clone)]
pub struct Settings {
    /// Anyone may read and register (the deployed default); otherwise
    /// reads need a collector token or the login cookie.
    pub public_read: bool,
    /// Public host name, for the registration answer and login origins.
    pub hostname: String,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            public_read: true,
            hostname: "mxd.ruit.me".into(),
        }
    }
}

impl Settings {
    /// These aliases belong to the deployed market, not to custom/private hosts.
    pub fn public_hostname_matches(&self, host: &str) -> bool {
        host == self.hostname
            || (self.hostname == "mxd.ruit.me"
                && ["meso.ruit.me", "ms.ruit.me", "mscw.ruit.me"].contains(&host))
    }

    pub fn public_origin_matches(&self, origin: &str) -> bool {
        origin
            .strip_prefix("https://")
            .is_some_and(|host| self.public_hostname_matches(host))
    }
}

#[cfg(test)]
mod public_host_tests {
    use super::Settings;

    #[test]
    fn market_aliases_accept_only_exact_https_origins() {
        let settings = Settings::default();
        for host in ["mxd.ruit.me", "meso.ruit.me", "ms.ruit.me", "mscw.ruit.me"] {
            assert!(settings.public_origin_matches(&format!("https://{host}")));
            assert!(!settings.public_origin_matches(&format!("http://{host}")));
            assert!(!settings.public_origin_matches(&format!("https://{host}.evil.example")));
            assert!(!settings.public_origin_matches(&format!("https://{host}/")));
        }
        assert!(!settings.public_origin_matches("https://unrelated.ruit.me"));
        let private = Settings {
            hostname: "private.example".into(),
            ..settings
        };
        assert!(private.public_origin_matches("https://private.example"));
        assert!(!private.public_origin_matches("https://ms.ruit.me"));
    }
}

#[derive(Clone)]
pub struct AppState {
    pub remote_debug: Arc<remote_debug::Hub>,
    pub db: PgPool,
    /// Waiting for the serial market writer must never consume read connections.
    pub write_db: PgPool,
    pub uploads: Arc<upload_queue::UploadQueue>,
    /// Short task leases must not queue behind market aggregation or uploads.
    pub scan_db: PgPool,
    pub market_lists: Arc<market_cache::MarketListCache>,
    pub public_reads: Arc<market_cache::PublicReadCache>,
    pub alert_calculations: Arc<tokio::sync::Semaphore>,
    pub started: Instant,
    pub settings: Arc<Settings>,
    pub limiter: Arc<auth::RateLimiter>,
    /// Committed `market_changed` notices: the changed item ids, `None`
    /// when unknown (see `realtime::notify_market`).
    pub events: tokio::sync::broadcast::Sender<realtime::MarketChange>,
    /// Route graphs and the search area list, per catalogue import.
    pub catalog: Arc<catalog_cache::CatalogCache>,
    /// Committed `account_changed` notices: (account id, topic).
    pub account_events: tokio::sync::broadcast::Sender<(i64, &'static str)>,
    pub collector_updates: tokio::sync::watch::Sender<Option<String>>,
    pub google: Option<Arc<contributors::GoogleOAuth>>,
    pub agent: Option<Arc<agent::OpenRouter>>,
    /// `None` when no VAPID key is configured.
    pub push: Option<Arc<push::WebPush>>,
}

impl AppState {
    pub fn new(db: PgPool, settings: Settings) -> Self {
        let write_db = PgPoolOptions::new()
            .max_connections(1)
            .connect_lazy_with(db.connect_options().as_ref().clone());
        let scan_db = PgPoolOptions::new()
            .max_connections(2)
            .acquire_timeout(Duration::from_secs(2))
            .connect_lazy_with(db.connect_options().as_ref().clone());
        Self {
            remote_debug: Arc::default(),
            db,
            uploads: Arc::new(upload_queue::UploadQueue::new(write_db.clone())),
            write_db,
            scan_db,
            market_lists: Arc::default(),
            public_reads: Arc::default(),
            alert_calculations: Arc::new(tokio::sync::Semaphore::new(2)),
            started: Instant::now(),
            settings: Arc::new(settings),
            limiter: Arc::default(),
            events: tokio::sync::broadcast::channel(64).0,
            catalog: Arc::default(),
            account_events: tokio::sync::broadcast::channel(256).0,
            collector_updates: tokio::sync::watch::channel(None).0,
            google: None,
            agent: None,
            push: None,
        }
    }
}

pub fn unix_now() -> f64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("clock after 1970")
        .as_secs_f64()
}

/// Headers `shared_server.py` puts on API answers. Scoped to `/api` so
/// cacheable SSR pages keep their own policy.
fn api_headers(router: Router<AppState>) -> Router<AppState> {
    let set = |name: HeaderName, value: &'static str| {
        SetResponseHeaderLayer::if_not_present(name, HeaderValue::from_static(value))
    };
    router
        .layer(set(header::CACHE_CONTROL, "no-store"))
        .layer(set(header::X_FRAME_OPTIONS, "DENY"))
        .layer(set(header::REFERRER_POLICY, "no-referrer"))
}

pub fn app(state: AppState) -> Router {
    app_with_web(state, None)
}

/// `web_dir`: the repository's `web/` tree, served at `/v2` and `/collect`.
pub fn app_with_web(state: AppState, web_dir: Option<&std::path::Path>) -> Router {
    let web = web_dir.map(web::routes).unwrap_or_default();
    Router::new()
        .merge(web)
        .route("/healthz", get(healthz))
        .route("/readyz", get(readyz))
        .route("/api/v1/version", get(version))
        .route("/api/v1/i18n/ko", get(i18n::names_api))
        .route("/api/v1/i18n/ko-ui", get(i18n::ui_api))
        .route("/api/v1/i18n/guess", get(i18n::guess_api))
        .merge(api_headers(api::router()))
        .merge(api_headers(agent::router()))
        .merge(api_headers(contributors::router()))
        .merge(api_headers(scan_assignments::router()))
        .merge(api_headers(traffic::router()))
        .merge(api_headers(accounts::router()))
        .merge(api_headers(devices::router()))
        .merge(api_headers(sweep::router()))
        .merge(api_headers(push::router()))
        .merge(api_headers(grind::router()))
        .merge(bestiary::routes())
        .layer(SetResponseHeaderLayer::if_not_present(
            header::X_CONTENT_TYPE_OPTIONS,
            HeaderValue::from_static("nosniff"),
        ))
        // Per-response compression of everything not already encoded (the
        // market list and web/ text files are, see `encoding`). Level 4: a
        // 750 KB JSON answer is 78 KB br in ~8 ms, 90 KB gzip in ~5 ms.
        .layer(CompressionLayer::new().quality(CompressionLevel::Precise(4)))
        .layer(
            // Microseconds: list answers take a few milliseconds.
            TraceLayer::new_for_http()
                .on_response(DefaultOnResponse::new().latency_unit(LatencyUnit::Micros)),
        )
        .layer(axum::middleware::from_fn(request_timing))
        .layer(axum::middleware::from_fn(collector_frames))
        .with_state(state)
}

/// The collector window shows site sections in a frame of its loopback UI
/// (`?embed=1`, kept on every link inside it). Only those pages may be framed,
/// and only by a loopback page; everything else keeps `frame-ancestors 'none'`.
async fn collector_frames(
    request: axum::extract::Request,
    next: axum::middleware::Next,
) -> axum::response::Response {
    let embedded = request
        .uri()
        .query()
        .is_some_and(|q| q.split('&').any(|pair| pair == "embed=1"));
    let mut response = next.run(request).await;
    if embedded {
        if let Some(csp) = response
            .headers()
            .get(header::CONTENT_SECURITY_POLICY)
            .and_then(|v| v.to_str().ok())
            .filter(|v| v.contains("frame-ancestors 'none'"))
        {
            let relaxed = csp.replace(
                "frame-ancestors 'none'",
                "frame-ancestors 'self' http://127.0.0.1:* http://localhost:*",
            );
            if let Ok(value) = HeaderValue::from_str(&relaxed) {
                response
                    .headers_mut()
                    .insert(header::CONTENT_SECURITY_POLICY, value);
            }
        }
    }
    response
}

/// Log route templates, never query strings, cookies or request bodies.
async fn request_timing(
    request: axum::extract::Request,
    next: axum::middleware::Next,
) -> axum::response::Response {
    let route = request
        .extensions()
        .get::<axum::extract::MatchedPath>()
        .map(|p| p.as_str().to_owned())
        .unwrap_or_default();
    let started = Instant::now();
    let mut response = next.run(request).await;
    let elapsed_ms = started.elapsed().as_secs_f64() * 1000.0;
    if route.starts_with("/api/") {
        if let Ok(value) = HeaderValue::from_str(&format!("app;dur={elapsed_ms:.1}")) {
            response.headers_mut().insert("server-timing", value);
        }
        if elapsed_ms >= 250.0 {
            tracing::warn!(
                route,
                elapsed_ms,
                status = response.status().as_u16(),
                "slow API request"
            );
        }
    }
    response
}

#[derive(Serialize)]
struct Health {
    status: &'static str,
    uptime_seconds: u64,
}

/// Process is up. Does not touch the database, so a DB outage does not make
/// the orchestrator restart the web container.
async fn healthz(State(state): State<AppState>) -> Json<Health> {
    Json(Health {
        status: "ok",
        uptime_seconds: state.started.elapsed().as_secs(),
    })
}

#[derive(Serialize)]
struct Ready {
    status: &'static str,
    database: &'static str,
}

/// Ready to serve: the database answers.
async fn readyz(State(state): State<AppState>) -> impl IntoResponse {
    match sqlx::query_scalar::<_, i32>("SELECT 1")
        .fetch_one(&state.db)
        .await
    {
        Ok(_) => (
            StatusCode::OK,
            Json(Ready {
                status: "ok",
                database: "ok",
            }),
        ),
        Err(err) => {
            tracing::warn!(error = %err, "readiness check failed");
            (
                StatusCode::SERVICE_UNAVAILABLE,
                Json(Ready {
                    status: "unavailable",
                    database: "error",
                }),
            )
        }
    }
}

#[derive(Serialize)]
struct Version {
    name: &'static str,
    version: &'static str,
}

async fn version() -> Json<Version> {
    Json(Version {
        name: env!("CARGO_PKG_NAME"),
        version: env!("CARGO_PKG_VERSION"),
    })
}

/// Embedded migrations from `server/migrations`.
pub static MIGRATOR: sqlx::migrate::Migrator = sqlx::migrate!("../../migrations");

//! Router and shared state. `main.rs` wires config and the listener; tests
//! and the tools build the router or call the modules directly.

use std::sync::Arc;
use std::time::{Instant, SystemTime, UNIX_EPOCH};

use axum::{
    extract::State,
    http::{header, HeaderName, HeaderValue, StatusCode},
    response::IntoResponse,
    routing::get,
    Json, Router,
};
use serde::Serialize;
use sqlx::PgPool;
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
pub mod collector_updates;
pub mod config;
pub mod contributors;
pub mod crafting;
pub mod external;
pub mod ingest;
pub mod legacy;
pub mod realtime;
pub(crate) mod search;
pub mod stats;
pub mod traffic;
pub mod views;
pub mod web;

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

#[derive(Clone)]
pub struct AppState {
    pub db: PgPool,
    pub started: Instant,
    pub settings: Arc<Settings>,
    pub limiter: Arc<auth::RateLimiter>,
    pub events: tokio::sync::broadcast::Sender<()>,
    pub collector_updates: tokio::sync::watch::Sender<Option<String>>,
    pub google: Option<Arc<contributors::GoogleOAuth>>,
    pub agent: Option<Arc<agent::OpenRouter>>,
}

impl AppState {
    pub fn new(db: PgPool, settings: Settings) -> Self {
        Self {
            db,
            started: Instant::now(),
            settings: Arc::new(settings),
            limiter: Arc::default(),
            events: tokio::sync::broadcast::channel(64).0,
            collector_updates: tokio::sync::watch::channel(None).0,
            google: None,
            agent: None,
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
        .merge(api_headers(api::router()))
        .merge(api_headers(agent::router()))
        .merge(api_headers(contributors::router()))
        .merge(api_headers(traffic::router()))
        .merge(api_headers(accounts::router()))
        .merge(bestiary::routes())
        .layer(SetResponseHeaderLayer::if_not_present(
            header::X_CONTENT_TYPE_OPTIONS,
            HeaderValue::from_static("nosniff"),
        ))
        // Level 3: the 1001-item list is ~80 KB gzip in ~4 ms; the default
        // level saves ~10 KB more for twice the time.
        .layer(CompressionLayer::new().quality(CompressionLevel::Precise(3)))
        .layer(
            // Microseconds: list answers take a few milliseconds.
            TraceLayer::new_for_http()
                .on_response(DefaultOnResponse::new().latency_unit(LatencyUnit::Micros)),
        )
        .with_state(state)
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

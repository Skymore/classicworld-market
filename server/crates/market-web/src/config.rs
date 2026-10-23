//! Configuration from environment variables. Compose passes them from `.env`.

use std::net::SocketAddr;
use std::path::PathBuf;
use std::time::Duration;

use anyhow::{Context, Result};

use crate::Settings;

#[derive(Debug, Clone)]
pub struct Config {
    pub database_url: String,
    pub bind: SocketAddr,
    pub db_max_connections: u32,
    pub settings: Settings,
    /// How often time-driven stats changes are checked (see `stats`).
    pub stats_refresh: Duration,
    /// The `web/` tree (new UI at /v2, collector at /collect). `None` serves
    /// the API and bestiary pages only.
    pub web_dir: Option<PathBuf>,
}

fn parsed<T: std::str::FromStr>(name: &str) -> Result<Option<T>>
where
    T::Err: std::error::Error + Send + Sync + 'static,
{
    std::env::var(name)
        .ok()
        .map(|v| v.parse().with_context(|| format!("{name} is invalid")))
        .transpose()
}

impl Config {
    pub fn from_env() -> Result<Self> {
        let database_url = std::env::var("DATABASE_URL").context("DATABASE_URL is not set")?;
        // Loopback unless told otherwise; compose sets 0.0.0.0 inside the
        // container and publishes the port on 127.0.0.1 only.
        let bind = parsed("BIND")?.unwrap_or_else(|| SocketAddr::from(([127, 0, 0, 1], 8080)));
        let defaults = Settings::default();
        Ok(Self {
            database_url,
            bind,
            db_max_connections: parsed("DB_MAX_CONNECTIONS")?.unwrap_or(8),
            settings: Settings {
                public_read: parsed("PUBLIC_READ")?.unwrap_or(defaults.public_read),
                hostname: std::env::var("PUBLIC_HOSTNAME").unwrap_or(defaults.hostname),
            },
            stats_refresh: Duration::from_secs(parsed("STATS_REFRESH_SECONDS")?.unwrap_or(60)),
            web_dir: std::env::var_os("WEB_DIR").map(PathBuf::from),
        })
    }
}

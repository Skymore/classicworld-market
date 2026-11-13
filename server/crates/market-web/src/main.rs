use std::net::SocketAddr;
use std::time::Duration;

use anyhow::{Context, Result};
use market_web::{app_with_web, config::Config, stats, unix_now, AppState, MIGRATOR};
use sqlx::{postgres::PgPoolOptions, PgPool};
use tracing_subscriber::EnvFilter;

#[tokio::main]
async fn main() -> Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(
            EnvFilter::try_from_default_env().unwrap_or_else(|_| "info,sqlx=warn".into()),
        )
        .init();

    let config = Config::from_env()?;
    let db = PgPoolOptions::new()
        .max_connections(config.db_max_connections)
        .connect(&config.database_url)
        .await
        .context("connecting to Postgres")?;
    MIGRATOR.run(&db).await.context("running migrations")?;
    // The refresh coordinator and its batch transaction use two connections.
    // Neither should queue for, or occupy, the public read pool.
    let maintenance_db = PgPoolOptions::new()
        .max_connections(2)
        .connect_lazy_with(db.connect_options().as_ref().clone());
    tokio::spawn(refresh_stats(maintenance_db, config.stats_refresh));
    // Writers mark items; one connection of its own recomputes them every 2 s.
    stats::defer_recompute(true);
    let dirty_db = PgPoolOptions::new()
        .max_connections(1)
        .connect_lazy_with(db.connect_options().as_ref().clone());
    tokio::spawn(recompute_dirty(dirty_db));
    tokio::spawn(market_web::traffic::prune(db.clone()));
    tokio::spawn({
        let db = db.clone();
        async move {
            match market_web::ingest::retire_all_replaced_stalls(&db, unix_now()).await {
                Ok(n) => tracing::info!(items = n, "retired shops covered by newer stalls"),
                Err(err) => tracing::warn!(%err, "retiring shops covered by newer stalls failed"),
            }
        }
    });
    tokio::spawn(market_web::diagnostics::prune());
    tokio::spawn(market_web::remote_debug::prune());

    let mut state = AppState::new(db, config.settings.clone());
    let read_cache = state.public_reads.clone();
    tokio::spawn(async move {
        let mut tick = tokio::time::interval(Duration::from_secs(60));
        tick.tick().await;
        loop {
            tick.tick().await;
            for (lane, sample) in read_cache.take_metrics() {
                if sample.requests > 0 {
                    tracing::info!(
                        lane,
                        requests = sample.requests,
                        hits = sample.hits,
                        rebuilds = sample.rebuilds,
                        evictions = sample.evictions,
                        bypasses = sample.bypasses,
                        cold = sample.cold,
                        expired = sample.expired,
                        invalidated = sample.invalidated,
                        entries = sample.entries,
                        key_wait_ms = sample.key_wait_ms,
                        permit_wait_ms = sample.permit_wait_ms,
                        lookup_ms = sample.lookup_ms,
                        wait_ms = sample.wait_ms,
                        build_ms = sample.build_ms,
                        "public cache interval"
                    );
                }
            }
        }
    });
    state.agent = market_web::agent::OpenRouter::from_env()?.map(std::sync::Arc::new);
    state.push = market_web::push::WebPush::from_env()?.map(std::sync::Arc::new);
    if let Some(push) = state.push.clone() {
        // Rounds hold an advisory lock on one connection and query on the other.
        let push_db = PgPoolOptions::new()
            .max_connections(2)
            .connect_lazy_with(state.db.connect_options().as_ref().clone());
        tokio::spawn(market_web::push::run(push_db, push));
        tracing::info!("web push enabled");
    }
    state.google = market_web::contributors::GoogleOAuth::load(
        config.web_dir.as_deref(),
        &config.settings.hostname,
    )?
    .map(std::sync::Arc::new);
    // Korean names for the pages and /api/v1/i18n/ko (catalogue joined to the client pack).
    tokio::spawn({
        let db = state.db.clone();
        async move { market_web::i18n::load_names(&db).await }
    });
    tokio::spawn(market_web::realtime::listen(
        state.db.clone(),
        state.events.clone(),
        state.collector_updates.clone(),
        state.account_events.clone(),
    ));
    let listener = tokio::net::TcpListener::bind(config.bind)
        .await
        .with_context(|| format!("binding {}", config.bind))?;
    tracing::info!(bind = %config.bind, public_read = config.settings.public_read, "market-web listening");
    axum::serve(
        listener,
        app_with_web(state, config.web_dir.as_deref())
            .into_make_service_with_connect_info::<SocketAddr>(),
    )
    .with_graceful_shutdown(shutdown_signal())
    .await
    .context("serving")?;
    Ok(())
}

/// Keeps untouched items current as the sale anchor and the 72-hour window move.
async fn refresh_stats(db: PgPool, every: Duration) {
    let mut tick = tokio::time::interval(every);
    loop {
        tick.tick().await;
        match stats::refresh_if_due(&db, unix_now()).await {
            Ok(true) => tracing::info!("item stats refreshed"),
            Ok(false) => {}
            Err(err) => tracing::warn!(error = %err, "item stats refresh failed"),
        }
    }
}

async fn recompute_dirty(db: PgPool) {
    let mut tick = tokio::time::interval(Duration::from_secs(2));
    loop {
        tick.tick().await;
        loop {
            let started = std::time::Instant::now();
            match stats::recompute_dirty(&db, unix_now()).await {
                Ok(n) => {
                    let ms = started.elapsed().as_millis();
                    if ms >= 2000 {
                        tracing::info!(items = n, elapsed_ms = ms as u64, "slow background stats pass");
                    }
                    if n < stats::DIRTY_BATCH {
                        break;
                    }
                }
                Err(err) => {
                    tracing::warn!(error = %err, "background stats pass failed");
                    break;
                }
            }
        }
    }
}

async fn shutdown_signal() {
    let ctrl_c = tokio::signal::ctrl_c();
    #[cfg(unix)]
    {
        let mut term = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
            .expect("install SIGTERM handler");
        tokio::select! {
            _ = ctrl_c => {},
            _ = term.recv() => {},
        }
    }
    #[cfg(not(unix))]
    {
        let _ = ctrl_c.await;
    }
    tracing::info!("shutting down");
}

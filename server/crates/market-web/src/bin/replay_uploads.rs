//! Replay the Python site's uploads through the write path, in observed order.
//!
//!     DATABASE_URL=... cargo run --release -p market-web --bin replay_uploads -- data/fixture/shared/market.sqlite
//!
//! Reads `uploads` (cleaned v1 payloads) and copies `members` as collectors,
//! so existing collector tokens keep working. When `uploads` is empty (the
//! dev fixture), rebuilds uploads from `visits`. Each upload is validated
//! against the clock it was received at.

use std::collections::{BTreeMap, HashMap};
use std::path::PathBuf;
use std::time::Instant;

use anyhow::{Context, Result};
use market_core::protocol::validate;
use market_web::auth::{new_credentials, token_hash, Collector};
use market_web::ingest::{ingest, IngestError, IngestOutcome, Received};
use market_web::{legacy, stats, unix_now, MIGRATOR};
use sqlx::PgPool;

#[tokio::main]
async fn main() -> Result<()> {
    let path: PathBuf = std::env::args()
        .nth(1)
        .context("usage: replay_uploads <market.sqlite>")?
        .into();
    let db =
        PgPool::connect(&std::env::var("DATABASE_URL").context("DATABASE_URL is not set")?).await?;
    MIGRATOR.run(&db).await?;

    let members = legacy::read_members(&path)?;
    for m in &members {
        let hash =
            hex::decode(&m.hash).with_context(|| format!("token hash of member {}", m.id))?;
        sqlx::query(
            "INSERT INTO collectors (public_id, token_hash, source, name, active, created_at)
             VALUES ($1, $2, 'packet', $3, $4, COALESCE(to_timestamp($5), now())) ON CONFLICT (public_id) DO NOTHING",
        )
        .bind(&m.id)
        .bind(hash)
        .bind(&m.name)
        .bind(m.active)
        .bind(m.created)
        .execute(&db)
        .await?;
    }
    let mut uploads = legacy::read_uploads(&path)?;
    let source = if uploads.is_empty() {
        uploads = legacy::uploads_from_visits(&path)?;
        "visits"
    } else {
        "uploads"
    };
    println!(
        "{} uploads from {source}, {} members",
        uploads.len(),
        members.len()
    );

    let mut collectors: HashMap<String, Collector> = HashMap::new();
    for name in uploads.iter().map(|u| u.collector.clone()) {
        if collectors.contains_key(&name) {
            continue;
        }
        // Collectors without a members row (the fixture's placeholder) get an
        // inactive identity with a token nobody holds.
        sqlx::query(
            "INSERT INTO collectors (public_id, token_hash, source, name, active) VALUES ($1, $2, 'packet', $1, false)
             ON CONFLICT (public_id) DO NOTHING",
        )
        .bind(&name)
        .bind(token_hash(&new_credentials().token))
        .execute(&db)
        .await?;
        let id: i64 = sqlx::query_scalar("SELECT id FROM collectors WHERE public_id = $1")
            .bind(&name)
            .fetch_one(&db)
            .await?;
        collectors.insert(
            name.clone(),
            Collector {
                id,
                public_id: name,
            },
        );
    }

    let started = Instant::now();
    let mut outcomes: BTreeMap<&str, usize> = BTreeMap::new();
    let mut fingerprint_mismatches = 0;
    let mut latencies = Vec::with_capacity(uploads.len());
    for (n, legacy) in uploads.iter().enumerate() {
        let upload = match validate(&legacy.payload, legacy.received) {
            Ok(upload) => upload,
            Err(err) => {
                eprintln!("rejected {}: {err}", legacy.visit_id);
                *outcomes.entry("rejected").or_default() += 1;
                continue;
            }
        };
        if legacy
            .fingerprint
            .as_deref()
            .is_some_and(|fp| fp != upload.fingerprint())
        {
            fingerprint_mismatches += 1;
        }
        let raw = serde_json::to_vec(&legacy.payload)?;
        let one = Instant::now();
        let outcome = ingest(
            &db,
            Received {
                collector: &collectors[&legacy.collector],
                upload: &upload,
                raw: &raw,
                received_at: legacy.received,
                now: unix_now(),
            },
        )
        .await;
        latencies.push(one.elapsed().as_secs_f64() * 1000.0);
        let key = match outcome {
            Ok(IngestOutcome::Created(_)) => "created",
            Ok(IngestOutcome::Duplicate) => "duplicate",
            Err(IngestError::Conflict) => "conflict",
            Err(IngestError::Db(err)) => return Err(err).context("ingesting"),
        };
        *outcomes.entry(key).or_default() += 1;
        if (n + 1) % 1000 == 0 {
            println!("{}/{} uploads", n + 1, uploads.len());
        }
    }
    let elapsed = started.elapsed().as_secs_f64();
    latencies.sort_by(f64::total_cmp);
    let pick = |q: f64| {
        latencies
            .get(((latencies.len() as f64 - 1.0) * q).round() as usize)
            .copied()
            .unwrap_or(0.0)
    };
    println!("outcomes {outcomes:?}, python fingerprint mismatches {fingerprint_mismatches}");
    println!(
        "{:.1}s total; per upload p50 {:.2} ms, p95 {:.2} ms, p99 {:.2} ms, max {:.2} ms",
        elapsed,
        pick(0.5),
        pick(0.95),
        pick(0.99),
        pick(1.0)
    );

    let refreshed = Instant::now();
    let mut tx = db.begin().await?;
    stats::lock_writes(&mut tx).await?;
    let items = stats::refresh_all(&mut tx, unix_now()).await?;
    tx.commit().await?;
    println!(
        "full stats refresh: {items} items in {:.0} ms",
        refreshed.elapsed().as_secs_f64() * 1000.0
    );

    let kinds: Vec<(String, i64)> =
        sqlx::query_as("SELECT kind, count(*) FROM sales GROUP BY kind ORDER BY kind")
            .fetch_all(&db)
            .await?;
    let listings: i64 = sqlx::query_scalar("SELECT count(*) FROM listings WHERE stock > 0")
        .fetch_one(&db)
        .await?;
    println!("sales by kind {kinds:?}; listings with stock {listings}");
    Ok(())
}

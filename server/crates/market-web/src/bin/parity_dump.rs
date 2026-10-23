//! Dump what the read path serves, for `server/tools/parity.py`.
//!
//!     DATABASE_URL=... cargo run --release -p market-web --bin parity_dump -- --now 1792390000 > rust.json
//!
//! Recomputes every item at the given clock first, so the 72-hour window
//! matches the Python report built with the same clock.

use std::time::Instant;

use anyhow::{Context, Result};
use market_web::views::{self, Hours, SalesQuery};

const PAGES: usize = 20;
use market_web::{stats, unix_now};
use serde_json::{json, Value};
use sqlx::PgPool;

#[tokio::main]
async fn main() -> Result<()> {
    let args: Vec<String> = std::env::args().collect();
    let now = match args.iter().position(|a| a == "--now") {
        Some(i) => args
            .get(i + 1)
            .context("--now needs a value")?
            .parse()
            .context("--now")?,
        None => unix_now(),
    };
    let db =
        PgPool::connect(&std::env::var("DATABASE_URL").context("DATABASE_URL is not set")?).await?;

    let started = Instant::now();
    let mut tx = db.begin().await?;
    stats::lock_writes(&mut tx).await?;
    let items = stats::refresh_all(&mut tx, now).await?;
    tx.commit().await?;
    eprintln!(
        "refreshed {items} items in {:.0} ms",
        started.elapsed().as_secs_f64() * 1000.0
    );

    let kinds: Vec<(String, i64)> =
        sqlx::query_as("SELECT kind, count(*) FROM sales GROUP BY kind")
            .fetch_all(&db)
            .await?;
    let mut windows = serde_json::Map::new();
    for hours in [Hours::Recent, Hours::All] {
        let (_, summary) = views::market_summary(&db, hours, now, true).await?;
        let (_, list) = views::market_list(&db, hours, now, true).await?;
        let list: Value = serde_json::from_slice(&list)?;
        windows.insert(
            hours.key().into(),
            json!({"summary": summary, "list": list}),
        );
    }
    // Recent-sales pages, all items and one category, following next_before.
    let mut feeds = serde_json::Map::new();
    for category in [None, Some("装备")] {
        let mut pages = Vec::new();
        let mut before = None;
        for _ in 0..PAGES {
            let query = SalesQuery {
                limit: 50,
                before,
                item_id: None,
                category,
            };
            let page = views::recent_sales(&db, &query, now).await?;
            before = page["next_before"].as_f64();
            pages.push(page);
            if before.is_none() {
                break;
            }
        }
        feeds.insert(category.unwrap_or("all").into(), Value::Array(pages));
    }
    let dump = json!({
        "feeds": feeds,
        "now": now,
        "sales_by_kind": kinds.into_iter().map(|(k, v)| (k, json!(v))).collect::<serde_json::Map<_, _>>(),
        "windows": windows,
    });
    println!("{dump}");
    Ok(())
}

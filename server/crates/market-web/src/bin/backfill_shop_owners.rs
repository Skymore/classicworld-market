//! Local administrator import of structured owner evidence. Requires DATABASE_URL.
//! Each JSONL row is {"collector": public_id, "payload": validated observation}.
//! Uses the same immutable-observation checks and transactions as authenticated HTTP repairs.
use anyhow::{bail, Context, Result};
use market_core::protocol::validate;
use market_web::{
    auth::Collector,
    ingest::{repair_owner, IngestError, Received},
    unix_now,
};
use serde_json::Value;
use sqlx::postgres::PgPoolOptions;
use std::io::{BufRead, BufReader};

#[tokio::main]
async fn main() -> Result<()> {
    let args: Vec<_> = std::env::args().collect();
    if args.len() != 3 || args[1] != "--apply" {
        bail!("Usage: backfill_shop_owners --apply <evidence.jsonl>; back up the database first");
    }
    let db = PgPoolOptions::new()
        .max_connections(1)
        .connect(&std::env::var("DATABASE_URL")?)
        .await?;
    let input = BufReader::new(std::fs::File::open(&args[2])?);
    let (mut repaired, mut unchanged, mut conflicts) = (0, 0, 0);
    for (index, line) in input.lines().enumerate() {
        let line = line?;
        if line.len() > 262144 {
            bail!("Evidence row {} is too large", index + 1);
        }
        let entry: Value = serde_json::from_str(&line).context("Invalid evidence JSON")?;
        let public = entry["collector"].as_str().context("Missing collector")?;
        let (id, public_id): (i64, String) =
            sqlx::query_as("SELECT id,public_id FROM collectors WHERE public_id=$1")
                .bind(public)
                .fetch_one(&db)
                .await?;
        let collector = Collector { id, public_id };
        let payload = &entry["payload"];
        let observed = payload["observed_at"]
            .as_f64()
            .context("Missing observation time")?;
        if !observed.is_finite() || observed > unix_now() + 120. {
            bail!("Invalid observation time");
        }
        let upload = validate(payload, observed)?;
        let raw = serde_json::to_vec(payload)?;
        match repair_owner(
            &db,
            Received {
                collector: &collector,
                upload: &upload,
                raw: &raw,
                received_at: unix_now(),
                now: unix_now(),
            },
        )
        .await
        {
            Ok(true) => repaired += 1,
            Ok(false) => unchanged += 1,
            Err(IngestError::Conflict) => conflicts += 1,
            Err(error) => return Err(error.into()),
        }
        if (index + 1) % 100 == 0 {
            println!(
                "processed={} repaired={repaired} unchanged={unchanged} conflicts={conflicts}",
                index + 1
            );
        }
        // Yield between short transactions so live uploads retain priority.
        tokio::time::sleep(std::time::Duration::from_millis(10)).await;
    }
    println!("complete repaired={repaired} unchanged={unchanged} conflicts={conflicts}");
    db.close().await;
    Ok(())
}

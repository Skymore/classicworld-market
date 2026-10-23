//! Import offline, authorized raw evidence. Never reads the price-summary export as samples.
use anyhow::{Context, Result};
use market_web::{
    external::{self, Points},
    unix_now, MIGRATOR,
};
use sha2::{Digest, Sha256};
use sqlx::postgres::PgPoolOptions;

#[tokio::main]
async fn main() -> Result<()> {
    let path = std::env::args()
        .nth(1)
        .context("usage: import_mesowatch points-import.json")?;
    let raw = std::fs::read(path)?;
    let points: Points = serde_json::from_slice(&raw)?;
    let db = PgPoolOptions::new()
        .max_connections(2)
        .connect(&std::env::var("DATABASE_URL")?)
        .await?;
    MIGRATOR.run(&db).await?;
    let result =
        external::import(&db, &points, &hex::encode(Sha256::digest(&raw)), unix_now()).await?;
    println!("{}", serde_json::to_string_pretty(&result)?);
    Ok(())
}

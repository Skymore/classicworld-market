//! Offline entry point; scheduled sync uses the active market-web release.
use anyhow::{Context, Result};
#[tokio::main]
async fn main() -> Result<()> {
    let path = std::env::args()
        .nth(1)
        .context("usage: import_mesowatch points-import.json | --prune | --deduplicate")?;
    market_web::external::run_import(&path).await
}

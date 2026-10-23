//! Load `items` and `item_records` from an items.sqlite catalogue.
//!
//!     DATABASE_URL=... cargo run -p market-web --bin seed_items -- data/fixture/items.sqlite
//!
//! Minimal loader for tests and the parity run; R3's `import_catalog` is the
//! canonical importer.

use std::path::PathBuf;

use anyhow::{Context, Result};
use market_web::{legacy, MIGRATOR};

#[tokio::main]
async fn main() -> Result<()> {
    let path: PathBuf = std::env::args()
        .nth(1)
        .context("usage: seed_items <items.sqlite>")?
        .into();
    let db =
        sqlx::PgPool::connect(&std::env::var("DATABASE_URL").context("DATABASE_URL is not set")?)
            .await?;
    MIGRATOR.run(&db).await?;
    let items = legacy::read_catalog(&path)?;
    let count = legacy::seed_items(&db, &items).await?;
    println!("seeded {count} items from {}", path.display());
    Ok(())
}

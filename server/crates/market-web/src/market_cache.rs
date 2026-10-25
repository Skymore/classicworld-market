//! Two bounded entries, one per supported window. A version change makes the
//! next request rebuild once; concurrent SSE refreshes share that result.
use crate::{
    unix_now,
    views::{self, Hours},
};
use sqlx::PgPool;
use tokio::sync::Mutex;

type Entry = Option<(i64, Vec<u8>)>;

#[derive(Default)]
pub struct MarketListCache {
    recent: Mutex<Entry>,
    all: Mutex<Entry>,
}

impl MarketListCache {
    pub async fn get(
        &self,
        db: &PgPool,
        hours: Hours,
        public: bool,
    ) -> sqlx::Result<(i64, Vec<u8>)> {
        let mut entry = match hours {
            Hours::Recent => &self.recent,
            Hours::All => &self.all,
        }
        .lock()
        .await;
        // Read after acquiring the lock so a waiter cannot replace a newer
        // cached response with the version it saw before waiting.
        let version = views::version(db).await?;
        if let Some((cached_version, body)) = entry.as_ref() {
            if *cached_version == version {
                return Ok((version, body.clone()));
            }
        }
        let fresh = views::market_list(db, hours, unix_now(), public).await?;
        *entry = Some(fresh.clone());
        Ok(fresh)
    }
}

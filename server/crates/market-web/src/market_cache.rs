//! Bounded public response caches. Upload versions invalidate prices immediately;
//! callers waiting for a rebuild do not hold database connections.
use crate::{
    unix_now,
    views::{self, Hours},
};
use sqlx::PgPool;
use tokio::sync::{Mutex, Semaphore};

type Entry = Option<(i64, Vec<u8>)>;

type ReportEntry = Option<(i64, String, Vec<u8>)>;

#[derive(Clone, Copy)]
pub enum Report {
    Records(Hours, bool),
    Quotes(Hours, i64),
    Leaderboard(i32),
}

pub struct MarketListCache {
    recent: Mutex<Entry>,
    all: Mutex<Entry>,
    reports: [Mutex<ReportEntry>; 9],
    personal: [Mutex<ReportEntry>; 16],
    rebuilds: Semaphore,
}

impl Default for MarketListCache {
    fn default() -> Self {
        Self {
            recent: Mutex::new(None),
            all: Mutex::new(None),
            reports: std::array::from_fn(|_| Mutex::new(None)),
            personal: std::array::from_fn(|_| Mutex::new(None)),
            rebuilds: Semaphore::new(2),
        }
    }
}

impl MarketListCache {
    pub async fn personal_stats(
        &self,
        db: &PgPool,
        account: Option<i64>,
        collector: Option<i64>,
    ) -> sqlx::Result<serde_json::Value> {
        // Fixed-size shards bound memory; the full authenticated identity is
        // compared inside the shard, so a collision never shares private data.
        let slot =
            account.or(collector).unwrap_or_default().unsigned_abs() as usize % self.personal.len();
        let mut entry = self.personal[slot].lock().await;
        let _permit = self.rebuilds.acquire().await.expect("cache gate open");
        let version = (unix_now() / 30.0) as i64;
        let identity = format!(
            "{account:?}:{collector:?}:{}",
            crate::contributors::board_identity(db).await?
        );
        if let Some((old_version, old_identity, body)) = entry.as_ref() {
            if *old_version == version && *old_identity == identity {
                return Ok(serde_json::from_slice(body).expect("cached stats JSON"));
            }
        }
        let value = crate::contributors::personal_stats(db, account, collector).await?;
        *entry = Some((
            version,
            identity,
            serde_json::to_vec(&value).expect("serialisable"),
        ));
        Ok(value)
    }

    pub async fn report(&self, db: &PgPool, report: Report) -> sqlx::Result<(i64, Vec<u8>)> {
        let all = |h| usize::from(matches!(h, Hours::All));
        let slot = match report {
            Report::Records(h, sales) => all(h) * 2 + usize::from(sales),
            Report::Quotes(h, _) => 4 + all(h),
            Report::Leaderboard(days) => {
                6 + match days {
                    7 => 0,
                    30 => 1,
                    _ => 2,
                }
            }
        };
        let mut entry = self.reports[slot].lock().await;
        // Bound distinct concurrent rebuilds as well as coalescing identical ones.
        let _permit = self.rebuilds.acquire().await.expect("cache gate open");
        let version = if matches!(report, Report::Leaderboard(_)) {
            // Rankings may reuse counts for 30s; prices/alerts never use this clock.
            // The separate profile identity still makes opt-out/rename immediate.
            (unix_now() / 30.0) as i64
        } else {
            views::version(db).await?
        };
        let identity = match report {
            Report::Quotes(_, limit) => limit.to_string(),
            Report::Leaderboard(_) => crate::contributors::board_identity(db).await?,
            _ => String::new(),
        };
        if let Some((old_version, old_identity, body)) = entry.as_ref() {
            if *old_version == version && *old_identity == identity {
                return Ok((version, body.clone()));
            }
        }
        let now = unix_now();
        let value = match report {
            Report::Records(hours, sales) => views::latest_records(db, hours, sales, now).await?,
            Report::Quotes(hours, limit) => views::recent_quotes(db, hours, limit, now).await?,
            Report::Leaderboard(days) => crate::contributors::board(db, days).await?,
        };
        let body = serde_json::to_vec(&value).expect("serialisable");
        *entry = Some((version, identity, body.clone()));
        Ok((version, body))
    }

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

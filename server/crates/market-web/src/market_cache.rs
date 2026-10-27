//! Bounded public response caches. Upload versions invalidate prices immediately;
//! callers waiting for a rebuild do not hold database connections.
use crate::{
    unix_now,
    views::{self, Hours},
};
use sqlx::PgPool;
use tokio::sync::{Mutex, Semaphore};

struct PublicEntry {
    key: String,
    version: i64,
    built: std::time::Instant,
    value: Option<serde_json::Value>,
}

/// Shared public snapshots only. Full keys prevent shard collisions from mixing
/// filters/items; the database version invalidates committed changes immediately.
pub struct PublicReadCache {
    slots: [[Mutex<Option<PublicEntry>>; 32]; 3],
    rebuilds: [Semaphore; 3],
}

impl Default for PublicReadCache {
    fn default() -> Self {
        Self {
            slots: std::array::from_fn(|_| std::array::from_fn(|_| Mutex::new(None))),
            rebuilds: [Semaphore::new(2), Semaphore::new(1), Semaphore::new(1)],
        }
    }
}

impl PublicReadCache {
    pub async fn get<F>(&self, db: &PgPool, key: &str, build: F) -> sqlx::Result<Option<serde_json::Value>>
    where F: std::future::Future<Output = sqlx::Result<Option<serde_json::Value>>> {
        use std::hash::{Hash, Hasher};
        // Waiters need a snapshot at least as new as when their request began.
        // Requiring the version at the end of the wait would serialize another
        // rebuild per waiter whenever uploads commit during a slow history read.
        let requested_version = views::version(db).await?;
        let mut hash = std::collections::hash_map::DefaultHasher::new();
        key.hash(&mut hash);
        // Slow full histories cannot occupy crafting/watch rebuild permits or
        // collide with their cache shards. Each class remains independently bounded.
        let lane = if key == "crafting" { 1 } else if key.starts_with("watch:") { 2 } else { 0 };
        let slots = &self.slots[lane];
        let mut slot = slots[hash.finish() as usize % slots.len()].lock().await;
        if let Some(hit) = slot.as_ref() {
            if hit.key == key && hit.version >= requested_version && hit.built.elapsed().as_secs_f64() < 2.0 {
                return Ok(hit.value.clone());
            }
        }
        let _permit = self.rebuilds[lane].acquire().await.expect("public cache gate open");
        // A queued rebuild uses the current version, never the old request's
        // version. All waits above hold no database connection.
        let version = views::version(db).await?;
        let value = build.await?;
        *slot = Some(PublicEntry { key: key.to_owned(), version, built: std::time::Instant::now(), value: value.clone() });
        Ok(value)
    }
}

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
        let version = views::version(db).await?;
        let identity = format!(
            "{account:?}:{collector:?}:{}:{}",
            crate::contributors::board_identity(db).await?,
            unix_now() as i64
        );
        if let Some((old_version, old_identity, body)) = entry.as_ref() {
            if *old_version == version && *old_identity == identity {
                return Ok(serde_json::from_slice(body).expect("cached stats JSON"));
            }
        }
        let _permit = self.rebuilds.acquire().await.expect("cache gate open");
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
        // Every committed upload invalidates contribution counts too. The time
        // component below only expires rolling windows on subsequent reads;
        // it never delays invalidation after an upload.
        let version = views::version(db).await?;
        let identity = match report {
            Report::Quotes(_, limit) => limit.to_string(),
            Report::Leaderboard(_) => format!(
                "{}:{}",
                crate::contributors::board_identity(db).await?,
                unix_now() as i64
            ),
            _ => String::new(),
        };
        if let Some((old_version, old_identity, body)) = entry.as_ref() {
            if *old_version == version && *old_identity == identity {
                return Ok((version, body.clone()));
            }
        }
        let _permit = self.rebuilds.acquire().await.expect("cache gate open");
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

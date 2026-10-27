//! Bounded public response caches. Related commits invalidate prices immediately;
//! callers waiting for a rebuild do not hold database connections.
use crate::{
    unix_now,
    views::{self, Hours},
};
use sqlx::PgPool;
use std::{sync::atomic::{AtomicU64, Ordering}, time::Instant};
use tokio::sync::{Mutex, Semaphore};

#[derive(PartialEq)]
enum Revision {
    Market(i64),
    Items(Vec<(i32, i64)>),
}

impl Revision {
    fn covers(&self, requested: &Self) -> bool {
        match (self, requested) {
            (Self::Market(current), Self::Market(requested)) => current >= requested,
            (Self::Items(current), Self::Items(requested)) => current.len() == requested.len()
                && current.iter().zip(requested).all(|((id, version), (wanted, minimum))|
                    id == wanted && version >= minimum),
            _ => false,
        }
    }
}

async fn revision(db: &PgPool, items: Option<&[i32]>) -> sqlx::Result<Revision> {
    match items {
        None => views::version(db).await.map(Revision::Market),
        Some(ids) => sqlx::query_as(
            "SELECT item_id,read_revision FROM item_stats WHERE item_id=ANY($1) ORDER BY item_id")
            .bind(ids).fetch_all(db).await.map(Revision::Items),
    }
}

#[derive(Default)]
struct Counters {
    requests: AtomicU64,
    hits: AtomicU64,
    rebuilds: AtomicU64,
    collisions: AtomicU64,
    lookup_us: AtomicU64,
    wait_us: AtomicU64,
    build_us: AtomicU64,
}

#[derive(Debug)]
pub struct CacheMetrics {
    pub requests: u64,
    pub hits: u64,
    pub rebuilds: u64,
    pub collisions: u64,
    pub lookup_ms: f64,
    pub wait_ms: f64,
    pub build_ms: f64,
}

struct PublicEntry {
    key: String,
    revision: Revision,
    built: Instant,
    value: Option<serde_json::Value>,
}

/// Shared public snapshots only. Full keys prevent shard collisions from mixing
/// filters/items; transactional item revisions invalidate related commits.
pub struct PublicReadCache {
    slots: [[Mutex<Option<PublicEntry>>; 32]; 3],
    rebuilds: [Semaphore; 3],
    counters: [Counters; 3],
}

impl Default for PublicReadCache {
    fn default() -> Self {
        Self {
            slots: std::array::from_fn(|_| std::array::from_fn(|_| Mutex::new(None))),
            rebuilds: [Semaphore::new(2), Semaphore::new(1), Semaphore::new(1)],
            counters: std::array::from_fn(|_| Counters::default()),
        }
    }
}

impl PublicReadCache {
    pub async fn get<F>(&self, db: &PgPool, key: &str, build: F) -> sqlx::Result<Option<serde_json::Value>>
    where F: std::future::Future<Output = sqlx::Result<Option<serde_json::Value>>> {
        self.get_scoped(db, key, None, build).await
    }

    pub async fn get_items<F>(&self, db: &PgPool, key: &str, items: &[i32], build: F)
        -> sqlx::Result<Option<serde_json::Value>>
    where F: std::future::Future<Output = sqlx::Result<Option<serde_json::Value>>> {
        self.get_scoped(db, key, Some(items), build).await
    }

    async fn get_scoped<F>(&self, db: &PgPool, key: &str, items: Option<&[i32]>, build: F)
        -> sqlx::Result<Option<serde_json::Value>>
    where F: std::future::Future<Output = sqlx::Result<Option<serde_json::Value>>> {
        use std::hash::{Hash, Hasher};
        let requested = Instant::now();
        // Slow full histories cannot occupy crafting/watch rebuild permits or
        // collide with their cache shards. Each class remains independently bounded.
        let lane = if key == "crafting" { 1 } else if key.starts_with("watch:") { 2 } else { 0 };
        let counters = &self.counters[lane];
        counters.requests.fetch_add(1, Ordering::Relaxed);
        let requested_revision = revision(db, items).await?;
        counters.lookup_us.fetch_add(requested.elapsed().as_micros() as u64, Ordering::Relaxed);
        let mut hash = std::collections::hash_map::DefaultHasher::new();
        key.hash(&mut hash);
        let slots = &self.slots[lane];
        let waiting = Instant::now();
        let mut slot = slots[hash.finish() as usize % slots.len()].lock().await;
        if let Some(hit) = slot.as_ref() {
            // Every watched item's revision must be at least the one this
            // request observed. Compare membership too: deletion must never
            // hit a larger stale revision; recreated rows have new revisions.
            if hit.key == key && hit.revision.covers(&requested_revision)
                && hit.built.elapsed().as_secs_f64() < 2.0 {
                counters.hits.fetch_add(1, Ordering::Relaxed);
                counters.wait_us.fetch_add(waiting.elapsed().as_micros() as u64, Ordering::Relaxed);
                return Ok(hit.value.clone());
            }
            if hit.key != key { counters.collisions.fetch_add(1, Ordering::Relaxed); }
        }
        let _permit = self.rebuilds[lane].acquire().await.expect("public cache gate open");
        counters.wait_us.fetch_add(waiting.elapsed().as_micros() as u64, Ordering::Relaxed);
        // Capture current revisions after waiting, without holding a database
        // connection in the queue. No listener or invalidation message can be lost.
        let started = Instant::now();
        let revision = revision(db, items).await?;
        counters.rebuilds.fetch_add(1, Ordering::Relaxed);
        let result = build.await;
        counters.build_us.fetch_add(started.elapsed().as_micros() as u64, Ordering::Relaxed);
        let value = result?;
        *slot = Some(PublicEntry { key: key.to_owned(), revision, built: Instant::now(), value: value.clone() });
        Ok(value)
    }

    /// Aggregate operational metrics only: no keys, item IDs or user identities.
    pub fn take_metrics(&self) -> [(&'static str, CacheMetrics); 3] {
        std::array::from_fn(|lane| {
            let c = &self.counters[lane];
            let take = |v: &AtomicU64| v.swap(0, Ordering::Relaxed);
            (["item", "crafting", "watch"][lane], CacheMetrics {
                requests: take(&c.requests), hits: take(&c.hits), rebuilds: take(&c.rebuilds),
                collisions: take(&c.collisions), lookup_ms: take(&c.lookup_us) as f64 / 1000.,
                wait_ms: take(&c.wait_us) as f64 / 1000., build_ms: take(&c.build_us) as f64 / 1000.,
            })
        })
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

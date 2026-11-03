//! Bounded public response caches. Related commits invalidate prices immediately;
//! callers waiting for a rebuild do not hold database connections.
use crate::{
    encoding::{self, Coding},
    unix_now,
    views::{self, Hours},
};
use axum::body::Bytes;
use sqlx::PgPool;
use std::{collections::VecDeque, sync::{Arc, Mutex as RegistryMutex, atomic::{AtomicU64, Ordering}}, time::Instant};
use tokio::sync::{Mutex, OnceCell, Semaphore};

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
    evictions: AtomicU64,
    bypasses: AtomicU64,
    cold: AtomicU64,
    expired: AtomicU64,
    invalidated: AtomicU64,
    lookup_us: AtomicU64,
    key_wait_us: AtomicU64,
    permit_wait_us: AtomicU64,
    build_us: AtomicU64,
}

#[derive(Debug)]
pub struct CacheMetrics {
    pub requests: u64,
    pub hits: u64,
    pub rebuilds: u64,
    pub evictions: u64,
    pub bypasses: u64,
    pub cold: u64,
    pub expired: u64,
    pub invalidated: u64,
    pub entries: usize,
    pub lookup_ms: f64,
    pub wait_ms: f64,
    pub key_wait_ms: f64,
    pub permit_wait_ms: f64,
    pub build_ms: f64,
}

struct PublicEntry {
    revision: Revision,
    built: Instant,
    value: Option<serde_json::Value>,
}

type PublicSlot = Arc<Mutex<Option<PublicEntry>>>;

#[derive(Default)]
struct PublicLane {
    // At most 32 exact keys, oldest use first. This lock only protects the
    // registry, never a query, a response copy or an async wait.
    entries: RegistryMutex<VecDeque<(String, PublicSlot)>>,
}

impl PublicLane {
    fn slot(&self, key: &str, counters: &Counters) -> Option<PublicSlot> {
        let mut entries = self.entries.lock().expect("public cache registry");
        if let Some(index) = entries.iter().position(|(old, _)| old == key) {
            let entry = entries.remove(index).expect("existing cache key");
            let slot = entry.1.clone();
            entries.push_back(entry);
            return Some(slot);
        }
        let mut retired = None;
        if entries.len() == 32 {
            // A caller owns an Arc until it releases the entry lock. Never
            // evict a building entry or detach waiters from a shared rebuild.
            if let Some(index) = entries.iter().position(|(_, slot)| Arc::strong_count(slot) == 1) {
                retired = entries.remove(index);
                counters.evictions.fetch_add(1, Ordering::Relaxed);
            } else {
                // All keys are in use: keep memory bounded and run uncached,
                // still subject to the lane's database rebuild limit.
                counters.bypasses.fetch_add(1, Ordering::Relaxed);
                return None;
            }
        }
        let slot = Arc::new(Mutex::new(None));
        entries.push_back((key.to_owned(), slot.clone()));
        drop(entries);
        // Dropping a large retired response must not hold the registry lock.
        drop(retired);
        Some(slot)
    }
}

/// Shared public snapshots only. Exact keys isolate filters/items without hash
/// slot collisions; transactional item revisions invalidate related commits.
pub struct PublicReadCache {
    lanes: [PublicLane; 3],
    rebuilds: [Semaphore; 3],
    counters: [Counters; 3],
}

impl Default for PublicReadCache {
    fn default() -> Self {
        Self {
            lanes: std::array::from_fn(|_| PublicLane::default()),
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
        let requested = Instant::now();
        // Slow full histories cannot occupy crafting/watch rebuild permits or
        // displace their cache entries. Each class remains independently bounded.
        let lane = if key == "crafting" { 1 } else if key.starts_with("watch:") { 2 } else { 0 };
        let counters = &self.counters[lane];
        counters.requests.fetch_add(1, Ordering::Relaxed);
        let requested_revision = revision(db, items).await?;
        counters.lookup_us.fetch_add(requested.elapsed().as_micros() as u64, Ordering::Relaxed);
        let waiting = Instant::now();
        let slot = self.lanes[lane].slot(key, counters);
        let mut entry = match slot.as_ref() {
            Some(slot) => Some(slot.lock().await),
            None => None,
        };
        counters.key_wait_us.fetch_add(waiting.elapsed().as_micros() as u64, Ordering::Relaxed);
        let mut cause = &counters.cold;
        if let Some(hit) = entry.as_deref().and_then(Option::as_ref) {
            // Every watched item's revision must be at least the one this
            // request observed. Compare membership too: deletion must never
            // hit a larger stale revision; recreated rows have new revisions.
            let current = hit.revision.covers(&requested_revision);
            if current && hit.built.elapsed().as_secs_f64() < 2.0 {
                counters.hits.fetch_add(1, Ordering::Relaxed);
                return Ok(hit.value.clone());
            }
            cause = if current { &counters.expired } else { &counters.invalidated };
        }
        let waiting = Instant::now();
        let _permit = self.rebuilds[lane].acquire().await.expect("public cache gate open");
        counters.permit_wait_us.fetch_add(waiting.elapsed().as_micros() as u64, Ordering::Relaxed);
        // Capture current revisions after waiting, without holding a database
        // connection in the queue. No listener or invalidation message can be lost.
        let started = Instant::now();
        let revision = revision(db, items).await?;
        counters.rebuilds.fetch_add(1, Ordering::Relaxed);
        cause.fetch_add(1, Ordering::Relaxed);
        let result = build.await;
        counters.build_us.fetch_add(started.elapsed().as_micros() as u64, Ordering::Relaxed);
        let value = result?;
        if let Some(entry) = entry.as_deref_mut() {
            *entry = Some(PublicEntry { revision, built: Instant::now(), value: value.clone() });
        }
        Ok(value)
    }

    /// Aggregate operational metrics only: no keys, item IDs or user identities.
    pub fn take_metrics(&self) -> [(&'static str, CacheMetrics); 3] {
        std::array::from_fn(|lane| {
            let c = &self.counters[lane];
            let take = |v: &AtomicU64| v.swap(0, Ordering::Relaxed);
            let key_wait_ms = take(&c.key_wait_us) as f64 / 1000.;
            let permit_wait_ms = take(&c.permit_wait_us) as f64 / 1000.;
            (["item", "crafting", "watch"][lane], CacheMetrics {
                requests: take(&c.requests), hits: take(&c.hits), rebuilds: take(&c.rebuilds),
                evictions: take(&c.evictions), bypasses: take(&c.bypasses), cold: take(&c.cold),
                expired: take(&c.expired), invalidated: take(&c.invalidated),
                entries: self.lanes[lane].entries.lock().expect("public cache registry").len(),
                lookup_ms: take(&c.lookup_us) as f64 / 1000., key_wait_ms, permit_wait_ms,
                wait_ms: key_wait_ms + permit_wait_ms, build_ms: take(&c.build_us) as f64 / 1000.,
            })
        })
    }
}

/// One committed version of `?view=list`. Its br and gzip forms are made
/// once, on the first request that accepts them, not per response.
pub struct MarketList {
    pub version: i64,
    as_of: Option<f64>,
    body: Bytes,
    rows: Vec<(i32, std::ops::Range<usize>)>,
    br: OnceCell<Bytes>,
    gzip: OnceCell<Bytes>,
}

impl MarketList {
    fn new(list: views::ListBody) -> Self {
        Self {
            version: list.version,
            as_of: list.as_of,
            body: list.body.into(),
            rows: list.rows,
            br: OnceCell::new(),
            gzip: OnceCell::new(),
        }
    }

    pub fn body(&self) -> Bytes {
        self.body.clone()
    }

    /// br 6 / gzip 6: about 65 / 77 KB for the 750 KB list in ~15 ms each.
    pub(crate) async fn encoded(&self, coding: Coding) -> Bytes {
        let cell = match coding {
            Coding::Br => &self.br,
            Coding::Gzip => &self.gzip,
        };
        cell.get_or_init(|| {
            let body = self.body.clone();
            async move {
                tokio::task::spawn_blocking(move || {
                    Bytes::from(match coding {
                        Coding::Br => encoding::brotli(&body, 6),
                        Coding::Gzip => encoding::gzip(&body, 6),
                    })
                })
                .await
                .expect("compression task")
            }
        })
        .await
        .clone()
    }

    /// `view=list&ids=`: the rows of `ids` exactly as in the full list, and
    /// the requested ids the list does not have.
    pub fn select(&self, ids: &[i32]) -> Vec<u8> {
        let mut out = b"{\"as_of\":".to_vec();
        serde_json::to_writer(&mut out, &self.as_of).expect("serialisable");
        out.extend_from_slice(b",\"products\":[");
        let mut removed = Vec::new();
        let mut first = true;
        for id in ids {
            match self.rows.binary_search_by_key(id, |(item, _)| *item) {
                Ok(index) => {
                    if !first {
                        out.push(b',');
                    }
                    first = false;
                    out.extend_from_slice(&self.body[self.rows[index].1.clone()]);
                }
                Err(_) => removed.push(*id),
            }
        }
        out.extend_from_slice(b"],\"removed\":");
        serde_json::to_writer(&mut out, &removed).expect("serialisable");
        out.push(b'}');
        out
    }
}

type Entry = Option<Arc<MarketList>>;

#[cfg(test)]
mod hint_tests {
    use super::*;
    #[tokio::test]
    async fn period_hint_coalesces_and_expires_without_market_invalidation() {
        let cache=MarketListCache::default();
        let calls=AtomicU64::new(0);
        let build=|| async { calls.fetch_add(1,Ordering::Relaxed); tokio::task::yield_now().await; Ok(b"hint".to_vec()) };
        let (a,b)=tokio::join!(cache.period_hint(build()),cache.period_hint(build()));
        assert_eq!(a.unwrap(),b.unwrap());assert_eq!(calls.load(Ordering::Relaxed),1);
        cache.period_hint(build()).await.unwrap();assert_eq!(calls.load(Ordering::Relaxed),1);
        cache.period_hint.lock().await.as_mut().unwrap().0=Instant::now()-std::time::Duration::from_secs(301);
        cache.period_hint(build()).await.unwrap();assert_eq!(calls.load(Ordering::Relaxed),2);
    }
}

type ReportEntry = Option<(i64, String, Vec<u8>)>;

#[derive(Clone, Copy)]
pub enum Report {
    Records(Hours, bool),
    Quotes(Hours, i64),
    Leaderboard(i32),
}

pub struct MarketListCache {
    period_hint: Mutex<Option<(Instant, Vec<u8>)>>,
    projections: [Mutex<Option<(i64, serde_json::Value, serde_json::Value)>>; 2],
    recent: Mutex<Entry>,
    all: Mutex<Entry>,
    reports: [Mutex<ReportEntry>; 9],
    personal: [Mutex<ReportEntry>; 16],
    rebuilds: Semaphore,
}

impl Default for MarketListCache {
    fn default() -> Self {
        Self {
            period_hint: Mutex::new(None),
            projections: std::array::from_fn(|_| Mutex::new(None)),
            recent: Mutex::new(None),
            all: Mutex::new(None),
            reports: std::array::from_fn(|_| Mutex::new(None)),
            personal: std::array::from_fn(|_| Mutex::new(None)),
            rebuilds: Semaphore::new(2),
        }
    }
}

impl MarketListCache {
    pub async fn projection(&self, db: &PgPool, hours: Hours, public: bool, ids: Option<&[i32]>)
        -> sqlx::Result<serde_json::Value> {
        let slot=usize::from(matches!(hours, Hours::All));
        let mut entry=self.projections[slot].lock().await;
        let revision=views::version(db).await?;
        if entry.as_ref().is_none_or(|(version,_,_)| *version!=revision) {
            // Decode the full table once per committed version, never once per
            // visitor or watch combination. Only two bounded snapshots remain.
            let list=self.get(db,hours,public).await?;
            let market=serde_json::from_slice(&list.body).expect("cached market JSON");
            let overview=crate::delivery::overview(&market);
            *entry=Some((list.version,market,overview));
        }
        let (_,market,overview)=entry.as_ref().unwrap();
        Ok(match ids { Some(ids)=>crate::delivery::selected(market,ids), None=>overview.clone() })
    }

    pub async fn period_hint<F>(&self, build: F) -> sqlx::Result<Vec<u8>>
    where F: std::future::Future<Output = sqlx::Result<Vec<u8>>> {
        let mut entry = self.period_hint.lock().await;
        if let Some((at, body)) = entry.as_ref() {
            if at.elapsed().as_secs() < 300 { return Ok(body.clone()); }
        }
        let body = build.await?;
        *entry = Some((Instant::now(), body.clone()));
        Ok(body)
    }

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

    fn list_slot(&self, hours: Hours) -> &Mutex<Entry> {
        match hours {
            Hours::Recent => &self.recent,
            Hours::All => &self.all,
        }
    }

    /// The cached list when it is at least `version`, without waiting or
    /// touching the database; `None` while a rebuild holds the slot.
    pub fn peek(&self, hours: Hours, version: i64) -> Option<Arc<MarketList>> {
        let entry = self.list_slot(hours).try_lock().ok()?;
        entry
            .as_ref()
            .filter(|list| list.version >= version)
            .cloned()
    }

    /// Overview and selected rows can be answered from memory for `version`.
    pub fn projection_ready(&self, hours: Hours, version: i64) -> bool {
        let slot = usize::from(matches!(hours, Hours::All));
        self.projections[slot].try_lock().is_ok_and(|entry| {
            entry
                .as_ref()
                .is_some_and(|(cached, _, _)| *cached == version)
        })
    }

    pub async fn get(
        &self,
        db: &PgPool,
        hours: Hours,
        public: bool,
    ) -> sqlx::Result<Arc<MarketList>> {
        let mut entry = self.list_slot(hours).lock().await;
        // Read after acquiring the lock so a waiter cannot replace a newer
        // cached response with the version it saw before waiting.
        let version = views::version(db).await?;
        if let Some(list) = entry.as_ref() {
            if list.version == version {
                return Ok(list.clone());
            }
        }
        let fresh = Arc::new(MarketList::new(
            views::market_list_rows(db, hours, unix_now(), public).await?,
        ));
        *entry = Some(fresh.clone());
        Ok(fresh)
    }
}

#[cfg(test)]
mod list_tests {
    use super::*;

    fn list() -> MarketList {
        let rows = [
            (3, r#"{"item_id":3,"low":1}"#),
            (7, r#"{"item_id":7,"low":null}"#),
        ];
        let mut body = br#"{"as_of":12.5,"products":["#.to_vec();
        let mut positions = Vec::new();
        for (n, (id, row)) in rows.iter().enumerate() {
            if n > 0 {
                body.push(b',');
            }
            positions.push((*id, body.len()..body.len() + row.len()));
            body.extend_from_slice(row.as_bytes());
        }
        body.extend_from_slice(b"]}");
        MarketList::new(views::ListBody {
            version: 1,
            as_of: Some(12.5),
            body,
            rows: positions,
        })
    }

    #[test]
    fn selected_rows_are_copied_and_missing_ids_listed() {
        let value: serde_json::Value =
            serde_json::from_slice(&list().select(&[1, 3, 7, 9])).unwrap();
        assert_eq!(
            value,
            serde_json::json!({"as_of":12.5,
            "products":[{"item_id":3,"low":1},{"item_id":7,"low":null}],"removed":[1,9]})
        );
        let empty: serde_json::Value = serde_json::from_slice(&list().select(&[])).unwrap();
        assert_eq!(
            empty,
            serde_json::json!({"as_of":12.5,"products":[],"removed":[]})
        );
    }

    #[tokio::test]
    async fn encoded_forms_are_made_once() {
        use std::io::Read as _;
        let list = list();
        let br = list.encoded(Coding::Br).await;
        assert_eq!(br, list.encoded(Coding::Br).await);
        let mut out = Vec::new();
        brotli::Decompressor::new(&br[..], 4096)
            .read_to_end(&mut out)
            .unwrap();
        assert_eq!(out, list.body());
        out.clear();
        flate2::read::GzDecoder::new(&list.encoded(Coding::Gzip).await[..])
            .read_to_end(&mut out)
            .unwrap();
        assert_eq!(out, list.body());
    }
}

mod common;
use market_web::market_cache::PublicReadCache;
use serde_json::json;
use std::{hash::{Hash, Hasher}, sync::Arc, time::Duration};

fn colliding_keys() -> Vec<String> {
    // Reproduce the previous 32-slot hash collision with unrelated requests.
    (0..10000).map(|i| format!("item:collision:{i}")).filter(|key| {
        let mut hash = std::collections::hash_map::DefaultHasher::new();
        key.hash(&mut hash);
        hash.finish() % 32 == 0
    }).take(8).collect()
}

#[tokio::test]
async fn unrelated_keys_retain_snapshots_even_when_old_hash_slots_collide() {
    let Some(db) = common::TestDb::new().await else { return };
    let cache = PublicReadCache::default();
    let keys = colliding_keys();
    for key in &keys {
        cache.get(&db.pool, key, async { Ok(Some(json!(key))) }).await.unwrap();
    }
    for key in &keys {
        assert_eq!(cache.get(&db.pool, key, async { panic!("unrelated key displaced a fresh snapshot") })
            .await.unwrap(), Some(json!(key)));
    }
    let metrics = cache.take_metrics();
    let m = &metrics[0].1;
    assert_eq!((m.requests, m.hits, m.rebuilds, m.cold, m.entries, m.evictions), (16, 8, 8, 8, 8, 0));
    db.close().await;
}

#[tokio::test]
async fn unrelated_colliding_key_does_not_wait_for_a_blocked_rebuild() {
    let Some(db) = common::TestDb::new().await else { return };
    let cache = Arc::new(PublicReadCache::default());
    let started = Arc::new(tokio::sync::Notify::new());
    let keys = colliding_keys();
    let blocked = {
        let (cache, pool, started, key) = (cache.clone(), db.pool.clone(), started.clone(), keys[0].clone());
        tokio::spawn(async move { cache.get(&pool, &key, async {
            started.notify_one();
            std::future::pending::<sqlx::Result<Option<serde_json::Value>>>().await
        }).await })
    };
    tokio::time::timeout(Duration::from_secs(3), started.notified()).await.unwrap();
    let response = tokio::time::timeout(Duration::from_secs(1), cache.get(&db.pool, &keys[1], async {
        Ok(Some(json!("ready")))
    })).await;
    blocked.abort();
    let _ = blocked.await;
    assert_eq!(response.expect("unrelated key waited behind another key").unwrap(), Some(json!("ready")));
    // A cancelled builder releases its entry and permit; it can be rebuilt.
    assert_eq!(cache.get(&db.pool, &keys[0], async { Ok(Some(json!("recovered"))) })
        .await.unwrap(), Some(json!("recovered")));
    db.close().await;
}

#[tokio::test]
async fn capacity_evicts_the_oldest_idle_key_and_preserves_recent_hits() {
    let Some(db) = common::TestDb::new().await else { return };
    let cache = PublicReadCache::default();
    for i in 0..32 {
        cache.get(&db.pool, &format!("item:{i}"), async { Ok(Some(json!(i))) }).await.unwrap();
    }
    cache.get(&db.pool, "item:0", async { panic!("first key missing before capacity reached") }).await.unwrap();
    cache.get(&db.pool, "item:32", async { Ok(Some(json!(32))) }).await.unwrap();
    cache.get(&db.pool, "item:0", async { panic!("recently used key evicted") }).await.unwrap();
    assert_eq!(cache.get(&db.pool, "item:1", async { Ok(Some(json!("rebuilt"))) })
        .await.unwrap(), Some(json!("rebuilt")));
    let metrics = cache.take_metrics();
    let m = &metrics[0].1;
    assert_eq!((m.entries, m.evictions, m.bypasses, m.rebuilds, m.hits), (32, 2, 0, 34, 2));
    db.close().await;
}

#[tokio::test]
async fn full_cache_never_evicts_active_rebuilds_or_grows_for_overflow() {
    let Some(db) = common::TestDb::new().await else { return };
    let cache = Arc::new(PublicReadCache::default());
    let gate = Arc::new(tokio::sync::Semaphore::new(0));
    let mut tasks = Vec::new();
    for i in 0..32 {
        let (cache, pool, gate) = (cache.clone(), db.pool.clone(), gate.clone());
        tasks.push(tokio::spawn(async move {
            cache.get(&pool, &format!("item:{i}"), async {
                gate.acquire().await.unwrap().forget();
                Ok(Some(json!(i)))
            }).await.unwrap()
        }));
    }
    tokio::time::timeout(Duration::from_secs(3), async {
        while cache.take_metrics()[0].1.entries < 32 { tokio::task::yield_now().await; }
    }).await.unwrap();
    let overflow = {
        let (cache, pool) = (cache.clone(), db.pool.clone());
        tokio::spawn(async move {
            cache.get(&pool, "item:overflow", async { Ok(Some(json!("overflow"))) }).await.unwrap()
        })
    };
    tokio::time::timeout(Duration::from_secs(3), async {
        loop {
            let metrics = cache.take_metrics();
            assert_eq!(metrics[0].1.entries, 32);
            assert_eq!(metrics[0].1.evictions, 0);
            if metrics[0].1.bypasses == 1 { break; }
            tokio::task::yield_now().await;
        }
    }).await.unwrap();
    assert!(!overflow.is_finished(), "overflow bypassed the database concurrency limit");
    gate.add_permits(32);
    for (i, task) in tasks.into_iter().enumerate() { assert_eq!(task.await.unwrap(), Some(json!(i))); }
    assert_eq!(overflow.await.unwrap(), Some(json!("overflow")));
    for i in 0..32 {
        cache.get(&db.pool, &format!("item:{i}"), async { panic!("an active key was evicted") }).await.unwrap();
    }
    assert_eq!(cache.take_metrics()[0].1.entries, 32);
    db.close().await;
}

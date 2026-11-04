#[path = "common/mod.rs"]
mod common;
use axum::{
    body::Body,
    http::{Request, StatusCode},
};
use http_body_util::BodyExt;
use market_web::{app, market_cache::PublicReadCache, AppState, Settings};
use serde_json::json;
use std::sync::{
    atomic::{AtomicUsize, Ordering},
    Arc,
};
use std::time::Duration;
use tower::ServiceExt;

#[tokio::test]
async fn waiting_uploads_do_not_exhaust_public_read_connections() {
    let Some(db) = common::TestDb::new().await else {
        return;
    };
    let collector = db.collector("writer-queue").await;
    let state = AppState::new(db.pool.clone(), Settings::default());
    let application = app(state.clone());
    let mut blocker = db.pool.begin().await.unwrap();
    market_web::stats::lock_writes(&mut blocker).await.unwrap();
    let mut uploads = Vec::new();
    for i in 0..8 {
        let application = application.clone();
        let token = format!(
            "Bearer token-of-{}-padding-to-thirty-chars",
            collector.public_id
        );
        uploads.push(tokio::spawn(async move {
            let body = json!({"version":1,"world":"ClassicWorld","complete":true,"title":"Shop","shop_id":7,
                "location":{"channel":1,"room":1},"observation_id":format!("queue-{i}"),"observed_at":market_web::unix_now(),
                "items":[{"item_id":4010001,"category":4,"slot":1,"price":500,"bundle":1,"stock":1}]});
            application.oneshot(Request::post("/api/v1/observations").header("authorization",token)
                .header("content-type","application/json").body(Body::from(body.to_string())).unwrap()).await.unwrap().status()
        }));
    }
    tokio::time::timeout(Duration::from_secs(3), async {
        while state.write_db.size() == 0 || state.write_db.num_idle() > 0 {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap();
    // More uploads than the four read slots are now waiting for one writer.
    tokio::time::sleep(Duration::from_millis(100)).await;
    let response = tokio::time::timeout(
        Duration::from_secs(1),
        application.oneshot(Request::get("/readyz").body(Body::empty()).unwrap()),
    )
    .await
    .expect("read blocked behind writer queue")
    .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    assert!(uploads.iter().all(|task| !task.is_finished()));
    blocker.rollback().await.unwrap();
    for upload in uploads {
        assert_eq!(upload.await.unwrap(), StatusCode::CREATED);
    }
    db.close().await;
}

#[tokio::test]
async fn public_snapshots_coalesce_and_commits_invalidate_without_losing_filters() {
    let Some(db) = common::TestDb::new().await else {
        return;
    };
    let cache = Arc::new(PublicReadCache::default());
    let builds = Arc::new(AtomicUsize::new(0));
    let mut requests = Vec::new();
    for _ in 0..16 {
        let (cache, builds, pool) = (cache.clone(), builds.clone(), db.pool.clone());
        requests.push(tokio::spawn(async move {
            cache
                .get(&pool, "item:1:variant:2", async {
                    builds.fetch_add(1, Ordering::SeqCst);
                    tokio::time::sleep(Duration::from_millis(300)).await;
                    // Uploads can commit while this shared history read runs. The
                    // waiting requests must still share it, rather than rebuilding
                    // once per waiter as the global version keeps advancing.
                    sqlx::query("UPDATE market_state SET version=version+1")
                        .execute(&pool)
                        .await?;
                    Ok(Some(json!({"variant":2})))
                })
                .await
                .unwrap()
        }));
    }
    for request in requests {
        assert_eq!(request.await.unwrap(), Some(json!({"variant":2})));
    }
    assert_eq!(builds.load(Ordering::SeqCst), 1);
    assert_eq!(
        cache
            .get(&db.pool, "item:1:variant:3", async {
                Ok(Some(json!({"variant":3})))
            })
            .await
            .unwrap(),
        Some(json!({"variant":3}))
    );
    sqlx::query("UPDATE market_state SET version=version+1")
        .execute(&db.pool)
        .await
        .unwrap();
    assert_eq!(
        cache
            .get(&db.pool, "item:1:variant:2", async {
                Ok(Some(json!({"changed":true})))
            })
            .await
            .unwrap(),
        Some(json!({"changed":true}))
    );
    db.close().await;
}

#[tokio::test]
async fn blocked_detail_rebuilds_do_not_block_crafting_or_watch_snapshots() {
    let Some(db) = common::TestDb::new().await else {
        return;
    };
    let cache = Arc::new(PublicReadCache::default());
    let started = Arc::new(tokio::sync::Barrier::new(3));
    let mut pending = Vec::new();
    // Select distinct item shards so both detail rebuild permits are occupied.
    use std::hash::{Hash, Hasher};
    let mut shards = std::collections::HashSet::new();
    for index in 0..100 {
        let key = format!("item:blocked:{index}");
        let mut hash = std::collections::hash_map::DefaultHasher::new();
        key.hash(&mut hash);
        if !shards.insert(hash.finish() % 32) {
            continue;
        }
        let (cache, pool, started) = (cache.clone(), db.pool.clone(), started.clone());
        pending.push(tokio::spawn(async move {
            cache
                .get(&pool, &key, async {
                    started.wait().await;
                    std::future::pending::<sqlx::Result<Option<serde_json::Value>>>().await
                })
                .await
        }));
        if pending.len() == 2 {
            break;
        }
    }
    tokio::time::timeout(Duration::from_secs(3), started.wait())
        .await
        .unwrap();
    for key in ["crafting", "watch:[4010001]"] {
        assert_eq!(
            tokio::time::timeout(
                Duration::from_secs(1),
                cache.get(&db.pool, key, async { Ok(Some(json!({"ready":true}))) })
            )
            .await
            .expect("unrelated public snapshot blocked by full details")
            .unwrap(),
            Some(json!({"ready":true}))
        );
    }
    for task in pending {
        task.abort();
        let _ = task.await;
    }
    db.close().await;
}

#[tokio::test]
async fn event_bursts_keep_initial_snapshot_and_one_trailing_invalidation() {
    let Some(db) = common::TestDb::new().await else {
        return;
    };
    let state = AppState::new(db.pool.clone(), Settings::default());
    let response = app(state.clone())
        .oneshot(Request::get("/api/v1/events").body(Body::empty()).unwrap())
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let mut body = response.into_body();
    assert!(
        std::str::from_utf8(body.frame().await.unwrap().unwrap().data_ref().unwrap())
            .unwrap()
            .contains("event: market")
    );
    for _ in 0..20 {
        state.events.send(None).unwrap();
    }
    assert!(
        tokio::time::timeout(Duration::from_millis(100), body.frame())
            .await
            .is_err()
    );
    let frame = tokio::time::timeout(Duration::from_secs(2), body.frame())
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    assert!(std::str::from_utf8(frame.data_ref().unwrap())
        .unwrap()
        .contains("event: market"));
    assert!(
        tokio::time::timeout(Duration::from_millis(100), body.frame())
            .await
            .is_err(),
        "burst was replayed per upload"
    );
    state.events.send(None).unwrap();
    assert!(tokio::time::timeout(Duration::from_secs(2), body.frame())
        .await
        .unwrap()
        .is_some());
    drop(body);
    db.close().await;
}

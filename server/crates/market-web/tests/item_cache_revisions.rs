mod common;
use axum::{
    body::Body,
    http::{Request, StatusCode},
};
use http_body_util::BodyExt;
use market_web::{app, market_cache::PublicReadCache, AppState, Settings};
use serde_json::{json, Value};
use std::sync::{
    atomic::{AtomicUsize, Ordering},
    Arc,
};
use tower::ServiceExt;

#[tokio::test]
async fn item_revisions_are_transactional_cover_membership_and_keep_time_expiry() {
    let Some(db) = common::TestDb::new().await else {
        return;
    };
    sqlx::query("INSERT INTO items(id,name_en,category) VALUES(1,'One','etc'),(2,'Two','etc'),(3,'Three','etc')")
        .execute(&db.pool).await.unwrap();
    sqlx::query("INSERT INTO item_stats(item_id,as_of) SELECT id,now() FROM items")
        .execute(&db.pool)
        .await
        .unwrap();
    let cache = PublicReadCache::default();
    let key = "watch:[1,2]";
    let read = || {
        cache.get_items(&db.pool, key, &[1, 2], async {
            panic!("unrelated or uncommitted write evicted the snapshot")
        })
    };
    cache
        .get_items(&db.pool, key, &[1, 2], async { Ok(Some(json!("initial"))) })
        .await
        .unwrap();
    // Even a newer revision on another item and a global market invalidation
    // leave this watch intact. Include both items rather than max(revision).
    sqlx::query("UPDATE item_stats SET lowest_ask=30 WHERE item_id=3")
        .execute(&db.pool)
        .await
        .unwrap();
    sqlx::query("UPDATE market_state SET version=version+1")
        .execute(&db.pool)
        .await
        .unwrap();
    assert_eq!(read().await.unwrap(), Some(json!("initial")));
    let mut tx = db.pool.begin().await.unwrap();
    sqlx::query("UPDATE item_stats SET lowest_ask=10 WHERE item_id=1")
        .execute(&mut *tx)
        .await
        .unwrap();
    assert_eq!(read().await.unwrap(), Some(json!("initial")));
    tx.rollback().await.unwrap();
    assert_eq!(read().await.unwrap(), Some(json!("initial")));
    // The same cache works across pool connections and needs no in-process
    // notification. A committed related write invalidates on the next request.
    sqlx::query("UPDATE item_stats SET lowest_ask=20 WHERE item_id=1")
        .execute(&db.pool)
        .await
        .unwrap();
    assert_eq!(
        cache
            .get_items(&db.pool, key, &[1, 2], async {
                Ok(Some(json!("committed")))
            })
            .await
            .unwrap(),
        Some(json!("committed"))
    );
    sqlx::query("DELETE FROM item_stats WHERE item_id=2")
        .execute(&db.pool)
        .await
        .unwrap();
    assert_eq!(
        cache
            .get_items(&db.pool, key, &[1, 2], async { Ok(Some(json!("deleted"))) })
            .await
            .unwrap(),
        Some(json!("deleted"))
    );
    sqlx::query("INSERT INTO item_stats(item_id,as_of) VALUES(2,now())")
        .execute(&db.pool)
        .await
        .unwrap();
    assert_eq!(
        cache
            .get_items(&db.pool, key, &[1, 2], async {
                Ok(Some(json!("restored")))
            })
            .await
            .unwrap(),
        Some(json!("restored"))
    );
    // Missing records are not negatively cached after their first upload.
    cache
        .get_items(&db.pool, "item:4", &[4], async { Ok(None) })
        .await
        .unwrap();
    sqlx::query("INSERT INTO items(id,name_en,category) VALUES(4,'Four','etc')")
        .execute(&db.pool)
        .await
        .unwrap();
    sqlx::query("INSERT INTO item_stats(item_id,as_of) VALUES(4,now())")
        .execute(&db.pool)
        .await
        .unwrap();
    assert_eq!(
        cache
            .get_items(&db.pool, "item:4", &[4], async {
                Ok(Some(json!("created")))
            })
            .await
            .unwrap(),
        Some(json!("created"))
    );
    tokio::time::sleep(std::time::Duration::from_millis(2100)).await;
    assert_eq!(
        cache
            .get_items(&db.pool, key, &[1, 2], async {
                Ok(Some(json!("clock advanced")))
            })
            .await
            .unwrap(),
        Some(json!("clock advanced"))
    );
    db.close().await;
}

#[tokio::test]
async fn scoped_rebuild_waiters_coalesce_while_a_related_commit_arrives() {
    let Some(db) = common::TestDb::new().await else {
        return;
    };
    sqlx::query("INSERT INTO items(id,name_en,category) VALUES(1,'One','etc')")
        .execute(&db.pool)
        .await
        .unwrap();
    sqlx::query("INSERT INTO item_stats(item_id,as_of) VALUES(1,now())")
        .execute(&db.pool)
        .await
        .unwrap();
    let cache = Arc::new(PublicReadCache::default());
    let builds = Arc::new(AtomicUsize::new(0));
    let mut pending = Vec::new();
    for _ in 0..16 {
        let (cache, builds, pool) = (cache.clone(), builds.clone(), db.pool.clone());
        pending.push(tokio::spawn(async move {
            cache
                .get_items(&pool, "item:1", &[1], async {
                    builds.fetch_add(1, Ordering::SeqCst);
                    tokio::time::sleep(std::time::Duration::from_millis(300)).await;
                    sqlx::query("UPDATE item_stats SET lowest_ask=50 WHERE item_id=1")
                        .execute(&pool)
                        .await?;
                    Ok(Some(json!("shared")))
                })
                .await
                .unwrap()
        }));
    }
    for task in pending {
        assert_eq!(task.await.unwrap(), Some(json!("shared")));
    }
    assert_eq!(builds.load(Ordering::SeqCst), 1);
    let metrics = cache.take_metrics();
    assert_eq!(
        (
            metrics[0].1.requests,
            metrics[0].1.hits,
            metrics[0].1.rebuilds
        ),
        (16, 15, 1)
    );
    assert_eq!(
        cache
            .get_items(&db.pool, "item:1", &[1], async { Ok(Some(json!("fresh"))) })
            .await
            .unwrap(),
        Some(json!("fresh"))
    );
    db.close().await;
}

#[tokio::test]
async fn actual_uploads_only_invalidate_related_catalogue_and_watch_snapshots() {
    let Some(db) = common::TestDb::new().await else {
        return;
    };
    let collector = db.collector("cache-upload").await;
    let state = AppState::new(db.pool.clone(), Settings::default());
    let router = app(state.clone());
    let now = market_web::unix_now();
    let upload = |id: &str, item: i32, shop: i32, stock: i32, age: f64| {
        let body = json!({"version":1,"world":"ClassicWorld","complete":true,"title":"Shop","shop_id":shop,
            "location":{"channel":1,"room":1},"observation_id":id,"observed_at":now-age,
            "items":[{"item_id":item,"slot":1,"price":500,"bundle":1,"stock":stock}]});
        Request::post("/api/v1/observations")
            .header(
                "authorization",
                format!(
                    "Bearer token-of-{}-padding-to-thirty-chars",
                    collector.public_id
                ),
            )
            .header("content-type", "application/json")
            .body(Body::from(body.to_string()))
            .unwrap()
    };
    assert_eq!(
        router
            .clone()
            .oneshot(upload("a", 4010001, 1, 5, 60.))
            .await
            .unwrap()
            .status(),
        StatusCode::CREATED
    );
    let paths = [
        "/api/v1/catalog/page?url=%2Fitem%2F4010001",
        "/api/v1/watchlist/listings?ids=4010001",
    ];
    async fn get(router: axum::Router, path: &str) -> Value {
        let r = router
            .oneshot(Request::get(path).body(Body::empty()).unwrap())
            .await
            .unwrap();
        assert_eq!(r.status(), StatusCode::OK);
        serde_json::from_slice(&r.into_body().collect().await.unwrap().to_bytes()).unwrap()
    }
    let first_item = get(router.clone(), paths[0]).await;
    let first_watch = get(router.clone(), paths[1]).await;
    assert_eq!(first_watch["listings"][0]["stock"], 5);
    state.public_reads.take_metrics();
    assert_eq!(
        router
            .clone()
            .oneshot(upload("b", 4010002, 2, 7, 40.))
            .await
            .unwrap()
            .status(),
        StatusCode::CREATED
    );
    assert_eq!(get(router.clone(), paths[0]).await, first_item);
    assert_eq!(get(router.clone(), paths[1]).await, first_watch);
    let metrics = state.public_reads.take_metrics();
    for lane in [0, 2] {
        assert_eq!((metrics[lane].1.hits, metrics[lane].1.rebuilds), (1, 0));
    }
    assert_eq!(
        router
            .clone()
            .oneshot(upload("c", 4010001, 1, 3, 20.))
            .await
            .unwrap()
            .status(),
        StatusCode::CREATED
    );
    assert_eq!(
        get(router.clone(), paths[0]).await["page"]["market"]["listings"][0]["stock"],
        3
    );
    assert_eq!(
        get(router.clone(), paths[1]).await["listings"][0]["stock"],
        3
    );
    let metrics = state.public_reads.take_metrics();
    for lane in [0, 2] {
        assert_eq!(metrics[lane].1.rebuilds, 1);
    }
    db.close().await;
}

mod common;
use common::TestDb;
use market_core::protocol::validate;
use market_web::{
    ingest::{ingest, Received},
    stats, unix_now,
};
use serde_json::json;

// Its own test binary: the deferred switch is process-wide.
#[tokio::test]
async fn deferred_writes_only_mark_items_and_the_background_pass_writes_their_figures() {
    let Some(db) = TestDb::new().await else {
        return;
    };
    stats::defer_recompute(true);
    let who = db.collector("deferred").await;
    let now = unix_now();
    let v = json!({"version":1,"world":"ClassicWorld","complete":true,"observation_id":"deferred-1",
        "observed_at":now - 5.,"shop_id":301,"title":"Shop",
        "location":{"channel":3,"room":1},"items":[{"item_id":4010001,"slot":1,"price":500,"bundle":1,"stock":8}]});
    let upload = validate(&v, now).unwrap();
    let raw = serde_json::to_vec(&v).unwrap();
    ingest(&db.pool, Received { collector: &who, upload: &upload, raw: &raw, received_at: now, now })
        .await
        .unwrap();
    let marked: Vec<i32> = sqlx::query_scalar("SELECT item_id FROM stats_dirty").fetch_all(&db.pool).await.unwrap();
    assert_eq!(marked, vec![4010001]);
    let before: i64 = sqlx::query_scalar("SELECT count(*) FROM item_stats WHERE item_id=4010001")
        .fetch_one(&db.pool)
        .await
        .unwrap();
    assert_eq!(before, 0, "the write itself no longer recomputes");

    assert_eq!(stats::recompute_dirty(&db.pool, now).await.unwrap(), 1);
    let ask: Option<f64> = sqlx::query_scalar("SELECT lowest_ask FROM item_stats WHERE item_id=4010001")
        .fetch_one(&db.pool)
        .await
        .unwrap();
    assert_eq!(ask, Some(500.0));
    let left: i64 = sqlx::query_scalar("SELECT count(*) FROM stats_dirty").fetch_one(&db.pool).await.unwrap();
    assert_eq!(left, 0);
    assert_eq!(stats::recompute_dirty(&db.pool, now).await.unwrap(), 0);
}

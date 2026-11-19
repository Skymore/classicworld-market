//! The periodic refresh recomputes only items whose evidence crossed a
//! clock line since the last pass, plus an hourly full pass. Its own test
//! binary: the full-pass clock is process-wide.

mod common;

use common::TestDb;
use market_core::protocol::validate;
use market_web::ingest::{ingest, Received};
use market_web::stats::refresh_if_due;
use market_web::unix_now;
use serde_json::json;

const DAY: f64 = 86400.0;

#[tokio::test]
async fn periodic_refresh_recomputes_only_items_that_crossed_a_clock_line() {
    let Some(db) = TestDb::new().await else {
        return;
    };
    let (collector, now) = (db.collector("incremental").await, unix_now());
    // Item 4000008 sold just inside the last 24 h; 4000009 three hours ago.
    for (n, shop, item, ago, stock) in [
        (1, 1, 4000008, DAY + 300.0, 3),
        (2, 1, 4000008, DAY - 60.0, 0),
        (3, 2, 4000009, 3.0 * 3600.0 + 300.0, 3),
        (4, 2, 4000009, 3.0 * 3600.0, 0),
    ] {
        let data = json!({
            "version": 1, "world": "ClassicWorld", "observation_id": format!("v{n}"), "complete": true,
            "observed_at": now - ago, "title": "shop", "shop_id": shop, "location": {"channel": 1, "room": shop},
            "items": [{"item_id": item, "slot": 1, "price": 200, "bundle": 1, "stock": stock}]
        });
        let upload = validate(&data, now).unwrap();
        let raw = serde_json::to_vec(&data).unwrap();
        ingest(
            &db.pool,
            Received {
                collector: &collector,
                upload: &upload,
                raw: &raw,
                received_at: now,
                now,
            },
        )
        .await
        .unwrap();
    }
    let sales_24h = |item: i32| {
        let pool = db.pool.clone();
        async move {
            sqlx::query_scalar::<_, i32>("SELECT sales_24h FROM item_stats WHERE item_id=$1")
                .bind(item)
                .fetch_one(&pool)
                .await
                .unwrap()
        }
    };
    assert!(refresh_if_due(&db.pool, now).await.unwrap());
    assert_eq!((sales_24h(4000008).await, sales_24h(4000009).await), (1, 1));
    // A marker the refresh only overwrites when it recomputes the item.
    sqlx::query("UPDATE item_stats SET sales_24h=99 WHERE item_id=4000009")
        .execute(&db.pool)
        .await
        .unwrap();
    assert!(refresh_if_due(&db.pool, now + 660.0).await.unwrap());
    assert_eq!(sales_24h(4000008).await, 0, "the sale left the 24 h window");
    assert_eq!(sales_24h(4000009).await, 99, "nothing crossed a line");
    // The six-hourly full pass still recomputes everything.
    assert!(refresh_if_due(&db.pool, now + 6.0 * 3600.0 + 100.0)
        .await
        .unwrap());
    assert_eq!((sales_24h(4000008).await, sales_24h(4000009).await), (0, 1));
    db.close().await;
}

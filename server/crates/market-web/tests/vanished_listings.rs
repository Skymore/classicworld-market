mod common;
use common::TestDb;
use market_core::protocol::validate;
use market_web::{
    ingest::{ingest, Received},
    unix_now,
};
use serde_json::{json, Value};

async fn upload(db: &TestDb, who: &market_web::auth::Collector, now: f64, v: Value) {
    let upload = validate(&v, now + 1.).unwrap();
    let raw = serde_json::to_vec(&v).unwrap();
    ingest(
        &db.pool,
        Received {
            collector: who,
            upload: &upload,
            raw: &raw,
            received_at: now,
            now,
        },
    )
    .await
    .unwrap();
}

fn snapshot(id: &str, time: f64, shop: u32, title: &str, items: Value) -> Value {
    json!({"version":1,"world":"ClassicWorld","complete":true,
      "observation_id":id,"observed_at":time,"shop_id":shop,"title":title,
      "location":{"channel":1,"room":2},
      "owner":{"character_id":414290,"name":"ExampleHost","parser":"cw_shop_owner_v1"},
      "items":items})
}

async fn expired(db: &TestDb) -> Vec<(i32, i64, f64)> {
    sqlx::query_as(
        "SELECT item_id,price,extract(epoch FROM invalidated_at)::float8 FROM expired_listings
         ORDER BY item_id,price",
    )
    .fetch_all(&db.pool)
    .await
    .unwrap()
}

#[tokio::test]
async fn withdrawn_and_repriced_quotes_expire_in_the_same_or_a_reopened_shop() {
    let Some(db) = TestDb::new().await else {
        return;
    };
    let who = db.collector("vanish").await;
    let now = unix_now().floor();
    let first = json!([
        {"item_id":4010001,"slot":1,"price":500,"bundle":1,"stock":1},
        {"item_id":4010002,"slot":2,"price":600,"bundle":1,"stock":1},
        {"item_id":4010003,"slot":3,"price":700,"bundle":1,"stock":1},
        {"item_id":4010004,"slot":4,"price":800,"bundle":1,"stock":1}
    ]);
    upload(
        &db,
        &who,
        now,
        snapshot("a", now - 300., 5145, "@o@", first),
    )
    .await;
    // Same shop: 4010002 withdrawn, 4010003 repriced, 4010004 sold out.
    let second = json!([
        {"item_id":4010001,"slot":1,"price":500,"bundle":1,"stock":1},
        {"item_id":4010003,"slot":3,"price":650,"bundle":1,"stock":1},
        {"item_id":4010004,"slot":4,"price":800,"bundle":1,"stock":0}
    ]);
    upload(
        &db,
        &who,
        now,
        snapshot("b", now - 200., 5145, "@o@", second.clone()),
    )
    .await;
    assert_eq!(
        expired(&db).await,
        vec![(4010002, 600, now - 200.), (4010003, 700, now - 200.)]
    );
    // A late duplicate of the older visit changes nothing.
    upload(
        &db,
        &who,
        now,
        snapshot("a2", now - 250., 5145, "@o@", second),
    )
    .await;
    assert_eq!(expired(&db).await.len(), 2);

    // Reopened under a new shop id and title: carried-over quotes stay live.
    let third = json!([
        {"item_id":4010003,"slot":9,"price":650,"bundle":1,"stock":1},
        {"item_id":4010005,"slot":5,"price":900,"bundle":1,"stock":1}
    ]);
    upload(
        &db,
        &who,
        now,
        snapshot("c", now - 100., 6075, "The Rising+4", third),
    )
    .await;
    assert_eq!(
        expired(&db).await,
        vec![
            (4010001, 500, now - 100.),
            (4010002, 600, now - 200.),
            (4010003, 700, now - 200.)
        ]
    );
    let live: Vec<(i32, i64)> =
        sqlx::query_as("SELECT item_id,price FROM listings ORDER BY item_id")
            .fetch_all(&db.pool)
            .await
            .unwrap();
    assert_eq!(live, vec![(4010003, 650), (4010005, 900)]);
    let sales: Vec<String> = sqlx::query_scalar("SELECT kind FROM sales")
        .fetch_all(&db.pool)
        .await
        .unwrap();
    assert_eq!(
        sales,
        vec!["sold_out".to_string()],
        "withdrawals are not sales"
    );
    let page = market_web::bestiary::queries::item_page(&db.pool, 4010001, now + 2.)
        .await
        .unwrap()
        .unwrap();
    assert!(page.market.listings.is_empty());
    assert_eq!(page.market.expired_listings.len(), 1);
    db.close().await;
}

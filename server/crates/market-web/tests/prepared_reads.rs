mod common;

use market_web::{
    bestiary::queries::{item_page_selected, ItemSelection},
    views,
};
use serde_json::Value;
use sqlx::postgres::PgPoolOptions;

// A warmed SQLx connection can switch to generic plans after repeated calls.
// Tiny happy-path fixtures and one-shot literal EXPLAINs miss the resulting
// whole-market hash joins. Verify actual row visits, not machine-specific time.
fn assert_point_lookup(plan: &Value, table: &str, maximum: u64) -> u64 {
    let mut visits = 0;
    if plan["Relation Name"] == table {
        let rows = plan["Actual Rows"].as_u64().unwrap();
        let loops = plan["Actual Loops"].as_u64().unwrap();
        assert!(rows <= 1, "unbounded {table} read: {plan}");
        assert!(
            rows * loops <= maximum,
            "read unrelated {table} rows: {plan}"
        );
        visits += loops;
    }
    if let Some(children) = plan["Plans"].as_array() {
        visits += children
            .iter()
            .map(|p| assert_point_lookup(p, table, maximum))
            .sum::<u64>();
    }
    visits
}

#[tokio::test]
async fn warmed_detail_and_watch_plans_only_read_selected_observations_and_shops() {
    let Some(db) = common::TestDb::new().await else {
        return;
    };
    for statement in [
        "INSERT INTO items(id,name_en,category) VALUES(1002000,'Target','equipment'),(4000000,'Unrelated','etc')",
        "INSERT INTO collectors(id,public_id,token_hash,source) VALUES(1,'fixture','\\x01','packet')",
        "INSERT INTO equipment_variants(id,item_id,stats_hash,stats) VALUES
          (1,1002000,'\\x01','{\"stats\":[{\"key\":\"dex\",\"label\":\"DEX\",\"value\":1}],\"unknown_fields\":[]}'),
          (2,1002000,'\\x02','{\"stats\":[{\"key\":\"dex\",\"label\":\"DEX\",\"value\":2}],\"unknown_fields\":[]}')",
        "INSERT INTO shops(id,shop_key,world,shop_id,title,first_seen_at,last_seen_at,public_key)
          SELECT i,i::text,'w',i,'Shop','2026-10-25Z','2026-10-25 04:00Z',i::text FROM generate_series(1,5000) i",
        "INSERT INTO observations(id,observation_id,collector_id,shop_id,source,observed_at,fingerprint,visit_key)
          SELECT i,i::text,1,i,'packet','2026-10-25 00:00Z',i::text,i::text FROM generate_series(1,5000) i",
        // Latest positive quote per day/shop/slot, filtering variants first.
        // Equal-time observations use visit_key; insertion order is irrelevant.
        "INSERT INTO observations(id,observation_id,collector_id,shop_id,source,observed_at,fingerprint,visit_key) VALUES
          (5001,'a',1,1,'packet','2026-10-25 01:00Z','a','a'),
          (5002,'c',1,1,'packet','2026-10-25 02:00Z','c','c'),
          (5003,'b',1,1,'packet','2026-10-25 02:00Z','b','b'),
          (5004,'d',1,1,'packet','2026-10-25 03:00Z','d','d'),
          (5005,'future',1,1,'packet','2026-10-25 06:00Z','f','f'),
          (5006,'before',1,1,'packet','2026-10-18 23:59:59Z','g','g'),
          (5007,'boundary',1,1,'packet','2026-10-19 00:00Z','h','h')",
        "INSERT INTO observation_rows(observation_id,slot,item_id,variant_id,price,bundle,stock,position) VALUES
          (5001,1,1002000,1,100,1,5,0),(5002,1,1002000,2,600,2,5,0),
          (5003,1,1002000,1,400,2,5,0),(5004,1,1002000,2,600,2,0,0),
          (5005,1,1002000,2,900,1,5,0),(5006,1,1002000,1,1,1,5,0),
          (5007,1,1002000,1,50,1,5,0), (2,1,1002000,NULL,500,1,5,0)",
        "INSERT INTO listings(shop_id,observation_id,slot,item_id,variant_id,price,bundle,stock,first_seen_at,last_seen_at)
          SELECT i,i,1,CASE WHEN i<=2 THEN 1002000 ELSE 4000000 END,NULL,i*100,1,5,
            '2026-10-25Z','2026-10-25 04:00Z' FROM generate_series(1,5000) i",
        "UPDATE market_state SET as_of='2026-10-25 04:00Z'",
        "ANALYZE observations", "ANALYZE shops", "ANALYZE observation_rows", "ANALYZE listings",
    ] { sqlx::query(statement).execute(&db.pool).await.unwrap(); }
    // Keep all prepared statements and planner settings on a single connection.
    let pool = PgPoolOptions::new()
        .max_connections(1)
        .connect_with((*db.pool.connect_options()).clone())
        .await
        .unwrap();
    sqlx::query("SET plan_cache_mode=force_generic_plan")
        .execute(&pool)
        .await
        .unwrap();
    let now = chrono::DateTime::parse_from_rfc3339("2026-10-25T05:00:00Z")
        .unwrap()
        .timestamp() as f64;
    for (selection, count, median) in [
        (ItemSelection::default(), 2, Some(400.)),
        (
            ItemSelection {
                variant: Some(1),
                ..Default::default()
            },
            1,
            Some(200.),
        ),
        (
            ItemSelection {
                variant: Some(2),
                ..Default::default()
            },
            1,
            Some(300.),
        ),
        (
            ItemSelection {
                equipment: "missing".into(),
                ..Default::default()
            },
            1,
            Some(500.),
        ),
        (
            ItemSelection {
                attributes: vec![("dex".into(), 99)],
                ..Default::default()
            },
            0,
            None,
        ),
    ] {
        let page = item_page_selected(&pool, 1002000, now, true, &selection)
            .await
            .unwrap()
            .unwrap();
        let last = page.market.listing_days.last().unwrap();
        assert_eq!((last.count, last.median), (count, median));
        if selection.variant == Some(1) {
            let first = &page.market.listing_days[0];
            assert_eq!((first.count, first.median), (1, Some(50.)));
        }
        assert!(
            page.market.sales.is_empty(),
            "historical quotes cannot invent sales"
        );
    }
    let detail_sql: String = sqlx::query_scalar(
        "SELECT statement FROM pg_prepared_statements
        WHERE statement LIKE 'WITH quotes AS (%' AND statement LIKE '%observation_rows%' LIMIT 1",
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    let first = chrono::NaiveDate::from_ymd_opt(2026, 10, 19).unwrap();
    let detail_plan: Value = sqlx::query_scalar(&format!(
        "EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON) {detail_sql}"
    ))
    .bind(1002000)
    .bind(first)
    .bind(now)
    .bind(None::<Vec<i64>>)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert!(assert_point_lookup(&detail_plan[0]["Plan"], "observations", 8) > 0);
    assert_eq!(detail_plan[0]["Plan"]["Temp Written Blocks"], 0);

    let watch = views::watch_listings(&pool, &[1002000], now).await.unwrap();
    assert_eq!(watch["total"], 2);
    assert_eq!(watch["listings"].as_array().unwrap().len(), 2);
    assert_eq!(watch["percentile_caps"]["1002000"]["50"], 100.);
    let watch_sql: String = sqlx::query_scalar(
        "SELECT statement FROM pg_prepared_statements
        WHERE statement LIKE 'SELECT o.visit_key,%' AND statement LIKE '%FROM listings l%'
          AND statement LIKE '%ANY($1)%' LIMIT 1",
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    let watch_plan: Value = sqlx::query_scalar(&format!(
        "EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON) {watch_sql}"
    ))
    .bind(vec![1002000])
    .bind(now - 259200.)
    .fetch_one(&pool)
    .await
    .unwrap();
    for table in ["shops", "observations"] {
        assert!(assert_point_lookup(&watch_plan[0]["Plan"], table, 2) > 0);
    }
    assert_eq!(watch_plan[0]["Plan"]["Temp Written Blocks"], 0);
    pool.close().await;
    db.close().await;
}

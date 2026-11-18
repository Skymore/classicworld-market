//! A clock pass reads only recent sales. Its figures must equal a full
//! recompute at the same instant, including items whose typical price falls
//! back to older sales.

mod common;

use common::TestDb;
use market_web::{external, stats, unix_now};
use serde_json::{json, Value};

const DAY: f64 = 86400.0;
const ITEMS: [i32; 3] = [4010001, 4010002, 4010003];

async fn import(db: &TestDb, item: i32, sales: &[(f64, f64)]) {
    let now = unix_now();
    let id = format!("basil:{item:08}");
    let points: external::Points = serde_json::from_value(json!({
        "version": 1, "source": "mesowatch", "world": "ClassicWorld", "generated_at": now, "manifest": {},
        "items": [{"source_item_id": id, "item_id": item, "name_en": "Ore", "unit_basis": "item",
                   "listings_generated_at": now}],
        "sales": sales.iter().enumerate().map(|(i, (time, price))| json!({
            "source_item_id": id, "source_key": format!("{id}:{i}"), "time": time, "kind": "drop",
            "unit_price": price, "seller": format!("Seller{}", i % 4), "location": {"room": 22}, "raw": {}
        })).collect::<Vec<_>>(),
        "listings": []
    }))
    .unwrap();
    external::import(&db.pool, &points, &format!("r{item}"), now).await.unwrap();
}

/// item_stats rows, and item_stats_all rows with list_fields as JSON, without
/// the cache revision every write bumps.
async fn snapshot(db: &TestDb) -> Value {
    sqlx::query_scalar(
        "SELECT jsonb_build_object(
           'stats', (SELECT jsonb_object_agg(item_id, to_jsonb(s) - 'read_revision') FROM item_stats s WHERE item_id = ANY($1)),
           'all', (SELECT jsonb_object_agg(item_id, to_jsonb(a) - 'list_fields' - 'read_revision'
                     || jsonb_build_object('list', ('{' || a.list_fields || '}')::jsonb))
                   FROM item_stats_all a WHERE item_id = ANY($1)),
           'daily', (SELECT count(*) FROM item_daily WHERE item_id = ANY($1)))",
    )
    .bind(&ITEMS[..])
    .fetch_one(&db.pool)
    .await
    .unwrap()
}

/// Names the differing leaves instead of printing both snapshots.
fn assert_same(clock: &Value, full: &Value) {
    fn walk(path: String, a: &Value, b: &Value, out: &mut Vec<String>) {
        match (a, b) {
            (Value::Object(x), Value::Object(y)) => {
                for k in x.keys().chain(y.keys().filter(|k| !x.contains_key(*k))) {
                    walk(format!("{path}.{k}"), x.get(k).unwrap_or(&Value::Null), y.get(k).unwrap_or(&Value::Null), out);
                }
            }
            _ if a != b => out.push(format!("{path}: clock={a} full={b}")),
            _ => {}
        }
    }
    let mut out = Vec::new();
    walk(String::new(), clock, full, &mut out);
    assert!(out.is_empty(), "{}", out.join("
"));
}

#[tokio::test]
async fn clock_pass_from_recent_sales_matches_a_full_recompute() {
    let Some(db) = TestDb::new().await else {
        return;
    };
    sqlx::query("INSERT INTO items(id,name_en,category) VALUES (4010001,'Ore','其他'),(4010002,'Ore','其他'),(4010003,'Ore','其他')")
        .execute(&db.pool)
        .await
        .unwrap();
    let now = unix_now();
    // Busy: a sale every 18 hours for 30 days, prices drifting.
    let busy: Vec<(f64, f64)> = (0..40)
        .map(|n| (now - 600.0 - f64::from(n) * 0.75 * DAY, 100.0 + f64::from(n * 7 % 23)))
        .collect();
    import(&db, 4010001, &busy).await;
    // Only older sales: the typical price uses the latest ten of twelve.
    let old: Vec<(f64, f64)> = (0..12)
        .map(|n| (now - 12.0 * DAY - f64::from(n) * DAY, 50.0 + f64::from(n * 5)))
        .collect();
    import(&db, 4010002, &old).await;
    // Fewer sales than the fallback, all old.
    import(&db, 4010003, &[(now - 20.0 * DAY, 9.0), (now - 25.0 * DAY, 11.0), (now - 40.0 * DAY, 13.0)]).await;

    let sales: Vec<(i32, i64)> = sqlx::query_as("SELECT item_id, count(*) FROM market_sales GROUP BY 1 ORDER BY 1")
        .fetch_all(&db.pool)
        .await
        .unwrap();
    assert_eq!(sales, [(4010001, 40), (4010002, 12), (4010003, 3)]);
    stats::recompute_at(&db.pool, &ITEMS, now, false).await.unwrap();
    let full_now = snapshot(&db).await;
    // Spoil the clock fields, then let a clock pass restore them.
    sqlx::query(
        "UPDATE item_stats SET typical=-1, sales_24h=-1, sales_10d=-1, trend='[]', list_fields='\"x\":1'
         WHERE item_id = ANY($1)",
    )
    .bind(&ITEMS[..])
    .execute(&db.pool)
    .await
    .unwrap();
    sqlx::query(
        "UPDATE item_stats_all SET list_fields = substr(j::text, 2, length(j::text) - 2)
         FROM (SELECT item_id AS id, ('{' || list_fields || '}')::jsonb
                 || '{\"typical\":-1,\"sales_24h\":-1,\"trend\":[],\"last_sale_at\":0}'::jsonb AS j
               FROM item_stats_all) x
         WHERE item_id = x.id AND item_id = ANY($1)",
    )
    .bind(&ITEMS[..])
    .execute(&db.pool)
    .await
    .unwrap();
    stats::recompute_at(&db.pool, &ITEMS, now, true).await.unwrap();
    assert_same(&snapshot(&db).await, &full_now);

    // Days later, sales have moved across the 24 h, 72 h, 7 and 10 day lines.
    let later = now + 3.3 * DAY;
    stats::recompute_at(&db.pool, &ITEMS, later, true).await.unwrap();
    let clock_later = snapshot(&db).await;
    stats::recompute_at(&db.pool, &ITEMS, later, false).await.unwrap();
    assert_same(&clock_later, &snapshot(&db).await);
    assert_ne!(clock_later, full_now, "the clock moved some figures");
    db.close().await;
}

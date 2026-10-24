//! The browser matcher and Postgres search use the same user-facing cases.
#[path = "common/mod.rs"]
mod common;

use market_web::{
    bestiary::{model::ItemFilters, queries},
    views,
};
use serde_json::Value;

#[tokio::test]
async fn keyword_search_matches_browser_cases_in_postgres() {
    let Some(db) = common::TestDb::new().await else {
        return;
    };
    let cases: Vec<Value> = serde_json::from_str(include_str!(
        "../../../../web/tests/fixtures/search-cases.json"
    ))
    .unwrap();
    for item in &cases {
        sqlx::query("INSERT INTO items(id,name_zh,name_en,category) VALUES ($1,$2,$3,'消耗品')")
            .bind(item["item_id"].as_i64().unwrap() as i32)
            .bind(item["name_zh"].as_str())
            .bind(item["name_en"].as_str())
            .execute(&db.pool)
            .await
            .unwrap();
    }
    for item in &cases {
        let id = item["item_id"].as_i64().unwrap() as i32;
        for (field, expected) in [("queries", true), ("misses", false)] {
            for query in item[field].as_array().unwrap() {
                let query = query.as_str().unwrap();
                let dex =
                    queries::search_filtered(&db.pool, query, None, 0, ItemFilters::default())
                        .await
                        .unwrap();
                assert_eq!(
                    dex.items.rows.iter().any(|row| row.id == id),
                    expected,
                    "dex: {id} {query:?}"
                );
                if !query.trim().is_empty() {
                    let watch = views::search_catalog(&db.pool, query).await.unwrap();
                    assert_eq!(
                        watch["items"]
                            .as_array()
                            .unwrap()
                            .iter()
                            .any(|row| row["item_id"] == id),
                        expected,
                        "watchlist: {id} {query:?}"
                    );
                }
            }
        }
    }
    // Category filters still apply after keyword matching.
    let equip = queries::search_filtered(
        &db.pool,
        "宠物 移速",
        None,
        0,
        ItemFilters {
            cat: "equip".into(),
            ..Default::default()
        },
    )
    .await
    .unwrap();
    assert!(equip.items.rows.is_empty());
    db.close().await;
}

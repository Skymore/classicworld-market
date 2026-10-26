#[path = "common/mod.rs"]
mod common;

use market_web::views;
use serde_json::json;

#[tokio::test]
async fn enhancement_catalog_returns_only_matching_scroll_family() {
    let Some(db) = common::TestDb::new().await else {
        return;
    };
    for id in [2040801, 2040802, 2040805, 2044501] {
        sqlx::query("INSERT INTO items(id,name_en,category) VALUES ($1,'Scroll','消耗品')")
            .bind(id)
            .execute(&db.pool)
            .await
            .unwrap();
        sqlx::query("INSERT INTO item_records(item_id,record) VALUES ($1,$2)")
            .bind(id)
            .bind(json!({"item_id":id,"mapledex_reference":{"data":{"success":60}}}))
            .execute(&db.pool)
            .await
            .unwrap();
    }
    let gloves = views::enhancement_scrolls(&db.pool, 1082000).await.unwrap();
    assert_eq!(
        gloves
            .iter()
            .map(|r| r["item_id"].as_i64().unwrap())
            .collect::<Vec<_>>(),
        vec![2040801, 2040802, 2040805]
    );
    let bow = views::enhancement_scrolls(&db.pool, 1452003).await.unwrap();
    assert_eq!(bow.len(), 1);
    assert_eq!(bow[0]["item_id"], 2044501);
    assert!(views::enhancement_scrolls(&db.pool, 1002000)
        .await
        .unwrap()
        .is_empty());
    db.close().await;
}

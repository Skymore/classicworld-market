#[path = "bestiary_common/mod.rs"]
mod common;

use axum::{
    body::Body,
    http::{Request, StatusCode},
};
use http_body_util::BodyExt;
use market_web::{app, crafting, AppState, Settings};
use serde_json::Value;
use tower::ServiceExt;

#[tokio::test]
async fn ingredient_prices_preserve_unknowns_expire_old_evidence_and_use_npc_buy_prices() {
    let Some(db) = common::test_db().await else {
        return;
    };
    sqlx::query("INSERT INTO items(id,name_en,category) VALUES (1452003,'Battle Bow','装备'), (4010101,'Iron Ingot','其他'), (4020106,'Topaz','其他')")
        .execute(&db.pool).await.unwrap();
    sqlx::query("INSERT INTO npcs(id,name_en) VALUES (210,'Karl')")
        .execute(&db.pool)
        .await
        .unwrap();
    sqlx::query("INSERT INTO npc_shops(npc_id,item_id,price,source) VALUES (210,1452003,16500,'fixture shop purchase')").execute(&db.pool).await.unwrap();
    let now = 1_792_800_000.0;
    sqlx::query("INSERT INTO item_stats(item_id,typical,last_sale_at,lowest_ask,listings_count,last_seen_at,as_of)
                 VALUES (1452003,7999,to_timestamp($1-100),9000,1,to_timestamp($1-100),to_timestamp($1)),
                 (4010101,1000,to_timestamp($1-80*3600),1500,1,to_timestamp($1-80*3600),to_timestamp($1))")
        .bind(now).execute(&db.pool).await.unwrap();
    let rows = serde_json::to_value(crafting::prices(&db.pool, now).await.unwrap()).unwrap();
    let get = |id: i32| {
        rows.as_array()
            .unwrap()
            .iter()
            .find(|r| r["item_id"] == id)
            .unwrap()
    };
    assert_eq!(get(1452003)["market_price"], 7999.0);
    assert_eq!(get(1452003)["npc_price"], 16500.0);
    assert!(get(4010101)["market_price"].is_null());
    assert!(get(4010101)["ask_price"].is_null());
    assert!(get(4020106)["market_price"].is_null());
    sqlx::query("UPDATE item_stats SET last_seen_at=to_timestamp($1-100) WHERE item_id=4010101")
        .bind(now)
        .execute(&db.pool)
        .await
        .unwrap();
    let refreshed = serde_json::to_value(crafting::prices(&db.pool, now).await.unwrap()).unwrap();
    let iron = refreshed
        .as_array()
        .unwrap()
        .iter()
        .find(|r| r["item_id"] == 4010101)
        .unwrap();
    assert!(iron["market_price"].is_null());
    assert_eq!(iron["ask_price"], 1500.0);
    let state = AppState::new(db.pool.clone(), Settings::default());
    let response = app(state)
        .oneshot(
            Request::get("/api/v1/crafting/prices")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let body: Value =
        serde_json::from_slice(&response.into_body().collect().await.unwrap().to_bytes()).unwrap();
    assert!(body["prices"].is_array());
    assert!(body["as_of"].is_number());
    db.drop_schema().await;
}

#[tokio::test]
async fn private_market_does_not_expose_ingredient_quotes_anonymously() {
    let pool = sqlx::postgres::PgPoolOptions::new()
        .connect_lazy("postgres://nobody@127.0.0.1:1/none")
        .unwrap();
    let state = AppState::new(
        pool,
        Settings {
            public_read: false,
            ..Settings::default()
        },
    );
    let response = app(state)
        .oneshot(
            Request::get("/api/v1/crafting/prices")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
}

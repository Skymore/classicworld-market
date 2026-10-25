#[path = "bestiary_common/mod.rs"]
mod common;

use axum::{
    body::Body,
    http::{Request, StatusCode},
};
use http_body_util::BodyExt;
use market_web::{
    app,
    bestiary::queries::{item_page_selected, ItemSelection},
    unix_now, AppState, Settings,
};
use serde_json::{json, Value};
use tower::ServiceExt;

#[tokio::test]
async fn attribute_subpages_scope_before_sale_limits_and_recompute_every_price_input() {
    let Some(db) = common::test_db().await else {
        return;
    };
    for statement in [
        "INSERT INTO items(id,name_en,category) VALUES(1002000,'Fixture equipment','装备'),(1002001,'Other equipment','装备')",
        "INSERT INTO collectors(id,public_id,token_hash,source) VALUES(1,'fixture','\\x01','packet')",
        "INSERT INTO shops(id,shop_key,world,channel,room,shop_id,title,first_seen_at,last_seen_at,public_key) VALUES(1,'fixture','w',14,8,77,'Fixture shop',now()-interval '1 hour',now(),'fixture')",
        "INSERT INTO observations(id,observation_id,collector_id,shop_id,source,observed_at,fingerprint,visit_key) VALUES(1,'fixture',1,1,'packet',now(),'fixture','fixture')",
        "UPDATE market_state SET as_of=now()",
    ] { sqlx::query(statement).execute(&db.pool).await.unwrap(); }
    for (id, dex, def, enhancements, left) in [
        (1, 2, 10, 0, 7),
        (2, 2, 20, 0, 7),
        (3, 4, 10, 0, 7),
        (4, 2, 10, 1, 7),
        (5, 2, 10, 0, 6),
    ] {
        let stats = json!({"stats":[{"key":"str","label":"力量","value":11},{"key":"dex","label":"敏捷","value":dex},{"key":"weapon_defense","label":"物理防御","value":def}],"enhancements":enhancements,"remaining_upgrades":left,"unknown_fields":[]});
        sqlx::query(
            "INSERT INTO equipment_variants(id,item_id,stats_hash,stats) VALUES($1,1002000,$2,$3)",
        )
        .bind(id as i64)
        .bind(vec![id as u8])
        .bind(stats)
        .execute(&db.pool)
        .await
        .unwrap();
        sqlx::query("INSERT INTO listings(shop_id,slot,item_id,variant_id,price,bundle,stock,first_seen_at,last_seen_at,observation_id) VALUES(1,$1,1002000,$2,$3,1,1,now(),now(),1)")
            .bind(id).bind(id as i64).bind(id*100).execute(&db.pool).await.unwrap();
    }
    // Sixty newer sales of other attributes must not crowd matching sales out.
    for slot in 1..=63 {
        let variant = if slot <= 2 {
            Some(slot as i64)
        } else if slot == 63 {
            None
        } else {
            Some(3_i64)
        };
        let age = if slot == 1 { 100.0 } else { 1.0 };
        sqlx::query("INSERT INTO sales(item_id,variant_id,shop_id,slot,kind,price,bundle,detected_at,observation_id,position) VALUES(1002000,$1,1,$2,'found_sold',$3,1,now()-($4::float8*interval '1 hour'),1,$5)")
            .bind(variant).bind(slot).bind(slot*100).bind(age).bind(slot as i16).execute(&db.pool).await.unwrap();
    }
    let now = unix_now();
    let selection = ItemSelection {
        variant: Some(1),
        ..Default::default()
    };
    let page = item_page_selected(&db.pool, 1002000, now, true, &selection)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(page.selected_variant.as_ref().unwrap().id, 1);
    assert_eq!(
        page.market
            .listings
            .iter()
            .map(|l| l.variant.as_ref().unwrap().id)
            .collect::<Vec<_>>(),
        vec![1, 2]
    );
    assert_eq!(
        page.market.sales.len(),
        2,
        "filter before the fifty-sale limit"
    );
    let stats = page.stats.unwrap();
    assert_eq!(
        (stats.listings_count, stats.shops_count, stats.lowest_ask),
        (2, 1, Some(100))
    );
    assert_eq!((stats.sales_24h, stats.typical), (2, Some(150)));
    assert_eq!(page.market.sale_points.len(), 2);
    assert_eq!(page.market.days.iter().map(|d| d.count).sum::<i32>(), 2);
    let recent = item_page_selected(&db.pool, 1002000, now, false, &selection)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(recent.market.sales.len(), 1);
    assert_eq!(recent.stats.unwrap().typical, Some(200));
    let multiple = ItemSelection {
        attributes: vec![("str".into(), 11), ("dex".into(), 3)],
        ..Default::default()
    };
    let page = item_page_selected(&db.pool, 1002000, now, true, &multiple)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(page.market.listings.len(), 1);
    assert_eq!(page.market.listings[0].variant.as_ref().unwrap().id, 3);
    assert_eq!(page.market.sales.len(), 50);
    assert_eq!(page.stats.unwrap().sales_24h, 60);
    assert_eq!(page.market.sale_points.len(), 60);
    assert!(
        item_page_selected(&db.pool, 1002001, now, true, &selection)
            .await
            .unwrap()
            .is_none(),
        "wrong-item variant cannot broaden to all attributes"
    );
    let router = app(AppState::new(db.pool.clone(), Settings::default()));
    for route in [
        "/item/1002000?variant=1&hours=all",
        "/api/v1/catalog/page?url=%2Fitem%2F1002000%3Fvariant%3D1%26hours%3Dall",
    ] {
        let response = router
            .clone()
            .oneshot(Request::get(route).body(Body::empty()).unwrap())
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let body = response.into_body().collect().await.unwrap().to_bytes();
        if route.starts_with("/api") {
            let dto: Value = serde_json::from_slice(&body).unwrap();
            assert_eq!(
                dto["page"]["market"]["listings"].as_array().unwrap().len(),
                2
            );
        } else {
            let text = String::from_utf8(body.to_vec()).unwrap();
            assert!(text.contains("data-selected-attributes") && text.contains("查看全部属性"));
        }
    }
    for route in ["/item/1002001?variant=1", "/item/1002000?variant=999999"] {
        assert_eq!(
            router
                .clone()
                .oneshot(Request::get(route).body(Body::empty()).unwrap())
                .await
                .unwrap()
                .status(),
            StatusCode::NOT_FOUND
        );
    }
    db.drop_schema().await;
}

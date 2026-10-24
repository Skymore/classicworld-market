#[path = "common/mod.rs"]
mod common;
use axum::{
    body::Body,
    http::{Request, StatusCode},
};
use http_body_util::BodyExt;
use market_web::{app, AppState, Settings};
use tower::ServiceExt;

#[tokio::test]
async fn catalog_snapshots_keep_search_filters_and_do_not_expose_arbitrary_paths() {
    let Some(db) = common::TestDb::new().await else {
        return;
    };
    sqlx::query("INSERT INTO items(id,name_zh,name_en,category,req_level) VALUES (1002000,'蓝色头巾','Blue Bandana','装备',10),(2000000,'红色药水','Red Potion','消耗品',0)").execute(&db.pool).await.unwrap();
    let application = app(AppState::new(db.pool.clone(), Settings::default()));
    for (url, expected) in [
        ("/search?kind=item&cat=use", 2000000),
        (
            "/search?kind=item&cat=equip&min_level=5&max_level=20",
            1002000,
        ),
    ] {
        let path = format!(
            "/api/v1/catalog/page?url={}",
            url::form_urlencoded::byte_serialize(url.as_bytes()).collect::<String>()
        );
        let response = application
            .clone()
            .oneshot(Request::get(path).body(Body::empty()).unwrap())
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(response.headers()["cache-control"], "no-store");
        let json: serde_json::Value =
            serde_json::from_slice(&response.into_body().collect().await.unwrap().to_bytes())
                .unwrap();
        assert_eq!(json["kind"], "search");
        assert_eq!(json["page"]["items"]["rows"].as_array().unwrap().len(), 1);
        assert_eq!(json["page"]["items"]["rows"][0]["id"], expected);
    }
    for url in ["/item/2000000?hours=all", "/route"] {
        let path = format!(
            "/api/v1/catalog/page?url={}",
            url::form_urlencoded::byte_serialize(url.as_bytes()).collect::<String>()
        );
        let response = application
            .clone()
            .oneshot(Request::get(path).body(Body::empty()).unwrap())
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
    }
    for (url, expected) in [
        ("https://example.com", StatusCode::BAD_REQUEST),
        ("//example.com/item/1", StatusCode::BAD_REQUEST),
        ("/api/v1/account", StatusCode::NOT_FOUND),
        ("/item/9999999", StatusCode::NOT_FOUND),
        ("/item/-1", StatusCode::NOT_FOUND),
    ] {
        let path = format!(
            "/api/v1/catalog/page?url={}",
            url::form_urlencoded::byte_serialize(url.as_bytes()).collect::<String>()
        );
        let response = application
            .clone()
            .oneshot(Request::get(path).body(Body::empty()).unwrap())
            .await
            .unwrap();
        assert_eq!(response.status(), expected, "{url}");
    }
    db.close().await;
}

//! HTTP behaviour of `/api/v1/*` against Postgres, following
//! `test_shared_market.py` (auth, limits, cookies) and `test_market_sales.py`
//! (list view, ETag, recent sales, item detail).

mod common;

use axum::{
    body::Body,
    http::{header, Request, Response, StatusCode},
};
use common::TestDb;
use http_body_util::BodyExt;
use market_web::{app, auth, unix_now, AppState, Settings};
use serde_json::{json, Value};
use tower::ServiceExt;

struct Client {
    state: AppState,
}

impl Client {
    fn new(db: &TestDb, public_read: bool) -> Self {
        Self {
            state: AppState::new(
                db.pool.clone(),
                Settings {
                    public_read,
                    ..Settings::default()
                },
            ),
        }
    }

    async fn send(&self, request: Request<Body>) -> Response<Body> {
        app(self.state.clone()).oneshot(request).await.unwrap()
    }

    async fn get(&self, uri: &str, headers: &[(&str, &str)]) -> Response<Body> {
        let mut request = Request::get(uri);
        for (k, v) in headers {
            request = request.header(*k, *v);
        }
        self.send(request.body(Body::empty()).unwrap()).await
    }

    async fn post(&self, uri: &str, body: &Value, headers: &[(&str, &str)]) -> Response<Body> {
        let mut request = Request::post(uri).header(header::CONTENT_TYPE, "application/json");
        for (k, v) in headers {
            request = request.header(*k, *v);
        }
        self.send(request.body(Body::from(body.to_string())).unwrap())
            .await
    }
}

async fn json_body(response: Response<Body>) -> Value {
    let bytes = response.into_body().collect().await.unwrap().to_bytes();
    serde_json::from_slice(&bytes).unwrap()
}

fn observation(id: &str, observed_at: f64, stock: i64) -> Value {
    json!({
        "version": 1, "world": "ClassicWorld", "complete": true, "title": "Shop", "shop_id": 7,
        "location": {"channel": 1, "room": 1}, "observation_id": id, "observed_at": observed_at,
        "items": [{"item_id": 4010001, "category": 4, "slot": 1, "price": 500, "bundle": 1, "stock": stock}]
    })
}

/// A public site with one shop seen at stock 5, 3, 0: a drop and a sell-out.
async fn market(db: &TestDb) -> (Client, String) {
    let client = Client::new(db, true);
    let registered = json_body(client.post("/api/v1/register", &json!({}), &[]).await).await;
    let token = registered["token"].as_str().unwrap().to_string();
    let now = unix_now();
    for (n, stock) in [5, 3, 0].into_iter().enumerate() {
        let response = client
            .post(
                "/api/v1/observations",
                &observation(&n.to_string(), now - 300.0 + n as f64 * 60.0, stock),
                &[("authorization", &format!("Bearer {token}"))],
            )
            .await;
        assert_eq!(response.status(), StatusCode::CREATED);
    }
    (client, token)
}

#[tokio::test]
async fn list_view_is_slim_and_revalidates() {
    let Some(db) = TestDb::new().await else {
        return;
    };
    let (client, _) = market(&db).await;
    let first = client.get("/api/v1/market?view=list", &[]).await;
    assert_eq!(first.status(), StatusCode::OK);
    assert_eq!(first.headers()[header::CACHE_CONTROL], "no-store");
    let tag = first.headers()[header::ETAG].to_str().unwrap().to_string();
    let body = json_body(first).await;
    let product = &body["products"][0];
    assert_eq!(
        (product["sales_24h"].clone(), product["typical"].clone()),
        (json!(2), json!(500.0))
    );
    assert_eq!(product["trend"].as_array().unwrap().len(), 7);
    assert!(product.get("quotes").is_none() && product.get("recommendation").is_none());
    assert_eq!(body["public_read"], true);

    let again = client
        .get("/api/v1/market?view=list", &[("if-none-match", &tag)])
        .await;
    assert_eq!(again.status(), StatusCode::NOT_MODIFIED);
    assert!(again
        .into_body()
        .collect()
        .await
        .unwrap()
        .to_bytes()
        .is_empty());
    assert_eq!(
        client.get("/api/v1/market?view=cards", &[]).await.status(),
        StatusCode::BAD_REQUEST
    );
    assert_eq!(
        client.get("/api/v1/market?hours=24", &[]).await.status(),
        StatusCode::BAD_REQUEST
    );

    let summary = json_body(client.get("/api/v1/market?summary=1&hours=all", &[]).await).await;
    assert_eq!(
        summary["products"][0]["recommendation"]["fast_price"],
        499.0
    );
    assert_eq!(summary["hours"], Value::Null);
    db.close().await;
}

#[tokio::test]
async fn an_upload_changes_the_list_tag() {
    let Some(db) = TestDb::new().await else {
        return;
    };
    let (client, token) = market(&db).await;
    let tag = |r: &Response<Body>| r.headers()[header::ETAG].to_str().unwrap().to_string();
    let before = tag(&client.get("/api/v1/market?view=list", &[]).await);
    let response = client
        .post(
            "/api/v1/observations",
            &observation("later", unix_now() - 10.0, 9),
            &[("authorization", &format!("Bearer {token}"))],
        )
        .await;
    assert_eq!(response.status(), StatusCode::CREATED);
    let after = client
        .get("/api/v1/market?view=list", &[("if-none-match", &before)])
        .await;
    assert_eq!(after.status(), StatusCode::OK);
    assert_ne!(tag(&after), before);
    db.close().await;
}

#[tokio::test]
async fn recent_sales_pages_newest_first() {
    let Some(db) = TestDb::new().await else {
        return;
    };
    let (client, _) = market(&db).await;
    let first = json_body(client.get("/api/v1/sales/recent?limit=1", &[]).await).await;
    assert_eq!(first["sales"][0]["kind"], "sold_out");
    assert_eq!(first["sales"][0]["quantity"], 3);
    assert!(
        first["sales"][0].get("shop_key").is_none(),
        "public fields only"
    );
    let next = first["next_before"].as_f64().unwrap();
    let older = json_body(
        client
            .get(&format!("/api/v1/sales/recent?before={next}"), &[])
            .await,
    )
    .await;
    let kinds: Vec<&str> = older["sales"]
        .as_array()
        .unwrap()
        .iter()
        .map(|s| s["kind"].as_str().unwrap())
        .collect();
    assert_eq!(kinds, ["drop"]);
    assert_eq!(older["next_before"], Value::Null);
    let filtered = json_body(
        client
            .get("/api/v1/sales/recent?category=%E8%A3%85%E5%A4%87", &[])
            .await,
    )
    .await;
    assert!(filtered["sales"].as_array().unwrap().is_empty());
    assert_eq!(
        client
            .get("/api/v1/sales/recent?limit=500", &[])
            .await
            .status(),
        StatusCode::BAD_REQUEST
    );
    db.close().await;
}

#[tokio::test]
async fn item_detail_lists_newest_sales_first_with_trend() {
    let Some(db) = TestDb::new().await else {
        return;
    };
    let (client, _) = market(&db).await;
    let detail = json_body(client.get("/api/v1/market?item_id=4010001", &[]).await).await;
    let product = &detail["products"][0];
    let kinds: Vec<&str> = product["sales"]
        .as_array()
        .unwrap()
        .iter()
        .map(|s| s["kind"].as_str().unwrap())
        .collect();
    assert_eq!(kinds, ["sold_out", "drop"]);
    assert_eq!(product["trend_7d"].as_array().unwrap().len(), 7);
    assert_eq!(detail["history"].as_array().unwrap().len(), 3);
    assert_eq!(detail["history"][0]["stock"], 0, "newest first");
    let page = json_body(client.get("/api/v1/item/4010001", &[]).await).await;
    assert_eq!(page["daily"][0]["count"], 2);
    assert_eq!(
        client.get("/api/v1/item/4999999", &[]).await.status(),
        StatusCode::NOT_FOUND
    );
    db.close().await;
}

#[tokio::test]
async fn uploads_need_an_active_token() {
    let Some(db) = TestDb::new().await else {
        return;
    };
    let client = Client::new(&db, true);
    let registered = json_body(client.post("/api/v1/register", &json!({}), &[]).await).await;
    let other = json_body(client.post("/api/v1/register", &json!({}), &[]).await).await;
    assert_ne!(registered["member_id"], other["member_id"]);
    assert_eq!(registered["endpoint"], "https://mxd.ruit.me");
    let bearer = format!("Bearer {}", registered["token"].as_str().unwrap());
    let data = observation("first", unix_now() - 60.0, 8);
    assert_eq!(
        client
            .post("/api/v1/observations", &data, &[])
            .await
            .status(),
        StatusCode::UNAUTHORIZED
    );
    assert_eq!(
        client
            .post("/api/v1/observations", &data, &[("authorization", &bearer)])
            .await
            .status(),
        StatusCode::CREATED
    );
    let again = client
        .post("/api/v1/upload", &data, &[("authorization", &bearer)])
        .await;
    assert_eq!(again.status(), StatusCode::OK);
    assert_eq!(
        json_body(again).await,
        json!({"ok": true, "duplicate": true})
    );
    let changed = observation("first", unix_now() - 60.0, 7);
    assert_eq!(
        client
            .post(
                "/api/v1/observations",
                &changed,
                &[("authorization", &bearer)]
            )
            .await
            .status(),
        StatusCode::CONFLICT
    );
    let ahead = observation("ahead", unix_now() + 600.0, 8);
    assert_eq!(
        client
            .post(
                "/api/v1/observations",
                &ahead,
                &[("authorization", &bearer)]
            )
            .await
            .status(),
        StatusCode::BAD_REQUEST
    );
    assert_eq!(
        client
            .post(
                "/api/v1/observations",
                &json!([]),
                &[("authorization", &bearer)]
            )
            .await
            .status(),
        StatusCode::BAD_REQUEST
    );
    auth::revoke(&db.pool, registered["member_id"].as_str().unwrap())
        .await
        .unwrap();
    assert_eq!(
        client
            .post("/api/v1/observations", &data, &[("authorization", &bearer)])
            .await
            .status(),
        StatusCode::UNAUTHORIZED
    );
    db.close().await;
}

#[tokio::test]
async fn private_site_needs_sign_in() {
    let Some(db) = TestDb::new().await else {
        return;
    };
    let client = Client::new(&db, false);
    assert_eq!(
        client
            .post("/api/v1/register", &json!({}), &[])
            .await
            .status(),
        StatusCode::FORBIDDEN
    );
    assert_eq!(
        client.get("/api/v1/market", &[]).await.status(),
        StatusCode::UNAUTHORIZED
    );
    assert_eq!(
        client.get("/api/v1/watchlist/catalog", &[]).await.status(),
        StatusCode::UNAUTHORIZED
    );
    let token = auth::register(&db.pool, "a").await.unwrap().token;
    let bearer = format!("Bearer {token}");
    assert_eq!(
        client
            .get("/api/v1/market", &[("authorization", &bearer)])
            .await
            .status(),
        StatusCode::OK
    );

    let login = client
        .post("/api/v1/login", &json!({"token": token}), &[])
        .await;
    assert_eq!(login.status(), StatusCode::OK);
    let cookie = login.headers()[header::SET_COOKIE]
        .to_str()
        .unwrap()
        .to_string();
    for flag in ["Secure", "HttpOnly", "SameSite=Strict"] {
        assert!(cookie.contains(flag), "{cookie}");
    }
    let session = cookie.split(';').next().unwrap().to_string();
    assert_eq!(
        client
            .get("/api/v1/market?view=list", &[("cookie", &session)])
            .await
            .status(),
        StatusCode::OK
    );
    let evil = client
        .post(
            "/api/v1/login",
            &json!({"token": token}),
            &[("origin", "https://evil.invalid")],
        )
        .await;
    assert_eq!(evil.status(), StatusCode::FORBIDDEN);
    assert_eq!(
        client
            .post("/api/v1/login", &json!({"token": "x"}), &[])
            .await
            .status(),
        StatusCode::UNAUTHORIZED
    );
    db.close().await;
}

#[tokio::test]
async fn public_limits_are_per_client_address() {
    let Some(db) = TestDb::new().await else {
        return;
    };
    let client = Client::new(&db, true);
    for _ in 0..5 {
        assert_eq!(
            client
                .post("/api/v1/register", &json!({}), &[])
                .await
                .status(),
            StatusCode::CREATED
        );
    }
    assert_eq!(
        client
            .post("/api/v1/register", &json!({}), &[])
            .await
            .status(),
        StatusCode::TOO_MANY_REQUESTS
    );
    let elsewhere = client
        .post(
            "/api/v1/register",
            &json!({}),
            &[("cf-connecting-ip", "192.0.2.10")],
        )
        .await;
    assert_eq!(elsewhere.status(), StatusCode::CREATED);
    db.close().await;
}

#[tokio::test]
async fn watchlist_routes_filter_items() {
    let Some(db) = TestDb::new().await else {
        return;
    };
    let (client, _) = market(&db).await;
    // The shop sold out; add a live listing.
    let token = auth::register(&db.pool, "w").await.unwrap().token;
    let response = client
        .post(
            "/api/v1/observations",
            &observation("live", unix_now() - 5.0, 8),
            &[("authorization", &format!("Bearer {token}"))],
        )
        .await;
    assert_eq!(response.status(), StatusCode::CREATED);
    let result = json_body(
        client
            .get("/api/v1/watchlist/listings?ids=4010001", &[])
            .await,
    )
    .await;
    assert_eq!(result["total"], 1);
    assert_eq!(result["listings"][0]["item_id"], 4010001);
    assert_eq!(
        json_body(
            client
                .get("/api/v1/watchlist/listings?ids=1452003", &[])
                .await
        )
        .await["total"],
        0
    );
    assert_eq!(
        client
            .get("/api/v1/watchlist/listings?ids=evil", &[])
            .await
            .status(),
        StatusCode::BAD_REQUEST
    );
    let catalog = json_body(client.get("/api/v1/watchlist/catalog?q=4010001", &[]).await).await;
    assert_eq!(
        catalog["items"][0]["name_zh"], "4010001",
        "placeholder item is listed under its id"
    );
    assert_eq!(catalog["presets"][0]["id"], "archer_25_30");
    assert_eq!(
        client.get("/api/v1/items/4010001", &[]).await.status(),
        StatusCode::NOT_FOUND
    );
    assert_eq!(
        client.get("/api/v1/items/abc", &[]).await.status(),
        StatusCode::NOT_FOUND
    );
    db.close().await;
}

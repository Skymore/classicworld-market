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
    assert_eq!(first.headers()[header::CACHE_CONTROL], "private, no-cache");
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
async fn page_delivery_revalidates_unchanged_items_and_limits_market_payloads() {
    let Some(db) = TestDb::new().await else { return };
    let (client, token) = market(&db).await;
    let auth = format!("Bearer {token}");
    let now = unix_now();
    assert_eq!(client.post("/api/v1/observations", &observation("live",now,5), &[("authorization",&auth)]).await.status(), StatusCode::CREATED);
    let paths = ["/api/v1/watchlist/listings?ids=4010001", "/api/v1/catalog/page?url=%2Fitem%2F4010001", "/api/v1/market/selected?ids=4010001"];
    let mut tags = Vec::new();
    for path in paths {
        let response = client.get(path, &[]).await;
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(response.headers()[header::CACHE_CONTROL], "private, no-cache");
        tags.push(response.headers()[header::ETAG].to_str().unwrap().to_owned());
    }
    // The HTML seed carries the same validator, including its unit and filters.
    let html = client.get("/item/4010001", &[]).await.into_body().collect().await.unwrap().to_bytes();
    let html = String::from_utf8(html.to_vec()).unwrap();
    let seed = html.split("id=\"catalog-snapshot\"").nth(1).unwrap().split_once('>').unwrap().1.split("</script>").next().unwrap();
    let seed: Value = serde_json::from_str(seed).unwrap();
    assert_eq!(seed["etag"], tags[1]);
    let mut other = observation("unrelated",now+1.,4);
    other["shop_id"] = json!(8); other["items"][0]["item_id"] = json!(4010002);
    assert_eq!(client.post("/api/v1/observations", &other, &[("authorization",&auth)]).await.status(), StatusCode::CREATED);
    // New state forces a fresh rebuild: validators must survive cache expiry
    // and global clock/version changes, not just the 2-second snapshot hit.
    let fresh = Client::new(&db, true);
    for (path, tag) in paths.iter().zip(&tags) {
        let response = fresh.get(path, &[("if-none-match", tag)]).await;
        assert_eq!(response.status(), StatusCode::NOT_MODIFIED, "{path}");
        assert!(response.into_body().collect().await.unwrap().to_bytes().is_empty());
    }
    let selected = json_body(fresh.get(paths[2], &[]).await).await;
    assert_eq!(selected["products"].as_array().unwrap().len(), 1);
    assert_eq!(selected["products"][0]["item_id"], 4010001);
    let other_selected = json_body(fresh.get("/api/v1/market/selected?ids=4010002", &[]).await).await;
    assert_eq!(other_selected["products"].as_array().unwrap().len(),1);
    assert_eq!(other_selected["products"][0]["item_id"],4010002,"shared projection cannot reuse another watch's selection");
    let overview = json_body(fresh.get("/api/v1/market/overview", &[]).await).await;
    assert_eq!(overview["product_count"], 2);
    assert!(overview.get("products").is_none());
    assert!(overview["busy"].as_array().unwrap().len() <= 8);
    assert_eq!(fresh.get("/api/v1/market/selected?ids=invalid", &[]).await.status(),StatusCode::BAD_REQUEST);
    assert_eq!(client.post("/api/v1/observations", &observation("changed",now+2.,3), &[("authorization",&auth)]).await.status(),StatusCode::CREATED);
    for (path, tag) in paths.iter().zip(&tags) {
        let response = fresh.get(path, &[("if-none-match",tag)]).await;
        assert_eq!(response.status(),StatusCode::OK,"changed {path}");
        assert_ne!(response.headers()[header::ETAG],tag.as_str());
    }
    let private = Client::new(&db, false);
    assert_eq!(private.get("/api/v1/market/overview", &[]).await.status(),StatusCode::UNAUTHORIZED);
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
async fn concurrent_lists_share_precomputed_results_without_reading_sales() {
    let Some(db) = TestDb::new().await else {
        return;
    };
    let (client, _) = market(&db).await;
    let mut lock = db.pool.begin().await.unwrap();
    sqlx::query("LOCK TABLE sales IN ACCESS EXCLUSIVE MODE")
        .execute(&mut *lock)
        .await
        .unwrap();
    let mut requests = tokio::task::JoinSet::new();
    for _ in 0..16 {
        let state = client.state.clone();
        requests.spawn(async move {
            state
                .market_lists
                .get(&state.db, market_web::views::Hours::Recent, true)
                .await
                .unwrap()
        });
    }
    let first = tokio::time::timeout(std::time::Duration::from_secs(2), async {
        let first = requests.join_next().await.unwrap().unwrap();
        while let Some(answer) = requests.join_next().await {
            assert!(
                std::sync::Arc::ptr_eq(&answer.unwrap(), &first),
                "same-version requests must reuse the exact response"
            );
        }
        let all = client
            .state
            .market_lists
            .get(&db.pool, market_web::views::Hours::All, true)
            .await
            .unwrap();
        let all: Value = serde_json::from_slice(&all.body()).unwrap();
        assert_eq!(all["hours"], Value::Null);
        assert_eq!(all["products"][0]["sales_window"], 2);
        first
    })
    .await
    .expect("list reads must not wait for the sales history table");
    let body: Value = serde_json::from_slice(&first.body()).unwrap();
    assert_eq!(body["hours"], 72);
    assert_eq!(body["products"][0]["sales_window"], 2);
    assert_eq!(body["products"][0]["typical_window"], 500.0);
    lock.rollback().await.unwrap();
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
    assert_eq!(result["grouped_listings"].as_array().unwrap().len(), 1);
    let live = &result["listings"][0];
    assert!(live["shop_key"].as_str().is_some_and(|s| !s.is_empty()));
    assert!(live["visit_id"].as_str().is_some_and(|s| !s.is_empty()));
    assert!(live["slot"].is_i64());
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

#[tokio::test]
async fn same_shop_quotes_group_before_limit_without_changing_notification_rows() {
    let Some(db) = TestDb::new().await else {
        return;
    };
    let (client, token) = market(&db).await;
    let mut value = observation("multiple-slots", unix_now() - 1., 1);
    value["items"] = json!([
        {"item_id":4010001,"category":4,"slot":1,"price":500,"bundle":1,"stock":1},
        {"item_id":4010001,"category":4,"slot":2,"price":500,"bundle":1,"stock":3},
        {"item_id":4010001,"category":4,"slot":3,"price":600,"bundle":1,"stock":2}
    ]);
    assert_eq!(
        client
            .post(
                "/api/v1/observations",
                &value,
                &[("authorization", &format!("Bearer {token}"))]
            )
            .await
            .status(),
        StatusCode::CREATED
    );
    let watch = json_body(
        client
            .get("/api/v1/watchlist/listings?ids=4010001", &[])
            .await,
    )
    .await;
    assert_eq!(watch["listings"].as_array().unwrap().len(), 3);
    let grouped = watch["grouped_listings"].as_array().unwrap();
    assert_eq!(grouped.len(), 2);
    let group = grouped
        .iter()
        .find(|row| row["unit_price"] == 500.)
        .unwrap();
    assert_eq!(group["stock"], 4);
    assert_eq!(group["merged_count"], 2);
    for n in 0..4 {
        let mut older = observation(&format!("older-shop-{n}"), unix_now() - 100. - n as f64, 99);
        older["shop_id"] = json!(100 + n);
        assert_eq!(
            client
                .post(
                    "/api/v1/observations",
                    &older,
                    &[("authorization", &format!("Bearer {token}"))]
                )
                .await
                .status(),
            StatusCode::CREATED
        );
    }
    let two = json_body(
        client
            .get("/api/v1/quotes/recent?limit=2&hours=all", &[])
            .await,
    )
    .await;
    let grouped_stock = |rows: &Value| {
        rows.as_array()
            .unwrap()
            .iter()
            .map(|row| json!([row["id"], row["stock"], row["merged_count"]]))
            .collect::<Vec<_>>()
    };
    assert_eq!(
        grouped_stock(&two["grouped_listings"]),
        grouped_stock(&watch["grouped_listings"])
    );
    let recent = json_body(
        client
            .get("/api/v1/quotes/recent?limit=1&hours=all", &[])
            .await,
    )
    .await;
    assert_eq!(recent["listings"].as_array().unwrap().len(), 1);
    assert_eq!(recent["grouped_listings"].as_array().unwrap().len(), 1);
    let group = &recent["grouped_listings"][0];
    let expected = if group["unit_price"] == 500. { 4 } else { 2 };
    assert_eq!(group["stock"], expected);
    db.close().await;
}

#[tokio::test]
async fn public_report_cache_coalesces_and_uploads_invalidate_all_price_windows() {
    use market_web::{market_cache::Report, views::Hours};
    let Some(db) = TestDb::new().await else {
        return;
    };
    let (client, token) = market(&db).await;
    let reports = [
        Report::Records(Hours::Recent, false),
        Report::Records(Hours::All, false),
        Report::Records(Hours::Recent, true),
        Report::Records(Hours::All, true),
        Report::Quotes(Hours::Recent, 8),
        Report::Quotes(Hours::All, 8),
    ];
    let mut previous = Vec::new();
    for report in reports {
        let results = futures_util::future::join_all(
            (0..8).map(|_| client.state.market_lists.report(&db.pool, report)),
        )
        .await;
        let first = results[0].as_ref().unwrap();
        assert!(results.iter().all(|r| r.as_ref().unwrap() == first));
        previous.push(first.clone());
    }
    // Cached public reports no longer touch historical/listing tables.
    let mut locked = db.pool.begin().await.unwrap();
    sqlx::raw_sql("LOCK TABLE sales,listings IN ACCESS EXCLUSIVE MODE")
        .execute(&mut *locked)
        .await
        .unwrap();
    for (report, old) in reports.into_iter().zip(&previous) {
        let result = tokio::time::timeout(
            std::time::Duration::from_secs(2),
            client.state.market_lists.report(&db.pool, report),
        )
        .await
        .unwrap()
        .unwrap();
        assert_eq!(&result, old);
    }
    locked.rollback().await.unwrap();
    let value = observation("cache-refresh", unix_now() - 1., 7);
    assert_eq!(
        client
            .post(
                "/api/v1/observations",
                &value,
                &[("authorization", &format!("Bearer {token}"))]
            )
            .await
            .status(),
        StatusCode::CREATED
    );
    for (report, old) in reports.into_iter().zip(&previous) {
        let (version, body) = client
            .state
            .market_lists
            .report(&db.pool, report)
            .await
            .unwrap();
        assert!(version > old.0);
        let payload: Value = serde_json::from_slice(&body).unwrap();
        match report {
            Report::Records(_, false) => assert_eq!(payload["records"][0]["stock"], 7),
            Report::Quotes(_, _) => assert_eq!(payload["listings"][0]["stock"], 7),
            _ => {}
        }
    }
    // A different limit must not reuse the previous request's shape.
    let (_, body) = client
        .state
        .market_lists
        .report(&db.pool, Report::Quotes(Hours::Recent, 1))
        .await
        .unwrap();
    assert_eq!(
        serde_json::from_slice::<Value>(&body).unwrap()["listings"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
    db.close().await;
}

#[tokio::test]
async fn private_statistics_cache_never_shares_counts_on_shard_collision() {
    let Some(db) = TestDb::new().await else {
        return;
    };
    let (client, token) = market(&db).await;
    let owner = market_web::auth::authenticate(&db.pool, Some(&token))
        .await
        .unwrap()
        .unwrap();
    let other = db.collector("empty-account").await;
    let other_id = owner.id + 16;
    sqlx::query("UPDATE collectors SET id=$1 WHERE id=$2")
        .bind(other_id)
        .bind(other.id)
        .execute(&db.pool)
        .await
        .unwrap();
    let own = client
        .state
        .market_lists
        .personal_stats(&db.pool, None, Some(owner.id))
        .await
        .unwrap();
    let empty = client
        .state
        .market_lists
        .personal_stats(&db.pool, None, Some(other_id))
        .await
        .unwrap();
    let own_again = client
        .state
        .market_lists
        .personal_stats(&db.pool, None, Some(owner.id))
        .await
        .unwrap();
    assert_eq!(own, json!({"shops":1,"quotes":3}));
    assert_eq!(empty, json!({"shops":0,"quotes":0}));
    assert_eq!(own_again, own);
    db.close().await;
}

#[tokio::test]
async fn recent_quotes_keep_the_observation_price_location_and_stock_together() {
    let Some(db) = TestDb::new().await else {
        return;
    };
    let (client, token) = market(&db).await;
    let now = unix_now();
    for (shop, age, price, stock) in [(21, 600.0, 10, 8), (22, 60.0, 900, 4), (23, 10.0, 1, 0)] {
        let mut value = observation(&format!("quote-{shop}"), now - age, stock);
        value["shop_id"] = json!(shop);
        value["location"] = json!({"channel":5,"room":3});
        value["items"][0]["price"] = json!(price);
        assert_eq!(
            client
                .post(
                    "/api/v1/observations",
                    &value,
                    &[("authorization", &format!("Bearer {token}"))]
                )
                .await
                .status(),
            StatusCode::CREATED
        );
    }
    let first = client
        .get("/api/v1/quotes/recent?limit=1&hours=all", &[])
        .await;
    assert_eq!(first.status(), StatusCode::OK);
    let tag = first.headers()[header::ETAG].to_str().unwrap().to_string();
    let body = json_body(first).await;
    let rows = body["listings"].as_array().unwrap();
    assert_eq!(rows.len(), 1);
    let row = &rows[0];
    assert_eq!(row["unit_price"], json!(900.0));
    assert_eq!(row["stock"], 4);
    assert!((row["observed"].as_f64().unwrap() - (now - 60.0)).abs() < 0.000_01);
    assert_eq!(row["location"]["channel"], 5);
    assert_eq!(row["location"]["room"], 3);
    assert!(row["id"].is_string());
    assert!(row.get("token").is_none());
    assert_eq!(
        client
            .get(
                "/api/v1/quotes/recent?limit=1&hours=all",
                &[("if-none-match", &tag)]
            )
            .await
            .status(),
        StatusCode::NOT_MODIFIED
    );
    let body = json_body(client.get("/api/v1/quotes/recent?hours=72", &[]).await).await;
    assert_eq!(
        body["listings"].as_array().unwrap().len(),
        2,
        "sold-out quotes are excluded"
    );
    assert_eq!(body["listings"][1]["unit_price"], json!(10.0));
    let records = json_body(
        client
            .get("/api/v1/market/records?kind=quotes&hours=all", &[])
            .await,
    )
    .await;
    assert_eq!(
        records["records"].as_array().unwrap().len(),
        1,
        "one latest quote per item"
    );
    assert_eq!(records["records"][0]["unit_price"], json!(900.0));
    assert_eq!(records["records"][0]["stock"], 4);
    assert_eq!(records["records"][0]["shop"], "Shop");
    let records = json_body(
        client
            .get("/api/v1/market/records?kind=sales&hours=all", &[])
            .await,
    )
    .await;
    assert_eq!(
        records["records"].as_array().unwrap().len(),
        1,
        "one latest sale per item"
    );
    assert_eq!(records["records"][0]["sale_unit_price"], json!(1.0));
    assert_eq!(records["records"][0]["stock"], 0);
    for query in ["kind=bad", "kind=sales&hours=bad", ""] {
        assert_eq!(
            client
                .get(&format!("/api/v1/market/records?{query}"), &[])
                .await
                .status(),
            StatusCode::BAD_REQUEST
        );
    }
    for query in ["limit=0", "limit=101", "limit=-1", "hours=bad"] {
        assert_eq!(
            client
                .get(&format!("/api/v1/quotes/recent?{query}"), &[])
                .await
                .status(),
            StatusCode::BAD_REQUEST
        );
    }
    db.close().await;
}

#[tokio::test]
async fn item_history_keeps_the_cheapest_offer_of_each_newest_observation() {
    let Some(db) = TestDb::new().await else {
        return;
    };
    let (client, token) = market(&db).await;
    let auth = format!("Bearer {token}");
    let now = unix_now();
    let mut several = observation("several", now - 30.0, 0);
    several["items"] = json!([
        {"item_id": 4010001, "category": 4, "slot": 1, "price": 900, "bundle": 1, "stock": 0},
        {"item_id": 4010001, "category": 4, "slot": 2, "price": 1400, "bundle": 2, "stock": 2},
        {"item_id": 4010001, "category": 4, "slot": 3, "price": 650, "bundle": 1, "stock": 1},
    ]);
    let mut sold_out = observation("sold-out", now - 20.0, 0);
    sold_out["items"] = json!([
        {"item_id": 4010001, "category": 4, "slot": 1, "price": 300, "bundle": 1, "stock": 0},
        {"item_id": 4010001, "category": 4, "slot": 2, "price": 200, "bundle": 1, "stock": 0},
    ]);
    for body in [several, sold_out] {
        let response = client
            .post("/api/v1/observations", &body, &[("authorization", &auth)])
            .await;
        assert_eq!(response.status(), StatusCode::CREATED);
    }
    let detail = json_body(client.get("/api/v1/market?item_id=4010001", &[]).await).await;
    let rows: Vec<(f64, i64)> = detail["history"]
        .as_array()
        .unwrap()
        .iter()
        .map(|r| {
            (
                r["unit_price"].as_f64().unwrap(),
                r["stock"].as_i64().unwrap(),
            )
        })
        .collect();
    // Newest first; one row per observation; in-stock offers before cheaper sold-out rows.
    assert_eq!(rows[..2], [(200.0, 0), (650.0, 1)]);
    assert_eq!(rows.len(), 5);

    sqlx::query(
        "INSERT INTO observations (observation_id, collector_id, shop_id, source, observed_at, received_at, fingerprint, visit_key)
         SELECT 'cap-'||n, o.collector_id, o.shop_id, 'packet', now() - interval '1 day' - n * interval '1 second', now(),
                'cap-'||n, 'cap-'||n
         FROM generate_series(1, 510) n, (SELECT collector_id, shop_id FROM observations LIMIT 1) o",
    )
    .execute(&db.pool)
    .await
    .unwrap();
    sqlx::query(
        "INSERT INTO observation_rows (observation_id, slot, item_id, price, bundle, stock, position)
         SELECT id, 1, 4010001, 100, 1, 1, 0 FROM observations WHERE observation_id LIKE 'cap-%'",
    )
    .execute(&db.pool)
    .await
    .unwrap();
    sqlx::query("UPDATE market_state SET version = version + 1")
        .execute(&db.pool)
        .await
        .unwrap();
    let detail = json_body(client.get("/api/v1/market?item_id=4010001", &[]).await).await;
    let history = detail["history"].as_array().unwrap();
    assert_eq!(history.len() as i64, market_web::views::HISTORY_LIMIT);
    assert_eq!(
        history[0]["unit_price"], 200.0,
        "the newest observations stay"
    );
    assert!(history
        .windows(2)
        .all(|w| w[0]["time"].as_f64() >= w[1]["time"].as_f64()));
    db.close().await;
}

#[tokio::test]
async fn list_answers_are_precompressed_private_and_select_rows_by_id() {
    use std::io::Read as _;
    let Some(db) = TestDb::new().await else {
        return;
    };
    let (client, _) = market(&db).await;
    let plain = client.get("/api/v1/market?view=list&hours=all", &[]).await;
    assert!(plain.headers().get(header::CONTENT_ENCODING).is_none());
    let tag = plain.headers()[header::ETAG].to_str().unwrap().to_owned();
    let plain = plain.into_body().collect().await.unwrap().to_bytes();
    let list: Value = serde_json::from_slice(&plain).unwrap();
    for coding in ["br", "gzip"] {
        let response = client
            .get(
                "/api/v1/market?view=list&hours=all",
                &[("accept-encoding", coding)],
            )
            .await;
        assert_eq!(response.status(), StatusCode::OK);
        let headers = response.headers().clone();
        assert_eq!(headers[header::CONTENT_ENCODING], coding);
        assert_eq!(headers[header::CACHE_CONTROL], "private, no-cache");
        assert_eq!(headers[header::VARY], "accept-encoding");
        assert_eq!(headers[header::ETAG], tag.as_str());
        let body = response.into_body().collect().await.unwrap().to_bytes();
        let mut decoded = Vec::new();
        if coding == "br" {
            brotli::Decompressor::new(&body[..], 4096)
                .read_to_end(&mut decoded)
                .unwrap();
        } else {
            flate2::read::GzDecoder::new(&body[..])
                .read_to_end(&mut decoded)
                .unwrap();
        }
        assert_eq!(decoded, plain, "{coding}");
    }
    let unchanged = client
        .get(
            "/api/v1/market?view=list&hours=all",
            &[("if-none-match", &tag)],
        )
        .await;
    assert_eq!(unchanged.status(), StatusCode::NOT_MODIFIED);
    assert_eq!(
        unchanged.headers()[header::CACHE_CONTROL],
        "private, no-cache"
    );

    let rows = json_body(
        client
            .get(
                "/api/v1/market?view=list&hours=all&ids=4999999,4010001",
                &[],
            )
            .await,
    )
    .await;
    assert_eq!(rows["as_of"], list["as_of"]);
    assert_eq!(rows["products"], json!([list["products"][0].clone()]));
    assert_eq!(rows["removed"], json!([4999999]));
    let none = json_body(client.get("/api/v1/market?view=list&ids=", &[]).await).await;
    assert_eq!(
        (none["products"].clone(), none["removed"].clone()),
        (json!([]), json!([]))
    );
    let many: Vec<String> = (0..201).map(|n| (4_000_000 + n).to_string()).collect();
    for bad in [many.join(","), "4010001,x".into(), "4010001,".into()] {
        let response = client
            .get(&format!("/api/v1/market?view=list&ids={bad}"), &[])
            .await;
        assert_eq!(response.status(), StatusCode::BAD_REQUEST, "{bad}");
    }
    let max = client
        .get(
            &format!("/api/v1/market?view=list&ids={}", many[..200].join(",")),
            &[],
        )
        .await;
    assert_eq!(max.status(), StatusCode::OK);
    db.close().await;
}

#[tokio::test]
async fn cached_market_reads_do_not_spend_the_read_limit() {
    let Some(db) = TestDb::new().await else {
        return;
    };
    let (client, _) = market(&db).await;
    let ip = [("cf-connecting-ip", "203.0.113.9")];
    let first = client.get("/api/v1/market?view=list", &ip).await;
    assert_eq!(first.status(), StatusCode::OK);
    let tag = first.headers()[header::ETAG].to_str().unwrap().to_owned();
    assert_eq!(
        client.get("/api/v1/market/overview", &ip).await.status(),
        StatusCode::OK
    );
    // Each market event makes every open page refresh: hits, 304s, rows and
    // the overview come from memory and have their own, wider budget.
    for n in 0..100 {
        let path = [
            "/api/v1/market?view=list",
            "/api/v1/market?view=list&ids=4010001",
            "/api/v1/market/overview",
        ][n % 3];
        assert_eq!(
            client.get(path, &ip).await.status(),
            StatusCode::OK,
            "{n} {path}"
        );
        let revalidated = client
            .get(
                "/api/v1/market?view=list",
                &[ip[0], ("if-none-match", &tag)],
            )
            .await;
        assert_eq!(revalidated.status(), StatusCode::NOT_MODIFIED, "{n}");
    }
    // Uncached reads keep the old limit: two of 60 were spent above.
    let mut allowed = 0;
    while client
        .get("/api/v1/market?item_id=4010001", &ip)
        .await
        .status()
        == StatusCode::OK
    {
        allowed += 1;
        assert!(allowed <= 60);
    }
    assert_eq!(allowed, 58);
    assert_eq!(
        client
            .get("/api/v1/market?item_id=4010001", &ip)
            .await
            .status(),
        StatusCode::TOO_MANY_REQUESTS
    );
    // The cached budget is bounded too.
    let mut cached = 200;
    while client.get("/api/v1/market?view=list", &ip).await.status() == StatusCode::OK {
        cached += 1;
        assert!(cached <= 600);
    }
    assert_eq!(cached, 600);
    db.close().await;
}

#[tokio::test]
async fn market_events_name_the_uploaded_items() {
    let Some(db) = TestDb::new().await else {
        return;
    };
    let (client, token) = market(&db).await;
    let state = client.state.clone();
    let mut ready = state.events.subscribe();
    let listener = tokio::spawn(market_web::realtime::listen(
        state.db.clone(),
        state.events.clone(),
        state.collector_updates.clone(),
        state.account_events.clone(),
    ));
    tokio::time::timeout(std::time::Duration::from_secs(5), ready.recv())
        .await
        .unwrap()
        .unwrap();
    let mut body = client.get("/api/v1/events", &[]).await.into_body();
    async fn next(body: &mut Body) -> String {
        let frame = tokio::time::timeout(std::time::Duration::from_secs(5), body.frame())
            .await
            .unwrap();
        String::from_utf8(frame.unwrap().unwrap().into_data().unwrap().to_vec()).unwrap()
    }
    assert!(
        next(&mut body).await.contains("data: {}"),
        "connecting revalidates everything"
    );
    // Another shop, so the first shop's listings stay as they were.
    let mut other = observation("live-ids", unix_now() - 5.0, 4);
    other["shop_id"] = json!(8);
    other["items"][0]["item_id"] = json!(4010002);
    let response = client
        .post(
            "/api/v1/observations",
            &other,
            &[("authorization", &format!("Bearer {token}"))],
        )
        .await;
    assert_eq!(response.status(), StatusCode::CREATED);
    let event = next(&mut body).await;
    assert!(
        event.contains("event: market") && event.contains(r#"data: {"ids":[4010002]}"#),
        "{event}"
    );
    state.events.send(None).unwrap();
    assert!(next(&mut body).await.contains("data: {}"));
    listener.abort();
    db.close().await;
}

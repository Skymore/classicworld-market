//! `/api/v1/collector/alerts` against Postgres: a reference market from one
//! collector, a cheap listing from another, and the alert only the second
//! one sees. Expected figures come from `market_views.opportunities` on the
//! same market (see the comments at the assertions).

mod common;

use axum::{
    body::Body,
    http::{header, Request, Response, StatusCode},
};
use common::TestDb;
use http_body_util::BodyExt;
use market_web::{alerts, app, auth::Collector, unix_now, views::Hours, AppState, Settings};
use serde_json::{json, Value};
use tower::ServiceExt;

const ORE: i64 = 4_010_001;

struct Client {
    state: AppState,
}

impl Client {
    async fn send(&self, request: Request<Body>) -> Response<Body> {
        app(self.state.clone()).oneshot(request).await.unwrap()
    }

    async fn register(&self) -> String {
        let response = self
            .send(
                Request::post("/api/v1/register")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await;
        assert_eq!(response.status(), StatusCode::CREATED);
        json_body(response).await["token"]
            .as_str()
            .unwrap()
            .to_string()
    }

    async fn upload(&self, token: &str, body: Value) {
        let request = Request::post("/api/v1/observations")
            .header(header::CONTENT_TYPE, "application/json")
            .header(header::AUTHORIZATION, format!("Bearer {token}"))
            .body(Body::from(body.to_string()))
            .unwrap();
        assert_eq!(self.send(request).await.status(), StatusCode::CREATED);
    }

    async fn alerts(&self, query: &str, auth: Option<(&str, String)>) -> Response<Body> {
        let mut request = Request::get(format!("/api/v1/collector/alerts{query}"));
        if let Some((name, value)) = auth {
            request = request.header(name, value);
        }
        self.send(request.body(Body::empty()).unwrap()).await
    }
}

async fn json_body(response: Response<Body>) -> Value {
    let bytes = response.into_body().collect().await.unwrap().to_bytes();
    serde_json::from_slice(&bytes).unwrap()
}

fn shop(id: &str, shop_id: i64, room: i64, observed: f64, price: i64, stock: i64) -> Value {
    json!({
        "version": 1, "world": "ClassicWorld", "complete": true, "observation_id": id,
        "observed_at": observed, "shop_id": shop_id, "title": format!("Shop {shop_id}"),
        "location": {"channel": 2, "room": room},
        "items": [{"item_id": ORE, "category": 4, "slot": 1, "price": price, "bundle": 1, "stock": stock}]
    })
}

/// Ten shops asking 100..=190 ten minutes ago, and an eleventh that sold out
/// at 80 in between. The reference collector uploads all of them.
async fn reference_market(client: &Client, now: f64) {
    let token = client.register().await;
    for k in 0..10 {
        let body = shop(
            &format!("ref-{k}"),
            100 + k,
            k + 1,
            now - 600.0,
            100 + 10 * k,
            2,
        );
        client.upload(&token, body).await;
    }
    client
        .upload(&token, shop("sold-a", 200, 20, now - 900.0, 80, 2))
        .await;
    client
        .upload(&token, shop("sold-b", 200, 20, now - 540.0, 80, 0))
        .await;
}

fn bearer(token: &str) -> Option<(&'static str, String)> {
    Some(("authorization", format!("Bearer {token}")))
}

#[tokio::test]
async fn authenticated_history_location_repair_preserves_quotes_and_merges_shop() {
    let Some(db) = TestDb::new().await else {
        return;
    };
    let client = Client {
        state: AppState::new(db.pool.clone(), Settings::default()),
    };
    let owner = client.register().await;
    let other = client.register().await;
    let now = unix_now();
    let mut old = shop("history-missing", 1234, 7, now - 3600.0, 100, 10);
    old["location"] = Value::Null;
    client.upload(&owner, old.clone()).await;
    let mut known = shop("history-known", 1234, 7, now - 60.0, 100, 9);
    known["location"]["channel"] = json!(33);
    client.upload(&owner, known).await;
    let before:Vec<(i64,i32,i64,i32,i32)>=sqlx::query_as("SELECT observation_id,slot,price,bundle,stock FROM observation_rows ORDER BY observation_id,slot")
        .fetch_all(&db.pool).await.unwrap();
    let original_raw: Vec<u8> =
        sqlx::query_scalar("SELECT body FROM uploads_raw WHERE observation_id='history-missing'")
            .fetch_one(&db.pool)
            .await
            .unwrap();
    let pending = |token: &str| {
        Request::get("/api/v1/collector/missing-locations")
            .header(header::AUTHORIZATION, format!("Bearer {token}"))
            .body(Body::empty())
            .unwrap()
    };
    assert_eq!(
        client
            .send(
                Request::get("/api/v1/collector/missing-locations")
                    .body(Body::empty())
                    .unwrap()
            )
            .await
            .status(),
        StatusCode::UNAUTHORIZED
    );
    assert_eq!(
        json_body(client.send(pending(&other)).await).await["observations"],
        json!([])
    );
    assert_eq!(
        json_body(client.send(pending(&owner)).await).await["observations"],
        json!(["history-missing"])
    );
    let mut fixed = old.clone();
    fixed["location"] = json!({"channel":33,"room":7});
    fixed["map_context"] = json!({"channel":33,"map_id":80002007});
    let request = |token: &str, b: &Value| {
        Request::post("/api/v1/collector/repair-location")
            .header(header::AUTHORIZATION, format!("Bearer {token}"))
            .header(header::CONTENT_TYPE, "application/json")
            .body(Body::from(b.to_string()))
            .unwrap()
    };
    assert_eq!(
        json_body(client.send(request(&other, &fixed)).await).await["repaired"],
        false
    );
    for field in ["price", "stock", "bundle"] {
        let mut tampered = fixed.clone();
        tampered["items"][0][field] = json!(999);
        assert_eq!(
            client.send(request(&owner, &tampered)).await.status(),
            StatusCode::CONFLICT
        );
    }
    let mut tampered = fixed.clone();
    tampered["observed_at"] = json!(now);
    assert_eq!(
        client.send(request(&owner, &tampered)).await.status(),
        StatusCode::CONFLICT
    );
    let mut tampered = fixed.clone();
    tampered["map_context"]["channel"] = json!(12);
    assert_eq!(
        client.send(request(&owner, &tampered)).await.status(),
        StatusCode::CONFLICT
    );
    let response = client.send(request(&owner, &fixed)).await;
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(json_body(response).await["repaired"], true);
    let contributions: (i64, i64) =
        sqlx::query_as("SELECT count(DISTINCT shop_id),count(*) FROM contribution_states")
            .fetch_one(&db.pool)
            .await
            .unwrap();
    assert_eq!(
        contributions,
        (1, 2),
        "location repair merges the contribution shop without losing its two stock states"
    );
    assert_eq!(
        json_body(client.send(request(&owner, &fixed)).await).await["repaired"],
        false
    );
    assert_eq!(
        json_body(client.send(pending(&owner)).await).await["observations"],
        json!([])
    );
    let after:Vec<(i64,i32,i64,i32,i32)>=sqlx::query_as("SELECT observation_id,slot,price,bundle,stock FROM observation_rows ORDER BY observation_id,slot")
        .fetch_all(&db.pool).await.unwrap();
    assert_eq!(before, after);
    assert_eq!(
        sqlx::query_scalar::<_, Vec<u8>>(
            "SELECT body FROM uploads_raw WHERE observation_id='history-missing'"
        )
        .fetch_one(&db.pool)
        .await
        .unwrap(),
        original_raw
    );
    assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT count(*) FROM observations")
            .fetch_one(&db.pool)
            .await
            .unwrap(),
        2
    );
    assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT count(*) FROM shops")
            .fetch_one(&db.pool)
            .await
            .unwrap(),
        1
    );
    assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT count(*) FROM listings")
            .fetch_one(&db.pool)
            .await
            .unwrap(),
        1
    );
    assert_eq!(
        sqlx::query_scalar::<_, i32>("SELECT stock FROM listings")
            .fetch_one(&db.pool)
            .await
            .unwrap(),
        9
    );
    assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT count(*) FROM sales WHERE kind='drop' AND quantity=1")
            .fetch_one(&db.pool)
            .await
            .unwrap(),
        1
    );
    assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT count(*) FROM observation_location_repairs")
            .fetch_one(&db.pool)
            .await
            .unwrap(),
        1
    );
    // Original retries remain idempotent; later attempts cannot move known locations.
    let retry = Request::post("/api/v1/observations")
        .header(header::AUTHORIZATION, format!("Bearer {owner}"))
        .body(Body::from(old.to_string()))
        .unwrap();
    assert_eq!(json_body(client.send(retry).await).await["duplicate"], true);
    fixed["location"]["channel"] = json!(34);
    fixed["map_context"]["channel"] = json!(34);
    assert_eq!(
        client.send(request(&owner, &fixed)).await.status(),
        StatusCode::CONFLICT
    );
    db.close().await;
}

#[tokio::test]
async fn extended_packet_channels_are_uploaded_stored_and_returned() {
    let Some(db) = TestDb::new().await else {
        return;
    };
    let client = Client {
        state: AppState::new(db.pool.clone(), Settings::default()),
    };
    let token = client.register().await;
    let now = unix_now();
    let expected = vec![12, 18, 19, 20, 21, 33, 40, 60, 255];
    for &channel in &expected {
        let mut body = shop(
            &format!("channel-{channel}"),
            800 + channel,
            7,
            now - 5.0,
            100,
            1,
        );
        body["location"]["channel"] = json!(channel);
        body["map_context"] = json!({"channel":channel,"map_id":80002007});
        client.upload(&token, body).await;
    }
    let data = market_web::views::watch_listings(&db.pool, &[ORE as i32], now)
        .await
        .unwrap();
    let mut actual: Vec<i64> = data["listings"]
        .as_array()
        .unwrap()
        .iter()
        .map(|row| row["location"]["channel"].as_i64().unwrap())
        .collect();
    actual.sort();
    assert_eq!(actual, expected);
    let stored: Vec<i16> =
        sqlx::query_scalar("SELECT map_channel FROM observations ORDER BY map_channel")
            .fetch_all(&db.pool)
            .await
            .unwrap();
    assert_eq!(
        stored,
        expected.iter().map(|&ch| ch as i16).collect::<Vec<_>>()
    );
    db.close().await;
}

#[tokio::test]
async fn personal_watches_include_own_rescan_of_shared_offer_and_exclude_other_collectors() {
    let Some(db) = TestDb::new().await else {
        return;
    };
    let client = Client {
        state: AppState::new(db.pool.clone(), Settings::default()),
    };
    let a = client.register().await;
    let b = client.register().await;
    let c = client.register().await;
    let now = unix_now();
    client
        .upload(&a, shop("shared-first", 700, 1, now - 15.0, 50, 1))
        .await;
    client
        .upload(&b, shop("my-rescan", 700, 1, now - 5.0, 50, 1))
        .await;
    let equipment = json!({"version":1,"world":"ClassicWorld","complete":true,"observation_id":"own-equip","observed_at":now-4.0,"shop_id":701,"title":"Equipment","items":[{"item_id":1452003,"slot":1,"price":100,"bundle":1,"stock":1,"equipment":{"status":"candidate","stats":[{"key":"weapon_attack","value":49}],"remaining_upgrades":7}}]});
    client.upload(&b, equipment).await;
    let url = format!("/api/v1/collector/watch-listings?ids={ORE},1452003");
    let response = client
        .send(Request::get(&url).body(Body::empty()).unwrap())
        .await;
    assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
    let read = |token: String| {
        let client = &client;
        let url = &url;
        async move {
            json_body(
                client
                    .send(
                        Request::get(url)
                            .header("authorization", format!("Bearer {token}"))
                            .body(Body::empty())
                            .unwrap(),
                    )
                    .await,
            )
            .await
        }
    };
    let mine = read(b).await;
    let other = read(c).await;
    assert_eq!(mine["listings"].as_array().unwrap().len(), 2, "{mine}");
    assert!(other["listings"].as_array().unwrap().is_empty());
    let bow = mine["listings"]
        .as_array()
        .unwrap()
        .iter()
        .find(|v| v["item_id"] == 1452003)
        .unwrap();
    assert_eq!(bow["equipment"]["stats"][0]["value"], 49);
    db.close().await;
}

#[tokio::test]
async fn a_cheap_listing_alerts_its_collector_only() {
    let Some(db) = TestDb::new().await else {
        return;
    };
    let client = Client {
        state: AppState::new(db.pool.clone(), Settings::default()),
    };
    let now = unix_now();
    reference_market(&client, now).await;
    let buyer = client.register().await;
    let cheap = json!({
        "version": 1, "world": "ClassicWorld", "complete": true, "observation_id": "cheap",
        "observed_at": now - 5.0, "shop_id": 7, "title": "Cheap", "location": null,
        "items": [
            {"item_id": ORE, "category": 4, "slot": 1, "price": 50, "bundle": 1, "stock": 1},
            {"item_id": ORE, "category": 4, "slot": 2, "price": 120, "bundle": 1, "stock": 3},
            {"item_id": 1452003, "category": 1, "slot": 3, "price": 5, "bundle": 1, "stock": 1}
        ]
    });
    client.upload(&buyer, cheap).await;

    let response = client.alerts("?hours=72", bearer(&buyer)).await;
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(response.headers()[header::CACHE_CONTROL], "no-store");
    let body = json_body(response).await;
    assert_eq!(body["personal_alerts"], true);
    assert!(body["generated_at"].as_f64().unwrap() >= now);
    let deals = body["opportunities"].as_array().unwrap();
    // Only the 50-meso row: 120 is under q1 (122.5) but not 15 % below the
    // quick-sell price, and equipment never alerts.
    assert_eq!(deals.len(), 1, "{body}");
    let deal = &deals[0];
    // market_views.opportunities on the same market: asks 100..190 in ten
    // shops, one sold-out at 80 -> q1 122.5, quick sell 79, normal 109.
    for (key, expected) in [
        ("item_id", json!(ORE)),
        ("buy", json!(50.0)),
        ("bundle", json!(1)),
        ("bundle_cost", json!(50)),
        ("stock", json!(1)),
        ("q1", json!(122.5)),
        ("sell", json!(79.0)),
        ("fast_sell", json!(79.0)),
        ("normal_sell", json!(109.0)),
        ("profit", json!(26.63)),
        ("margin", json!(53.3)),
        ("normal_profit", json!(55.73)),
        ("normal_margin", json!(111.5)),
        ("shops", json!(10)),
        ("listing_count", json!(10)),
        ("listed_quantity", json!(20)),
        ("fee_percent", json!(3)),
        ("pricing_version", json!(2)),
        ("shop", json!("Cheap")),
        ("location", Value::Null),
    ] {
        assert_eq!(deal[key], expected, "{key}: {deal}");
    }
    assert_eq!(
        deal["id"],
        r#"["ClassicWorld", "shared", 0, 7, "Cheap"]:4001:4010001:50.0"#
    );
    assert_eq!(deal.as_object().unwrap().len(), 25);

    // Everything else in the shared market is someone else's discovery.
    let seller = client.register().await;
    let theirs = json_body(client.alerts("", bearer(&seller)).await).await;
    assert_eq!(theirs["opportunities"], json!([]));
    // ?hours=all compares with every record; same market here.
    let all = json_body(client.alerts("?hours=all", bearer(&buyer)).await).await;
    assert_eq!(all["opportunities"][0]["margin"], 53.3);
    db.close().await;
}

#[tokio::test]
async fn token_window_and_limits() {
    let Some(db) = TestDb::new().await else {
        return;
    };
    let client = Client {
        state: AppState::new(db.pool.clone(), Settings::default()),
    };
    let token = client.register().await;
    for auth in [
        None,
        bearer("not-a-real-token-but-long-enough-xx"),
        // The reader cookie does not identify a collector.
        Some(("cookie", format!("fm_session={token}"))),
    ] {
        let response = client.alerts("", auth).await;
        assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
        assert_eq!(
            json_body(response).await["error"],
            "Collector token required"
        );
    }
    let bad = client.alerts("?hours=24", bearer(&token)).await;
    assert_eq!(bad.status(), StatusCode::BAD_REQUEST);
    assert_eq!(json_body(bad).await["error"], "hours must be 72 or all");
    // 60 a minute per collector, the 400 above included.
    for _ in 0..59 {
        assert_eq!(
            client.alerts("", bearer(&token)).await.status(),
            StatusCode::OK
        );
    }
    let limited = client.alerts("", bearer(&token)).await;
    assert_eq!(limited.status(), StatusCode::TOO_MANY_REQUESTS);
    db.close().await;
}

#[tokio::test]
async fn candidates_are_received_in_the_last_two_minutes() {
    let Some(db) = TestDb::new().await else {
        return;
    };
    let client = Client {
        state: AppState::new(db.pool.clone(), Settings::default()),
    };
    let now = unix_now();
    reference_market(&client, now).await;
    let token = client.register().await;
    client
        .upload(&token, shop("cheap", 300, 22, now - 5.0, 50, 1))
        .await;
    let id: i64 = sqlx::query_scalar("SELECT id FROM collectors ORDER BY id DESC LIMIT 1")
        .fetch_one(&db.pool)
        .await
        .unwrap();
    let public_id: String = sqlx::query_scalar("SELECT public_id FROM collectors WHERE id = $1")
        .bind(id)
        .fetch_one(&db.pool)
        .await
        .unwrap();
    let collector = Collector { id, public_id };
    let found = alerts::personal_alerts(&db.pool, &collector, Hours::Recent, now + 60.0)
        .await
        .unwrap();
    assert_eq!(found.len(), 1);
    assert_eq!(
        found[0].location,
        json!({"channel": 2, "room": 22, "map_id": 80_002_022})
    );
    let later = alerts::personal_alerts(&db.pool, &collector, Hours::Recent, now + 130.0)
        .await
        .unwrap();
    assert!(later.is_empty());
    db.close().await;
}

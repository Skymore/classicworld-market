#[path = "bestiary_common/mod.rs"]
mod common;

use axum::{
    body::Body,
    extract::ConnectInfo,
    http::{Request, StatusCode},
};
use http_body_util::BodyExt;
use market_web::{app, AppState, Settings};
use serde_json::{json, Value};
use sqlx::postgres::PgPoolOptions;
use std::net::SocketAddr;
use tower::ServiceExt;

fn state() -> AppState {
    AppState::new(
        PgPoolOptions::new()
            .connect_lazy("postgres://nobody@127.0.0.1:1/none")
            .unwrap(),
        Settings::default(),
    )
}
fn local_get(path: &str) -> Request<Body> {
    Request::get(path)
        .header("host", "127.0.0.1:8766")
        .extension(ConnectInfo("127.0.0.1:4321".parse::<SocketAddr>().unwrap()))
        .body(Body::empty())
        .unwrap()
}
fn payload(id: char, visitor: char, path: &str) -> Value {
    json!({"event_id":id.to_string().repeat(32),"visitor":visitor.to_string().repeat(32),
        "path":path,"device":"phone","referrer":"https://search.example/results?q=private#secret"})
}
fn post(value: Value) -> Request<Body> {
    Request::post("/api/v1/traffic/event")
        .header("origin", "https://mxd.ruit.me")
        .header("content-type", "application/json")
        .header("user-agent", "Mozilla/5.0")
        .body(Body::from(value.to_string()))
        .unwrap()
}

#[tokio::test]
async fn dashboard_is_loopback_only_even_when_tunnel_peer_is_local() {
    let router = app(state());
    let response = router.clone().oneshot(local_get("/traffic")).await.unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(response.headers()["cache-control"], "no-store");
    assert_eq!(response.headers()["x-frame-options"], "DENY");
    for path in ["/traffic", "/api/v1/traffic/summary"] {
        for (host, forwarded, peer) in [
            ("mxd.ruit.me", false, "127.0.0.1:1234"),
            ("localhost:8766", true, "127.0.0.1:1234"),
            ("127.0.0.1:8766", false, "192.168.1.2:1234"),
        ] {
            let mut request = Request::get(path)
                .header("host", host)
                .extension(ConnectInfo(peer.parse::<SocketAddr>().unwrap()))
                .body(Body::empty())
                .unwrap();
            if forwarded {
                request
                    .headers_mut()
                    .insert("cf-connecting-ip", "203.0.113.1".parse().unwrap());
            }
            assert_eq!(
                router.clone().oneshot(request).await.unwrap().status(),
                StatusCode::NOT_FOUND
            );
        }
        let request = Request::get(path)
            .header("host", "localhost:8766")
            .body(Body::empty())
            .unwrap();
        assert_eq!(
            router.clone().oneshot(request).await.unwrap().status(),
            StatusCode::NOT_FOUND,
            "a Host header alone is not authorization"
        );
    }
}

#[tokio::test]
async fn bots_privacy_signals_invalid_origins_and_unrecognized_paths_never_touch_database() {
    let router = app(state());
    for signal in ["dnt", "sec-gpc"] {
        let mut request = post(payload('a', 'b', "/"));
        request.headers_mut().insert(signal, "1".parse().unwrap());
        assert_eq!(
            router.clone().oneshot(request).await.unwrap().status(),
            StatusCode::NO_CONTENT
        );
    }
    let mut bot = post(payload('a', 'b', "/"));
    bot.headers_mut()
        .insert("user-agent", "Googlebot".parse().unwrap());
    assert_eq!(
        router.clone().oneshot(bot).await.unwrap().status(),
        StatusCode::NO_CONTENT
    );
    let mut foreign = post(payload('a', 'b', "/"));
    foreign
        .headers_mut()
        .insert("origin", "https://evil.example".parse().unwrap());
    assert_eq!(
        router.clone().oneshot(foreign).await.unwrap().status(),
        StatusCode::FORBIDDEN
    );
    assert_eq!(
        router
            .clone()
            .oneshot(post(payload('a', 'b', "/unknown")))
            .await
            .unwrap()
            .status(),
        StatusCode::NO_CONTENT
    );
    assert_eq!(
        router
            .clone()
            .oneshot(post(payload('z', 'b', "/")))
            .await
            .unwrap()
            .status(),
        StatusCode::BAD_REQUEST
    );
    let mut private = state();
    private.settings = std::sync::Arc::new(Settings {
        public_read: false,
        ..Settings::default()
    });
    assert_eq!(
        app(private)
            .oneshot(post(payload('a', 'b', "/")))
            .await
            .unwrap()
            .status(),
        StatusCode::NO_CONTENT
    );
}

#[tokio::test]
async fn pageviews_deduplicate_events_hash_visitors_strip_secrets_and_fill_empty_dates() {
    let Some(db) = common::test_db().await else {
        return;
    };
    let router = app(AppState::new(db.pool.clone(), Settings::default()));
    for input in [
        payload('1', 'a', "/item/2000000?q=secret#hidden"),
        payload('1', 'a', "/item/2000000"),
        payload('2', 'a', "/agent/private-conversation"),
        payload('3', 'b', "/"),
    ] {
        assert_eq!(
            router.clone().oneshot(post(input)).await.unwrap().status(),
            StatusCode::NO_CONTENT
        );
    }
    let stored: Vec<(String, String, Vec<u8>)> =
        sqlx::query_as("SELECT path,source,visitor_hash FROM site_pageviews ORDER BY event_id")
            .fetch_all(&db.pool)
            .await
            .unwrap();
    assert_eq!(stored.len(), 3);
    assert_eq!(stored[0].0, "/item/2000000");
    assert_eq!(stored[1].0, "/agent");
    assert!(stored
        .iter()
        .all(|row| row.1 == "search.example" && row.2.len() == 32));
    assert_eq!(stored[0].2, stored[1].2);
    assert_ne!(stored[1].2, stored[2].2);
    let response = router
        .clone()
        .oneshot(local_get("/api/v1/traffic/summary?days=7"))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let report: Value =
        serde_json::from_slice(&response.into_body().collect().await.unwrap().to_bytes()).unwrap();
    assert_eq!(report["today"], json!({"pageviews":3,"visitors":2}));
    assert_eq!(report["daily"].as_array().unwrap().len(), 7);
    assert_eq!(report["daily"][0]["pageviews"], 0);
    assert_eq!(report["daily_visitors"], 2);
    // A distinct day gets its own UV; period UV is explicitly a daily sum.
    sqlx::query("INSERT INTO site_pageviews(event_id,day,visitor_hash,path,source,device) SELECT repeat('4',32),day-1,visitor_hash,'/','','desktop' FROM site_pageviews LIMIT 1").execute(&db.pool).await.unwrap();
    let report = market_web::traffic::report(&db.pool, 7).await.unwrap();
    assert_eq!(report["pageviews"], 4);
    assert_eq!(report["daily_visitors"], 3);
    // Only domains, and no local referrer, should be retained.
    for (id, source) in [
        ('5', "https://mxd.ruit.me/account?token=secret"),
        ('6', "https://192.168.1.2/private"),
        ('7', "javascript:alert(1)"),
    ] {
        let mut input = payload(id, 'a', "/");
        input["referrer"] = json!(source);
        assert_eq!(
            router.clone().oneshot(post(input)).await.unwrap().status(),
            StatusCode::NO_CONTENT
        );
    }
    let empty: i64 = sqlx::query_scalar("SELECT count(*) FROM site_pageviews WHERE source=''")
        .fetch_one(&db.pool)
        .await
        .unwrap();
    assert_eq!(empty, 4);
    // Rate limits apply to this endpoint without exhausting market API limits.
    for _ in 0..113 {
        let _ = router
            .clone()
            .oneshot(post(payload('8', 'a', "/")))
            .await
            .unwrap();
    }
    assert_eq!(
        router
            .oneshot(post(payload('9', 'a', "/")))
            .await
            .unwrap()
            .status(),
        StatusCode::TOO_MANY_REQUESTS
    );
    db.drop_schema().await;
}

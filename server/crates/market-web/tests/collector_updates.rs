mod common;
use axum::{body::Body, http::Request};
use common::TestDb;
use http_body_util::BodyExt;
use market_web::{app, collector_updates::stable_tag, realtime, AppState, Settings};
use std::time::Duration;
use tower::ServiceExt;

#[test]
fn release_hints_accept_only_short_stable_tags() {
    for tag in ["v0.5.8", "v1.0.0"] {
        assert!(stable_tag(tag));
    }
    for tag in [
        "v0.5.8-beta",
        "https://evil.example/run",
        "v1.2",
        "v1.2.3333333",
        "v1.2.-3",
    ] {
        assert!(!stable_tag(tag));
    }
}

#[tokio::test]
async fn committed_release_notice_reaches_existing_and_reconnecting_collectors() {
    let Some(db) = TestDb::new().await else {
        return;
    };
    let state = AppState::new(db.pool.clone(), Settings::default());
    let mut market = state.events.subscribe();
    let listener = tokio::spawn(realtime::listen(
        state.db.clone(),
        state.events.clone(),
        state.collector_updates.clone(),
    ));
    tokio::time::timeout(Duration::from_secs(5), market.recv())
        .await
        .unwrap()
        .unwrap();
    let response = app(state.clone())
        .oneshot(
            Request::builder()
                .uri("/api/v1/collector/updates")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), 200);
    assert_eq!(response.headers()["cache-control"], "no-cache");
    assert_eq!(response.headers()["x-accel-buffering"], "no");
    let mut body = response.into_body();
    let frame = body.frame().await.unwrap().unwrap().into_data().unwrap();
    assert!(String::from_utf8_lossy(&frame).contains("\"version\":null"));
    sqlx::query("SELECT pg_notify('collector_update', 'v0.5.8')")
        .execute(&db.pool)
        .await
        .unwrap();
    let frame = tokio::time::timeout(Duration::from_secs(3), body.frame())
        .await
        .unwrap()
        .unwrap()
        .unwrap()
        .into_data()
        .unwrap();
    let text = String::from_utf8_lossy(&frame);
    assert!(text.contains("event: collector-update"));
    assert!(text.contains("v0.5.8"));
    assert!(
        market.try_recv().is_err(),
        "release notices must not refresh market pages"
    );
    let response = app(state.clone())
        .oneshot(
            Request::builder()
                .uri("/api/v1/collector/updates")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    let frame = response
        .into_body()
        .frame()
        .await
        .unwrap()
        .unwrap()
        .into_data()
        .unwrap();
    assert!(String::from_utf8_lossy(&frame).contains("v0.5.8"));
    sqlx::query("SELECT pg_notify('collector_update', 'v0.5.8')")
        .execute(&db.pool)
        .await
        .unwrap();
    assert!(
        tokio::time::timeout(Duration::from_millis(150), body.frame())
            .await
            .is_err(),
        "duplicate notices are coalesced"
    );
    drop(body);
    listener.abort();
    let _ = listener.await;
    drop(state);
    db.close().await;
}

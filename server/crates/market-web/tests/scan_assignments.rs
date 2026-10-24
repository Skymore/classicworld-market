mod common;
use axum::{
    body::Body,
    http::{Request, StatusCode},
};
use common::TestDb;
use http_body_util::BodyExt;
use market_web::{app, auth, AppState, Settings};
use serde_json::{json, Value};
use tower::ServiceExt;
async fn call(s: &AppState, token: &str, action: &str, body: Value) -> (StatusCode, Value) {
    let response = app(s.clone())
        .oneshot(
            Request::post(format!("/api/v1/scanner/{action}"))
                .header("content-type", "application/json")
                .header("authorization", format!("Bearer {token}"))
                .body(Body::from(body.to_string()))
                .unwrap(),
        )
        .await
        .unwrap();
    let status = response.status();
    let bytes = response.into_body().collect().await.unwrap().to_bytes();
    (status, serde_json::from_slice(&bytes).unwrap())
}
#[tokio::test]
async fn leases_exclude_other_workers_and_fence_disconnected_sessions() {
    let Some(db) = TestDb::new().await else {
        return;
    };
    let s = AppState::new(db.pool.clone(), Settings::default());
    let a = auth::register(&db.pool, "scanner a").await.unwrap();
    let b = auth::register(&db.pool, "scanner b").await.unwrap();
    let session = json!({"session_id":"aaaaaaaaaaaaaaaa"});
    assert_eq!(
        call(&s, "bad", "claim", session.clone()).await.0,
        StatusCode::UNAUTHORIZED
    );
    let (one, two) = tokio::join!(
        call(&s, &a.token, "claim", session.clone()),
        call(&s, &b.token, "claim", session.clone())
    );
    assert_eq!(one.0, StatusCode::OK);
    assert_eq!(two.0, StatusCode::OK);
    assert_ne!(one.1["assignment"]["room"], two.1["assignment"]["room"]);
    let repeat = call(&s, &a.token, "claim", session.clone()).await;
    assert_eq!(
        one.1["assignment"]["lease_id"],
        repeat.1["assignment"]["lease_id"]
    );
    assert_eq!(
        call(
            &s,
            &a.token,
            "claim",
            json!({"session_id":"bbbbbbbbbbbbbbbb"})
        )
        .await
        .0,
        StatusCode::CONFLICT
    );
    let old = json!({"session_id":"aaaaaaaaaaaaaaaa","lease_id":one.1["assignment"]["lease_id"],"channel":12});
    assert_eq!(
        call(&s, &b.token, "heartbeat", old.clone()).await.0,
        StatusCode::CONFLICT
    );
    assert_eq!(
        call(&s, &a.token, "heartbeat", old.clone()).await.0,
        StatusCode::OK
    );
    sqlx::query("UPDATE scan_rooms SET expires_at=clock_timestamp()-interval '1 second' WHERE collector_id=(SELECT id FROM collectors WHERE public_id=$1)")
        .bind(&a.public_id).execute(&db.pool).await.unwrap();
    assert_eq!(
        call(&s, &a.token, "heartbeat", old.clone()).await.0,
        StatusCode::CONFLICT
    );
    let fresh = call(
        &s,
        &a.token,
        "claim",
        json!({"session_id":"bbbbbbbbbbbbbbbb"}),
    )
    .await;
    assert_eq!(fresh.0, StatusCode::OK);
    assert_eq!(one.1["assignment"]["room"], fresh.1["assignment"]["room"]);
    assert_ne!(
        one.1["assignment"]["lease_id"],
        fresh.1["assignment"]["lease_id"]
    );
    for action in ["complete", "release", "heartbeat"] {
        assert_eq!(
            call(&s, &a.token, action, old.clone()).await.0,
            StatusCode::CONFLICT
        );
    }
    let current =
        json!({"session_id":"bbbbbbbbbbbbbbbb","lease_id":fresh.1["assignment"]["lease_id"]});
    assert_eq!(
        call(&s, &a.token, "complete", current.clone()).await.0,
        StatusCode::OK
    );
    assert_eq!(
        call(&s, &a.token, "complete", current).await.0,
        StatusCode::CONFLICT
    );
    let next = call(
        &s,
        &a.token,
        "claim",
        json!({"session_id":"bbbbbbbbbbbbbbbb"}),
    )
    .await;
    assert_ne!(next.1["assignment"]["room"], fresh.1["assignment"]["room"]);
    db.close().await;
}

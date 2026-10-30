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
    s.scan_db.close().await;
    db.close().await;
}

#[tokio::test]
async fn task_lease_survives_exhausted_market_pool() {
    let Some(db) = TestDb::new().await else {
        return;
    };
    let s = AppState::new(db.pool.clone(), Settings::default());
    let collector = auth::register(&db.pool, "busy market scanner")
        .await
        .unwrap();
    // Hold every connection used by market pages and ingestion. Claim and
    // authentication must also use the reserved pool, not just heartbeat SQL.
    let mut held = Vec::new();
    for _ in 0..4 {
        held.push(db.pool.acquire().await.unwrap());
    }
    let scenario = async {
        let session = json!({"session_id":"cccccccccccccccc"});
        let (status, claimed) = call(&s, &collector.token, "claim", session).await;
        assert_eq!(status, StatusCode::OK);
        let lease = json!({"session_id":"cccccccccccccccc", "lease_id":claimed["assignment"]["lease_id"], "channel":14});
        assert_eq!(
            call(&s, &collector.token, "heartbeat", lease.clone())
                .await
                .0,
            StatusCode::OK
        );
        assert_eq!(
            call(&s, &collector.token, "release", lease.clone()).await.0,
            StatusCode::OK
        );
        assert_eq!(
            call(&s, &collector.token, "heartbeat", lease).await.0,
            StatusCode::CONFLICT
        );
    };
    tokio::time::timeout(std::time::Duration::from_secs(2), scenario)
        .await
        .expect("market traffic must not block short task leases");
    drop(held);
    s.scan_db.close().await;
    db.close().await;
}

#[tokio::test]
async fn recovery_prefers_unfinished_room_but_never_steals_or_resumes_a_completed_round() {
    let Some(db) = TestDb::new().await else {
        return;
    };
    let s = AppState::new(db.pool.clone(), Settings::default());
    let a = auth::register(&db.pool, "resume a").await.unwrap();
    let b = auth::register(&db.pool, "resume b").await.unwrap();
    let session = json!({"session_id":"resume-session-aa"});
    // Let a take room 2 while room 1 is temporarily unavailable.
    sqlx::query("UPDATE scan_rooms SET enabled=false WHERE room=1")
        .execute(&db.pool)
        .await
        .unwrap();
    let first = call(&s, &a.token, "claim", session.clone()).await.1["assignment"].clone();
    assert_eq!(first["room"], 2);
    let hint =
        json!({"session_id":"resume-session-aa","resume_room":2,"resume_round":first["round_id"]});
    sqlx::query(
        "UPDATE scan_rooms SET expires_at=clock_timestamp()-interval '1 second' WHERE room=2",
    )
    .execute(&db.pool)
    .await
    .unwrap();
    sqlx::query("UPDATE scan_rooms SET enabled=true WHERE room=1")
        .execute(&db.pool)
        .await
        .unwrap();
    let recovered = call(&s, &a.token, "claim", hint.clone()).await.1["assignment"].clone();
    assert_eq!(
        recovered["room"], 2,
        "unfinished room wins over the normal room 1 order"
    );
    assert_eq!(recovered["round_id"], first["round_id"]);
    assert_ne!(recovered["lease_id"], first["lease_id"]);
    let old = json!({"session_id":"resume-session-aa","lease_id":first["lease_id"]});
    assert_eq!(
        call(&s, &a.token, "heartbeat", old).await.0,
        StatusCode::CONFLICT
    );
    // Another live owner cannot be displaced by a recovery hint.
    let other_hint =
        json!({"session_id":"resume-session-bb","resume_room":2,"resume_round":first["round_id"]});
    let other = call(&s, &b.token, "claim", other_hint).await.1["assignment"].clone();
    assert_eq!(other["room"], 1);
    let lease = json!({"session_id":"resume-session-aa","lease_id":recovered["lease_id"]});
    assert_eq!(
        call(&s, &a.token, "complete", lease).await.0,
        StatusCode::OK
    );
    let next = call(&s, &a.token, "claim", hint.clone()).await.1["assignment"].clone();
    assert_eq!(
        next["room"], 3,
        "completed round no longer gets recovery priority"
    );
    let release = json!({"session_id":"resume-session-aa","lease_id":next["lease_id"]});
    assert_eq!(
        call(&s, &a.token, "release", release).await.0,
        StatusCode::OK
    );
    sqlx::query("UPDATE scan_rooms SET enabled=(room=2)")
        .execute(&db.pool)
        .await
        .unwrap();
    let fresh = call(&s, &a.token, "claim", hint).await.1["assignment"].clone();
    assert_eq!(fresh["room"], 2);
    assert_ne!(
        fresh["round_id"], first["round_id"],
        "new round invalidates old channel checkpoint"
    );
    assert_eq!(
        call(
            &s,
            &a.token,
            "claim",
            json!({"session_id":"resume-session-aa","resume_room":99,"resume_round":"0"})
        )
        .await
        .0,
        StatusCode::BAD_REQUEST
    );
    s.scan_db.close().await;
    db.close().await;
}

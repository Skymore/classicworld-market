//! Admin-only views of every account's grind runs.
mod common;
use axum::{
    body::Body,
    http::{Request, StatusCode},
};
use common::TestDb;
use http_body_util::BodyExt;
use market_web::{app, contributors::GoogleOAuth, AppState, Settings};
use serde_json::{json, Value};
use tower::ServiceExt;

async fn send(s: &AppState, path: &str, cookie: Option<&str>) -> (StatusCode, Value) {
    let mut req = Request::get(path);
    if let Some(cookie) = cookie {
        req = req.header("cookie", cookie);
    }
    let response = app(s.clone()).oneshot(req.body(Body::empty()).unwrap()).await.unwrap();
    let status = response.status();
    let bytes = response.into_body().collect().await.unwrap().to_bytes();
    (status, serde_json::from_slice(&bytes).unwrap_or(Value::Null))
}

async fn register(s: &AppState, name: &str) -> (String, i64) {
    let response = app(s.clone())
        .oneshot(
            Request::post("/api/v1/account/register")
                .header("content-type", "application/json")
                .header("origin", "https://mxd.ruit.me")
                .body(Body::from(json!({"username":name,"password":"a long unique maple passphrase"}).to_string()))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let cookie = response.headers()["set-cookie"].to_str().unwrap().split(';').next().unwrap().to_string();
    let id: i64 = sqlx::query_scalar("SELECT id FROM accounts ORDER BY id DESC LIMIT 1").fetch_one(&s.db).await.unwrap();
    (cookie, id)
}

#[tokio::test]
async fn only_accounts_signed_in_with_an_admin_email_see_everyone() {
    let Some(db) = TestDb::new().await else {
        return;
    };
    let mut s = AppState::new(db.pool.clone(), Settings::default());
    let google: GoogleOAuth = serde_json::from_value(json!({
        "client_id": "x.apps.googleusercontent.com", "client_secret": "s",
        "redirect_uri": "https://mxd.ruit.me/auth/google/callback", "admin_emails": ["Owner@Example.com"]}))
    .unwrap();
    s.google = Some(std::sync::Arc::new(google));
    let (friend, friend_id) = register(&s, "friend").await;
    let (owner, owner_id) = register(&s, "owner").await;
    sqlx::query("UPDATE accounts SET email='owner@example.com' WHERE id=$1").bind(owner_id).execute(&db.pool).await.unwrap();
    // The friend's synced run.
    let device = db.collector("friend-pc").await;
    sqlx::query("UPDATE collectors SET account_id=$1 WHERE id=$2").bind(friend_id).bind(device.id).execute(&db.pool).await.unwrap();
    sqlx::query("INSERT INTO grind_runs(collector_id,run_id,started_at,ended_at,map_id,level,job,active_seconds,exp,net,kills,summary)
                 VALUES($1,'r1',now()-interval '1 hour',now(),10004141,69,310,1800,100000,5000,400,$2)")
        .bind(device.id)
        .bind(json!({"id":"r1","map_id":10004141,"character":{"name":"Friendly"},"active_seconds":1800}))
        .execute(&db.pool)
        .await
        .unwrap();

    assert_eq!(send(&s, "/api/v1/admin/grind", None).await.0, StatusCode::UNAUTHORIZED);
    assert_eq!(send(&s, "/api/v1/admin/grind", Some(&friend)).await.0, StatusCode::FORBIDDEN);
    assert_eq!(send(&s, "/api/v1/account", Some(&friend)).await.1["admin"], false);
    assert_eq!(send(&s, "/api/v1/account", Some(&owner)).await.1["admin"], true);
    let (status, all) = send(&s, "/api/v1/admin/grind", Some(&owner)).await;
    assert_eq!(status, StatusCode::OK);
    let run = &all["runs"][0];
    assert_eq!(run["character"]["name"], "Friendly");
    assert_eq!(run["owner"]["nickname"].is_string() || run["owner"]["nickname"].is_null(), true);
    let row = run["row"].as_i64().unwrap();
    let (status, detail) = send(&s, &format!("/api/v1/admin/grind/runs/{row}"), Some(&owner)).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(detail["run"]["id"], "r1");
    assert_eq!(send(&s, &format!("/api/v1/admin/grind/runs/{row}"), Some(&friend)).await.0, StatusCode::FORBIDDEN);
    db.close().await;
}

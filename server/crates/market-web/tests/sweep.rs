//! Device login, account events and live sweep against a throwaway database.
mod common;
use std::time::Duration;

use axum::{
    body::Body,
    http::{Request, StatusCode},
};
use base64::Engine;
use common::TestDb;
use http_body_util::BodyExt;
use market_web::{app, auth, realtime, AppState, Settings};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use tower::ServiceExt;

const PASSWORD: &str = "a long unique maple passphrase";
const GLOVE: i64 = 1082002;
// Argon2 jobs share a small process-wide pool; keep password steps one at a time.
static PASSWORDS: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

struct Web {
    cookie: String,
    csrf: String,
}
async fn send(s: &AppState, method: &str, path: &str, headers: &[(&str, String)], body: Value) -> (StatusCode, Value) {
    let mut req = Request::builder().method(method).uri(path).header("content-type", "application/json");
    for (k, v) in headers {
        req = req.header(*k, v);
    }
    let body = if body.is_null() { Body::empty() } else { Body::from(body.to_string()) };
    let response = app(s.clone()).oneshot(req.body(body).unwrap()).await.unwrap();
    let status = response.status();
    let bytes = response.into_body().collect().await.unwrap().to_bytes();
    (status, serde_json::from_slice(&bytes).unwrap_or(Value::Null))
}
fn browser(w: &Web) -> Vec<(&'static str, String)> {
    vec![("cookie", w.cookie.clone()), ("origin", "https://mxd.ruit.me".into()), ("x-csrf-token", w.csrf.clone())]
}
async fn web(s: &AppState, method: &str, path: &str, w: &Web, body: Value) -> (StatusCode, Value) {
    send(s, method, path, &browser(w), body).await
}
async fn dev(s: &AppState, method: &str, path: &str, token: &str, body: Value) -> (StatusCode, Value) {
    send(s, method, path, &[("authorization", format!("Bearer {token}"))], body).await
}
async fn signed_in(s: &AppState, path: &str, body: Value) -> Web {
    let _guard = PASSWORDS.lock().await;
    let response = app(s.clone())
        .oneshot(Request::post(path).header("content-type", "application/json").header("origin", "https://mxd.ruit.me")
            .body(Body::from(body.to_string())).unwrap())
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let cookie = response.headers()["set-cookie"].to_str().unwrap().split(';').next().unwrap().to_string();
    let me = send(s, "GET", "/api/v1/account", &[("cookie", cookie.clone())], Value::Null).await.1;
    Web { cookie, csrf: me["csrf"].as_str().unwrap().to_owned() }
}
async fn signup(s: &AppState, name: &str) -> Web {
    signed_in(s, "/api/v1/account/register", json!({"username":name,"password":PASSWORD})).await
}
async fn sensitive(s: &AppState, path: &str, w: &Web, mut body: Value) -> (StatusCode, Value) {
    let _guard = PASSWORDS.lock().await;
    if body.get("current_password").is_none() {
        body["current_password"] = json!(PASSWORD);
    }
    web(s, "POST", path, w, body).await
}
fn pkce() -> (String, String) {
    let verifier = auth::new_credentials().token;
    let challenge = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()));
    (verifier, challenge)
}
const REDIRECT: &str = "http://127.0.0.1:8766/callback";
async fn code(s: &AppState, w: &Web, challenge: &str, name: &str) -> String {
    let (status, body) = web(s, "POST", "/api/v1/device/authorize", w, json!({"redirect_uri":REDIRECT,"challenge":challenge,"name":name})).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    body["code"].as_str().unwrap().to_owned()
}
async fn exchange(s: &AppState, code: &str, verifier: &str, redirect: &str, collector: Option<&str>) -> (StatusCode, Value) {
    let headers: Vec<(&str, String)> = collector.map(|t| ("authorization", format!("Bearer {t}"))).into_iter().collect();
    send(s, "POST", "/api/v1/device/token", &headers, json!({"code":code,"verifier":verifier,"redirect_uri":redirect,"client_version":"0.7.0"})).await
}
/// Browser login of a new device; returns (token, device id).
async fn device(s: &AppState, w: &Web, name: &str) -> (String, String) {
    let (verifier, challenge) = pkce();
    let code = code(s, w, &challenge, name).await;
    let (status, body) = exchange(s, &code, &verifier, REDIRECT, None).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    (body["token"].as_str().unwrap().to_owned(), body["device"]["id"].as_str().unwrap().to_owned())
}
fn local_state(allow_web_start: bool, ready: bool) -> Value {
    json!({"client_version":"0.7.0","sweep":{"allow_web_start":allow_web_start,"max_spend":1000000,"max_order":0,"reserve_mesos":0,
        "executor":{"ready":ready,"reason":""},"game":{"connected":true}}})
}
async fn ready_device(s: &AppState, w: &Web, name: &str) -> (String, String) {
    let (token, id) = device(s, w, name).await;
    assert_eq!(dev(s, "POST", "/api/v1/device/state", &token, local_state(true, true)).await.0, StatusCode::OK);
    (token, id)
}
fn group(cap: i64) -> Value {
    json!({"id":"g1","name":"扫货","cap":cap,"notify":true,"buy":true,"reminder":{"percentile":"all"}})
}
async fn watch(s: &AppState, w: &Web, item: i64, cap: i64, limit: i64, version: i64) {
    let value = json!({"cap":null,"notify":true,"position":0,"buyLimit":limit,"groups":[group(cap)]});
    let (status, body) = web(s, "POST", "/api/v1/account/data", w,
        json!({"operations":[{"kind":"watch","key":item.to_string(),"value":value,"version":version}]})).await;
    assert_eq!(status, StatusCode::OK, "{body}");
}
fn order(run: &str, lease: &str, listing: u32, item: i64, price: i64) -> Value {
    json!({"run":run,"lease":lease,"plan_version":1,"listing":format!("{listing:064x}"),"item_id":item,"price":price,
        "bundle":1,"stock":1,"quantity":1,"location":{"room":3,"channel":7,"shop_id":12345,"owner":"Seller","category":1,"slot":4}})
}
async fn join(s: &AppState, token: &str, run: &str, version: i64) -> String {
    let (status, body) = dev(s, "POST", "/api/v1/device/sweep/join", token, json!({"run":run,"plan_version":version})).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["expires_in"], 30);
    body["lease"].as_str().unwrap().to_owned()
}
/// (granted, reservation id or refusal reason)
async fn grant(s: &AppState, token: &str, order: Value) -> (i64, String) {
    let (status, body) = dev(s, "POST", "/api/v1/device/sweep/reserve", token, order).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let id = body["reservation"].as_str().or(body["reason"].as_str()).unwrap();
    (body["granted"].as_i64().unwrap(), id.to_owned())
}
async fn settle(s: &AppState, token: &str, reservation: &str, status: &str, quantity: i64, spent: i64, reason: &str) -> StatusCode {
    dev(s, "POST", "/api/v1/device/sweep/settle", token,
        json!({"reservation":reservation,"status":status,"quantity":quantity,"spent":spent,"reason":reason})).await.0
}
async fn run_view(s: &AppState, w: &Web) -> Value {
    let (status, body) = web(s, "GET", "/api/v1/account/sweep", w, Value::Null).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    body["run"].clone()
}
async fn device_start(s: &AppState, token: &str, budget: i64) -> String {
    let (status, body) = dev(s, "POST", "/api/v1/device/sweep/start", token, json!({"budget":budget,"minutes":60})).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    body["run"]["id"].as_str().unwrap().to_owned()
}
fn units(run: &Value, item: i64) -> i64 {
    run["items"].as_array().unwrap().iter().find(|i| i["item_id"] == item).unwrap()["units"].as_i64().unwrap()
}

#[tokio::test]
async fn unlimited_watch_buys_past_9999_but_never_past_budget() {
    let Some(db) = TestDb::new().await else { return };
    let s = AppState::new(db.pool.clone(), Settings::default());
    let w = signup(&s, "unlimited_owner").await;
    watch(&s, &w, 2000001, 130, 0, 0).await;
    let (token, _) = ready_device(&s, &w, "PC").await;
    let run = device_start(&s, &token, 1300520).await;
    let lease = join(&s, &token, &run, 1).await;
    let mut first = order(&run, &lease, 901, 2000001, 130);
    first["quantity"] = json!(9999);
    first["stock"] = json!(9999);
    let (n, id) = grant(&s, &token, first).await;
    assert_eq!(n, 9999);
    assert_eq!(settle(&s, &token, &id, "bought", n, n*130, "").await, StatusCode::OK);
    let mut next = order(&run, &lease, 902, 2000001, 130);
    next["quantity"] = json!(100);
    next["stock"] = json!(100);
    let (n, id) = grant(&s, &token, next).await;
    assert_eq!(n, 5, "remaining budget still caps the unlimited item");
    assert_eq!(settle(&s, &token, &id, "bought", n, n*130, "").await, StatusCode::OK);
    let summary = run_view(&s, &w).await;
    assert_eq!(units(&summary, 2000001), 10004);
    assert_eq!(summary["remaining"], 0);
    assert_eq!(summary["items"][0]["limit"], 0);
    db.close().await;
}

#[tokio::test]
async fn device_login_uses_a_single_use_pkce_code() {
    let Some(db) = TestDb::new().await else { return };
    let s = AppState::new(db.pool.clone(), Settings::default());
    let w = signup(&s, "device_owner").await;
    let (verifier, challenge) = pkce();
    let body = |redirect: &str, challenge: &str, name: &str| json!({"redirect_uri":redirect,"challenge":challenge,"name":name});
    for bad in [
        body("http://127.0.0.1:80/callback", &challenge, "书房电脑"),
        body("http://localhost:8766/callback", &challenge, "书房电脑"),
        body("http://127.0.0.1:8766/callback?x=1", &challenge, "书房电脑"),
        body(REDIRECT, &challenge[1..], "书房电脑"),
        body(REDIRECT, &challenge, ""),
        body(REDIRECT, &challenge, &"长".repeat(41)),
        body(REDIRECT, &challenge, "a\nb"),
    ] {
        let (status, answer) = web(&s, "POST", "/api/v1/device/authorize", &w, bad).await;
        assert_eq!((status, answer["error"].as_str()), (StatusCode::BAD_REQUEST, Some("invalid_request")));
    }
    let no_csrf = [("cookie", w.cookie.clone()), ("origin", "https://mxd.ruit.me".into())];
    assert_eq!(send(&s, "POST", "/api/v1/device/authorize", &no_csrf, body(REDIRECT, &challenge, "x")).await.0, StatusCode::FORBIDDEN);
    assert_eq!(send(&s, "POST", "/api/v1/device/authorize", &[], body(REDIRECT, &challenge, "x")).await.0, StatusCode::UNAUTHORIZED);
    for _ in 0..3 {
        web(&s, "POST", "/api/v1/device/authorize", &w, body(REDIRECT, &challenge, "x")).await;
    }
    let (status, limited) = web(&s, "POST", "/api/v1/device/authorize", &w, body(REDIRECT, &challenge, "x")).await;
    assert_eq!((status, limited["error"].as_str()), (StatusCode::TOO_MANY_REQUESTS, Some("rate_limited")));
    // A fresh limiter; sessions and codes live in the database.
    let s = AppState::new(db.pool.clone(), Settings::default());

    let invalid_grant = |r: (StatusCode, Value)| r.0 == StatusCode::BAD_REQUEST && r.1["error"] == "invalid_grant";
    // A wrong verifier burns the code.
    let first = code(&s, &w, &challenge, "书房电脑").await;
    assert!(invalid_grant(exchange(&s, &first, &pkce().0, REDIRECT, None).await));
    assert!(invalid_grant(exchange(&s, &first, &verifier, REDIRECT, None).await));
    let other = code(&s, &w, &challenge, "书房电脑").await;
    assert!(invalid_grant(exchange(&s, &other, &verifier, "http://127.0.0.1:8767/callback", None).await));
    let expired = code(&s, &w, &challenge, "书房电脑").await;
    sqlx::query("UPDATE device_authorizations SET expires_at=now()-interval '1 second' WHERE code_hash=$1")
        .bind(auth::token_hash(&expired)).execute(&db.pool).await.unwrap();
    assert!(invalid_grant(exchange(&s, &expired, &verifier, REDIRECT, None).await));
    assert!(invalid_grant(exchange(&s, &"x".repeat(43), &verifier, REDIRECT, None).await));

    let good = code(&s, &w, &challenge, " 书房电脑 ").await;
    let (status, issued) = exchange(&s, &good, &verifier, REDIRECT, None).await;
    assert_eq!(status, StatusCode::OK, "{issued}");
    let token = issued["token"].as_str().unwrap();
    assert!(token.starts_with("cwd_") && token.len() == 47);
    assert_eq!(issued["device"]["name"], "书房电脑");
    let me = send(&s, "GET", "/api/v1/account", &[("cookie", w.cookie.clone())], Value::Null).await.1;
    assert_eq!(issued["account"]["id"], me["public_id"]);
    assert_eq!(issued["account"]["nickname"], me["nickname"]);
    assert!(invalid_grant(exchange(&s, &good, &verifier, REDIRECT, None).await));
    let stored: Vec<u8> = sqlx::query_scalar("SELECT token_hash FROM account_devices").fetch_one(&db.pool).await.unwrap();
    assert_eq!(stored, auth::token_hash(token));

    let (status, account) = dev(&s, "GET", "/api/v1/device/account", token, Value::Null).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(account["device"], issued["device"]);
    let listed = web(&s, "GET", "/api/v1/account/devices", &w, Value::Null).await.1;
    assert_eq!(listed["devices"][0]["id"], issued["device"]["id"]);
    assert_eq!(listed["devices"][0]["online"], true);
    assert_eq!(listed["devices"][0]["client_version"], "0.7.0");

    // Unused for 90 days: invalid. Revoked: invalid at once.
    let (stale, _) = device(&s, &w, "旧电脑").await;
    sqlx::query("UPDATE account_devices SET last_seen_at=now()-interval '91 days' WHERE token_hash=$1")
        .bind(auth::token_hash(&stale)).execute(&db.pool).await.unwrap();
    assert_eq!(dev(&s, "GET", "/api/v1/device/account", &stale, Value::Null).await.0, StatusCode::UNAUTHORIZED);
    assert_eq!(web(&s, "POST", "/api/v1/account/devices/revoke", &w, json!({"device":issued["device"]["id"]})).await.0, StatusCode::OK);
    let (status, denied) = dev(&s, "GET", "/api/v1/device/data", token, Value::Null).await;
    assert_eq!((status, denied["error"].as_str()), (StatusCode::UNAUTHORIZED, Some("login_required")));
    assert_eq!(web(&s, "GET", "/api/v1/account/devices", &w, Value::Null).await.1["devices"], json!([]));
    assert_eq!(web(&s, "POST", "/api/v1/account/devices/revoke", &w, json!({"device":"0".repeat(24)})).await.0, StatusCode::NOT_FOUND);
    db.close().await;
}

#[tokio::test]
async fn collector_tokens_link_on_login_and_migrate_once() {
    let Some(db) = TestDb::new().await else { return };
    let s = AppState::new(db.pool.clone(), Settings::default());
    let w = signup(&s, "collector_owner").await;
    let account: i64 = sqlx::query_scalar("SELECT id FROM accounts").fetch_one(&db.pool).await.unwrap();
    let old = auth::register(&db.pool, "old").await.unwrap();
    let migrate = |token: String| {
        let s = s.clone();
        async move { send(&s, "POST", "/api/v1/device/migrate", &[("authorization", format!("Bearer {token}"))], Value::Null).await }
    };
    assert_eq!(migrate(old.token.clone()).await.1["error"], "login_required");
    sqlx::query("UPDATE collectors SET account_id=$1 WHERE public_id=$2").bind(account).bind(&old.public_id).execute(&db.pool).await.unwrap();
    let (status, migrated) = migrate(old.token.clone()).await;
    assert_eq!(status, StatusCode::OK, "{migrated}");
    assert_eq!(migrated["device"]["name"], "采集器");
    assert!(migrated["token"].as_str().unwrap().starts_with("cwd_"));
    assert_eq!(migrate(old.token.clone()).await.0, StatusCode::UNAUTHORIZED);
    let device = migrated["token"].as_str().unwrap();
    assert_eq!(dev(&s, "POST", "/api/v1/device/logout", device, Value::Null).await.0, StatusCode::OK);
    assert_eq!(dev(&s, "GET", "/api/v1/device/account", device, Value::Null).await.0, StatusCode::UNAUTHORIZED);
    let linked: Option<i64> = sqlx::query_scalar("SELECT account_id FROM collectors WHERE public_id=$1").bind(&old.public_id).fetch_one(&db.pool).await.unwrap();
    assert_eq!(linked, None, "device logout signs the collector out too");
    sqlx::query("UPDATE collectors SET account_id=$1 WHERE public_id=$2").bind(account).bind(&old.public_id).execute(&db.pool).await.unwrap();
    assert_eq!(migrate(old.token.clone()).await.0, StatusCode::UNAUTHORIZED, "a revoked device still counts");

    // Browser login with an unlinked collector links it and records it on the device.
    let fresh = auth::register(&db.pool, "fresh").await.unwrap();
    sqlx::query("UPDATE collectors SET nickname='采集昵称' WHERE public_id=$1").bind(&fresh.public_id).execute(&db.pool).await.unwrap();
    let (verifier, challenge) = pkce();
    let c = code(&s, &w, &challenge, "新电脑").await;
    let (status, fresh_device) = exchange(&s, &c, &verifier, REDIRECT, Some(&fresh.token)).await;
    assert_eq!(status, StatusCode::OK);
    let (owner, recorded): (Option<i64>, bool) = sqlx::query_as("SELECT c.account_id,EXISTS(SELECT 1 FROM account_devices d WHERE d.collector_id=c.id AND d.name='新电脑') FROM collectors c WHERE c.public_id=$1")
        .bind(&fresh.public_id).fetch_one(&db.pool).await.unwrap();
    assert_eq!((owner, recorded), (Some(account), true));
    assert_eq!(migrate(fresh.token.clone()).await.0, StatusCode::UNAUTHORIZED);
    assert_eq!(web(&s, "POST", "/api/v1/account/devices/revoke", &w, json!({"device":fresh_device["device"]["id"]})).await.0, StatusCode::OK);
    let owner: Option<i64> = sqlx::query_scalar("SELECT account_id FROM collectors WHERE public_id=$1").bind(&fresh.public_id).fetch_one(&db.pool).await.unwrap();
    assert_eq!(owner, None, "signing a device out on the web unlinks its collector");

    // A collector of another account keeps its owner and is not recorded.
    let stranger = signup(&s, "someone_else").await;
    let theirs = auth::register(&db.pool, "theirs").await.unwrap();
    let (verifier, challenge) = pkce();
    let c = code(&s, &stranger, &challenge, "他们的").await;
    assert_eq!(exchange(&s, &c, &verifier, REDIRECT, Some(&theirs.token)).await.0, StatusCode::OK);
    let (verifier, challenge) = pkce();
    let c = code(&s, &w, &challenge, "借用").await;
    assert_eq!(exchange(&s, &c, &verifier, REDIRECT, Some(&theirs.token)).await.0, StatusCode::OK);
    let (owner, recorded): (Option<i64>, Option<i64>) = sqlx::query_as("SELECT c.account_id,(SELECT collector_id FROM account_devices WHERE name='借用') FROM collectors c WHERE c.public_id=$1")
        .bind(&theirs.public_id).fetch_one(&db.pool).await.unwrap();
    assert_ne!(owner, Some(account));
    assert_eq!(recorded, None);
    assert_eq!(migrate(theirs.token.clone()).await.0, StatusCode::UNAUTHORIZED, "any browser login rules out migrate");
    db.close().await;
}

#[tokio::test]
async fn device_data_is_scoped_to_watch_records() {
    let Some(db) = TestDb::new().await else { return };
    let s = AppState::new(db.pool.clone(), Settings::default());
    let w = signup(&s, "data_owner").await;
    let (token, _) = device(&s, &w, "书房").await;
    assert_eq!(web(&s, "POST", "/api/v1/account/data", &w, json!({"operations":[{"kind":"pref","key":"theme","value":"dark","version":0}]})).await.0, StatusCode::OK);
    for blocked in [
        json!({"kind":"pref","key":"theme","value":"light","version":1}),
        json!({"kind":"pref","key":"lang","value":"en","version":0}),
        json!({"kind":"pref","key":"item.showExpired.1002000","value":"true","version":0}),
    ] {
        let (status, body) = dev(&s, "POST", "/api/v1/device/data", &token, json!({"operations":[blocked]})).await;
        assert_eq!((status, body["error"].as_str()), (StatusCode::BAD_REQUEST, Some("invalid_data")));
    }
    let value = json!({"cap":null,"notify":true,"position":0,"buyLimit":2,"groups":[group(500000)]});
    let ops = json!({"operations":[{"kind":"watch","key":"1082002","value":value,"version":0},{"kind":"pref","key":"watch.offerSort","value":"recent","version":0}]});
    let (status, saved) = dev(&s, "POST", "/api/v1/device/data", &token, ops.clone()).await;
    assert_eq!(status, StatusCode::OK, "{saved}");
    assert_eq!(saved["records"].as_array().unwrap().len(), 2);
    assert!(saved["account"]["id"].is_string());
    assert_eq!(dev(&s, "POST", "/api/v1/device/data", &token, ops).await.1["error"], "sync_conflict");
    let records = dev(&s, "GET", "/api/v1/device/data", &token, Value::Null).await.1["records"].clone();
    assert!(records.as_array().unwrap().iter().all(|r| r["key"] != "theme"));
    let site = web(&s, "GET", "/api/v1/account/data", &w, Value::Null).await.1;
    assert!(site["records"].as_array().unwrap().iter().any(|r| r["key"] == "1082002" && r["value"] == value));
    db.close().await;
}

#[tokio::test]
async fn web_start_checks_password_devices_and_the_single_running_run() {
    let Some(db) = TestDb::new().await else { return };
    let s = AppState::new(db.pool.clone(), Settings::default());
    let w = signup(&s, "web_starter").await;
    let (empty_token, _) = ready_device(&s, &w, "空规则").await;
    assert_eq!(dev(&s, "POST", "/api/v1/device/sweep/start", &empty_token, json!({"budget":1000,"minutes":60})).await.1["error"], "no_sweep_groups");
    watch(&s, &w, GLOVE, 500000, 2, 0).await;
    let (_, ready) = ready_device(&s, &w, "可用").await;
    let (offline_token, offline) = ready_device(&s, &w, "离线").await;
    sqlx::query("UPDATE account_devices SET last_seen_at=now()-interval '2 minutes' WHERE token_hash=$1")
        .bind(auth::token_hash(&offline_token)).execute(&db.pool).await.unwrap();
    let (closed_token, closed) = device(&s, &w, "不允许").await;
    dev(&s, "POST", "/api/v1/device/state", &closed_token, local_state(false, true)).await;
    let (no_executor_token, no_executor) = device(&s, &w, "无执行器").await;
    dev(&s, "POST", "/api/v1/device/state", &no_executor_token, local_state(true, false)).await;
    let (_, never_reported) = device(&s, &w, "未上报").await;

    let start = |devices: Vec<&str>| json!({"devices":devices,"budget":1000000,"minutes":10080});
    let mut wrong = start(vec![&ready]);
    wrong["current_password"] = json!("not the password at all");
    assert_eq!(sensitive(&s, "/api/v1/account/sweep/start", &w, wrong).await.1["error"], "invalid_current_password");
    for unavailable in [&offline, &closed, &no_executor, &never_reported] {
        let (status, body) = sensitive(&s, "/api/v1/account/sweep/start", &w, start(vec![&ready, unavailable])).await;
        assert_eq!((status, body["error"].as_str()), (StatusCode::CONFLICT, Some("device_unavailable")));
    }
    let (status, started) = sensitive(&s, "/api/v1/account/sweep/start", &w, start(vec![&ready])).await;
    assert_eq!(status, StatusCode::OK, "{started}");
    let run = &started["run"];
    assert_eq!((run["status"].as_str(), run["started_by"].as_str(), run["remaining"].as_i64()), (Some("running"), Some("web"), Some(1000000)));
    assert_eq!(run["devices"][0]["state"], "invited");
    assert_eq!(run["items"], json!([{"item_id":GLOVE,"limit":2,"units":0}]));
    assert_eq!(run["plan_stale"], false);
    assert_eq!(sensitive(&s, "/api/v1/account/sweep/start", &w, start(vec![&ready])).await.1["error"], "sweep_running");
    assert_eq!(dev(&s, "POST", "/api/v1/device/sweep/start", &empty_token, json!({"budget":1000,"minutes":60})).await.1["error"], "sweep_running");
    for (budget, minutes) in [(0i64, 60), (1_000_000_000_001, 60), (1000, 4), (1000, 10081)] {
        let (status, body) = dev(&s, "POST", "/api/v1/device/sweep/start", &empty_token, json!({"budget":budget,"minutes":minutes})).await;
        assert_eq!((status, body["error"].as_str()), (StatusCode::BAD_REQUEST, Some("invalid_request")));
    }
    // Not invited: the device sees no run and cannot join.
    assert_eq!(dev(&s, "GET", "/api/v1/device/sweep", &empty_token, Value::Null).await.1, json!({"run":null}));
    let id = run["id"].as_str().unwrap();
    assert_eq!(dev(&s, "POST", "/api/v1/device/sweep/join", &empty_token, json!({"run":id,"plan_version":1})).await.1["error"], "not_invited");
    db.close().await;
}

#[tokio::test]
async fn two_devices_share_one_budget() {
    let Some(db) = TestDb::new().await else { return };
    let s = AppState::new(db.pool.clone(), Settings::default());
    let w = signup(&s, "shared_budget").await;
    watch(&s, &w, GLOVE, 500000, 2, 0).await;
    let (a, a_id) = ready_device(&s, &w, "A").await;
    let (b, b_id) = ready_device(&s, &w, "B").await;
    let (status, started) = sensitive(&s, "/api/v1/account/sweep/start", &w, json!({"devices":[a_id,b_id],"budget":1000000,"minutes":60})).await;
    assert_eq!(status, StatusCode::OK, "{started}");
    let run = started["run"]["id"].as_str().unwrap().to_owned();
    let seen = dev(&s, "GET", "/api/v1/device/sweep", &a, Value::Null).await.1;
    assert_eq!(seen["run"]["participant"]["state"], "invited");
    assert_eq!(seen["run"]["plan"]["watches"][0]["item_id"], GLOVE);
    assert_eq!(seen["run"]["started_by"], "web");
    let a_lease = join(&s, &a, &run, 1).await;
    let b_lease = join(&s, &b, &run, 1).await;

    let (n, a1) = grant(&s, &a, order(&run, &a_lease, 1, GLOVE, 450000)).await;
    assert_eq!(n, 1);
    let view = run_view(&s, &w).await;
    assert_eq!((view["reserved"].as_i64(), view["remaining"].as_i64()), (Some(450000), Some(550000)));
    let (n, b1) = grant(&s, &b, order(&run, &b_lease, 2, GLOVE, 480000)).await;
    assert_eq!(n, 1);
    let view = run_view(&s, &w).await;
    assert_eq!((view["remaining"].as_i64(), units(&view, GLOVE)), (Some(70000), 2));
    // The item limit is reached while both are held.
    assert_eq!(grant(&s, &a, order(&run, &a_lease, 9, GLOVE, 1000)).await, (0, "item_limit".into()));

    assert_eq!(settle(&s, &a, &a1, "bought", 1, 450000, "").await, StatusCode::OK);
    let view = run_view(&s, &w).await;
    assert_eq!((view["spent"].as_i64(), view["reserved"].as_i64(), view["remaining"].as_i64()), (Some(450000), Some(480000), Some(70000)));
    assert_eq!(settle(&s, &b, &b1, "not_bought", 0, 0, "sold_out").await, StatusCode::OK);
    let view = run_view(&s, &w).await;
    assert_eq!((view["reserved"].as_i64(), view["remaining"].as_i64(), units(&view, GLOVE)), (Some(0), Some(550000), 1));
    let (n, b2) = grant(&s, &b, order(&run, &b_lease, 3, GLOVE, 460000)).await;
    assert_eq!(n, 1);
    assert_eq!(dev(&s, "GET", "/api/v1/device/sweep", &b, Value::Null).await.1["run"]["remaining"], 90000);
    assert_eq!(settle(&s, &b, &b2, "bought", 1, 460000, "").await, StatusCode::OK);
    let view = run_view(&s, &w).await;
    assert_eq!((view["spent"].as_i64(), view["remaining"].as_i64(), units(&view, GLOVE)), (Some(910000), Some(90000), 2));
    assert_eq!(view["status"], "running");
    let spent: Vec<(String, i64)> = view["devices"].as_array().unwrap().iter()
        .map(|d| (d["name"].as_str().unwrap().to_owned(), d["spent"].as_i64().unwrap())).collect();
    assert_eq!(spent, vec![("A".into(), 450000), ("B".into(), 460000)]);
    let purchases = view["purchases"].as_array().unwrap();
    assert_eq!(purchases.iter().map(|p| p["status"].as_str().unwrap()).collect::<Vec<_>>(), vec!["bought", "not_bought", "bought"]);
    assert_eq!((purchases[0]["room"].as_i64(), purchases[0]["channel"].as_i64(), purchases[0]["owner"].as_str()), (Some(3), Some(7), Some("Seller")));
    assert_eq!(purchases[1]["reason"], "sold_out");
    assert_eq!(dev(&s, "GET", "/api/v1/device/sweep", &b, Value::Null).await.1["run"]["spent_here"], 460000);
    // Another device cannot settle B's reservation.
    assert_eq!(settle(&s, &a, &b2, "bought", 1, 460000, "").await, StatusCode::NOT_FOUND);
    db.close().await;
}

#[tokio::test]
async fn grants_stop_at_limits_and_unsettled_reservations_count() {
    let Some(db) = TestDb::new().await else { return };
    let s = AppState::new(db.pool.clone(), Settings::default());
    let w = signup(&s, "limits").await;
    // Ores: 100 per bundle, cap 100 per unit, 250 units. Stars: priced per bundle.
    watch(&s, &w, 4010000, 100, 250, 0).await;
    watch(&s, &w, 2070000, 50000, 100, 0).await;
    let (token, _) = ready_device(&s, &w, "本机").await;
    let run = device_start(&s, &token, 100000).await;
    let lease = join(&s, &token, &run, 1).await;
    let mut ore = order(&run, &lease, 1, 4010000, 9000);
    ore["bundle"] = json!(100);
    ore["stock"] = json!(5);
    ore["quantity"] = json!(5);
    let (n, first) = grant(&s, &token, ore.clone()).await;
    assert_eq!(n, 2, "250 units allow two bundles of 100");
    assert_eq!(grant(&s, &token, ore.clone()).await, (0, "duplicate".into()));
    let mut costly = ore.clone();
    costly["listing"] = json!(format!("{:064x}", 2));
    costly["price"] = json!(10001);
    assert_eq!(dev(&s, "POST", "/api/v1/device/sweep/reserve", &token, costly).await.1["error"], "price_over_cap");
    let mut unplanned = ore.clone();
    unplanned["listing"] = json!(format!("{:064x}", 3));
    unplanned["item_id"] = json!(4010001);
    assert_eq!(dev(&s, "POST", "/api/v1/device/sweep/reserve", &token, unplanned).await.1["error"], "item_not_in_plan");
    let mut bad = ore.clone();
    bad["listing"] = json!("ABC");
    assert_eq!(dev(&s, "POST", "/api/v1/device/sweep/reserve", &token, bad).await.0, StatusCode::BAD_REQUEST);
    let mut stars = order(&run, &lease, 4, 2070000, 40000);
    stars["bundle"] = json!(800);
    stars["stock"] = json!(10);
    stars["quantity"] = json!(10);
    let (n, second) = grant(&s, &token, stars).await;
    assert_eq!(n, 2, "82000 left buys two bundles at 40000");
    let view = run_view(&s, &w).await;
    assert_eq!((view["reserved"].as_i64(), view["remaining"].as_i64(), units(&view, 2070000), units(&view, 4010000)), (Some(98000), Some(2000), 2, 200));
    let mut cheap = order(&run, &lease, 5, 2070000, 5000);
    cheap["bundle"] = json!(800);
    assert_eq!(grant(&s, &token, cheap).await, (0, "budget".into()));

    // Expired holds count as unknown; a late result within 10 minutes replaces it.
    sqlx::query("UPDATE sweep_reservations SET expires_at=now()-interval '1 second'").execute(&db.pool).await.unwrap();
    let view = run_view(&s, &w).await;
    assert_eq!((view["reserved"].as_i64(), view["unknown"].as_i64(), view["remaining"].as_i64()), (Some(0), Some(98000), Some(2000)));
    assert_eq!(view["purchases"][1]["status"], "expired");
    assert_eq!(settle(&s, &token, &first, "bought", 2, 15000, "").await, StatusCode::OK);
    let view = run_view(&s, &w).await;
    assert_eq!((view["spent"].as_i64(), view["unknown"].as_i64(), view["remaining"].as_i64()), (Some(15000), Some(80000), Some(5000)));
    assert_eq!(settle(&s, &token, &first, "bought", 2, 15000, "").await, StatusCode::OK, "same result twice is fine");
    assert_eq!(settle(&s, &token, &first, "not_bought", 0, 0, "").await, StatusCode::CONFLICT);
    assert_eq!(settle(&s, &token, &first, "bought", 1, 15000, "").await, StatusCode::CONFLICT);
    sqlx::query("UPDATE sweep_reservations SET created_at=now()-interval '11 minutes' WHERE public_id=$1").bind(&second).execute(&db.pool).await.unwrap();
    assert_eq!(settle(&s, &token, &second, "not_bought", 0, 0, "").await, StatusCode::CONFLICT);
    assert_eq!(run_view(&s, &w).await["unknown"], 80000);
    // Results must fit the reservation of two bundles at 40000.
    sqlx::query("UPDATE sweep_runs SET budget=budget+100000").execute(&db.pool).await.unwrap();
    let mut more = order(&run, &lease, 6, 2070000, 40000);
    more["bundle"] = json!(800);
    more["stock"] = json!(2);
    more["quantity"] = json!(2);
    let (n, open) = grant(&s, &token, more).await;
    assert_eq!(n, 2);
    for (status, quantity, spent, reason) in [("bought", 3, 0, ""), ("bought", 1, 40001, ""), ("not_bought", 1, 0, ""),
        ("maybe", 0, 0, ""), ("not_bought", 0, 0, "Sold Out")] {
        assert_eq!(settle(&s, &token, &open, status, quantity, spent, reason).await, StatusCode::BAD_REQUEST, "{status} {quantity} {spent}");
    }
    assert_eq!(settle(&s, &token, &open, "bought", 2, 80000, "").await, StatusCode::OK);
    db.close().await;
}

#[tokio::test]
async fn plan_changes_require_stop_and_restart() {
    let Some(db) = TestDb::new().await else { return };
    let s = AppState::new(db.pool.clone(), Settings::default());
    let w = signup(&s, "plan_versions").await;
    watch(&s, &w, GLOVE, 500000, 5, 0).await;
    let (token, _) = ready_device(&s, &w, "本机").await;
    let run = device_start(&s, &token, 10_000_000).await;
    let lease = join(&s, &token, &run, 1).await;
    assert_eq!(grant(&s, &token, order(&run, &lease, 1, GLOVE, 100000)).await.0, 1);
    watch(&s, &w, GLOVE, 300000, 5, 1).await;
    assert_eq!(run_view(&s, &w).await["plan_stale"], true);
    let (status, applied) = sensitive(&s, "/api/v1/account/sweep/apply", &w, json!({"run":run})).await;
    assert_eq!(status, StatusCode::CONFLICT, "{applied}");
    assert_eq!(applied["error"], "restart_required");
    let view = run_view(&s, &w).await;
    assert_eq!(view["plan_version"], 1);
    assert_eq!(view["plan"]["watches"][0]["groups"][0]["cap"], 500000);
    assert_eq!(grant(&s, &token, order(&run, &lease, 2, GLOVE, 400000)).await.0, 1, "running plan remains unchanged");
    assert_eq!(web(&s, "POST", "/api/v1/account/sweep/stop", &w, json!({"run":run})).await.0, StatusCode::OK);
    let next = device_start(&s, &token, 10_000_000).await;
    let next_lease = join(&s, &token, &next, 1).await;
    assert_eq!(dev(&s, "POST", "/api/v1/device/sweep/reserve", &token, order(&next, &next_lease, 3, GLOVE, 400000)).await.1["error"], "price_over_cap");
    let (_, reservation) = grant(&s, &token, order(&next, &next_lease, 4, GLOVE, 250000)).await;
    assert_eq!(settle(&s, &token, &reservation, "unknown", 0, 0, "timeout").await, StatusCode::OK);
    assert_eq!(dev(&s, "POST", "/api/v1/device/sweep/heartbeat", &token, json!({"run":next,"lease":next_lease})).await.1["error"], "lease_lost");
    let view = run_view(&s, &w).await;
    assert_eq!((view["devices"][0]["state"].as_str(), view["unknown"].as_i64()), (Some("left"), Some(250000)));
    db.close().await;
}

#[tokio::test]
async fn runs_end_by_stop_time_and_budget() {
    let Some(db) = TestDb::new().await else { return };
    let s = AppState::new(db.pool.clone(), Settings::default());
    let w = signup(&s, "run_endings").await;
    watch(&s, &w, GLOVE, 500000, 5, 0).await;
    let (token, _) = ready_device(&s, &w, "本机").await;
    let beat = |run: &str, lease: &str| json!({"run":run,"lease":lease,"status":{"message":"","checked":0}});

    let run = device_start(&s, &token, 1_000_000).await;
    assert_eq!(dev(&s, "GET", "/api/v1/device/sweep", &token, Value::Null).await.1["run"]["started_by"].as_str().map(str::len), Some(24));
    let lease = join(&s, &token, &run, 1).await;
    sqlx::query("UPDATE sweep_run_devices SET lease_expires_at=now()-interval '1 second'").execute(&db.pool).await.unwrap();
    assert_eq!(dev(&s, "POST", "/api/v1/device/sweep/heartbeat", &token, beat(&run, &lease)).await.1["error"], "lease_lost");
    let lease = join(&s, &token, &run, 1).await;
    assert_eq!(dev(&s, "POST", "/api/v1/device/sweep/heartbeat", &token, beat(&run, &lease)).await.0, StatusCode::OK);
    let (status, stopped) = web(&s, "POST", "/api/v1/account/sweep/stop", &w, json!({"run":run})).await;
    assert_eq!((status, stopped["run"]["stop_reason"].as_str()), (StatusCode::OK, Some("stopped_on_web")));
    let (status, body) = dev(&s, "POST", "/api/v1/device/sweep/heartbeat", &token, beat(&run, &lease)).await;
    assert_eq!((status, body), (StatusCode::CONFLICT, json!({"error":"sweep_stopped","reason":"stopped_on_web"})));
    assert_eq!(dev(&s, "POST", "/api/v1/device/sweep/reserve", &token, order(&run, &lease, 1, GLOVE, 1000)).await.1["error"], "sweep_stopped");
    assert_eq!(dev(&s, "POST", "/api/v1/device/sweep/leave", &token, json!({"run":run,"lease":lease,"reason":"done"})).await.0, StatusCode::OK);

    let run = device_start(&s, &token, 1_000_000).await;
    let lease = join(&s, &token, &run, 1).await;
    sqlx::query("UPDATE sweep_runs SET ends_at=now()-interval '1 second' WHERE status='running'").execute(&db.pool).await.unwrap();
    assert_eq!(dev(&s, "POST", "/api/v1/device/sweep/heartbeat", &token, beat(&run, &lease)).await.1["reason"], "time_up");
    let view = run_view(&s, &w).await;
    assert_eq!((view["id"].as_str(), view["status"].as_str(), view["stop_reason"].as_str()), (Some(run.as_str()), Some("finished"), Some("time_up")));

    // Exactly spending the budget finishes the run; the result still settles.
    let run = device_start(&s, &token, 450000).await;
    let lease = join(&s, &token, &run, 1).await;
    let (n, reservation) = grant(&s, &token, order(&run, &lease, 1, GLOVE, 450000)).await;
    assert_eq!(n, 1);
    assert_eq!(dev(&s, "POST", "/api/v1/device/sweep/reserve", &token, order(&run, &lease, 2, GLOVE, 1)).await.1["reason"], "budget_spent");
    assert_eq!(settle(&s, &token, &reservation, "bought", 1, 449000, "").await, StatusCode::OK);
    let view = run_view(&s, &w).await;
    assert_eq!((view["status"].as_str(), view["stop_reason"].as_str(), view["spent"].as_i64()), (Some("finished"), Some("budget_spent"), Some(449000)));

    let run = device_start(&s, &token, 1000).await;
    assert_eq!(dev(&s, "POST", "/api/v1/device/sweep/refuse", &token, json!({"run":run,"reason":"规则校验失败"})).await.0, StatusCode::OK);
    assert_eq!(dev(&s, "GET", "/api/v1/device/sweep", &token, Value::Null).await.1, json!({"run":null}));
    assert_eq!(dev(&s, "POST", "/api/v1/device/sweep/join", &token, json!({"run":run,"plan_version":1})).await.1["error"], "not_invited");
    assert_eq!(run_view(&s, &w).await["devices"][0]["message"], "规则校验失败");
    assert_eq!(dev(&s, "POST", "/api/v1/device/sweep/stop", &token, json!({"run":run})).await.0, StatusCode::OK);
    assert_eq!(run_view(&s, &w).await["stop_reason"], "stopped_on_device");
    db.close().await;
}

#[tokio::test]
async fn logout_all_and_password_change_revoke_devices() {
    let Some(db) = TestDb::new().await else { return };
    let s = AppState::new(db.pool.clone(), Settings::default());
    let w = signup(&s, "revoker").await;
    watch(&s, &w, GLOVE, 500000, 1, 0).await;
    let (first, _) = ready_device(&s, &w, "一号").await;
    let (second, _) = device(&s, &w, "二号").await;
    let run = device_start(&s, &first, 1000).await;
    join(&s, &first, &run, 1).await;
    assert_eq!(sensitive(&s, "/api/v1/account/logout-all", &w, json!({})).await.0, StatusCode::OK);
    for token in [&first, &second] {
        assert_eq!(dev(&s, "GET", "/api/v1/device/account", token, Value::Null).await.0, StatusCode::UNAUTHORIZED);
    }
    let seat: (String, String) = sqlx::query_as("SELECT state,message FROM sweep_run_devices").fetch_one(&db.pool).await.unwrap();
    assert_eq!(seat, ("left".into(), "revoked".into()));
    let w = signed_in(&s, "/api/v1/account/login", json!({"username":"revoker","password":PASSWORD})).await;
    let (third, _) = device(&s, &w, "三号").await;
    let changed = sensitive(&s, "/api/v1/account/password", &w,
        json!({"username":"revoker","password":"another long maple passphrase"})).await;
    assert_eq!(changed.0, StatusCode::OK, "{}", changed.1);
    assert_eq!(dev(&s, "GET", "/api/v1/device/account", &third, Value::Null).await.0, StatusCode::UNAUTHORIZED);
    db.close().await;
}

async fn next_event(body: &mut Body, millis: u64) -> Option<String> {
    let frame = tokio::time::timeout(Duration::from_millis(millis), body.frame()).await.ok()??.ok()?;
    frame.into_data().ok().map(|bytes| String::from_utf8_lossy(&bytes).into_owned())
}
async fn open_events(s: &AppState, headers: &[(&str, String)]) -> Body {
    let mut req = Request::get("/api/v1/account/events");
    for (k, v) in headers {
        req = req.header(*k, v);
    }
    let response = app(s.clone()).oneshot(req.body(Body::empty()).unwrap()).await.unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let mut body = response.into_body();
    assert!(next_event(&mut body, 2000).await.unwrap().contains("event: hello"));
    body
}

#[tokio::test]
async fn account_events_reach_only_their_account() {
    let Some(db) = TestDb::new().await else { return };
    let s = AppState::new(db.pool.clone(), Settings::default());
    let mut ready = s.events.subscribe();
    let listener = tokio::spawn(realtime::listen(s.db.clone(), s.events.clone(), s.collector_updates.clone(), s.account_events.clone()));
    tokio::time::timeout(Duration::from_secs(5), ready.recv()).await.unwrap().unwrap();
    let mine = signup(&s, "events_mine").await;
    let theirs = signup(&s, "events_theirs").await;
    let (token, _) = device(&s, &mine, "本机").await;
    assert_eq!(send(&s, "GET", "/api/v1/account/events", &[], Value::Null).await.0, StatusCode::UNAUTHORIZED);
    assert_eq!(dev(&s, "GET", "/api/v1/account/events", &format!("cwd_{}", "x".repeat(43)), Value::Null).await.0, StatusCode::UNAUTHORIZED);
    let mut device_feed = open_events(&s, &[("authorization", format!("Bearer {token}"))]).await;
    let mut their_feed = open_events(&s, &[("cookie", theirs.cookie.clone())]).await;
    let mut my_site = open_events(&s, &[("cookie", mine.cookie.clone())]).await;

    assert_eq!(dev(&s, "POST", "/api/v1/device/state", &token, local_state(true, true)).await.0, StatusCode::OK);
    assert!(next_event(&mut device_feed, 3000).await.unwrap().contains("event: devices"));
    assert!(next_event(&mut my_site, 3000).await.unwrap().contains("event: devices"));
    watch(&s, &theirs, GLOVE, 1000, 1, 0).await;
    assert!(next_event(&mut their_feed, 3000).await.unwrap().contains("event: data"));
    assert_eq!(next_event(&mut device_feed, 300).await, None, "another account's change stays private");
    watch(&s, &mine, GLOVE, 1000, 1, 0).await;
    assert!(next_event(&mut device_feed, 3000).await.unwrap().contains("event: data"));
    device_start(&s, &token, 1000).await;
    assert!(next_event(&mut my_site, 3000).await.unwrap().contains("event: data"));
    assert!(next_event(&mut my_site, 3000).await.unwrap().contains("event: sweep"));
    assert_eq!(next_event(&mut their_feed, 300).await, None);
    listener.abort();
    drop((device_feed, their_feed, my_site));
    db.close().await;
}

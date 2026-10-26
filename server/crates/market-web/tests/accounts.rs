mod common;
use axum::{
    body::Body,
    http::{HeaderMap, Request, StatusCode},
};
use common::TestDb;
use http_body_util::BodyExt;
use market_web::{app, contributors, AppState, Settings};
use serde_json::{json, Value};
use tower::ServiceExt;

const PASSWORD: &str = "a long unique maple passphrase";
#[tokio::test]
async fn upgrade_keeps_google_owners_and_does_not_refresh_old_authentication() {
    let Some(db) = TestDb::new().await else {
        return;
    };
    let mut tx = db.pool.begin().await.unwrap();
    sqlx::raw_sql("CREATE SCHEMA account_upgrade_fixture; SET LOCAL search_path=account_upgrade_fixture; CREATE TABLE accounts(id bigserial PRIMARY KEY, google_sub text NOT NULL UNIQUE); INSERT INTO accounts(id,google_sub) VALUES(19,'existing-google'); CREATE TABLE account_sessions(token_hash bytea PRIMARY KEY,expires_at timestamptz); INSERT INTO account_sessions VALUES(decode('01','hex'),now()+interval '90 days'); CREATE TABLE google_login_states(state_hash bytea PRIMARY KEY);")
        .execute(&mut *tx).await.unwrap();
    sqlx::raw_sql(include_str!(
        "../../../migrations/0019_application_accounts.sql"
    ))
    .execute(&mut *tx)
    .await
    .unwrap();
    let owner:i64=sqlx::query_scalar("SELECT account_id FROM account_identities WHERE provider='google' AND subject='existing-google'").fetch_one(&mut *tx).await.unwrap();
    assert_eq!(owner, 19);
    let old: bool =
        sqlx::query_scalar("SELECT authenticated_at='epoch'::timestamptz FROM account_sessions")
            .fetch_one(&mut *tx)
            .await
            .unwrap();
    assert!(old);
    sqlx::query("INSERT INTO account_sessions(token_hash,expires_at) VALUES(decode('02','hex'),now()+interval '90 days')").execute(&mut *tx).await.unwrap();
    let recent:bool=sqlx::query_scalar("SELECT authenticated_at>now()-interval '15 minutes' FROM account_sessions WHERE token_hash=decode('02','hex')").fetch_one(&mut *tx).await.unwrap();
    assert!(recent);
    sqlx::query("INSERT INTO accounts(google_sub) VALUES(NULL)")
        .execute(&mut *tx)
        .await
        .unwrap();
    tx.rollback().await.unwrap();
    db.close().await;
}
async fn request(
    state: &AppState,
    method: &str,
    path: &str,
    body: Value,
    cookie: &str,
    csrf: &str,
    origin: bool,
) -> (StatusCode, HeaderMap, Value) {
    let mut req = Request::builder()
        .method(method)
        .uri(path)
        .header("content-type", "application/json");
    if origin {
        req = req.header("origin", "https://mxd.ruit.me");
    }
    if !cookie.is_empty() {
        req = req.header("cookie", cookie);
    }
    if !csrf.is_empty() {
        req = req.header("x-csrf-token", csrf);
    }
    let response = app(state.clone())
        .oneshot(req.body(Body::from(body.to_string())).unwrap())
        .await
        .unwrap();
    let code = response.status();
    let headers = response.headers().clone();
    let bytes = response.into_body().collect().await.unwrap().to_bytes();
    (
        code,
        headers,
        serde_json::from_slice(&bytes).unwrap_or(Value::Null),
    )
}
async fn post(
    state: &AppState,
    path: &str,
    body: Value,
    cookie: &str,
    csrf: &str,
) -> (StatusCode, HeaderMap, Value) {
    request(state, "POST", path, body, cookie, csrf, true).await
}
async fn me(state: &AppState, cookie: &str) -> Value {
    request(
        state,
        "GET",
        "/api/v1/account",
        Value::Null,
        cookie,
        "",
        false,
    )
    .await
    .2
}
async fn signup(state: &AppState, name: &str) -> (String, String, String) {
    let result = post(
        state,
        "/api/v1/account/register",
        json!({"username":name,"password":PASSWORD}),
        "",
        "",
    )
    .await;
    assert_eq!(result.0, StatusCode::OK);
    let cookie = result.1["set-cookie"]
        .to_str()
        .unwrap()
        .split(';')
        .next()
        .unwrap()
        .to_string();
    assert!(result.1["set-cookie"]
        .to_str()
        .unwrap()
        .contains("HttpOnly"));
    let csrf = me(state, &cookie).await["csrf"]
        .as_str()
        .unwrap()
        .to_owned();
    (
        cookie,
        csrf,
        result.2["recovery_code"].as_str().unwrap().to_owned(),
    )
}
fn watch(id: &str, value: Value, version: i64) -> Value {
    json!({"kind":"watch","key":id,"value":value,"version":version})
}
fn settings(cap: i64) -> Value {
    json!({"cap":cap,"notify":true,"position":0})
}

#[tokio::test]
async fn item_filters_are_saved_per_product_and_account() {
    let Some(db) = TestDb::new().await else {
        return;
    };
    let state = AppState::new(db.pool.clone(), Settings::default());
    let (a, csrf, _) = signup(&state, "filter_player").await;
    let (b, _, _) = signup(&state, "other_filter_player").await;
    let pref = |key: &str, value: Value, version: i64| json!({"kind":"pref","key":key,"value":value,"version":version});
    let first = json!({"hours":"6","stats":[{"stat":"dex","min":3}]}).to_string();
    let second = json!({"percentile":"25"}).to_string();
    assert_eq!(
        post(
            &state,
            "/api/v1/account/data",
            json!({"operations":[
                pref("item.offerFilters.1002000",json!(first),0),
                pref("item.offerFilters.1002001",json!(second),0),
                pref("item.showExpired.1002000",json!("false"),0)
            ]}),
            &a,
            &csrf
        )
        .await
        .0,
        StatusCode::OK
    );
    let saved = records(&state, &a).await;
    assert_eq!(saved.as_array().unwrap().len(), 3);
    assert_eq!(
        saved
            .as_array()
            .unwrap()
            .iter()
            .find(|r| r["key"] == "item.offerFilters.1002000")
            .unwrap()["value"],
        first
    );
    assert_eq!(records(&state, &b).await, json!([]));
    assert_eq!(
        post(
            &state,
            "/api/v1/account/data",
            json!({"operations":[pref("item.offerFilters.1002000",Value::Null,1)]}),
            &a,
            &csrf
        )
        .await
        .0,
        StatusCode::OK
    );
    let saved = records(&state, &a).await;
    assert_eq!(
        saved
            .as_array()
            .unwrap()
            .iter()
            .find(|r| r["key"] == "item.offerFilters.1002001")
            .unwrap()["value"],
        second
    );
    assert!(saved
        .as_array()
        .unwrap()
        .iter()
        .find(|r| r["key"] == "item.offerFilters.1002000")
        .unwrap()["value"]
        .is_null());
    assert_eq!(
        post(
            &state,
            "/api/v1/account/data",
            json!({"operations":[pref("item.offerFilters.1002000",json!("{\"hours\":\"2\"}"),2)]}),
            &a,
            &csrf
        )
        .await
        .0,
        StatusCode::BAD_REQUEST
    );
    db.close().await;
}
#[tokio::test]
async fn reminder_rules_sync_with_each_watch_and_reject_time_conditions() {
    let Some(db) = TestDb::new().await else {
        return;
    };
    let state = AppState::new(db.pool.clone(), Settings::default());
    let (cookie, csrf, _) = signup(&state, "reminder_player").await;
    let mut value = settings(200);
    value["reminder"] = json!({"percentile":"10","minPrice":null,"stock":"all","minStock":null,"equipment":"all","stats":[{"stat":"str","min":2}]});
    let result = post(
        &state,
        "/api/v1/account/data",
        json!({"operations":[watch("1452003",value.clone(),0)]}),
        &cookie,
        &csrf,
    )
    .await;
    assert_eq!(result.0, StatusCode::OK);
    assert_eq!(records(&state, &cookie).await[0]["value"], value);
    value["reminder"]["hours"] = json!("1");
    assert_eq!(
        post(
            &state,
            "/api/v1/account/data",
            json!({"operations":[watch("1452003",value,1)]}),
            &cookie,
            &csrf
        )
        .await
        .0,
        StatusCode::BAD_REQUEST
    );
    db.close().await;
}
async fn records(state: &AppState, cookie: &str) -> Value {
    request(
        state,
        "GET",
        "/api/v1/account/data",
        Value::Null,
        cookie,
        "",
        false,
    )
    .await
    .2["records"]
        .clone()
}

#[tokio::test]
async fn application_registration_login_recovery_and_session_revocation() {
    let Some(db) = TestDb::new().await else {
        return;
    };
    let state = AppState::new(db.pool.clone(), Settings::default());
    assert_eq!(
        request(
            &state,
            "POST",
            "/api/v1/account/register",
            json!({"username":"maple","password":PASSWORD}),
            "",
            "",
            false
        )
        .await
        .0,
        StatusCode::FORBIDDEN
    );
    assert_eq!(
        post(
            &state,
            "/api/v1/account/register",
            json!({"username":"maple","password":"short"}),
            "",
            ""
        )
        .await
        .0,
        StatusCode::BAD_REQUEST
    );
    let (cookie, csrf, recovery) = signup(&state, "Maple_User").await;
    let profile = me(&state, &cookie).await;
    assert_eq!(profile["username"], "maple_user");
    assert_eq!(profile["has_password"], true);
    assert_eq!(profile["google_linked"], false);
    assert_eq!(profile["listed"], false);
    assert!(profile.get("password_hash").is_none());
    assert!(profile.get("recovery_code").is_none());
    let encoded: String = sqlx::query_scalar(
        "SELECT password_hash FROM account_passwords WHERE username='maple_user'",
    )
    .fetch_one(&db.pool)
    .await
    .unwrap();
    assert!(encoded.starts_with("$argon2id$"));
    assert_eq!(
        post(
            &state,
            "/api/v1/account/register",
            json!({"username":"maple_user","password":PASSWORD}),
            "",
            ""
        )
        .await
        .0,
        StatusCode::CONFLICT
    );
    assert_eq!(
        post(
            &state,
            "/api/v1/account/login",
            json!({"username":"MAPLE_USER","password":"wrong"}),
            "",
            ""
        )
        .await
        .0,
        StatusCode::UNAUTHORIZED
    );
    let second = post(
        &state,
        "/api/v1/account/login",
        json!({"username":"MAPLE_USER","password":PASSWORD}),
        "",
        "",
    )
    .await;
    assert_eq!(second.0, StatusCode::OK);
    let second_cookie = second.1["set-cookie"]
        .to_str()
        .unwrap()
        .split(';')
        .next()
        .unwrap();
    assert_eq!(
        post(
            &state,
            "/api/v1/account/logout",
            json!({}),
            &cookie,
            "wrong"
        )
        .await
        .0,
        StatusCode::FORBIDDEN
    );
    let new_password = "another long unique maple passphrase";
    let reset = post(
        &state,
        "/api/v1/account/recover",
        json!({"username":"maple_user","recovery_code":recovery,"password":new_password}),
        "",
        "",
    )
    .await;
    assert_eq!(reset.0, StatusCode::OK);
    assert_ne!(reset.2["recovery_code"], recovery);
    assert_eq!(me(&state, &cookie).await["signed_in"], false);
    assert_eq!(me(&state, second_cookie).await["signed_in"], false);
    assert_eq!(
        post(
            &state,
            "/api/v1/account/recover",
            json!({"username":"maple_user","recovery_code":recovery,"password":PASSWORD}),
            "",
            ""
        )
        .await
        .0,
        StatusCode::UNAUTHORIZED
    );
    assert_eq!(
        post(
            &state,
            "/api/v1/account/login",
            json!({"username":"maple_user","password":PASSWORD}),
            "",
            ""
        )
        .await
        .0,
        StatusCode::UNAUTHORIZED
    );
    assert_eq!(
        post(
            &state,
            "/api/v1/account/login",
            json!({"username":"maple_user","password":new_password}),
            "",
            ""
        )
        .await
        .0,
        StatusCode::OK
    );
    assert_eq!(
        request(
            &state,
            "GET",
            "/api/v1/account/data",
            Value::Null,
            &cookie,
            &csrf,
            false
        )
        .await
        .0,
        StatusCode::UNAUTHORIZED
    );
    db.close().await;
}

#[tokio::test]
async fn private_sync_isolated_versioned_atomic_and_deletions_do_not_resurrect() {
    let Some(db) = TestDb::new().await else {
        return;
    };
    let state = AppState::new(db.pool.clone(), Settings::default());
    let (a, csrf_a, _) = signup(&state, "player_a").await;
    let (b, csrf_b, _) = signup(&state, "player_b").await;
    assert_eq!(
        request(
            &state,
            "GET",
            "/api/v1/account/data",
            Value::Null,
            "",
            "",
            false
        )
        .await
        .0,
        StatusCode::UNAUTHORIZED
    );
    let first = watch("4010001", settings(100), 0);
    assert_eq!(
        post(
            &state,
            "/api/v1/account/data",
            json!({"operations":[first]}),
            &a,
            &csrf_b
        )
        .await
        .0,
        StatusCode::FORBIDDEN
    );
    assert_eq!(
        post(
            &state,
            "/api/v1/account/data",
            json!({"operations":[first]}),
            &a,
            &csrf_a
        )
        .await
        .0,
        StatusCode::OK
    );
    assert_eq!(records(&state, &a).await[0]["version"], 1);
    assert_eq!(records(&state, &b).await, json!([]));
    // Conflicting batch must roll back even the preceding, non-conflicting write.
    let conflict = post(
        &state,
        "/api/v1/account/data",
        json!({"operations":[watch("4010002",settings(50),0),watch("4010001",settings(200),0)]}),
        &a,
        &csrf_a,
    )
    .await;
    assert_eq!(conflict.0, StatusCode::CONFLICT);
    assert_eq!(records(&state, &a).await.as_array().unwrap().len(), 1);
    let imported = post(
        &state,
        "/api/v1/account/data/import",
        json!({"operations":[watch("4010001",settings(999),0),watch("4010002",settings(50),0)]}),
        &a,
        &csrf_a,
    )
    .await;
    assert_eq!(imported.0, StatusCode::OK);
    assert_eq!(records(&state, &a).await[0]["value"]["cap"], 100);
    assert_eq!(
        post(
            &state,
            "/api/v1/account/data",
            json!({"operations":[watch("4010001",Value::Null,1)]}),
            &a,
            &csrf_a
        )
        .await
        .0,
        StatusCode::OK
    );
    assert!(records(&state, &a).await[0]["value"].is_null());
    assert_eq!(records(&state, &a).await[0]["version"], 2);
    assert_eq!(
        post(
            &state,
            "/api/v1/account/data",
            json!({"operations":[first]}),
            &a,
            &csrf_a
        )
        .await
        .0,
        StatusCode::CONFLICT
    );
    // Import cannot resurrect a tombstone either.
    assert_eq!(
        post(
            &state,
            "/api/v1/account/data/import",
            json!({"operations":[first]}),
            &a,
            &csrf_a
        )
        .await
        .0,
        StatusCode::OK
    );
    assert!(records(&state, &a).await[0]["value"].is_null());
    let invalid = json!({"operations":[{"kind":"pref","key":"cwm.collector.token","value":"secret","version":0}]});
    assert_eq!(
        post(&state, "/api/v1/account/data", invalid, &a, &csrf_a)
            .await
            .0,
        StatusCode::BAD_REQUEST
    );
    let preference =
        json!({"operations":[{"kind":"pref","key":"theme","value":"dark","version":0}]});
    assert_eq!(
        post(&state, "/api/v1/account/data", preference, &b, &csrf_b)
            .await
            .0,
        StatusCode::OK
    );
    assert!(records(&state, &a)
        .await
        .as_array()
        .unwrap()
        .iter()
        .all(|r| r["kind"] == "watch"));
    // Enforce the same limit for imports and normal saves on the server.
    let many: Vec<Value> = (0..101)
        .map(|i| watch(&(4_010_100 + i).to_string(), settings(1), 0))
        .collect();
    assert_eq!(
        post(
            &state,
            "/api/v1/account/data/import",
            json!({"operations":many}),
            &b,
            &csrf_b
        )
        .await
        .0,
        StatusCode::CONFLICT
    );
    assert_eq!(records(&state, &b).await.as_array().unwrap().len(), 1);
    db.close().await;
}

#[tokio::test]
async fn google_linking_preserves_accounts_rejects_takeover_and_requires_remaining_login() {
    let Some(db) = TestDb::new().await else {
        return;
    };
    let mut state = AppState::new(db.pool.clone(), Settings::default());
    state.google=Some(std::sync::Arc::new(serde_json::from_value(json!({"client_id":"test.apps.googleusercontent.com","client_secret":"test","redirect_uri":"https://mxd.ruit.me/auth/google/callback"})).unwrap()));
    let (a, csrf_a, _) = signup(&state, "native_player").await;
    let a_id: i64 = sqlx::query_scalar(
        "SELECT account_id FROM account_passwords WHERE username='native_player'",
    )
    .fetch_one(&db.pool)
    .await
    .unwrap();
    assert_eq!(
        post(
            &state,
            "/api/v1/account/google/link",
            json!({"current_password":"wrong"}),
            &a,
            &csrf_a
        )
        .await
        .0,
        StatusCode::UNAUTHORIZED
    );
    let start = post(
        &state,
        "/api/v1/account/google/link",
        json!({"current_password":PASSWORD}),
        &a,
        &csrf_a,
    )
    .await;
    assert_eq!(start.0, StatusCode::OK);
    assert!(start.2["url"]
        .as_str()
        .unwrap()
        .starts_with("https://accounts.google.com/"));
    let bound: Option<i64> =
        sqlx::query_scalar("SELECT account_id FROM google_login_states LIMIT 1")
            .fetch_one(&db.pool)
            .await
            .unwrap();
    assert_eq!(bound, Some(a_id));
    assert_eq!(
        contributors::google_account(
            &db.pool,
            "verified-google-a",
            Some((
                a_id,
                market_web::auth::token_hash(a.strip_prefix("cwm_account=").unwrap())
            ))
        )
        .await
        .unwrap(),
        a_id
    );
    assert_eq!(
        contributors::google_account(&db.pool, "verified-google-a", None)
            .await
            .unwrap(),
        a_id
    );
    let b_id = contributors::google_account(&db.pool, "verified-google-b", None)
        .await
        .unwrap();
    assert_ne!(a_id, b_id);
    assert!(contributors::google_account(
        &db.pool,
        "verified-google-b",
        Some((
            a_id,
            market_web::auth::token_hash(a.strip_prefix("cwm_account=").unwrap())
        ))
    )
    .await
    .is_err());
    assert_eq!(me(&state, &a).await["google_linked"], true);
    let google_token = market_web::auth::new_credentials().token;
    contributors::new_session(&db.pool, b_id, &google_token)
        .await
        .unwrap();
    let b_cookie = format!("cwm_account={google_token}");
    let b_csrf = me(&state, &b_cookie).await["csrf"]
        .as_str()
        .unwrap()
        .to_owned();
    assert_eq!(
        post(
            &state,
            "/api/v1/account/google/unlink",
            json!({}),
            &b_cookie,
            &b_csrf
        )
        .await
        .2["error"],
        "last_login_method"
    );
    sqlx::query(
        "UPDATE account_sessions SET authenticated_at=now()-interval '1 hour' WHERE account_id=$1",
    )
    .bind(b_id)
    .execute(&db.pool)
    .await
    .unwrap();
    assert_eq!(
        post(
            &state,
            "/api/v1/account/password",
            json!({"username":"google_player","password":PASSWORD}),
            &b_cookie,
            &b_csrf
        )
        .await
        .2["error"],
        "reauth_required"
    );
    assert_eq!(
        post(
            &state,
            "/api/v1/account/google/unlink",
            json!({"current_password":PASSWORD}),
            &a,
            &csrf_a
        )
        .await
        .0,
        StatusCode::OK
    );
    assert_eq!(me(&state, &a).await["google_linked"], false);
    assert_eq!(post(&state,"/api/v1/account/password",json!({"username":"native_player","password":"changed long maple password","current_password":PASSWORD}),&a,&csrf_a).await.0,StatusCode::OK);
    assert_eq!(me(&state, &a).await["signed_in"], false);
    db.close().await;
}

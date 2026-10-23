mod common;
use axum::{
    body::Body,
    http::{Request, StatusCode},
};
use common::TestDb;
use http_body_util::BodyExt;
use market_web::{app, auth, contributors, unix_now, AppState, Settings};
use serde_json::{json, Value};
use tower::ServiceExt;

async fn request(
    state: &AppState,
    method: &str,
    path: &str,
    body: Value,
    headers: &[(&str, String)],
) -> (StatusCode, axum::http::HeaderMap, Value) {
    let mut req = Request::builder()
        .method(method)
        .uri(path)
        .header("content-type", "application/json");
    for (k, v) in headers {
        req = req.header(*k, v);
    }
    let r = app(state.clone())
        .oneshot(req.body(Body::from(body.to_string())).unwrap())
        .await
        .unwrap();
    let code = r.status();
    let headers = r.headers().clone();
    let bytes = r.into_body().collect().await.unwrap().to_bytes();
    (
        code,
        headers,
        serde_json::from_slice(&bytes).unwrap_or(Value::Null),
    )
}
async fn profile(state: &AppState, token: &str, name: &str, listed: bool) -> StatusCode {
    request(
        state,
        "POST",
        "/api/v1/collector/profile",
        json!({"nickname":name,"listed":listed}),
        &[("authorization", format!("Bearer {token}"))],
    )
    .await
    .0
}
async fn upload(state: &AppState, token: &str, id: &str, shop: i64, when: f64) {
    let body = json!({"version":1,"world":"ClassicWorld","complete":true,"observation_id":id,"observed_at":when,"shop_id":shop,"title":format!("Shop {shop}"),"location":{"channel":30,"room":3},
      "items":[{"item_id":4010001,"category":4,"slot":1,"price":100,"bundle":1,"stock":5}]});
    let result = request(
        state,
        "POST",
        "/api/v1/observations",
        body,
        &[("authorization", format!("Bearer {token}"))],
    )
    .await;
    assert_eq!(result.0, StatusCode::CREATED, "{}", result.2);
}
#[tokio::test]
async fn nickname_board_preserves_identity_deduplicates_and_honors_privacy() {
    let Some(db) = TestDb::new().await else {
        return;
    };
    let state = AppState::new(db.pool.clone(), Settings::default());
    let a = auth::register(&db.pool, "legacy anonymous").await.unwrap();
    let b = auth::register(&db.pool, "other").await.unwrap();
    let now = unix_now();
    upload(&state, &a.token, "a1", 77, now - 120.).await;
    upload(&state, &a.token, "a2", 77, now - 60.).await;
    upload(&state, &a.token, "a3", 78, now - 9. * 86400.).await;
    upload(&state, &b.token, "b1", 79, now - 60.).await;
    let initial = request(&state, "GET", "/api/v1/contributors", Value::Null, &[])
        .await
        .2;
    assert_eq!(initial["contributors"].as_array().unwrap().len(), 2);
    let own = request(
        &state,
        "GET",
        "/api/v1/collector/profile",
        Value::Null,
        &[("authorization", format!("Bearer {}", a.token))],
    )
    .await
    .2;
    assert_eq!(own["temporary"], true);
    assert_eq!(own["listed"], true);
    let alias = own["nickname"].as_str().unwrap();
    assert!(alias.chars().count() >= 4);
    let again = request(
        &state,
        "GET",
        "/api/v1/collector/profile",
        Value::Null,
        &[("authorization", format!("Bearer {}", a.token))],
    )
    .await
    .2;
    assert_eq!(again["nickname"], alias);
    assert_eq!(
        profile(&state, &a.token, "枫叶探路者", true).await,
        StatusCode::OK
    );
    assert_eq!(
        profile(&state, &b.token, "Private", false).await,
        StatusCode::OK
    );
    assert_eq!(
        profile(&state, &a.token, "<script>", true).await,
        StatusCode::BAD_REQUEST
    );
    assert_eq!(
        profile(&state, &"x".repeat(43), "Stolen", true).await,
        StatusCode::UNAUTHORIZED
    );
    let week = request(
        &state,
        "GET",
        "/api/v1/contributors?period=week",
        Value::Null,
        &[],
    )
    .await
    .2;
    assert_eq!(week["contributors"].as_array().unwrap().len(), 1);
    assert_eq!(week["contributors"][0]["shops"], 1);
    assert_eq!(week["contributors"][0]["quotes"], 1);
    let all = request(
        &state,
        "GET",
        "/api/v1/contributors?period=all",
        Value::Null,
        &[],
    )
    .await
    .2;
    assert_eq!(all["contributors"][0]["shops"], 2);
    assert_eq!(all["contributors"][0]["quotes"], 2);
    assert!(!all.to_string().contains(&a.public_id));
    assert!(!all.to_string().contains(&a.token));
    assert_eq!(
        request(
            &state,
            "GET",
            "/api/v1/contributors?period=wrong",
            Value::Null,
            &[]
        )
        .await
        .0,
        StatusCode::BAD_REQUEST
    );
    profile(&state, &a.token, "改名之后", true).await;
    assert_eq!(
        request(&state, "GET", "/api/v1/contributors", Value::Null, &[])
            .await
            .2["contributors"][0]["nickname"],
        "改名之后"
    );
    profile(&state, &a.token, "改名之后", false).await;
    let custom = request(
        &state,
        "GET",
        "/api/v1/collector/profile",
        Value::Null,
        &[("authorization", format!("Bearer {}", a.token))],
    )
    .await
    .2;
    assert_eq!(custom["nickname"], "改名之后");
    assert_eq!(custom["temporary"], false);
    assert_eq!(custom["listed"], false);
    assert_eq!(
        request(&state, "GET", "/api/v1/contributors", Value::Null, &[])
            .await
            .2["contributors"],
        json!([])
    );
    assert!(auth::authenticate(&db.pool, Some(&a.token))
        .await
        .unwrap()
        .is_some());
    db.close().await;
}
#[tokio::test]
async fn temporary_name_migration_backfills_only_unnamed_and_preserves_opt_out() {
    let Some(db) = TestDb::new().await else {
        return;
    };
    let mut tx = db.pool.begin().await.unwrap();
    sqlx::raw_sql("CREATE SCHEMA legacy_fixture; SET LOCAL search_path=legacy_fixture; CREATE TABLE collectors(id serial,nickname text NOT NULL DEFAULT '',listed boolean NOT NULL DEFAULT false); CREATE TABLE accounts(id serial,nickname text NOT NULL DEFAULT '',listed boolean NOT NULL DEFAULT false); INSERT INTO collectors(nickname,listed) VALUES('',false),('Custom private',false),('Custom public',true); INSERT INTO accounts(nickname,listed) VALUES('',false),('Google custom',false);").execute(&mut *tx).await.unwrap();
    sqlx::raw_sql(include_str!(
        "../../../migrations/0018_temporary_nicknames.sql"
    ))
    .execute(&mut *tx)
    .await
    .unwrap();
    let rows: Vec<(String, bool, bool)> =
        sqlx::query_as("SELECT nickname,listed,nickname_temporary FROM collectors ORDER BY id")
            .fetch_all(&mut *tx)
            .await
            .unwrap();
    assert!(!rows[0].0.is_empty());
    assert_eq!((rows[0].1, rows[0].2), (true, true));
    assert_eq!(rows[1], ("Custom private".into(), false, false));
    assert_eq!(rows[2], ("Custom public".into(), true, false));
    let default: (String, bool, bool) = sqlx::query_as(
        "INSERT INTO collectors DEFAULT VALUES RETURNING nickname,listed,nickname_temporary",
    )
    .fetch_one(&mut *tx)
    .await
    .unwrap();
    assert!(!default.0.is_empty());
    assert_eq!((default.1, default.2), (true, true));
    tx.rollback().await.unwrap();
    db.close().await;
}
#[tokio::test]
async fn account_link_requires_session_csrf_one_time_code_and_existing_owner() {
    let Some(db) = TestDb::new().await else {
        return;
    };
    let state = AppState::new(db.pool.clone(), Settings::default());
    let collector = auth::register(&db.pool, "old").await.unwrap();
    let other = auth::register(&db.pool, "second device").await.unwrap();
    profile(&state, &collector.token, "OldNickname", true).await;
    let c = auth::authenticate(&db.pool, Some(&collector.token))
        .await
        .unwrap()
        .unwrap();
    let a: i64 = sqlx::query_scalar(
        "INSERT INTO accounts(public_id,google_sub) VALUES('test-a','fake-google-a') RETURNING id",
    )
    .fetch_one(&db.pool)
    .await
    .unwrap();
    let b: i64 = sqlx::query_scalar(
        "INSERT INTO accounts(public_id,google_sub) VALUES('test-b','fake-google-b') RETURNING id",
    )
    .fetch_one(&db.pool)
    .await
    .unwrap();
    let credentials = auth::new_credentials();
    contributors::new_session(&db.pool, a, &credentials.token)
        .await
        .unwrap();
    let cookie = ("cookie", format!("cwm_account={}", credentials.token));
    let me = request(
        &state,
        "GET",
        "/api/v1/account",
        Value::Null,
        std::slice::from_ref(&cookie),
    )
    .await
    .2;
    let headers = [
        cookie.clone(),
        ("origin", "https://mxd.ruit.me".into()),
        ("x-csrf-token", me["csrf"].as_str().unwrap().into()),
    ];
    let code = auth::new_credentials().token;
    sqlx::query(
        "INSERT INTO collector_account_links VALUES($1,$2,now()+interval '10 minutes',NULL)",
    )
    .bind(auth::token_hash(&code))
    .bind(c.id)
    .execute(&db.pool)
    .await
    .unwrap();
    assert_eq!(
        request(
            &state,
            "POST",
            "/api/v1/account/link",
            json!({"code":code}),
            &[]
        )
        .await
        .0,
        StatusCode::UNAUTHORIZED
    );
    assert_eq!(
        request(
            &state,
            "POST",
            "/api/v1/account/link",
            json!({"code":code}),
            std::slice::from_ref(&cookie)
        )
        .await
        .0,
        StatusCode::FORBIDDEN
    );
    let mut wrong = headers.clone();
    wrong[1].1 = "https://evil.example".into();
    assert_eq!(
        request(
            &state,
            "POST",
            "/api/v1/account/link",
            json!({"code":code}),
            &wrong
        )
        .await
        .0,
        StatusCode::FORBIDDEN
    );
    assert_eq!(
        request(
            &state,
            "POST",
            "/api/v1/account/link",
            json!({"code":code}),
            &headers
        )
        .await
        .0,
        StatusCode::OK
    );
    assert_eq!(
        request(
            &state,
            "POST",
            "/api/v1/account/link",
            json!({"code":code}),
            &headers
        )
        .await
        .0,
        StatusCode::CONFLICT
    );
    assert_eq!(
        request(
            &state,
            "GET",
            "/api/v1/account",
            Value::Null,
            std::slice::from_ref(&cookie)
        )
        .await
        .2["nickname"],
        "OldNickname"
    );
    assert_eq!(
        profile(&state, &collector.token, "Cannot rename account", true).await,
        StatusCode::CONFLICT
    );
    // The same known shop from two owned collectors counts once.
    let c2 = auth::authenticate(&db.pool, Some(&other.token))
        .await
        .unwrap()
        .unwrap();
    sqlx::query("UPDATE collectors SET account_id=$1 WHERE id=$2")
        .bind(a)
        .bind(c2.id)
        .execute(&db.pool)
        .await
        .unwrap();
    let now = unix_now();
    upload(&state, &collector.token, "same1", 99, now - 100.).await;
    upload(&state, &other.token, "same2", 99, now - 50.).await;
    assert_eq!(
        request(&state, "GET", "/api/v1/contributors", Value::Null, &[])
            .await
            .2["contributors"][0]["quotes"],
        1
    );
    // Another account cannot take ownership even with a newly issued link.
    let second = auth::new_credentials();
    contributors::new_session(&db.pool, b, &second.token)
        .await
        .unwrap();
    let other_cookie = ("cookie", format!("cwm_account={}", second.token));
    let other_me = request(
        &state,
        "GET",
        "/api/v1/account",
        Value::Null,
        std::slice::from_ref(&other_cookie),
    )
    .await
    .2;
    let other_headers = [
        other_cookie,
        ("origin", "https://mxd.ruit.me".into()),
        ("x-csrf-token", other_me["csrf"].as_str().unwrap().into()),
    ];
    let fresh = auth::new_credentials().token;
    sqlx::query(
        "INSERT INTO collector_account_links VALUES($1,$2,now()+interval '10 minutes',NULL)",
    )
    .bind(auth::token_hash(&fresh))
    .bind(c.id)
    .execute(&db.pool)
    .await
    .unwrap();
    assert_eq!(
        request(
            &state,
            "POST",
            "/api/v1/account/link",
            json!({"code":fresh}),
            &other_headers
        )
        .await
        .0,
        StatusCode::CONFLICT
    );
    sqlx::query("UPDATE collector_account_links SET expires_at=now()-interval '1 second' WHERE code_hash=$1").bind(auth::token_hash(&fresh)).execute(&db.pool).await.unwrap();
    assert_eq!(
        request(
            &state,
            "POST",
            "/api/v1/account/link",
            json!({"code":fresh}),
            &headers
        )
        .await
        .0,
        StatusCode::CONFLICT
    );
    assert_eq!(
        request(
            &state,
            "POST",
            "/api/v1/account",
            json!({"nickname":"GoogleNickname","listed":true}),
            &headers
        )
        .await
        .0,
        StatusCode::OK
    );
    let logout = request(
        &state,
        "POST",
        "/api/v1/account/logout",
        json!({}),
        &headers,
    )
    .await;
    assert_eq!(logout.0, StatusCode::OK);
    assert!(logout.1["set-cookie"]
        .to_str()
        .unwrap()
        .contains("Max-Age=0"));
    assert_eq!(
        request(&state, "GET", "/api/v1/account", Value::Null, &[cookie])
            .await
            .2["signed_in"],
        false
    );
    db.close().await;
}
#[tokio::test]
async fn google_start_uses_pkce_nonce_and_single_browser_state() {
    let Some(db) = TestDb::new().await else {
        return;
    };
    let mut state = AppState::new(db.pool.clone(), Settings::default());
    state.google=Some(std::sync::Arc::new(serde_json::from_value(json!({"client_id":"test.apps.googleusercontent.com","client_secret":"test-only","redirect_uri":"https://mxd.ruit.me/auth/google/callback"})).unwrap()));
    let result = request(&state, "GET", "/auth/google/start", Value::Null, &[]).await;
    assert_eq!(result.0, StatusCode::SEE_OTHER);
    let url = url::Url::parse(result.1["location"].to_str().unwrap()).unwrap();
    let params: std::collections::HashMap<_, _> = url.query_pairs().collect();
    assert_eq!(params["scope"], "openid");
    assert_eq!(params["code_challenge_method"], "S256");
    assert_eq!(
        params["redirect_uri"],
        "https://mxd.ruit.me/auth/google/callback"
    );
    assert_eq!(params["nonce"].len(), 43);
    assert!(!url.as_str().contains("test-only"));
    assert!(result.1["set-cookie"]
        .to_str()
        .unwrap()
        .contains("Secure; HttpOnly; SameSite=Lax"));
    let rejected = request(
        &state,
        "GET",
        &format!(
            "/auth/google/callback?code=forged&state={}",
            params["state"]
        ),
        Value::Null,
        &[("cookie", format!("cwm_google_state={}", "x".repeat(43)))],
    )
    .await;
    assert!(rejected.1["location"]
        .to_str()
        .unwrap()
        .contains("login_failed"));
    let count: i64 = sqlx::query_scalar("SELECT count(*) FROM accounts")
        .fetch_one(&db.pool)
        .await
        .unwrap();
    assert_eq!(count, 0);
    db.close().await;
}

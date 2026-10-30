//! Push subscription endpoints. Writes need the site session and its CSRF token.
#![allow(clippy::result_large_err)]

use axum::{
    extract::{rejection::JsonRejection, DefaultBodyLimit, State},
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    routing::{get, post},
    Json, Router,
};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use serde_json::json;
use sqlx::FromRow;

use super::{
    client::{Delivery, Message, Stored, WebPush},
    crypto,
};
use crate::{
    auth,
    contributors::{cookie, error, internal, session, writable, SESSION},
    AppState,
};

/// Older subscriptions beyond this many per account are removed.
const PER_ACCOUNT: i64 = 10;

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/api/v1/push/config", get(config))
        .route("/api/v1/account/push", get(list))
        .route("/api/v1/account/push/subscribe", post(subscribe))
        .route("/api/v1/account/push/unsubscribe", post(unsubscribe))
        .route("/api/v1/account/push/test", post(test))
        .layer(DefaultBodyLimit::max(8 * 1024))
}

fn invalid() -> Response {
    error(StatusCode::BAD_REQUEST, "invalid_request")
}

fn enabled(state: &AppState) -> Result<&WebPush, Response> {
    state
        .push
        .as_deref()
        .ok_or_else(|| error(StatusCode::SERVICE_UNAVAILABLE, "push_unavailable"))
}

async fn config(State(state): State<AppState>) -> Response {
    match &state.push {
        Some(push) => {
            Json(json!({"enabled": true, "public_key": push.public_key()})).into_response()
        }
        None => Json(json!({"enabled": false})).into_response(),
    }
}

#[derive(Serialize, FromRow)]
struct Listed {
    id: String,
    label: String,
    lang: String,
    created_at: DateTime<Utc>,
    last_sent_at: Option<DateTime<Utc>>,
}

async fn list(State(state): State<AppState>, headers: HeaderMap) -> Response {
    let account = match session(&state, &headers).await {
        Ok(Some(s)) => s.id,
        Ok(None) => return error(StatusCode::UNAUTHORIZED, "login_required"),
        Err(e) => return e,
    };
    let rows: Vec<Listed> = match sqlx::query_as(
        "SELECT p.public_id AS id,p.label,p.lang,p.created_at,p.last_sent_at FROM push_subscriptions p
         JOIN account_sessions s ON s.token_hash=p.session_hash
         WHERE p.account_id=$1 AND s.expires_at>now() ORDER BY p.created_at,p.id",
    )
    .bind(account)
    .fetch_all(&state.db)
    .await
    {
        Ok(rows) => rows,
        Err(e) => return internal(e),
    };
    Json(json!({"subscriptions": rows})).into_response()
}

#[derive(Deserialize)]
struct Keys {
    p256dh: String,
    auth: String,
}

/// `PushSubscription.toJSON()` plus a device label and language; other
/// fields such as `expirationTime` are ignored.
#[derive(Deserialize)]
struct SubscribeInput {
    endpoint: String,
    keys: Keys,
    #[serde(default)]
    label: String,
    #[serde(default)]
    lang: Option<String>,
}

fn base64url(value: &str, len: usize) -> Option<Vec<u8>> {
    URL_SAFE_NO_PAD
        .decode(value.trim_end_matches('='))
        .ok()
        .filter(|bytes| bytes.len() == len)
}

struct NewSubscription {
    endpoint: String,
    p256dh: Vec<u8>,
    auth: Vec<u8>,
    label: String,
    lang: &'static str,
}

fn validate(push: &WebPush, input: SubscribeInput) -> Option<NewSubscription> {
    let p256dh = base64url(&input.keys.p256dh, crypto::PUBLIC_KEY_LEN)?;
    crypto::subscriber_key(&p256dh).ok()?;
    let label = input.label.trim();
    Some(NewSubscription {
        auth: base64url(&input.keys.auth, crypto::AUTH_SECRET_LEN)?,
        lang: match input.lang.as_deref() {
            None | Some("zh") => "zh",
            Some("en") => "en",
            Some(_) => return None,
        },
        label: crate::devices::valid_text(label, 40).then(|| label.to_owned())?,
        endpoint: push
            .endpoint_allowed(&input.endpoint)
            .then_some(input.endpoint)?,
        p256dh,
    })
}

async fn subscribe(
    State(state): State<AppState>,
    headers: HeaderMap,
    body: Result<Json<SubscribeInput>, JsonRejection>,
) -> Response {
    let account = match writable(&state, &headers).await {
        Ok(s) => s.id,
        Err(e) => return e,
    };
    let push = match enabled(&state) {
        Ok(push) => push,
        Err(e) => return e,
    };
    let Some(new) = body.ok().and_then(|Json(input)| validate(push, input)) else {
        return invalid();
    };
    if !state
        .limiter
        .allow(&format!("push-subscribe:{account}"), 20)
    {
        return error(StatusCode::TOO_MANY_REQUESTS, "rate_limited");
    }
    let session_hash = auth::token_hash(cookie(&headers, SESSION).unwrap_or_default());
    match save(&state, account, &session_hash, new).await {
        Ok(Some(id)) => Json(json!({"id": id})).into_response(),
        Ok(None) => error(StatusCode::UNAUTHORIZED, "login_required"),
        Err(e) => internal(e),
    }
}

/// One row per endpoint: a browser that signs in to another account moves its
/// subscription there. `None` when the session ended meanwhile.
async fn save(
    state: &AppState,
    account: i64,
    session_hash: &[u8],
    new: NewSubscription,
) -> sqlx::Result<Option<String>> {
    let mut tx = state.db.begin().await?;
    sqlx::query("SELECT id FROM accounts WHERE id=$1 FOR UPDATE")
        .bind(account)
        .execute(&mut *tx)
        .await?;
    let saved = sqlx::query_scalar(
        "INSERT INTO push_subscriptions(public_id,account_id,session_hash,endpoint,p256dh,auth,label,lang)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8)
         ON CONFLICT(endpoint) DO UPDATE SET
           public_id=CASE WHEN push_subscriptions.account_id=EXCLUDED.account_id
             THEN push_subscriptions.public_id ELSE EXCLUDED.public_id END,
           created_at=CASE WHEN push_subscriptions.account_id=EXCLUDED.account_id
             THEN push_subscriptions.created_at ELSE now() END,
           last_sent_at=CASE WHEN push_subscriptions.account_id=EXCLUDED.account_id
             THEN push_subscriptions.last_sent_at END,
           account_id=EXCLUDED.account_id,session_hash=EXCLUDED.session_hash,p256dh=EXCLUDED.p256dh,
           auth=EXCLUDED.auth,label=EXCLUDED.label,lang=EXCLUDED.lang
         RETURNING public_id",
    )
    .bind(auth::new_credentials().public_id)
    .bind(account)
    .bind(session_hash)
    .bind(&new.endpoint)
    .bind(&new.p256dh)
    .bind(&new.auth)
    .bind(&new.label)
    .bind(new.lang)
    .fetch_one(&mut *tx)
    .await;
    let id: String = match saved {
        Ok(id) => id,
        Err(e)
            if e.as_database_error()
                .is_some_and(|d| d.is_foreign_key_violation()) =>
        {
            return Ok(None)
        }
        Err(e) => return Err(e),
    };
    sqlx::query(
        "DELETE FROM push_subscriptions WHERE id IN (SELECT id FROM push_subscriptions
         WHERE account_id=$1 ORDER BY created_at DESC,id DESC OFFSET $2)",
    )
    .bind(account)
    .bind(PER_ACCOUNT)
    .execute(&mut *tx)
    .await?;
    tx.commit().await?;
    Ok(Some(id))
}

#[derive(Deserialize)]
struct Target {
    #[serde(default)]
    id: Option<String>,
    #[serde(default)]
    endpoint: Option<String>,
}

/// Removing a subscription works even while push is switched off.
async fn unsubscribe(
    State(state): State<AppState>,
    headers: HeaderMap,
    body: Result<Json<Target>, JsonRejection>,
) -> Response {
    let account = match writable(&state, &headers).await {
        Ok(s) => s.id,
        Err(e) => return e,
    };
    let Ok(Json(target)) = body else {
        return invalid();
    };
    let nonempty = |v: Option<String>| v.filter(|s| !s.is_empty() && s.len() <= 1024);
    let (id, endpoint) = (nonempty(target.id), nonempty(target.endpoint));
    if id.is_none() && endpoint.is_none() {
        return invalid();
    }
    match sqlx::query(
        "DELETE FROM push_subscriptions WHERE account_id=$1 AND (public_id=$2 OR endpoint=$3)",
    )
    .bind(account)
    .bind(id)
    .bind(endpoint)
    .execute(&state.db)
    .await
    {
        Ok(_) => Json(json!({"ok": true})).into_response(),
        Err(e) => internal(e),
    }
}

#[derive(Deserialize)]
struct TestInput {
    id: String,
}

fn test_message(lang: &str) -> Message {
    let (title, body) = if lang == "en" {
        ("Test notification", "Push notifications are on")
    } else {
        ("测试推送", "推送已开启")
    };
    Message::new(title, body, "/watch", "push-test")
}

/// Sends one message now. An unknown or removed id answers like an expired one,
/// so the page can offer to subscribe again.
async fn test(
    State(state): State<AppState>,
    headers: HeaderMap,
    body: Result<Json<TestInput>, JsonRejection>,
) -> Response {
    let account = match writable(&state, &headers).await {
        Ok(s) => s.id,
        Err(e) => return e,
    };
    let push = match enabled(&state) {
        Ok(push) => push,
        Err(e) => return e,
    };
    let Ok(Json(TestInput { id })) = body else {
        return invalid();
    };
    if id.is_empty() || id.len() > 64 {
        return invalid();
    }
    if !state.limiter.allow(&format!("push-test:{id}"), 3) {
        return error(StatusCode::TOO_MANY_REQUESTS, "rate_limited");
    }
    let found: Option<Stored> = match sqlx::query_as(&format!(
        "SELECT {} FROM push_subscriptions p JOIN account_sessions s ON s.token_hash=p.session_hash
         WHERE p.account_id=$1 AND p.public_id=$2 AND s.expires_at>now()",
        Stored::COLUMNS
    ))
    .bind(account)
    .bind(&id)
    .fetch_optional(&state.db)
    .await
    {
        Ok(found) => found,
        Err(e) => return internal(e),
    };
    let Some(subscription) = found else {
        return error(StatusCode::GONE, "push_expired");
    };
    let outcome = push
        .send(&subscription.target(), &test_message(&subscription.lang))
        .await;
    let update = match outcome {
        Delivery::Sent => "UPDATE push_subscriptions SET last_sent_at=now() WHERE id=$1",
        Delivery::Gone => "DELETE FROM push_subscriptions WHERE id=$1",
        Delivery::Busy | Delivery::Failed => return error(StatusCode::BAD_GATEWAY, "push_failed"),
    };
    if let Err(e) = sqlx::query(update)
        .bind(subscription.id)
        .execute(&state.db)
        .await
    {
        return internal(e);
    }
    match outcome {
        Delivery::Sent => Json(json!({"ok": true})).into_response(),
        _ => error(StatusCode::GONE, "push_expired"),
    }
}

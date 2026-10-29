//! Collector devices of an account: browser login with a one-time code and
//! PKCE (RFC 8252 / 7636), `cwd_` bearer tokens stored as sha256, the device's
//! slice of account data, reported local state and revocation.
#![allow(clippy::result_large_err)]
use crate::{
    accounts::{self, Record},
    api::{bearer, ClientAddr},
    auth,
    contributors::{self as identity, error, internal, session, writable},
    realtime::notify,
    AppState,
};
use axum::{
    extract::{DefaultBodyLimit, State},
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    routing::{get, post},
    Json, Router,
};
use base64::Engine;
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use sqlx::{FromRow, PgConnection, PgPool};

const MAX_AMOUNT: u64 = 1_000_000_000_000;

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/api/v1/device/authorize", post(authorize))
        .route("/api/v1/device/token", post(token))
        .route("/api/v1/device/migrate", post(migrate))
        .route("/api/v1/device/logout", post(logout))
        .route("/api/v1/device/account", get(account))
        .route("/api/v1/device/data", get(data).post(save_data))
        .route("/api/v1/device/state", post(save_state))
        .route("/api/v1/account/devices", get(list))
        .route("/api/v1/account/devices/revoke", post(revoke_device))
        .route("/api/v1/account/events", get(crate::realtime::account_events))
        .layer(DefaultBodyLimit::max(64 * 1024))
}

fn base64url(s: &str) -> bool {
    s.bytes()
        .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}
/// Only the collector's own loopback callback.
fn valid_redirect(uri: &str) -> bool {
    uri.strip_prefix("http://127.0.0.1:")
        .and_then(|rest| rest.strip_suffix("/callback"))
        .is_some_and(|port| {
            !port.starts_with('0')
                && port.len() <= 5
                && port.bytes().all(|b| b.is_ascii_digit())
                && port.parse::<u32>().is_ok_and(|p| (1024..=65535).contains(&p))
        })
}
fn valid_challenge(s: &str) -> bool {
    s.len() == 43 && base64url(s)
}
fn valid_verifier(s: &str) -> bool {
    (43..=128).contains(&s.len())
        && s.bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"-._~".contains(&b))
}
fn challenge_of(verifier: &str) -> String {
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()))
}
pub(crate) fn valid_text(s: &str, max: usize) -> bool {
    s.chars().count() <= max && !s.chars().any(char::is_control)
}
fn valid_version(s: &str) -> bool {
    s.len() <= 32
        && s.bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"._+-".contains(&b))
}
fn token_shape(t: &str) -> bool {
    t.len() == 47 && t.starts_with("cwd_") && base64url(&t[4..])
}
/// Private game holdings, reported by the account's own collector.
fn valid_holdings(v: &Value) -> bool {
    if v.is_null() { return true; }
    let Some(o) = v.as_object() else { return false; };
    o.len() == 4
        && o.get("observed_at").and_then(Value::as_u64).is_some_and(|n| n > 0 && n <= (Utc::now().timestamp() + 60) as u64)
        && o.get("mesos").is_some_and(|v| v.is_null() || v.as_u64().is_some_and(|n| n <= MAX_AMOUNT))
        && o.get("categories").and_then(Value::as_array).is_some_and(|a| a.len() <= 5 && a.iter().all(|v| v.as_u64().is_some_and(|n| (1..=5).contains(&n))))
        && o.get("items").and_then(Value::as_array).is_some_and(|a| a.len() <= 1000 && a.iter().all(|v| v.as_object().is_some_and(|i|
            i.len() == 2 && i.get("item_id").and_then(Value::as_u64).is_some_and(|n| (1000000..=5999999).contains(&n))
            && i.get("quantity").and_then(Value::as_u64).is_some_and(|n| n <= 1000000000))))
}

/// The `DeviceState` a collector reports; only the collector changes it.
fn valid_state(v: &Value) -> bool {
    let amount = |v: Option<&Value>| v.and_then(Value::as_u64).is_some_and(|n| n <= MAX_AMOUNT);
    let flag = |v: Option<&Value>| v.is_some_and(Value::is_boolean);
    v.as_object().is_some_and(|o| {
        o.len() == 2
            && o.get("client_version").and_then(Value::as_str).is_some_and(valid_version)
            && o.get("sweep").and_then(Value::as_object).is_some_and(|s| {
                (s.len() == 6 + usize::from(s.contains_key("holdings")) + usize::from(s.contains_key("recent_scan")))
                    && s.get("holdings").is_none_or(valid_holdings)
                    && s.get("recent_scan").is_none_or(Value::is_boolean)
                    && flag(s.get("allow_web_start"))
                    && ["max_spend", "max_order", "reserve_mesos"].iter().all(|k| amount(s.get(*k)))
                    && s.get("executor").and_then(Value::as_object).is_some_and(|e| {
                        flag(e.get("ready"))
                            && e.keys().all(|k| k == "ready" || k == "reason")
                            && e.get("reason").is_none_or(|r| r.as_str().is_some_and(|r| valid_text(r, 80)))
                    })
                    && s.get("game").and_then(Value::as_object)
                        .is_some_and(|g| g.len() == 1 && flag(g.get("connected")))
            })
    })
}

pub(crate) struct Device {
    pub(crate) id: i64,
    pub(crate) public_id: String,
    pub(crate) account: i64,
    pub(crate) name: String,
    collector: Option<i64>,
}
/// The signed-in device of a `cwd_` bearer token. Unused for 90 days or revoked: none.
pub(crate) async fn device(state: &AppState, headers: &HeaderMap) -> Result<Device, Response> {
    let denied = || error(StatusCode::UNAUTHORIZED, "login_required");
    let token = bearer(headers).filter(|t| token_shape(t)).ok_or_else(denied)?;
    let row: Option<(i64, String, i64, String, Option<i64>, bool)> = sqlx::query_as("SELECT id,public_id,account_id,name,collector_id,last_seen_at<now()-interval '30 seconds' FROM account_devices WHERE token_hash=$1 AND revoked_at IS NULL AND last_seen_at>now()-interval '90 days'")
        .bind(auth::token_hash(token)).fetch_optional(&state.db).await.map_err(internal)?;
    let (id, public_id, account, name, collector, stale) = row.ok_or_else(denied)?;
    if !state.limiter.allow(&format!("device:{id}"), 600) {
        return Err(error(StatusCode::TOO_MANY_REQUESTS, "rate_limited"));
    }
    // At most one write per 30 seconds; `online` allows a 75 second gap.
    if stale {
        sqlx::query("UPDATE account_devices SET last_seen_at=now() WHERE id=$1")
            .bind(id).execute(&state.db).await.map_err(internal)?;
    }
    Ok(Device { id, public_id, account, name, collector })
}

#[derive(Serialize, FromRow)]
pub(crate) struct DeviceRow {
    id: String,
    name: String,
    created_at: DateTime<Utc>,
    last_seen_at: DateTime<Utc>,
    online: bool,
    client_version: String,
    state: Option<Value>,
}
pub(crate) async fn device_list(db: &mut PgConnection, account: i64) -> sqlx::Result<Vec<DeviceRow>> {
    sqlx::query_as("SELECT public_id AS id,name,created_at,last_seen_at,last_seen_at>now()-interval '75 seconds' AS online,client_version,state FROM account_devices WHERE account_id=$1 AND revoked_at IS NULL AND last_seen_at>now()-interval '90 days' ORDER BY created_at,id")
        .bind(account).fetch_all(db).await
}
/// Revokes one or every device of an account; running sweeps record them as left.
pub(crate) async fn revoke(
    tx: &mut PgConnection,
    account: i64,
    device: Option<i64>,
    reason: &str,
) -> sqlx::Result<()> {
    let left = sqlx::query("UPDATE sweep_run_devices p SET state='left',message=$3,lease_hash=NULL FROM sweep_runs r,account_devices d WHERE r.id=p.run_id AND r.status='running' AND d.id=p.device_id AND d.account_id=$1 AND d.revoked_at IS NULL AND ($2::bigint IS NULL OR d.id=$2) AND p.state IN ('invited','active')")
        .bind(account).bind(device).bind(reason).execute(&mut *tx).await?.rows_affected();
    let revoked = sqlx::query("UPDATE account_devices SET revoked_at=now() WHERE account_id=$1 AND revoked_at IS NULL AND ($2::bigint IS NULL OR id=$2)")
        .bind(account).bind(device).execute(&mut *tx).await?.rows_affected();
    if revoked > 0 {
        notify(tx, account, "devices").await?;
    }
    if left > 0 {
        notify(tx, account, "sweep").await?;
    }
    Ok(())
}
async fn lock_account(tx: &mut PgConnection, account: i64) -> Result<(), Response> {
    sqlx::query("SELECT id FROM accounts WHERE id=$1 FOR UPDATE")
        .bind(account).execute(tx).await.map_err(internal).map(|_| ())
}
async fn account_json(db: &PgPool, account: i64) -> Result<Value, Response> {
    let (id, nickname): (String, String) = sqlx::query_as("SELECT public_id,nickname FROM accounts WHERE id=$1")
        .bind(account).fetch_one(db).await.map_err(internal)?;
    Ok(json!({"id":id,"nickname":nickname}))
}

#[derive(Deserialize)]
struct Authorize {
    redirect_uri: String,
    challenge: String,
    name: String,
}
async fn authorize(State(state): State<AppState>, headers: HeaderMap, Json(input): Json<Authorize>) -> Result<Response, Response> {
    let s = writable(&state, &headers).await?;
    if !state.limiter.allow(&format!("device-authorize:{}", s.id), 10) {
        return Err(error(StatusCode::TOO_MANY_REQUESTS, "rate_limited"));
    }
    let name = input.name.trim();
    if !valid_redirect(&input.redirect_uri) || !valid_challenge(&input.challenge) || name.is_empty() || !valid_text(name, 40) {
        return Err(error(StatusCode::BAD_REQUEST, "invalid_request"));
    }
    let code = auth::new_credentials().token;
    sqlx::query("DELETE FROM device_authorizations WHERE expires_at<now()").execute(&state.db).await.map_err(internal)?;
    sqlx::query("INSERT INTO device_authorizations(code_hash,account_id,challenge,redirect_uri,name,expires_at) VALUES($1,$2,$3,$4,$5,now()+interval '5 minutes')")
        .bind(auth::token_hash(&code)).bind(s.id).bind(&input.challenge).bind(&input.redirect_uri).bind(name)
        .execute(&state.db).await.map_err(internal)?;
    Ok(Json(json!({"code":code})).into_response())
}

/// Inserts a device and returns its public id and its token, shown only once.
async fn insert_device(
    tx: &mut PgConnection,
    account: i64,
    name: &str,
    collector: Option<i64>,
    version: &str,
) -> Result<(String, String), Response> {
    let token = format!("cwd_{}", auth::new_credentials().token);
    let id = auth::new_credentials().public_id;
    sqlx::query("INSERT INTO account_devices(public_id,account_id,collector_id,name,token_hash,client_version) VALUES($1,$2,$3,$4,$5,$6)")
        .bind(&id).bind(account).bind(collector).bind(name).bind(auth::token_hash(&token)).bind(version)
        .execute(&mut *tx).await.map_err(internal)?;
    notify(tx, account, "devices").await.map_err(internal)?;
    Ok((id, token))
}
async fn issued(state: &AppState, account: i64, (id, token): (String, String), name: &str) -> Result<Response, Response> {
    let account = account_json(&state.db, account).await?;
    Ok(Json(json!({"token":token,"device":{"id":id,"name":name},"account":account})).into_response())
}

#[derive(Deserialize)]
struct TokenRequest {
    code: String,
    verifier: String,
    redirect_uri: String,
    #[serde(default)]
    client_version: String,
}
async fn token(
    State(state): State<AppState>,
    ClientAddr(addr): ClientAddr,
    headers: HeaderMap,
    Json(input): Json<TokenRequest>,
) -> Result<Response, Response> {
    if !state.limiter.allow(&format!("device-token:{addr}"), 20) {
        return Err(error(StatusCode::TOO_MANY_REQUESTS, "rate_limited"));
    }
    if !valid_version(&input.client_version) {
        return Err(error(StatusCode::BAD_REQUEST, "invalid_request"));
    }
    let grant = || error(StatusCode::BAD_REQUEST, "invalid_grant");
    if input.code.len() != 43 || !base64url(&input.code) {
        return Err(grant());
    }
    // Consumed before it is checked, so a failed exchange cannot be retried.
    let found: Option<(i64, String, String, String)> = sqlx::query_as("UPDATE device_authorizations SET used_at=now() WHERE code_hash=$1 AND used_at IS NULL AND expires_at>now() RETURNING account_id,challenge,redirect_uri,name")
        .bind(auth::token_hash(&input.code)).fetch_optional(&state.db).await.map_err(internal)?;
    let (account, challenge, redirect, name) = found.ok_or_else(grant)?;
    if !valid_verifier(&input.verifier) || input.redirect_uri != redirect || challenge_of(&input.verifier) != challenge {
        return Err(grant());
    }
    let collector = auth::authenticate(&state.db, bearer(&headers)).await.map_err(internal)?;
    let mut tx = state.db.begin().await.map_err(internal)?;
    // A collector owned by another account keeps its contribution owner.
    let linked = match collector {
        Some(c) => {
            sqlx::query("UPDATE collectors SET device_token_issued_at=coalesce(device_token_issued_at,now()) WHERE id=$1")
                .bind(c.id).execute(&mut *tx).await.map_err(internal)?;
            identity::link_collector(&mut tx, c.id, account).await.map_err(internal)?.then_some(c.id)
        }
        None => None,
    };
    let device = insert_device(&mut tx, account, &name, linked, &input.client_version).await?;
    tx.commit().await.map_err(internal)?;
    issued(&state, account, device, &name).await
}

/// Signed-in collectors from before device login get one device without a browser.
async fn migrate(State(state): State<AppState>, ClientAddr(addr): ClientAddr, headers: HeaderMap) -> Result<Response, Response> {
    if !state.limiter.allow(&format!("device-migrate:{addr}"), 10) {
        return Err(error(StatusCode::TOO_MANY_REQUESTS, "rate_limited"));
    }
    let denied = || error(StatusCode::UNAUTHORIZED, "login_required");
    let c = auth::authenticate(&state.db, bearer(&headers)).await.map_err(internal)?.ok_or_else(denied)?;
    let mut tx = state.db.begin().await.map_err(internal)?;
    // The collector row lock makes "never exchanged a device token" a single-use check.
    let row: Option<(Option<i64>, bool)> = sqlx::query_as("SELECT account_id,device_token_issued_at IS NOT NULL FROM collectors WHERE id=$1 AND active FOR UPDATE")
        .bind(c.id).fetch_optional(&mut *tx).await.map_err(internal)?;
    let (account, used) = row.ok_or_else(denied)?;
    let account = account.filter(|_| !used).ok_or_else(denied)?;
    sqlx::query("UPDATE collectors SET device_token_issued_at=now() WHERE id=$1")
        .bind(c.id).execute(&mut *tx).await.map_err(internal)?;
    let device = insert_device(&mut tx, account, "采集器", Some(c.id), "").await?;
    tx.commit().await.map_err(internal)?;
    issued(&state, account, device, "采集器").await
}

async fn logout(State(state): State<AppState>, headers: HeaderMap) -> Result<Response, Response> {
    let d = device(&state, &headers).await?;
    let mut tx = state.db.begin().await.map_err(internal)?;
    if let Some(c) = d.collector {
        sqlx::query("UPDATE collectors SET account_id=NULL WHERE id=$1 AND account_id=$2")
            .bind(c).bind(d.account).execute(&mut *tx).await.map_err(internal)?;
    }
    revoke(&mut tx, d.account, Some(d.id), "logout").await.map_err(internal)?;
    tx.commit().await.map_err(internal)?;
    Ok(Json(json!({"ok":true})).into_response())
}

async fn account(State(state): State<AppState>, headers: HeaderMap) -> Result<Response, Response> {
    let d = device(&state, &headers).await?;
    let account = account_json(&state.db, d.account).await?;
    Ok(Json(json!({"account":account,"device":{"id":d.public_id,"name":d.name}})).into_response())
}

/// Watch rules and `watch.*` preferences only; never credentials or other settings.
fn in_scope(r: &Record) -> bool {
    r.kind == "watch" || (r.kind == "pref" && r.key.starts_with("watch."))
}
async fn device_snapshot(db: &PgPool, account: i64) -> Result<Response, Response> {
    let records: Vec<Record> = sqlx::query_as("SELECT kind,key,value,version FROM account_data WHERE account_id=$1 AND (kind='watch' OR (kind='pref' AND key LIKE 'watch.%')) ORDER BY kind,key")
        .bind(account).fetch_all(db).await.map_err(internal)?;
    let account = account_json(db, account).await?;
    Ok(Json(json!({"account":account,"records":records})).into_response())
}
async fn data(State(state): State<AppState>, headers: HeaderMap) -> Result<Response, Response> {
    let d = device(&state, &headers).await?;
    device_snapshot(&state.db, d.account).await
}
#[derive(Deserialize)]
struct Changes {
    operations: Vec<Record>,
}
async fn save_data(State(state): State<AppState>, headers: HeaderMap, Json(input): Json<Changes>) -> Result<Response, Response> {
    let d = device(&state, &headers).await?;
    if !state.limiter.allow(&format!("account-data:{}", d.account), 120) {
        return Err(error(StatusCode::TOO_MANY_REQUESTS, "rate_limited"));
    }
    let mut seen = std::collections::HashSet::new();
    if input.operations.is_empty()
        || input.operations.len() > 120
        || !input.operations.iter().all(|r| accounts::valid_record(r) && in_scope(r) && seen.insert((&r.kind, &r.key)))
    {
        return Err(error(StatusCode::BAD_REQUEST, "invalid_data"));
    }
    let mut tx = state.db.begin().await.map_err(internal)?;
    lock_account(&mut tx, d.account).await?;
    // Revocation committed after authentication wins over this write.
    let active: bool = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM account_devices WHERE id=$1 AND revoked_at IS NULL)")
        .bind(d.id).fetch_one(&mut *tx).await.map_err(internal)?;
    if !active {
        return Err(error(StatusCode::UNAUTHORIZED, "login_required"));
    }
    accounts::apply(&mut tx, d.account, input.operations, false).await?;
    tx.commit().await.map_err(internal)?;
    device_snapshot(&state.db, d.account).await
}

async fn save_state(State(state): State<AppState>, headers: HeaderMap, Json(input): Json<Value>) -> Result<Response, Response> {
    let d = device(&state, &headers).await?;
    if !valid_state(&input) {
        return Err(error(StatusCode::BAD_REQUEST, "invalid_request"));
    }
    let mut tx = state.db.begin().await.map_err(internal)?;
    let changed = sqlx::query("UPDATE account_devices SET state=$2,client_version=$3 WHERE id=$1 AND (state IS DISTINCT FROM $2 OR client_version<>$3)")
        .bind(d.id).bind(&input).bind(input["client_version"].as_str()).execute(&mut *tx).await.map_err(internal)?;
    if changed.rows_affected() > 0 {
        notify(&mut tx, d.account, "devices").await.map_err(internal)?;
    }
    tx.commit().await.map_err(internal)?;
    Ok(Json(json!({"ok":true})).into_response())
}

async fn list(State(state): State<AppState>, headers: HeaderMap) -> Result<Response, Response> {
    let s = session(&state, &headers).await?.ok_or_else(|| error(StatusCode::UNAUTHORIZED, "login_required"))?;
    let mut db = state.db.acquire().await.map_err(internal)?;
    let devices = device_list(&mut db, s.id).await.map_err(internal)?;
    Ok(Json(json!({"devices":devices})).into_response())
}
#[derive(Deserialize)]
struct Revoke {
    device: String,
}
async fn revoke_device(State(state): State<AppState>, headers: HeaderMap, Json(input): Json<Revoke>) -> Result<Response, Response> {
    let s = writable(&state, &headers).await?;
    if !state.limiter.allow(&format!("account-devices:{}", s.id), 30) {
        return Err(error(StatusCode::TOO_MANY_REQUESTS, "rate_limited"));
    }
    if !crate::sweep::public_id(&input.device) {
        return Err(error(StatusCode::BAD_REQUEST, "invalid_request"));
    }
    let mut tx = state.db.begin().await.map_err(internal)?;
    lock_account(&mut tx, s.id).await?;
    let id: Option<i64> = sqlx::query_scalar("SELECT id FROM account_devices WHERE account_id=$1 AND public_id=$2")
        .bind(s.id).bind(&input.device).fetch_optional(&mut *tx).await.map_err(internal)?;
    let id = id.ok_or_else(|| error(StatusCode::NOT_FOUND, "not_found"))?;
    // Like signing out on the device: its collector token can no longer reach the account's watch data.
    sqlx::query("UPDATE collectors SET account_id=NULL WHERE id=(SELECT collector_id FROM account_devices WHERE id=$1) AND account_id=$2")
        .bind(id).bind(s.id).execute(&mut *tx).await.map_err(internal)?;
    revoke(&mut tx, s.id, Some(id), "revoked").await.map_err(internal)?;
    tx.commit().await.map_err(internal)?;
    Ok(Json(json!({"ok":true})).into_response())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn redirect_uri_is_the_exact_loopback_callback() {
        for ok in ["http://127.0.0.1:1024/callback", "http://127.0.0.1:8766/callback", "http://127.0.0.1:65535/callback"] {
            assert!(valid_redirect(ok), "{ok}");
        }
        for bad in [
            "http://127.0.0.1:1023/callback", "http://127.0.0.1:65536/callback", "http://127.0.0.1:08766/callback",
            "http://127.0.0.1:/callback", "http://127.0.0.1:8766/callback/", "http://127.0.0.1:8766/callback?x=1",
            "https://127.0.0.1:8766/callback", "http://localhost:8766/callback", "http://127.0.0.1:8766@evil/callback",
            "http://127.0.0.1:+8766/callback", "http://127.0.0.1:8766/Callback",
        ] {
            assert!(!valid_redirect(bad), "{bad}");
        }
    }
    #[test]
    fn pkce_values_are_bounded_and_s256() {
        let verifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
        // RFC 7636 appendix B.
        assert_eq!(challenge_of(verifier), "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM");
        assert!(valid_verifier(verifier) && valid_challenge(&challenge_of(verifier)));
        assert!(valid_verifier(&"a.b_c~d-".repeat(16)));
        for bad in [&"a".repeat(42), &"a".repeat(129), &format!("{}+", "a".repeat(42)), &format!("{} ", "a".repeat(43))] {
            assert!(!valid_verifier(bad));
        }
        assert!(!valid_challenge(&"a".repeat(42)) && !valid_challenge(&format!("{}=", "a".repeat(42))));
        assert!(!valid_challenge(&format!("{}.", "a".repeat(42))));
    }
    #[test]
    fn device_tokens_and_state_are_strict() {
        let token = format!("cwd_{}", auth::new_credentials().token);
        assert!(token_shape(&token));
        assert!(!token_shape(&token[1..]) && !token_shape(&format!("cwx_{}", &token[4..])));
        let state = json!({"client_version":"0.7.0","sweep":{"allow_web_start":false,"max_spend":0,"max_order":0,"reserve_mesos":0,
            "executor":{"ready":false,"reason":"此电脑尚未安装购买执行器"},"game":{"connected":true}}});
        assert!(valid_state(&state));
        let mut no_reason = state.clone();
        no_reason["sweep"]["executor"] = json!({"ready":true});
        assert!(valid_state(&no_reason));
        let mut with_holdings = state.clone();
        with_holdings["sweep"]["holdings"] = json!({"observed_at":Utc::now().timestamp(),"mesos":434333,"categories":[2,3,4],
            "items":[{"item_id":2000001,"quantity":489}]});
        assert!(valid_state(&with_holdings));
        with_holdings["sweep"]["holdings"]["mesos"] = Value::Null;
        assert!(valid_state(&with_holdings));
        with_holdings["sweep"]["holdings"]["items"][0]["quantity"] = json!(-1);
        assert!(!valid_state(&with_holdings));
        with_holdings["sweep"]["holdings"] = Value::Null;
        assert!(valid_state(&with_holdings));
        for (path, value) in [
            ("max_spend", json!(1_000_000_000_001u64)), ("max_order", json!(-1)), ("reserve_mesos", json!(1.5)),
            ("allow_web_start", json!("yes")), ("extra", json!(1)), ("executor", json!({"ready":true,"reason":"x".repeat(81)})),
            ("game", json!({"connected":true,"pid":1})),
        ] {
            let mut bad = state.clone();
            bad["sweep"][path] = value;
            assert!(!valid_state(&bad), "{path}");
        }
        let mut bad = state.clone();
        bad["client_version"] = json!("0.7 beta");
        assert!(!valid_state(&bad));
    }
}

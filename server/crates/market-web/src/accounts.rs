//! Application passwords and private, versioned account data.
#![allow(clippy::result_large_err)]
use crate::{api::ClientAddr, auth, contributors as identity, AppState};
use argon2::{
    password_hash::{PasswordHash, PasswordHasher, PasswordVerifier, SaltString},
    Argon2,
};
use axum::{
    extract::{DefaultBodyLimit, State},
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    routing::{get, post},
    Json, Router,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sqlx::{FromRow, PgPool};

use identity::{
    cookie, error, internal, origin_ok, session, set_cookie, writable, Session, SESSION,
};
static PASSWORD_JOBS: tokio::sync::Semaphore = tokio::sync::Semaphore::const_new(4);
// A valid, non-secret PHC value makes unknown-user login perform the same KDF.
const DUMMY_HASH: &str = "$argon2id$v=19$m=19456,t=2,p=1$MDEyMzQ1Njc4OWFiY2RlZg$Le5Et/NZAKX6KC3PDC9ekfHzZGbtUYrVUN1tFnd0wUQ";

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/api/v1/account/register", post(register))
        .route("/api/v1/account/login", post(login))
        .route("/api/v1/account/password", post(password))
        .route("/api/v1/account/recover", post(recover))
        .route("/api/v1/account/google/unlink", post(unlink_google))
        .route("/api/v1/account/logout-all", post(logout_all))
        .route("/api/v1/account/data", get(data).post(save_data))
        .route("/api/v1/account/data/import", post(import_data))
        .layer(DefaultBodyLimit::max(64 * 1024))
}
fn username(raw: &str) -> Option<String> {
    let name = raw.trim().to_ascii_lowercase();
    ((3..=32).contains(&name.len())
        && name.as_bytes()[0].is_ascii_alphanumeric()
        && name
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"_.-".contains(&b)))
    .then_some(name)
}
fn valid_password(value: &str) -> bool {
    (15..=128).contains(&value.chars().count()) && value.len() <= 512
}
async fn hash_password(value: String) -> Result<String, Response> {
    let permit = PASSWORD_JOBS
        .try_acquire()
        .map_err(|_| error(StatusCode::TOO_MANY_REQUESTS, "rate_limited"))?;
    tokio::task::spawn_blocking(move || {
        let _permit = permit;
        let salt = SaltString::encode_b64(&auth::token_hash(&auth::new_credentials().token)[..16])
            .unwrap();
        Argon2::default()
            .hash_password(value.as_bytes(), &salt)
            .map(|h| h.to_string())
            .map_err(|e| e.to_string())
    })
    .await
    .map_err(internal)?
    .map_err(internal)
}
async fn verify(value: String, encoded: String) -> Result<bool, Response> {
    if value.len() > 512 {
        return Ok(false);
    }
    let permit = PASSWORD_JOBS
        .try_acquire()
        .map_err(|_| error(StatusCode::TOO_MANY_REQUESTS, "rate_limited"))?;
    tokio::task::spawn_blocking(move || {
        let _permit = permit;
        PasswordHash::new(&encoded).is_ok_and(|h| {
            Argon2::default()
                .verify_password(value.as_bytes(), &h)
                .is_ok()
        })
    })
    .await
    .map_err(internal)
}
fn auth_request(
    state: &AppState,
    headers: &HeaderMap,
    addr: &str,
    action: &str,
    limit: usize,
) -> Result<(), Response> {
    if !origin_ok(state, headers) {
        return Err(error(StatusCode::FORBIDDEN, "invalid_request"));
    }
    if !state
        .limiter
        .allow(&format!("account:{action}:{addr}"), limit)
    {
        return Err(error(StatusCode::TOO_MANY_REQUESTS, "rate_limited"));
    }
    Ok(())
}
#[derive(Deserialize)]
struct Credentials {
    username: String,
    password: String,
}
async fn register(
    State(state): State<AppState>,
    ClientAddr(addr): ClientAddr,
    headers: HeaderMap,
    Json(input): Json<Credentials>,
) -> Response {
    if let Err(e) = auth_request(&state, &headers, &addr, "register", 5) {
        return e;
    }
    // Registration must not silently replace a signed-in user's account.
    match session(&state, &headers).await {
        Ok(Some(_)) => return error(StatusCode::CONFLICT, "already_signed_in"),
        Err(e) => return e,
        _ => {}
    }
    let Some(name) = username(&input.username) else {
        return error(StatusCode::BAD_REQUEST, "invalid_username");
    };
    if !valid_password(&input.password) {
        return error(StatusCode::BAD_REQUEST, "invalid_password");
    }
    let encoded = match hash_password(input.password).await {
        Ok(h) => h,
        Err(e) => return e,
    };
    let recovery = auth::new_credentials().token;
    let credentials = auth::new_credentials();
    let mut tx = match state.db.begin().await {
        Ok(t) => t,
        Err(e) => return internal(e),
    };
    let account: i64 = match sqlx::query_scalar(
        "INSERT INTO accounts(public_id,listed) VALUES($1,false) RETURNING id",
    )
    .bind(&credentials.public_id)
    .fetch_one(&mut *tx)
    .await
    {
        Ok(a) => a,
        Err(e) => return internal(e),
    };
    if let Err(e) = sqlx::query("INSERT INTO account_passwords(account_id,username,password_hash,recovery_hash) VALUES($1,$2,$3,$4)").bind(account).bind(name).bind(&encoded).bind(auth::token_hash(&recovery)).execute(&mut *tx).await {
        if e.as_database_error().is_some_and(|e|e.is_unique_violation()) { return error(StatusCode::CONFLICT,"username_unavailable"); }
        return internal(e);
    }
    if let Err(e) = tx.commit().await {
        return internal(e);
    }
    signed_in(
        &state,
        &headers,
        account,
        Proof::Password(encoded),
        Json(json!({"ok":true,"recovery_code":recovery})).into_response(),
    )
    .await
}
pub(crate) enum Proof {
    Password(String),
    Google(String),
}
pub(crate) async fn signed_in(
    state: &AppState,
    headers: &HeaderMap,
    account: i64,
    proof: Proof,
    mut response: Response,
) -> Response {
    let credentials = auth::new_credentials();
    let mut tx = match state.db.begin().await {
        Ok(t) => t,
        Err(e) => return internal(e),
    };
    if let Err(e) = sqlx::query("SELECT id FROM accounts WHERE id=$1 FOR UPDATE")
        .bind(account)
        .execute(&mut *tx)
        .await
    {
        return internal(e);
    }
    let proven = match proof {
        Proof::Password(expected) => match sqlx::query_scalar::<_, String>(
            "SELECT password_hash FROM account_passwords WHERE account_id=$1",
        )
        .bind(account)
        .fetch_optional(&mut *tx)
        .await
        {
            Ok(current) => current.as_deref() == Some(expected.as_str()),
            Err(e) => return internal(e),
        },
        Proof::Google(expected) => match sqlx::query_scalar::<_, Option<String>>(
            "SELECT google_sub FROM accounts WHERE id=$1",
        )
        .bind(account)
        .fetch_one(&mut *tx)
        .await
        {
            Ok(current) => current.as_deref() == Some(expected.as_str()),
            Err(e) => return internal(e),
        },
    };
    if !proven {
        return error(StatusCode::UNAUTHORIZED, "reauth_required");
    }
    if let Err(e)=sqlx::query("INSERT INTO account_sessions(token_hash,account_id,csrf,expires_at) VALUES($1,$2,$3,now()+interval '90 days')")
        .bind(auth::token_hash(&credentials.token)).bind(account).bind(auth::new_credentials().token).execute(&mut *tx).await { return internal(e); }
    if let Some(old) = cookie(headers, SESSION) {
        if let Err(e) = sqlx::query("DELETE FROM account_sessions WHERE token_hash=$1")
            .bind(auth::token_hash(old))
            .execute(&mut *tx)
            .await
        {
            return internal(e);
        }
    }
    if let Err(e) = tx.commit().await {
        return internal(e);
    }
    set_cookie(&mut response, SESSION, &credentials.token, 90 * 86400);
    response
}

async fn login(
    State(state): State<AppState>,
    ClientAddr(addr): ClientAddr,
    headers: HeaderMap,
    Json(input): Json<Credentials>,
) -> Response {
    if let Err(e) = auth_request(&state, &headers, &addr, "login", 15) {
        return e;
    }
    let name = username(&input.username).unwrap_or_default();
    if !state.limiter.allow(
        &format!("password-user:{}", hex::encode(auth::token_hash(&name))),
        20,
    ) {
        return error(StatusCode::TOO_MANY_REQUESTS, "rate_limited");
    }
    let found: Option<(i64, String)> = match sqlx::query_as(
        "SELECT account_id,password_hash FROM account_passwords WHERE username=$1",
    )
    .bind(&name)
    .fetch_optional(&state.db)
    .await
    {
        Ok(r) => r,
        Err(e) => return internal(e),
    };
    let encoded = found
        .as_ref()
        .map(|(_, h)| h.as_str())
        .unwrap_or(DUMMY_HASH)
        .to_owned();
    match verify(input.password, encoded.clone()).await {
        Ok(true) if found.is_some() => {
            signed_in(
                &state,
                &headers,
                found.unwrap().0,
                Proof::Password(encoded),
                Json(json!({"ok":true})).into_response(),
            )
            .await
        }
        Ok(_) => error(StatusCode::UNAUTHORIZED, "invalid_credentials"),
        Err(e) => e,
    }
}
pub(crate) async fn sensitive(
    state: &AppState,
    headers: &HeaderMap,
    current_password: &str,
) -> Result<Session, Response> {
    let s = writable(state, headers).await?;
    if !state
        .limiter
        .allow(&format!("account-sensitive:{}", s.id), 10)
    {
        return Err(error(StatusCode::TOO_MANY_REQUESTS, "rate_limited"));
    }
    let encoded: Option<String> =
        sqlx::query_scalar("SELECT password_hash FROM account_passwords WHERE account_id=$1")
            .bind(s.id)
            .fetch_optional(&state.db)
            .await
            .map_err(internal)?;
    if let Some(encoded) = encoded {
        if !verify(current_password.to_owned(), encoded).await? {
            return Err(error(StatusCode::UNAUTHORIZED, "invalid_current_password"));
        }
    } else {
        let recent: bool=sqlx::query_scalar("SELECT authenticated_at>now()-interval '15 minutes' FROM account_sessions WHERE token_hash=$1 AND expires_at>now()")
            .bind(auth::token_hash(cookie(headers,SESSION).unwrap())).fetch_one(&state.db).await.map_err(internal)?;
        if !recent {
            return Err(error(StatusCode::UNAUTHORIZED, "reauth_required"));
        }
    }
    Ok(s)
}
async fn lock_session(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    id: i64,
    headers: &HeaderMap,
) -> Result<(), Response> {
    sqlx::query("SELECT id FROM accounts WHERE id=$1 FOR UPDATE")
        .bind(id)
        .execute(&mut **tx)
        .await
        .map_err(internal)?;
    let active:bool=sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM account_sessions WHERE account_id=$1 AND token_hash=$2 AND expires_at>now())")
        .bind(id).bind(auth::token_hash(cookie(headers,SESSION).unwrap_or_default())).fetch_one(&mut **tx).await.map_err(internal)?;
    if !active {
        return Err(error(StatusCode::UNAUTHORIZED, "reauth_required"));
    }
    Ok(())
}
#[derive(Deserialize, Default)]
pub(crate) struct Sensitive {
    #[serde(default)]
    pub(crate) current_password: String,
}
#[derive(Deserialize)]
struct PasswordInput {
    username: String,
    password: String,
    #[serde(default)]
    current_password: String,
}
async fn password(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(input): Json<PasswordInput>,
) -> Response {
    let s = match sensitive(&state, &headers, &input.current_password).await {
        Ok(s) => s,
        Err(e) => return e,
    };
    let Some(name) = username(&input.username) else {
        return error(StatusCode::BAD_REQUEST, "invalid_username");
    };
    if !valid_password(&input.password) {
        return error(StatusCode::BAD_REQUEST, "invalid_password");
    }
    let encoded = match hash_password(input.password).await {
        Ok(h) => h,
        Err(e) => return e,
    };
    let recovery = auth::new_credentials().token;
    let mut tx = match state.db.begin().await {
        Ok(t) => t,
        Err(e) => return internal(e),
    };
    // Serialize security changes and recheck that the proving session survived.
    if let Err(e) = lock_session(&mut tx, s.id, &headers).await {
        return e;
    }
    let result=sqlx::query("INSERT INTO account_passwords(account_id,username,password_hash,recovery_hash) VALUES($1,$2,$3,$4) ON CONFLICT(account_id) DO UPDATE SET password_hash=$3,recovery_hash=$4,changed_at=now() WHERE account_passwords.username=$2 AND account_passwords.changed_at <= (SELECT authenticated_at FROM account_sessions WHERE token_hash=$5)")
        .bind(s.id).bind(name).bind(&encoded).bind(auth::token_hash(&recovery)).bind(auth::token_hash(cookie(&headers,SESSION).unwrap())).execute(&mut *tx).await;
    match result {
        Ok(r) if r.rows_affected() == 1 => {}
        Ok(_) => return error(StatusCode::CONFLICT, "reauth_required"),
        Err(e)
            if e.as_database_error()
                .is_some_and(|e| e.is_unique_violation()) =>
        {
            return error(StatusCode::CONFLICT, "username_unavailable")
        }
        Err(e) => return internal(e),
    }
    if let Err(e) = sqlx::query("DELETE FROM account_sessions WHERE account_id=$1")
        .bind(s.id)
        .execute(&mut *tx)
        .await
    {
        return internal(e);
    }
    if let Err(e) = tx.commit().await {
        return internal(e);
    }
    signed_in(
        &state,
        &headers,
        s.id,
        Proof::Password(encoded),
        Json(json!({"ok":true,"recovery_code":recovery})).into_response(),
    )
    .await
}
#[derive(Deserialize)]
struct RecoveryInput {
    username: String,
    recovery_code: String,
    password: String,
}
async fn recover(
    State(state): State<AppState>,
    ClientAddr(addr): ClientAddr,
    headers: HeaderMap,
    Json(input): Json<RecoveryInput>,
) -> Response {
    if let Err(e) = auth_request(&state, &headers, &addr, "recover", 5) {
        return e;
    }
    if !valid_password(&input.password) {
        return error(StatusCode::BAD_REQUEST, "invalid_password");
    }
    if input.recovery_code.len() != 43 {
        return error(StatusCode::UNAUTHORIZED, "invalid_recovery");
    }
    let name = username(&input.username).unwrap_or_default();
    let encoded = match hash_password(input.password).await {
        Ok(h) => h,
        Err(e) => return e,
    };
    let recovery = auth::new_credentials().token;
    let mut tx = match state.db.begin().await {
        Ok(t) => t,
        Err(e) => return internal(e),
    };
    let candidate: Option<i64> =
        match sqlx::query_scalar("SELECT account_id FROM account_passwords WHERE username=$1")
            .bind(&name)
            .fetch_optional(&mut *tx)
            .await
        {
            Ok(a) => a,
            Err(e) => return internal(e),
        };
    let Some(candidate) = candidate else {
        return error(StatusCode::UNAUTHORIZED, "invalid_recovery");
    };
    if let Err(e) = sqlx::query("SELECT id FROM accounts WHERE id=$1 FOR UPDATE")
        .bind(candidate)
        .execute(&mut *tx)
        .await
    {
        return internal(e);
    }
    let account: Option<i64>=match sqlx::query_scalar("UPDATE account_passwords SET password_hash=$3,recovery_hash=$4,changed_at=now() WHERE username=$1 AND recovery_hash=$2 RETURNING account_id")
        .bind(name).bind(auth::token_hash(&input.recovery_code)).bind(&encoded).bind(auth::token_hash(&recovery)).fetch_optional(&mut *tx).await { Ok(a)=>a,Err(e)=>return internal(e) };
    let Some(account) = account else {
        return error(StatusCode::UNAUTHORIZED, "invalid_recovery");
    };
    if let Err(e) = sqlx::query("DELETE FROM account_sessions WHERE account_id=$1")
        .bind(account)
        .execute(&mut *tx)
        .await
    {
        return internal(e);
    }
    if let Err(e) = tx.commit().await {
        return internal(e);
    }
    signed_in(
        &state,
        &headers,
        account,
        Proof::Password(encoded),
        Json(json!({"ok":true,"recovery_code":recovery})).into_response(),
    )
    .await
}
async fn unlink_google(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(input): Json<Sensitive>,
) -> Response {
    let s = match sensitive(&state, &headers, &input.current_password).await {
        Ok(s) => s,
        Err(e) => return e,
    };
    let mut tx = match state.db.begin().await {
        Ok(t) => t,
        Err(e) => return internal(e),
    };
    if let Err(e) = lock_session(&mut tx, s.id, &headers).await {
        return e;
    }
    let password: bool = match sqlx::query_scalar(
        "SELECT EXISTS(SELECT 1 FROM account_passwords WHERE account_id=$1)",
    )
    .bind(s.id)
    .fetch_one(&mut *tx)
    .await
    {
        Ok(v) => v,
        Err(e) => return internal(e),
    };
    if !password {
        return error(StatusCode::CONFLICT, "last_login_method");
    }
    if let Err(e) =
        sqlx::query("DELETE FROM account_identities WHERE account_id=$1 AND provider='google'")
            .bind(s.id)
            .execute(&mut *tx)
            .await
    {
        return internal(e);
    }
    if let Err(e) = sqlx::query("UPDATE accounts SET google_sub=NULL WHERE id=$1")
        .bind(s.id)
        .execute(&mut *tx)
        .await
    {
        return internal(e);
    }
    // Invalidates Google-created sessions too; retain only the verified browser.
    if let Err(e) =
        sqlx::query("DELETE FROM account_sessions WHERE account_id=$1 AND token_hash<>$2")
            .bind(s.id)
            .bind(auth::token_hash(cookie(&headers, SESSION).unwrap()))
            .execute(&mut *tx)
            .await
    {
        return internal(e);
    }
    if let Err(e) = tx.commit().await {
        return internal(e);
    }
    Json(json!({"ok":true})).into_response()
}
async fn logout_all(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(input): Json<Sensitive>,
) -> Response {
    let s = match sensitive(&state, &headers, &input.current_password).await {
        Ok(s) => s,
        Err(e) => return e,
    };
    if let Err(e) = sqlx::query("DELETE FROM account_sessions WHERE account_id=$1")
        .bind(s.id)
        .execute(&state.db)
        .await
    {
        return internal(e);
    }
    let mut response = Json(json!({"ok":true})).into_response();
    set_cookie(&mut response, SESSION, "", 0);
    response
}

#[derive(Deserialize, Serialize, FromRow, Clone)]
struct Record {
    kind: String,
    key: String,
    value: Option<Value>,
    version: i64,
}
async fn snapshot(db: &PgPool, id: i64) -> Result<Value, Response> {
    let records: Vec<Record> = sqlx::query_as(
        "SELECT kind,key,value,version FROM account_data WHERE account_id=$1 ORDER BY kind,key",
    )
    .bind(id)
    .fetch_all(db)
    .await
    .map_err(internal)?;
    Ok(json!({"records":records}))
}
async fn data(State(state): State<AppState>, headers: HeaderMap) -> Response {
    let s = match session(&state, &headers).await {
        Ok(Some(s)) => s,
        Ok(None) => return error(StatusCode::UNAUTHORIZED, "login_required"),
        Err(e) => return e,
    };
    match snapshot(&state.db, s.id).await {
        Ok(v) => Json(v).into_response(),
        Err(e) => e,
    }
}
#[derive(Deserialize)]
struct Changes {
    operations: Vec<Record>,
}
fn valid_reminder(value: &Value) -> bool {
    let Some(o) = value.as_object() else {
        return false;
    };
    let price = |v: &Value| {
        v.is_null()
            || v.as_f64()
                .is_some_and(|n| n.is_finite() && (0.0..=1e15).contains(&n))
    };
    o.len() <= 6
        && o.iter().all(|(key, v)| match key.as_str() {
            "percentile" => matches!(v.as_str(), Some("all" | "10" | "25" | "50")),
            "minPrice" => price(v),
            "stock" => matches!(v.as_str(), Some("all" | "known" | "unknown")),
            "minStock" => {
                v.is_null()
                    || v.as_u64()
                        .is_some_and(|n| (1..=9_007_199_254_740_991).contains(&n))
            }
            "equipment" => matches!(v.as_str(), Some("all" | "captured" | "missing" | "bonus")),
            "stats" => v.as_array().is_some_and(|rows| {
                rows.len() <= 14
                    && rows.iter().all(|row| {
                        row.as_object().is_some_and(|stat| {
                            stat.len() == 2
                                && stat.get("stat").and_then(Value::as_str).is_some_and(|key| {
                                    [
                                        "weapon_attack",
                                        "magic_attack",
                                        "str",
                                        "dex",
                                        "int",
                                        "luk",
                                        "hp",
                                        "mp",
                                        "accuracy",
                                        "avoid",
                                        "speed",
                                        "jump",
                                        "weapon_defense",
                                        "magic_defense",
                                    ]
                                    .contains(&key)
                                })
                                && stat.get("min").is_some_and(|n| {
                                    n.is_null() || n.as_u64().is_some_and(|n| n <= 65535)
                                })
                        })
                    })
            }),
            _ => false,
        })
}
fn valid_item_filters(raw: &str) -> bool {
    if raw.len() > 4096 {
        return false;
    }
    let Ok(Value::Object(mut filters)) = serde_json::from_str::<Value>(raw) else {
        return false;
    };
    for (key, choices) in [
        ("hours", &["all", "1", "6", "24", "48", "72", "168"][..]),
        ("percentile", &["all", "10", "25", "50", "75"][..]),
    ] {
        if filters
            .remove(key)
            .is_some_and(|v| !v.as_str().is_some_and(|s| choices.contains(&s)))
        {
            return false;
        }
    }
    for key in ["minPrice", "maxPrice"] {
        if filters.remove(key).is_some_and(|v| {
            !v.is_null()
                && !v
                    .as_f64()
                    .is_some_and(|n| n.is_finite() && (0.0..=9_007_199_254_740_991.0).contains(&n))
        }) {
            return false;
        }
    }
    valid_reminder(&Value::Object(filters))
}
fn valid_record(r: &Record) -> bool {
    if r.version < 0 || r.version == i64::MAX {
        return false;
    }
    if r.kind == "watch" {
        if !r
            .key
            .parse::<u32>()
            .is_ok_and(|id| (1000000..=5999999).contains(&id) && id.to_string() == r.key)
        {
            return false;
        }
        return r.value.as_ref().is_none_or(|v| {
            v.as_object().is_some_and(|o| {
                (o.len() == 3 || (o.len() == 4 && o.get("reminder").is_some_and(valid_reminder)))
                    && o.get("cap").is_some_and(|c| {
                        c.is_null()
                            || c.as_f64()
                                .is_some_and(|n| n.is_finite() && (0.0..=1e15).contains(&n))
                    })
                    && o.get("notify").is_some_and(Value::is_boolean)
                    && o.get("position")
                        .and_then(Value::as_u64)
                        .is_some_and(|n| n <= 10000)
            })
        });
    }
    if r.kind != "pref" {
        return false;
    }
    for prefix in ["item.offerFilters.", "item.showExpired."] {
        if let Some(key) = r.key.strip_prefix(prefix) {
            if !key
                .parse::<u32>()
                .is_ok_and(|id| (1000000..=5999999).contains(&id) && id.to_string() == key)
            {
                return false;
            }
            return r.value.as_ref().is_none_or(|v| {
                v.as_str().is_some_and(|s| {
                    if prefix == "item.showExpired." {
                        s == "true" || s == "false"
                    } else {
                        valid_item_filters(s)
                    }
                })
            });
        }
    }
    let Some(v) = &r.value else {
        return [
            "lang",
            "theme",
            "market.offerSort",
            "watch.offerSort",
            "market.hours",
        ]
        .contains(&r.key.as_str());
    };
    match r.key.as_str() {
        "lang" => v == "zh" || v == "en",
        "theme" => v == "light" || v == "dark",
        "market.offerSort" | "watch.offerSort" => v == "price" || v == "recent",
        "market.hours" => v == "72" || v == "all",
        _ => false,
    }
}
async fn save_data(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(input): Json<Changes>,
) -> Response {
    write_data(state, headers, input, false).await
}
async fn import_data(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(input): Json<Changes>,
) -> Response {
    write_data(state, headers, input, true).await
}
async fn write_data(state: AppState, headers: HeaderMap, input: Changes, import: bool) -> Response {
    let s = match writable(&state, &headers).await {
        Ok(s) => s,
        Err(e) => return e,
    };
    if !state.limiter.allow(&format!("account-data:{}", s.id), 120) {
        return error(StatusCode::TOO_MANY_REQUESTS, "rate_limited");
    }
    if input.operations.is_empty()
        || input.operations.len() > 120
        || !input.operations.iter().all(valid_record)
    {
        return error(StatusCode::BAD_REQUEST, "invalid_data");
    }
    let mut seen = std::collections::HashSet::new();
    if !input
        .operations
        .iter()
        .all(|r| seen.insert((&r.kind, &r.key)))
    {
        return error(StatusCode::BAD_REQUEST, "invalid_data");
    }
    let mut tx = match state.db.begin().await {
        Ok(t) => t,
        Err(e) => return internal(e),
    };
    if let Err(e) = lock_session(&mut tx, s.id, &headers).await {
        return e;
    }
    for r in input.operations {
        let version: Option<i64> = match sqlx::query_scalar(
            "SELECT version FROM account_data WHERE account_id=$1 AND kind=$2 AND key=$3",
        )
        .bind(s.id)
        .bind(&r.kind)
        .bind(&r.key)
        .fetch_optional(&mut *tx)
        .await
        {
            Ok(v) => v,
            Err(e) => return internal(e),
        };
        if import && version.is_some() {
            continue;
        }
        if !import && version.unwrap_or(0) != r.version {
            return error(StatusCode::CONFLICT, "sync_conflict");
        }
        if import && r.value.is_none() {
            continue;
        }
        if let Err(e)=sqlx::query("INSERT INTO account_data(account_id,kind,key,value) VALUES($1,$2,$3,$4) ON CONFLICT(account_id,kind,key) DO UPDATE SET value=$4,version=account_data.version+1,updated_at=now()")
            .bind(s.id).bind(r.kind).bind(r.key).bind(r.value).execute(&mut *tx).await { return internal(e); }
    }
    let count:i64=match sqlx::query_scalar("SELECT count(*) FROM account_data WHERE account_id=$1 AND kind='watch' AND value IS NOT NULL").bind(s.id).fetch_one(&mut *tx).await { Ok(n)=>n,Err(e)=>return internal(e) };
    if count > 100 {
        return error(StatusCode::CONFLICT, "watch_limit");
    }
    if let Err(e) = tx.commit().await {
        return internal(e);
    }
    match snapshot(&state.db, s.id).await {
        Ok(v) => Json(v).into_response(),
        Err(e) => e,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn password_hash_is_salted_and_verifies() {
        let a = hash_password("correct horse battery staple".into())
            .await
            .unwrap();
        let b = hash_password("correct horse battery staple".into())
            .await
            .unwrap();
        assert_ne!(a, b);
        assert!(a.starts_with("$argon2id$"));
        assert!(verify("correct horse battery staple".into(), a.clone())
            .await
            .unwrap());
        assert!(!verify("wrong".into(), a).await.unwrap());
        assert!(PasswordHash::new(DUMMY_HASH).is_ok());
    }
    #[test]
    fn validates_username_password_and_private_data() {
        assert_eq!(username(" Maple_User ").as_deref(), Some("maple_user"));
        for name in ["", "ab", "中文账号", "a b", "_abc"] {
            assert!(username(name).is_none());
        }
        assert!(!valid_password("short"));
        assert!(valid_password("a long unique passphrase"));
        let mut r = Record {
            kind: "watch".into(),
            key: "4010001".into(),
            value: Some(json!({"cap":100,"notify":true,"position":0})),
            version: 0,
        };
        assert!(valid_record(&r));
        r.value = Some(json!({"cap":-1,"notify":true,"position":0}));
        assert!(!valid_record(&r));
        r.kind = "pref".into();
        r.key = "cwm.collector.token".into();
        r.value = Some(json!("secret"));
        assert!(!valid_record(&r));
    }

    #[test]
    fn validates_per_item_filter_preferences() {
        let mut r = Record {
            kind: "pref".into(), key: "item.offerFilters.1002000".into(),
            value: Some(json!(json!({"hours":"6","percentile":"75","minPrice":null,"maxPrice":9007199254740991u64,"stock":"known","minStock":2,"equipment":"bonus","stats":[{"stat":"dex","min":3}]}).to_string())), version: 0,
        };
        assert!(valid_record(&r));
        for invalid in [
            json!({"hours":"2"}),
            json!({"maxPrice":-1}),
            json!({"stats":[{"stat":"dex","min":65536}]}),
            json!({"secret":"no"}),
            json!([]),
        ] {
            r.value = Some(json!(invalid.to_string()));
            assert!(!valid_record(&r));
        }
        r.value = None;
        assert!(valid_record(&r));
        for key in [
            "item.offerFilters.01002000",
            "item.offerFilters.999999",
            "item.offerFilters.6000000",
            "item.offerFilters.1002000.other",
        ] {
            r.key = key.into();
            assert!(!valid_record(&r));
        }
        r.key = "item.showExpired.1002000".into();
        r.value = Some(json!("false"));
        assert!(valid_record(&r));
        r.value = Some(json!("yes"));
        assert!(!valid_record(&r));
        r.key = "item.offerFilters.1002000".into();
        r.value = Some(json!("x".repeat(4097)));
        assert!(!valid_record(&r));
    }
    #[test]
    fn validates_per_item_reminders_without_time_filters() {
        let valid = json!({"percentile":"25","minPrice":null,"stock":"known","minStock":5,"equipment":"bonus","stats":[{"stat":"weapon_attack","min":45}]});
        assert!(valid_reminder(&valid));
        for (key, value) in [
            ("hours", json!("1")),
            ("percentile", json!("75")),
            ("minStock", json!(-1)),
            ("stats", json!([{"stat":"secret","min":1}])),
        ] {
            let mut invalid = valid.clone();
            invalid[key] = value;
            assert!(!valid_reminder(&invalid));
        }
        assert!(!valid_reminder(
            &json!({"stats":[{"stat":"str","min":65536}]})
        ));
    }
}

//! Nicknames, opt-in contribution standings and Google sign-in.
//! Collector secrets stay in the collector; the browser pairs with an expiring code.
// Authentication gates return the final HTTP response directly.
#![allow(clippy::result_large_err)]
use crate::{api::ClientAddr, auth, AppState};
use axum::{
    extract::{Query, State},
    http::{header, HeaderMap, HeaderValue, StatusCode},
    response::{IntoResponse, Redirect, Response},
    routing::{get, post},
    Json, Router,
};
use base64::Engine;
use jsonwebtoken::{decode, decode_header, jwk::JwkSet, Algorithm, DecodingKey, Validation};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use sqlx::{FromRow, PgPool};
use std::{path::Path, time::Duration};

pub(crate) const SESSION: &str = "cwm_account";
const LOGIN: &str = "cwm_google_state";

#[derive(Deserialize)]
pub struct GoogleOAuth {
    client_id: String,
    client_secret: String,
    redirect_uri: String,
}
impl GoogleOAuth {
    pub fn load(web: Option<&Path>, hostname: &str) -> anyhow::Result<Option<Self>> {
        let path = std::env::var_os("GOOGLE_OAUTH_CONFIG")
            .map(std::path::PathBuf::from)
            .or_else(|| {
                web.and_then(Path::parent)
                    .map(|p| p.join("shared_data/google-oauth.json"))
            });
        let Some(path) = path.filter(|p| p.is_file()) else {
            return Ok(None);
        };
        let config: Self = serde_json::from_slice(&std::fs::read(path)?)?;
        anyhow::ensure!(
            config.client_id.ends_with(".apps.googleusercontent.com")
                && !config.client_secret.is_empty()
                && config.redirect_uri == format!("https://{hostname}/auth/google/callback"),
            "Invalid Google sign-in configuration"
        );
        Ok(Some(config))
    }
}

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/api/v1/contributors", get(leaderboard))
        .route("/api/v1/account", get(me).post(save_account))
        .route("/api/v1/account/logout", post(logout))
        .route("/api/v1/account/link", post(accept_link))
        .route("/api/v1/account/google/link", post(link_google))
        .route(
            "/api/v1/collector/profile",
            get(collector_profile).post(save_collector),
        )
        .route("/api/v1/collector/account-link", post(create_link))
        .route("/api/v1/collector/watch-revision", get(watch_revision))
        .route("/auth/google/start", get(google_start))
        .route("/auth/google/callback", get(google_callback))
}
pub(crate) fn error(status: StatusCode, code: &str) -> Response {
    (status, Json(json!({"error":code}))).into_response()
}
pub(crate) fn internal(err: impl std::fmt::Display) -> Response {
    tracing::error!(error=%err,"contributor request failed");
    error(StatusCode::INTERNAL_SERVER_ERROR, "unavailable")
}
pub(crate) fn cookie<'a>(headers: &'a HeaderMap, name: &str) -> Option<&'a str> {
    headers
        .get_all(header::COOKIE)
        .iter()
        .filter_map(|v| v.to_str().ok())
        .flat_map(|s| s.split(';'))
        .filter_map(|p| p.trim().split_once('='))
        .find_map(|(k, v)| (k == name).then_some(v))
}
pub(crate) fn set_cookie(response: &mut Response, name: &str, value: &str, age: u32) {
    response.headers_mut().append(
        header::SET_COOKIE,
        HeaderValue::from_str(&format!(
            "{name}={value}; Secure; HttpOnly; SameSite=Lax; Path=/; Max-Age={age}"
        ))
        .unwrap(),
    );
}
fn bearer(headers: &HeaderMap) -> Option<&str> {
    headers
        .get(header::AUTHORIZATION)?
        .to_str()
        .ok()?
        .strip_prefix("Bearer ")
}
pub(crate) async fn collector(
    state: &AppState,
    headers: &HeaderMap,
) -> Result<auth::Collector, Response> {
    auth::authenticate(&state.db, bearer(headers))
        .await
        .map_err(internal)?
        .ok_or_else(|| error(StatusCode::UNAUTHORIZED, "collector_required"))
}
pub(crate) fn origin_ok(state: &AppState, headers: &HeaderMap) -> bool {
    headers
        .get(header::ORIGIN)
        .and_then(|h| h.to_str().ok())
        .is_some_and(|origin| state.settings.public_origin_matches(origin))
}

// Google callbacks are registered on the primary host. Keep their host-only
// session cookies there; password accounts work independently on every alias.
fn google_enabled(state: &AppState, headers: &HeaderMap) -> bool {
    state.google.is_some()
        && headers
            .get(header::HOST)
            .and_then(|h| h.to_str().ok())
            .is_none_or(|host| host == state.settings.hostname)
}
#[derive(FromRow)]
pub(crate) struct Session {
    pub(crate) id: i64,
    public_id: String,
    username: Option<String>,
    google_linked: bool,
    nickname: String,
    listed: bool,
    nickname_temporary: bool,
    csrf: String,
}
pub(crate) async fn session(
    state: &AppState,
    headers: &HeaderMap,
) -> Result<Option<Session>, Response> {
    let Some(token) = cookie(headers, SESSION).filter(|s| s.len() == 43) else {
        return Ok(None);
    };
    sqlx::query_as("SELECT a.id,a.public_id,a.nickname,a.listed,a.nickname_temporary,s.csrf,(SELECT username FROM account_passwords WHERE account_id=a.id) AS username,a.google_sub IS NOT NULL AS google_linked FROM account_sessions s JOIN accounts a ON a.id=s.account_id WHERE s.token_hash=$1 AND s.expires_at>now()")
        .bind(auth::token_hash(token)).fetch_optional(&state.db).await.map_err(internal)
}
pub(crate) async fn writable(state: &AppState, headers: &HeaderMap) -> Result<Session, Response> {
    let s = session(state, headers)
        .await?
        .ok_or_else(|| error(StatusCode::UNAUTHORIZED, "login_required"))?;
    if !origin_ok(state, headers)
        || headers.get("x-csrf-token").and_then(|s| s.to_str().ok()) != Some(s.csrf.as_str())
    {
        return Err(error(StatusCode::FORBIDDEN, "invalid_request"));
    }
    Ok(s)
}
#[derive(Deserialize)]
struct Profile {
    nickname: String,
    listed: bool,
}
fn nickname(value: &str) -> Option<String> {
    let name = value.trim();
    (2..=24).contains(&name.chars().count()).then_some(())?;
    name.chars()
        .all(|c| c.is_alphanumeric() || " _-.".contains(c))
        .then(|| name.to_string())
}
async fn me(State(state): State<AppState>, headers: HeaderMap) -> Response {
    let s = match session(&state, &headers).await {
        Ok(s) => s,
        Err(e) => return e,
    };
    let Some(s) = s else {
        return Json(json!({"signed_in":false,"google_enabled":google_enabled(&state, &headers)}))
            .into_response();
    };
    let devices: i64 =
        match sqlx::query_scalar("SELECT count(*) FROM collectors WHERE account_id=$1 AND active")
            .bind(s.id)
            .fetch_one(&state.db)
            .await
        {
            Ok(n) => n,
            Err(e) => return internal(e),
        };
    let stats = match state
        .market_lists
        .personal_stats(&state.db, Some(s.id), None)
        .await
    {
        Ok(s) => s,
        Err(e) => return internal(e),
    };
    Json(json!({"signed_in":true,"public_id":s.public_id,"username":s.username,"has_password":s.username.is_some(),"google_linked":s.google_linked,"nickname":s.nickname,"temporary":s.nickname_temporary,"listed":s.listed,"csrf":s.csrf,"collectors":devices,"stats":stats,"google_enabled":google_enabled(&state, &headers)})).into_response()
}
async fn save_account(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(profile): Json<Profile>,
) -> Response {
    let s = match writable(&state, &headers).await {
        Ok(s) => s,
        Err(e) => return e,
    };
    let Some(name) = nickname(&profile.nickname) else {
        return error(StatusCode::BAD_REQUEST, "invalid_nickname");
    };
    if !state.limiter.allow(&format!("profile:a:{}", s.id), 10) {
        return error(StatusCode::TOO_MANY_REQUESTS, "rate_limited");
    }
    match sqlx::query("UPDATE accounts SET nickname_temporary=CASE WHEN nickname=$2 THEN nickname_temporary ELSE false END,nickname=$2,listed=$3 WHERE id=$1")
        .bind(s.id)
        .bind(name)
        .bind(profile.listed)
        .execute(&state.db)
        .await
    {
        Ok(_) => Json(json!({"ok":true})).into_response(),
        Err(e) => internal(e),
    }
}
async fn logout(State(state): State<AppState>, headers: HeaderMap) -> Response {
    if let Err(e) = writable(&state, &headers).await {
        return e;
    }
    if let Err(e) = sqlx::query("DELETE FROM account_sessions WHERE token_hash=$1")
        .bind(auth::token_hash(cookie(&headers, SESSION).unwrap()))
        .execute(&state.db)
        .await
    {
        return internal(e);
    }
    let mut response = Json(json!({"ok":true})).into_response();
    set_cookie(&mut response, SESSION, "", 0);
    response
}
async fn collector_profile(State(state): State<AppState>, headers: HeaderMap) -> Response {
    let c = match collector(&state, &headers).await {
        Ok(c) => c,
        Err(e) => return e,
    };
    let result:Result<(String,bool,bool,bool),_>=sqlx::query_as("SELECT coalesce(a.nickname,c.nickname),coalesce(a.listed,c.listed),c.account_id IS NOT NULL,coalesce(a.nickname_temporary,c.nickname_temporary) FROM collectors c LEFT JOIN accounts a ON a.id=c.account_id WHERE c.id=$1").bind(c.id).fetch_one(&state.db).await;
    let stats = match state
        .market_lists
        .personal_stats(&state.db, None, Some(c.id))
        .await
    {
        Ok(s) => s,
        Err(e) => return internal(e),
    };
    match result {Ok((name,listed,linked,temporary))=>Json(json!({"nickname":name,"temporary":temporary,"listed":listed,"linked":linked,"stats":stats,"google_enabled":google_enabled(&state, &headers)})).into_response(),Err(e)=>internal(e)}
}
async fn watch_revision(State(state): State<AppState>, headers: HeaderMap) -> Response {
    let c = match collector(&state, &headers).await {
        Ok(c) => c,
        Err(e) => return e,
    };
    let account: Option<i64> =
        match sqlx::query_scalar("SELECT account_id FROM collectors WHERE id=$1")
            .bind(c.id)
            .fetch_one(&state.db)
            .await
        {
            Ok(v) => v,
            Err(e) => return internal(e),
        };
    let rows: Vec<(String, String, i64)> = match sqlx::query_as("SELECT kind,key,version FROM account_data WHERE account_id=$1 AND (kind='watch' OR (kind='pref' AND key='watch.sweepSettings')) ORDER BY kind,key")
        .bind(account).fetch_all(&state.db).await {
        Ok(v) => v,
        Err(e) => return internal(e),
    };
    let bytes = serde_json::to_vec(&(account, rows)).unwrap_or_default();
    let revision = format!("{:x}", Sha256::digest(bytes));
    Json(json!({"linked":account.is_some(),"revision":revision})).into_response()
}
pub(crate) async fn personal_stats(
    db: &PgPool,
    account: Option<i64>,
    collector: Option<i64>,
) -> sqlx::Result<Value> {
    let mut tx = db.begin().await?;
    sqlx::query("SET LOCAL work_mem='32MB'")
        .execute(&mut *tx)
        .await?;
    sqlx::query("SET LOCAL statement_timeout='5s'")
        .execute(&mut *tx)
        .await?;
    let (shops, quotes): (i64, i64) = sqlx::query_as(
        "SELECT count(*),coalesce(sum(quotes),0)::bigint
         FROM contribution_shop_counts(
           ARRAY(SELECT id FROM collectors WHERE account_id=$1 OR id=$2),0,now())",
    )
    .bind(account)
    .bind(collector)
    .fetch_one(&mut *tx)
    .await?;
    tx.commit().await?;
    Ok(json!({"shops":shops,"quotes":quotes}))
}
async fn save_collector(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(profile): Json<Profile>,
) -> Response {
    let c = match collector(&state, &headers).await {
        Ok(c) => c,
        Err(e) => return e,
    };
    let Some(name) = nickname(&profile.nickname) else {
        return error(StatusCode::BAD_REQUEST, "invalid_nickname");
    };
    if !state.limiter.allow(&format!("profile:c:{}", c.id), 10) {
        return error(StatusCode::TOO_MANY_REQUESTS, "rate_limited");
    }
    match sqlx::query(
        "UPDATE collectors SET nickname_temporary=CASE WHEN nickname=$2 THEN nickname_temporary ELSE false END,nickname=$2,listed=$3 WHERE id=$1 AND account_id IS NULL",
    )
    .bind(c.id)
    .bind(name)
    .bind(profile.listed)
    .execute(&state.db)
    .await
    {
        Ok(r) if r.rows_affected() == 1 => Json(json!({"ok":true})).into_response(),
        Ok(_) => error(StatusCode::CONFLICT, "manage_on_website"),
        Err(e) => internal(e),
    }
}
async fn create_link(State(state): State<AppState>, headers: HeaderMap) -> Response {
    let c = match collector(&state, &headers).await {
        Ok(c) => c,
        Err(e) => return e,
    };
    if !state.limiter.allow(&format!("link:{}", c.id), 5) {
        return error(StatusCode::TOO_MANY_REQUESTS, "rate_limited");
    }
    let code = auth::new_credentials().token;
    if let Err(e) = sqlx::query(
        "DELETE FROM collector_account_links WHERE expires_at<now() OR used_at IS NOT NULL",
    )
    .execute(&state.db)
    .await
    {
        return internal(e);
    }
    if let Err(e)=sqlx::query("INSERT INTO collector_account_links(code_hash,collector_id,expires_at) VALUES($1,$2,now()+interval '10 minutes')")
        .bind(auth::token_hash(&code)).bind(c.id).execute(&state.db).await{return internal(e)}
    Json(json!({"url":format!("https://{}/account?link={code}",state.settings.hostname),"expires_in":600})).into_response()
}
#[derive(Deserialize)]
struct Link {
    code: String,
}
async fn accept_link(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(link): Json<Link>,
) -> Response {
    let s = match writable(&state, &headers).await {
        Ok(s) => s,
        Err(e) => return e,
    };
    if link.code.len() != 43 {
        return error(StatusCode::BAD_REQUEST, "invalid_link");
    }
    if !state.limiter.allow(&format!("claim:{}", s.id), 10) {
        return error(StatusCode::TOO_MANY_REQUESTS, "rate_limited");
    }
    let mut tx = match state.db.begin().await {
        Ok(t) => t,
        Err(e) => return internal(e),
    };
    let c:Option<i64>=match sqlx::query_scalar("UPDATE collector_account_links SET used_at=now() WHERE code_hash=$1 AND used_at IS NULL AND expires_at>now() RETURNING collector_id")
        .bind(auth::token_hash(&link.code)).fetch_optional(&mut *tx).await{Ok(c)=>c,Err(e)=>return internal(e)};
    let Some(c) = c else {
        return error(StatusCode::CONFLICT, "expired_link");
    };
    match link_collector(&mut tx, c, s.id).await {
        Ok(true) => {}
        Ok(false) => return error(StatusCode::CONFLICT, "already_linked"),
        Err(e) => return internal(e),
    }
    if let Err(e) = tx.commit().await {
        return internal(e);
    }
    Json(json!({"ok":true})).into_response()
}
/// Binds an active collector unless another account owns it. A temporary
/// account nickname takes over the profile of its first collector.
pub(crate) async fn link_collector(
    tx: &mut sqlx::PgConnection,
    collector: i64,
    account: i64,
) -> sqlx::Result<bool> {
    let linked = sqlx::query("UPDATE collectors SET account_id=$2 WHERE id=$1 AND active AND (account_id IS NULL OR account_id=$2)")
        .bind(collector).bind(account).execute(&mut *tx).await?.rows_affected() == 1;
    if linked {
        sqlx::query("UPDATE accounts a SET nickname=c.nickname,listed=c.listed,nickname_temporary=c.nickname_temporary FROM collectors c WHERE a.id=$1 AND c.id=$2 AND a.nickname_temporary AND c.nickname<>'' AND (SELECT count(*) FROM collectors WHERE account_id=a.id)=1")
            .bind(account).bind(collector).execute(&mut *tx).await?;
    }
    Ok(linked)
}

#[derive(Deserialize)]
struct BoardQuery {
    #[serde(default)]
    period: String,
}
#[derive(Serialize, FromRow)]
struct BoardRow {
    nickname: String,
    shops: i64,
    quotes: i64,
    days: i64,
}
async fn leaderboard(
    State(state): State<AppState>,
    ClientAddr(addr): ClientAddr,
    Query(q): Query<BoardQuery>,
) -> Response {
    // An open board refetches on each market event. Keep burst protection
    // without cutting off legitimate live readers at one upload per second.
    if !state.limiter.allow(&format!("contributors:{addr}"), 600) {
        return error(StatusCode::TOO_MANY_REQUESTS, "rate_limited");
    }
    let days = match q.period.as_str() {
        "" | "week" => 7,
        "month" => 30,
        "all" => 0,
        _ => return error(StatusCode::BAD_REQUEST, "invalid_period"),
    };
    match state
        .market_lists
        .report(&state.db, crate::market_cache::Report::Leaderboard(days))
        .await
    {
        Ok((_, body)) => crate::api::json_response(None, body),
        Err(e) => internal(e),
    }
}

// Include privacy/profile changes in the cache identity even without an upload.
pub(crate) async fn board_identity(db: &PgPool) -> sqlx::Result<String> {
    sqlx::query_scalar(
        "SELECT COALESCE(json_agg(p ORDER BY id)::text,'[]') FROM (
      SELECT c.id,c.active,c.account_id,coalesce(a.listed,c.listed) listed,
        coalesce(a.nickname,c.nickname) nickname
      FROM collectors c LEFT JOIN accounts a ON a.id=c.account_id) p",
    )
    .fetch_one(db)
    .await
}

pub(crate) async fn board(db: &PgPool, days: i32) -> sqlx::Result<Value> {
    let mut tx = db.begin().await?;
    // Only the bounded report rebuilds get this allowance; avoid a global
    // work_mem increase and prevent a large distinct-state sort spilling to disk.
    sqlx::query("SET LOCAL work_mem='32MB'")
        .execute(&mut *tx)
        .await?;
    sqlx::query("SET LOCAL statement_timeout='5s'")
        .execute(&mut *tx)
        .await?;
    // A row/price/stock state counts only once per person, across linked devices.
    // Rank by distinct shops, so repeatedly reopening one shop cannot farm rank.
    let rows = sqlx::query_as::<_, BoardRow>(
        r#"
        WITH public_collectors AS MATERIALIZED (
          SELECT c.id, CASE WHEN a.id IS NULL THEN c.id ELSE -a.id END actor,
                 coalesce(a.nickname,c.nickname) nickname
          FROM collectors c LEFT JOIN accounts a ON a.id=c.account_id
          WHERE c.active AND coalesce(a.listed,c.listed) AND coalesce(a.nickname,c.nickname)<>''
        ), actors AS (
          SELECT actor,nickname,array_agg(id) ids FROM public_collectors GROUP BY actor,nickname
        )
        SELECT p.nickname,q.shops,q.quotes,v.days FROM actors p
        CROSS JOIN LATERAL (
          SELECT count(*)::bigint shops,coalesce(sum(quotes),0)::bigint quotes
          FROM contribution_shop_counts(p.ids,$1,now())
        ) q
        CROSS JOIN LATERAL (
          SELECT count(DISTINCT d.day)::bigint days FROM contribution_days d
          WHERE d.collector_id=ANY(p.ids) AND CASE $1 WHEN 0 THEN d.first_seen<=now()
            WHEN 7 THEN d.week_windows @> now() ELSE d.month_windows @> now() END
        ) v
        WHERE q.shops>0 AND v.days>0
        ORDER BY shops DESC,quotes DESC,days DESC,
          CASE WHEN p.actor<0 THEN 'a:'||(-p.actor) ELSE 'c:'||p.actor END LIMIT 100
    "#,
    )
    .bind(days)
    .fetch_all(&mut *tx)
    .await?;
    tx.commit().await?;
    Ok(json!({"period":if days==0{"all"}else if days==30{"month"}else{"week"},"contributors":rows}))
}

#[derive(Deserialize)]
struct StartQuery {
    link: Option<String>,
}
async fn google_start(
    State(state): State<AppState>,
    ClientAddr(addr): ClientAddr,
    Query(q): Query<StartQuery>,
    headers: HeaderMap,
) -> Response {
    if let Some(host) = headers.get(header::HOST).and_then(|h| h.to_str().ok()) {
        if host != state.settings.hostname && state.settings.public_hostname_matches(host) {
            let mut url = url::Url::parse(&format!(
                "https://{}/auth/google/start",
                state.settings.hostname
            ))
            .unwrap();
            if let Some(link) = q.link {
                url.query_pairs_mut().append_pair("link", &link);
            }
            return Redirect::to(url.as_str()).into_response();
        }
    }
    if !state.limiter.allow(&format!("google:{addr}"), 10) {
        return error(StatusCode::TOO_MANY_REQUESTS, "rate_limited");
    }
    begin_google(&state, q.link, None).await
}
async fn link_google(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(input): Json<crate::accounts::Sensitive>,
) -> Response {
    let s = match crate::accounts::sensitive(&state, &headers, &input.current_password).await {
        Ok(s) => s,
        Err(e) => return e,
    };
    if !google_enabled(&state, &headers) {
        return error(StatusCode::SERVICE_UNAVAILABLE, "google_unavailable");
    }
    begin_google(
        &state,
        None,
        Some((s.id, auth::token_hash(cookie(&headers, SESSION).unwrap()))),
    )
    .await
}
async fn begin_google(
    state: &AppState,
    link: Option<String>,
    binding: Option<(i64, Vec<u8>)>,
) -> Response {
    let Some(config) = &state.google else {
        return Redirect::to("/account?error=google_unavailable").into_response();
    };
    let state_token = auth::new_credentials().token;
    if let Err(e) = sqlx::query("DELETE FROM google_login_states WHERE expires_at<now()")
        .execute(&state.db)
        .await
    {
        return internal(e);
    }
    let browser = auth::new_credentials().token;
    let nonce = auth::new_credentials().token;
    let verifier = auth::new_credentials().token;
    let link = link.filter(|s| {
        s.len() == 43
            && s.bytes()
                .all(|c| c.is_ascii_alphanumeric() || b"_-".contains(&c))
    });
    if let Err(e)=sqlx::query("INSERT INTO google_login_states(state_hash,browser_hash,nonce,verifier,link_code,expires_at,account_id,session_hash) VALUES($1,$2,$3,$4,$5,now()+interval '10 minutes',$6,$7)")
        .bind(auth::token_hash(&state_token)).bind(auth::token_hash(&browser)).bind(&nonce).bind(&verifier).bind(link).bind(binding.as_ref().map(|b|b.0)).bind(binding.as_ref().map(|b|&b.1)).execute(&state.db).await{return internal(e)}
    let mut url = url::Url::parse("https://accounts.google.com/o/oauth2/v2/auth").unwrap();
    url.query_pairs_mut().extend_pairs([
        ("client_id", config.client_id.as_str()),
        ("redirect_uri", &config.redirect_uri),
        ("response_type", "code"),
        ("scope", "openid"),
        ("state", &state_token),
        ("nonce", &nonce),
        ("code_challenge_method", "S256"),
        (
            "code_challenge",
            &base64::engine::general_purpose::URL_SAFE_NO_PAD
                .encode(Sha256::digest(verifier.as_bytes())),
        ),
    ]);
    if binding.is_some() {
        url.query_pairs_mut()
            .append_pair("prompt", "select_account");
    }
    let mut response = if binding.is_some() {
        Json(json!({"url":url.as_str()})).into_response()
    } else {
        Redirect::to(url.as_str()).into_response()
    };
    set_cookie(&mut response, LOGIN, &browser, 600);
    response
}
#[derive(Deserialize)]
struct Callback {
    code: Option<String>,
    state: Option<String>,
}
#[derive(FromRow)]
struct LoginState {
    nonce: String,
    verifier: String,
    link_code: Option<String>,
    account_id: Option<i64>,
    session_hash: Option<Vec<u8>>,
}
#[derive(Deserialize)]
struct GoogleClaims {
    sub: String,
    nonce: String,
    iat: u64,
    azp: Option<String>,
}
async fn google_identity(
    config: &GoogleOAuth,
    code: &str,
    login: &LoginState,
) -> anyhow::Result<String> {
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(15))
        .redirect(reqwest::redirect::Policy::none())
        .build()?;
    let tokens: Value = client
        .post("https://oauth2.googleapis.com/token")
        .form(&[
            ("code", code),
            ("client_id", &config.client_id),
            ("client_secret", &config.client_secret),
            ("redirect_uri", &config.redirect_uri),
            ("grant_type", "authorization_code"),
            ("code_verifier", &login.verifier),
        ])
        .send()
        .await?
        .error_for_status()?
        .json()
        .await?;
    let token = tokens
        .get("id_token")
        .and_then(Value::as_str)
        .ok_or_else(|| anyhow::anyhow!("Missing identity"))?;
    let keys: JwkSet = client
        .get("https://www.googleapis.com/oauth2/v3/certs")
        .send()
        .await?
        .error_for_status()?
        .json()
        .await?;
    verify_identity(token, &keys, &config.client_id, &login.nonce)
}
fn verify_identity(
    token: &str,
    keys: &JwkSet,
    client_id: &str,
    nonce: &str,
) -> anyhow::Result<String> {
    let header = decode_header(token)?;
    anyhow::ensure!(header.alg == Algorithm::RS256, "Invalid algorithm");
    let key = header
        .kid
        .as_deref()
        .and_then(|kid| keys.find(kid))
        .ok_or_else(|| anyhow::anyhow!("Unknown signing key"))?;
    let mut validation = Validation::new(Algorithm::RS256);
    validation.set_audience(&[client_id]);
    validation.set_issuer(&["https://accounts.google.com", "accounts.google.com"]);
    validation.set_required_spec_claims(&["exp", "iss", "aud", "sub", "iat", "nonce"]);
    validation.leeway = 30;
    let claims = decode::<GoogleClaims>(token, &DecodingKey::from_jwk(key)?, &validation)?.claims;
    anyhow::ensure!(
        claims.nonce == nonce
            && !claims.sub.is_empty()
            && claims.sub.len() <= 255
            && claims.iat <= crate::unix_now() as u64 + 60
            && claims.azp.as_deref().is_none_or(|a| a == client_id),
        "Invalid identity claims"
    );
    Ok(claims.sub)
}
async fn google_callback(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(q): Query<Callback>,
) -> Response {
    let fail = || {
        let mut r = Redirect::to("/account?error=login_failed").into_response();
        set_cookie(&mut r, LOGIN, "", 0);
        r
    };
    let Some(config) = &state.google else {
        return fail();
    };
    let (Some(code), Some(token), Some(browser)) = (q.code, q.state, cookie(&headers, LOGIN))
    else {
        return fail();
    };
    if code.len() > 4096 || token.len() != 43 || browser.len() != 43 {
        return fail();
    }
    let login:Option<LoginState>=match sqlx::query_as("DELETE FROM google_login_states WHERE state_hash=$1 AND browser_hash=$2 AND expires_at>now() RETURNING nonce,verifier,link_code,account_id,session_hash")
        .bind(auth::token_hash(&token)).bind(auth::token_hash(browser)).fetch_optional(&state.db).await{Ok(s)=>s,Err(e)=>return internal(e)};
    let Some(login) = login else { return fail() };
    if let Some(account) = login.account_id {
        let Some(token) = cookie(&headers, SESSION) else {
            return fail();
        };
        if login.session_hash.as_deref() != Some(auth::token_hash(token).as_slice()) {
            return fail();
        }
        match session(&state, &headers).await {
            Ok(Some(s)) if s.id == account => {}
            _ => return fail(),
        }
    }
    let subject = match google_identity(config, &code, &login).await {
        Ok(s) => s,
        Err(_) => return fail(),
    };
    let account = match google_account(
        &state.db,
        &subject,
        login.account_id.zip(login.session_hash),
    )
    .await
    {
        Ok(a) => a,
        Err(e) => return e,
    };
    let target = login
        .link_code
        .map(|c| format!("/account?link={c}"))
        .unwrap_or_else(|| "/account".into());
    let mut response = crate::accounts::signed_in(
        &state,
        &headers,
        account,
        crate::accounts::Proof::Google(subject),
        Redirect::to(&target).into_response(),
    )
    .await;
    set_cookie(&mut response, LOGIN, "", 0);
    response
}
/// Resolve only a cryptographically verified Google subject. Binding callers
/// must have already verified the existing session and its single-use state.
pub async fn google_account(
    db: &PgPool,
    subject: &str,
    binding: Option<(i64, Vec<u8>)>,
) -> Result<i64, Response> {
    let mut tx = db.begin().await.map_err(internal)?;
    let account = if let Some((account, session_hash)) = binding {
        let existing: Option<String> =
            sqlx::query_scalar("SELECT google_sub FROM accounts WHERE id=$1 FOR UPDATE")
                .bind(account)
                .fetch_one(&mut *tx)
                .await
                .map_err(internal)?;
        let active:bool=sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM account_sessions WHERE account_id=$1 AND token_hash=$2 AND expires_at>now())")
            .bind(account).bind(session_hash).fetch_one(&mut *tx).await.map_err(internal)?;
        if !active {
            return Err(Redirect::to("/account?error=reauth_required").into_response());
        }
        if existing.as_deref().is_some_and(|s| s != subject) {
            return Err(Redirect::to("/account?error=google_already_linked").into_response());
        }
        let owner: Option<i64> = sqlx::query_scalar(
            "SELECT account_id FROM account_identities WHERE provider='google' AND subject=$1",
        )
        .bind(subject)
        .fetch_optional(&mut *tx)
        .await
        .map_err(internal)?;
        if owner.is_some_and(|id| id != account) {
            return Err(Redirect::to("/account?error=google_already_linked").into_response());
        }
        if let Err(e) = sqlx::query("UPDATE accounts SET google_sub=$2 WHERE id=$1")
            .bind(account)
            .bind(subject)
            .execute(&mut *tx)
            .await
        {
            if e.as_database_error()
                .is_some_and(|e| e.is_unique_violation())
            {
                return Err(Redirect::to("/account?error=google_already_linked").into_response());
            }
            return Err(internal(e));
        }
        account
    } else {
        sqlx::query_scalar("INSERT INTO accounts(public_id,google_sub,listed) VALUES($1,$2,false) ON CONFLICT(google_sub) DO UPDATE SET google_sub=excluded.google_sub RETURNING id")
            .bind(auth::new_credentials().public_id).bind(subject).fetch_one(&mut *tx).await.map_err(internal)?
    };
    sqlx::query("INSERT INTO account_identities(account_id,provider,subject) VALUES($1,'google',$2) ON CONFLICT DO NOTHING").bind(account).bind(subject).execute(&mut *tx).await.map_err(internal)?;
    let owner: i64 = sqlx::query_scalar(
        "SELECT account_id FROM account_identities WHERE provider='google' AND subject=$1",
    )
    .bind(subject)
    .fetch_one(&mut *tx)
    .await
    .map_err(internal)?;
    if owner != account {
        return Err(Redirect::to("/account?error=google_already_linked").into_response());
    }
    tx.commit().await.map_err(internal)?;
    Ok(account)
}
pub async fn new_session(db: &PgPool, account: i64, token: &str) -> sqlx::Result<()> {
    sqlx::query("DELETE FROM account_sessions WHERE expires_at<now()")
        .execute(db)
        .await?;
    sqlx::query("INSERT INTO account_sessions(token_hash,account_id,csrf,expires_at) VALUES($1,$2,$3,now()+interval '90 days')")
        .bind(auth::token_hash(token)).bind(account).bind(auth::new_credentials().token).execute(db).await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn identity_rejects_wrong_signature_audience_issuer_nonce_and_expiry() {
        // Disposable test-only signing key. Never accepted by the Google JWKS endpoint.
        let key = jsonwebtoken::EncodingKey::from_rsa_pem(include_bytes!(
            "../tests/fixtures/test-only-oidc.pem"
        ))
        .unwrap();
        let keys: JwkSet =
            serde_json::from_str(include_str!("../tests/fixtures/test-only-oidc-jwks.json"))
                .unwrap();
        let now = crate::unix_now() as u64;
        let claims = json!({"sub":"test-user","aud":"test-client","iss":"https://accounts.google.com","iat":now,"exp":now+3600,"nonce":"test-nonce","azp":"test-client"});
        let mut header = jsonwebtoken::Header::new(Algorithm::RS256);
        header.kid = Some("fixture".into());
        let signed = |v: &Value| jsonwebtoken::encode(&header, v, &key).unwrap();
        assert_eq!(
            verify_identity(&signed(&claims), &keys, "test-client", "test-nonce").unwrap(),
            "test-user"
        );
        for (field, bad) in [
            ("aud", json!("other-client")),
            ("iss", json!("https://evil.example")),
            ("nonce", json!("replayed")),
            ("azp", json!("other-client")),
            ("exp", json!(now - 120)),
            ("iat", json!(now + 120)),
            ("sub", json!("")),
        ] {
            let mut c = claims.clone();
            c[field] = bad;
            assert!(
                verify_identity(&signed(&c), &keys, "test-client", "test-nonce").is_err(),
                "accepted invalid {field}"
            );
        }
        let mut tampered = signed(&claims).into_bytes();
        let i = tampered.len() - 20;
        tampered[i] = if tampered[i] == b'A' { b'B' } else { b'A' };
        assert!(verify_identity(
            std::str::from_utf8(&tampered).unwrap(),
            &keys,
            "test-client",
            "test-nonce"
        )
        .is_err());
        let wrong_algorithm = jsonwebtoken::encode(
            &jsonwebtoken::Header::default(),
            &claims,
            &jsonwebtoken::EncodingKey::from_secret(b"test-only"),
        )
        .unwrap();
        assert!(verify_identity(&wrong_algorithm, &keys, "test-client", "test-nonce").is_err());
    }
    #[test]
    fn nicknames_are_plain_and_bounded() {
        assert_eq!(nickname(" 枫叶玩家 "), Some("枫叶玩家".into()));
        for bad in [
            "x",
            "<script>",
            "a\nb",
            "\u{202e}admin",
            "abcdefghijklmnopqrstuvwxyz",
        ] {
            assert!(nickname(bad).is_none());
        }
    }
}

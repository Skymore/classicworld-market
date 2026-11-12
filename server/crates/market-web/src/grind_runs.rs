//! Whole grind runs: synced from a client to its account, shared publicly by
//! link (`/g/<code>`), plus the site-wide map leaderboard. The anonymous
//! per-map statistics stay in `grind.rs`.
#![allow(clippy::result_large_err)]

use axum::{
    body::Bytes,
    extract::{Path, RawQuery, State},
    http::{header, HeaderMap, HeaderValue, StatusCode},
    response::{Html, IntoResponse, Response},
    routing::{get, post},
    Json, Router,
};
use serde_json::{json, Value};
use sqlx::PgPool;

use crate::api::{bearer, error, internal, reader, ClientAddr};
use crate::{auth, unix_now, AppState};

/// A run summary is a few dozen rows of loot, kills and skills; rate history
/// is capped by the client. Anything larger is not a run.
pub const MAX_RUN: usize = 192 * 1024;
const CODE_ALPHABET: &[u8] = b"ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789";
/// Money fields hidden when a share leaves profit out.
const MONEY: [&str; 12] = [
    "mesos",
    "item_value",
    "consume_cost",
    "mesos_spent",
    "net",
    "net_per_hour",
    "net_per_hour_1m",
    "cash_per_hour",
    "loot",
    "consumables",
    "drops_value",
    "rate_history_net",
];

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/api/v1/collector/grind-run", post(sync))
        .route("/api/v1/collector/grind-share", post(share))
        .route("/api/v1/collector/grind-live", post(live_push))
        .route("/api/v1/grind/share/{code}", get(shared))
        .route("/api/v1/grind/live", get(my_live))
        .route("/api/v1/grind/runs", get(my_runs))
        .route("/api/v1/grind/runs/{id}", get(my_run))
        .route("/api/v1/grind/runs/{id}/share", post(share_mine))
        .route("/api/v1/grind/leaderboard", get(leaderboard))
}

/// `/g/<code>`: the site shell with the run in the title and link previews.
pub fn pages() -> Router<AppState> {
    Router::new().route("/g/{code}", get(share_page))
}

fn number(run: &Value, key: &str) -> Option<f64> {
    run.get(key)
        .and_then(Value::as_f64)
        .filter(|v| v.is_finite())
}

/// The fields a run must carry, checked before anything is stored.
pub struct RunRow {
    pub run_id: String,
    pub started_at: f64,
    pub ended_at: f64,
    pub map_id: Option<i32>,
    pub level: Option<i16>,
    pub job: Option<i32>,
    pub active_seconds: i32,
    pub exp: i64,
    pub net: i64,
    pub kills: i32,
}

pub fn validate(run: &Value, now: f64) -> Option<RunRow> {
    let run_id = run.get("id")?.as_str()?;
    if run_id.len() != 32 || !run_id.bytes().all(|b| b.is_ascii_hexdigit()) {
        return None;
    }
    let started_at = number(run, "started_at")?;
    let ended_at = number(run, "ended_at").unwrap_or(started_at);
    let active = number(run, "active_seconds")?;
    if started_at < now - 400. * 86400.
        || ended_at > now + 600.
        || ended_at < started_at
        || !(0.0..=7.0 * 86400.).contains(&active)
    {
        return None;
    }
    let character = run.get("character").cloned().unwrap_or(Value::Null);
    let int = |v: Option<f64>| v.map(|v| v.round() as i64);
    Some(RunRow {
        run_id: run_id.to_ascii_lowercase(),
        started_at,
        ended_at,
        map_id: int(number(run, "map_id")).and_then(|v| i32::try_from(v).ok()),
        level: int(number(run, "level").or_else(|| number(&character, "level")))
            .and_then(|v| i16::try_from(v).ok())
            .filter(|v| (1..=250).contains(v)),
        job: int(number(&character, "job")).and_then(|v| i32::try_from(v).ok()),
        active_seconds: active.round() as i32,
        exp: int(number(run, "exp"))
            .unwrap_or(0)
            .clamp(-10_000_000_000_000, 10_000_000_000_000),
        net: int(number(run, "net"))
            .unwrap_or(0)
            .clamp(-10_000_000_000_000, 10_000_000_000_000),
        kills: int(number(run, "kills")).unwrap_or(0).clamp(0, 10_000_000) as i32,
    })
}

/// Upserts a run; returns its row ID.
pub async fn store(
    db: &PgPool,
    collector: i64,
    run: &Value,
    now: f64,
) -> sqlx::Result<Option<i64>> {
    let Some(row) = validate(run, now) else {
        return Ok(None);
    };
    sqlx::query_scalar(
        "INSERT INTO grind_runs (collector_id, run_id, started_at, ended_at, map_id, level, job, active_seconds,
           exp, net, kills, summary)
         VALUES ($1,$2,to_timestamp($3),to_timestamp($4),$5,$6,$7,$8,$9,$10,$11,$12)
         ON CONFLICT (collector_id, run_id) DO UPDATE SET ended_at=excluded.ended_at, map_id=excluded.map_id,
           level=excluded.level, job=excluded.job, active_seconds=excluded.active_seconds, exp=excluded.exp,
           net=excluded.net, kills=excluded.kills, summary=excluded.summary, updated_at=now()
         RETURNING id",
    )
    .bind(collector)
    .bind(&row.run_id)
    .bind(row.started_at)
    .bind(row.ended_at)
    .bind(row.map_id)
    .bind(row.level)
    .bind(row.job)
    .bind(row.active_seconds)
    .bind(row.exp)
    .bind(row.net)
    .bind(row.kills)
    .bind(run)
    .fetch_one(db)
    .await
    .map(Some)
}

async fn client(
    state: &AppState,
    headers: &HeaderMap,
    scope: &str,
    per_minute: usize,
) -> Result<i64, Response> {
    let collector = match auth::authenticate(&state.db, bearer(headers)).await {
        Ok(Some(c)) => c,
        Ok(None) => return Err(error(StatusCode::UNAUTHORIZED, "Collector token required")),
        Err(e) => return Err(internal(e)),
    };
    if !state
        .limiter
        .allow(&format!("{scope}:{}", collector.id), per_minute)
    {
        return Err(error(StatusCode::TOO_MANY_REQUESTS, "Rate limited"));
    }
    Ok(collector.id)
}

fn body_run(body: &Bytes) -> Option<Value> {
    if body.len() > MAX_RUN {
        return None;
    }
    let value: Value = serde_json::from_slice(body).ok()?;
    let run = value.get("run")?.clone();
    run.is_object().then_some(run)
}

async fn sync(State(state): State<AppState>, headers: HeaderMap, body: Bytes) -> Response {
    let collector = match client(&state, &headers, "grind-run", 60).await {
        Ok(id) => id,
        Err(response) => return response,
    };
    let Some(run) = body_run(&body) else {
        return error(StatusCode::BAD_REQUEST, "Invalid grind run");
    };
    match store(&state.db, collector, &run, unix_now()).await {
        Ok(Some(id)) => Json(json!({"ok": true, "id": id})).into_response(),
        Ok(None) => error(StatusCode::BAD_REQUEST, "Invalid grind run"),
        Err(e) => internal(e),
    }
}

fn new_code() -> String {
    let mut bytes = [0u8; 7];
    getrandom::getrandom(&mut bytes).expect("rng");
    bytes
        .iter()
        .map(|b| CODE_ALPHABET[*b as usize % CODE_ALPHABET.len()] as char)
        .collect()
}

/// The share code of a stored run with these options, created once.
pub async fn share_code(
    db: &PgPool,
    run: i64,
    show_name: bool,
    show_profit: bool,
) -> sqlx::Result<String> {
    for _ in 0..5 {
        let code = new_code();
        let found: Option<String> = sqlx::query_scalar(
            "WITH inserted AS (
               INSERT INTO grind_shares (code, run, show_name, show_profit) VALUES ($1,$2,$3,$4)
               ON CONFLICT DO NOTHING RETURNING code)
             SELECT code FROM inserted
             UNION ALL SELECT code FROM grind_shares WHERE run=$2 AND show_name=$3 AND show_profit=$4
             LIMIT 1",
        )
        .bind(&code)
        .bind(run)
        .bind(show_name)
        .bind(show_profit)
        .fetch_optional(db)
        .await?;
        if let Some(code) = found {
            return Ok(code);
        }
    }
    Err(sqlx::Error::Protocol("no free share code".into()))
}

async fn share(State(state): State<AppState>, headers: HeaderMap, body: Bytes) -> Response {
    let collector = match client(&state, &headers, "grind-share", 20).await {
        Ok(id) => id,
        Err(response) => return response,
    };
    let Some(run) = body_run(&body) else {
        return error(StatusCode::BAD_REQUEST, "Invalid grind run");
    };
    let options: Value = serde_json::from_slice(&body).unwrap_or(Value::Null);
    let flag = |key: &str| options.get(key).and_then(Value::as_bool).unwrap_or(true);
    let id = match store(&state.db, collector, &run, unix_now()).await {
        Ok(Some(id)) => id,
        Ok(None) => return error(StatusCode::BAD_REQUEST, "Invalid grind run"),
        Err(e) => return internal(e),
    };
    match share_code(&state.db, id, flag("show_name"), flag("show_profit")).await {
        Ok(code) => Json(json!({"ok": true, "code": code,
            "url": format!("https://{}/g/{code}", state.settings.hostname)}))
        .into_response(),
        Err(e) => internal(e),
    }
}

/// A run as a share shows it: no name or money when the sharer left them out.
pub fn public_view(mut run: Value, show_name: bool, show_profit: bool) -> Value {
    if let Some(object) = run.as_object_mut() {
        object.remove("rate_history_private");
        if !show_name {
            if let Some(Value::Object(character)) = object.get_mut("character") {
                character.remove("name");
                character.remove("key");
            }
        }
        if !show_profit {
            for key in MONEY {
                object.remove(key);
            }
            if let Some(Value::Array(rows)) = object.get_mut("drops") {
                for row in rows.iter_mut().filter_map(Value::as_object_mut) {
                    row.remove("value");
                }
            }
        }
    }
    run
}

/// How this run's EXP/h compares with uploads from the same map and level
/// band (and job when there are enough). None below five comparable runs.
pub async fn comparison(db: &PgPool, run: &Value, now: f64) -> sqlx::Result<Option<Value>> {
    let (Some(map), Some(level), Some(active)) = (
        number(run, "map_id"),
        number(run, "level").or_else(|| run.get("character").and_then(|c| number(c, "level"))),
        number(run, "active_seconds").filter(|a| *a >= 300.0),
    ) else {
        return Ok(None);
    };
    let exp_h = number(run, "exp").unwrap_or(0.0) * 3600.0 / active;
    let job = run
        .get("character")
        .and_then(|c| number(c, "job"))
        .map(|j| j as i32);
    let band = ((level as i32 - 1) / 5) * 5 + 1;
    for by_job in [true, false] {
        if by_job && job.is_none() {
            continue;
        }
        let (count, below, median): (i64, i64, Option<f64>) = sqlx::query_as(
            "SELECT count(*), count(*) FILTER (WHERE g.exp * 3600.0 / g.active_seconds < $5),
               percentile_cont(0.5) WITHIN GROUP (ORDER BY g.exp * 3600.0 / g.active_seconds)
             FROM grind_segments g JOIN grind_sessions x ON x.id = g.session_id
             WHERE g.map_id = $1 AND g.level BETWEEN $2 AND $2 + 4 AND g.active_seconds >= 300
               AND x.ended_at >= to_timestamp($3) AND ($4::int IS NULL OR g.job = $4)",
        )
        .bind(map as i32)
        .bind(band as i16)
        .bind(now - 90.0 * 86400.0)
        .bind(if by_job { job } else { None })
        .bind(exp_h)
        .fetch_one(db)
        .await?;
        if count >= 5 {
            return Ok(Some(
                json!({"level_from": band, "level_to": band + 4, "job": if by_job { job } else { None },
                "runs": count, "exp_per_hour_median": median, "exp_better_than": below as f64 / count as f64}),
            ));
        }
    }
    Ok(None)
}

pub async fn load_share(db: &PgPool, code: &str, now: f64) -> sqlx::Result<Option<Value>> {
    if code.len() != 7 || !code.bytes().all(|b| b.is_ascii_alphanumeric()) {
        return Ok(None);
    }
    let row: Option<(Value, bool, bool, i32, f64)> = sqlx::query_as(
        "UPDATE grind_shares s SET views = views + 1 FROM grind_runs r WHERE s.code=$1 AND r.id=s.run
         RETURNING r.summary, s.show_name, s.show_profit, s.views, extract(epoch FROM s.created_at)::float8",
    )
    .bind(code)
    .fetch_optional(db)
    .await?;
    let Some((summary, show_name, show_profit, views, created)) = row else {
        return Ok(None);
    };
    let compare = comparison(db, &summary, now).await?;
    Ok(Some(
        json!({"code": code, "run": public_view(summary, show_name, show_profit), "show_name": show_name,
        "show_profit": show_profit, "views": views, "shared_at": created, "comparison": compare}),
    ))
}

async fn shared(
    State(state): State<AppState>,
    ClientAddr(addr): ClientAddr,
    headers: HeaderMap,
    Path(code): Path<String>,
) -> Response {
    if let Err(response) = reader(&state, &headers, &addr, "grind-share").await {
        return response;
    }
    match load_share(&state.db, &code, unix_now()).await {
        Ok(Some(value)) => Json(value).into_response(),
        Ok(None) => error(StatusCode::NOT_FOUND, "Not found"),
        Err(e) => internal(e),
    }
}

/// Open runs a client may push at once (one per character it tracks).
pub const MAX_LIVE: usize = 4;
/// A live row older than this is a client that stopped or went offline.
const LIVE_SECONDS: i32 = 90;

/// Replaces a client's open runs; an empty list clears them. Returns how many were kept.
pub async fn store_live(db: &PgPool, collector: i64, runs: &[Value], now: f64) -> sqlx::Result<usize> {
    let kept: Vec<Value> = runs
        .iter()
        .filter(|run| run.is_object() && validate(run, now).is_some())
        .take(MAX_LIVE)
        .cloned()
        .collect();
    if kept.is_empty() {
        sqlx::query("DELETE FROM grind_live WHERE collector_id=$1")
            .bind(collector)
            .execute(db)
            .await?;
        return Ok(0);
    }
    sqlx::query(
        "INSERT INTO grind_live (collector_id, runs) VALUES ($1,$2)
         ON CONFLICT (collector_id) DO UPDATE SET runs=excluded.runs, updated_at=now()",
    )
    .bind(collector)
    .bind(Value::Array(kept.clone()))
    .execute(db)
    .await?;
    Ok(kept.len())
}

/// Open runs of every client linked to this account that pushed recently.
pub async fn live_of(db: &PgPool, account: i64) -> sqlx::Result<Value> {
    let rows: Vec<(Value, f64)> = sqlx::query_as(
        "SELECT l.runs, extract(epoch FROM l.updated_at)::float8 FROM grind_live l
         JOIN collectors c ON c.id = l.collector_id
         WHERE c.account_id = $1 AND l.updated_at > now() - make_interval(secs => $2)
         ORDER BY l.updated_at DESC",
    )
    .bind(account)
    .bind(LIVE_SECONDS)
    .fetch_all(db)
    .await?;
    let mut out = Vec::new();
    for (runs, at) in rows {
        for mut run in runs.as_array().cloned().unwrap_or_default() {
            if let Some(object) = run.as_object_mut() {
                object.insert("live_at".into(), json!(at));
            }
            out.push(run);
        }
    }
    Ok(Value::Array(out))
}

async fn live_push(State(state): State<AppState>, headers: HeaderMap, body: Bytes) -> Response {
    let collector = match client(&state, &headers, "grind-live", 30).await {
        Ok(id) => id,
        Err(response) => return response,
    };
    let runs = (body.len() <= MAX_RUN * 2)
        .then(|| serde_json::from_slice::<Value>(&body).ok())
        .flatten()
        .and_then(|v| v.get("runs").and_then(Value::as_array).cloned());
    let Some(runs) = runs else {
        return error(StatusCode::BAD_REQUEST, "Invalid live runs");
    };
    match store_live(&state.db, collector, &runs, unix_now()).await {
        Ok(kept) => Json(json!({"ok": true, "runs": kept})).into_response(),
        Err(e) => internal(e),
    }
}

async fn my_live(State(state): State<AppState>, headers: HeaderMap) -> Response {
    let account = match account(&state, &headers).await {
        Ok(id) => id,
        Err(response) => return response,
    };
    match live_of(&state.db, account).await {
        Ok(runs) => {
            let mut response = Json(json!({"runs": runs})).into_response();
            response
                .headers_mut()
                .insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
            response
        }
        Err(e) => internal(e),
    }
}

async fn account(state: &AppState, headers: &HeaderMap) -> Result<i64, Response> {
    match crate::contributors::session(state, headers).await? {
        Some(session) => Ok(session.id),
        None => Err(error(StatusCode::UNAUTHORIZED, "login_required")),
    }
}

/// Runs of every client linked to this account, newest first, without the bulky rows.
pub async fn runs_of(db: &PgPool, account: i64, limit: i64) -> sqlx::Result<Value> {
    let rows: Vec<(i64, Value, Option<String>)> = sqlx::query_as(
        "SELECT r.id, r.summary - 'rate_history' - 'loot' - 'consumables' - 'segments' - 'attacks' - 'casts' - 'mobs' - 'drops'
                - 'recent' - 'buffs' - 'combat' - 'damage',
           (SELECT code FROM grind_shares s WHERE s.run=r.id ORDER BY created_at LIMIT 1)
         FROM grind_runs r JOIN collectors c ON c.id = r.collector_id
         WHERE c.account_id = $1 ORDER BY r.started_at DESC LIMIT $2",
    )
    .bind(account)
    .bind(limit)
    .fetch_all(db)
    .await?;
    Ok(Value::Array(
        rows.into_iter()
            .map(|(id, mut run, code)| {
                if let Some(object) = run.as_object_mut() {
                    object.insert("row".into(), json!(id));
                    object.insert("share_code".into(), json!(code));
                }
                run
            })
            .collect(),
    ))
}

async fn my_runs(State(state): State<AppState>, headers: HeaderMap) -> Response {
    let account = match account(&state, &headers).await {
        Ok(id) => id,
        Err(response) => return response,
    };
    match runs_of(&state.db, account, 300).await {
        Ok(runs) => Json(json!({"runs": runs})).into_response(),
        Err(e) => internal(e),
    }
}

async fn my_run(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<String>,
) -> Response {
    let account = match account(&state, &headers).await {
        Ok(id) => id,
        Err(response) => return response,
    };
    let Ok(id) = id.parse::<i64>() else {
        return error(StatusCode::NOT_FOUND, "Not found");
    };
    let row: Result<Option<(Value, Option<String>)>, _> = sqlx::query_as(
        "SELECT r.summary, (SELECT code FROM grind_shares s WHERE s.run=r.id ORDER BY created_at LIMIT 1)
         FROM grind_runs r JOIN collectors c ON c.id = r.collector_id WHERE r.id=$1 AND c.account_id=$2",
    )
    .bind(id)
    .bind(account)
    .fetch_optional(&state.db)
    .await;
    match row {
        Ok(Some((run, code))) => {
            let compare = comparison(&state.db, &run, unix_now()).await.ok().flatten();
            Json(json!({"row": id, "run": run, "share_code": code, "comparison": compare}))
                .into_response()
        }
        Ok(None) => error(StatusCode::NOT_FOUND, "Not found"),
        Err(e) => internal(e),
    }
}

/// Whether the run was synced by one of the account's clients.
pub async fn owns(db: &PgPool, account: i64, run: i64) -> sqlx::Result<bool> {
    sqlx::query_scalar(
        "SELECT EXISTS (SELECT 1 FROM grind_runs r JOIN collectors c ON c.id = r.collector_id
         WHERE r.id=$1 AND c.account_id=$2)",
    )
    .bind(run)
    .bind(account)
    .fetch_one(db)
    .await
}

/// Share one of the signed-in account's runs from the website.
async fn share_mine(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<String>,
    body: Bytes,
) -> Response {
    let session = match crate::contributors::writable(&state, &headers).await {
        Ok(s) => s,
        Err(response) => return response,
    };
    let Ok(id) = id.parse::<i64>() else {
        return error(StatusCode::NOT_FOUND, "Not found");
    };
    match owns(&state.db, session.id, id).await {
        Ok(true) => {}
        Ok(false) => return error(StatusCode::NOT_FOUND, "Not found"),
        Err(e) => return internal(e),
    }
    let options: Value = serde_json::from_slice(&body).unwrap_or(Value::Null);
    let flag = |key: &str| options.get(key).and_then(Value::as_bool).unwrap_or(true);
    match share_code(&state.db, id, flag("show_name"), flag("show_profit")).await {
        Ok(code) => Json(json!({"ok": true, "code": code,
            "url": format!("https://{}/g/{code}", state.settings.hostname)}))
        .into_response(),
        Err(e) => internal(e),
    }
}

/// Maps ranked by median EXP/h per level band, from the anonymous uploads.
pub async fn leaderboard_rows(
    db: &PgPool,
    band: Option<i16>,
    job: Option<i32>,
    now: f64,
) -> sqlx::Result<Value> {
    type Row = (
        i16,
        i32,
        Option<String>,
        Option<String>,
        i64,
        f64,
        f64,
        f64,
        f64,
    );
    let rows: Vec<Row> = sqlx::query_as(
        "WITH s AS (
           SELECT ((g.level - 1) / 5) * 5 + 1 AS band, g.map_id, g.session_id, g.active_seconds,
                  g.exp * 3600.0 / g.active_seconds AS exp_h,
                  (g.mesos + g.item_value - g.consume_cost) * 3600.0 / g.active_seconds AS net_h,
                  g.kills * 3600.0 / g.active_seconds AS kills_h
           FROM grind_segments g JOIN grind_sessions x ON x.id = g.session_id
           WHERE g.level IS NOT NULL AND g.active_seconds >= 300 AND x.ended_at >= to_timestamp($1)
             AND ($2::int2 IS NULL OR ((g.level - 1) / 5) * 5 + 1 = $2) AND ($3::int IS NULL OR g.job = $3))
         SELECT s.band::int2, s.map_id, COALESCE(NULLIF(m.name_zh, ''), m.name_en), m.name_en,
           count(DISTINCT s.session_id)::int8, sum(s.active_seconds)::float8 / 3600,
           percentile_cont(0.5) WITHIN GROUP (ORDER BY s.exp_h), percentile_cont(0.5) WITHIN GROUP (ORDER BY s.net_h),
           percentile_cont(0.5) WITHIN GROUP (ORDER BY s.kills_h)
         FROM s LEFT JOIN maps m ON m.id = s.map_id
         GROUP BY s.band, s.map_id, m.name_zh, m.name_en
         ORDER BY s.band, percentile_cont(0.5) WITHIN GROUP (ORDER BY s.exp_h) DESC LIMIT 300",
    )
    .bind(now - 30.0 * 86400.0)
    .bind(band)
    .bind(job)
    .fetch_all(db)
    .await?;
    Ok(Value::Array(rows.into_iter().map(|(band, map, zh, en, runs, hours, exp, net, kills)| json!({
        "level_from": band, "level_to": band + 4, "map_id": map, "name": zh, "name_en": en, "runs": runs,
        "hours": hours, "exp_per_hour": exp, "net_per_hour": net, "kills_per_hour": kills})).collect()))
}

async fn leaderboard(
    State(state): State<AppState>,
    ClientAddr(addr): ClientAddr,
    headers: HeaderMap,
    RawQuery(query): RawQuery,
) -> Response {
    if let Err(response) = reader(&state, &headers, &addr, "grind-leaderboard").await {
        return response;
    }
    let param = |name: &str| {
        query
            .as_deref()
            .unwrap_or("")
            .split('&')
            .find_map(|pair| pair.strip_prefix(name).and_then(|v| v.strip_prefix('=')))
            .and_then(|v| v.parse::<i32>().ok())
    };
    let band = param("level").and_then(|l| i16::try_from(((l.clamp(1, 250) - 1) / 5) * 5 + 1).ok());
    match leaderboard_rows(&state.db, band, param("job"), unix_now()).await {
        Ok(rows) => (
            [(header::CACHE_CONTROL, "public, max-age=300")],
            Json(json!({"days": 30, "rows": rows})),
        )
            .into_response(),
        Err(e) => internal(e),
    }
}

fn escape(text: &str) -> String {
    text.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
}

fn wan(value: f64) -> String {
    if value.abs() >= 1e8 {
        format!("{:.1}亿", value / 1e8)
    } else if value.abs() >= 1e4 {
        format!("{:.1}万", value / 1e4)
    } else {
        format!("{}", value.round() as i64)
    }
}

/// Title and description for link previews, from the shared run.
pub fn preview(share: &Value) -> (String, String) {
    let run = &share["run"];
    let who = run["character"]["name"]
        .as_str()
        .map(str::to_owned)
        .unwrap_or_else(|| {
            run["job_name"]
                .as_str()
                .map(|j| format!("一位{j}"))
                .unwrap_or_else(|| "一位冒险家".into())
        });
    let map = run["map_name"].as_str().unwrap_or("冒险岛");
    let minutes = (number(run, "active_seconds").unwrap_or(0.0) / 60.0).round() as i64;
    let length = if minutes >= 60 {
        format!("{}小时{}分", minutes / 60, minutes % 60)
    } else {
        format!("{minutes}分钟")
    };
    let title = format!("{who}在{map}刷了{length} · 枫叶市集");
    let mut parts = vec![];
    if let Some(v) = number(run, "exp_per_hour") {
        parts.push(format!("经验 {}/时", wan(v)));
    }
    if let Some(v) = number(run, "net_per_hour") {
        parts.push(format!("收益 {}/时", wan(v)));
    }
    if let Some(v) = number(run, "kills") {
        parts.push(format!("击杀 {}", v as i64));
    }
    parts.push("枫叶市集客户端自动记录经验、掉落和收益".into());
    (title, parts.join(" · "))
}

async fn share_page(State(state): State<AppState>, Path(code): Path<String>) -> Response {
    let root = std::env::var_os("WEB_DIR")
        .map(std::path::PathBuf::from)
        .unwrap_or_else(|| "web".into());
    let Ok(shell) = std::fs::read_to_string(root.join("index.html")) else {
        return error(StatusCode::NOT_FOUND, "Not found");
    };
    let mut meta = String::new();
    if let Ok(Some(found)) = load_share(&state.db, &code, unix_now()).await {
        let (title, description) = preview(&found);
        let url = format!("https://{}/g/{code}", state.settings.hostname);
        meta = format!(
            "<meta property=\"og:type\" content=\"website\"><meta property=\"og:site_name\" content=\"枫叶市集\">\
             <meta property=\"og:title\" content=\"{t}\"><meta property=\"og:description\" content=\"{d}\">\
             <meta property=\"og:url\" content=\"{u}\"><meta name=\"description\" content=\"{d}\">\
             <meta name=\"twitter:card\" content=\"summary\"><title>{t}</title>",
            t = escape(&title), d = escape(&description), u = escape(&url));
    }
    let mut html = shell;
    if !meta.is_empty() {
        if let (Some(start), Some(end)) = (html.find("<title>"), html.find("</title>")) {
            html.replace_range(start..end + "</title>".len(), &meta);
        }
    }
    let mut response = Html(html).into_response();
    response
        .headers_mut()
        .insert(header::CACHE_CONTROL, HeaderValue::from_static("no-cache"));
    response
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn shares_hide_name_and_money_when_asked() {
        let run = json!({"character": {"name": "Skyyyy", "key": "Skyyyy", "job": 310}, "net": 5, "mesos": 3,
            "loot": [1], "drops": [{"item_id": 1, "quantity": 2, "value": 9}], "kills": 4});
        let view = public_view(run.clone(), false, false);
        assert_eq!(view["character"], json!({"job": 310}));
        assert!(view.get("net").is_none() && view.get("loot").is_none());
        assert_eq!(view["drops"][0], json!({"item_id": 1, "quantity": 2}));
        assert_eq!(public_view(run.clone(), true, true), run);
    }

    #[test]
    fn previews_name_the_run() {
        let share = json!({"run": {"character": {"name": "Skyyyy"}, "map_name": "第2军营", "active_seconds": 9119,
            "exp_per_hour": 196000.0, "net_per_hour": 10000.0, "kills": 1973}});
        let (title, description) = preview(&share);
        assert_eq!(title, "Skyyyy在第2军营刷了2小时32分 · 枫叶市集");
        assert!(description.starts_with("经验 19.6万/时 · 收益 1.0万/时 · 击杀 1973"));
        let anonymous = json!({"run": {"job_name": "猎人", "active_seconds": 600}});
        assert!(preview(&anonymous)
            .0
            .starts_with("一位猎人在冒险岛刷了10分钟"));
    }

    #[test]
    fn runs_need_an_id_and_sane_times() {
        let now = 1_800_000_000.0;
        let good = json!({"id": "a".repeat(32), "started_at": now - 100.0, "ended_at": now, "active_seconds": 90,
            "exp": 5, "net": -3, "kills": 2, "map_id": 10004141, "character": {"level": 68, "job": 310}});
        let row = validate(&good, now).unwrap();
        assert_eq!(
            (row.level, row.job, row.map_id, row.net),
            (Some(68), Some(310), Some(10004141), -3)
        );
        let mut bad = good.clone();
        bad["id"] = json!("x");
        assert!(validate(&bad, now).is_none());
        let mut future = good;
        future["ended_at"] = json!(now + 3600.0);
        assert!(validate(&future, now).is_none());
    }
}

//! Live sweep runs: one running run per account, a shared budget, 30 second
//! device leases, and reservations that count fully until a result is known.
//! Every accounting change holds the run row lock.
#![allow(clippy::result_large_err)]
use std::collections::HashMap;

use crate::{
    accounts, auth,
    contributors::{error, internal, session, writable},
    devices::{self, Device},
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
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sqlx::{FromRow, PgConnection};

const MAX_AMOUNT: i64 = 1_000_000_000_000;
const LEASE_SECONDS: i64 = 30;

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/api/v1/account/sweep", get(web_get))
        .route("/api/v1/account/sweep/start", post(web_start))
        .route("/api/v1/account/sweep/stop", post(web_stop))
        .route("/api/v1/account/sweep/apply", post(web_apply))
        .route("/api/v1/device/sweep", get(device_get))
        .route("/api/v1/device/sweep/targets", get(device_targets))
        .route("/api/v1/device/sweep/start", post(device_start))
        .route("/api/v1/device/sweep/join", post(join))
        .route("/api/v1/device/sweep/refuse", post(refuse))
        .route("/api/v1/device/sweep/heartbeat", post(heartbeat))
        .route("/api/v1/device/sweep/leave", post(leave))
        .route("/api/v1/device/sweep/stop", post(device_stop))
        .route("/api/v1/device/sweep/reserve", post(reserve))
        .route("/api/v1/device/sweep/settle", post(settle))
        .layer(DefaultBodyLimit::max(64 * 1024))
}

type Reply = Result<Response, Response>;
fn invalid() -> Response {
    error(StatusCode::BAD_REQUEST, "invalid_request")
}
fn conflict(code: &str) -> Response {
    error(StatusCode::CONFLICT, code)
}
fn ok() -> Reply {
    Ok(Json(json!({"ok":true})).into_response())
}
pub(crate) fn public_id(s: &str) -> bool {
    s.len() == 24 && s.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

/// Groups that can sweep: buy ticked, a fixed positive cap, every percentile, not "missing".
fn sweepable(group: &Value) -> bool {
    let reminder = &group["reminder"];
    group["buy"] == true
        && group["cap"].as_f64().is_some_and(|cap| cap > 0.0)
        && reminder.get("percentile").is_none_or(|p| p == "all")
        && reminder.get("equipment").is_none_or(|e| e != "missing")
}
/// Rule snapshot from watch records `(item id, value)`.
fn plan(watches: &[(String, Value)]) -> Value {
    let mut items: Vec<(i64, Value)> = watches
        .iter()
        .filter_map(|(key, value)| {
            let item: i64 = key.parse().ok()?;
            let groups: Vec<Value> = value["groups"].as_array()?.iter().filter(|g| sweepable(g)).cloned().collect();
            let limit = value.get("buyLimit").and_then(Value::as_u64).unwrap_or(1);
            (!groups.is_empty()).then(|| (item, json!({"item_id":item,"limit":limit,"groups":groups})))
        })
        .collect();
    items.sort_by_key(|(item, _)| *item);
    json!({"watches":items.into_iter().take(100).map(|(_, w)| w).collect::<Vec<_>>()})
}
fn watches(plan: &Value) -> impl Iterator<Item = &Value> {
    plan["watches"].as_array().into_iter().flatten()
}
/// (limit in units, highest sweepable cap) of a planned item.
fn plan_item(plan: &Value, item: i64) -> Option<(i64, f64)> {
    let watch = watches(plan).find(|w| w["item_id"].as_i64() == Some(item))?;
    let cap = watch["groups"].as_array()?.iter().filter_map(|g| g["cap"].as_f64()).fold(0.0, f64::max);
    Some((watch["limit"].as_i64().unwrap_or(1), cap))
}
/// Throwing stars and bullets are priced and counted per bundle.
fn per_bundle(item: i64) -> bool {
    matches!(item / 10000, 207 | 233)
}
fn units_per(item: i64, bundle: i64) -> i64 {
    if per_bundle(item) { 1 } else { bundle }
}
fn within_cap(item: i64, price: i64, bundle: i64, cap: f64) -> bool {
    let unit = if per_bundle(item) { price as f64 } else { price as f64 / bundle as f64 };
    unit <= cap
}
/// Purchases granted, or the reason none can be.
fn granted(quantity: i64, stock: i64, units_left: Option<i64>, per: i64, budget_left: i64, price: i64) -> Result<i64, &'static str> {
    let by_units = units_left.map(|left| left.max(0) / per).unwrap_or(quantity);
    let by_budget = budget_left.max(0) / price;
    match quantity.min(stock).min(by_units).min(by_budget) {
        0 if by_units == 0 => Err("item_limit"),
        0 => Err("budget"),
        n => Ok(n),
    }
}

#[derive(FromRow)]
struct Run {
    id: i64,
    public_id: String,
    account_id: i64,
    plan: Value,
    plan_version: i32,
    budget: i64,
    status: String,
    stop_reason: Option<String>,
    started_by: Option<String>,
    started_at: DateTime<Utc>,
    ends_at: DateTime<Utc>,
    stopped_at: Option<DateTime<Utc>>,
}
const RUN: &str = "SELECT r.id,r.public_id,r.account_id,r.plan,r.plan_version,r.budget,r.status,r.stop_reason,d.public_id AS started_by,r.started_at,r.ends_at,r.stopped_at FROM sweep_runs r LEFT JOIN account_devices d ON d.id=r.started_by";

/// Lazy expiry under the run lock: overdue reservations count as unknown and
/// an overdue run finishes.
async fn refresh(tx: &mut PgConnection, run: &mut Run) -> sqlx::Result<()> {
    let expired = sqlx::query("UPDATE sweep_reservations SET status='expired' WHERE run_id=$1 AND status='held' AND expires_at<=clock_timestamp()")
        .bind(run.id).execute(&mut *tx).await?.rows_affected();
    let ended = run.status == "running"
        && sqlx::query("UPDATE sweep_runs SET status='finished',stop_reason='time_up',stopped_at=ends_at WHERE id=$1 AND status='running' AND ends_at<=now()")
            .bind(run.id).execute(&mut *tx).await?.rows_affected() == 1;
    if ended {
        run.status = "finished".into();
        run.stop_reason = Some("time_up".into());
        run.stopped_at = Some(run.ends_at);
    }
    if expired > 0 || ended {
        notify(tx, run.account_id, "sweep").await?;
    }
    Ok(())
}
async fn lock(tx: &mut PgConnection, account: i64, run: &str) -> Result<Run, Response> {
    if !public_id(run) {
        return Err(invalid());
    }
    let found: Option<Run> = sqlx::query_as(&format!("{RUN} WHERE r.public_id=$1 AND r.account_id=$2 FOR UPDATE OF r"))
        .bind(run).bind(account).fetch_optional(&mut *tx).await.map_err(internal)?;
    let mut run = found.ok_or_else(|| error(StatusCode::NOT_FOUND, "not_found"))?;
    refresh(tx, &mut run).await.map_err(internal)?;
    Ok(run)
}
async fn lock_running(tx: &mut PgConnection, account: i64) -> Result<Option<Run>, Response> {
    let found: Option<Run> = sqlx::query_as(&format!("{RUN} WHERE r.account_id=$1 AND r.status='running' FOR UPDATE OF r"))
        .bind(account).fetch_optional(&mut *tx).await.map_err(internal)?;
    let Some(mut run) = found else { return Ok(None) };
    refresh(tx, &mut run).await.map_err(internal)?;
    Ok(Some(run))
}
fn ensure_running(run: &Run) -> Result<(), Response> {
    if run.status == "running" {
        return Ok(());
    }
    Err((StatusCode::CONFLICT, Json(json!({"error":"sweep_stopped","reason":run.stop_reason}))).into_response())
}
async fn stop(tx: &mut PgConnection, run: &mut Run, reason: &str) -> Result<(), Response> {
    if run.status != "running" {
        return Ok(());
    }
    sqlx::query("UPDATE sweep_runs SET status='stopped',stop_reason=$2,stopped_at=now() WHERE id=$1")
        .bind(run.id).bind(reason).execute(&mut *tx).await.map_err(internal)?;
    run.status = "stopped".into();
    run.stop_reason = Some(reason.into());
    notify(tx, run.account_id, "sweep").await.map_err(internal)
}

/// Budget use: bought at their spend; held, unknown and expired at full cost.
struct Totals {
    spent: i64,
    reserved: i64,
    unknown: i64,
}
impl Totals {
    fn used(&self) -> i64 {
        self.spent + self.reserved + self.unknown
    }
}
async fn totals(tx: &mut PgConnection, run: i64, device: Option<i64>) -> Result<Totals, Response> {
    let (spent, reserved, unknown) = sqlx::query_as("SELECT coalesce(sum(spent) FILTER (WHERE status='bought'),0)::bigint,coalesce(sum(cost) FILTER (WHERE status='held'),0)::bigint,coalesce(sum(cost) FILTER (WHERE status IN ('unknown','expired')),0)::bigint FROM sweep_reservations WHERE run_id=$1 AND ($2::bigint IS NULL OR device_id=$2)")
        .bind(run).bind(device).fetch_one(&mut *tx).await.map_err(internal)?;
    Ok(Totals { spent, reserved, unknown })
}
/// Units counted per item, on the same basis as the budget.
async fn item_units(tx: &mut PgConnection, run: i64) -> Result<HashMap<i64, i64>, Response> {
    let rows: Vec<(i32, i64)> = sqlx::query_as("SELECT item_id,sum(CASE status WHEN 'bought' THEN bought_quantity*units_per WHEN 'not_bought' THEN 0 ELSE quantity*units_per END)::bigint FROM sweep_reservations WHERE run_id=$1 GROUP BY item_id")
        .bind(run).fetch_all(&mut *tx).await.map_err(internal)?;
    Ok(rows.into_iter().map(|(item, units)| (i64::from(item), units)).collect())
}
async fn current_plan(tx: &mut PgConnection, account: i64) -> Result<Value, Response> {
    let watches: Vec<(String, Value)> = sqlx::query_as("SELECT key,value FROM account_data WHERE account_id=$1 AND kind='watch' AND value IS NOT NULL ORDER BY key")
        .bind(account).fetch_all(&mut *tx).await.map_err(internal)?;
    Ok(plan(&watches))
}
fn empty(plan: &Value) -> bool {
    watches(plan).next().is_none()
}

#[derive(Serialize, FromRow)]
struct Participant {
    id: String,
    name: String,
    state: String,
    message: String,
    online: bool,
    spent: i64,
    checked: Option<i64>,
    progress_at: Option<DateTime<Utc>>,
    leased: bool,
}
#[derive(FromRow)]
struct Purchase {
    id: String,
    device: String,
    item_id: i32,
    status: String,
    quantity: i64,
    units_per: i64,
    price: i64,
    spent: i64,
    reason: String,
    location: Value,
    created_at: DateTime<Utc>,
    settled_at: Option<DateTime<Utc>>,
}
async fn web_view(tx: &mut PgConnection, run: &Run) -> Result<Value, Response> {
    let t = totals(tx, run.id, None).await?;
    let units = item_units(tx, run.id).await?;
    // Aggregate every settled purchase, independently of the recent-record limit
    // and of held/unknown units that still consume a purchase allowance.
    let bought: Vec<(i32, i64)> = sqlx::query_as("SELECT item_id,sum(bought_quantity*units_per)::bigint FROM sweep_reservations WHERE run_id=$1 AND status='bought' GROUP BY item_id")
        .bind(run.id).fetch_all(&mut *tx).await.map_err(internal)?;
    let bought: HashMap<i64, i64> = bought.into_iter().map(|(id, count)| (i64::from(id), count)).collect();
    let items: Vec<Value> = watches(&run.plan)
        .map(|w| {
            let item = w["item_id"].as_i64().unwrap_or_default();
            json!({"item_id":item,"limit":w["limit"],"units":units.get(&item).copied().unwrap_or(0),"bought":bought.get(&item).copied().unwrap_or(0)})
        })
        .collect();
    let devices: Vec<Participant> = sqlx::query_as("SELECT d.public_id AS id,d.name,p.state,p.message,(d.revoked_at IS NULL AND d.last_seen_at>now()-interval '75 seconds') AS online,(SELECT coalesce(sum(spent),0)::bigint FROM sweep_reservations s WHERE s.run_id=p.run_id AND s.device_id=p.device_id AND s.status='bought') AS spent,p.checked,p.progress_at,coalesce(p.state='active' AND p.lease_expires_at>now(),false) AS leased FROM sweep_run_devices p JOIN account_devices d ON d.id=p.device_id WHERE p.run_id=$1 ORDER BY d.created_at,d.id")
        .bind(run.id).fetch_all(&mut *tx).await.map_err(internal)?;
    // quantity and spent are what the row counts against the run.
    let purchases: Vec<Purchase> = sqlx::query_as("SELECT s.public_id AS id,d.public_id AS device,s.item_id,s.status,CASE s.status WHEN 'bought' THEN s.bought_quantity WHEN 'not_bought' THEN 0 ELSE s.quantity END AS quantity,s.units_per,s.price,CASE s.status WHEN 'bought' THEN s.spent WHEN 'not_bought' THEN 0 ELSE s.cost END AS spent,s.reason,s.location,s.created_at,s.settled_at FROM sweep_reservations s JOIN account_devices d ON d.id=s.device_id WHERE s.run_id=$1 ORDER BY s.created_at DESC,s.id DESC LIMIT 50")
        .bind(run.id).fetch_all(&mut *tx).await.map_err(internal)?;
    let purchases: Vec<Value> = purchases.into_iter().map(|p| json!({
        "id":p.id,"device":p.device,"item_id":p.item_id,"status":p.status,"quantity":p.quantity,"units":p.quantity*p.units_per,
        "price":p.price,"spent":p.spent,"reason":p.reason,"room":p.location["room"],"channel":p.location["channel"],
        "owner":p.location["owner"],"created_at":p.created_at,"settled_at":p.settled_at,
    })).collect();
    let stale = current_plan(tx, run.account_id).await?["watches"] != run.plan["watches"];
    Ok(json!({
        "id":run.public_id,"status":run.status,"stop_reason":run.stop_reason,"budget":run.budget,
        "spent":t.spent,"reserved":t.reserved,"unknown":t.unknown,"remaining":(run.budget-t.used()).max(0),
        "started_at":run.started_at,"ends_at":run.ends_at,"stopped_at":run.stopped_at,"started_by":run.started_by.as_deref().unwrap_or("web"),
        "bought":bought.values().sum::<i64>(),
        "plan":run.plan,"plan_version":run.plan_version,"plan_stale":stale,"items":items,"devices":devices,"purchases":purchases,
    }))
}
/// The running run, else the latest one that ended within 24 hours.
async fn web_reply(state: &AppState, account: i64) -> Reply {
    let mut tx = state.db.begin().await.map_err(internal)?;
    let latest: Option<String> = sqlx::query_scalar("SELECT public_id FROM sweep_runs WHERE account_id=$1 AND (status='running' OR stopped_at>now()-interval '24 hours') ORDER BY status='running' DESC,stopped_at DESC LIMIT 1")
        .bind(account).fetch_optional(&mut *tx).await.map_err(internal)?;
    let run = match latest {
        Some(id) => {
            let run = lock(&mut tx, account, &id).await?;
            Some(web_view(&mut tx, &run).await?)
        }
        None => None,
    };
    let devices = devices::device_list(&mut tx, account).await.map_err(internal)?;
    tx.commit().await.map_err(internal)?;
    Ok(Json(json!({"run":run,"devices":devices})).into_response())
}
async fn web_session(state: &AppState, headers: &HeaderMap) -> Result<i64, Response> {
    let s = session(state, headers).await?.ok_or_else(|| error(StatusCode::UNAUTHORIZED, "login_required"))?;
    if !state.limiter.allow(&format!("account-sweep:{}", s.id), 300) {
        return Err(error(StatusCode::TOO_MANY_REQUESTS, "rate_limited"));
    }
    Ok(s.id)
}
fn write_limit(state: &AppState, account: i64) -> Result<(), Response> {
    if state.limiter.allow(&format!("account-sweep-write:{account}"), 30) {
        Ok(())
    } else {
        Err(error(StatusCode::TOO_MANY_REQUESTS, "rate_limited"))
    }
}
fn valid_limits(budget: i64, minutes: i64) -> Result<(), Response> {
    if (1..=MAX_AMOUNT).contains(&budget) && (5..=10080).contains(&minutes) {
        Ok(())
    } else {
        Err(invalid())
    }
}
/// Starts a run of the account (whose row the caller locked) with the given invitees.
async fn begin_run(tx: &mut PgConnection, account: i64, budget: i64, minutes: i64, started_by: Option<i64>, invitees: &[i64], scan: &ScanMode) -> Result<(), Response> {
    // An overdue run must not block a new one; the notice below covers it.
    sqlx::query("UPDATE sweep_runs SET status='finished',stop_reason='time_up',stopped_at=ends_at WHERE account_id=$1 AND status='running' AND ends_at<=now()")
        .bind(account).execute(&mut *tx).await.map_err(internal)?;
    let running: bool = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM sweep_runs WHERE account_id=$1 AND status='running')")
        .bind(account).fetch_one(&mut *tx).await.map_err(internal)?;
    if running {
        return Err(conflict("sweep_running"));
    }
    let mut plan = current_plan(tx, account).await?;
    if empty(&plan) {
        return Err(conflict("no_sweep_groups"));
    }
    plan["scan"] = json!(scan);
    let run: i64 = sqlx::query_scalar("INSERT INTO sweep_runs(public_id,account_id,plan,budget,started_by,ends_at) VALUES($1,$2,$3,$4,$5,now()+make_interval(mins=>$6)) RETURNING id")
        .bind(auth::new_credentials().public_id).bind(account).bind(&plan).bind(budget).bind(started_by).bind(minutes as i32)
        .fetch_one(&mut *tx).await.map_err(internal)?;
    sqlx::query("INSERT INTO sweep_run_devices(run_id,device_id) SELECT $1,unnest($2::bigint[])")
        .bind(run).bind(invitees).execute(&mut *tx).await.map_err(internal)?;
    notify(tx, account, "sweep").await.map_err(internal)
}
async fn lock_account(tx: &mut PgConnection, account: i64) -> Result<(), Response> {
    sqlx::query("SELECT id FROM accounts WHERE id=$1 FOR UPDATE")
        .bind(account).execute(tx).await.map_err(internal).map(|_| ())
}

async fn web_get(State(state): State<AppState>, headers: HeaderMap) -> Reply {
    let account = web_session(&state, &headers).await?;
    web_reply(&state, account).await
}
#[derive(Deserialize)]
struct WebStart {
    devices: Vec<String>,
    budget: i64,
    minutes: i64,
    #[serde(default)]
    scan: ScanMode,
    #[serde(default)]
    current_password: String,
}

#[derive(Default, Deserialize, Serialize)]
#[serde(tag = "mode", rename_all = "snake_case", deny_unknown_fields)]
enum ScanMode {
    #[default]
    Market,
    Recent { recent_minutes: i64 },
}
impl ScanMode {
    fn validate(&self) -> Result<(), Response> {
        match self {
            Self::Market => Ok(()),
            Self::Recent { recent_minutes } if [10, 30, 60, 360, 1440].contains(recent_minutes) => Ok(()),
            _ => Err(invalid()),
        }
    }
    fn recent(&self) -> bool { matches!(self, Self::Recent { .. }) }
}
async fn web_start(State(state): State<AppState>, headers: HeaderMap, Json(input): Json<WebStart>) -> Reply {
    let s = accounts::sensitive(&state, &headers, &input.current_password).await?;
    write_limit(&state, s.id)?;
    let mut ids = input.devices.clone();
    ids.sort();
    ids.dedup();
    if !(1..=8).contains(&input.devices.len()) || ids.len() != input.devices.len() || !ids.iter().all(|d| public_id(d)) {
        return Err(invalid());
    }
    valid_limits(input.budget, input.minutes)?;
    input.scan.validate()?;
    let mut tx = state.db.begin().await.map_err(internal)?;
    lock_account(&mut tx, s.id).await?;
    let ready: Vec<i64> = sqlx::query_scalar("SELECT id FROM account_devices WHERE account_id=$1 AND public_id=ANY($2) AND revoked_at IS NULL AND last_seen_at>now()-interval '75 seconds' AND state @> '{\"sweep\":{\"allow_web_start\":true,\"executor\":{\"ready\":true}}}'")
        .bind(s.id).bind(&ids).fetch_all(&mut *tx).await.map_err(internal)?;
    if ready.len() != ids.len() {
        return Err(conflict("device_unavailable"));
    }
    if input.scan.recent() {
        let capable: i64 = sqlx::query_scalar("SELECT count(*) FROM account_devices WHERE id=ANY($1) AND state @> '{\"sweep\":{\"recent_scan\":true}}'")
            .bind(&ready).fetch_one(&mut *tx).await.map_err(internal)?;
        if capable != ready.len() as i64 { return Err(conflict("collector_update_required")); }
    }
    begin_run(&mut tx, s.id, input.budget, input.minutes, None, &ready, &input.scan).await?;
    tx.commit().await.map_err(internal)?;
    web_reply(&state, s.id).await
}
#[derive(Deserialize)]
struct RunRef {
    run: String,
}
async fn web_stop(State(state): State<AppState>, headers: HeaderMap, Json(input): Json<RunRef>) -> Reply {
    let s = writable(&state, &headers).await?;
    write_limit(&state, s.id)?;
    let mut tx = state.db.begin().await.map_err(internal)?;
    let mut run = lock(&mut tx, s.id, &input.run).await?;
    stop(&mut tx, &mut run, "stopped_on_web").await?;
    tx.commit().await.map_err(internal)?;
    web_reply(&state, s.id).await
}
#[derive(Deserialize)]
struct Apply {
    run: String,
    #[serde(default)]
    current_password: String,
}
async fn web_apply(State(state): State<AppState>, headers: HeaderMap, Json(input): Json<Apply>) -> Reply {
    let s = accounts::sensitive(&state, &headers, &input.current_password).await?;
    write_limit(&state, s.id)?;
    let mut tx = state.db.begin().await.map_err(internal)?;
    let run = lock(&mut tx, s.id, &input.run).await?;
    ensure_running(&run)?;
    // Running plans are immutable, including requests from cached older pages.
    Err(conflict("restart_required"))
}

#[derive(FromRow)]
struct Seat {
    state: String,
    message: String,
    plan_version: Option<i32>,
    /// The lease token matches and has not expired.
    leased: bool,
    /// The lease token matches, expired or not.
    holder: bool,
}
async fn seat(tx: &mut PgConnection, run: i64, device: i64, lease: &str) -> Result<Option<Seat>, Response> {
    sqlx::query_as("SELECT state,message,plan_version,coalesce(state='active' AND lease_hash=$3 AND lease_expires_at>clock_timestamp(),false) AS leased,coalesce(state='active' AND lease_hash=$3,false) AS holder FROM sweep_run_devices WHERE run_id=$1 AND device_id=$2 FOR UPDATE")
        .bind(run).bind(device).bind(auth::token_hash(lease)).fetch_optional(&mut *tx).await.map_err(internal)
}
async fn leased(tx: &mut PgConnection, run: i64, device: i64, lease: &str) -> Result<Seat, Response> {
    seat(tx, run, device, lease).await?.filter(|s| s.leased).ok_or_else(|| conflict("lease_lost"))
}
async fn device_view(tx: &mut PgConnection, run: &Run, device: i64) -> Result<Option<Value>, Response> {
    let seat: Option<(String, String, Option<i32>)> = sqlx::query_as("SELECT state,message,plan_version FROM sweep_run_devices WHERE run_id=$1 AND device_id=$2 AND state IN ('invited','active')")
        .bind(run.id).bind(device).fetch_optional(&mut *tx).await.map_err(internal)?;
    let Some((state, message, version)) = seat else { return Ok(None) };
    let all = totals(tx, run.id, None).await?;
    let here = totals(tx, run.id, Some(device)).await?;
    Ok(Some(json!({
        "id":run.public_id,"status":run.status,"budget":run.budget,"remaining":(run.budget-all.used()).max(0),
        "ends_at":run.ends_at,"started_by":run.started_by.as_deref().unwrap_or("web"),"plan":run.plan,
        "plan_version":run.plan_version,"participant":{"state":state,"message":message,"plan_version":version},
        "spent_here":here.used(),
    })))
}
async fn device_reply(state: &AppState, d: &Device) -> Reply {
    let mut tx = state.db.begin().await.map_err(internal)?;
    let view = match lock_running(&mut tx, d.account).await? {
        Some(run) if run.status == "running" => device_view(&mut tx, &run, d.id).await?,
        _ => None,
    };
    tx.commit().await.map_err(internal)?;
    Ok(Json(json!({"run":view})).into_response())
}
async fn device_get(State(state): State<AppState>, headers: HeaderMap) -> Reply {
    let d = devices::device(&state, &headers).await?;
    device_reply(&state, &d).await
}
#[derive(Deserialize)]
struct DeviceStart {
    budget: i64,
    minutes: i64,
    #[serde(default)]
    scan: ScanMode,
}
/// Started at the computer itself: no password, and only this device takes part.
async fn device_start(State(state): State<AppState>, headers: HeaderMap, Json(input): Json<DeviceStart>) -> Reply {
    let d = devices::device(&state, &headers).await?;
    valid_limits(input.budget, input.minutes)?;
    input.scan.validate()?;
    let mut tx = state.db.begin().await.map_err(internal)?;
    lock_account(&mut tx, d.account).await?;
    begin_run(&mut tx, d.account, input.budget, input.minutes, Some(d.id), &[d.id], &input.scan).await?;
    tx.commit().await.map_err(internal)?;
    device_reply(&state, &d).await
}

/// Current known quotes guide navigation only. The collector reapplies the
/// complete conditions and verifies a fresh in-game listing before reserving.
async fn device_targets(State(state): State<AppState>, headers: HeaderMap) -> Reply {
    let d = devices::device(&state, &headers).await?;
    let mut tx = state.db.begin().await.map_err(internal)?;
    let run = lock_running(&mut tx, d.account).await?.ok_or_else(|| conflict("sweep_stopped"))?;
    ensure_running(&run)?;
    let member: bool = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM sweep_run_devices WHERE run_id=$1 AND device_id=$2 AND state='active' AND lease_expires_at>clock_timestamp())")
        .bind(run.id).bind(d.id).fetch_one(&mut *tx).await.map_err(internal)?;
    if !member { return Err(conflict("lease_lost")); }
    let Some(minutes) = run.plan["scan"]["recent_minutes"].as_i64() else { return Err(invalid()) };
    let ids: Vec<i32> = watches(&run.plan).filter_map(|w| w["item_id"].as_i64().map(|n| n as i32)).collect();
    tx.commit().await.map_err(internal)?;
    let now = Utc::now().timestamp() as f64;
    let rows = crate::views::sweep_quotes(&state.db, &ids, now - (minutes * 60) as f64).await.map_err(internal)?;
    let rows: Vec<Value> = rows.into_iter().filter(|r| {
        let item = r["item_id"].as_i64().unwrap_or_default();
        r["source"] == "packet" && r["location"]["room"].as_i64().is_some_and(|n| (1..=20).contains(&n))
            && r["location"]["channel"].as_i64().is_some_and(|n| (1..=40).contains(&n))
            && r["stock"].as_i64().is_some_and(|n| n > 0)
            && plan_item(&run.plan, item).is_some_and(|(_, cap)| r["unit_price"].as_f64().is_some_and(|p| p > 0.0 && p <= cap))
    }).collect();
    Ok(Json(json!({"run":run.public_id,"plan_version":run.plan_version,"generated_at":now,"listings":rows})).into_response())
}
#[derive(Deserialize)]
struct Join {
    run: String,
    plan_version: i32,
}
async fn join(State(state): State<AppState>, headers: HeaderMap, Json(input): Json<Join>) -> Reply {
    let d = devices::device(&state, &headers).await?;
    let mut tx = state.db.begin().await.map_err(internal)?;
    let run = lock(&mut tx, d.account, &input.run).await?;
    ensure_running(&run)?;
    let open = seat(&mut tx, run.id, d.id, "").await?.is_some_and(|s| s.state == "invited" || s.state == "active");
    if !open {
        return Err(conflict("not_invited"));
    }
    if input.plan_version != run.plan_version {
        return Err(conflict("plan_changed"));
    }
    // A new lease fences any earlier session of this device.
    let lease = auth::new_credentials().token;
    sqlx::query("UPDATE sweep_run_devices SET state='active',lease_hash=$3,lease_expires_at=clock_timestamp()+make_interval(secs=>$4),plan_version=$5 WHERE run_id=$1 AND device_id=$2")
        .bind(run.id).bind(d.id).bind(auth::token_hash(&lease)).bind(LEASE_SECONDS as f64).bind(run.plan_version)
        .execute(&mut *tx).await.map_err(internal)?;
    notify(&mut tx, d.account, "sweep").await.map_err(internal)?;
    tx.commit().await.map_err(internal)?;
    Ok(Json(json!({"lease":lease,"expires_in":LEASE_SECONDS})).into_response())
}
#[derive(Deserialize)]
struct Refuse {
    run: String,
    #[serde(default)]
    reason: String,
}
async fn refuse(State(state): State<AppState>, headers: HeaderMap, Json(input): Json<Refuse>) -> Reply {
    let d = devices::device(&state, &headers).await?;
    if !devices::valid_text(&input.reason, 80) {
        return Err(invalid());
    }
    let mut tx = state.db.begin().await.map_err(internal)?;
    let run = lock(&mut tx, d.account, &input.run).await?;
    ensure_running(&run)?;
    let changed = sqlx::query("UPDATE sweep_run_devices SET state='refused',message=$3,lease_hash=NULL WHERE run_id=$1 AND device_id=$2 AND state IN ('invited','active')")
        .bind(run.id).bind(d.id).bind(&input.reason).execute(&mut *tx).await.map_err(internal)?;
    if changed.rows_affected() != 1 {
        return Err(conflict("not_invited"));
    }
    notify(&mut tx, d.account, "sweep").await.map_err(internal)?;
    tx.commit().await.map_err(internal)?;
    ok()
}
#[derive(Deserialize, Default)]
struct Status {
    #[serde(default)]
    message: String,
    #[serde(default)]
    checked: Option<u64>,
}
#[derive(Deserialize)]
struct Heartbeat {
    run: String,
    lease: String,
    #[serde(default)]
    status: Status,
}
async fn heartbeat(State(state): State<AppState>, headers: HeaderMap, Json(input): Json<Heartbeat>) -> Reply {
    let d = devices::device(&state, &headers).await?;
    if !devices::valid_text(&input.status.message, 80) || input.status.checked.is_some_and(|n| n > MAX_AMOUNT as u64) {
        return Err(invalid());
    }
    let mut tx = state.db.begin().await.map_err(internal)?;
    let run = lock(&mut tx, d.account, &input.run).await?;
    ensure_running(&run)?;
    let seat = leased(&mut tx, run.id, d.id, &input.lease).await?;
    let previous_checked: Option<i64> = sqlx::query_scalar("SELECT checked FROM sweep_run_devices WHERE run_id=$1 AND device_id=$2")
        .bind(run.id).bind(d.id).fetch_one(&mut *tx).await.map_err(internal)?;
    let checked = input.status.checked.map(|n| n as i64);
    sqlx::query("UPDATE sweep_run_devices SET lease_expires_at=clock_timestamp()+make_interval(secs=>$3),message=$4,checked=coalesce($5,checked),progress_at=now() WHERE run_id=$1 AND device_id=$2")
        .bind(run.id).bind(d.id).bind(LEASE_SECONDS as f64).bind(&input.status.message).bind(checked).execute(&mut *tx).await.map_err(internal)?;
    if seat.message != input.status.message || checked.is_some() && checked != previous_checked {
        notify(&mut tx, d.account, "sweep").await.map_err(internal)?;
    }
    let t = totals(&mut tx, run.id, None).await?;
    tx.commit().await.map_err(internal)?;
    Ok(Json(json!({"plan_version":run.plan_version,"remaining":(run.budget-t.used()).max(0)})).into_response())
}
#[derive(Deserialize)]
struct Leave {
    run: String,
    lease: String,
    #[serde(default)]
    reason: String,
}
async fn leave(State(state): State<AppState>, headers: HeaderMap, Json(input): Json<Leave>) -> Reply {
    let d = devices::device(&state, &headers).await?;
    if !devices::valid_text(&input.reason, 80) {
        return Err(invalid());
    }
    let mut tx = state.db.begin().await.map_err(internal)?;
    let run = lock(&mut tx, d.account, &input.run).await?;
    // Only this device's newest lease can end its part, even after expiry.
    if !seat(&mut tx, run.id, d.id, &input.lease).await?.is_some_and(|s| s.holder) {
        return Err(conflict("lease_lost"));
    }
    sqlx::query("UPDATE sweep_run_devices SET state='left',message=$3,lease_hash=NULL WHERE run_id=$1 AND device_id=$2")
        .bind(run.id).bind(d.id).bind(&input.reason).execute(&mut *tx).await.map_err(internal)?;
    notify(&mut tx, d.account, "sweep").await.map_err(internal)?;
    tx.commit().await.map_err(internal)?;
    ok()
}
async fn device_stop(State(state): State<AppState>, headers: HeaderMap, Json(input): Json<RunRef>) -> Reply {
    let d = devices::device(&state, &headers).await?;
    let mut tx = state.db.begin().await.map_err(internal)?;
    let mut run = lock(&mut tx, d.account, &input.run).await?;
    stop(&mut tx, &mut run, "stopped_on_device").await?;
    tx.commit().await.map_err(internal)?;
    ok()
}

#[derive(Deserialize, Serialize)]
struct Location {
    room: i64,
    channel: i64,
    shop_id: i64,
    #[serde(default)]
    owner: Option<String>,
    category: i64,
    slot: i64,
}
#[derive(Deserialize)]
struct Reserve {
    run: String,
    lease: String,
    plan_version: i32,
    listing: String,
    item_id: i64,
    price: i64,
    bundle: i64,
    stock: i64,
    quantity: i64,
    location: Location,
}
/// Ranges follow the upload protocol; the listing is a lowercase sha256.
fn valid_reserve(r: &Reserve) -> bool {
    let l = &r.location;
    r.listing.len() == 64
        && r.listing.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
        && (1_000_000..=5_999_999).contains(&r.item_id)
        && (1..=MAX_AMOUNT).contains(&r.price)
        && (1..=1_000_000).contains(&r.bundle)
        && (1..=1_000_000).contains(&r.stock)
        && (1..=1_000_000).contains(&r.quantity)
        && (0..=22).contains(&l.room)
        && (1..=255).contains(&l.channel)
        && (1..=i64::from(u32::MAX)).contains(&l.shop_id)
        && l.owner.as_deref().is_none_or(|o| devices::valid_text(o, 24))
        && (1..=6).contains(&l.category)
        && (1..=200).contains(&l.slot)
}
async fn reserve(State(state): State<AppState>, headers: HeaderMap, Json(input): Json<Reserve>) -> Reply {
    let d = devices::device(&state, &headers).await?;
    if !valid_reserve(&input) {
        return Err(invalid());
    }
    let mut tx = state.db.begin().await.map_err(internal)?;
    let run = lock(&mut tx, d.account, &input.run).await?;
    ensure_running(&run)?;
    let seat = leased(&mut tx, run.id, d.id, &input.lease).await?;
    if input.plan_version != run.plan_version || seat.plan_version != Some(run.plan_version) {
        return Err(conflict("plan_changed"));
    }
    let (limit, cap) = plan_item(&run.plan, input.item_id).ok_or_else(|| conflict("item_not_in_plan"))?;
    if !within_cap(input.item_id, input.price, input.bundle, cap) {
        return Err(conflict("price_over_cap"));
    }
    let refused = |reason: &str| -> Reply { Ok(Json(json!({"granted":0,"reason":reason})).into_response()) };
    let duplicate: bool = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM sweep_reservations WHERE run_id=$1 AND listing=$2)")
        .bind(run.id).bind(&input.listing).fetch_one(&mut *tx).await.map_err(internal)?;
    if duplicate {
        return refused("duplicate");
    }
    let budget_left = run.budget - totals(&mut tx, run.id, None).await?.used();
    let per = units_per(input.item_id, input.bundle);
    let units_left = if limit == 0 { None } else {
        Some(limit - item_units(&mut tx, run.id).await?.get(&input.item_id).copied().unwrap_or(0))
    };
    let count = match granted(input.quantity, input.stock, units_left, per, budget_left, input.price) {
        Ok(n) => n,
        Err(reason) => return refused(reason),
    };
    let cost = count * input.price;
    let id = auth::new_credentials().public_id;
    sqlx::query("INSERT INTO sweep_reservations(public_id,run_id,device_id,listing,item_id,quantity,units_per,bundle,price,cost,location,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,clock_timestamp()+make_interval(secs=>$12))")
        .bind(&id).bind(run.id).bind(d.id).bind(&input.listing).bind(input.item_id as i32).bind(count).bind(per)
        .bind(input.bundle).bind(input.price).bind(cost).bind(sqlx::types::Json(&input.location)).bind(LEASE_SECONDS as f64)
        .execute(&mut *tx).await.map_err(internal)?;
    if budget_left == cost {
        sqlx::query("UPDATE sweep_runs SET status='finished',stop_reason='budget_spent',stopped_at=now() WHERE id=$1")
            .bind(run.id).execute(&mut *tx).await.map_err(internal)?;
    }
    notify(&mut tx, d.account, "sweep").await.map_err(internal)?;
    tx.commit().await.map_err(internal)?;
    Ok(Json(json!({"reservation":id,"granted":count,"expires_in":LEASE_SECONDS})).into_response())
}

#[derive(Deserialize)]
struct Settle {
    reservation: String,
    status: String,
    quantity: i64,
    spent: i64,
    #[serde(default)]
    reason: String,
}
fn valid_result(status: &str, quantity: i64, spent: i64, granted: i64, price: i64) -> bool {
    match status {
        "bought" => (1..=granted).contains(&quantity) && (0..=quantity * price).contains(&spent),
        "not_bought" => quantity == 0 && spent == 0,
        "unknown" => (0..=granted).contains(&quantity) && (0..=granted * price).contains(&spent),
        _ => false,
    }
}
#[derive(FromRow)]
struct Held {
    id: i64,
    status: String,
    quantity: i64,
    price: i64,
    bought_quantity: i64,
    spent: i64,
    reason: String,
    recent: bool,
}
/// No lease needed: results arrive after a purchase even if the lease is gone.
async fn settle(State(state): State<AppState>, headers: HeaderMap, Json(input): Json<Settle>) -> Reply {
    let d = devices::device(&state, &headers).await?;
    if !public_id(&input.reservation)
        || !matches!(input.status.as_str(), "bought" | "not_bought" | "unknown")
        || input.reason.len() > 40
        || !input.reason.bytes().all(|b| b.is_ascii_lowercase() || b == b'_')
    {
        return Err(invalid());
    }
    let mut tx = state.db.begin().await.map_err(internal)?;
    let run: Option<String> = sqlx::query_scalar("SELECT r.public_id FROM sweep_reservations s JOIN sweep_runs r ON r.id=s.run_id WHERE s.public_id=$1 AND s.device_id=$2")
        .bind(&input.reservation).bind(d.id).fetch_optional(&mut *tx).await.map_err(internal)?;
    let run = run.ok_or_else(|| error(StatusCode::NOT_FOUND, "not_found"))?;
    let run = lock(&mut tx, d.account, &run).await?;
    let held: Held = sqlx::query_as("SELECT id,status,quantity,price,bought_quantity,spent,reason,created_at>clock_timestamp()-interval '10 minutes' AS recent FROM sweep_reservations WHERE public_id=$1 FOR UPDATE")
        .bind(&input.reservation).fetch_one(&mut *tx).await.map_err(internal)?;
    if held.status != "held" && held.status != "expired" {
        let same = (held.status.as_str(), held.bought_quantity, held.spent, held.reason.as_str())
            == (input.status.as_str(), input.quantity, input.spent, input.reason.as_str());
        return if same { ok() } else { Err(conflict("already_settled")) };
    }
    if held.status == "expired" && !held.recent {
        return Err(conflict("reservation_expired"));
    }
    if !valid_result(&input.status, input.quantity, input.spent, held.quantity, held.price) {
        return Err(invalid());
    }
    sqlx::query("UPDATE sweep_reservations SET status=$2,bought_quantity=$3,spent=$4,reason=$5,settled_at=now() WHERE id=$1")
        .bind(held.id).bind(&input.status).bind(input.quantity).bind(input.spent).bind(&input.reason)
        .execute(&mut *tx).await.map_err(internal)?;
    // A device that cannot tell whether it bought must stop buying in this run.
    if input.status == "unknown" {
        sqlx::query("UPDATE sweep_run_devices SET state='left',message='unknown',lease_hash=NULL WHERE run_id=$1 AND device_id=$2 AND state IN ('invited','active')")
            .bind(run.id).bind(d.id).execute(&mut *tx).await.map_err(internal)?;
    }
    notify(&mut tx, d.account, "sweep").await.map_err(internal)?;
    tx.commit().await.map_err(internal)?;
    ok()
}

#[cfg(test)]
mod tests {
    use super::*;
    fn group(id: &str, buy: bool, cap: Value, reminder: Value) -> Value {
        json!({"id":id,"name":id,"cap":cap,"notify":true,"buy":buy,"reminder":reminder})
    }
    #[test]
    fn plan_keeps_only_sweepable_groups_sorted_by_item() {
        let keep = group("keep", true, json!(500000), json!({"percentile":"all","equipment":"bonus"}));
        let watches = vec![
            ("1082002".to_string(), json!({"cap":null,"notify":true,"position":0,"buyLimit":2,"groups":[
                keep.clone(),
                group("off", false, json!(500000), json!({})),
                group("nocap", true, json!(null), json!({})),
                group("zero", true, json!(0), json!({})),
                group("p25", true, json!(1000), json!({"percentile":"25"})),
                group("missing", true, json!(1000), json!({"equipment":"missing"})),
            ]})),
            ("1002000".to_string(), json!({"cap":null,"notify":true,"position":1,"groups":[group("a", true, json!(10), json!({}))]})),
            ("2000000".to_string(), json!({"cap":5,"notify":true,"position":2})),
            ("2000001".to_string(), json!({"cap":5,"notify":true,"position":3,"groups":[group("b", false, json!(10), json!({}))]})),
        ];
        let p = plan(&watches);
        assert_eq!(p, json!({"watches":[
            {"item_id":1002000,"limit":1,"groups":[group("a", true, json!(10), json!({}))]},
            {"item_id":1082002,"limit":2,"groups":[keep]},
        ]}));
        assert_eq!(plan_item(&p, 1082002), Some((2, 500000.0)));
        assert_eq!(plan_item(&p, 2000000), None);
        assert!(empty(&plan(&watches[2..])));
    }
    #[test]
    fn stars_and_bullets_count_per_bundle() {
        assert!(per_bundle(2070000) && per_bundle(2330005) && !per_bundle(2060000) && !per_bundle(1082002));
        assert_eq!(units_per(2070000, 800), 1);
        assert_eq!(units_per(4000000, 100), 100);
        assert!(within_cap(2070000, 9000, 800, 9000.0) && !within_cap(2070000, 9001, 800, 9000.0));
        assert!(within_cap(4000000, 10000, 100, 100.0) && !within_cap(4000000, 10001, 100, 100.0));
    }
    #[test]
    fn grants_are_bounded_by_quantity_stock_units_and_budget() {
        assert_eq!(granted(20_000, 15_000, None, 1, 1_000_000, 10), Ok(15_000));
        assert_eq!(granted(20_000, 15_000, None, 1, 25, 10), Ok(2));
        assert_eq!(granted(5, 9, None, 1, 9, 10), Err("budget"));
        assert_eq!(granted(5, 3, Some(100), 1, 1_000, 10), Ok(3));
        assert_eq!(granted(5, 9, Some(2), 1, 1_000, 10), Ok(2));
        assert_eq!(granted(5, 9, Some(250), 100, 1_000, 10), Ok(2));
        assert_eq!(granted(5, 9, Some(100), 1, 25, 10), Ok(2));
        assert_eq!(granted(5, 9, Some(0), 1, 1_000, 10), Err("item_limit"));
        assert_eq!(granted(5, 9, Some(99), 100, 1_000, 10), Err("item_limit"));
        assert_eq!(granted(5, 9, Some(100), 1, 9, 10), Err("budget"));
        assert_eq!(granted(5, 9, Some(100), 1, -5, 10), Err("budget"));
    }
    #[test]
    fn results_stay_within_the_reservation() {
        assert!(valid_result("bought", 2, 900, 2, 450));
        assert!(!valid_result("bought", 0, 0, 2, 450) && !valid_result("bought", 3, 0, 2, 450));
        assert!(!valid_result("bought", 1, 451, 2, 450));
        assert!(valid_result("not_bought", 0, 0, 2, 450) && !valid_result("not_bought", 1, 0, 2, 450));
        assert!(valid_result("unknown", 0, 0, 2, 450) && !valid_result("unknown", 3, 0, 2, 450));
        assert!(!valid_result("held", 0, 0, 2, 450));
    }
}

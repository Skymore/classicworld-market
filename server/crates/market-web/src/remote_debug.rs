//! Explicit, ephemeral player consent. Operator control is server-local only.
#![allow(clippy::result_large_err)]
use crate::{api::{bearer, error, internal}, auth, unix_now, AppState};
use axum::{extract::{ConnectInfo, State}, http::{HeaderMap, StatusCode}, response::{IntoResponse, Response}, Json};
use serde::{Deserialize, Serialize};
use serde_json::json;
use sha2::{Digest, Sha256};
use std::{collections::HashMap, net::SocketAddr, path::PathBuf, sync::Mutex};

#[derive(Default)]
pub struct Hub(Mutex<HashMap<String, Session>>);
#[derive(Clone, Serialize)]
struct Command { id: String, script: String, status: String, output: String, exit_code: Option<i64> }
#[derive(Clone, Serialize)]
struct Session { id: String, collector: i64, created_at: f64, expires_at: f64, last_seen: f64, active: bool, commands: Vec<Command> }
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ClientRequest { action: String, session: Option<String>, command: Option<String>, output: Option<String>, exit_code: Option<i64> }
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct OperatorRequest { action: String, session: Option<String>, script: Option<String> }
fn id() -> String { auth::new_credentials().public_id }
fn root() -> PathBuf { PathBuf::from("shared_data/remote-debug") }
fn audit(s: &Session) -> std::io::Result<()> {
    std::fs::create_dir_all(root())?;
    let data = serde_json::to_vec(s)?;
    let pending = root().join(format!("{}.pending", s.id));
    let final_path = root().join(format!("{}.json", s.id));
    std::fs::write(&pending, data)?;
    // Windows rename cannot replace; the audit is a bounded private snapshot.
    if final_path.exists() { std::fs::remove_file(&final_path)?; }
    std::fs::rename(pending, final_path)
}
fn expire(s: &mut Session, now: f64) {
    if now >= s.expires_at || now - s.last_seen > 12. { s.active = false; }
    if !s.active { for c in &mut s.commands { if c.status == "queued" || c.status == "running" { c.status = "terminated".into(); } } }
}
fn live<'a>(map: &'a mut HashMap<String, Session>, key: &str) -> Result<&'a mut Session, Response> {
    let s = map.get_mut(key).ok_or_else(|| error(StatusCode::NOT_FOUND, "session_not_found"))?;
    expire(s, unix_now());
    Ok(s)
}
pub async fn client(State(state): State<AppState>, headers: HeaderMap, Json(r): Json<ClientRequest>) -> Response {
    let collector = match auth::authenticate(&state.db, bearer(&headers)).await {
        Ok(Some(c)) => c, Ok(None) => return error(StatusCode::UNAUTHORIZED, "collector_required"), Err(e) => return internal(e)
    };
    if !state.limiter.allow(&format!("debug-client:{}", collector.id), 120) { return error(StatusCode::TOO_MANY_REQUESTS, "rate_limited"); }
    let mut map = state.remote_debug.0.lock().unwrap();
    let now = unix_now();
    map.retain(|_, s| now - s.created_at < 86400.);
    if r.action == "open" {
        if map.len() >= 64 { return error(StatusCode::SERVICE_UNAVAILABLE, "capacity"); }
        for s in map.values_mut().filter(|s| s.collector == collector.id) { s.active = false; expire(s, now); let _ = audit(s); }
        let s = Session { id: id(), collector: collector.id, created_at: now, expires_at: now+900., last_seen: now, active: true, commands: vec![] };
        if let Err(e) = audit(&s) { return internal(e); }
        let answer = json!({"session":s.id,"expires_at":s.expires_at});
        map.insert(s.id.clone(), s);
        return Json(answer).into_response();
    }
    let s = match live(&mut map, r.session.as_deref().unwrap_or("")) { Ok(s) => s, Err(e) => return e };
    if s.collector != collector.id { return error(StatusCode::FORBIDDEN, "wrong_collector"); }
    if r.action == "close" { s.active = false; expire(s, now); if let Err(e)=audit(s) {return internal(e);} return Json(json!({"active":false})).into_response(); }
    if !s.active { return Json(json!({"active":false})).into_response(); }
    s.last_seen = now;
    if r.action == "result" {
        let Some(c) = s.commands.iter_mut().find(|c| Some(&c.id)==r.command.as_ref()) else { return error(StatusCode::NOT_FOUND,"command_not_found"); };
        let output = r.output.unwrap_or_default();
        if output.len()>65536 || (c.status != "running" && c.status != "finished") { return error(StatusCode::BAD_REQUEST,"invalid_result"); }
        if c.status == "finished" && (c.output != output || c.exit_code != r.exit_code) { return error(StatusCode::CONFLICT,"result_changed"); }
        c.status="finished".into(); c.output=output; c.exit_code=r.exit_code;
        if let Err(e)=audit(s) {return internal(e);}
        return Json(json!({"active":true,"ack":r.command})).into_response();
    }
    if r.action != "poll" { return error(StatusCode::BAD_REQUEST,"invalid_action"); }
    let command = s.commands.iter_mut().find(|c| c.status == "queued").map(|c| { c.status="running".into(); json!({"id":c.id,"script":c.script}) });
    // Delivery is never repeated: uncertain responses cannot re-execute a command.
    if command.is_some() { if let Err(e)=audit(s) { s.active=false; return internal(e); } }
    Json(json!({"active":true,"command":command})).into_response()
}
fn operator_allowed(peer: SocketAddr, headers: &HeaderMap, secret: &str) -> bool {
    peer.ip().is_loopback() && secret.len() >= 43
        && headers.get("host").and_then(|v|v.to_str().ok()).is_some_and(|h|h.starts_with("127.0.0.1:"))
        && !["origin","forwarded","x-forwarded-for","cf-connecting-ip","x-forwarded-host"].iter().any(|k|headers.contains_key(*k))
        && bearer(headers).is_some_and(|t|Sha256::digest(t.as_bytes())==Sha256::digest(secret.as_bytes()))
}
pub async fn operator(State(state): State<AppState>, ConnectInfo(peer): ConnectInfo<SocketAddr>, headers: HeaderMap, Json(r): Json<OperatorRequest>) -> Response {
    let secret = std::fs::read_to_string("shared_data/remote-debug-operator.key").unwrap_or_default();
    if !operator_allowed(peer,&headers,secret.trim()) { return error(StatusCode::FORBIDDEN,"server_local_operator_required"); }
    let mut map=state.remote_debug.0.lock().unwrap();
    for s in map.values_mut() { expire(s,unix_now()); }
    if r.action=="list" { return Json(json!({"sessions":map.values().map(|s|json!({"id":s.id,"collector":s.collector,"active":s.active,"expires_at":s.expires_at,"last_seen":s.last_seen,"command_count":s.commands.len()})).collect::<Vec<_>>()})).into_response(); }
    let s=match live(&mut map,r.session.as_deref().unwrap_or("")) {Ok(s)=>s,Err(e)=>return e};
    if r.action=="show" {return Json(json!(s)).into_response();}
    if r.action=="stop" {s.active=false;expire(s,unix_now());if let Err(e)=audit(s){return internal(e);}return Json(json!(s)).into_response();}
    if r.action!="exec" || !s.active {return error(StatusCode::CONFLICT,"session_not_active");}
    let script=r.script.unwrap_or_default();
    if script.trim().is_empty() || script.len()>8192 || s.commands.len()>=32 {return error(StatusCode::BAD_REQUEST,"invalid_command");}
    if s.commands.iter().any(|c|c.status=="queued"||c.status=="running") {return error(StatusCode::CONFLICT,"command_in_progress");}
    let c=Command{id:id(),script,status:"queued".into(),output:String::new(),exit_code:None};
    s.commands.push(c.clone());
    if let Err(e)=audit(s){s.active=false;return internal(e);}
    Json(json!(c)).into_response()
}
pub async fn prune() {
    loop {
        let _=tokio::task::spawn_blocking(|| {
            if let Ok(files)=std::fs::read_dir(root()) {for file in files.flatten() {
                if let Ok(m)=file.metadata() {if m.is_file() && m.modified().ok().and_then(|t|t.elapsed().ok()).is_some_and(|age|age.as_secs()>7*86400) {let _=std::fs::remove_file(file.path());}}
            }}
        }).await;
        tokio::time::sleep(std::time::Duration::from_secs(60)).await;
    }
}
#[cfg(test)] mod tests {
    use super::*;
    #[tokio::test] async fn anonymous_client_cannot_create_consent() {
        use axum::{body::Body,http::Request};use tower::ServiceExt;
        let db=sqlx::postgres::PgPoolOptions::new().connect_lazy("postgres://test@127.0.0.1:1/unused").unwrap();
        let app=crate::app(AppState::new(db,crate::Settings::default()));
        let answer=app.oneshot(Request::builder().method("POST").uri("/api/v1/remote-debug/client").header("content-type","application/json").body(Body::from(r#"{"action":"open"}"#)).unwrap()).await.unwrap();
        assert_eq!(answer.status(),StatusCode::UNAUTHORIZED);
    }
    #[test] fn operator_cannot_use_public_route_or_browser() {
        let mut h=HeaderMap::new();let key="a".repeat(43);h.insert("host","127.0.0.1:8766".parse().unwrap());h.insert("authorization",format!("Bearer {key}").parse().unwrap());
        assert!(operator_allowed("127.0.0.1:7".parse().unwrap(),&h,&key));
        assert!(!operator_allowed("8.8.8.8:7".parse().unwrap(),&h,&key));
        h.insert("cf-connecting-ip","127.0.0.1".parse().unwrap());assert!(!operator_allowed("127.0.0.1:7".parse().unwrap(),&h,&key));
    }
    #[test] fn expired_or_disconnected_consent_cancels_commands() {
        let mut s=Session{id:id(),collector:1,created_at:1.,expires_at:901.,last_seen:2.,active:true,commands:vec![Command{id:id(),script:"Get-Date".into(),status:"running".into(),output:String::new(),exit_code:None}]};
        expire(&mut s,15.);assert!(!s.active);assert_eq!(s.commands[0].status,"terminated");
    }
}

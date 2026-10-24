//! Account-owned conversations. Client-provided account IDs/history are never authoritative.
#![allow(clippy::result_large_err)]
use super::{error, stream::Sink, ChatRequest, Turn};
use crate::{
    api::{reader, ClientAddr},
    auth, contributors, AppState,
};
use axum::{
    extract::{Path, Query, State},
    http::{HeaderMap, StatusCode},
    response::{
        sse::{Event, KeepAlive, Sse},
        IntoResponse, Response,
    },
    routing::{get, post},
    Json, Router,
};
use futures_util::stream;
use serde::Deserialize;
use serde_json::{json, Value};
use sqlx::PgPool;
use std::{
    collections::HashMap,
    convert::Infallible,
    sync::{Mutex, OnceLock},
    time::Duration,
};
use tokio::sync::{mpsc, watch};

fn jobs() -> &'static Mutex<HashMap<String, watch::Sender<bool>>> {
    static JOBS: OnceLock<Mutex<HashMap<String, watch::Sender<bool>>>> = OnceLock::new();
    JOBS.get_or_init(Mutex::default)
}
fn internal(_: impl std::fmt::Display) -> Response {
    error(
        StatusCode::INTERNAL_SERVER_ERROR,
        "agent_history_unavailable",
    )
}
fn id() -> String {
    auth::new_credentials().public_id
}
fn valid_id(s: &str) -> bool {
    s.len() == 24 && s.bytes().all(|c| c.is_ascii_hexdigit())
}
async fn owner(state: &AppState, headers: &HeaderMap, write: bool) -> Result<i64, Response> {
    if write {
        return Ok(contributors::writable(state, headers).await?.id);
    }
    contributors::session(state, headers)
        .await?
        .map(|s| s.id)
        .ok_or_else(|| error(StatusCode::UNAUTHORIZED, "login_required"))
}
async fn owns(db: &PgPool, account: i64, thread: &str) -> Result<(), Response> {
    if !valid_id(thread) {
        return Err(error(StatusCode::NOT_FOUND, "conversation_not_found"));
    }
    let found: bool = sqlx::query_scalar(
        "SELECT EXISTS(SELECT 1 FROM agent_threads WHERE id=$1 AND account_id=$2)",
    )
    .bind(thread)
    .bind(account)
    .fetch_one(db)
    .await
    .map_err(internal)?;
    if found {
        Ok(())
    } else {
        Err(error(StatusCode::NOT_FOUND, "conversation_not_found"))
    }
}
pub fn router() -> Router<AppState> {
    Router::new()
        .route("/api/v1/agent/threads", get(list).post(create))
        .route(
            "/api/v1/agent/threads/{id}",
            get(load).patch(rename).delete(remove),
        )
        .route("/api/v1/agent/threads/{id}/stop", post(stop))
        .route("/api/v1/agent/stream", post(generate))
}
#[derive(Default, Deserialize)]
struct Page {
    before: Option<String>,
    before_seq: Option<i64>,
}
async fn list(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(page): Query<Page>,
) -> Response {
    let account = match owner(&state, &headers, false).await {
        Ok(a) => a,
        Err(e) => return e,
    };
    let rows:Result<Vec<Value>,_>=sqlx::query_scalar("SELECT to_jsonb(x) FROM (SELECT t.id,t.title,extract(epoch FROM t.created_at)::float8 AS created_at,extract(epoch FROM t.updated_at)::float8 AS updated_at FROM agent_threads t WHERE account_id=$1 AND ($2::text IS NULL OR (t.updated_at,t.id)<(SELECT updated_at,id FROM agent_threads WHERE id=$2 AND account_id=$1)) ORDER BY updated_at DESC,id DESC LIMIT 51) x")
        .bind(account).bind(page.before).fetch_all(&state.db).await;
    match rows {
        Ok(mut rows) => {
            let more = rows.len() > 50;
            rows.truncate(50);
            let next = if more {
                rows.last().map(|r| r["id"].clone())
            } else {
                None
            };
            Json(json!({"threads":rows,"next_cursor":next})).into_response()
        }
        Err(e) => internal(e),
    }
}
async fn create(State(state): State<AppState>, headers: HeaderMap) -> Response {
    let account = match owner(&state, &headers, true).await {
        Ok(a) => a,
        Err(e) => return e,
    };
    let thread = id();
    match sqlx::query("INSERT INTO agent_threads(id,account_id) VALUES($1,$2)")
        .bind(&thread)
        .bind(account)
        .execute(&state.db)
        .await
    {
        Ok(_) => (
            StatusCode::CREATED,
            Json(json!({"id":thread,"title":"新对话"})),
        )
            .into_response(),
        Err(e) => internal(e),
    }
}
async fn stale(db: &PgPool, thread: &str) -> Result<(), sqlx::Error> {
    sqlx::query("UPDATE agent_messages SET state='aborted',error_code='agent_stream_interrupted',updated_at=now() WHERE thread_id=$1 AND state='streaming' AND updated_at<now()-interval '180 seconds'").bind(thread).execute(db).await?;
    Ok(())
}
async fn load(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(thread): Path<String>,
    Query(page): Query<Page>,
) -> Response {
    let account = match owner(&state, &headers, false).await {
        Ok(a) => a,
        Err(e) => return e,
    };
    if let Err(e) = owns(&state.db, account, &thread).await {
        return e;
    }
    if let Err(e) = stale(&state.db, &thread).await {
        return internal(e);
    }
    let title: Result<String, _> =
        sqlx::query_scalar("SELECT title FROM agent_threads WHERE id=$1 AND account_id=$2")
            .bind(&thread)
            .bind(account)
            .fetch_one(&state.db)
            .await;
    let rows:Result<Vec<Value>,_>=sqlx::query_scalar("SELECT to_jsonb(x) FROM (SELECT id,seq,request_id,role,content,state,metadata,error_code,extract(epoch FROM created_at)::float8 AS created_at FROM agent_messages WHERE thread_id=$1 AND ($2::bigint IS NULL OR seq<$2) ORDER BY seq DESC LIMIT 101) x").bind(&thread).bind(page.before_seq).fetch_all(&state.db).await;
    match (title, rows) {
        (Ok(title), Ok(mut rows)) => {
            let more = rows.len() > 100;
            rows.truncate(100);
            rows.reverse();
            Json(json!({"id":thread,"title":title,"messages":rows,"has_more":more})).into_response()
        }
        _ => internal("load"),
    }
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Title {
    title: String,
}
async fn rename(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(thread): Path<String>,
    Json(input): Json<Title>,
) -> Response {
    let account = match owner(&state, &headers, true).await {
        Ok(a) => a,
        Err(e) => return e,
    };
    if let Err(e) = owns(&state.db, account, &thread).await {
        return e;
    }
    let title = input.title.trim();
    if title.is_empty() || title.chars().count() > 80 {
        return error(StatusCode::BAD_REQUEST, "invalid_title");
    }
    match sqlx::query(
        "UPDATE agent_threads SET title=$3,updated_at=now() WHERE id=$1 AND account_id=$2",
    )
    .bind(&thread)
    .bind(account)
    .bind(title)
    .execute(&state.db)
    .await
    {
        Ok(_) => Json(json!({"ok":true})).into_response(),
        Err(e) => internal(e),
    }
}
async fn remove(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(thread): Path<String>,
) -> Response {
    let account = match owner(&state, &headers, true).await {
        Ok(a) => a,
        Err(e) => return e,
    };
    if let Err(e) = owns(&state.db, account, &thread).await {
        return e;
    }
    if let Some(sender) = jobs().lock().unwrap().get(&thread) {
        let _ = sender.send(true);
    }
    match sqlx::query("DELETE FROM agent_threads WHERE id=$1 AND account_id=$2")
        .bind(&thread)
        .bind(account)
        .execute(&state.db)
        .await
    {
        Ok(_) => StatusCode::NO_CONTENT.into_response(),
        Err(e) => internal(e),
    }
}
async fn stop(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(thread): Path<String>,
) -> Response {
    let account = match owner(&state, &headers, true).await {
        Ok(a) => a,
        Err(e) => return e,
    };
    if let Err(e) = owns(&state.db, account, &thread).await {
        return e;
    }
    if let Some(sender) = jobs().lock().unwrap().get(&thread) {
        let _ = sender.send(true);
    }
    Json(json!({"ok":true})).into_response()
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Input {
    message: String,
    #[serde(default)]
    thread_id: Option<String>,
    #[serde(default)]
    request_id: String,
    #[serde(default)]
    language: String,
    #[serde(default)]
    history: Vec<Turn>,
    #[serde(default)]
    retry: bool,
}
struct Saved {
    thread: String,
    assistant: String,
}
async fn prepare(
    state: &AppState,
    account: i64,
    input: &Input,
) -> Result<(Saved, Vec<Turn>), Response> {
    let thread = input.thread_id.clone().unwrap_or_else(id);
    let mut tx = state.db.begin().await.map_err(internal)?;
    if input.thread_id.is_none() {
        sqlx::query("INSERT INTO agent_threads(id,account_id) VALUES($1,$2)")
            .bind(&thread)
            .bind(account)
            .execute(&mut *tx)
            .await
            .map_err(internal)?;
    }
    let found: Option<String> =
        sqlx::query_scalar("SELECT id FROM agent_threads WHERE id=$1 AND account_id=$2 FOR UPDATE")
            .bind(&thread)
            .bind(account)
            .fetch_optional(&mut *tx)
            .await
            .map_err(internal)?;
    if found.is_none() {
        return Err(error(StatusCode::NOT_FOUND, "conversation_not_found"));
    }
    sqlx::query("UPDATE agent_messages SET state='aborted',error_code='agent_stream_interrupted' WHERE thread_id=$1 AND state='streaming' AND updated_at<now()-interval '180 seconds'").bind(&thread).execute(&mut *tx).await.map_err(internal)?;
    let busy: bool = sqlx::query_scalar(
        "SELECT EXISTS(SELECT 1 FROM agent_messages WHERE thread_id=$1 AND state='streaming')",
    )
    .bind(&thread)
    .fetch_one(&mut *tx)
    .await
    .map_err(internal)?;
    if busy {
        return Err(error(StatusCode::CONFLICT, "conversation_busy"));
    }
    let duplicate: bool = sqlx::query_scalar(
        "SELECT EXISTS(SELECT 1 FROM agent_messages WHERE thread_id=$1 AND request_id=$2)",
    )
    .bind(&thread)
    .bind(&input.request_id)
    .fetch_one(&mut *tx)
    .await
    .map_err(internal)?;
    let mut retry_before = None;
    if duplicate {
        let last:Option<(i64,String,String)>=sqlx::query_as("SELECT seq,request_id,content FROM agent_messages WHERE thread_id=$1 AND role='user' ORDER BY seq DESC LIMIT 1").bind(&thread).fetch_optional(&mut *tx).await.map_err(internal)?;
        let Some((seq, request_id, content)) = last
            .filter(|(_, r, c)| input.retry && r == &input.request_id && c == input.message.trim())
        else {
            return Err(error(StatusCode::CONFLICT, "message_already_saved"));
        };
        let _ = (request_id, content);
        let removed=sqlx::query("DELETE FROM agent_messages WHERE thread_id=$1 AND seq>$2 AND role='assistant' AND state IN ('error','aborted')").bind(&thread).bind(seq).execute(&mut *tx).await.map_err(internal)?;
        if removed.rows_affected() == 0 {
            return Err(error(StatusCode::CONFLICT, "message_already_saved"));
        }
        retry_before = Some(seq);
    }
    let mut previous:Vec<(String,String)>=sqlx::query_as("SELECT role,content FROM agent_messages WHERE thread_id=$1 AND content<>'' AND state<>'streaming' AND ($2::bigint IS NULL OR seq<$2) ORDER BY seq DESC LIMIT 12").bind(&thread).bind(retry_before).fetch_all(&mut *tx).await.map_err(internal)?;
    previous.reverse();
    let user = id();
    let assistant = id();
    if !duplicate {
        sqlx::query("INSERT INTO agent_messages(id,thread_id,request_id,role,content) VALUES($1,$2,$3,'user',$4)").bind(user).bind(&thread).bind(&input.request_id).bind(input.message.trim()).execute(&mut *tx).await.map_err(internal)?;
    }
    sqlx::query(
        "INSERT INTO agent_messages(id,thread_id,role,state) VALUES($1,$2,'assistant','streaming')",
    )
    .bind(&assistant)
    .bind(&thread)
    .execute(&mut *tx)
    .await
    .map_err(internal)?;
    let title: String = input.message.trim().chars().take(38).collect();
    sqlx::query("UPDATE agent_threads SET title=CASE WHEN title='新对话' THEN $2 ELSE title END,updated_at=now() WHERE id=$1").bind(&thread).bind(title).execute(&mut *tx).await.map_err(internal)?;
    tx.commit().await.map_err(internal)?;
    Ok((
        Saved { thread, assistant },
        previous
            .into_iter()
            .map(|(role, content)| Turn {
                role,
                content: content.chars().take(4000).collect(),
            })
            .collect(),
    ))
}
async fn persist(
    db: &PgPool,
    saved: &Saved,
    content: &str,
    metadata: &Value,
    status: &str,
    code: Option<&str>,
) -> Result<(), sqlx::Error> {
    let mut tx = db.begin().await?;
    sqlx::query("UPDATE agent_messages SET content=$2,metadata=$3,state=$4,error_code=$5,updated_at=now() WHERE id=$1").bind(&saved.assistant).bind(content).bind(metadata).bind(status).bind(code).execute(&mut *tx).await?;
    sqlx::query("UPDATE agent_threads SET updated_at=now() WHERE id=$1")
        .bind(&saved.thread)
        .execute(&mut *tx)
        .await?;
    tx.commit().await
}
async fn generate(
    State(state): State<AppState>,
    headers: HeaderMap,
    ClientAddr(addr): ClientAddr,
    Json(mut input): Json<Input>,
) -> Response {
    let request = ChatRequest {
        message: input.message.clone(),
        history: input.history.clone(),
        language: input.language.clone(),
    };
    if !request.valid()
        || input.request_id.len() > 80
        || !input
            .request_id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"_-".contains(&b))
        || input.thread_id.as_ref().is_some_and(|s| !valid_id(s))
    {
        return error(StatusCode::BAD_REQUEST, "invalid_agent_request");
    }
    if input.request_id.is_empty() {
        input.request_id = id();
    }
    if let Err(e) = reader(&state, &headers, &addr, "agent-chat").await {
        return e;
    }
    let account = match contributors::session(&state, &headers).await {
        Ok(a) => a,
        Err(e) => return e,
    };
    if account.is_none() && input.thread_id.is_some() {
        return error(StatusCode::UNAUTHORIZED, "login_required");
    }
    if account.is_some() {
        if let Err(e) = contributors::writable(&state, &headers).await {
            return e;
        }
    }
    let Some(agent) = state.agent.clone() else {
        return error(StatusCode::SERVICE_UNAVAILABLE, "agent_not_configured");
    };
    let rate = account
        .as_ref()
        .map(|a| format!("agent-account:{}", a.id))
        .unwrap_or_else(|| format!("agent-chat-ip:{addr}"));
    if !state.limiter.allow(&rate, 6) || !state.limiter.allow(&format!("agent-all-ip:{addr}"), 12) {
        return error(StatusCode::TOO_MANY_REQUESTS, "agent_rate_limited");
    }
    let Ok(permit) = agent.permit() else {
        return error(StatusCode::TOO_MANY_REQUESTS, "agent_busy");
    };
    let (saved, history) = if let Some(a) = account {
        match prepare(&state, a.id, &input).await {
            Ok((s, h)) => (Some(s), h),
            Err(e) => return e,
        }
    } else {
        (None, input.history)
    };
    let message_id = saved
        .as_ref()
        .map(|s| s.assistant.clone())
        .unwrap_or_else(id);
    let (sender, receiver) = mpsc::channel::<Value>(64);
    let sink = Sink::new(sender, agent.model());
    let (cancel, mut cancelled) = watch::channel(false);
    if let Some(s) = &saved {
        jobs().lock().unwrap().insert(s.thread.clone(), cancel);
    }
    tokio::spawn(async move {
        let _permit = permit;
        sink.emit(json!({"type":"start","messageId":message_id}))
            .await;
        sink.emit(json!({"type":"data-session","data":{"thread_id":saved.as_ref().map(|s|&s.thread)},"transient":true})).await;
        let request = ChatRequest {
            message: input.message,
            history,
            language: input.language,
        };
        let task = agent.chat_with_events(&state.db, request, Some(sink.clone()));
        tokio::pin!(task);
        let deadline = tokio::time::sleep(Duration::from_secs(150));
        tokio::pin!(deadline);
        let mut tick = tokio::time::interval(Duration::from_secs(2));
        tick.tick().await;
        let (content, meta, status, code) = loop {
            tokio::select! {
                result=&mut task=>match result {
                    Ok(v)=>break (v["answer"].as_str().unwrap_or("").to_owned(),json!({"model":v["model"],"tool_calls":v["tool_calls"],"sources":v["sources"]}),"complete",None),
                    Err((_,code))=>{let (text,meta)=sink.snapshot();break(text,meta,"error",Some(code));}
                },
                _=&mut deadline=>{let(text,meta)=sink.snapshot();break(text,meta,"error",Some("agent_timeout"));},
                _=sink.sender.closed()=>{let(text,meta)=sink.snapshot();break(text,meta,"aborted",Some("agent_stream_interrupted"));},
                _=cancelled.changed(),if saved.is_some()=>{let(text,meta)=sink.snapshot();break(text,meta,"aborted",None);},
                _=tick.tick()=>if let Some(s)=&saved {let(text,meta)=sink.snapshot();if persist(&state.db,s,&text,&meta,"streaming",None).await.is_err(){break(text,meta,"error",Some("agent_history_unavailable"));}},
            }
        };
        let mut failure = code;
        if let Some(s) = &saved {
            if persist(&state.db, s, &content, &meta, status, code)
                .await
                .is_err()
            {
                failure = Some("agent_history_unavailable");
            }
            jobs().lock().unwrap().remove(&s.thread);
        }
        if let Some(code) = failure {
            sink.emit(json!({"type":"error","errorText":code})).await;
        } else if status == "aborted" {
            sink.emit(json!({"type":"abort"})).await;
        }
        sink.emit(json!({"type":"finish","messageMetadata":{ "thread_id":saved.as_ref().map(|s|&s.thread),"state":status,"model":meta["model"],"sources":meta["sources"],"tool_calls":meta["tool_calls"]}})).await;
    });
    let events = stream::unfold(receiver, |mut rx| async move {
        rx.recv().await.map(|v| {
            (
                Ok::<_, Infallible>(Event::default().data(v.to_string())),
                rx,
            )
        })
    });
    // SDK requires a terminal sentinel in addition to its finish event.
    use futures_util::StreamExt;
    let events = events.chain(stream::once(async {
        Ok::<_, Infallible>(Event::default().data("[DONE]"))
    }));
    let mut response = Sse::new(events)
        .keep_alive(KeepAlive::new().interval(Duration::from_secs(10)))
        .into_response();
    response
        .headers_mut()
        .insert("x-vercel-ai-ui-message-stream", "v1".parse().unwrap());
    response
        .headers_mut()
        .insert("x-accel-buffering", "no".parse().unwrap());
    response.headers_mut().insert("content-encoding", "identity".parse().unwrap());
    response
        .headers_mut()
        .insert("cache-control", "no-cache, no-transform".parse().unwrap());
    response
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::{body::Body, http::Request};
    use http_body_util::BodyExt;
    use sqlx::{
        postgres::{PgConnectOptions, PgPoolOptions},
        ConnectOptions,
    };
    use tower::ServiceExt;

    async fn call(
        app: &Router,
        method: &str,
        path: &str,
        token: &str,
        data: Option<Value>,
    ) -> Response {
        app.clone()
            .oneshot(
                Request::builder()
                    .method(method)
                    .uri(path)
                    .header("cookie", format!("cwm_account={token}"))
                    .header("origin", "https://mxd.ruit.me")
                    .header("x-csrf-token", "fixture-csrf")
                    .header("content-type", "application/json")
                    .body(
                        data.map(|v| Body::from(v.to_string()))
                            .unwrap_or_else(Body::empty),
                    )
                    .unwrap(),
            )
            .await
            .unwrap()
    }
    async fn json_body(res: Response) -> Value {
        serde_json::from_slice(&res.into_body().collect().await.unwrap().to_bytes()).unwrap()
    }
    async fn through_first_delta(body: &mut Body) -> String {
        let mut output = String::new();
        while !output.contains("text-delta") {
            let frame = tokio::time::timeout(Duration::from_secs(4), body.frame())
                .await
                .expect("first streamed text must not wait for model completion")
                .unwrap()
                .unwrap();
            if let Ok(data) = frame.into_data() {
                output.push_str(std::str::from_utf8(&data).unwrap());
            }
        }
        assert!(!output.contains("\"type\":\"finish\""));
        output
    }
    #[tokio::test]
    async fn history_is_private_streams_before_completion_and_survives_stop_retry_and_new_session()
    {
        let Ok(url) = std::env::var("DATABASE_URL") else {
            return;
        };
        let options: PgConnectOptions = url.parse().unwrap();
        let admin = PgPoolOptions::new()
            .max_connections(1)
            .connect_with(options.clone().disable_statement_logging())
            .await
            .unwrap();
        let database = format!("agent_history_test_{}", id());
        sqlx::query(&format!("CREATE DATABASE {database}"))
            .execute(&admin)
            .await
            .unwrap();
        let db = PgPoolOptions::new()
            .max_connections(6)
            .connect_with(options.database(&database).disable_statement_logging())
            .await
            .unwrap();
        crate::MIGRATOR.run(&db).await.unwrap();
        let a: i64 =
            sqlx::query_scalar("INSERT INTO accounts(public_id) VALUES('history-a') RETURNING id")
                .fetch_one(&db)
                .await
                .unwrap();
        let b: i64 =
            sqlx::query_scalar("INSERT INTO accounts(public_id) VALUES('history-b') RETURNING id")
                .fetch_one(&db)
                .await
                .unwrap();
        let tokens = [
            auth::new_credentials().token,
            auth::new_credentials().token,
            auth::new_credentials().token,
        ];
        for (account, token) in [(a, &tokens[0]), (b, &tokens[1]), (a, &tokens[2])] {
            sqlx::query("INSERT INTO account_sessions(token_hash,account_id,csrf,expires_at) VALUES($1,$2,'fixture-csrf',now()+interval '1 hour')").bind(auth::token_hash(token)).bind(account).execute(&db).await.unwrap();
        }
        let gate = std::sync::Arc::new(tokio::sync::Notify::new());
        let mock_gate = gate.clone();
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let endpoint = format!("http://{}/chat", listener.local_addr().unwrap());
        let upstream=Router::new().route("/chat",post(move||{let gate=mock_gate.clone();async move {
            let chunks=stream::unfold((0,gate),|(phase,gate)|async move {
                if phase==0 {let text="这是一段用于检查真实流式传输的回复，首段应该立即出现，而不是等待完整回答。".repeat(5);let data=json!({"choices":[{"delta":{"content":text},"finish_reason":null}]});Some((Ok::<_,Infallible>(format!("data: {data}\n\n")),(1,gate)))}
                else if phase==1 {gate.notified().await;let data=json!({"choices":[{"delta":{"content":"回复完成。"},"finish_reason":"stop"}]});Some((Ok(format!("data: {data}\n\ndata: [DONE]\n\n")),(2,gate)))}else{None}
            });
            ([ ("content-type","text/event-stream") ],Body::from_stream(chunks))
        }}));
        let mock_job = tokio::spawn(async move {
            axum::serve(listener, upstream).await.unwrap();
        });
        let mut state = AppState::new(db.clone(), crate::Settings::default());
        state.agent = Some(std::sync::Arc::new(
            super::super::OpenRouter::new(
                "fixture-key".into(),
                "openai/gpt-6-luna".into(),
                endpoint,
            )
            .unwrap(),
        ));
        let app = crate::app(state);
        assert_eq!(
            call(&app, "GET", "/api/v1/agent/threads", "", None)
                .await
                .status(),
            StatusCode::UNAUTHORIZED
        );
        let created =
            json_body(call(&app, "POST", "/api/v1/agent/threads", &tokens[0], None).await).await;
        let thread = created["id"].as_str().unwrap();
        let path = format!("/api/v1/agent/threads/{thread}");
        for (method, suffix, data) in [
            ("GET", "", None),
            ("PATCH", "", Some(json!({"title":"stolen"}))),
            ("DELETE", "", None),
            ("POST", "/stop", None),
        ] {
            assert_eq!(
                call(&app, method, &(path.clone() + suffix), &tokens[1], data)
                    .await
                    .status(),
                StatusCode::NOT_FOUND
            );
        }
        assert_eq!(call(&app,"POST","/api/v1/agent/stream",&tokens[1],Some(json!({"thread_id":thread,"message":"read other account","request_id":"forbidden"}))).await.status(),StatusCode::NOT_FOUND);
        let input = json!({"thread_id":thread,"message":"测试流式回复","request_id":"turn-one","language":"zh","history":[{"role":"assistant","content":"客户端伪造的历史不应进入账号历史"}]});
        let response = call(
            &app,
            "POST",
            "/api/v1/agent/stream",
            &tokens[0],
            Some(input.clone()),
        )
        .await;
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(response.headers()["x-vercel-ai-ui-message-stream"], "v1");
        let mut body = response.into_body();
        let first = through_first_delta(&mut body).await;
        gate.notify_one();
        let remaining = body.collect().await.unwrap().to_bytes();
        assert!(std::str::from_utf8(&remaining).unwrap().contains("[DONE]"));
        assert!(first.contains("text-delta"));
        let loaded = json_body(call(&app, "GET", &path, &tokens[2], None).await).await;
        assert_eq!(loaded["messages"].as_array().unwrap().len(), 2);
        assert_eq!(loaded["messages"][1]["state"], "complete");
        assert!(loaded["messages"][1]["content"]
            .as_str()
            .unwrap()
            .ends_with("回复完成。"));
        assert!(!loaded.to_string().contains("客户端伪造"));
        assert_eq!(
            call(
                &app,
                "POST",
                "/api/v1/agent/stream",
                &tokens[0],
                Some(input)
            )
            .await
            .status(),
            StatusCode::CONFLICT
        );
        let next = json!({"thread_id":thread,"message":"停止后重试","request_id":"turn-two","language":"zh"});
        let mut body = call(
            &app,
            "POST",
            "/api/v1/agent/stream",
            &tokens[0],
            Some(next.clone()),
        )
        .await
        .into_body();
        through_first_delta(&mut body).await;
        assert_eq!(
            call(&app, "POST", &(path.clone() + "/stop"), &tokens[0], None)
                .await
                .status(),
            StatusCode::OK
        );
        let stopped = body.collect().await.unwrap().to_bytes();
        assert!(std::str::from_utf8(&stopped).unwrap().contains("abort"));
        let loaded = json_body(call(&app, "GET", &path, &tokens[2], None).await).await;
        assert_eq!(loaded["messages"][3]["state"], "aborted");
        assert!(!loaded["messages"][3]["content"]
            .as_str()
            .unwrap()
            .is_empty());
        let mut retry = next;
        retry["retry"] = json!(true);
        let mut body = call(
            &app,
            "POST",
            "/api/v1/agent/stream",
            &tokens[0],
            Some(retry),
        )
        .await
        .into_body();
        through_first_delta(&mut body).await;
        gate.notify_one();
        body.collect().await.unwrap();
        let loaded = json_body(call(&app, "GET", &path, &tokens[2], None).await).await;
        assert_eq!(loaded["messages"].as_array().unwrap().len(), 4);
        assert_eq!(loaded["messages"][3]["state"], "complete");
        assert_eq!(
            call(
                &app,
                "PATCH",
                &path,
                &tokens[0],
                Some(json!({"title":"保存在账号中的对话"}))
            )
            .await
            .status(),
            StatusCode::OK
        );
        let list =
            json_body(call(&app, "GET", "/api/v1/agent/threads", &tokens[2], None).await).await;
        assert_eq!(list["threads"][0]["title"], "保存在账号中的对话");
        assert_eq!(
            call(&app, "DELETE", &path, &tokens[0], None).await.status(),
            StatusCode::NO_CONTENT
        );
        let count: i64 = sqlx::query_scalar("SELECT count(*) FROM agent_messages")
            .fetch_one(&db)
            .await
            .unwrap();
        assert_eq!(count, 0);
        mock_job.abort();
        db.close().await;
        sqlx::query(&format!("DROP DATABASE {database}"))
            .execute(&admin)
            .await
            .unwrap();
        admin.close().await;
    }
}

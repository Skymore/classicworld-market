//! Read-only market tools, shared by the HTTP API and the OpenRouter agent.
//! Tool execution never accepts arbitrary SQL, URLs, or collector credentials.
mod data;
mod history;
mod provider;
mod stream;

pub use provider::OpenRouter;

use axum::{
    extract::{DefaultBodyLimit, Path, State},
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    routing::{get, post},
    Json, Router,
};
use serde::Deserialize;
use serde_json::{json, Value};

use crate::{
    api::{reader, ClientAddr},
    AppState,
};

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/api/v1/agent/tools", get(catalog))
        .route("/api/v1/agent/tools/{name}", post(call_tool))
        .route("/api/v1/agent/chat", post(chat))
        .merge(history::router())
        .layer(DefaultBodyLimit::max(32 * 1024))
}

pub(crate) fn error(status: StatusCode, code: &str) -> Response {
    (status, Json(json!({"error":code}))).into_response()
}

async fn catalog(
    State(state): State<AppState>,
    headers: HeaderMap,
    ClientAddr(addr): ClientAddr,
) -> Response {
    if let Err(res) = reader(&state, &headers, &addr, "agent-tools").await {
        return res;
    }
    Json(json!({
        "enabled":state.agent.is_some(),
        "model":state.agent.as_ref().map(|a| a.model()),
        "tools":data::definitions(), "read_only":true,
        "endpoint":"POST /api/v1/agent/tools/{function.name}",
        "limitations":crate::views::LIMITATION,
    }))
    .into_response()
}

async fn call_tool(
    State(state): State<AppState>,
    headers: HeaderMap,
    ClientAddr(addr): ClientAddr,
    Path(name): Path<String>,
    Json(args): Json<Value>,
) -> Response {
    if let Err(res) = reader(&state, &headers, &addr, "agent-tools").await {
        return res;
    }
    match execute(&state.db, &name, args).await {
        Ok(value) => Json(value).into_response(),
        Err((status, code)) => error(status, code),
    }
}

pub(crate) async fn execute(
    db: &sqlx::PgPool,
    name: &str,
    args: Value,
) -> Result<Value, (StatusCode, &'static str)> {
    let args = data::parse(name, args).map_err(|code| (StatusCode::BAD_REQUEST, code))?;
    match tokio::time::timeout(std::time::Duration::from_secs(12), data::run(db, args)).await {
        Ok(Ok(value)) => Ok(value),
        result => {
            // No user prompt, upstream body or credential is logged.
            tracing::warn!(
                tool = name,
                timed_out = result.is_err(),
                "agent data tool failed"
            );
            Err((StatusCode::SERVICE_UNAVAILABLE, "market_data_unavailable"))
        }
    }
}

#[derive(Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Turn {
    pub role: String,
    pub content: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ChatRequest {
    pub message: String,
    #[serde(default)]
    pub history: Vec<Turn>,
    #[serde(default)]
    pub language: String,
}

impl ChatRequest {
    pub fn valid(&self) -> bool {
        !self.message.trim().is_empty()
            && self.message.chars().count() <= 2000
            && self.history.len() <= 12
            && self.history.iter().all(|t| {
                matches!(t.role.as_str(), "user" | "assistant")
                    && !t.content.trim().is_empty()
                    && t.content.chars().count() <= 4000
            })
            && matches!(self.language.as_str(), "" | "zh" | "en")
    }
}

async fn chat(
    State(state): State<AppState>,
    headers: HeaderMap,
    ClientAddr(addr): ClientAddr,
    Json(request): Json<ChatRequest>,
) -> Response {
    if !request.valid() {
        return error(StatusCode::BAD_REQUEST, "invalid_agent_request");
    }
    if let Err(res) = reader(&state, &headers, &addr, "agent-chat").await {
        return res;
    }
    let Some(agent) = &state.agent else {
        return error(StatusCode::SERVICE_UNAVAILABLE, "agent_not_configured");
    };
    if !state.limiter.allow(&format!("agent-chat-ip:{addr}"), 4) {
        return error(StatusCode::TOO_MANY_REQUESTS, "agent_rate_limited");
    }
    let Ok(_permit) = agent.permit() else {
        return error(StatusCode::TOO_MANY_REQUESTS, "agent_busy");
    };
    match tokio::time::timeout(
        std::time::Duration::from_secs(150),
        agent.chat(&state.db, request),
    )
    .await
    {
        Ok(Ok(value)) => Json(value).into_response(),
        Ok(Err((status, code))) => error(status, code),
        Err(_) => error(StatusCode::GATEWAY_TIMEOUT, "agent_timeout"),
    }
}

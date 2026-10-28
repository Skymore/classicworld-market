//! Read-only adventure and market tools for Global MapleStory Classic World.
//! Tool execution never accepts arbitrary SQL, URLs, or collector credentials.
mod adventure;
mod data;
mod history;
mod knowledge;
mod provider;
mod stream;
mod web_search;

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
        .route("/api/v1/agent/knowledge", get(knowledge::index))
        .route("/api/v1/agent/knowledge/{id}", get(knowledge::detail))
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
        "game":"Global MapleStory Classic World", "assistant":"冒险助手",
        "web_search":{"enabled":state.agent.is_some(),"max_per_turn":2,"cache_seconds":300},
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
    let provider = state.agent.as_deref();
    let _permit = if name == "search_web" {
        if !state.limiter.allow(&format!("agent-web-ip:{addr}"), 4) {
            return error(StatusCode::TOO_MANY_REQUESTS, "agent_rate_limited");
        }
        match provider.map(OpenRouter::permit) {
            Some(Ok(permit)) => Some(permit),
            Some(Err(_)) => return error(StatusCode::TOO_MANY_REQUESTS, "agent_busy"),
            None => return error(StatusCode::SERVICE_UNAVAILABLE, "agent_not_configured"),
        }
    } else {
        None
    };
    match execute_with_provider(&state.db, provider, &name, args).await {
        Ok(value) => Json(value).into_response(),
        Err((status, code)) => error(status, code),
    }
}

pub(crate) async fn execute(
    db: &sqlx::PgPool,
    name: &str,
    args: Value,
) -> Result<Value, (StatusCode, &'static str)> {
    execute_with_provider(db, None, name, args).await
}

pub(crate) async fn execute_with_provider(
    db: &sqlx::PgPool,
    provider: Option<&OpenRouter>,
    name: &str,
    args: Value,
) -> Result<Value, (StatusCode, &'static str)> {
    let args = data::parse(name, args).map_err(|code| (StatusCode::BAD_REQUEST, code))?;
    if let data::Args::WebSearch(query) = args {
        return match provider {
            Some(provider) => provider.search_web(query).await,
            None => Err((StatusCode::SERVICE_UNAVAILABLE, "agent_not_configured")),
        };
    }
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

/// The catalogue page the player has open when asking, sent by the browser.
#[derive(Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PageContext {
    pub kind: String,
    pub id: i64,
    pub label: String,
}

impl PageContext {
    fn valid(&self) -> bool {
        matches!(self.kind.as_str(), "item" | "mob" | "map")
            && (1..=999_999_999).contains(&self.id)
            && !self.label.trim().is_empty()
            && self.label.chars().count() <= 120
            && !self.label.chars().any(char::is_control)
    }

    /// Prefixed to the player's message for the model only; history keeps what they typed.
    pub(crate) fn note(&self) -> String {
        let (kind, tool) = match self.kind.as_str() {
            "item" => ("item", "get_item"),
            "mob" => ("monster", "get_game_entity kind=monster"),
            _ => ("map", "get_game_entity kind=map"),
        };
        format!(
            "[Page the player has open on this site, added by the browser: {kind} id {} named {}. \"This item/monster/map\" (这件/这把/这只/这里) means this page; read it with {tool} using this id.]",
            self.id,
            serde_json::to_string(&self.label).unwrap_or_default(),
        )
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ChatRequest {
    pub message: String,
    #[serde(default)]
    pub history: Vec<Turn>,
    #[serde(default)]
    pub language: String,
    #[serde(default)]
    pub page: Option<PageContext>,
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
            && self.page.as_ref().is_none_or(PageContext::valid)
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

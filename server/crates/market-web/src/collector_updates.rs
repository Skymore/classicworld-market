//! Release hints only. Clients independently verify official-domain release manifests.
use crate::{api::ClientAddr, AppState};
use axum::{
    extract::State,
    http::StatusCode,
    response::{
        sse::{Event, KeepAlive, Sse},
        IntoResponse, Response,
    },
};
use futures_util::stream;
use std::{convert::Infallible, time::Duration};

pub fn stable_tag(tag: &str) -> bool {
    let Some(tag) = tag.strip_prefix('v') else {
        return false;
    };
    let parts: Vec<_> = tag.split('.').collect();
    parts.len() == 3
        && parts
            .iter()
            .all(|p| !p.is_empty() && p.len() <= 6 && p.bytes().all(|c| c.is_ascii_digit()))
}

pub async fn events(State(state): State<AppState>, ClientAddr(addr): ClientAddr) -> Response {
    // Public version notices never need a collector identity or login cookie.
    if !state
        .limiter
        .allow(&format!("collector-updates:{addr}"), 60)
    {
        return StatusCode::TOO_MANY_REQUESTS.into_response();
    }
    let updates = stream::unfold(
        (state.collector_updates.subscribe(), true),
        |(mut receiver, first)| async move {
            if !first && receiver.changed().await.is_err() {
                return None;
            }
            let tag = receiver.borrow_and_update().clone();
            let event = Event::default()
                .event("collector-update")
                .data(serde_json::json!({"version":tag}).to_string());
            Some((Ok::<_, Infallible>(event), (receiver, false)))
        },
    );
    let mut response = Sse::new(updates)
        .keep_alive(KeepAlive::new().interval(Duration::from_secs(15)))
        .into_response();
    response
        .headers_mut()
        .insert("x-accel-buffering", "no".parse().unwrap());
    response
}

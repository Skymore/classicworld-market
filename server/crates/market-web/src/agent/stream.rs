//! AI SDK UI message-stream events and OpenRouter SSE decoding.
use axum::http::StatusCode;
use eventsource_stream::Eventsource;
use futures_util::StreamExt;
use serde_json::{json, Value};
use std::{
    collections::BTreeMap,
    sync::{Arc, Mutex},
};
use tokio::sync::mpsc;

#[derive(Clone)]
pub struct Sink {
    pub sender: mpsc::Sender<Value>,
    pub partial: Arc<Mutex<String>>,
    pub metadata: Arc<Mutex<Value>>,
    pub text_id: String,
}
impl Sink {
    pub fn new(sender: mpsc::Sender<Value>, model: &str) -> Self {
        Self {
            sender,
            partial: Arc::default(),
            metadata: Arc::new(Mutex::new(
                json!({"model":model,"tool_calls":[],"sources":[]}),
            )),
            text_id: "answer".into(),
        }
    }
    pub async fn emit(&self, value: Value) {
        let _ = self.sender.send(value).await;
    }
    pub fn snapshot(&self) -> (String, Value) {
        (
            self.partial.lock().unwrap().clone(),
            self.metadata.lock().unwrap().clone(),
        )
    }
    pub async fn reset(&self) {
        self.partial.lock().unwrap().clear();
        self.emit(json!({"type":"reset-step"})).await;
    }
    async fn delta(&self, text: &str) {
        self.partial.lock().unwrap().push_str(text);
        self.emit(json!({"type":"text-delta","id":self.text_id,"delta":text}))
            .await;
    }
}

pub async fn read_model_stream(
    response: reqwest::Response,
    sink: &Sink,
) -> Result<Value, (StatusCode, &'static str)> {
    let mut events = Box::pin(response.bytes_stream().eventsource());
    let mut text = String::new();
    let mut emitted = 0;
    let mut started = false;
    let mut done = false;
    let mut calls: BTreeMap<u64, Value> = BTreeMap::new();
    let mut size = 0usize;
    while let Some(event) = events.next().await {
        let event = event.map_err(|_| (StatusCode::BAD_GATEWAY, "agent_stream_interrupted"))?;
        if event.data == "[DONE]" {
            done = true;
            break;
        }
        size += event.data.len();
        if size > 512 * 1024 {
            return Err((StatusCode::BAD_GATEWAY, "agent_invalid_response"));
        }
        let value: Value = serde_json::from_str(&event.data)
            .map_err(|_| (StatusCode::BAD_GATEWAY, "agent_invalid_response"))?;
        if value.get("error").is_some() {
            return Err((StatusCode::BAD_GATEWAY, "agent_provider_unavailable"));
        }
        if value["choices"][0]["finish_reason"] == "length" {
            return Err((StatusCode::BAD_GATEWAY, "agent_response_truncated"));
        }
        let delta = &value["choices"][0]["delta"];
        if let Some(chunk) = delta["content"].as_str() {
            text.push_str(chunk);
        }
        if text.len() > 128 * 1024 {
            return Err((StatusCode::BAD_GATEWAY, "agent_invalid_response"));
        }
        if let Some(parts) = delta["tool_calls"].as_array() {
            for part in parts {
                let index = part["index"]
                    .as_u64()
                    .filter(|v| *v < 32)
                    .ok_or((StatusCode::BAD_GATEWAY, "agent_invalid_response"))?;
                let call = calls.entry(index).or_insert_with(
                    || json!({"id":"","type":"function","function":{"name":"","arguments":""}}),
                );
                for (target, source) in [
                    ("/id", "/id"),
                    ("/function/name", "/function/name"),
                    ("/function/arguments", "/function/arguments"),
                ] {
                    if let Some(fragment) = part.pointer(source).and_then(Value::as_str) {
                        let previous = call.pointer(target).and_then(Value::as_str).unwrap_or("");
                        *call.pointer_mut(target).unwrap() = json!(format!("{previous}{fragment}"));
                    }
                }
            }
        }
        // Retain a small suffix so a tool-protocol marker split across chunks cannot leak.
        if calls.is_empty() && !super::provider::contains_tool_protocol(&text) {
            let end = text
                .char_indices()
                .rev()
                .nth(63)
                .map(|(i, _)| i)
                .unwrap_or(0);
            if end > emitted {
                if !started {
                    sink.emit(json!({"type":"text-start","id":sink.text_id}))
                        .await;
                    started = true;
                }
                sink.delta(&text[emitted..end]).await;
                emitted = end;
            }
        }
    }
    if !done {
        return Err((StatusCode::BAD_GATEWAY, "agent_stream_interrupted"));
    }
    if calls.is_empty() && !super::provider::contains_tool_protocol(&text) && !text.is_empty() {
        if !started {
            sink.emit(json!({"type":"text-start","id":sink.text_id}))
                .await;
            started = true;
        }
        if emitted < text.len() {
            sink.delta(&text[emitted..]).await;
        }
    }
    if started {
        sink.emit(json!({"type":"text-end","id":sink.text_id}))
            .await;
    }
    Ok(
        json!({"role":"assistant","content":if text.is_empty(){Value::Null}else{json!(text)},
        "tool_calls":if calls.is_empty(){Value::Null}else{json!(calls.into_values().collect::<Vec<_>>())}}),
    )
}

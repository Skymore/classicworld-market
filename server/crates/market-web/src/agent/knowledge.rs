//! Small, authored FAQ notes with provenance; lookup, not a new vector service.
use crate::{
    api::{reader, ClientAddr},
    AppState,
};
use axum::{
    extract::{Path, State},
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    Json,
};
use serde::Deserialize;
use serde_json::{json, Value};
use std::sync::OnceLock;

const TEXTS: &[(&str, &str)] = &[
    (
        "getting-started",
        include_str!("knowledge/getting-started.md"),
    ),
    (
        "job-advancement",
        include_str!("knowledge/job-advancement.md"),
    ),
    ("hunter-skills", include_str!("knowledge/hunter-skills.md")),
    ("training", include_str!("knowledge/training.md")),
    ("quest-help", include_str!("knowledge/quest-help.md")),
    ("trade-unlock", include_str!("knowledge/trade-unlock.md")),
    ("kerning-pq", include_str!("knowledge/kerning-pq.md")),
    ("crafting", include_str!("knowledge/crafting.md")),
    ("citizenship", include_str!("knowledge/citizenship.md")),
    ("housing", include_str!("knowledge/housing.md")),
    (
        "market-and-equipment",
        include_str!("knowledge/market-and-equipment.md"),
    ),
    ("launch-events", include_str!("knowledge/launch-events.md")),
];
fn docs() -> &'static Vec<Value> {
    static DOCS: OnceLock<Vec<Value>> = OnceLock::new();
    DOCS.get_or_init(|| {
        let mut raw: Value = serde_json::from_str(include_str!("knowledge/index.json"))
            .expect("validated guide index");
        raw["entries"]
            .as_array_mut()
            .unwrap()
            .iter_mut()
            .map(|row| {
                row["content"] = json!(
                    TEXTS
                        .iter()
                        .find(|(id, _)| row["id"] == *id)
                        .expect("guide text")
                        .1
                );
                row.clone()
            })
            .collect()
    })
}
fn fresh(row: &Value) -> Value {
    let mut row = row.clone();
    let age = (crate::unix_now() - row["checked_at"].as_f64().unwrap_or(0.)).max(0.);
    row["needs_refresh"] = json!(
        row["always_search_live"].as_bool().unwrap_or(false)
            || age > row["review_after_days"].as_f64().unwrap_or(1.) * 86400.
    );
    row
}
fn summary(row: &Value) -> Value {
    let mut r = fresh(row);
    r.as_object_mut().unwrap().remove("content");
    r
}
fn source_urls(row: &Value) -> Vec<Value> {
    row["sources"]
        .as_array()
        .unwrap()
        .iter()
        .filter_map(|s| s.get("url").cloned())
        .collect()
}
pub fn source_url(url: &str) -> bool {
    docs()
        .iter()
        .any(|r| source_urls(r).iter().any(|s| s.as_str() == Some(url)))
}

pub fn definitions() -> Vec<Value> {
    vec![
        json!({"type":"function","function":{"name":"search_guides","description":"Search the built-in Chinese Global Classic World FAQ notes first for common questions: first/second job, Hunter skills, leveling, quests, trade unlock, KPQ, crafting, citizenship, housing, events and market methods. Returns relevant full short notes plus dated sources. Empty query lists the index only. needs_refresh/always_search_live or a latest/current question requires search_web; notes are not automatically current.","strict":false,"parameters":{"type":"object","properties":{"query":{"type":"string","maxLength":160,"default":""}},"required":[],"additionalProperties":false}}}),
        json!({"type":"function","function":{"name":"get_guide","description":"Read one built-in FAQ document by guide_id from search_guides. Includes text, provenance, checked date and refresh requirements. These are authored summaries, not proof of live changes. Skill details still require get_skills; current market prices still require market tools.","strict":false,"parameters":{"type":"object","properties":{"guide_id":{"type":"string","maxLength":60}},"required":["guide_id"],"additionalProperties":false}}}),
    ]
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Search {
    #[serde(default)]
    query: String,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Read {
    guide_id: String,
}
pub enum Request {
    Search(String),
    Read(String),
}
pub fn parse(name: &str, args: Value) -> Result<Request, &'static str> {
    let bad = "invalid_tool_arguments";
    match name {
        "search_guides" => {
            let q: Search = serde_json::from_value(args).map_err(|_| bad)?;
            if q.query.chars().count() > 160 {
                return Err(bad);
            }
            Ok(Request::Search(q.query))
        }
        "get_guide" => {
            let q: Read = serde_json::from_value(args).map_err(|_| bad)?;
            if !TEXTS.iter().any(|(id, _)| q.guide_id == *id) {
                return Err(bad);
            }
            Ok(Request::Read(q.guide_id))
        }
        _ => Err("unknown_tool"),
    }
}
fn normalize(text: &str) -> String {
    text.chars()
        .filter(|c| c.is_alphanumeric())
        .flat_map(char::to_lowercase)
        .collect()
}
pub fn run(request: Request) -> Value {
    let selected = match request {
        Request::Read(id) => vec![fresh(docs().iter().find(|r| r["id"] == id).unwrap())],
        Request::Search(query) if query.trim().is_empty() => {
            return json!({"guides":docs().iter().map(summary).collect::<Vec<_>>(),"total":docs().len(),"generated_at":crate::unix_now(),"index_only":true})
        }
        Request::Search(query) => {
            let q = normalize(&query);
            let mut rows = docs()
                .iter()
                .filter_map(|r| {
                    let mut score = if normalize(r["title"].as_str().unwrap()).contains(&q) {
                        6
                    } else {
                        0
                    };
                    for tag in r["tags"]
                        .as_array()
                        .unwrap()
                        .iter()
                        .filter_map(Value::as_str)
                    {
                        let t = normalize(tag);
                        if q.contains(&t) || t.contains(&q) {
                            score += 3;
                        }
                    }
                    if score > 0 {
                        Some((score, r))
                    } else {
                        None
                    }
                })
                .collect::<Vec<_>>();
            rows.sort_by(|a, b| b.0.cmp(&a.0));
            rows.into_iter().take(3).map(|(_, r)| fresh(r)).collect()
        }
    };
    let urls = selected
        .iter()
        .flat_map(source_urls)
        .filter_map(|s| s.as_str().map(str::to_owned))
        .collect::<std::collections::BTreeSet<_>>();
    json!({"guides":selected,"source_urls":urls,"generated_at":crate::unix_now(),"limitations":"Built-in notes are dated authored summaries with source types. An official notice overrides stale community/client assumptions about availability. A checked date is not a publication date or live verification. Use live search for current changes, events, missing details, or needs_refresh=true. Do not turn community advice into official optimal builds."})
}

pub async fn index(
    State(state): State<AppState>,
    headers: HeaderMap,
    ClientAddr(addr): ClientAddr,
) -> Response {
    if let Err(response) = reader(&state, &headers, &addr, "agent-tools").await {
        return response;
    }
    (
        [("cache-control", "no-store")],
        Json(json!({"guides":docs().iter().map(summary).collect::<Vec<_>>(),"total":docs().len()})),
    )
        .into_response()
}
pub async fn detail(
    State(state): State<AppState>,
    headers: HeaderMap,
    ClientAddr(addr): ClientAddr,
    Path(id): Path<String>,
) -> Response {
    if let Err(response) = reader(&state, &headers, &addr, "agent-tools").await {
        return response;
    }
    match docs().iter().find(|r| r["id"] == id) {
        Some(row) => ([("cache-control", "no-store")], Json(fresh(row))).into_response(),
        None => super::error(StatusCode::NOT_FOUND, "guide_not_found"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn guide_lookup_distinguishes_live_events_and_job_rules() {
        let r = run(Request::Search("法师8级可以转职吗".into()));
        assert_eq!(r["guides"][0]["id"], "job-advancement");
        assert!(r["guides"][0]["content"]
            .as_str()
            .unwrap()
            .contains("10 级"));
        let r = run(Request::Read("launch-events".into()));
        assert_eq!(r["guides"][0]["needs_refresh"], true);
        assert_eq!(docs().len(), 12);
        assert!(docs()
            .iter()
            .all(|r| !r["content"].as_str().unwrap().is_empty()));
        assert!(parse("get_guide", json!({"guide_id":"../../secret"})).is_err());
    }
}

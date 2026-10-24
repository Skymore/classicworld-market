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
    ("build-roadmap", include_str!("knowledge/build-roadmap.md")),
    ("warrior-build", include_str!("knowledge/warrior-build.md")),
    (
        "magician-build",
        include_str!("knowledge/magician-build.md"),
    ),
    ("bowman-build", include_str!("knowledge/bowman-build.md")),
    ("thief-build", include_str!("knowledge/thief-build.md")),
    ("fighter-build", include_str!("knowledge/fighter-build.md")),
    ("page-build", include_str!("knowledge/page-build.md")),
    (
        "spearman-build",
        include_str!("knowledge/spearman-build.md"),
    ),
    (
        "ice-lightning-build",
        include_str!("knowledge/ice-lightning-build.md"),
    ),
    (
        "fire-poison-build",
        include_str!("knowledge/fire-poison-build.md"),
    ),
    ("cleric-build", include_str!("knowledge/cleric-build.md")),
    (
        "crossbowman-build",
        include_str!("knowledge/crossbowman-build.md"),
    ),
    (
        "assassin-build",
        include_str!("knowledge/assassin-build.md"),
    ),
    ("bandit-build", include_str!("knowledge/bandit-build.md")),
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
    r.as_object_mut().unwrap().remove("training_candidates");
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
        json!({"type":"function","function":{"name":"search_guides","description":"Search researched Chinese Global Classic World guides: all four 1st-job and ten 2nd-job builds, default/alternative SP orders with reasons, level 1-100 routes, and common quests/trade/KPQ/crafting/housing questions. Use a specific class plus topic, or 全职业加点 for the overview. Returns relevant full notes and dated primary sources. Empty query lists the index. needs_refresh/always_search_live or a latest/current question requires search_web.","strict":false,"parameters":{"type":"object","properties":{"query":{"type":"string","maxLength":160,"default":""}},"required":[],"additionalProperties":false}}}),
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
fn topic_match(query: &str, topic: &str) -> bool {
    if topic.is_ascii() {
        let words = |s: &str| {
            s.to_lowercase()
                .split(|c: char| !c.is_alphanumeric())
                .filter(|s| !s.is_empty())
                .map(str::to_owned)
                .collect::<Vec<_>>()
        };
        let q = words(query);
        let t = words(topic);
        !t.is_empty() && q.windows(t.len()).any(|w| w == t)
    } else {
        normalize(query).contains(&normalize(topic))
    }
}
pub fn run(request: Request) -> Value {
    let selected = match request {
        Request::Read(id) => vec![fresh(docs().iter().find(|r| r["id"] == id).unwrap())],
        Request::Search(query) if normalize(&query).is_empty() => {
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
                        if topic_match(&query, tag) || (!tag.is_ascii() && t.contains(&q)) {
                            score += 3;
                        }
                    }
                    // The displayed guide is Chinese, while the original client
                    // terms remain searchable through hidden index aliases.
                    if r["original_terms"].as_array().is_some_and(|terms| {
                        terms.iter().filter_map(Value::as_str).any(|term| {
                            term.len() >= 5 && topic_match(&query, term)
                        })
                    }) {
                        score += 8;
                    }
                    if r["subjects"].as_array().is_some_and(|subjects| {
                        subjects
                            .iter()
                            .filter_map(Value::as_str)
                            .any(|t| topic_match(&query, t))
                    }) {
                        score += 40;
                    }
                    // Resolve a rule question before a generic class build, and give
                    // broad overviews a single useful entry rather than random jobs.
                    if r["id"] == "job-advancement"
                        && ["转职", "job advancement"]
                            .iter()
                            .any(|t| topic_match(&query, t))
                    {
                        score += 80;
                    }
                    if r["id"] == "build-roadmap"
                        && ["全职业", "所有职业", "all classes"]
                            .iter()
                            .any(|t| topic_match(&query, t))
                    {
                        score += 80;
                    }
                    if score > 0 {
                        Some((score, r))
                    } else {
                        None
                    }
                })
                .collect::<Vec<_>>();
            rows.sort_by(|a, b| b.0.cmp(&a.0));
            // A resolved topic should not bring in unrelated classes merely
            // because all their documents contain a generic tag such as 加点.
            let specific = rows.first().is_some_and(|(score, _)| *score >= 40);
            rows.into_iter()
                .filter(|(score, _)| !specific || *score >= 40)
                .take(3)
                .map(|(_, r)| fresh(r))
                .collect()
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
        assert_eq!(docs().len(), 26);
        assert!(docs()
            .iter()
            .all(|r| !r["content"].as_str().unwrap().is_empty()));
        assert!(parse("get_guide", json!({"guide_id":"../../secret"})).is_err());
    }
    #[test]
    fn class_questions_find_their_own_researched_build() {
        for (query, id) in [
            ("牧师单练加点", "cleric-build"),
            ("冰雷加点", "ice-lightning-build"),
            ("弩手加点", "crossbowman-build"),
            ("全职业加点", "build-roadmap"),
            ("30级升级路线", "training"),
            ("Assassin skill build", "assassin-build"),
        ] {
            assert_eq!(
                run(Request::Search(query.into()))["guides"][0]["id"],
                id,
                "{query}"
            );
        }
        assert!(!topic_match("webpage", "Page"));
        assert_eq!(
            run(Request::Search("牧师 Cleric 二转 单练 默认加点".into()))["guides"]
                .as_array()
                .unwrap()
                .len(),
            1
        );
        assert_eq!(run(Request::Search("???".into()))["index_only"], true);
    }
    #[test]
    fn published_build_orders_have_feasible_budgets_and_prerequisites() {
        let plans: Value =
            serde_json::from_str(include_str!("knowledge/build-plans.json")).unwrap();
        let data: Value = serde_json::from_str(include_str!("adventure-data.json")).unwrap();
        assert_eq!(plans.as_object().unwrap().len(), 17);
        for (id, plan) in plans.as_object().unwrap() {
            let mut ranks = std::collections::BTreeMap::<&str, u64>::new();
            let mut used = 0;
            for step in plan["steps"].as_array().unwrap() {
                let name = step["skill"].as_str().unwrap();
                let skill = data["skill"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .find(|s| s["class_name"] == plan["class_name"] && s["name"] == name)
                    .unwrap();
                let target = step["rank"].as_u64().unwrap();
                let previous = ranks.get(name).copied().unwrap_or(0);
                assert!(
                    target > previous && target <= skill["max_level"].as_u64().unwrap(),
                    "{id}: {name}"
                );
                if let Some(required) = skill["required_skill"].as_str().filter(|s| !s.is_empty()) {
                    let (dependency, rank) = required.rsplit_once(" Lv.").unwrap();
                    assert!(
                        ranks.get(dependency).copied().unwrap_or(0) >= rank.parse::<u64>().unwrap(),
                        "{id}: {name} requires {required}"
                    );
                }
                used += target - previous;
                ranks.insert(name, target);
                assert_eq!(step["total_sp"], used);
            }
            let budget = 1 + 3
                * (plan["target_level"].as_u64().unwrap()
                    - plan["job_start_level"].as_u64().unwrap());
            assert_eq!(used + plan["unspent_sp"].as_u64().unwrap(), budget, "{id}");
        }
    }
}

//! Korean. The interface strings live in `ko.json`, keyed by the Chinese text
//! the pages already pass (`lang.t("中文", "English")`, the React site's
//! `words("中文", "English")`); `tools/i18n/ko-strings.mjs --check` lists any
//! Chinese string without a Korean entry. Game names come from the Classic
//! World client's Korean language pack (`ko-game.json`, exported by
//! `tools/export_korean_strings.cs`): items by id, everything else by its
//! English name. At startup the catalogue's Chinese and English names are
//! joined to them (`load_names`), so a page or the browser can turn either
//! name into Korean. Anything without Korean falls back to English.

use std::collections::HashMap;
use std::sync::{LazyLock, OnceLock};

use axum::{
    extract::State,
    http::{header, HeaderMap, HeaderValue},
    response::{IntoResponse, Response},
};
use serde::Deserialize;
use sqlx::PgPool;

use crate::AppState;

/// Chinese interface text -> Korean.
static UI: LazyLock<HashMap<String, String>> = LazyLock::new(|| {
    serde_json::from_str(include_str!("ko.json")).expect("i18n/ko.json is valid")
});

#[derive(Deserialize)]
struct Game {
    items: HashMap<i32, String>,
    item_desc: HashMap<i32, String>,
    names: HashMap<String, String>,
}

static GAME: LazyLock<Game> = LazyLock::new(|| {
    serde_json::from_str(include_str!("ko-game.json")).expect("i18n/ko-game.json is valid")
});

/// Catalogue names (Chinese and English) -> Korean, filled once by `load_names`.
#[derive(Default)]
pub struct Names {
    pub zh: HashMap<String, String>,
    pub en: HashMap<String, String>,
}

static NAMES: OnceLock<Names> = OnceLock::new();
/// The same, as the JSON `/api/v1/i18n/ko` serves.
static NAMES_JSON: OnceLock<String> = OnceLock::new();

/// The interface string's Korean, if the dictionary has it.
pub fn ui(zh: &str) -> Option<&'static str> {
    UI.get(zh).map(String::as_str)
}

/// Korean for a two-language string: the interface dictionary, then the game
/// names (by Chinese, then English). None: the caller shows English.
pub fn text(zh: &str, en: &str) -> Option<&'static str> {
    if let Some(ko) = ui(zh) {
        return Some(ko);
    }
    if let Some(names) = NAMES.get() {
        if let Some(ko) = names.zh.get(zh).or_else(|| names.en.get(en)) {
            return Some(ko.as_str());
        }
    }
    GAME.names.get(en).map(String::as_str)
}

/// An item's Korean name from the client, by id.
pub fn item_name(id: i32) -> Option<&'static str> {
    GAME.items.get(&id).map(String::as_str)
}

/// An item's Korean description from the client (`\n` line breaks, `#c…#` colour).
pub fn item_desc(id: i32) -> Option<&'static str> {
    GAME.item_desc.get(&id).map(String::as_str)
}

/// A game name's Korean by its English name (monsters, maps, NPCs, skills, items).
pub fn name_by_en(en: &str) -> Option<&'static str> {
    GAME.names.get(en).map(String::as_str)
}

/// Chinese and English names whose Korean contains `query` (spaces ignored),
/// at most `limit`: lets a Korean search match the stored names.
pub fn names_containing(query: &str, limit: usize) -> Vec<String> {
    let query: String = query.split_whitespace().collect();
    if query.is_empty() {
        return Vec::new();
    }
    let hit = |ko: &str| ko.split_whitespace().collect::<String>().contains(&query);
    let mut out = Vec::new();
    let mut push = |name: &str| {
        if out.len() < limit && !out.iter().any(|n: &String| n == name) {
            out.push(name.to_string());
        }
    };
    if let Some(names) = NAMES.get() {
        for (name, ko) in names.zh.iter().chain(names.en.iter()) {
            if hit(ko) {
                push(name);
            }
        }
    }
    for (en, ko) in GAME.names.iter() {
        if hit(ko) {
            push(en);
        }
    }
    out
}

fn add(names: &mut Names, zh: Option<String>, en: Option<String>, ko: &str) {
    if let Some(zh) = zh.filter(|s| !s.is_empty()) {
        names.zh.entry(zh).or_insert_with(|| ko.to_string());
    }
    if let Some(en) = en.filter(|s| !s.is_empty()) {
        names.en.entry(en).or_insert_with(|| ko.to_string());
    }
}

/// Joins the catalogue's names to the Korean ones. Runs once at startup; a
/// failed query leaves the English-name fallback in place.
pub async fn load_names(db: &PgPool) {
    if NAMES.get().is_some() {
        return;
    }
    let mut names = Names::default();
    let rows: Vec<(i32, Option<String>, Option<String>)> =
        sqlx::query_as("SELECT id, name_zh, name_en FROM items")
            .fetch_all(db)
            .await
            .unwrap_or_default();
    for (id, zh, en) in rows {
        let ko = item_name(id).or_else(|| en.as_deref().and_then(name_by_en));
        if let Some(ko) = ko {
            add(&mut names, zh, en, ko);
        }
    }
    for sql in [
        "SELECT name_zh, name_en FROM mobs",
        "SELECT name_zh, name_en FROM maps",
        "SELECT street_zh, street_en FROM maps",
        "SELECT name_zh, name_en FROM npcs",
    ] {
        let rows: Vec<(Option<String>, Option<String>)> =
            sqlx::query_as(sql).fetch_all(db).await.unwrap_or_default();
        for (zh, en) in rows {
            if let Some(ko) = en.as_deref().and_then(name_by_en) {
                add(&mut names, zh, en, ko);
            }
        }
    }
    let json = serde_json::json!({ "zh": names.zh, "en": names.en }).to_string();
    let _ = NAMES.set(names);
    let _ = NAMES_JSON.set(json);
}

/// `/api/v1/i18n/ko`: the game names for the browser, `{zh: {..}, en: {..}}`.
/// Loaded only by Korean visitors; the asset revision in the URL busts caches.
pub async fn names_api(State(state): State<AppState>) -> Response {
    load_names(&state.db).await;
    let body = NAMES_JSON.get().cloned().unwrap_or_else(|| r#"{"zh":{},"en":{}}"#.into());
    let mut response = ([(header::CONTENT_TYPE, "application/json")], body).into_response();
    response.headers_mut().insert(
        header::CACHE_CONTROL,
        HeaderValue::from_static("public, max-age=3600, s-maxage=3600"),
    );
    response
}

/// `/api/v1/i18n/ko-ui`: the interface dictionary for the collector window,
/// which has no bundler access to the server crate.
pub async fn ui_api() -> Response {
    let mut response = (
        [(header::CONTENT_TYPE, "application/json")],
        include_str!("ko.json"),
    )
        .into_response();
    response.headers_mut().insert(
        header::CACHE_CONTROL,
        HeaderValue::from_static("public, max-age=3600, s-maxage=3600"),
    );
    response
}

/// The page language for a visitor whose browser states none: its
/// `Accept-Language`, else the country Cloudflare saw (`CF-IPCountry`):
/// Korea -> ko, Chinese-speaking regions -> zh, elsewhere en.
pub fn guess(headers: &HeaderMap) -> &'static str {
    let accept = headers
        .get(header::ACCEPT_LANGUAGE)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("");
    for tag in accept.split(',') {
        let code = tag.split(';').next().unwrap_or("").trim().to_ascii_lowercase();
        if code.starts_with("zh") {
            return "zh";
        }
        if code.starts_with("ko") {
            return "ko";
        }
        if code.starts_with("en") {
            return "en";
        }
    }
    let country = headers
        .get("cf-ipcountry")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("");
    match country {
        "KR" | "KP" => "ko",
        "CN" | "TW" | "HK" | "MO" | "SG" => "zh",
        "" | "XX" | "T1" => "zh",
        _ => "en",
    }
}

/// `/api/v1/i18n/guess`: `{"lang": "zh" | "en" | "ko"}` from `guess`. Per
/// visitor, so never cached.
pub async fn guess_api(headers: HeaderMap) -> Response {
    let mut response = axum::Json(serde_json::json!({ "lang": guess(&headers) })).into_response();
    response
        .headers_mut()
        .insert(header::CACHE_CONTROL, HeaderValue::from_static("private, no-store"));
    response
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn client_names_load() {
        assert_eq!(item_name(2000000), Some("빨간 포션"));
        assert_eq!(name_by_en("Henesys"), Some("헤네시스"));
        assert_eq!(name_by_en("Snail"), Some("달팽이"));
        assert!(item_desc(2000000).is_some_and(|d| d.contains("HP")));
    }

    #[test]
    fn guesses_by_header_then_country() {
        let mut h = HeaderMap::new();
        h.insert("cf-ipcountry", HeaderValue::from_static("KR"));
        assert_eq!(guess(&h), "ko");
        h.insert("cf-ipcountry", HeaderValue::from_static("US"));
        assert_eq!(guess(&h), "en");
        h.insert(header::ACCEPT_LANGUAGE, HeaderValue::from_static("ko-KR,ko;q=0.9"));
        assert_eq!(guess(&h), "ko");
        h.insert(header::ACCEPT_LANGUAGE, HeaderValue::from_static("fr-FR, zh-CN;q=0.5"));
        assert_eq!(guess(&h), "zh");
    }

    #[test]
    fn dictionary_is_korean() {
        assert!(!UI.is_empty());
        for (zh, ko) in UI.iter() {
            assert!(!ko.trim().is_empty(), "empty Korean for {zh:?}");
            // Placeholders survive translation.
            for n in 0..6 {
                let p = format!("{{{n}}}");
                assert_eq!(zh.contains(&p), ko.contains(&p), "placeholder {p} in {zh:?} -> {ko:?}");
            }
        }
    }
}

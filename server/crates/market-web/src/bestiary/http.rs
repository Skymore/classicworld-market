//! Routes for the bestiary pages. Pages are public and anonymous by design
//! (a game database); they carry edge-cache headers, search does not.

use axum::{
    extract::{Path, Query, State},
    http::{header, HeaderValue, StatusCode},
    response::{IntoResponse, Response},
    routing::get,
    Router,
};
use maud::Markup;
use serde::Deserialize;

use super::assets::CSS;
use super::dex_api;
use super::model::{RouteEnd, RouteOutcome, RoutePage, Step};
use super::pages;
use super::queries::{self, Resolution};
use super::route::Graph;
use crate::AppState;

// Page context: language, device hint, render time.
use std::convert::Infallible;

use axum::{extract::FromRequestParts, http::request::Parts};
use sqlx::types::chrono::Utc;

use super::format::Lang;
use super::model::SearchKind;
use super::pages::{Ctx, Device};
use crate::unix_now;

/// Bestiary data only changes on import, which purges the edge cache.
pub const EDGE_CACHE: &str = "public, s-maxage=86400";
/// The item page carries market numbers; `item.js` refreshes them anyway.
pub const ITEM_CACHE: &str = "public, max-age=0, s-maxage=60";
/// Mob pages show typical prices next to their drops.
pub const MOB_CACHE: &str = "public, s-maxage=600";
const NOT_FOUND_CACHE: &str = "public, s-maxage=600";
const NO_STORE: &str = "no-store";
/// Scripts and fetches only from this origin; no inline styles (sizes are
/// classes), images from the item and mob CDNs.
const CSP: &str = crate::web::CSP;
const MAX_QUERY_CHARS: usize = 64;

pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/api/v1/catalog/page", get(catalog_page))
        .route("/item/{id}", get(item))
        .route("/mob/{id}", get(mob))
        .route("/map/{id}", get(map))
        .route("/route", get(route))
        .route("/search", get(search))
        .route("/static/bestiary.css", get(css))
        .route("/api/v1/dex/dropped-items", get(dex_api::dropped_items))
        .route("/api/v1/dex/counts", get(dex_api::counts))
        .route(
            "/api/v1/market/period-default",
            get(dex_api::period_default),
        )
}

fn html(status: StatusCode, cache: &'static str, markup: Markup) -> Response {
    (
        status,
        [
            (
                header::CONTENT_TYPE,
                HeaderValue::from_static("text/html; charset=utf-8"),
            ),
            (header::CACHE_CONTROL, HeaderValue::from_static(cache)),
            (
                header::CONTENT_SECURITY_POLICY,
                HeaderValue::from_static(CSP),
            ),
            // The first paint's layout follows the hint (see `Device`).
            (header::VARY, HeaderValue::from_static("Sec-CH-UA-Mobile")),
        ],
        markup.into_string(),
    )
        .into_response()
}

/// Language from `?lang=`, layout hint from `Sec-CH-UA-Mobile`, and this
/// page's own URL for the language switch.
pub struct PageCtx(pub Ctx);

impl<S: Send + Sync> FromRequestParts<S> for PageCtx {
    type Rejection = Infallible;

    async fn from_request_parts(parts: &mut Parts, _: &S) -> Result<Self, Self::Rejection> {
        let mut lang = Lang::Zh;
        let mut kept: Vec<&str> = Vec::new();
        for pair in parts.uri.query().unwrap_or("").split('&') {
            match pair.split_once('=').map_or(pair, |(k, _)| k) {
                "" | "part" => {}
                "lang" => lang = Lang::parse(pair.split_once('=').map(|(_, v)| v)),
                _ => kept.push(pair),
            }
        }
        let mut here = parts.uri.path().to_string();
        if !kept.is_empty() {
            here = format!("{here}?{}", kept.join("&"));
        }
        let hint = parts
            .headers
            .get("sec-ch-ua-mobile")
            .and_then(|v| v.to_str().ok());
        Ok(Self(Ctx {
            lang,
            device: Device::from_mobile_hint(hint),
            here,
            now: Utc::now(),
        }))
    }
}

/// What a missing page was, in both languages.
type What = (&'static str, &'static str);
const ITEM: What = ("物品", "item");
const MOB: What = ("怪物", "monster");
const MAP: What = ("地图", "map");

fn not_found(what: What, ctx: &Ctx) -> Response {
    html(
        StatusCode::NOT_FOUND,
        NOT_FOUND_CACHE,
        pages::not_found_page(what.0, what.1, ctx),
    )
}

fn server_error(err: sqlx::Error, ctx: &Ctx) -> Response {
    tracing::error!(error = %err, "bestiary query failed");
    html(
        StatusCode::INTERNAL_SERVER_ERROR,
        NO_STORE,
        pages::error_page(ctx),
    )
}

/// Game ids are positive integers; anything else is a 404, not a 400.
fn parse_id(raw: &str) -> Option<i32> {
    if raw.is_empty() || !raw.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    raw.parse().ok()
}

/// Shared shape of the detail pages.
fn detail<T>(
    found: sqlx::Result<Option<T>>,
    ctx: &Ctx,
    what: What,
    cache: &'static str,
    render: fn(&T, &Ctx) -> Markup,
) -> Response {
    match found {
        Ok(Some(page)) => html(StatusCode::OK, cache, render(&page, ctx)),
        Ok(None) => not_found(what, ctx),
        Err(err) => server_error(err, ctx),
    }
}

#[derive(Deserialize)]
struct ItemParams {
    /// `market`: only the market sections, for `item.js` after a poll.
    #[serde(default)]
    part: String,
    #[serde(default)]
    hours: String,
    variant: Option<i64>,
    #[serde(default)]
    attributes: String,
    #[serde(default)]
    equipment: String,
}

impl ItemParams {
    fn selection(&self) -> Option<queries::ItemSelection> {
        let attributes: Vec<(String, i64)> = if self.attributes.is_empty() {
            vec![]
        } else {
            serde_json::from_str(&self.attributes).ok()?
        };
        let allowed = [
            "weapon_attack",
            "magic_attack",
            "str",
            "dex",
            "int",
            "luk",
            "hp",
            "mp",
            "accuracy",
            "avoid",
            "speed",
            "jump",
            "weapon_defense",
            "magic_defense",
        ];
        if attributes.len() > allowed.len()
            || attributes
                .iter()
                .any(|(key, min)| !allowed.contains(&key.as_str()) || !(0..=65535).contains(min))
            || self.variant.is_some_and(|id| id <= 0)
            || !["", "all", "captured", "missing", "bonus"].contains(&self.equipment.as_str())
        {
            return None;
        }
        Some(queries::ItemSelection {
            variant: self.variant,
            attributes,
            equipment: self.equipment.clone(),
        })
    }
}

async fn item(
    State(state): State<AppState>,
    Path(raw): Path<String>,
    PageCtx(ctx): PageCtx,
    Query(params): Query<ItemParams>,
) -> Response {
    let Some(id) = parse_id(&raw) else {
        return not_found(ITEM, &ctx);
    };
    let Some(selection) = params.selection() else {
        return html(StatusCode::BAD_REQUEST, NO_STORE, pages::error_page(&ctx));
    };
    let found =
        queries::item_page_selected(&state.db, id, unix_now(), params.hours == "all", &selection)
            .await;
    if params.part == "market" {
        return detail(found, &ctx, ITEM, NO_STORE, pages::item_market_fragment);
    }
    if params.part == "preview" {
        return detail(found, &ctx, ITEM, NO_STORE, pages::item_preview);
    }
    detail(found, &ctx, ITEM, ITEM_CACHE, pages::item_page)
}

async fn mob(
    State(state): State<AppState>,
    Path(raw): Path<String>,
    PageCtx(ctx): PageCtx,
) -> Response {
    let Some(id) = parse_id(&raw) else {
        return not_found(MOB, &ctx);
    };
    detail(
        queries::mob_page(&state.db, id).await,
        &ctx,
        MOB,
        MOB_CACHE,
        pages::mob_page,
    )
}

async fn map(
    State(state): State<AppState>,
    Path(raw): Path<String>,
    PageCtx(ctx): PageCtx,
) -> Response {
    let Some(id) = parse_id(&raw) else {
        return not_found(MAP, &ctx);
    };
    detail(
        queries::map_page(&state.db, id).await,
        &ctx,
        MAP,
        EDGE_CACHE,
        pages::map_page,
    )
}

#[derive(Deserialize)]
struct RouteParams {
    #[serde(default)]
    from: String,
    #[serde(default)]
    to: String,
}

async fn route(
    State(state): State<AppState>,
    PageCtx(ctx): PageCtx,
    Query(params): Query<RouteParams>,
) -> Response {
    let from = clip(&params.from);
    let to = clip(&params.to);
    match route_page(&state, from, to).await {
        Ok(page) => html(StatusCode::OK, EDGE_CACHE, pages::route_page(&page, &ctx)),
        Err(err) => server_error(err, &ctx),
    }
}

async fn route_page(state: &AppState, from_input: &str, to_input: &str) -> sqlx::Result<RoutePage> {
    let edges = queries::load_edges(&state.db).await?;
    let mut page = RoutePage {
        from_input: from_input.to_string(),
        to_input: to_input.to_string(),
        known_edges: edges.len(),
        outcome: RouteOutcome::Form,
    };
    if from_input.is_empty() && to_input.is_empty() {
        return Ok(page);
    }
    let from = match resolve(state, from_input, RouteEnd::From).await? {
        Ok(map) => map,
        Err(outcome) => {
            page.outcome = outcome;
            return Ok(page);
        }
    };
    let to = match resolve(state, to_input, RouteEnd::To).await? {
        Ok(map) => map,
        Err(outcome) => {
            page.outcome = outcome;
            return Ok(page);
        }
    };
    if from.id == to.id {
        page.outcome = RouteOutcome::Same(from);
        return Ok(page);
    }
    let graph = Graph::new(edges);
    page.outcome = match graph.shortest_path(from.id, to.id) {
        None => RouteOutcome::NoPath { from, to },
        Some(path) => {
            let mut ids: Vec<i32> = path.iter().flat_map(|e| [e.from, e.to]).collect();
            ids.sort_unstable();
            ids.dedup();
            let names = queries::map_refs(&state.db, &ids).await?;
            let steps = path
                .iter()
                .map(|e| Step {
                    from: names[&e.from].clone(),
                    to: names[&e.to].clone(),
                    kind: e.kind,
                    portal_name: e.portal_name.clone(),
                })
                .collect();
            RouteOutcome::Found { from, to, steps }
        }
    };
    Ok(page)
}

/// `Ok(map)` or the outcome to show instead.
async fn resolve(
    state: &AppState,
    input: &str,
    end: RouteEnd,
) -> sqlx::Result<Result<super::model::MapRef, RouteOutcome>> {
    if input.is_empty() {
        return Ok(Err(RouteOutcome::Unresolved {
            end,
            query: String::new(),
            candidates: Vec::new(),
        }));
    }
    Ok(match queries::resolve_map(&state.db, input).await? {
        Resolution::One(map) => Ok(map),
        Resolution::Many(candidates) => Err(RouteOutcome::Unresolved {
            end,
            query: input.to_string(),
            candidates,
        }),
    })
}

#[derive(Deserialize)]
struct SearchParams {
    #[serde(default)]
    region: String,
    #[serde(default)]
    area: String,
    #[serde(default)]
    cat: String,
    #[serde(default)]
    job: String,
    #[serde(default)]
    min_level: String,
    #[serde(default)]
    max_level: String,
    #[serde(default)]
    q: String,
    /// `item`, `mob` or `map`; anything else searches all three.
    #[serde(default)]
    kind: String,
    #[serde(default)]
    page: u32,
}

// Browsing selects one catalogue; a nonempty query always searches all three.
fn search_kind(query: &str, requested: &str) -> Option<SearchKind> {
    if query.is_empty() {
        Some(SearchKind::parse(requested).unwrap_or(SearchKind::Item))
    } else {
        None
    }
}

async fn search(
    State(state): State<AppState>,
    PageCtx(ctx): PageCtx,
    Query(params): Query<SearchParams>,
) -> Response {
    let q = clip(&params.q);
    let kind = search_kind(q, &params.kind);
    let limit = if kind.is_some() {
        queries::SEARCH_KIND_LIMIT
    } else {
        queries::SEARCH_LIMIT
    };
    let offset = i64::from(params.page.saturating_sub(1).min(10000)) * limit;
    let mut filters = super::model::ItemFilters {
        cat: params.cat,
        job: params.job.parse().unwrap_or(0),
        min_level: params.min_level.parse().ok(),
        max_level: params.max_level.parse().ok(),
    };
    filters.normalize();
    let page = queries::search_places(
        &state.db,
        q,
        kind,
        offset,
        filters,
        &params.region,
        &params.area,
    )
    .await;
    match page {
        Ok(page) => html(StatusCode::OK, NO_STORE, pages::search_page(&page, &ctx)),
        Err(err) => server_error(err, &ctx),
    }
}

/// Trimmed and capped, so a long query string costs nothing.
fn clip(text: &str) -> &str {
    let text = text.trim();
    match text.char_indices().nth(MAX_QUERY_CHARS) {
        Some((end, _)) => &text[..end],
        None => text,
    }
}

/// The R3 stylesheet URL, kept so cached old pages do not 404; styles now
/// live in `web/css/`.
async fn css() -> impl IntoResponse {
    (
        [
            (header::CONTENT_TYPE, "text/css; charset=utf-8"),
            (
                header::CACHE_CONTROL,
                "public, max-age=86400, s-maxage=86400",
            ),
        ],
        CSS,
    )
}

#[derive(Deserialize)]
struct CatalogRequest {
    url: String,
    #[serde(default)]
    preview: bool,
}

// Separate JSON URL keeps CDN HTML caches and public page data independent.
// React uses the same query functions and normalization as the indexed pages.
async fn catalog_page(
    State(state): State<AppState>,
    Query(request): Query<CatalogRequest>,
) -> Response {
    use axum::{http::Uri, Json};
    use serde_json::json;
    fn response(status: StatusCode, value: serde_json::Value) -> Response {
        (status, [(header::CACHE_CONTROL, NO_STORE)], Json(value)).into_response()
    }
    fn loaded<T: serde::Serialize>(result: sqlx::Result<Option<T>>, kind: &str) -> Response {
        #[derive(serde::Serialize)]
        struct Snapshot<'a, T> { kind: &'a str, page: T }
        match result {
            // Serialize the envelope directly. json! would first copy the full
            // cached history into another Value tree on every cache hit.
            Ok(Some(page)) => (StatusCode::OK, [(header::CACHE_CONTROL, NO_STORE)],
                Json(Snapshot { kind, page })).into_response(),
            Ok(None) => response(StatusCode::NOT_FOUND, json!({"error":"not_found"})),
            Err(error) => {
                tracing::error!(%error,"catalog snapshot failed");
                response(
                    StatusCode::INTERNAL_SERVER_ERROR,
                    json!({"error":"unavailable"}),
                )
            }
        }
    }
    if request.url.len() > 4096 || !request.url.starts_with('/') || request.url.starts_with("//") {
        return response(StatusCode::BAD_REQUEST, json!({"error":"invalid_url"}));
    }
    let Ok(uri) = request.url.parse::<Uri>() else {
        return response(StatusCode::BAD_REQUEST, json!({"error":"invalid_url"}));
    };
    let path = uri.path();
    if path == "/search" {
        let Ok(Query(params)) = Query::<SearchParams>::try_from_uri(&uri) else {
            return response(StatusCode::BAD_REQUEST, json!({"error":"invalid_query"}));
        };
        let q = clip(&params.q);
        let kind = search_kind(q, &params.kind);
        let limit = if kind.is_some() {
            queries::SEARCH_KIND_LIMIT
        } else {
            queries::SEARCH_LIMIT
        };
        let offset = i64::from(params.page.saturating_sub(1).min(10000)) * limit;
        let mut filters = super::model::ItemFilters {
            cat: params.cat,
            job: params.job.parse().unwrap_or(0),
            min_level: params.min_level.parse().ok(),
            max_level: params.max_level.parse().ok(),
        };
        filters.normalize();
        return loaded(
            queries::search_places(
                &state.db,
                q,
                kind,
                offset,
                filters,
                &params.region,
                &params.area,
            )
            .await
            .map(Some),
            "search",
        );
    }
    if path == "/route" {
        let Ok(Query(params)) = Query::<RouteParams>::try_from_uri(&uri) else {
            return response(StatusCode::BAD_REQUEST, json!({"error":"invalid_query"}));
        };
        return loaded(
            route_page(&state, clip(&params.from), clip(&params.to))
                .await
                .map(Some),
            "route",
        );
    }
    let Some((kind, raw)) = path.trim_start_matches('/').split_once('/') else {
        return response(StatusCode::NOT_FOUND, json!({"error":"not_found"}));
    };
    let Some(id) = parse_id(raw) else {
        return response(StatusCode::NOT_FOUND, json!({"error":"not_found"}));
    };
    match kind {
        "item" => {
            let Ok(Query(params)) = Query::<ItemParams>::try_from_uri(&uri) else {
                return response(StatusCode::BAD_REQUEST, json!({"error":"invalid_query"}));
            };
            loaded(
                {
                    let Some(selection) = params.selection() else {
                        return response(StatusCode::BAD_REQUEST, json!({"error":"invalid_query"}));
                    };
                    if request.preview {
                        if selection.variant.is_some() || !selection.attributes.is_empty()
                            || !selection.equipment.is_empty() {
                            return response(StatusCode::BAD_REQUEST, json!({"error":"invalid_query"}));
                        }
                        return loaded(queries::item_preview(&state.db, id, params.hours == "all").await, "item_preview");
                    }
                    let key = format!("item:{id}:{}:{:?}:{:?}:{}", params.hours == "all",
                        selection.variant, selection.attributes, selection.equipment);
                    state.public_reads.get_items(&state.db, &key, &[id], async {
                    queries::item_page_selected(
                        &state.db,
                        id,
                        unix_now(),
                        params.hours == "all",
                        &selection,
                    )
                    .await
                    .map(|page| {
                        page.map(|page| {
                            let unit = crate::external::unit(page.item.id);
                            let mut value =
                                serde_json::to_value(page).expect("catalog item serialize");
                            value["unit"] = json!(unit);
                            value
                        })
                    })
                    }).await
                },
                "item",
            )
        }
        "mob" => loaded(queries::mob_page(&state.db, id).await, "mob"),
        "map" => loaded(queries::map_page(&state.db, id).await, "map"),
        _ => response(StatusCode::NOT_FOUND, json!({"error":"not_found"})),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn search_crosses_catalogues_only_when_typing() {
        assert_eq!(search_kind("", ""), Some(SearchKind::Item));
        assert_eq!(search_kind("", "mob"), Some(SearchKind::Mob));
        assert_eq!(search_kind("", "map"), Some(SearchKind::Map));
        for kind in ["", "item", "mob", "map"] {
            assert_eq!(search_kind("蜗牛", kind), None);
        }
    }

    #[test]
    fn ids_and_clipping() {
        assert_eq!(parse_id("10001000"), Some(10001000));
        assert_eq!(parse_id("-1"), None);
        assert_eq!(parse_id("1e3"), None);
        assert_eq!(parse_id("99999999999"), None);
        assert_eq!(clip("  射手村  "), "射手村");
        assert_eq!(clip(&"字".repeat(100)).chars().count(), MAX_QUERY_CHARS);
    }

    async fn ctx_of(uri: &str, mobile: Option<&str>) -> Ctx {
        let mut req = axum::http::Request::get(uri);
        if let Some(m) = mobile {
            req = req.header("sec-ch-ua-mobile", m);
        }
        let (mut parts, _) = req.body(()).unwrap().into_parts();
        PageCtx::from_request_parts(&mut parts, &())
            .await
            .unwrap()
            .0
    }

    #[tokio::test]
    async fn page_context_from_the_request() {
        let ctx = ctx_of("/route?from=1&lang=en&to=2", Some("?0")).await;
        assert_eq!(ctx.lang, Lang::En);
        assert_eq!(ctx.device, Device::Desktop);
        assert_eq!(ctx.here, "/route?from=1&to=2");
        let ctx = ctx_of("/item/4?part=market", None).await;
        assert_eq!((ctx.lang, ctx.device), (Lang::Zh, Device::Phone));
        assert_eq!(ctx.here, "/item/4");
    }
}

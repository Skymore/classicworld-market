//! Routes for the bestiary pages. Pages are public and anonymous by design
//! (a game database); they carry edge-cache headers, search does not.

use axum::{
    extract::{Path, Query, State},
    http::{header, HeaderMap, HeaderValue, StatusCode},
    response::{IntoResponse, Response},
    routing::get,
    Router,
};
use maud::Markup;
use serde::Deserialize;

use super::assets::CSS;
use super::dex_api;
use super::model::{MobPlace, RouteEnd, RouteOutcome, RouteOverview, RoutePage, Step};
use super::pages;
use super::queries::{self, Resolution};
use super::route::{transport_npc, EdgeKind, Graph, HENESYS};
use crate::AppState;

// Page context: language and render time.
use std::convert::Infallible;

use axum::{extract::FromRequestParts, http::request::Parts};
use sqlx::types::chrono::Utc;

use super::format::Lang;
use super::model::{ItemFilters, MobFilters, SearchKind, SearchRequest};
use super::pages::Ctx;
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
        .route("/npc/{id}", get(npc))
        .route("/world", get(world))
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
    page_response(status, cache, markup.into_string())
}

/// The same markup for every device (no `Vary`), so an edge cache can keep one copy.
fn page_response(status: StatusCode, cache: &'static str, body: String) -> Response {
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
        ],
        body,
    )
        .into_response()
}

/// A page with its `/api/v1/catalog/page` data for this URL at the end of the
/// body, so React starts from it instead of requesting it again (`catalog.ts`).
fn page_with_data(
    cache: &'static str,
    markup: Markup,
    ctx: &Ctx,
    kind: &str,
    page: serde_json::Value,
) -> Response {
    let mut body = markup.into_string();
    if let Some(script) = pages::page_data_script(ctx, kind, page) {
        let end = body.rfind("</body>").unwrap_or(body.len());
        body.insert_str(end, &script);
    }
    page_response(StatusCode::OK, cache, body)
}

/// Language from `?lang=` and this page's own URL for the language switch.
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
        Ok(Self(Ctx {
            lang,
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
const NPC: What = ("NPC", "NPC");

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

/// A detail page that also carries its data for React (`page_with_data`).
fn detail_with_data<T: serde::Serialize>(
    found: sqlx::Result<Option<T>>,
    ctx: &Ctx,
    what: What,
    cache: &'static str,
    kind: &str,
    render: fn(&T, &Ctx) -> Markup,
) -> Response {
    match found {
        Ok(Some(page)) => {
            let data = serde_json::to_value(&page).expect("catalog page serialize");
            page_with_data(cache, render(&page, ctx), ctx, kind, data)
        }
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
            "critical_rate",
            "critical_damage",
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
    match found {
        Ok(Some(page)) => {
            let data = pages::item_data(&page);
            page_with_data(
                ITEM_CACHE,
                pages::item_page(&page, &ctx),
                &ctx,
                "item",
                data,
            )
        }
        Ok(None) => not_found(ITEM, &ctx),
        Err(err) => server_error(err, &ctx),
    }
}

async fn mob(
    State(state): State<AppState>,
    Path(raw): Path<String>,
    PageCtx(ctx): PageCtx,
) -> Response {
    let Some(id) = parse_id(&raw) else {
        return not_found(MOB, &ctx);
    };
    detail_with_data(
        queries::mob_page(&state.db, id).await,
        &ctx,
        MOB,
        MOB_CACHE,
        "mob",
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
    detail_with_data(
        map_page(&state, id).await,
        &ctx,
        MAP,
        EDGE_CACHE,
        "map",
        pages::map_page,
    )
}

/// The map page with the way from Henesys.
async fn map_page(state: &AppState, id: i32) -> sqlx::Result<Option<super::model::MapPage>> {
    let Some(mut page) = queries::map_page(&state.db, id).await? else {
        return Ok(None);
    };
    if id != HENESYS {
        // Walking, scrolls and the ship; no paid taxi.
        let mut edges = queries::load_edges(&state.db).await?;
        edges.retain(|e| e.kind != EdgeKind::Taxi);
        let graph = Graph::new(edges);
        if let Some(path) = graph.shortest_path(HENESYS, id) {
            let ids: Vec<i32> = std::iter::once(HENESYS)
                .chain(path.iter().map(|e| e.to))
                .collect();
            let names = queries::map_refs(&state.db, &ids).await?;
            page.from_henesys = Some(ids.iter().map(|id| names[id].clone()).collect());
        }
    }
    Ok(Some(page))
}

#[derive(Deserialize)]
struct WorldParams {
    /// A map to point at.
    #[serde(default)]
    map: String,
}

async fn world(
    State(state): State<AppState>,
    PageCtx(ctx): PageCtx,
    Query(params): Query<WorldParams>,
) -> Response {
    match queries::world_page(&state.db, parse_id(&params.map)).await {
        Ok(page) => {
            let markup = pages::world_page(&page, &ctx);
            let data = serde_json::to_value(&page).expect("world page serialize");
            page_with_data(EDGE_CACHE, markup, &ctx, "world", data)
        }
        Err(err) => server_error(err, &ctx),
    }
}

async fn npc(
    State(state): State<AppState>,
    Path(raw): Path<String>,
    PageCtx(ctx): PageCtx,
) -> Response {
    let Some(id) = parse_id(&raw) else {
        return not_found(NPC, &ctx);
    };
    detail_with_data(
        queries::npc_page(&state.db, id).await,
        &ctx,
        NPC,
        EDGE_CACHE,
        "npc",
        pages::npc_page,
    )
}

#[derive(Deserialize)]
struct RouteParams {
    #[serde(default)]
    from: String,
    #[serde(default)]
    to: String,
    /// The monster finder: a monster name or id instead of `to`.
    #[serde(default)]
    mob: String,
    /// `mob` shows the monster finder's form.
    #[serde(default)]
    mode: String,
    /// `1`: routes may take the taxi (it costs mesos).
    #[serde(default)]
    taxi: String,
}

async fn route(
    State(state): State<AppState>,
    PageCtx(ctx): PageCtx,
    Query(params): Query<RouteParams>,
) -> Response {
    let from = clip(&params.from);
    let to = clip(&params.to);
    match route_page(&state, from, to, clip(&params.mob), params.taxi == "1").await {
        Ok(mut page) => {
            page.mob_mode |= params.mode == "mob";
            let markup = pages::route_page(&page, &ctx);
            let data = serde_json::to_value(&page).expect("route page serialize");
            page_with_data(EDGE_CACHE, markup, &ctx, "route", data)
        }
        Err(err) => server_error(err, &ctx),
    }
}

async fn route_page(
    state: &AppState,
    from_input: &str,
    to_input: &str,
    mob_input: &str,
    taxi: bool,
) -> sqlx::Result<RoutePage> {
    let mut edges = queries::load_edges(&state.db).await?;
    if !taxi {
        edges.retain(|e| e.kind != EdgeKind::Taxi);
    }
    let mut page = RoutePage {
        from_input: from_input.to_string(),
        to_input: to_input.to_string(),
        mob_input: mob_input.to_string(),
        mob_mode: !mob_input.is_empty(),
        taxi,
        known_edges: edges.len(),
        outcome: RouteOutcome::Form,
    };
    if !mob_input.is_empty() {
        page.outcome = mob_route(state, edges, from_input, mob_input).await?;
        return Ok(page);
    }
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
            let (steps, overview) = steps_of(&state.db, &from, &path).await?;
            RouteOutcome::Found {
                from,
                to,
                steps,
                overview,
            }
        }
    };
    Ok(page)
}

/// The monster finder: from the start (Henesys when empty) to the nearest
/// open map where the monster spawns.
async fn mob_route(
    state: &AppState,
    edges: Vec<super::route::Edge>,
    from_input: &str,
    mob_input: &str,
) -> sqlx::Result<RouteOutcome> {
    let from_input = if from_input.is_empty() {
        HENESYS.to_string()
    } else {
        from_input.to_string()
    };
    let from = match resolve(state, &from_input, RouteEnd::From).await? {
        Ok(map) => map,
        Err(outcome) => return Ok(outcome),
    };
    let mob = match queries::resolve_mob(&state.db, mob_input).await? {
        queries::MobResolution::One(mob) => mob,
        queries::MobResolution::Many(candidates) => {
            return Ok(RouteOutcome::MobUnresolved {
                query: mob_input.to_string(),
                candidates,
            })
        }
    };
    let spawn_maps = queries::mob_spawn_maps(&state.db, mob.id).await?;
    let graph = Graph::new(edges);
    let paths = graph.paths_from(from.id);
    let Some(nearest) = paths.nearest(spawn_maps.iter().map(|(m, _)| m.id)) else {
        return Ok(RouteOutcome::MobNoPath { from, mob });
    };
    let mut places: Vec<MobPlace> = spawn_maps
        .into_iter()
        .map(|(map, spawn_count)| MobPlace {
            steps: paths.to(map.id).map(|p| p.len()),
            map,
            spawn_count,
        })
        .collect();
    places.sort_by_key(|p| (p.steps.is_none(), p.steps, p.map.id));
    let to = places
        .iter()
        .find(|p| p.map.id == nearest)
        .map(|p| p.map.clone())
        .expect("the nearest map is a spawn map");
    let path = paths.to(nearest).unwrap_or_default();
    let (steps, overview) = steps_of(&state.db, &from, &path).await?;
    Ok(RouteOutcome::MobFound {
        from,
        mob,
        to,
        steps,
        overview,
        places,
    })
}

/// The route's steps with their maps drawn, and the route over the world map.
async fn steps_of(
    db: &sqlx::PgPool,
    from: &super::model::MapRef,
    path: &[&super::route::Edge],
) -> sqlx::Result<(Vec<Step>, Option<RouteOverview>)> {
    let mut ids: Vec<i32> = path.iter().flat_map(|e| [e.from, e.to]).collect();
    ids.push(from.id);
    ids.sort_unstable();
    ids.dedup();
    let names = queries::map_refs(db, &ids).await?;
    let mut steps: Vec<Step> = path
        .iter()
        .map(|e| Step {
            from: names[&e.from].clone(),
            to: names[&e.to].clone(),
            kind: e.kind,
            portal_name: e.portal_name.clone(),
            view: None,
            exit: None,
            npc: None,
            exit_hidden: false,
            arrival: None,
        })
        .collect();
    step_views(db, &mut steps).await?;
    let stops: Vec<super::model::MapRef> = std::iter::once(from.clone())
        .chain(steps.iter().map(|s| s.to.clone()))
        .collect();
    let overview = queries::route_overview(db, &stops).await?;
    Ok((steps, overview))
}

/// Each step's map with the portal to take and where the player stands
/// when the step starts: the portal back to the previous map, or the map's
/// spawn point (start, after a scroll, ship or taxi).
async fn step_views(db: &sqlx::PgPool, steps: &mut [Step]) -> sqlx::Result<()> {
    use super::model::Point;
    let mut came_from: Option<i32> = None;
    for step in steps.iter_mut() {
        let npc = transport_npc(step.from.id, step.to.id, step.kind);
        let layers = if npc.is_some() {
            queries::Layers::STEP_NPCS
        } else {
            queries::Layers::PORTALS
        };
        let view = queries::map_view(db, step.from.id, layers).await?;
        if let Some(view) = &view {
            if step.kind == EdgeKind::Portal {
                let to_next = || view.portals.iter().filter(|p| p.to.id == step.to.id);
                let exit = to_next()
                    .find(|p| p.name.is_some() && p.name == step.portal_name)
                    .or_else(|| to_next().next());
                step.exit = exit.map(|p| Point { x: p.x, y: p.y });
                step.exit_hidden = exit.is_some_and(|p| p.portal_type == Some(1));
            }
            if let Some(stand) = npc.and_then(|id| view.npcs.iter().find(|n| n.npc.id == id)) {
                step.exit = Some(Point {
                    x: stand.x,
                    y: stand.y,
                });
                step.npc = Some(stand.npc.clone());
            }
            step.arrival = came_from
                .and_then(|prev| view.portals.iter().find(|p| p.to.id == prev))
                .map(|p| Point { x: p.x, y: p.y })
                .or(view.player_spawn);
        }
        step.view = view;
        came_from = (step.kind == EdgeKind::Portal).then_some(step.from.id);
    }
    Ok(())
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
    /// `warrior`, `magician`, `bowman`, `thief`, or an old bit (1, 2, 4, 8).
    #[serde(default)]
    job: String,
    #[serde(default)]
    lmin: String,
    #[serde(default)]
    lmax: String,
    /// Old names of `lmin` and `lmax`.
    #[serde(default)]
    min_level: String,
    #[serde(default)]
    max_level: String,
    #[serde(default, rename = "type")]
    slot: String,
    #[serde(default)]
    weapon: String,
    #[serde(default, rename = "use")]
    use_type: String,
    /// `0` drops gear every job can wear.
    #[serde(default)]
    shared: String,
    #[serde(default)]
    sort: String,
    #[serde(default)]
    boss: String,
    #[serde(default)]
    town: String,
    #[serde(default)]
    q: String,
    /// `item`, `mob` or `map`; a query without it searches all three.
    #[serde(default)]
    kind: String,
    #[serde(default)]
    page: u32,
}

impl SearchParams {
    /// The normalized request: only the chosen kind's filters are kept, and
    /// the three-catalogue view of a typed query has none.
    fn request(&self) -> SearchRequest {
        let query = clip(&self.q).to_string();
        let level =
            |new: &str, old: &str| if new.is_empty() { old } else { new }.parse::<i16>().ok();
        let (lmin, lmax) = (
            level(&self.lmin, &self.min_level),
            level(&self.lmax, &self.max_level),
        );
        let mut items = ItemFilters {
            cat: self.cat.clone(),
            job: ItemFilters::parse_job(&self.job),
            lmin,
            lmax,
            slot: self.slot.clone(),
            weapon: self.weapon.parse().ok(),
            use_type: self.use_type.clone(),
            shared: self.shared != "0",
            sort: self.sort.clone(),
        };
        items.normalize();
        let mut mobs = MobFilters {
            lmin,
            lmax,
            boss: self.boss == "1",
            sort: self.sort.clone(),
        };
        mobs.normalize();
        let kind = search_kind(&query, &self.kind, items != ItemFilters::default());
        let size = if kind.is_some() {
            queries::SEARCH_KIND_LIMIT
        } else {
            queries::SEARCH_LIMIT
        };
        let mut request = SearchRequest {
            query,
            kind,
            offset: i64::from(self.page.saturating_sub(1).min(10000)) * size,
            ..Default::default()
        };
        match kind {
            Some(SearchKind::Item) => request.items = items,
            Some(SearchKind::Mob) => request.mobs = mobs,
            Some(SearchKind::Map) => request.town = self.town == "1",
            None => {}
        }
        if matches!(kind, Some(SearchKind::Mob | SearchKind::Map)) {
            request.region = self.region.clone();
            request.area = self.area.clone();
        }
        request
    }
}

// Browsing selects one catalogue (items by default). A typed query searches
// all three unless it names a kind; old links with item filters mean items.
fn search_kind(query: &str, requested: &str, item_filters: bool) -> Option<SearchKind> {
    match SearchKind::parse(requested) {
        Some(kind) => Some(kind),
        None if query.is_empty() || item_filters => Some(SearchKind::Item),
        None => None,
    }
}

async fn search(
    State(state): State<AppState>,
    PageCtx(ctx): PageCtx,
    Query(params): Query<SearchParams>,
) -> Response {
    let page = queries::search_page(&state.db, &params.request()).await;
    match page {
        Ok(page) => {
            let markup = pages::search_page(&page, &ctx);
            let data = serde_json::to_value(&page).expect("search page serialize");
            page_with_data(NO_STORE, markup, &ctx, "search", data)
        }
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
    headers: HeaderMap,
) -> Response {
    use axum::{http::Uri, Json};
    use serde_json::json;
    fn response(status: StatusCode, value: serde_json::Value) -> Response {
        (status, [(header::CACHE_CONTROL, NO_STORE)], Json(value)).into_response()
    }
    fn loaded<T: serde::Serialize>(result: sqlx::Result<Option<T>>, kind: &str, headers: &HeaderMap) -> Response {
        #[derive(serde::Serialize)]
        struct Snapshot<'a, T> { kind: &'a str, page: T }
        match result {
            // Conditional requests keep unchanged snapshots off the wire.
            Ok(Some(page)) => crate::delivery::revalidate(headers, kind,
                serde_json::to_value(Snapshot { kind, page }).expect("catalog snapshot")),
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
        return loaded(
            queries::search_page(&state.db, &params.request())
                .await
                .map(Some),
            "search", &headers,
        );
    }
    if path == "/world" {
        let Ok(Query(params)) = Query::<WorldParams>::try_from_uri(&uri) else {
            return response(StatusCode::BAD_REQUEST, json!({"error":"invalid_query"}));
        };
        return loaded(
            queries::world_page(&state.db, parse_id(&params.map))
                .await
                .map(Some),
            "world",
            &headers,
        );
    }
    if path == "/route" {
        let Ok(Query(params)) = Query::<RouteParams>::try_from_uri(&uri) else {
            return response(StatusCode::BAD_REQUEST, json!({"error":"invalid_query"}));
        };
        return loaded(
            route_page(
                &state,
                clip(&params.from),
                clip(&params.to),
                clip(&params.mob),
                params.taxi == "1",
            )
            .await
            .map(|mut page| {
                page.mob_mode |= params.mode == "mob";
                Some(page)
            }),
            "route", &headers,
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
                        return loaded(queries::item_preview(&state.db, id, params.hours == "all").await, "item_preview", &headers);
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
                "item", &headers,
            )
        }
        "mob" => loaded(queries::mob_page(&state.db, id).await, "mob", &headers),
        "map" => loaded(map_page(&state, id).await, "map", &headers),
        "npc" => loaded(queries::npc_page(&state.db, id).await, "npc", &headers),
        _ => response(StatusCode::NOT_FOUND, json!({"error":"not_found"})),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn item_selection_accepts_critical_attribute_filters() {
        let params: ItemParams = serde_json::from_value(serde_json::json!({
            "attributes": r#"[["critical_rate",2],["critical_damage",3]]"#
        })).unwrap();
        assert_eq!(params.selection().unwrap().attributes.len(), 2);
    }
    #[test]
    fn search_crosses_catalogues_only_for_a_query_without_a_kind() {
        assert_eq!(search_kind("", "", false), Some(SearchKind::Item));
        assert_eq!(search_kind("", "mob", false), Some(SearchKind::Mob));
        assert_eq!(search_kind("", "map", false), Some(SearchKind::Map));
        assert_eq!(search_kind("蜗牛", "", false), None);
        assert_eq!(search_kind("蜗牛", "mob", false), Some(SearchKind::Mob));
        assert_eq!(search_kind("帽", "", true), Some(SearchKind::Item));
    }

    fn request(query: &str) -> SearchRequest {
        let uri: axum::http::Uri = format!("/search?{query}").parse().unwrap();
        Query::<SearchParams>::try_from_uri(&uri)
            .unwrap()
            .0
            .request()
    }

    #[test]
    fn old_links_and_kind_scoped_filters() {
        let old = request("kind=item&cat=use&job=1&min_level=30&max_level=40");
        assert_eq!(old.items.cat, "equip", "a job selects 装备");
        assert_eq!(old.items.job, "warrior");
        assert_eq!((old.items.lmin, old.items.lmax), (Some(30), Some(40)));
        let new = request("kind=item&job=warrior&lmin=30&lmax=40");
        assert_eq!(new.items, old.items);
        assert_eq!(request("kind=item&job=16").items.job, "", "no pirates");
        assert_eq!(request("kind=item&page=3").offset, 120);
        let mobs = request("kind=mob&lmin=10&lmax=1&boss=1&sort=name&region=victoria&job=1");
        assert_eq!(mobs.mobs.query(), "&lmin=1&lmax=10&boss=1&sort=name");
        assert_eq!(mobs.items, ItemFilters::default());
        assert_eq!(mobs.region, "victoria");
        let maps = request("kind=map&town=1&lmin=5");
        assert!(maps.town);
        assert_eq!(maps.mobs, MobFilters::default());
        let mixed = request("q=%E8%9C%97%E7%89%9B&region=victoria&page=2");
        assert_eq!(mixed.kind, None);
        assert_eq!((mixed.region.as_str(), mixed.offset), ("", 20));
        let legacy = request("q=%E5%B8%BD&cat=equip");
        assert_eq!(legacy.kind, Some(SearchKind::Item));
        assert_eq!(legacy.items.cat, "equip");
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

    async fn ctx_of(uri: &str) -> Ctx {
        let req = axum::http::Request::get(uri).header("sec-ch-ua-mobile", "?0");
        let (mut parts, _) = req.body(()).unwrap().into_parts();
        PageCtx::from_request_parts(&mut parts, &())
            .await
            .unwrap()
            .0
    }

    #[tokio::test]
    async fn page_context_from_the_request() {
        let ctx = ctx_of("/route?from=1&lang=en&to=2").await;
        assert_eq!(ctx.lang, Lang::En);
        assert_eq!(ctx.here, "/route?from=1&to=2");
        let ctx = ctx_of("/item/4?part=market").await;
        assert_eq!(ctx.lang, Lang::Zh);
        assert_eq!(ctx.here, "/item/4");
    }
}

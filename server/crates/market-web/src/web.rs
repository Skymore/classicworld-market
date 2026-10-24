//! The `web/` tree. Assets at `/web/...` (same prefix as the Python servers, see `web_assets.py`) (cacheable), page routes (`/`,
//! `/prices`, `/sales`, `/watch`, `/alerts`, legacy `/v2`) return the SPA
//! shell `web/index.html`, and the screen collector lives at `/collect`.
//! Read from disk at runtime because `web/collect/pkg/` (the WASM) is a
//! build product, not a source file.

use std::path::Path;

use axum::{
    http::{header, HeaderValue},
    Router,
};
use tower_http::{
    services::{ServeDir, ServeFile},
    set_header::SetResponseHeaderLayer,
};

use crate::AppState;

/// `wasm-unsafe-eval` lets the collector instantiate its WASM; `media-src
/// blob:` is the screen-share preview; `img-src https:` the item icons.
/// `style-src 'unsafe-inline'` only covers style attributes: the UI passes
/// sizes as inline custom properties (`style="--s:28px"`); scripts stay strict.
const CSP: &str = "default-src 'none'; script-src 'self' 'wasm-unsafe-eval'; worker-src 'self'; \
    style-src 'self' 'unsafe-inline'; img-src 'self' https: data: blob:; media-src blob:; connect-src 'self' http://127.0.0.1:8780; \
    font-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'";

/// Client-routed pages (see `web/js/app.js`). Each also matches `/<page>/*`.
pub const PAGE_ROUTES: &[&str] = &[
    "/",
    "/prices",
    "/agent",
    "/selling",
    "/sales",
    "/watch",
    "/alerts",
    "/account",
    "/privacy",
    "/contributors",
    "/v2",
];

pub fn routes(web_dir: &Path) -> Router<AppState> {
    let releases = std::env::var_os("COLLECTOR_RELEASE_DIR")
        .map(std::path::PathBuf::from)
        .unwrap_or_else(|| web_dir.join("releases"));
    routes_with_releases(web_dir, &releases)
}

/// Keep collector downloads independent of immutable website deployments.
pub fn routes_with_releases(web_dir: &Path, releases: &Path) -> Router<AppState> {
    let cache = |value: &'static str| {
        SetResponseHeaderLayer::overriding(header::CACHE_CONTROL, HeaderValue::from_static(value))
    };
    // Revalidate assets on navigation so HTML, modules and styles stay in
    // sync after deployment; unchanged files still use conditional responses.
    let assets = Router::new()
        .nest_service("/web/releases", ServeDir::new(releases))
        .nest_service("/web", ServeDir::new(web_dir).precompressed_gzip())
        .nest_service(
            "/collect",
            ServeDir::new(web_dir.join("collect"))
                .append_index_html_on_directories(true)
                .precompressed_gzip(),
        )
        .layer(cache("no-cache"));
    let index = web_dir.join("index.html");
    let mut shell = Router::new();
    for route in PAGE_ROUTES {
        let file = ServeFile::new(&index);
        shell = shell.route_service(route, file.clone());
        if *route != "/" {
            shell = shell.route_service(&format!("{route}/{{*rest}}"), file);
        }
    }
    assets
        .merge(shell.layer(cache("no-cache")))
        .layer(SetResponseHeaderLayer::if_not_present(
            header::REFERRER_POLICY,
            HeaderValue::from_static("no-referrer"),
        ))
        .layer(SetResponseHeaderLayer::if_not_present(
            header::CONTENT_SECURITY_POLICY,
            HeaderValue::from_static(CSP),
        ))
}

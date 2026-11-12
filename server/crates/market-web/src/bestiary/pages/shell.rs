//! The page shell: the same chrome as `web/js/lib/chrome.js` (phone top bar
//! and dock, desktop header; `base.css` shows one per `html[data-device]`),
//! the pixel icons of `web/js/lib/icons.js`, and links in the page language.

use std::sync::{Arc, Mutex};

use maud::{html, Markup, PreEscaped, DOCTYPE};
use serde::Deserialize;
use sqlx::types::chrono::{DateTime, Utc};

use crate::bestiary::format::Lang;

/// Per-request rendering context. The markup does not depend on the device:
/// `boot.js` sets `html[data-device]` from the viewport before any stylesheet
/// applies, so one cached page serves phones and desktops.
#[derive(Debug, Clone, Default)]
pub struct Ctx {
    pub lang: Lang,
    /// This page's path and query without `lang`, for the language switch.
    pub here: String,
    /// Render time, for "data updated N ago".
    pub now: DateTime<Utc>,
}

impl Ctx {
    pub fn t<'a>(&self, zh: &'a str, en: &'a str) -> &'a str {
        self.lang.t(zh, en)
    }

    /// A link to a server-rendered page, keeping the page language.
    pub fn href(&self, path: &str) -> String {
        match self.lang {
            Lang::Zh => path.to_string(),
            Lang::En => with_param(path, "lang=en"),
            Lang::Ko => with_param(path, "lang=ko"),
        }
    }

    /// This page in the next language (中文 -> English -> 한국어). Chinese is the
    /// default, so it states `lang=zh` only to override a browser preference.
    fn other_lang_href(&self) -> String {
        let here = if self.here.is_empty() {
            "/"
        } else {
            &self.here
        };
        match self.lang.next() {
            Lang::Zh => with_param(here, "lang=zh"),
            Lang::En => with_param(here, "lang=en"),
            Lang::Ko => with_param(here, "lang=ko"),
        }
    }
}

fn with_param(path: &str, param: &str) -> String {
    let sep = if path.contains('?') { '&' } else { '?' };
    format!("{path}{sep}{param}")
}

/// Which navigation entry is current.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Nav {
    /// The home page, which holds the price table.
    Home,
    Dex,
}

pub struct Page<'a> {
    pub title: &'a str,
    pub nav: Nav,
    /// `web/css/<name>.css` files loaded after `base.css`.
    pub css: &'a [&'static str],
    /// Extra `web/js/pages/<name>.js` modules after `dex.js`.
    /// Text of the "data updated" chips; hidden when `None`.
    pub fresh: Option<String>,
    /// Kept in the desktop search box.
    pub query: &'a str,
}

/// What the frontend build lists for the server-rendered pages
/// (`web/react/preload.json`, written by `frontend/build-assets.ts`).
#[derive(Debug, Default, Deserialize)]
struct Preloads {
    /// Modules `shell.js` imports.
    shell: Vec<String>,
    /// The catalogue route React loads on every page here.
    catalogue: RoutePreloads,
    /// The search view, loaded on `/search` only.
    search: RoutePreloads,
    /// `web/css` files the catalogue route loads before it renders.
    #[serde(rename = "siteStyles")]
    site_styles: Vec<String>,
}

#[derive(Debug, Default, Deserialize)]
struct RoutePreloads {
    modules: Vec<String>,
    styles: Vec<String>,
}

/// The build's list, read again when the frontend asset version changes.
fn preloads(version: &str) -> Arc<Preloads> {
    static CACHE: Mutex<Option<(String, Arc<Preloads>)>> = Mutex::new(None);
    let mut cache = CACHE.lock().unwrap_or_else(|e| e.into_inner());
    if let Some((cached, list)) = cache.as_ref() {
        if cached == version {
            return list.clone();
        }
    }
    let root = std::env::var_os("WEB_DIR")
        .map(std::path::PathBuf::from)
        .unwrap_or_else(|| std::path::PathBuf::from("web"));
    let list: Arc<Preloads> = Arc::new(
        std::fs::read(root.join("react/preload.json"))
            .ok()
            .and_then(|bytes| serde_json::from_slice(&bytes).ok())
            .unwrap_or_default(),
    );
    *cache = Some((version.to_owned(), list.clone()));
    list
}

/// Item icons and monster renders, the first third-party images on most pages.
const IMAGE_HOSTS: [&str; 2] = ["https://mxdgcw.dvg.cn", "https://maplestory.io"];

pub fn layout(ctx: &Ctx, page: &Page<'_>, body: Markup) -> Markup {
    let asset_version = crate::web::frontend_asset_version();
    let preloads = preloads(&asset_version);
    page_shell(ctx, page, body, &asset_version, &preloads)
}

fn page_shell(
    ctx: &Ctx,
    page: &Page<'_>,
    body: Markup,
    asset_version: &str,
    preloads: &Preloads,
) -> Markup {
    let brand = ctx.t("枫叶市集", "Maple Market");
    // Fetch the React route alongside the entry instead of one import level at a time.
    let views: Vec<&RoutePreloads> = if ctx.here.starts_with("/search") {
        vec![&preloads.catalogue, &preloads.search]
    } else {
        vec![&preloads.catalogue]
    };
    let site_styles = preloads
        .site_styles
        .iter()
        .filter(|name| !page.css.contains(&name.as_str()));
    html! {
        (DOCTYPE)
        // `boot.js` replaces data-device before the first paint.
        html lang=(ctx.lang.html_lang()) data-lang=(ctx.lang.code()) data-device="phone" data-theme="light" {
            head {
                meta charset="utf-8";
                meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover";
                meta name="color-scheme" content="light dark";
                meta name="theme-color" content="#3b5f8a";
                // Add to Home Screen from any page gets the app name and icon (WEB_PUSH.md).
                meta name="apple-mobile-web-app-title" content="枫叶市集";
                link rel="manifest" href="/manifest.webmanifest";
                link rel="apple-touch-icon" href="/web/icons/apple-touch-icon.png";
                @for host in IMAGE_HOSTS {
                    link rel="preconnect" href=(host);
                }
                // Blocking initialization must run before CSS and deferred modules.
                script src=(format!("/web/js/lib/boot.js?v={asset_version}")) {}
                title { (page.title) " · " (brand) }
                link rel="stylesheet" href=(format!("/web/css/base.css?v={asset_version}"));
                @for name in page.css {
                    link rel="stylesheet" href={"/web/css/" (name) ".css?v=" (asset_version)};
                }
                link rel="stylesheet" href=(format!("/web/react/style.css?v={asset_version}"));
                script type="module" src=(format!("/web/react/shell.js?v={asset_version}")) {}
                @for file in preloads.shell.iter().chain(views.iter().flat_map(|view| &view.modules)) {
                    link rel="modulepreload" href={"/web/react/" (file)};
                }
                @for file in views.iter().flat_map(|view| &view.styles) {
                    link rel="preload" as="style" href={"/web/react/" (file)};
                }
                @for name in site_styles {
                    link rel="preload" as="style" href={"/web/css/" (name) ".css?v=" (asset_version)};
                }
            }
            body {
                div id="app" class="app" {
                    header.ptop {
                        (brand_link(ctx, 22))
                        (fresh_chip(page.fresh.as_deref()))
                        (prefs(ctx))
                    }
                    header.dhead {
                        div.in {
                            (brand_link(ctx, 26))
                            (desk_nav(ctx, page.nav))
                            form.finder action="/search" method="get" role="search" {
                                (PreEscaped(icon(Icon::Search)))
                                input type="search" name="q" value=(page.query)
                                    placeholder=(ctx.t("搜索物品、怪物、地图", "Search items, monsters, maps"))
                                    aria-label=(ctx.t("搜索", "Search"));
                                @if ctx.lang != Lang::Zh { input type="hidden" name="lang" value=(ctx.lang.code()); }
                                kbd { "/" }
                            }
                            (fresh_chip(page.fresh.as_deref()))
                            (prefs(ctx))
                        }
                    }
                    main.pmain id="main" { (body) }
                    (dock(ctx, page.nav))
                }
            }
        }
    }
}

/// Largest page data embedded in the HTML. Above it the page keeps only its
/// server-rendered first screen and React requests the JSON as usual.
pub const PAGE_DATA_LIMIT: usize = 256 * 1024;

/// `<script id="catalog-snapshot">`: this URL's `/api/v1/catalog/page` answer
/// (`{kind, page}`), its validator and the render time, which `catalog.ts`
/// seeds the React query with. `None` when it exceeds [`PAGE_DATA_LIMIT`].
pub fn page_data_script(ctx: &Ctx, kind: &str, page: serde_json::Value) -> Option<String> {
    let mut data = serde_json::json!({ "kind": kind, "page": page });
    // The same weak tag the JSON endpoint sends, for its conditional requests.
    let tag = crate::delivery::tag(kind, &mut data);
    let json = serde_json::json!({
        "url": ctx.here,
        "updatedAt": ctx.now.timestamp_millis(),
        "data": data,
        "etag": tag,
    })
    .to_string();
    if json.len() > PAGE_DATA_LIMIT {
        return None;
    }
    // Escape raw-text delimiters: names must never close the script or open a comment.
    let json = json
        .replace('&', "\\u0026")
        .replace('<', "\\u003c")
        .replace('>', "\\u003e")
        .replace('\u{2028}', "\\u2028")
        .replace('\u{2029}', "\\u2029");
    Some(format!(
        r#"<script id="catalog-snapshot" type="application/json">{json}</script>"#
    ))
}

fn brand_link(ctx: &Ctx, size: u32) -> Markup {
    html! {
        a.brand href="/" {
            (PreEscaped(leaf(size)))
            span { (ctx.t("枫叶市集", "Maple Market")) }
        }
    }
}

/// Same markup as `chrome.js`, so `setFreshness()` can update it later.
fn fresh_chip(text: Option<&str>) -> Markup {
    html! {
        span.fresh data-fresh hidden[text.is_none()] {
            i {}
            span { @if let Some(text) = text { (text) } }
        }
    }
}

fn prefs(ctx: &Ctx) -> Markup {
    html! {
        span.prefs {
            a.iconbtn href=(ctx.other_lang_href()) data-lang-toggle=(ctx.lang.next().code()) hreflang=(ctx.lang.next().code()) aria-label=(ctx.t("切换语言 / English", "Switch language / 中文")) title=(ctx.t("切换语言 / English", "Switch language / 中文")) {
                span.pref-glyph.pref-language aria-hidden="true" {}
            }
            button.iconbtn type="button" data-theme-toggle aria-label=(ctx.t("切换夜市主题", "Toggle night market theme")) title=(ctx.t("切换夜市主题", "Toggle night market theme")) {
                span.pref-glyph.pref-theme aria-hidden="true" {}
            }
            a.iconbtn.account-link href="/account" data-account-link aria-label=(ctx.t("登录账号", "Sign in to your account")) title=(ctx.t("登录账号", "Sign in to your account")) {
                span.pref-glyph.pref-account aria-hidden="true" {}
            }
        }
    }
}

fn desk_nav(ctx: &Ctx, active: Nav) -> Markup {
    let entries = [
        ("/", ctx.t("首页", "Home"), Some(Nav::Home)),
        ("/agent", ctx.t("AI 助手", "Ask AI"), None),
        (
            "/search?kind=item",
            ctx.t("图鉴", "Catalogue"),
            Some(Nav::Dex),
        ),
        ("/watch", ctx.t("关注", "Watch"), None),
        ("/tools", ctx.t("工具", "Tools"), None),
        ("/selling", ctx.t("背包／摆摊", "Bag & shop"), None),
    ];
    html! {
        nav.dnav aria-label=(ctx.t("主导航", "Main")) {
            @for (href, label, nav) in entries {
                @let on = nav == Some(active);
                a href=(nav_href(ctx, href)) class=[on.then_some("on")] aria-current=[on.then_some("page")] { (label) }
            }
        }
    }
}

fn dock(ctx: &Ctx, active: Nav) -> Markup {
    let entries = [
        (
            "/",
            ctx.t("首页", "Home"),
            Icon::Home,
            Some(Nav::Home),
            "home",
        ),
        (
            "/agent",
            ctx.t("AI 助手", "Ask AI"),
            Icon::Search,
            None,
            "agent",
        ),
        (
            "/search?kind=item",
            ctx.t("图鉴", "Catalogue"),
            Icon::Book,
            Some(Nav::Dex),
            "dex",
        ),
        ("/watch", ctx.t("关注", "Watch"), Icon::Star, None, "watch"),
        ("/tools", ctx.t("工具", "Tools"), Icon::Tools, None, "tools"),
        (
            "/selling",
            ctx.t("背包／摆摊", "Bag & shop"),
            Icon::Tag,
            None,
            "selling",
        ),
    ];
    html! {
        nav.dock aria-label=(ctx.t("主导航", "Main")) {
            @for (href, label, glyph, nav, key) in entries {
                @let on = nav == Some(active);
                a href=(nav_href(ctx, href)) class=[on.then_some("on")] aria-current=[on.then_some("page")] {
                    span.dock-icon aria-hidden="true" { (PreEscaped(icon(glyph))) }
                    span { (label) }
                    span.badge data-badge=(key) hidden {}
                }
            }
        }
    }
}

/// `/search` is server-rendered and takes the language; the SPA pages read
/// the language the visitor saved, so they need no parameter. Entries match
/// `web/js/lib/chrome.js` (DOCK / DESK_NAV).
fn nav_href(ctx: &Ctx, href: &str) -> String {
    if href.starts_with("/search") {
        ctx.href(href)
    } else {
        href.to_string()
    }
}

// ---------- pixel icons (web/js/lib/icons.js) ----------

#[derive(Debug, Clone, Copy)]
pub enum Icon {
    Home,
    Tag,
    Book,
    Star,
    Tools,
    /// A small coin for meso amounts.
    Coin,
    StarSmall,
    StarOutline,
    Search,
    Chev,
    Caret,
    Map,
}

const LEAF: &str = "
.....r.....
....rrr....
.r..rrr..r.
.rr.rrr.rr.
.rrrrrrrrr.
rrrrrrrrrrr
.rrrrrrrrr.
..rrrrrrr..
.rr.rkr.rr.
.....k.....
....k......";
const HOME: &str = "
.....##.....
....####....
...######...
..########..
.##########.
############
.##......##.
.##.####.##.
.##.#..#.##.
.##.#..#.##.
.##.#..#.##.
.##########.";
const TAG: &str = "
.....#######
....##.....#
...##..##..#
..##...##..#
.##........#
##........##
#........##.
##......##..
.##....##...
..##..##....
...####.....
....##......";
const BOOK: &str = "
............
.####..####.
#....##....#
#.##.##.##.#
#....##....#
#.##.##.##.#
#....##....#
#.##.##.##.#
#....##....#
.####..####.
.....##.....
............";
const STAR: &str = "
.....##.....
.....##.....
....####....
....####....
############
.##########.
..########..
...######...
...######...
..###..###..
..##....##..
.##......##.";
/// Toolbox for the 工具 dock entry (same art as `tools` in web/js/lib/icons.js).
const TOOLS: &str = "
....####....
...#....#...
...#....#...
############
#..........#
#..........#
#####..#####
#....##....#
#..........#
#..........#
#..........#
############";
/// Coin for meso amounts (same art as `coin` in web/js/lib/icons.js).
const COIN: &str = "
....####....
..########..
.####..####.
.###.##.###.
####.##.####
####.##.####
####.##.####
####.##.####
.###.##.###.
.####..####.
..########..
....####....";
const STAR_OUTLINE: &str = "
.....##.....
.....##.....
....#..#....
....#..#....
#####..#####
.#........#.
..#......#..
...#....#...
...#....#...
..#..##..#..
..#.#..#.#..
.##......##.";
const SEARCH: &str = "
..#####.....
.##...##....
##.....##...
#.......#...
#.......#...
##.....##...
.##...##....
..#######...
.......###..
........###.
.........###
..........##";
const CHEV: &str = "
#.....
##....
.##...
..##..
...##.
...##.
..##..
.##...
##....
#.....";
const CARET: &str = "
#........#
##......##
.##....##.
..##..##..
...####...
....##....";
const MAP: &str = "
............
###...##.....
#.####.###...
#...#....####
#...#....#..#
#...#....#..#
#...#....#..#
#...#....#..#
####.###.#..#
...###..####.
.............
.............";

pub fn icon(which: Icon) -> String {
    let (art, size) = match which {
        Icon::Home => (HOME, 24),
        Icon::Tag => (TAG, 24),
        Icon::Book => (BOOK, 24),
        Icon::Star => (STAR, 24),
        Icon::Tools => (TOOLS, 24),
        Icon::Coin => (COIN, 14),
        Icon::StarSmall => (STAR, 18),
        Icon::StarOutline => (STAR_OUTLINE, 18),
        Icon::Search => (SEARCH, 18),
        Icon::Chev => (CHEV, 6),
        Icon::Caret => (CARET, 12),
        Icon::Map => (MAP, 20),
    };
    px(art, size, &[])
}

fn leaf(size: u32) -> String {
    px(LEAF, size, &[('r', "var(--maple)"), ('k', "var(--edge)")])
}

/// One `<rect>` per horizontal run of a character; `.` is empty. Rows are
/// padded to the widest one (the map art is ragged, as in icons.js).
fn px(art: &str, size: u32, palette: &[(char, &str)]) -> String {
    let rows: Vec<Vec<char>> = art
        .trim()
        .lines()
        .map(|r| r.trim().chars().collect())
        .collect();
    let w = rows.iter().map(Vec::len).max().unwrap_or(1);
    let h = rows.len().max(1);
    let mut rects = String::new();
    for (y, row) in rows.iter().enumerate() {
        let mut x = 0;
        while x < row.len() {
            let c = row[x];
            let run = row[x..].iter().take_while(|&&k| k == c).count();
            if c != '.' {
                let fill = palette
                    .iter()
                    .find(|(k, _)| *k == c)
                    .map_or("currentColor", |(_, v)| v);
                rects.push_str(&format!(
                    r#"<rect x="{x}" y="{y}" width="{run}" height="1" fill="{fill}"/>"#
                ));
            }
            x += run;
        }
    }
    let height = (f64::from(size) * h as f64 / w as f64).round();
    format!(
        r#"<svg class="px" viewBox="0 0 {w} {h}" width="{size}" height="{height}" shape-rendering="crispEdges" aria-hidden="true">{rects}</svg>"#
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn theme_is_initialized_before_styles_and_page_modules() {
        let rendered = layout(
            &Ctx::default(),
            &Page {
                title: "Theme test",
                nav: Nav::Dex,
                css: &["dex"],
                fresh: None,
                query: "",
            },
            html! { p { "Page content" } },
        )
        .into_string();
        let version = crate::web::frontend_asset_version();
        let boot = rendered
            .find(&format!(
                r#"<script src="/web/js/lib/boot.js?v={version}"></script>"#
            ))
            .expect("parser-blocking theme initialization");
        assert!(boot < rendered.find(r#"rel="stylesheet""#).unwrap());
        assert!(boot < rendered.find(r#"type="module""#).unwrap());
        for asset in [
            "css/base.css",
            "css/dex.css",
            "react/style.css",
            "react/shell.js",
        ] {
            assert!(rendered.contains(&format!("/web/{asset}?v={version}")));
        }
    }

    fn test_page<'a>(css: &'a [&'static str]) -> Page<'a> {
        Page {
            title: "Preload test",
            nav: Nav::Dex,
            css,
            fresh: None,
            query: "",
        }
    }

    #[test]
    fn head_preloads_the_route_and_is_the_same_for_every_device() {
        let route = |module: &str, style: &str| RoutePreloads {
            modules: vec![module.into()],
            styles: vec![style.into()],
        };
        let list = Preloads {
            shell: vec!["chunks/main-a.js".into(), "chunks/shared-b.js".into()],
            catalogue: route("chunks/catalogue-c.js", "chunks/offer-filters-d.css"),
            search: route("chunks/catalogue-search-e.js", "chunks/search-f.css"),
            site_styles: vec!["dex".into(), "prices".into()],
        };
        let render = |here: &str| {
            let ctx = Ctx {
                here: here.into(),
                ..Ctx::default()
            };
            page_shell(&ctx, &test_page(&["dex"]), html! {}, "v1", &list).into_string()
        };
        let item = render("/item/4");
        for link in [
            r#"<link rel="modulepreload" href="/web/react/chunks/main-a.js">"#,
            r#"<link rel="modulepreload" href="/web/react/chunks/shared-b.js">"#,
            r#"<link rel="modulepreload" href="/web/react/chunks/catalogue-c.js">"#,
            r#"<link rel="preload" as="style" href="/web/react/chunks/offer-filters-d.css">"#,
            r#"<link rel="preload" as="style" href="/web/css/prices.css?v=v1">"#,
            r#"<link rel="preconnect" href="https://mxdgcw.dvg.cn">"#,
            r#"<link rel="preconnect" href="https://maplestory.io">"#,
        ] {
            assert!(item.contains(link), "{link}");
        }
        // dex.css is already a stylesheet here; search modules stay off other pages.
        assert!(!item.contains(r#"as="style" href="/web/css/dex.css"#));
        assert!(!item.contains("catalogue-search-e.js"));
        let search = render("/search?q=x");
        assert!(search.contains(
            r#"<link rel="modulepreload" href="/web/react/chunks/catalogue-search-e.js">"#
        ));
        assert!(search
            .contains(r#"<link rel="preload" as="style" href="/web/react/chunks/search-f.css">"#));
        assert!(item.contains(r#"data-device="phone""#));
        // Without a build list the page still renders, just without preloads.
        let bare = page_shell(
            &Ctx::default(),
            &test_page(&[]),
            html! {},
            "v1",
            &Preloads::default(),
        )
        .into_string();
        assert!(!bare.contains("modulepreload") && bare.contains("react/shell.js?v=v1"));
    }

    #[test]
    fn page_data_is_escaped_and_skipped_when_too_large() {
        let ctx = Ctx {
            here: "/mob/1".into(),
            ..Ctx::default()
        };
        let name = "</script><!-- \u{2028}\u{2029}&";
        let script = page_data_script(&ctx, "mob", serde_json::json!({ "name": name })).unwrap();
        let inner = script
            .strip_prefix(r#"<script id="catalog-snapshot" type="application/json">"#)
            .and_then(|rest| rest.strip_suffix("</script>"))
            .unwrap();
        for raw in ['<', '>', '&', '\u{2028}', '\u{2029}'] {
            assert!(!inner.contains(raw), "{raw:?}");
        }
        let value: serde_json::Value = serde_json::from_str(inner).unwrap();
        assert_eq!(value["data"]["page"]["name"], name);
        assert_eq!(value["data"]["kind"], "mob");
        assert_eq!(value["url"], "/mob/1");
        assert!(value["etag"].as_str().unwrap().starts_with("W/"));
        let big = "x".repeat(PAGE_DATA_LIMIT);
        assert!(page_data_script(&ctx, "mob", serde_json::json!({ "name": big })).is_none());
    }

    #[test]
    fn navigation_matches_the_site() {
        let ctx = Ctx::default();
        for nav in [desk_nav(&ctx, Nav::Dex), dock(&ctx, Nav::Dex)] {
            let html = nav.into_string();
            let labels = ["首页", "AI 助手", "图鉴", "关注", "工具"]
                .map(|label| html.find(&format!("{label}</")).expect(label));
            assert!(labels.windows(2).all(|pair| pair[0] < pair[1]), "{html}");
            assert!(
                !html.contains("/prices") && !html.contains("价格表"),
                "{html}"
            );
            assert!(html.contains(r#"href="/agent""#));
        }
        assert!(desk_nav(&ctx, Nav::Home)
            .into_string()
            .contains(r#"<a href="/" class="on" aria-current="page">"#));
    }

    #[test]
    fn links_keep_the_language() {
        let en = Ctx {
            lang: Lang::En,
            here: "/route?from=1&to=2".into(),
            ..Ctx::default()
        };
        assert_eq!(en.href("/mob/4"), "/mob/4?lang=en");
        assert_eq!(en.href("/route?from=1"), "/route?from=1&lang=en");
        assert_eq!(en.other_lang_href(), "/route?from=1&to=2&lang=ko");
        let zh = Ctx {
            here: "/item/4".into(),
            ..Ctx::default()
        };
        assert_eq!(zh.href("/mob/4"), "/mob/4");
        assert_eq!(zh.other_lang_href(), "/item/4?lang=en");
    }

    #[test]
    fn pixel_art_runs() {
        let svg = leaf(22);
        assert!(svg.contains(r#"<rect x="5" y="0" width="1" height="1" fill="var(--maple)"/>"#));
        assert!(svg.contains(r#"<rect x="0" y="5" width="11" height="1" fill="var(--maple)"/>"#));
        assert!(svg.contains(r#"fill="var(--edge)""#));
        assert!(icon(Icon::Map).contains(r#"viewBox="0 0 13 12""#));
    }
}

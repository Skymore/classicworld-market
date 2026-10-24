//! The page shell: the same chrome as `web/js/lib/chrome.js` (phone top bar
//! and dock, desktop header; `base.css` shows one per `html[data-device]`),
//! the pixel icons of `web/js/lib/icons.js`, and links in the page language.

use maud::{html, Markup, PreEscaped, DOCTYPE};
use sqlx::types::chrono::{DateTime, Utc};

use crate::bestiary::format::Lang;

/// Layout hint for the first paint; `dex.js` corrects it from the viewport.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum Device {
    #[default]
    Phone,
    Desktop,
}

impl Device {
    /// `Sec-CH-UA-Mobile: ?0` means a desktop browser; anything else (absent,
    /// `?1`) gets the phone layout, the cheaper one to correct.
    pub fn from_mobile_hint(hint: Option<&str>) -> Self {
        match hint.map(str::trim) {
            Some("?0") => Self::Desktop,
            _ => Self::Phone,
        }
    }

    fn attr(self) -> &'static str {
        match self {
            Self::Phone => "phone",
            Self::Desktop => "desktop",
        }
    }
}

/// Per-request rendering context.
#[derive(Debug, Clone, Default)]
pub struct Ctx {
    pub lang: Lang,
    pub device: Device,
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
        }
    }

    /// This page in the other language. Chinese is the default, so it needs no parameter.
    fn other_lang_href(&self) -> String {
        let here = if self.here.is_empty() {
            "/"
        } else {
            &self.here
        };
        match self.lang.other() {
            Lang::Zh => here.to_string(),
            Lang::En => with_param(here, "lang=en"),
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
    Prices,
    Dex,
}

pub struct Page<'a> {
    pub title: &'a str,
    pub nav: Nav,
    /// `web/css/<name>.css` files loaded after `base.css`.
    pub css: &'a [&'static str],
    /// Extra `web/js/pages/<name>.js` modules after `dex.js`.
    pub scripts: &'a [&'static str],
    /// Text of the "data updated" chips; hidden when `None`.
    pub fresh: Option<String>,
    /// Kept in the desktop search box.
    pub query: &'a str,
}

pub fn layout(ctx: &Ctx, page: &Page<'_>, body: Markup) -> Markup {
    let brand = ctx.t("枫叶市集", "Maple Market");
    html! {
        (DOCTYPE)
        html lang=(ctx.lang.html_lang()) data-lang=(ctx.lang.code()) data-device=(ctx.device.attr()) data-theme="light" {
            head {
                meta charset="utf-8";
                meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover";
                meta name="color-scheme" content="light dark";
                meta name="theme-color" content="#3b5f8a";
                // Blocking initialization must run before CSS and deferred modules.
                script src="/web/js/lib/boot.js" {}
                title { (page.title) " · " (brand) }
                link rel="stylesheet" href="/web/css/base.css?v=20261024-accounts-1";
                @for name in page.css {
                    link rel="stylesheet" href={"/web/css/" (name) ".css?v=20261021-uiux-trend-2"};
                }
                script type="module" src="/web/js/pages/dex.js?v=20261024-accounts-1" {}
                @for name in page.scripts {
                    script type="module" src={"/web/js/pages/" (name) ".js?v=20261024-accounts-1"} {}
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
                                @if ctx.lang == Lang::En { input type="hidden" name="lang" value="en"; }
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
            a.iconbtn href=(ctx.other_lang_href()) data-lang-toggle=(ctx.lang.other().code()) hreflang=(ctx.lang.other().code()) aria-label=(ctx.t("切换语言 / English", "Switch language / 中文")) title=(ctx.t("切换语言 / English", "Switch language / 中文")) {
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
        ("/", ctx.t("首页", "Home"), None),
        ("/prices", ctx.t("价格表", "Prices"), Some(Nav::Prices)),
        (
            "/search?kind=item",
            ctx.t("图鉴", "Catalogue"),
            Some(Nav::Dex),
        ),
        ("/watch", ctx.t("关注", "Watch"), None),
        ("/alerts", ctx.t("捡漏", "Deals"), None),
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
        ("/", ctx.t("首页", "Home"), Icon::Home, None, "home"),
        (
            "/prices",
            ctx.t("价格表", "Prices"),
            Icon::Tag,
            Some(Nav::Prices),
            "prices",
        ),
        (
            "/search?kind=item",
            ctx.t("图鉴", "Catalogue"),
            Icon::Book,
            Some(Nav::Dex),
            "dex",
        ),
        ("/watch", ctx.t("关注", "Watch"), Icon::Star, None, "watch"),
        (
            "/alerts",
            ctx.t("捡漏", "Deals"),
            Icon::Coin,
            None,
            "alerts",
        ),
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
                    (PreEscaped(icon(glyph)))
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
/// Coin for the 捡漏 dock entry (same art as `coin` in web/js/lib/icons.js).
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
        Icon::Coin => (COIN, 24),
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
    fn device_hint() {
        assert_eq!(Device::from_mobile_hint(Some("?0")), Device::Desktop);
        assert_eq!(Device::from_mobile_hint(Some("?1")), Device::Phone);
        assert_eq!(Device::from_mobile_hint(None), Device::Phone);
    }

    #[test]
    fn theme_is_initialized_before_styles_and_page_modules() {
        let rendered = layout(
            &Ctx::default(),
            &Page {
                title: "Theme test",
                nav: Nav::Dex,
                css: &["dex"],
                scripts: &[],
                fresh: None,
                query: "",
            },
            html! { p { "Page content" } },
        )
        .into_string();
        let boot = rendered
            .find(r#"<script src="/web/js/lib/boot.js"></script>"#)
            .expect("parser-blocking theme initialization");
        assert!(boot < rendered.find(r#"rel="stylesheet""#).unwrap());
        assert!(boot < rendered.find(r#"type="module""#).unwrap());
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
        assert_eq!(en.other_lang_href(), "/route?from=1&to=2");
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

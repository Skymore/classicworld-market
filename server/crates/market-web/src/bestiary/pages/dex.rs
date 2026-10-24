//! Mob, map, route, search and error pages in the stall-panel style. All
//! lists use one row component (`.drow`) so the bestiary reads as one book.

use maud::{html, Markup, PreEscaped};

use super::shell::{icon, layout, Ctx, Icon, Nav, Page};
use super::{mob_image_url, mob_pic, mob_picture_url, slot};
use crate::bestiary::format::{grouped, meso, percent, Lang};
use crate::bestiary::model::*;
use crate::bestiary::route::{EdgeKind, HENESYS};

/// Mob shown when a search finds nothing (蘑菇仔 / Shroom).
const EMPTY_MOB: i32 = 120100;

fn dex_page(ctx: &Ctx, title: &str, query: &str, body: Markup) -> Markup {
    layout(
        ctx,
        &Page {
            title,
            nav: Nav::Dex,
            css: &["dex"],
            fresh: None,
            query,
        },
        html! { div.dwrap.dex { (body) } },
    )
}

fn crumb(ctx: &Ctx, here: &str) -> Markup {
    html! {
        nav.crumb.on-desktop aria-label=(ctx.t("位置", "Breadcrumb")) {
            a href=(ctx.href("/search")) { (ctx.t("图鉴", "Dex")) }
            (PreEscaped(icon(Icon::Chev)))
            span { (here) }
        }
    }
}

fn bar(title: &str, meta: Option<&str>) -> Markup {
    html! {
        div.stall-bar {
            h2 { (title) }
            @if let Some(meta) = meta { span.bar-meta { (meta) } }
        }
    }
}

fn well_head(title: &str, note: Option<String>) -> Markup {
    html! {
        div.well-h { h3 { (title) } @if let Some(note) = note { small { (note) } } }
    }
}

fn n_of(ctx: &Ctx, n: usize, zh_unit: &str, en_unit: &str) -> String {
    match ctx.lang {
        Lang::Zh => format!("{n} {zh_unit}"),
        Lang::En => format!("{n} {en_unit}"),
    }
}

fn empty(text: &str) -> Markup {
    html! { p.note { (text) } }
}

fn level(lv: Option<i16>) -> Markup {
    html! { @if let Some(lv) = lv { span.lv { "Lv." (lv) } } }
}

fn map_glyph() -> Markup {
    html! { span.glyph { (PreEscaped(icon(Icon::Map))) } }
}

fn mob_row(ctx: &Ctx, mob: &MobRef, right: Option<String>, sub: Option<String>) -> Markup {
    html! {
        a.drow href=(ctx.href(&format!("/mob/{}", mob.id))) {
            (mob_pic(mob.id, mob.image_id))
            span.t {
                b { (mob.names.get(ctx.lang)) } (level(mob.level))
                (super::secondary_name(&mob.names, ctx.lang))
                @if let Some(sub) = sub.filter(|s| Some(s.as_str()) != mob.names.secondary(ctx.lang)) { span.s { (sub) } }
            }
            @if let Some(right) = right { span.r { (right) } }
        }
    }
}

fn map_row(ctx: &Ctx, map: &MapRef, sub: Option<String>, right: Option<String>) -> Markup {
    html! {
        a.drow href=(ctx.href(&format!("/map/{}", map.id))) {
            (map_glyph())
            span.t {
                b { (map.names.get(ctx.lang)) }
                (super::secondary_name(&map.names, ctx.lang))
                @if let Some(sub) = sub { span.s { (sub) } }
            }
            @if let Some(right) = right { span.r { (right) } }
        }
    }
}

/// How the player takes a step.
fn edge_label(kind: EdgeKind, lang: Lang) -> &'static str {
    match kind {
        EdgeKind::Portal => lang.t("走传送口", "walk through a portal"),
        EdgeKind::Ship => lang.t("坐船", "take the ship"),
        EdgeKind::Taxi => lang.t("坐出租车", "take a taxi"),
        EdgeKind::Return => lang.t(
            "用回城卷轴（阵亡后也回到这里）",
            "use a return scroll (also where you respawn)",
        ),
    }
}

fn edge_text(kind: EdgeKind, portal: Option<&str>, lang: Lang) -> String {
    match portal {
        Some(p) => format!("{} · {p}", edge_label(kind, lang)),
        None => edge_label(kind, lang).to_string(),
    }
}

// ---------- mob ----------

pub fn mob_page(page: &MobPage, ctx: &Ctx) -> Markup {
    let mob = &page.mob;
    let lang = ctx.lang;
    let name = mob.names.get(lang);
    let stat = |v: Option<i64>| v.map_or_else(|| "—".to_string(), grouped);
    let small = |v: Option<i32>| stat(v.map(i64::from));
    let stats = [
        ("HP", "HP", stat(mob.hp)),
        ("MP", "MP", stat(mob.mp)),
        ("经验", "EXP", stat(mob.exp)),
        ("物理攻击", "Weapon ATT", small(mob.pad)),
        ("物理防御", "Weapon DEF", small(mob.pdd)),
        ("魔法攻击", "Magic ATT", small(mob.mad)),
        ("魔法防御", "Magic DEF", small(mob.mdd)),
        ("命中", "Accuracy", small(mob.acc)),
        ("回避", "Avoid", small(mob.eva)),
        ("移动速度", "Speed", small(mob.speed)),
    ];
    let body = html! {
        (crumb(ctx, name))
        section.stall {
            (bar(&format!("{} · {name}", ctx.t("怪物图鉴", "Monster")), None))
            div.ihead.mob-head {
                span.mobpic.big { @if let Some(url) = mob_picture_url(mob.id, mob.image_id) { img src=(url) alt="" loading="lazy"; } }
                div {
                    h1 { (name) }
                    @if let Some(other) = mob.names.secondary(lang) { div.en { (other) } }
                    div.tags {
                        @if let Some(lv) = mob.level { span.tagx { "Lv." (lv) } }
                        @if mob.is_boss { span.tagx.hot { (ctx.t("首领", "Boss")) } }
                        @if mob.is_undead { span.tagx { (ctx.t("不死系", "Undead")) } }
                    }
                }
            }
            dl.stats {
                @for (zh, en, value) in &stats { div { dt { (lang.t(zh, en)) } dd { (value) } } }
            }
            @if let Some(text) = &mob.description {
                div.desc { @for line in text.lines().filter(|l| !l.trim().is_empty()) { p { (line) } } }
            }
            div.dgrid {
                section.well {
                    (well_head(ctx.t("掉落", "Drops"), Some(n_of(ctx, page.drops.len(), "种", "kinds"))))
                    @for d in &page.drops { (drop_row(ctx, d)) }
                    @if page.drops.is_empty() { (empty(ctx.t("图鉴里没有这只怪物的掉落记录。", "The dex has no drops for this monster."))) }
                }
                section.well {
                    (well_head(ctx.t("出现地图", "Found in"), Some(n_of(ctx, page.spawns.len(), "张", "maps"))))
                    @for s in &page.spawns {
                        (map_row(ctx, &s.map, s.street.as_ref().map(|n| n.get(lang).to_string()), Some(spawn_points(lang, s.spawn_count))))
                    }
                    @if page.spawns.is_empty() { (empty(ctx.t("图鉴里没有这只怪物的出现地图。", "The dex has no maps for this monster."))) }
                }
            }
        }
    };
    dex_page(ctx, name, "", body)
}

fn spawn_points(lang: Lang, n: i16) -> String {
    match lang {
        Lang::Zh => format!("{n} 个刷怪点"),
        Lang::En => format!("{n} spawns"),
    }
}

fn drop_row(ctx: &Ctx, drop: &MobDrop) -> Markup {
    let lang = ctx.lang;
    let quest = drop.quest_id.map(|q| match lang {
        Lang::Zh => format!(" · 任务 #{q} 期间"),
        Lang::En => format!(" · during quest #{q}"),
    });
    let rate = html! { span.r { (percent(drop.rate_pct)) } };
    match &drop.what {
        DropTarget::Item {
            id,
            names,
            icon_url,
            typical,
            lowest_ask,
        } => html! {
            a.drow href=(ctx.href(&format!("/item/{id}"))) {
                (slot(icon_url.as_deref(), 28))
                span.t {
                    b { (names.get(lang)) }
                    (super::secondary_name(names, lang))
                    span.s {
                        @match typical {
                            Some(p) => { (ctx.t("成交 ", "typical ")) (meso(*p)) },
                            None => (ctx.t("暂无成交", "no sales yet")),
                        }
                        @if let Some(ask) = lowest_ask { (ctx.t(" · 在售最低 ", " · lowest ask ")) (meso(*ask)) }
                        @if let Some(q) = &quest { (q) }
                    }
                }
                (rate)
            }
        },
        DropTarget::Meso { min, max } => html! {
            div.drow {
                span.slot.s28.coin { (ctx.t("金", "$")) }
                span.t { b { (ctx.t("金币", "Mesos")) } span.s { (min) "–" (max) } }
                (rate)
            }
        },
        DropTarget::Unlisted { id, names } => html! {
            div.drow {
                (slot(None, 28))
                span.t {
                    b {
                        @match (names, id) {
                            (Some(names), _) => (names.get(lang)),
                            (None, Some(id)) => { (ctx.t("物品 #", "Item #")) (id) },
                            (None, None) => (ctx.t("未知物品", "Unknown item")),
                        }
                    }
                    @if let Some(names) = names { (super::secondary_name(names, lang)) }
                    span.s { (ctx.t("不在市场目录", "not in the market catalogue")) @if let Some(q) = &quest { (q) } }
                }
                (rate)
            }
        },
    }
}

// ---------- map ----------

pub fn map_page(page: &MapPage, ctx: &Ctx) -> Markup {
    let map = &page.map;
    let lang = ctx.lang;
    let name = map.names.get(lang);
    let route_href = if map.id == HENESYS {
        format!("/route?from={HENESYS}")
    } else {
        format!("/route?from={HENESYS}&to={}", map.id)
    };
    let body = html! {
        (crumb(ctx, name))
        section.stall {
            (bar(&format!("{} · {name}", ctx.t("地图", "Map")), map.street.as_ref().map(|s| s.get(lang))))
            div.ihead.solo {
                div {
                    h1 { (name) }
                    @if let Some(other) = map.names.secondary(lang) { div.en { (other) } }
                    div.tags {
                        @if let Some(street) = &map.street { span.tagx { (street.get(lang)) } }
                        @if map.is_town { span.tagx { (ctx.t("城镇", "Town")) } }
                        @if let Some(rate) = map.mob_rate { span.tagx { (ctx.t("刷怪倍率 ", "spawn rate ")) (format!("{rate:.1}")) } }
                    }
                }
            }
            div.actions {
                a.btn.primary href=(ctx.href(&route_href)) {
                    @if map.id == HENESYS { (ctx.t("从这里出发去哪", "Where to from here")) } @else { (ctx.t("从射手村怎么走", "How to get here from Henesys")) }
                }
                @if let Some(r) = &page.return_map {
                    a.btn href=(ctx.href(&format!("/map/{}", r.id))) { span { (ctx.t("回城点：", "Return town: ")) (r.names.get(lang)) (super::secondary_name(&r.names, lang)) } }
                }
            }
            @if let Some(url) = &map.minimap_url {
                img.minimap src=(url) alt={(ctx.t("小地图：", "Minimap: ")) (name)} loading="lazy";
            } @else {
                p.note.map-preview-missing { (ctx.t("暂无地图预览。下方仍可查看已收录的怪物和传送连接；暂未收录精确刷新坐标。", "Map preview unavailable. Recorded monsters and portal connections are listed below; exact spawn coordinates are not available.")) }
            }
            @if let Some(text) = &map.description {
                div.desc { @for line in text.lines().filter(|l| !l.trim().is_empty()) { p { (line) } } }
            }
            div.dgrid {
                div.dcol {
                    section.well {
                        (well_head(ctx.t("怪物", "Monsters"), Some(n_of(ctx, page.mobs.len(), "种", "kinds"))))
                        @for m in &page.mobs { (mob_row(ctx, &m.mob, Some(spawn_points(lang, m.spawn_count)), None)) }
                        @if page.mobs.is_empty() { (empty(ctx.t("这张地图没有刷怪记录。", "No monsters spawn here."))) }
                    }
                    section.well {
                        (well_head("NPC", Some(n_of(ctx, page.npcs.len(), "个", "NPCs"))))
                        @for npc in &page.npcs {
                            div.drow.plain { span.glyph { "N" } span.t { b { (npc.label(lang)) } @if let Some(names) = &npc.names { (super::secondary_name(names, lang)) } } }
                        }
                        @if page.npcs.is_empty() { (empty(ctx.t("这张地图没有 NPC 记录。", "No NPCs recorded here."))) }
                        @else if page.npcs.iter().all(|n| n.names.is_none()) {
                            (empty(ctx.t("NPC 名字还没有导入，暂时只显示编号。", "NPC names are not imported yet; showing ids.")))
                        }
                    }
                }
                div.dcol { (portals_well(ctx, page)) }
            }
        }
    };
    dex_page(ctx, name, "", body)
}

/// Exits and entrances. Towns are the return point of dozens of fields, so
/// return-scroll entrances are one line of names instead of a row each.
fn portals_well(ctx: &Ctx, page: &MapPage) -> Markup {
    let lang = ctx.lang;
    let (by_scroll, walked): (Vec<&Link>, Vec<&Link>) = page
        .entrances
        .iter()
        .partition(|l| l.kind == EdgeKind::Return);
    html! {
        section.well {
            (well_head(ctx.t("传送", "Portals"), None))
            div.sub-h { (ctx.t("从这里去", "Leads to")) }
            @for link in &page.exits { (link_row(ctx, link)) }
            @if page.exits.is_empty() { (empty(ctx.t("还没有从这里出去的连接。", "No known way out yet."))) }
            div.sub-h.ruled { (ctx.t("从这些地图过来", "Comes from")) }
            @for link in &walked { (link_row(ctx, link)) }
            @if page.entrances.is_empty() { (empty(ctx.t("还没有到这里的连接。", "No known way in yet."))) }
            @if !by_scroll.is_empty() {
                div.sub-h.ruled {
                    (ctx.t("用回城卷轴回到这里", "Return scrolls lead here from"))
                    small { (n_of(ctx, by_scroll.len(), "张地图", "maps")) }
                }
                p.townlist {
                    @for (i, link) in by_scroll.iter().enumerate() {
                        @if i > 0 { " · " }
                        a href=(ctx.href(&format!("/map/{}", link.other.id))) { (link.other.names.get(lang)) (super::secondary_name(&link.other.names, lang)) }
                    }
                }
            }
        }
    }
}

fn link_row(ctx: &Ctx, link: &Link) -> Markup {
    map_row(
        ctx,
        &link.other,
        Some(edge_text(link.kind, link.portal_name.as_deref(), ctx.lang)),
        None,
    )
}

// ---------- route ----------

pub fn route_page(page: &RoutePage, ctx: &Ctx) -> Markup {
    let body = html! {
        section.stall {
            (bar(ctx.t("怎么走", "Route"), None))
            form.route-form action="/route" method="get" {
                label.field {
                    span { (ctx.t("出发", "From")) }
                    input type="text" name="from" value=(page.from_input) placeholder=(ctx.t("地图名或 ID", "map name or id")) autocomplete="off";
                }
                label.field {
                    span { (ctx.t("目的地", "To")) }
                    input type="text" name="to" value=(page.to_input) placeholder=(ctx.t("地图名或 ID", "map name or id")) autocomplete="off";
                }
                @if ctx.lang == Lang::En { input type="hidden" name="lang" value="en"; }
                button.btn.primary type="submit" { (ctx.t("查路线", "Find route")) }
            }
            div.dbody { (route_outcome(page, ctx)) }
            p.note {
                @match ctx.lang {
                    Lang::Zh => { "路线只用已导入的连接（现有 " (page.known_edges) " 条），按步数最少找。" },
                    Lang::En => { "Routes use the imported links only (" (page.known_edges) " so far), fewest steps first." },
                }
            }
        }
    };
    dex_page(ctx, ctx.t("怎么走", "Route"), "", body)
}

fn route_outcome(page: &RoutePage, ctx: &Ctx) -> Markup {
    let lang = ctx.lang;
    match &page.outcome {
        RouteOutcome::Form => empty(ctx.t(
            "输入出发和目的地的地图名（中文或英文）或地图 ID。",
            "Enter the start and destination map names (Chinese or English) or map ids.",
        )),
        RouteOutcome::Unresolved {
            end,
            query,
            candidates,
        } => {
            let which = match end {
                RouteEnd::From => ctx.t("出发地", "start"),
                RouteEnd::To => ctx.t("目的地", "destination"),
            };
            let title = match (query.is_empty(), candidates.is_empty(), lang) {
                (true, _, Lang::Zh) => format!("请填写{which}"),
                (true, _, Lang::En) => format!("Enter a {which}"),
                (false, true, Lang::Zh) => format!("没有找到{which}「{query}」"),
                (false, true, Lang::En) => format!("No {which} matches “{query}”"),
                (false, false, Lang::Zh) => format!("{which}「{query}」有多个地图，选一个"),
                (false, false, Lang::En) => format!("Several maps match “{query}”; pick one"),
            };
            html! {
                section.well {
                    (well_head(&title, None))
                    @for c in candidates {
                        @let href = match end {
                            RouteEnd::From => route_href(&c.id.to_string(), &page.to_input),
                            RouteEnd::To => route_href(&page.from_input, &c.id.to_string()),
                        };
                        a.drow href=(ctx.href(&href)) { (map_glyph()) span.t { b { (c.names.get(lang)) } (super::secondary_name(&c.names, lang)) span.s { "ID " (c.id) } } }
                    }
                }
            }
        }
        RouteOutcome::Same(map) => html! {
            section.well {
                (well_head(ctx.t("出发地和目的地是同一张地图", "Start and destination are the same map"), None))
                (map_row(ctx, map, Some(format!("ID {}", map.id)), None))
            }
        },
        RouteOutcome::NoPath { from, to } => html! {
            section.well {
                (well_head(ctx.t("暂时查不到路线", "No route found yet"), None))
                (empty(ctx.t("已知连接里没有从出发地到目的地的路。", "The known links do not connect these maps.")))
                (map_row(ctx, from, Some(ctx.t("出发", "start").to_string()), None))
                (map_row(ctx, to, Some(ctx.t("目的地", "destination").to_string()), None))
            }
        },
        RouteOutcome::Found { from, to, steps } => html! {
            section.well {
                (well_head(
                    &format!("{} → {}", from.names.get(lang), to.names.get(lang)),
                    Some(n_of(ctx, steps.len(), "步", "steps")),
                ))
                ol.steps {
                    @for (i, step) in steps.iter().enumerate() {
                        li.step.scroll[step.kind == EdgeKind::Return] {
                            a href=(ctx.href(&format!("/map/{}", step.to.id))) {
                                span.no { (i + 1) }
                                span.t {
                                    b { (step.from.names.get(lang)) " → " (step.to.names.get(lang)) }
                                    @if step.from.names.secondary(lang).is_some() || step.to.names.secondary(lang).is_some() {
                                        span.name-secondary { (step.from.names.get(lang.other())) " → " (step.to.names.get(lang.other())) }
                                    }
                                    span.s { (edge_text(step.kind, step.portal_name.as_deref(), lang)) }
                                }
                                @if step.kind == EdgeKind::Return { span.kind { (ctx.t("回城卷轴", "scroll")) } }
                            }
                        }
                    }
                }
            }
        },
    }
}

fn route_href(from: &str, to: &str) -> String {
    format!("/route?from={}&to={}", url_encode(from), url_encode(to))
}

/// Percent-encodes everything but RFC 3986 unreserved characters.
pub(super) fn url_encode(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for b in text.bytes() {
        if b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'.' | b'~') {
            out.push(char::from(b));
        } else {
            out.push_str(&format!("%{b:02X}"));
        }
    }
    out
}

// ---------- search ----------

pub fn search_page(page: &SearchPage, ctx: &Ctx) -> Markup {
    let q = page.query.as_str();
    let lang = ctx.lang;
    let nothing =
        page.items.rows.is_empty() && page.mobs.rows.is_empty() && page.maps.rows.is_empty();
    let meta = (!q.is_empty()).then(|| format!("“{q}”"));
    let body = html! {
        section.stall {
            (bar(ctx.t("搜索", "Search"), meta.as_deref()))
            form.finder.in-page id="catalog-search" action="/search" method="get" role="search" {
                (PreEscaped(icon(Icon::Search)))
                input type="search" name="q" value=(q) placeholder=(ctx.t("搜索物品、怪物、地图", "Search items, monsters, maps"))
                    aria-label=(ctx.t("搜索", "Search")) autocomplete="off";
                @if let Some(kind) = page.kind { input type="hidden" name="kind" value=(kind.key()); }
                @if lang == Lang::En { input type="hidden" name="lang" value="en"; }
            }
            div data-search-results aria-live="polite" {
            (kind_chips(page, ctx))
            (search_pagination(page,ctx))
            div.dbody {
                @if page.kind.is_none() && !q.is_empty() { (place_filters(page,ctx)) }
                @if nothing {
                    @if page.kind.is_none() || page.kind == Some(SearchKind::Item) {
                        section.well id="search-item" {
                            (well_head(ctx.t("物品","Items"), Some(ctx.t("0 个","0 found").into())))
                            (catalog_filters(page,ctx))
                        }
                    }
                    @if page.kind == Some(SearchKind::Mob) || page.kind == Some(SearchKind::Map) {
                        section.well {
                            (well_head(if page.kind==Some(SearchKind::Map) {ctx.t("地图","Maps")} else {ctx.t("怪物","Monsters")},Some(ctx.t("本页 0","This page: 0").into())))
                            (place_filters(page,ctx))
                        }
                    }
                    (empty_state(ctx, &match lang {
                        _ if q.is_empty() && (!page.region.is_empty() || !page.area.is_empty()) => ctx.t("这个地区暂无匹配的记录，请调整地区或区域。", "No matching records in this location. Try another region or area.").to_string(),
                        _ if q.is_empty() && !page.filters.query().is_empty() => ctx.t("没有符合筛选条件的物品，请调整或重置筛选。", "No items match these filters. Adjust or reset the filters.").to_string(),
                        _ if q.is_empty() => ctx.t("暂无图鉴数据。", "No catalogue data yet.").to_string(),
                        Lang::Zh => format!("没有找到「{q}」。换个字试试，比如只输入名字的一部分。"),
                        Lang::En => format!("Nothing matches “{q}”. Try part of the name."),
                    }))
                } @else {
                    (hits_well(ctx, SearchKind::Item, !q.is_empty() || page.kind == Some(SearchKind::Item), ctx.t("物品", "Items"), &page.items, Some(catalog_filters(page,ctx)), |hit: &ItemHit| html! {
                        a.drow href=(ctx.href(&format!("/item/{}", hit.id))) {
                            (slot(hit.icon_url.as_deref(), 28))
                            span.t {
                                b { (hit.names.get(lang)) }
                                @if let Some(level)=hit.level.filter(|_| hit.id/1_000_000==1) { span.lv { (ctx.t("等级 ","Lv. ")) (level) } }
                                span.s {
                                    @if let Some(other) = hit.names.secondary(lang) { (other) }
                                    @if let Some(sub) = hit.subcategory.as_ref().filter(|_| lang == Lang::Zh) { " · " (sub) }
                                }
                            }
                        }
                    }))
                    (hits_well(ctx, SearchKind::Mob, !q.is_empty(), ctx.t("怪物", "Monsters"), &page.mobs, (page.kind==Some(SearchKind::Mob)).then(||place_filters(page,ctx)), |mob: &MobRef| {
                        mob_row(ctx, mob, None, mob.names.secondary(lang).map(str::to_string))
                    }))
                    (hits_well(ctx, SearchKind::Map, !q.is_empty(), ctx.t("地图", "Maps"), &page.maps, (page.kind==Some(SearchKind::Map)).then(||place_filters(page,ctx)), |map: &MapHit| html! {
                        a.drow href=(ctx.href(&format!("/map/{}", map.id))) {
                            (map_glyph())
                            span.t {
                                b { (map.names.get(lang)) }
                                (super::secondary_name(&map.names, lang))
                                @if let Some(street) = &map.street { span.s { (street.get(lang)) } }
                            }
                        }
                    }))
                }
            }
            (search_pagination(page,ctx))
            }
        }
    };
    dex_page(
        ctx,
        if q.is_empty() {
            ctx.t("搜索", "Search")
        } else {
            q
        },
        q,
        body,
    )
}

fn search_pagination(page: &SearchPage, ctx: &Ctx) -> Markup {
    if page.offset == 0 && !page.items.more && !page.mobs.more && !page.maps.more {
        return html! {};
    }
    let q = page.query.as_str();
    html! {
            @let size = if page.kind.is_some() { 60 } else { 20 };
            @let number = page.offset / size + 1;
            @let link = |n| {
                let kind = page.kind.map(|k| format!("&kind={}", k.key())).unwrap_or_default();
                ctx.href(&format!("/search?q={}&page={n}{kind}{}{}", url_encode(q), page.filters.query(), place_query(page)))
            };
            nav.chips.kinds aria-label=(ctx.t("分页", "Pagination")) {
                @if number > 1 { a.chip href=(link(number-1)) { (ctx.t("上一页", "Previous")) } }
                span.chip { (ctx.t("第", "Page")) " " (number) }
                @if page.items.more || page.mobs.more || page.maps.more {
                    a.chip href=(link(number+1)) { (ctx.t("下一页", "Next")) }
                }
            }
    }
}

fn empty_state(ctx: &Ctx, text: &str) -> Markup {
    html! {
        div.empty {
            img src=(mob_image_url(EMPTY_MOB)) alt="" loading="lazy";
            p { (text) }
            @if ctx.lang == Lang::Zh { p.hint { "试试：蜗牛、射手村、铁矿石" } } @else { p.hint { "Try: snail, Henesys, iron ore" } }
        }
    }
}

fn place_query(page: &SearchPage) -> String {
    let mut out = String::new();
    if !page.region.is_empty() {
        out.push_str(&format!("&region={}", url_encode(&page.region)));
    }
    if !page.area.is_empty() {
        out.push_str(&format!("&area={}", url_encode(&page.area)));
    }
    out
}

fn place_filters(page: &SearchPage, ctx: &Ctx) -> Markup {
    html! {
        div.place-tools {
            @if page.kind.is_none() { span.place-scope { (ctx.t("地图／怪物地区","Map / monster location")) } }
            label { (ctx.t("地区","Region"))
                select name="region" form="catalog-search" {
                    option value="" selected[page.region.is_empty()] { (ctx.t("全部地区","All regions")) }
                    @for (key,zh,en) in super::super::regions::REGIONS {
                        option value=(key) selected[page.region==*key] { (ctx.t(zh,en)) }
                    }
                }
            }
            label { (ctx.t("区域","Area"))
                select name="area" form="catalog-search" disabled[page.region.is_empty()] {
                    option value="" selected[page.area.is_empty()] { (if page.region.is_empty() {ctx.t("先选地区","Choose a region first")} else {ctx.t("全部区域","All areas")}) }
                    @for area in &page.areas {
                        @if !page.region.is_empty() && area.region==page.region {
                            option value=(&area.key) selected[page.area==area.key] { (area.names.get(ctx.lang)) }
                        }
                    }
                }
            }
            button.chip type="button" data-place-reset { (ctx.t("重置","Reset")) }
            @if page.kind != Some(SearchKind::Map) {
                small.place-hint { (ctx.t("怪物按刷新地图筛选；没有地图记录的怪物仅在全部地区显示。","Monsters match their recorded spawn maps. Monsters without map records appear only under all regions.")) }
            }
        }
    }
}

fn catalog_filters(page: &SearchPage, ctx: &Ctx) -> Markup {
    let f = &page.filters;
    let categories = [
        ("", ctx.t("全部", "All")),
        ("equip", ctx.t("装备 EQUIP", "EQUIP")),
        ("use", ctx.t("消耗 USE", "USE")),
        ("setup", ctx.t("装饰 SETUP", "SETUP")),
        ("etc", ctx.t("其他 ETC", "ETC")),
        ("cash", ctx.t("商城 CASH", "CASH")),
    ];
    let jobs = [
        (0, ctx.t("所有职业", "All jobs")),
        (1, ctx.t("战士", "Warrior")),
        (2, ctx.t("魔法师", "Magician")),
        (4, ctx.t("弓箭手", "Bowman")),
        (8, ctx.t("飞侠", "Thief")),
        (16, ctx.t("海盗", "Pirate")),
    ];
    let active = f.job != 0 || f.min_level.is_some() || f.max_level.is_some();
    html! {
        div.catalogue-tools {
            div.catalogue-cats role="group" aria-label=(ctx.t("物品分类","Item category")) {
                @for (value,label) in categories {
                    label { input type="radio" name="cat" value=(value) form="catalog-search" checked[f.cat==value]; span { (label) } }
                }
            }
            details.catalogue-filter open[active] {
                summary { (ctx.t("筛选","Filters")) span data-filter-summary { @if active { " ●" } } }
                div.catalogue-panel {
                    label { (ctx.t("适用职业","Job")) select name="job" form="catalog-search" {
                        @for (value,label) in jobs { option value=(value) selected[f.job==value] { (label) } }
                    } }
                    div.catalogue-levels {
                        label { (ctx.t("最低等级","Min level")) input type="number" name="min_level" form="catalog-search" min="0" max="300" value=(f.min_level.map(|n|n.to_string()).unwrap_or_default()) placeholder="0"; }
                        span { "–" }
                        label { (ctx.t("最高等级","Max level")) input type="number" name="max_level" form="catalog-search" min="0" max="300" value=(f.max_level.map(|n|n.to_string()).unwrap_or_default()) placeholder=(ctx.t("不限","Any")); }
                    }
                    div.catalogue-presets {
                        @for (lo,hi) in [(1,20),(21,30),(31,50),(51,70),(71,120)] {
                            button.chip type="button" data-catalog-levels=(format!("{lo},{hi}")) { (lo) "–" (hi) }
                        }
                        button.chip type="button" data-catalog-reset { (ctx.t("重置筛选","Reset filters")) }
                    }
                    p.fnote { (ctx.t("职业和等级筛选仅适用于装备，包含该职业可用的通用装备。","Job and level filters apply to equipment, including gear usable by all jobs.")) }
                }
            }
        }
    }
}

/// Three browse categories; during search these jump to the matching result group.
fn kind_chips(page: &SearchPage, ctx: &Ctx) -> Markup {
    let searching = !page.query.is_empty();
    let chips = [
        (SearchKind::Item, ctx.t("物品", "Items")),
        (SearchKind::Mob, ctx.t("怪物", "Monsters")),
        (SearchKind::Map, ctx.t("地图", "Maps")),
    ];
    html! {
        nav.chips.kinds aria-label=(ctx.t("结果类型", "Result type")) {
            @for (kind, label) in chips {
                @let href = if searching {
                    format!("#search-{}", kind.key())
                } else {
                    ctx.href(&format!("/search?kind={}{}", kind.key(), place_query(page)))
                };
                @let on = !searching && kind == page.kind.unwrap_or(SearchKind::Item);
                a.chip.on[on] href=(href) aria-current=[on.then_some("page")] { (label) }
            }
        }
    }
}

fn hits_well<T>(
    ctx: &Ctx,
    kind: SearchKind,
    show_empty: bool,
    title: &str,
    hits: &Hits<T>,
    controls: Option<Markup>,
    row: impl Fn(&T) -> Markup,
) -> Markup {
    html! {
        @if show_empty || !hits.rows.is_empty() {
            section.well id={"search-" (kind.key())} {
                (well_head(title, Some(format!("{} {}{}",ctx.t("本页","This page:"),hits.rows.len(),if hits.more { "+" } else { "" }))))
                @if let Some(controls)=controls { (controls) }
                @if !hits.rows.is_empty() {
                    div.catalogue-grid { @for hit in &hits.rows { (row(hit)) } }
                }
                @if hits.rows.is_empty() { p.note { (ctx.t("没有匹配结果。", "No matches.")) } }
                @if hits.more {
                    p.note {
                        (ctx.t("还有更多结果，可翻到下一页。", "More results on the next page."))
                    }
                }
            }
        }
    }
}

// ---------- errors ----------

pub fn not_found_page(what_zh: &str, what_en: &str, ctx: &Ctx) -> Markup {
    let body = html! {
        section.stall {
            (bar(ctx.t("没有找到", "Not found"), None))
            div.dbody {
                (empty_state(ctx, &match ctx.lang {
                    Lang::Zh => format!("没有这个{what_zh}。可能编号写错了，或者图鉴还没收录。可以用搜索找。"),
                    Lang::En => format!("No such {what_en}. The id may be wrong, or the dex does not have it yet. Try search."),
                }))
            }
        }
    };
    dex_page(ctx, ctx.t("没有找到", "Not found"), "", body)
}

pub fn error_page(ctx: &Ctx) -> Markup {
    let body = html! {
        section.stall {
            (bar(ctx.t("出错了", "Error"), None))
            div.dbody { (empty(ctx.t("服务器暂时出错，请稍后再试。", "The server had a problem. Please try again later."))) }
        }
    };
    dex_page(ctx, ctx.t("出错了", "Error"), "", body)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn category_chips_have_no_all_tab_and_search_links_jump_to_groups() {
        let ctx = Ctx::default();
        let browse = kind_chips(&SearchPage::default(), &ctx).into_string();
        assert_eq!(browse.matches("<a ").count(), 3);
        assert!(!browse.contains("全部"));
        assert!(browse.contains("/search?kind=item"));
        let page = SearchPage {
            query: "蜗牛".into(),
            ..Default::default()
        };
        let search = kind_chips(&page, &ctx).into_string();
        for kind in ["item", "mob", "map"] {
            assert!(search.contains(&format!("href=\"#search-{kind}\"")));
        }
    }

    #[test]
    fn url_encoding() {
        assert_eq!(url_encode("射手村"), "%E5%B0%84%E6%89%8B%E6%9D%91");
        assert_eq!(url_encode("a b&c=d"), "a%20b%26c%3Dd");
    }

    #[test]
    fn edge_labels() {
        assert_eq!(
            edge_text(EdgeKind::Portal, Some("east00"), Lang::Zh),
            "走传送口 · east00"
        );
        assert!(edge_label(EdgeKind::Return, Lang::Zh).starts_with("用回城卷轴"));
    }
}

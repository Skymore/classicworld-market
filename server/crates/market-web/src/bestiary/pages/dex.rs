//! Mob, map, route, search and error pages in the stall-panel style. All
//! lists use one row component (`.drow`) so the bestiary reads as one book.

use maud::{html, Markup, PreEscaped};

use super::mapview::{map_svg, mob_legend, Marks};
use super::shell::{icon, layout, Ctx, Icon, Nav, Page};
use super::worldmap::{levels, list_world, route_overview, spot_levels};
use super::{mob_image_url, mob_pic, mob_picture_url, slot};
use crate::bestiary::format::{grouped, meso, Lang};
use crate::bestiary::model::*;
use crate::bestiary::route::{EdgeKind, HENESYS};

/// Mob shown when a search finds nothing (蘑菇仔 / Shroom).
const EMPTY_MOB: i32 = 120100;
/// Drops listed before "show all"; the browser page uses the same count.
const DROPS_SHOWN: usize = 10;

/// A description line that only repeats the level ("等级：8").
fn is_level_line(line: &str) -> bool {
    let rest = line.trim().strip_prefix("等级");
    rest.and_then(|r| r.strip_prefix('：').or_else(|| r.strip_prefix(':')))
        .is_some_and(|n| !n.trim().is_empty() && n.trim().chars().all(|c| c.is_ascii_digit()))
}

/// Rounded unit prices: arrows and other bundle items cost under 1 meso each.
fn unit_meso(value: i64, lang: Lang) -> String {
    if value < 1 {
        "<1".to_string()
    } else {
        meso(value, lang)
    }
}

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
        Lang::En | Lang::Ko => format!("{n} {en_unit}"),
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

/// Portal names (east00, dun00) are internal map data, so only the way of travel is shown.
fn edge_text(kind: EdgeKind, _portal: Option<&str>, lang: Lang) -> String {
    edge_label(kind, lang).to_string()
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
            @if !page.spawns.is_empty() {
                div.actions {
                    a.btn.primary href=(ctx.href(&format!("/route?from={HENESYS}&mob={}", mob.id))) {
                        (ctx.t("从射手村去最近的刷怪地图", "Nearest spawn map from Henesys"))
                    }
                }
            }
            dl.stats {
                @for (zh, en, value) in &stats { div { dt { (lang.t(zh, en)) } dd { (value) } } }
            }
            @if let Some(text) = &mob.description {
                // "等级：8" repeats the Lv. badge above.
                div.desc { @for line in text.lines().filter(|l| !l.trim().is_empty() && !is_level_line(l)) { p { (line) } } }
            }
            div.dgrid {
                section.well {
                    (well_head(ctx.t("掉落", "Drops"), Some(n_of(ctx, page.drops.len(), "种", "kinds"))))
                    // The first ten (mesos and priced drops lead); the browser page expands the rest.
                    @for (i, d) in page.drops.iter().enumerate() {
                        @if i < DROPS_SHOWN { (drop_row(ctx, d)) } @else { div.extra { (drop_row(ctx, d)) } }
                    }
                    @if page.drops.len() > DROPS_SHOWN {
                        button.more type="button" data-more="drops" {
                            (match lang { Lang::Zh => format!("显示全部 {} 种", page.drops.len()), Lang::En | Lang::Ko => format!("Show all {}", page.drops.len()) })
                        }
                    }
                    @if page.drops.is_empty() { (empty(ctx.t("还没有玩家确认这只怪物的掉落。", "No player has confirmed a drop for this monster yet."))) }
                }
                section.well {
                    (well_head(ctx.t("出现地图", "Found in"), Some(n_of(ctx, page.spawns.len(), "张", "maps"))))
                    @for (i, s) in page.spawns.iter().enumerate() {
                        @let row = map_row(ctx, &s.map, s.street.as_ref().map(|n| n.get(lang).to_string()), Some(spawn_points(lang, s.spawn_count)));
                        @if i < DROPS_SHOWN { (row) } @else { div.extra { (row) } }
                    }
                    @if page.spawns.len() > DROPS_SHOWN {
                        button.more type="button" data-more="spawns" {
                            (match lang { Lang::Zh => format!("显示全部 {} 张", page.spawns.len()), Lang::En | Lang::Ko => format!("Show all {}", page.spawns.len()) })
                        }
                    }
                    @if page.spawns.is_empty() { (empty(ctx.t("图鉴里没有这只怪物的出现地图。", "The dex has no maps for this monster."))) }
                }
                @if !page.quests.is_empty() {
                    section.well {
                        (well_head(ctx.t("相关任务", "Quests"), Some(super::item::quest_count(lang, page.quests.len()))))
                        (super::quest_needs(lang, &page.quests, true))
                    }
                }
            }
        }
    };
    dex_page(ctx, name, "", body)
}

fn spawn_points(lang: Lang, n: i16) -> String {
    match lang {
        Lang::Zh => format!("{n} 个刷怪点"),
        Lang::En | Lang::Ko => format!("{n} spawns"),
    }
}

fn drop_row(ctx: &Ctx, drop: &MobDrop) -> Markup {
    let lang = ctx.lang;
    let quest = drop.quest_id.map(|q| match lang {
        Lang::Zh => format!(" · 任务 #{q} 期间"),
        Lang::En | Lang::Ko => format!(" · during quest #{q}"),
    });
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
                            Some(p) => { (ctx.t("成交价 ", "typical ")) (unit_meso(*p, lang)) },
                            None => (ctx.t("暂无成交", "no sales yet")),
                        }
                        @if let Some(ask) = lowest_ask { (ctx.t(" · 在售最低 ", " · lowest ask ")) (unit_meso(*ask, lang)) }
                        @if let Some(q) = &quest { (q) }
                    }
                }
            }
        },
        DropTarget::Meso { min, max } => html! {
            div.drow {
                span.slot.s28.coin { (ctx.t("金", "$")) }
                span.t { b { (ctx.t("金币", "Mesos")) } span.s { (min) "–" (max) } }
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
            div.actions.map-actions {
                a.btn.primary href=(ctx.href(&route_href)) {
                    @if map.id == HENESYS { span { (ctx.t("从这里出发去哪", "Where to from here")) } }
                    @else { (fit_label(ctx.t("从射手村怎么走", "How to get here from Henesys"), ctx.t("从射手村怎么走", "Route here"))) }
                }
                @if let Some(r) = &page.return_map {
                    a.btn.rtown href=(ctx.href(&format!("/map/{}", r.id))) { small { (ctx.t("回城点", "Return town")) } span { (r.names.get(lang)) } }
                }
                @if let Some(spot) = &page.world_spot {
                    a.btn href=(ctx.href(&format!("/search?kind=map&spot={}", url_encode(spot)))) { (fit_label(ctx.t("在世界地图上看", "On the world map"), ctx.t("世界地图", "World map"))) }
                }
            }
            @if let Some(path) = &page.from_henesys { (henesys_strip(ctx, path, &route_href)) }
            @if let Some(view) = &page.view {
                figure.mapvis {
                    (map_svg(ctx, view, name, &Marks { mobs: &page.mobs, links: true, ..Marks::default() }))
                    @if !view.spawns.is_empty() { (mob_legend(ctx, &page.mobs)) }
                }
            } @else if let Some(url) = &map.minimap_url {
                img.minimap src=(url) alt={(ctx.t("小地图：", "Minimap: ")) (name)} loading="lazy";
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
                            a.drow href=(ctx.href(&format!("/npc/{}", npc.id))) { span.glyph { "N" } span.t { b { (npc.label(lang)) } @if let Some(names) = &npc.names { (super::secondary_name(names, lang)) } } }
                        }
                        @if page.npcs.is_empty() { (empty(ctx.t("这张地图没有 NPC 记录。", "No NPCs recorded here."))) }
                    }
                }
                div.dcol {
                    (portals_well(ctx, page))
                    @if !page.quests_given.is_empty() || !page.quests_hunted.is_empty() {
                        section.well {
                            (well_head(ctx.t("任务", "Quests"), None))
                            @if !page.quests_given.is_empty() {
                                div.sub-h { (ctx.t("在这里接", "Given here")) small { (super::item::quest_count(lang, page.quests_given.len())) } }
                                (super::quest_list(lang, &page.quests_given, true))
                            }
                            @if !page.quests_hunted.is_empty() {
                                div.sub-h.ruled[!page.quests_given.is_empty()] { (ctx.t("要打这里的怪", "Hunt monsters here")) small { (super::item::quest_count(lang, page.quests_hunted.len())) } }
                                (super::quest_hunts(lang, &page.quests_hunted))
                            }
                        }
                    }
                }
            }
        }
    };
    dex_page(ctx, name, "", body)
}

/// A link label with a shorter wording for phones (dex.css `.map-actions`);
/// one span when the two are the same.
fn fit_label(long: &str, short: &str) -> Markup {
    html! {
        @if long == short { span { (long) } } @else { span.long { (long) } span.short { (short) } }
    }
}

/// "射手村 → … → here · 5 步", linking to the route page.
fn henesys_strip(ctx: &Ctx, path: &[MapRef], route_href: &str) -> Markup {
    let lang = ctx.lang;
    let hops = path.len().saturating_sub(1);
    html! {
        a.route-strip href=(ctx.href(route_href)) {
            span.rs-h { (ctx.t("从射手村过来", "From Henesys")) small { (n_of(ctx, hops, "步", "steps")) } }
            span.rs-path {
                @for (i, map) in path.iter().enumerate() {
                    @if i > 0 { span.rs-arrow { "→" } }
                    span.rs-stop.last[i + 1 == path.len()] { (map.names.get(lang)) }
                }
            }
        }
    }
}

// ---------- NPC ----------

pub fn npc_page(page: &NpcPage, ctx: &Ctx) -> Markup {
    let lang = ctx.lang;
    let name = page.npc.label(lang);
    let body = html! {
        (crumb(ctx, &name))
        section.stall {
            (bar(&format!("NPC · {name}"), None))
            div.ihead.solo {
                div {
                    h1 { (name) }
                    @if let Some(other) = page.npc.names.as_ref().and_then(|n| n.secondary(lang)) { div.en { (other) } }
                }
            }
            div.dgrid {
                div.dcol {
                    section.well {
                        (well_head(ctx.t("在哪里", "Where"), Some(n_of(ctx, page.places.len(), "张地图", "maps"))))
                        @for place in &page.places {
                            (map_row(ctx, &place.map, None, None))
                            @if let Some(view) = &place.view {
                                figure.mapvis.compact {
                                    (map_svg(ctx, view, place.map.names.get(lang), &Marks { npc: Some(page.npc.id), links: true, ..Marks::default() }))
                                }
                            }
                        }
                        @if page.places.is_empty() { (empty(ctx.t("图鉴里没有这个 NPC 的位置。", "The dex has no location for this NPC."))) }
                    }
                }
                div.dcol {
                    section.well {
                        (well_head(ctx.t("任务", "Quests"), Some(super::item::quest_count(lang, page.quests.len()))))
                        (super::quest_list(lang, &page.quests, false))
                        @if page.quests.is_empty() { (empty(ctx.t("这个 NPC 不给任务。", "This NPC gives no quests."))) }
                    }
                    @if !page.shop.is_empty() {
                        section.well {
                            (well_head(ctx.t("商店", "Shop"), Some(n_of(ctx, page.shop.len(), "种", "items"))))
                            @for item in &page.shop {
                                a.drow href=(ctx.href(&format!("/item/{}", item.id))) {
                                    (slot(item.icon_url.as_deref(), 28))
                                    span.t { b { (item.names.get(lang)) } (super::secondary_name(&item.names, lang)) }
                                    span.r { (meso(item.price, lang)) }
                                }
                            }
                        }
                    }
                }
            }
        }
    };
    dex_page(ctx, &name, "", body)
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
    let taxi = if page.taxi { "&taxi=1" } else { "" };
    let map_tab = format!("{}{taxi}", route_href(&page.from_input, &page.to_input));
    let mob_tab = format!(
        "/route?mode=mob&from={}{taxi}",
        url_encode(&page.from_input)
    );
    let body = html! {
        section.stall {
            (bar(ctx.t("怎么走", "Route"), None))
            nav.route-tabs aria-label=(ctx.t("寻路方式", "Route mode")) {
                a.on[!page.mob_mode] href=(ctx.href(&map_tab)) { (ctx.t("去地图", "To a map")) }
                a.on[page.mob_mode] href=(ctx.href(&mob_tab)) { (ctx.t("找怪物", "Find a monster")) }
            }
            form.route-form action="/route" method="get" {
                div.place-field {
                    label.field {
                        span { (ctx.t("出发", "From")) }
                        input type="text" name="from" value=(page.from_input) placeholder=(ctx.t("地图名或 ID（默认射手村）", "map name or id (Henesys)")) autocomplete="off";
                    }
                }
                @if page.mob_mode {
                    div.place-field {
                        label.field {
                            span { (ctx.t("怪物", "Monster")) }
                            input type="text" name="mob" value=(page.mob_input) placeholder=(ctx.t("怪物名或 ID", "monster name or id")) autocomplete="off";
                        }
                    }
                    input type="hidden" name="mode" value="mob";
                } @else {
                    div.place-field {
                        label.field {
                            span { (ctx.t("目的地", "To")) }
                            input type="text" name="to" value=(page.to_input) placeholder=(ctx.t("地图名或 ID", "map name or id")) autocomplete="off";
                        }
                    }
                }
                label.check {
                    input type="checkbox" name="taxi" value="1" checked[page.taxi];
                    span { (ctx.t("可以坐出租车", "Allow taxis")) }
                }
                @if ctx.lang != Lang::Zh { input type="hidden" name="lang" value=(ctx.lang.code()); }
                button.btn.primary type="submit" {
                    @if page.mob_mode { (ctx.t("找最近的地图", "Find the nearest map")) } @else { (ctx.t("查路线", "Find route")) }
                }
            }
            div.dbody { (route_outcome(page, ctx)) }
        }
    };
    dex_page(ctx, ctx.t("怎么走", "Route"), "", body)
}

/// Whether a route step draws its map view.
fn step_shows_map(step: &Step) -> bool {
    step.view.is_some() && (step.exit.is_some() || step.kind != EdgeKind::Portal)
}

fn steps_list(ctx: &Ctx, steps: &[Step]) -> Markup {
    let lang = ctx.lang;
    // Only the first map loads its scene with the page; the rest show their
    // empty background until they near the screen (`Steps` in catalogue.tsx).
    let first_map = steps.iter().position(step_shows_map);
    html! {
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
                            span.s { (step_hint(ctx, step)) }
                        }
                        @if step.kind == EdgeKind::Return { span.kind { (ctx.t("回城卷轴", "scroll")) } }
                    }
                    @if let (Some(view), true) = (&step.view, step_shows_map(step)) {
                        figure.mapvis.step-map {
                            (map_svg(ctx, view, step.from.names.get(lang), &Marks { exit: step.exit, arrival: step.arrival, exit_npc: step.npc.is_some(), defer_scene: first_map != Some(i), ..Marks::default() }))
                        }
                    }
                }
            }
        }
    }
}

fn route_outcome(page: &RoutePage, ctx: &Ctx) -> Markup {
    let lang = ctx.lang;
    match &page.outcome {
        RouteOutcome::Form => html! {},
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
                (true, _, Lang::En | Lang::Ko) => format!("Enter a {which}"),
                (false, true, Lang::Zh) => format!("没有找到{which}「{query}」"),
                (false, true, Lang::En | Lang::Ko) => format!("No {which} matches “{query}”"),
                (false, false, Lang::Zh) => format!("{which}「{query}」有多个地图，选一个"),
                (false, false, Lang::En | Lang::Ko) => format!("Several maps match “{query}”; pick one"),
            };
            html! {
                section.well {
                    (well_head(&title, None))
                    @for c in candidates {
                        @let id = c.map.id;
                        @let href = match (end, page.mob_mode) {
                            (RouteEnd::From, true) => format!("/route?from={id}&mob={}", url_encode(&page.mob_input)),
                            (RouteEnd::From, false) => route_href(&id.to_string(), &page.to_input),
                            (RouteEnd::To, _) => route_href(&page.from_input, &id.to_string()),
                        };
                        @let hint = c.hint.as_ref().and_then(|h| h.get(lang));
                        a.drow href=(ctx.href(&href)) {
                            (map_glyph())
                            span.t {
                                b { (c.map.names.get(lang)) }
                                (super::secondary_name(&c.map.names, lang))
                                @if let Some(hint) = hint { span.s { (hint) } } @else { span.s { "ID " (id) } }
                            }
                        }
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
        RouteOutcome::Found {
            from,
            to,
            steps,
            overview,
        } => html! {
            section.well {
                (well_head(
                    &format!("{} → {}", from.names.get(lang), to.names.get(lang)),
                    Some(n_of(ctx, steps.len(), "步", "steps")),
                ))
                @if let Some(o) = overview { (route_overview(ctx, o)) }
                (steps_list(ctx, steps))
            }
        },
        RouteOutcome::MobUnresolved { query, candidates } => {
            let title = match (candidates.is_empty(), lang) {
                (true, Lang::Zh) => format!("没有找到怪物「{query}」"),
                (true, Lang::En | Lang::Ko) => format!("No monster matches “{query}”"),
                (false, Lang::Zh) => format!("「{query}」有多只怪物，选一只"),
                (false, Lang::En | Lang::Ko) => format!("Several monsters match “{query}”; pick one"),
            };
            html! {
                section.well {
                    (well_head(&title, None))
                    @for mob in candidates {
                        @let href = format!("/route?from={}&mob={}", url_encode(&page.from_input), mob.id);
                        a.drow href=(ctx.href(&href)) {
                            (super::mob_pic(mob.id, mob.image_id))
                            span.t { b { (mob.names.get(lang)) } (level(mob.level)) (super::secondary_name(&mob.names, lang)) }
                        }
                    }
                }
            }
        }
        RouteOutcome::MobNoPath { from, mob } => html! {
            section.well {
                (well_head(ctx.t("暂时查不到路线", "No route found yet"), None))
                (empty(&match lang {
                    Lang::Zh => format!("从{}到不了有{}的开放地图。", from.names.get(lang), mob.names.get(lang)),
                    Lang::En | Lang::Ko => format!("No open map with {} can be reached from {}.", mob.names.get(lang), from.names.get(lang)),
                }))
                (mob_row(ctx, mob, None, None))
            }
        },
        RouteOutcome::MobFound {
            from,
            mob,
            to,
            steps,
            overview,
            places,
        } => html! {
            section.well {
                (well_head(
                    &match lang {
                        Lang::Zh => format!("{} → 最近的{}：{}", from.names.get(lang), mob.names.get(lang), to.names.get(lang)),
                        Lang::En | Lang::Ko => format!("{} → nearest {}: {}", from.names.get(lang), mob.names.get(lang), to.names.get(lang)),
                    },
                    Some(n_of(ctx, steps.len(), "步", "steps")),
                ))
                @if steps.is_empty() {
                    (empty(&match lang {
                        Lang::Zh => format!("{}就在出发地图上。", mob.names.get(lang)),
                        Lang::En | Lang::Ko => format!("{} spawns right on the start map.", mob.names.get(lang)),
                    }))
                }
                @if let Some(o) = overview { (route_overview(ctx, o)) }
                (steps_list(ctx, steps))
            }
            section.well {
                (well_head(
                    &match lang {
                        Lang::Zh => format!("{}的刷怪地图", mob.names.get(lang)),
                        Lang::En | Lang::Ko => format!("Where {} spawns", mob.names.get(lang)),
                    },
                    Some(n_of(ctx, places.len(), "张", "maps")),
                ))
                @for place in places {
                    @let right = match (place.steps, lang) {
                        (Some(n), Lang::Zh) => format!("{n} 步 · {}", spawn_points(lang, place.spawn_count)),
                        (Some(n), Lang::En | Lang::Ko) => format!("{n} steps · {}", spawn_points(lang, place.spawn_count)),
                        (None, _) => format!("{} · {}", ctx.t("到不了", "unreachable"), spawn_points(lang, place.spawn_count)),
                    };
                    a.drow.here[place.map.id == to.id] href=(ctx.href(&route_href(&from.id.to_string(), &place.map.id.to_string()))) {
                        (map_glyph())
                        span.t { b { (place.map.names.get(lang)) } (super::secondary_name(&place.map.names, lang)) }
                        span.r { (right) }
                    }
                }
            }
        },
    }
}

/// What to do on this step, pointing at the minimap when the portal is marked.
fn step_hint(ctx: &Ctx, step: &Step) -> String {
    let lang = ctx.lang;
    let npc = step.npc.as_ref().map(|n| n.label(lang));
    match (step.kind, step.exit.is_some(), npc) {
        (EdgeKind::Portal, true, _) if step.exit_hidden => ctx
            .t(
                "走圈出的隐藏传送口（游戏里看不到，站在圈里按↑）",
                "take the circled hidden portal (not drawn in game; stand in the circle and press up)",
            )
            .to_string(),
        (EdgeKind::Portal, true, _) => ctx
            .t("走地图上圈出的传送口", "take the circled portal on the map")
            .to_string(),
        (EdgeKind::Ship, _, Some(npc)) => match lang {
            Lang::Zh => format!("找圈出的{npc}坐船"),
            Lang::En | Lang::Ko => format!("take the ship with {npc}, circled"),
        },
        (EdgeKind::Taxi, _, Some(npc)) => match lang {
            Lang::Zh => format!("找圈出的{npc}坐出租车"),
            Lang::En | Lang::Ko => format!("take the taxi with {npc}, circled"),
        },
        (kind, _, _) => edge_text(kind, step.portal_name.as_deref(), lang),
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

/// The search page's own URL as key/value pairs: the query, the kind and the
/// kind's normalized filters. Links edit a copy.
fn search_pairs(page: &SearchPage) -> Vec<(String, String)> {
    let mut out = Vec::new();
    if !page.query.is_empty() {
        out.push(("q".into(), page.query.clone()));
    }
    if let Some(kind) = page.kind {
        out.push(("kind".into(), kind.key().into()));
    }
    let filters = match page.kind {
        Some(SearchKind::Item) => page.filters.query(),
        Some(SearchKind::Mob) => page.mob_filters.query(),
        Some(SearchKind::Map) if page.town => "&town=1".into(),
        _ => String::new(),
    };
    for pair in filters.split('&').filter(|p| !p.is_empty()) {
        let (key, value) = pair.split_once('=').unwrap_or((pair, ""));
        out.push((key.into(), value.into()));
    }
    if matches!(page.kind, Some(SearchKind::Mob | SearchKind::Map)) {
        if !page.region.is_empty() {
            out.push(("region".into(), page.region.clone()));
        }
        if !page.area.is_empty() {
            out.push(("area".into(), page.area.clone()));
        }
    }
    if page.kind == Some(SearchKind::Map) {
        // A spot sets the island; otherwise only a non-default island shows.
        if !page.spot.is_empty() {
            out.push(("spot".into(), page.spot.clone()));
        } else if page.island != default_island(page) {
            out.push(("island".into(), page.island.clone()));
        }
    }
    out
}

/// The island the map list shows without `island=`: the region's, else
/// Victoria Island.
fn default_island(page: &SearchPage) -> &'static str {
    match page.region.as_str() {
        "maple" => "maple",
        _ => "victoria",
    }
}

fn search_href(ctx: &Ctx, pairs: &[(String, String)]) -> String {
    let query: Vec<String> = pairs
        .iter()
        .map(|(k, v)| format!("{k}={}", url_encode(v)))
        .collect();
    ctx.href(&format!("/search?{}", query.join("&")))
}

/// This page's URL without `drop` keys, plus `add`.
fn edited_href(ctx: &Ctx, page: &SearchPage, drop: &[&str], add: &[(&str, String)]) -> String {
    let mut pairs = search_pairs(page);
    pairs.retain(|(k, _)| !drop.contains(&k.as_str()) && !add.iter().any(|(a, _)| a == k));
    pairs.extend(add.iter().map(|(k, v)| (k.to_string(), v.clone())));
    search_href(ctx, &pairs)
}

/// Filters only equipment has: another category drops them.
const EQUIPMENT_KEYS: [&str; 6] = ["job", "shared", "type", "weapon", "lmin", "lmax"];

/// An active filter: label, value, and the URL keys that remove it.
struct Token {
    label: &'static str,
    value: String,
    keys: &'static [&'static str],
}

fn level_text(lo: Option<i16>, hi: Option<i16>) -> String {
    match hi {
        Some(hi) => format!("{}–{hi}", lo.unwrap_or(0)),
        None => format!("{}+", lo.unwrap_or(0)),
    }
}

fn search_tokens(page: &SearchPage, ctx: &Ctx) -> Vec<Token> {
    let mut out = Vec::new();
    let mut add = |label, value: String, keys| out.push(Token { label, value, keys });
    let level = |lo: Option<i16>, hi: Option<i16>| {
        (lo.is_some() || hi.is_some()).then(|| level_text(lo, hi))
    };
    match page.kind {
        Some(SearchKind::Item) => {
            let f = &page.filters;
            if let Some((_, _, zh, en)) = JOBS.iter().find(|(key, ..)| *key == f.job) {
                add(ctx.t("职业", "Job"), ctx.t(zh, en).into(), &["job"]);
            }
            if !f.shared {
                add(
                    "",
                    ctx.t("不含通用装备", "No all-class gear").into(),
                    &["shared"],
                );
            }
            if let Some((_, zh, en)) = EQUIPMENT_TYPES.iter().find(|(key, ..)| *key == f.slot) {
                add(
                    ctx.t("类型", "Type"),
                    ctx.t(zh, en).into(),
                    &["type", "weapon"],
                );
            }
            if let Some((_, zh, en)) = WEAPON_TYPES.iter().find(|(id, ..)| Some(*id) == f.weapon) {
                add(ctx.t("武器", "Weapon"), ctx.t(zh, en).into(), &["weapon"]);
            }
            if let Some((_, zh, en)) = USE_TYPES.iter().find(|(key, ..)| *key == f.use_type) {
                add(ctx.t("类型", "Type"), ctx.t(zh, en).into(), &["use"]);
            }
            if let Some(text) = level(f.lmin, f.lmax) {
                add(ctx.t("等级", "Level"), text, &["lmin", "lmax"]);
            }
        }
        Some(kind) => {
            if kind == SearchKind::Mob {
                let f = &page.mob_filters;
                if let Some(text) = level(f.lmin, f.lmax) {
                    add(ctx.t("等级", "Level"), text, &["lmin", "lmax"]);
                }
            }
            // The map list's region and towns are chips of their own.
            let label =
                super::super::regions::label(&page.region).filter(|_| kind != SearchKind::Map);
            if let Some((zh, en)) = label {
                add(
                    ctx.t("地区", "Region"),
                    ctx.t(zh, en).into(),
                    &["region", "area"],
                );
            }
            if let Some(area) = page
                .areas
                .iter()
                .find(|a| a.key == page.area && a.region == page.region)
            {
                add(
                    ctx.t("区域", "Area"),
                    area.names.get(ctx.lang).into(),
                    &["area"],
                );
            }
            if kind == SearchKind::Mob && page.mob_filters.boss {
                add("", ctx.t("只看 Boss", "Bosses only").into(), &["boss"]);
            }
        }
        None => {}
    }
    out
}

/// Units of a kind's count: 件 items, 只 monsters, 张 maps.
fn count_text(ctx: &Ctx, kind: SearchKind, n: i64) -> String {
    let (zh, en) = match kind {
        SearchKind::Item => ("件", "items"),
        SearchKind::Mob => ("只", "monsters"),
        SearchKind::Map => ("张", "maps"),
    };
    match ctx.lang {
        Lang::Zh => format!("共 {} {zh}", grouped(n)),
        Lang::En | Lang::Ko => format!("{} {en}", grouped(n)),
    }
}

fn page_count(page: &SearchPage, total: i64) -> (i64, i64) {
    let size = page.page_size.max(1);
    ((page.offset / size) + 1, ((total + size - 1) / size).max(1))
}

pub fn search_page(page: &SearchPage, ctx: &Ctx) -> Markup {
    let q = page.query.as_str();
    let meta = (!q.is_empty()).then(|| format!("“{q}”"));
    let body = html! {
        section.stall.dex-search {
            (bar(ctx.t("图鉴", "Catalogue"), meta.as_deref()))
            div.dex-tools.dex-kind[page.kind.is_some()] {
                form.finder.in-page id="catalog-search" action="/search" method="get" role="search" {
                    (PreEscaped(icon(Icon::Search)))
                    input type="search" name="q" value=(q) placeholder=(ctx.t("搜索物品、怪物、地图", "Search items, monsters, maps"))
                        aria-label=(ctx.t("搜索", "Search")) autocomplete="off";
                    @for (key, value) in search_pairs(page).iter().filter(|(k, _)| k != "q") {
                        input type="hidden" name=(key) value=(value);
                    }
                    @if ctx.lang != Lang::Zh { input type="hidden" name="lang" value=(ctx.lang.code()); }
                }
                (kind_tabs(page, ctx))
                @if page.kind == Some(SearchKind::Item) { (category_links(page, ctx)) }
            }
            @match page.kind {
                Some(kind) => (kind_results(page, kind, ctx)),
                None => (mixed_results(page, ctx)),
            }
        }
    };
    dex_page(
        ctx,
        if q.is_empty() {
            ctx.t("图鉴", "Catalogue")
        } else {
            q
        },
        q,
        body,
    )
}

/// Items, monsters or maps: one tab each. Without a kind (a typed query
/// over all three) no tab is current and each opens its catalogue.
fn kind_tabs(page: &SearchPage, ctx: &Ctx) -> Markup {
    let places = matches!(page.kind, Some(SearchKind::Mob | SearchKind::Map));
    let tabs: Vec<(SearchKind, &str, String)> = [
        (SearchKind::Item, ctx.t("物品", "Items")),
        (SearchKind::Mob, ctx.t("怪物", "Monsters")),
        (SearchKind::Map, ctx.t("地图", "Maps")),
    ]
    .into_iter()
    .map(|(kind, label)| {
        let mut pairs = Vec::new();
        if !page.query.is_empty() {
            pairs.push(("q".to_string(), page.query.clone()));
        }
        pairs.push(("kind".to_string(), kind.key().to_string()));
        // Monsters and maps share the region and area.
        if places && kind != SearchKind::Item {
            for (key, value) in [("region", &page.region), ("area", &page.area)] {
                if !value.is_empty() {
                    pairs.push((key.to_string(), value.clone()));
                }
            }
        }
        (kind, label, search_href(ctx, &pairs))
    })
    .collect();
    html! {
        nav.tabs.dex-kinds aria-label=(ctx.t("图鉴分类", "Catalogue")) {
            @for (kind, label, href) in tabs {
                @let on = page.kind == Some(kind);
                a.tab.on[on] href=(href) aria-current=[on.then_some("page")] data-kind=(kind.key()) { (label) }
            }
        }
    }
}

fn category_links(page: &SearchPage, ctx: &Ctx) -> Markup {
    let counts = page
        .facets
        .as_ref()
        .map(|f| f.categories.as_slice())
        .unwrap_or(&[]);
    let links: Vec<(&str, &str, String, Option<i64>)> = ITEM_CATEGORIES
        .iter()
        .map(|(key, zh, en)| {
            let mut drop = vec!["cat", "use"];
            if *key != "equip" {
                drop.extend(EQUIPMENT_KEYS);
            }
            let add: Vec<(&str, String)> = if key.is_empty() {
                vec![]
            } else {
                vec![("cat", key.to_string())]
            };
            let count = counts.iter().find(|f| f.key == *key).map(|f| f.count);
            (
                *key,
                ctx.t(zh, en),
                edited_href(ctx, page, &drop, &add),
                count,
            )
        })
        .collect();
    html! {
        div.cats data-cats role="group" aria-label=(ctx.t("物品分类", "Item category")) {
            @for (key, label, href, count) in links {
                @let on = page.filters.cat == key;
                a.cat.on[on] href=(href) aria-current=[on.then_some("true")] data-cat=(if key.is_empty() { "all" } else { key }) {
                    (label)
                    @if let Some(n) = count { small { (grouped(n)) } }
                }
            }
        }
    }
}

fn kind_results(page: &SearchPage, kind: SearchKind, ctx: &Ctx) -> Markup {
    if kind == SearchKind::Map {
        return map_browser(page, ctx);
    }
    let lang = ctx.lang;
    let tokens = search_tokens(page, ctx);
    let total = match kind {
        SearchKind::Item => page.items.total,
        SearchKind::Mob => page.mobs.total,
        SearchKind::Map => page.maps.total,
    };
    let (number, pages) = page_count(page, total);
    let empty = match kind {
        SearchKind::Item => page.items.rows.is_empty(),
        SearchKind::Mob => page.mobs.rows.is_empty(),
        SearchKind::Map => page.maps.rows.is_empty(),
    };
    let all_keys: Vec<&str> = tokens.iter().flat_map(|t| t.keys.iter().copied()).collect();
    html! {
        div.dex-body {
            @if !tokens.is_empty() {
                div.dex-tokens data-active-filters {
                    @for token in &tokens {
                        a.tok href=(edited_href(ctx, page, token.keys, &[])) data-remove-filter=(token.keys[0]) {
                            @if !token.label.is_empty() { (token.label) " " }
                            b { (token.value) } " ×"
                        }
                    }
                    a.dex-clear href=(edited_href(ctx, page, &all_keys, &[])) data-clear-filters { (ctx.t("清除筛选", "Clear filters")) }
                }
            }
            p.dex-total data-total {
                (count_text(ctx, kind, total))
                @if total > 0 {
                    @match lang {
                        Lang::Zh => { " · 第 " (number) "/" (pages) " 页" },
                        Lang::En | Lang::Ko => { " · page " (number) " of " (pages) },
                    }
                }
            }
            div data-search-results aria-live="polite" id={"search-" (kind.key())} {
                @if empty {
                    (search_empty(page, ctx, !tokens.is_empty() || !page.filters.cat.is_empty()))
                } @else {
                    div.catalogue-grid {
                        @match kind {
                            SearchKind::Item => { @for hit in &page.items.rows { (item_hit(ctx, hit)) } },
                            SearchKind::Mob => { @for mob in &page.mobs.rows { (mob_row(ctx, mob, None, mob.names.secondary(lang).map(str::to_string))) } },
                            SearchKind::Map => { @for map in &page.maps.rows { (map_hit(ctx, map)) } },
                        }
                    }
                }
            }
            @if pages > 1 { (search_pager(page, ctx, number, pages)) }
        }
    }
}

fn item_hit(ctx: &Ctx, hit: &ItemHit) -> Markup {
    let lang = ctx.lang;
    html! {
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
    }
}

fn map_hit(ctx: &Ctx, map: &MapHit) -> Markup {
    html! {
        a.drow href=(ctx.href(&format!("/map/{}", map.id))) {
            (map_glyph())
            span.t {
                b { (map.names.get(ctx.lang)) }
                (super::secondary_name(&map.names, ctx.lang))
                @let street = map.street.as_ref().map(|s| s.get(ctx.lang));
                @let hint = map.hint.as_ref().and_then(|h| h.get(ctx.lang));
                @match (street, hint) {
                    (Some(street), Some(hint)) => span.s { (street) " · " (hint) },
                    (Some(text), None) | (None, Some(text)) => span.s { (text) },
                    (None, None) => {},
                }
            }
        }
    }
}

/// The map list: region chips over the world map (left) and picture cards
/// (right) in one box. The cards scroll inside the box; in the browser more
/// load as they scroll, and the pager is for pages without scripts.
fn map_browser(page: &SearchPage, ctx: &Ctx) -> Markup {
    let lang = ctx.lang;
    let total = page.maps.total;
    let (number, pages) = page_count(page, total);
    let tokens = search_tokens(page, ctx);
    let island_id = super::super::regions::ISLANDS
        .iter()
        .find(|(key, _)| *key == page.island)
        .map(|(_, id)| *id);
    let region = page.world.iter().find(|r| Some(r.id.as_str()) == island_id);
    let spot = page
        .world
        .iter()
        .flat_map(|r| &r.spots)
        .find(|s| s.key == page.spot);
    let is_island = |key: &str| key == "maple" || key == "victoria";
    let chip_on = |key: &str| match key {
        "rest" => !page.region.is_empty() && !is_island(&page.region),
        key => page.region == key,
    };
    let chip_href = |key: &str| {
        let add: Vec<(&str, String)> = if key.is_empty() {
            vec![]
        } else {
            vec![("region", key.to_string())]
        };
        edited_href(
            ctx,
            page,
            &["region", "area", "spot", "island", "page"],
            &add,
        )
    };
    let island_href = |key: &str| {
        if is_island(&page.region) {
            edited_href(
                ctx,
                page,
                &["region", "area", "spot", "island", "page"],
                &[("region", key.to_string())],
            )
        } else if key == "victoria" {
            edited_href(ctx, page, &["spot", "island", "page"], &[])
        } else {
            edited_href(
                ctx,
                page,
                &["spot", "island", "page"],
                &[("island", key.to_string())],
            )
        }
    };
    let spot_href = |s: &WorldSpot| {
        if s.key == page.spot {
            edited_href(
                ctx,
                page,
                &["spot", "page"],
                &[("island", page.island.clone())],
            )
        } else {
            let mut add = vec![("spot", s.key.clone())];
            if !page.region.is_empty() {
                add.push(("region", page.island.clone()));
            }
            edited_href(ctx, page, &["spot", "island", "page", "area"], &add)
        }
    };
    // A chosen place is where the route goes.
    let route_href = match spot {
        Some(spot) => format!("/route?to={}", spot.map.id),
        None => "/route".to_string(),
    };
    let town_href = if page.town {
        edited_href(ctx, page, &["town", "page"], &[])
    } else {
        edited_href(ctx, page, &["page"], &[("town", "1".into())])
    };
    html! {
        div.dex-body {
            @if !tokens.is_empty() {
                div.dex-tokens data-active-filters {
                    @for token in &tokens {
                        a.tok href=(edited_href(ctx, page, token.keys, &[])) data-remove-filter=(token.keys[0]) {
                            @if !token.label.is_empty() { (token.label) " " }
                            b { (token.value) } " ×"
                        }
                    }
                }
            }
            div.mbox data-map-browser {
                div.mb-tools {
                    nav.mb-regions aria-label=(ctx.t("地区", "Region")) {
                        @for facet in &page.map_regions {
                            @let on = if facet.key.is_empty() { page.region.is_empty() } else { chip_on(&facet.key) };
                            a.mb-chip.on[on] href=(chip_href(&facet.key)) aria-current=[on.then_some("true")]
                                data-region=(if facet.key.is_empty() { "all" } else { facet.key.as_str() }) {
                                (facet.names.get(lang)) " " span.mb-n { (grouped(facet.count)) }
                            }
                        }
                    }
                    a.mb-chip.mb-town.on[page.town] href=(town_href) aria-pressed=(page.town) data-town {
                        (ctx.t("只看城镇", "Towns only"))
                    }
                    a.mb-route href=(ctx.href(&route_href)) { (ctx.t("怎么走", "Route")) " →" }
                }
                div.mb-split {
                    div.mb-left {
                        div.mb-bar {
                            // An island chip already picks the island.
                            @if !is_island(&page.region) {
                            span.mb-isl role="group" aria-label=(ctx.t("世界地图", "World map")) {
                                @for r in &page.world {
                                    @let key = super::super::regions::ISLANDS.iter().find(|(_, id)| *id == r.id).map(|(k, _)| *k);
                                    @if let Some(key) = key {
                                        a.on[Some(r.id.as_str()) == island_id] href=(island_href(key)) data-island=(key) { (r.names.get(lang)) }
                                    }
                                }
                            }
                            }
                            small.mb-tip { (ctx.t("点地点只看那里的地图", "Pick a place to see its maps")) }
                        }
                        div.mb-mapbox {
                            @if let Some(region) = region { (list_world(ctx, region, &page.spot, spot_href)) }
                        }
                        div.mb-info {
                            @if let Some(spot) = spot {
                                b { (spot.map.names.get(lang)) }
                                span {
                                    (count_text(ctx, SearchKind::Map, total).trim_start_matches("共 "))
                                    @if let Some(lv) = spot_levels(spot) { " · " (lv) }
                                }
                                a.mb-clear href=(spot_href(spot)) data-clear-spot { (ctx.t("看全部", "Show all")) }
                            }
                        }
                    }
                    div.mb-right data-search-results aria-live="polite" id="search-map" {
                        p.mb-total data-total { (count_text(ctx, SearchKind::Map, total)) }
                        @if page.maps.rows.is_empty() {
                            (search_empty(page, ctx, !tokens.is_empty() || page.town || !page.region.is_empty() || !page.spot.is_empty()))
                        } @else {
                            div.mb-tiles { @for map in &page.maps.rows { (map_tile(ctx, map)) } }
                        }
                        @if pages > 1 { (search_pager(page, ctx, number, pages)) }
                    }
                }
            }
        }
    }
}

/// A map's card: its picture, with the name and details on it.
fn map_tile(ctx: &Ctx, map: &MapHit) -> Markup {
    let lang = ctx.lang;
    let name = map.names.get(lang);
    html! {
        a.mtile href=(ctx.href(&format!("/map/{}", map.id))) data-map=(map.id) data-spot=[map.spot.as_deref()] {
            @if let Some(url) = &map.thumb {
                img src=(url) alt="" loading="lazy" decoding="async" width="480" height="300";
            } @else {
                span.mt-none { (ctx.t("无图", "No picture")) }
            }
            @if map.town { span.mt-tag.mt-town { (ctx.t("城镇", "Town")) } }
            @if let Some(lv) = levels(map.level_min, map.level_max) {
                span.mt-tag.mt-lv title=(ctx.t("怪物等级", "Monster levels")) { (lv) }
            }
            span.mt-ov {
                b { (name) }
                small { (tile_details(map, lang).join(" · ")) }
            }
        }
    }
}

/// The card's small line: the other language's name, the street, the rooms
/// and what tells it from a map of the same name; nothing twice.
fn tile_details(map: &MapHit, lang: Lang) -> Vec<&str> {
    let name = map.names.get(lang);
    let mut out: Vec<&str> = Vec::new();
    let parts = [
        map.names.secondary(lang),
        map.street.as_ref().map(|s| s.get(lang)),
        map.copies.as_ref().map(|c| c.get(lang)),
        map.hint.as_ref().and_then(|h| h.get(lang)),
    ];
    for part in parts.into_iter().flatten() {
        if !part.is_empty() && part != name && !out.contains(&part) {
            out.push(part);
        }
    }
    out
}

/// Numbered pages: the first, the last and two either side of this one.
fn search_pager(page: &SearchPage, ctx: &Ctx, number: i64, pages: i64) -> Markup {
    let link = |n: i64| edited_href(ctx, page, &[], &[("page", n.to_string())]);
    let mut shown: Vec<Option<i64>> = Vec::new();
    for n in 1..=pages {
        if n == 1 || n == pages || (n - number).abs() <= 2 {
            shown.push(Some(n));
        } else if shown.last() != Some(&None) {
            shown.push(None);
        }
    }
    html! {
        nav.dex-pager aria-label=(ctx.t("分页", "Pagination")) {
            @if number > 1 { a.chip href=(link(number - 1)) rel="prev" { (ctx.t("上一页", "Previous")) } }
            @for n in shown {
                @match n {
                    Some(n) if n == number => { a.chip.on href=(link(n)) aria-current="page" { (n) } },
                    Some(n) => { a.chip href=(link(n)) { (n) } },
                    None => { span.gap { "…" } },
                }
            }
            @if number < pages { a.chip href=(link(number + 1)) rel="next" { (ctx.t("下一页", "Next")) } }
        }
    }
}

fn search_empty(page: &SearchPage, ctx: &Ctx, filtered: bool) -> Markup {
    let q = page.query.as_str();
    let text = match (q.is_empty(), filtered, ctx.lang) {
        (false, _, Lang::Zh) => format!("没有找到「{q}」。换个字试试，比如只输入名字的一部分。"),
        (false, _, Lang::En | Lang::Ko) => format!("Nothing matches “{q}”. Try part of the name."),
        (true, true, _) => ctx
            .t("没有符合筛选条件的结果。", "Nothing matches these filters.")
            .to_string(),
        (true, false, _) => ctx
            .t("暂无图鉴数据。", "No catalogue data yet.")
            .to_string(),
    };
    let kind = page
        .kind
        .map(|k| format!("?kind={}", k.key()))
        .unwrap_or_default();
    html! {
        div.empty {
            img src=(mob_image_url(EMPTY_MOB)) alt="" loading="lazy";
            p { (text) }
            @if !q.is_empty() || filtered {
                a.btn href=(ctx.href(&format!("/search{kind}"))) data-clear-search { (ctx.t("清空搜索和筛选", "Clear search and filters")) }
            }
        }
    }
}

/// A typed query without a kind: the first rows of all three catalogues,
/// each linking to its full list.
fn mixed_results(page: &SearchPage, ctx: &Ctx) -> Markup {
    let lang = ctx.lang;
    let nothing =
        page.items.rows.is_empty() && page.mobs.rows.is_empty() && page.maps.rows.is_empty();
    html! {
        div.dbody data-search-results aria-live="polite" {
            @if nothing {
                (empty_state(ctx, &match lang {
                    _ if page.query.is_empty() => ctx.t("暂无图鉴数据。", "No catalogue data yet.").to_string(),
                    Lang::Zh => format!("没有找到「{}」。换个字试试，比如只输入名字的一部分。", page.query),
                    Lang::En | Lang::Ko => format!("Nothing matches “{}”. Try part of the name.", page.query),
                }))
            } @else {
                (hits_well(page, ctx, SearchKind::Item, ctx.t("物品", "Items"), &page.items, |hit| item_hit(ctx, hit)))
                (hits_well(page, ctx, SearchKind::Mob, ctx.t("怪物", "Monsters"), &page.mobs, |mob: &MobRef| {
                    mob_row(ctx, mob, None, mob.names.secondary(lang).map(str::to_string))
                }))
                (hits_well(page, ctx, SearchKind::Map, ctx.t("地图", "Maps"), &page.maps, |map| map_hit(ctx, map)))
            }
        }
    }
}

fn hits_well<T>(
    page: &SearchPage,
    ctx: &Ctx,
    kind: SearchKind,
    title: &str,
    hits: &Hits<T>,
    row: impl Fn(&T) -> Markup,
) -> Markup {
    let all = search_href(
        ctx,
        &[
            ("q".into(), page.query.clone()),
            ("kind".into(), kind.key().into()),
        ],
    );
    html! {
        section.well id={"search-" (kind.key())} {
            (well_head(title, Some(count_text(ctx, kind, hits.total))))
            @if !hits.rows.is_empty() {
                div.catalogue-grid { @for hit in &hits.rows { (row(hit)) } }
            } @else {
                p.note { (ctx.t("没有匹配结果。", "No matches.")) }
            }
            @if hits.more {
                a.more href=(all) data-kind-all=(kind.key()) {
                    (match ctx.lang {
                        Lang::Zh => format!("查看全部 {} {}", grouped(hits.total), match kind { SearchKind::Item => "件", SearchKind::Mob => "只", SearchKind::Map => "张" }),
                        Lang::En | Lang::Ko => format!("Show all {}", grouped(hits.total)),
                    })
                }
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

// ---------- errors ----------

pub fn not_found_page(what_zh: &str, what_en: &str, ctx: &Ctx) -> Markup {
    let body = html! {
        section.stall {
            (bar(ctx.t("没有找到", "Not found"), None))
            div.dbody {
                (empty_state(ctx, &match ctx.lang {
                    Lang::Zh => format!("没有这个{what_zh}。可能编号写错了，或者图鉴还没收录。可以用搜索找。"),
                    Lang::En | Lang::Ko => format!("No such {what_en}. The id may be wrong, or the dex does not have it yet. Try search."),
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
    fn kind_tabs_keep_the_query_and_shared_places() {
        let ctx = Ctx::default();
        let browse = kind_tabs(
            &SearchPage {
                kind: Some(SearchKind::Item),
                ..Default::default()
            },
            &ctx,
        )
        .into_string();
        assert_eq!(browse.matches("<a ").count(), 3);
        assert!(!browse.contains("全部"));
        assert!(browse.contains(r#"class="tab on" href="/search?kind=item""#));
        let search = kind_tabs(
            &SearchPage {
                query: "蜗牛".into(),
                ..Default::default()
            },
            &ctx,
        )
        .into_string();
        assert!(
            !search.contains("tab on"),
            "no tab is current over three catalogues"
        );
        assert!(search.contains("/search?q=%E8%9C%97%E7%89%9B&amp;kind=mob"));
        let mobs = kind_tabs(
            &SearchPage {
                kind: Some(SearchKind::Mob),
                region: "victoria".into(),
                ..Default::default()
            },
            &ctx,
        )
        .into_string();
        assert!(mobs.contains("/search?kind=map&amp;region=victoria"));
        assert!(mobs.contains(r#"href="/search?kind=item""#));
    }

    #[test]
    fn tokens_remove_their_own_keys_and_categories_drop_equipment_filters() {
        let ctx = Ctx::default();
        let page = SearchPage {
            kind: Some(SearchKind::Item),
            filters: ItemFilters {
                cat: "equip".into(),
                job: "warrior".into(),
                lmin: Some(30),
                lmax: Some(40),
                sort: "level".into(),
                ..Default::default()
            },
            page_size: 60,
            offset: 60,
            items: Hits {
                total: 113,
                ..Default::default()
            },
            ..Default::default()
        };
        let tokens = search_tokens(&page, &ctx);
        assert_eq!(
            tokens
                .iter()
                .map(|t| (t.label, t.value.as_str()))
                .collect::<Vec<_>>(),
            [("职业", "战士"), ("等级", "30–40")]
        );
        assert_eq!(
            edited_href(&ctx, &page, tokens[0].keys, &[]),
            "/search?kind=item&cat=equip&lmin=30&lmax=40&sort=level"
        );
        let html = search_page(&page, &ctx).into_string();
        assert!(html.contains("共 113 件 · 第 2/2 页"));
        assert!(html.contains(r#"href="/search?kind=item&amp;sort=level&amp;cat=use""#));
        assert!(html.contains(r#"href="/search?kind=item&amp;cat=equip&amp;job=warrior&amp;lmin=30&amp;lmax=40&amp;sort=level&amp;page=1""#));
        assert!(html.contains("清除筛选"));
        assert!(html.contains(r#"<a class="cat on""#));
        assert_eq!(level_text(Some(70), None), "70+");
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
            "走传送口",
            "internal portal names stay hidden"
        );
        assert!(edge_label(EdgeKind::Return, Lang::Zh).starts_with("用回城卷轴"));
    }

    #[test]
    fn level_lines_and_unit_prices() {
        assert!(is_level_line("等级：8"));
        assert!(is_level_line(" 等级: 12 "));
        assert!(!is_level_line("等级：未知"));
        assert!(!is_level_line("形态：植物型"));
        assert_eq!(unit_meso(0, Lang::Zh), "<1");
        assert_eq!(unit_meso(23, Lang::Zh), "23");
        assert_eq!(unit_meso(2_000, Lang::En), "2K");
        assert_eq!(unit_meso(25_000, Lang::Zh), "2.5万");
    }
}

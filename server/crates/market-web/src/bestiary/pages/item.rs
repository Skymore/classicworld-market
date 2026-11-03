//! `/item/<id>`: head, sources (droppers, NPC shops, "farm or buy"), then the
//! market sections from `market.rs`. Phone and desktop share one DOM;
//! `item.css` lays it out per `html[data-device]`.

use maud::{html, Markup, PreEscaped};

use super::market::{self, View};
use super::shell::{icon, layout, Ctx, Icon, Nav, Page};
use super::{map_list, mob_pic};
use crate::bestiary::format::{ago, meso, Lang};
use crate::bestiary::model::*;

/// Droppers shown before "more": phone, desktop.
const MOBS_PHONE: usize = 4;
const MOBS_DESKTOP: usize = 6;

pub fn item_page(page: &ItemPage, ctx: &Ctx) -> Markup {
    let v = View::new(ctx, page);
    let names = page.item.names();
    let name = names.get(ctx.lang);
    let fresh = page.market.as_of.map(|_| fresh_text(&v));
    // Reuse the public data already read for this first paint. Escape raw-text
    // delimiters: item/shop names must never be able to close the JSON script.
    let mut data = serde_json::json!({"kind":"item", "page":page});
    data["page"]["unit"] = serde_json::json!(crate::external::unit(page.item.id));
    let tag = crate::delivery::tag("item", &mut data);
    let snapshot = serde_json::json!({
        "url": ctx.here,
        "updatedAt": ctx.now.timestamp_millis(),
        "data": data, "etag":tag,
    })
    .to_string()
    .replace('&', "\\u0026")
    .replace('<', "\\u003c")
    .replace('>', "\\u003e")
    .replace('\u{2028}', "\\u2028")
    .replace('\u{2029}', "\\u2029");
    let body = html! {
        script id="catalog-snapshot" type="application/json" { (PreEscaped(snapshot)) }
        div.dwrap.ipage {
            nav.crumb.on-desktop aria-label=(ctx.t("位置", "Breadcrumb")) {
                a href=(ctx.href("/search?kind=item")) { (ctx.t("图鉴", "Catalogue")) }
                (PreEscaped(icon(Icon::Chev)))
                @if let Some(cat) = market::category_key(&page.item.category) {
                    a href=(ctx.href(&format!("/search?kind=item&cat={cat}"))) { (market::category_label(&page.item.category, ctx.lang)) }
                } @else {
                    span { (market::category_label(&page.item.category, ctx.lang)) }
                }
                (PreEscaped(icon(Icon::Chev)))
                span { (name) }
            }
            section.stall.item-stall data-item=(page.item.id) data-mark=(market::mark(page)) data-as-of=(v.as_of.timestamp()) {
                div.stall-bar {
                    h2 { (if page.selected_variant.is_some() {ctx.t("属性详情", "Stat detail")} else {ctx.t("物品详情", "Item")}) span.on-desktop { " · " (name) } }
                    span.bar-meta.on-desktop data-fresh hidden[fresh.is_none()] {
                        span { @if let Some(text) = &fresh { (text) } }
                    }
                    label.item-period { span.sr-only { (ctx.t("统计范围","Statistics window")) }
                        select data-item-period aria-label=(ctx.t("统计范围","Statistics window")) {
                            option value="72" selected[!ctx.here.contains("hours=all")] { "72h" }
                            option value="all" selected[ctx.here.contains("hours=all")] { (ctx.t("全部","All time")) }
                        }
                    }
                    (star_button(ctx, page.item.id))
                }
                (market::head(&v))
                @if let Some(selected) = &page.selected_variant {
                    div.selected-attributes data-selected-attributes {
                        div.tags {
                            @for s in selected.stats.iter().filter(|s| !matches!(s.key.as_str(), "weapon_defense" | "magic_defense" | "pdd" | "mdd") && s.value > 0) {
                                span.tagx { (&s.label) " +" (s.value) }
                            }
                            @if let Some(left) = selected.remaining_upgrades { span.tagx { (ctx.t("可升级", "Upgrades left")) " " (left) } }
                        }
                        a data-all-attributes href=(format!("/item/{}?hours={}&lang={}", page.item.id, if ctx.here.contains("hours=all") {"all"} else {"72"}, if ctx.lang==Lang::En {"en"} else {"zh"})) { (ctx.t("查看全部属性", "All equipment stats")) }
                    }
                }
                @if let Some(strip) = equipment_strip(page, ctx) { (strip) }
                div.ibox {
                    div.src-box { (sources_well(&v)) }
                    (market::where_well(&v))
                    @if let Some(equip) = market::equipment_well(&v) { (equip) }
                    (market::tabs_well(&v))
                    (market::sales_well(&v))
                }
            }
        }
    };
    layout(
        ctx,
        &Page {
            title: name,
            nav: Nav::Prices,
            css: &["dex", "item"],
            fresh,
            query: "",
        },
        body,
    )
}

/// Requirements, jobs, type and base stats of equipment, under the head.
/// The React page renders the same strip (`EquipmentStrip`).
pub fn equipment_strip(page: &ItemPage, ctx: &Ctx) -> Option<Markup> {
    use crate::bestiary::equipment::{attack_speed_label, job_allowed, JOBS, STATS};
    let e = page.equipment.as_ref()?;
    let base: Vec<(&str, i64)> = STATS
        .iter()
        .filter_map(|(key, zh, en)| {
            let (_, value) = page.market.base_stats.iter().find(|(k, _)| k == key)?;
            (*value != 0).then(|| (ctx.t(zh, en), *value))
        })
        .collect();
    let kind = if ctx.lang == Lang::En {
        e.kind_en
    } else {
        e.kind
    };
    Some(html! {
        dl.eq-strip data-equipment-strip {
            @if let Some(req) = &e.req {
                dt { (ctx.t("要求", "Requires")) }
                dd {
                    @for (zh, en, value) in [("等级", "Level", req.level), ("力量", "STR", req.str),
                        ("敏捷", "DEX", req.dex), ("智力", "INT", req.int), ("运气", "LUK", req.luk)] {
                        span.zero[value == 0] { (ctx.t(zh, en)) " " b { (value) } }
                    }
                }
            }
            @if let Some(mask) = e.jobs {
                dt { (ctx.t("职业", "Jobs")) }
                dd.eq-jobs {
                    @for (bit, zh, en) in JOBS { span.on[job_allowed(mask, bit)] { (ctx.t(zh, en)) } }
                }
            }
            @if kind.is_some() || e.attack_speed.is_some() || e.upgrades.is_some() {
                dt { (ctx.t("类型", "Type")) }
                dd {
                    @if let Some(kind) = kind { span { (kind) } }
                    @if let Some(speed) = e.attack_speed {
                        @let (zh, en) = attack_speed_label(speed);
                        span { (ctx.t("攻击速度 ", "Attack speed ")) b { (ctx.t(zh, en)) } }
                    }
                    @if let Some(n) = e.upgrades { span { (ctx.t("可升级次数 ", "Upgrades ")) b { (n) } } }
                }
            }
            @if !base.is_empty() {
                dt { (ctx.t("基础", "Base")) }
                dd { @for (label, value) in &base { span { (label) " " b { "+" (value) } } } }
            }
        }
    })
}

/// The market sections alone, for `item.js` to swap in after a poll.
pub fn item_market_fragment(page: &ItemPage, ctx: &Ctx) -> Markup {
    let v = View::new(ctx, page);
    html! {
        div data-mark=(market::mark(page)) data-as-of=(v.as_of.timestamp()) {
            (market::head(&v))
            (market::where_well(&v))
            @if let Some(equip) = market::equipment_well(&v) { (equip) }
            (market::tabs_well(&v))
            (market::sales_well(&v))
        }
    }
}

/// "数据 2天前更新", like `setFreshness()` in chrome.js.
fn fresh_text(v: &View) -> String {
    let rel = ago((v.ctx.now - v.as_of).num_seconds(), v.ctx.lang);
    match v.ctx.lang {
        Lang::Zh if rel == "刚刚" => "数据刚刚更新".to_string(),
        Lang::Zh => format!("数据 {rel}更新"),
        Lang::En if rel == "just now" => "data just updated".to_string(),
        Lang::En => format!("data updated {rel}"),
    }
}

/// Watchlist star; `item.js` reads `localStorage.watchlist` and sets it.
fn star_button(ctx: &Ctx, id: i32) -> Markup {
    html! {
        button.bar-btn.wide.star-btn type="button" data-star=(id) aria-pressed="false" {
            span.when-off { (PreEscaped(icon(Icon::StarOutline))) (ctx.t("关注", "Watch")) }
            span.when-on { (PreEscaped(icon(Icon::StarSmall))) (ctx.t("已关注", "Watching")) }
        }
    }
}

// ---------- sources ----------

fn sources_well(v: &View) -> Markup {
    let page = v.page;
    let lang = v.ctx.lang;
    let droppers = &page.droppers;
    let mobs_note = match (droppers.len(), lang) {
        (0, _) => v
            .ctx
            .t(
                "还没有玩家确认的怪物掉落",
                "no player-confirmed monster drops yet",
            )
            .to_string(),
        (n, Lang::Zh) => format!("{n} 种怪物"),
        (n, Lang::En) => format!("{n} monsters"),
    };
    html! {
        section.well.src-well {
            div.well-h { h3 { (v.ctx.t("来源", "Sources")) } }
            div.sub-h { (v.ctx.t("怪物掉落", "Monster drops")) small { (mobs_note) } }
            @for (i, d) in droppers.iter().enumerate() {
                a.mob.xp[i >= MOBS_PHONE].xd[i >= MOBS_DESKTOP] href=(v.ctx.href(&format!("/mob/{}", d.mob.id))) {
                    (mob_pic(d.mob.id, d.mob.image_id))
                    span.mob-t {
                        b { (d.mob.names.get(lang)) }
                        @if let Some(lv) = d.mob.level { span.lv { "Lv." (lv) } }
                        (super::secondary_name(&d.mob.names, lang))
                        div.maps { (map_list(&d.maps, lang)) }
                    }
                }
            }
            @if droppers.len() > MOBS_PHONE {
                button.more.on-phone type="button" data-more="mobs" { (all_mobs(lang, droppers.len())) (PreEscaped(icon(Icon::Chev))) }
            }
            @if droppers.len() > MOBS_DESKTOP {
                button.more.on-desktop type="button" data-more="mobs" { (all_mobs(lang, droppers.len())) (PreEscaped(icon(Icon::Chev))) }
            }
            div.sub-h.ruled { (v.ctx.t("NPC 商店", "NPC shops")) }
            // 买: which NPCs sell it and for how much; 卖: what an NPC pays for one.
            div.npc {
                div.npc-col {
                    h4 { (v.ctx.t("买", "Buy")) }
                    // One row per price: most NPCs sell at the same price.
                    @for (price, npcs) in npc_prices(&page.npc_offers) {
                        span.npc-row {
                            span { (npc_names(&npcs, lang)) }
                            b { (meso(price, lang)) }
                        }
                    }
                    @if page.npc_offers.is_empty() { span.no { (v.ctx.t("NPC 不卖", "No NPC sells it")) } }
                }
                div.npc-col {
                    h4 { (v.ctx.t("卖", "Sell")) }
                    @if let Some(sell) = page.npc_sell {
                        span.npc-row { span { (v.ctx.t("回收价", "NPCs pay")) } b { (meso(sell, lang)) } }
                    } @else {
                        span.no { (v.ctx.t("NPC 不收", "NPCs do not buy it")) }
                    }
                }
            }
            @if !page.quest_rewards.is_empty() {
                div.sub-h.ruled { (v.ctx.t("任务奖励", "Quest rewards")) small { (quest_count(lang, page.quest_rewards.len())) } }
                (super::quest_rewards(lang, &page.quest_rewards))
            }
            @if !page.quest_needs.is_empty() {
                div.sub-h.ruled { (v.ctx.t("任务要用", "Needed for quests")) small { (quest_count(lang, page.quest_needs.len())) } }
                (super::quest_needs(lang, &page.quest_needs, false))
            }
        }
    }
}

/// NPC shop offers grouped by price, cheapest first.
fn npc_prices(offers: &[NpcOffer]) -> Vec<(i64, Vec<&NpcRef>)> {
    let mut groups: Vec<(i64, Vec<&NpcRef>)> = Vec::new();
    for offer in offers {
        match groups.iter_mut().find(|(price, _)| *price == offer.price) {
            Some((_, npcs)) => npcs.push(&offer.npc),
            None => groups.push((offer.price, vec![&offer.npc])),
        }
    }
    groups.sort_by_key(|(price, _)| *price);
    groups
}

/// "露茜、米娜、卢娜 等 8 个": the first three names of one price's sellers.
fn npc_names(npcs: &[&NpcRef], lang: Lang) -> String {
    let names: Vec<String> = npcs.iter().take(3).map(|n| n.label(lang)).collect();
    let more = npcs.len().saturating_sub(3);
    match (lang, more) {
        (Lang::Zh, 0) => names.join("、"),
        (Lang::Zh, _) => format!("{} 等 {} 个", names.join("、"), npcs.len()),
        (Lang::En, 0) => names.join(", "),
        (Lang::En, n) => format!("{} and {n} more", names.join(", ")),
    }
}

pub(super) fn quest_count(lang: Lang, n: usize) -> String {
    match lang {
        Lang::Zh => format!("{n} 个任务"),
        Lang::En => format!("{n} quests"),
    }
}

fn all_mobs(lang: Lang, n: usize) -> String {
    match lang {
        Lang::Zh => format!("查看全部 {n} 种怪物 "),
        Lang::En => format!("All {n} monsters "),
    }
}

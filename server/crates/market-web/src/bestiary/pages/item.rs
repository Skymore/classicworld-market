//! `/item/<id>`: head, sources (droppers, NPC shops, "farm or buy"), then the
//! market sections from `market.rs`. Phone and desktop share one DOM;
//! `item.css` lays it out per `html[data-device]`.

use maud::{html, Markup, PreEscaped};

use super::market::{self, View};
use super::shell::{icon, layout, Ctx, Icon, Nav, Page};
use super::{map_list, mob_pic};
use crate::bestiary::format::{ago, meso, percent, Lang};
use crate::bestiary::model::*;

/// Droppers shown before "more": phone, desktop.
const MOBS_PHONE: usize = 4;
const MOBS_DESKTOP: usize = 6;
/// A drop this easy (at most this many kills on average) is worth farming.
const EASY_KILLS: i64 = 3;

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
                a href="/prices" { (ctx.t("价格表", "Price table")) }
                (PreEscaped(icon(Icon::Chev)))
                span { (market::category_label(&page.item.category, ctx.lang)) }
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
    let same_rate = droppers
        .first()
        .filter(|first| droppers.iter().all(|d| d.rate_pct == first.rate_pct))
        .map(|d| d.rate_pct);
    let mobs_note = match (droppers.len(), same_rate, lang) {
        (0, _, _) => v
            .ctx
            .t("图鉴里没有怪物掉落记录", "no monster drops in the dex")
            .to_string(),
        (n, Some(rate), Lang::Zh) => format!("{n} 种怪物 · 每只掉率 {}", percent(rate)),
        (n, Some(rate), Lang::En) => format!("{n} monsters · {} each", percent(rate)),
        (n, None, Lang::Zh) => format!("{n} 种怪物"),
        (n, None, Lang::En) => format!("{n} monsters"),
    };
    let (verdict, reason) = verdict(v);
    html! {
        section.well.src-well {
            div.well-h { h3 { (v.ctx.t("来源", "Sources")) } small { (v.ctx.t("怎么拿到", "how to get it")) } }
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
                    span.rate { (percent(d.rate_pct)) }
                }
            }
            @if droppers.len() > MOBS_PHONE {
                button.more.on-phone type="button" data-more="mobs" { (all_mobs(lang, droppers.len())) (PreEscaped(icon(Icon::Chev))) }
            }
            @if droppers.len() > MOBS_DESKTOP {
                button.more.on-desktop type="button" data-more="mobs" { (all_mobs(lang, droppers.len())) (PreEscaped(icon(Icon::Chev))) }
            }
            div.sub-h.ruled { (v.ctx.t("NPC 商店", "NPC shops")) }
            div.npc {
                @for offer in &page.npc_offers {
                    span {
                        (offer.npc.label(lang)) (v.ctx.t(" 出售 ", " sells for ")) b { (meso(offer.price)) } (v.ctx.t(" / 个", " each"))
                        @if let Some(names) = &offer.npc.names { (super::secondary_name(names, lang)) }
                    }
                }
                @if page.npc_offers.is_empty() { span.no { (v.ctx.t("没有 NPC 出售记录", "No NPC sells it")) } }
                @if let Some(sell) = page.npc_sell {
                    span.sell { (v.ctx.t("卖给 NPC 只得 ", "NPCs pay ")) (meso(sell)) (v.ctx.t(" / 个", " each")) }
                }
            }
            div.verdict { b { (v.ctx.t("打还是买", "Farm or buy")) } strong { (verdict) } small { (reason) } }
        }
    }
}

fn all_mobs(lang: Lang, n: usize) -> String {
    match lang {
        Lang::Zh => format!("查看全部 {n} 种怪物 "),
        Lang::En => format!("All {n} monsters "),
    }
}

/// The "farm or buy" outcome (mockup `sourcesWell`).
#[derive(Debug, Clone, Copy, PartialEq)]
enum Verdict {
    /// An NPC sells it cheaper than the market (or the market has no price).
    Npc {
        npc: i64,
        market: Option<i64>,
    },
    /// Drops often enough to farm.
    Farm {
        kills: i64,
        market: Option<i64>,
    },
    Buy {
        kills: i64,
        market: i64,
    },
    MarketOnly {
        market: i64,
    },
    Unknown,
}

fn decide(page: &ItemPage) -> Verdict {
    let market = page.stats.as_ref().and_then(|s| s.typical);
    let npc = page.npc_offers.iter().map(|o| o.price).min();
    let kills = page
        .droppers
        .first()
        .filter(|d| d.rate_pct > 0.0)
        .map(|d| ((100.0 / d.rate_pct).round() as i64).max(1));
    match (npc, market, kills) {
        (Some(npc), m, _) if m.is_none_or(|m| npc < m) => Verdict::Npc { npc, market: m },
        (_, m, Some(kills)) if kills <= EASY_KILLS || m.is_none() => {
            Verdict::Farm { kills, market: m }
        }
        (_, Some(market), Some(kills)) => Verdict::Buy { kills, market },
        (_, Some(market), None) => Verdict::MarketOnly { market },
        _ => Verdict::Unknown,
    }
}

fn verdict(v: &View) -> (&'static str, String) {
    let zh = v.ctx.lang == Lang::Zh;
    if crate::external::unit(v.page.item.id) == "set" {
        let text = match v.page.stats.as_ref().and_then(|s| s.typical) {
            Some(price) if zh => format!("市场 {}/组；不与 NPC 单个报价直接比较", meso(price)),
            Some(price) => format!(
                "market {} per set; NPC each-price is not directly comparable",
                meso(price)
            ),
            None if zh => "暂无每组成交价".into(),
            None => "No per-set sale price yet".into(),
        };
        return (v.ctx.t("按组参考", "Per-set reference"), text);
    }
    let latest_offer = v.page.market.listings.iter().map(|l| l.seen_at).max();
    if v.page.stats.as_ref().and_then(|s| s.typical).is_some()
        && latest_offer.is_none_or(|at| (v.ctx.now - at).num_hours() >= 48)
    {
        return (v.ctx.t("历史价格参考", "Historical price only"), v.ctx.t("没有48小时内的在售报价，请先确认最新价格，再决定购买或打怪。", "No offer has been seen within 48 hours. Check current prices before deciding to buy or farm.").to_string());
    }
    match decide(v.page) {
        Verdict::Npc { npc, market } => (
            v.ctx.lang.t("去 NPC 买", "Buy from an NPC"),
            match (market, zh) {
                (Some(m), true) => format!("NPC {}/个，比市场 {}/个 便宜", meso(npc), meso(m)),
                (Some(m), false) => format!("NPC {} each, market {}", meso(npc), meso(m)),
                (None, true) => format!("NPC {}/个，市场还没有成交价", meso(npc)),
                (None, false) => format!("NPC {} each, no market sales yet", meso(npc)),
            },
        ),
        Verdict::Farm { kills, market } => (
            v.ctx.lang.t("可以自己打", "Farm it"),
            match (market, zh) {
                (Some(m), true) => format!("平均 {kills} 只怪就出 1 个；市场 {}/个", meso(m)),
                (Some(m), false) => format!("about 1 in {kills} kills; market {} each", meso(m)),
                (None, true) => format!("市场还没有成交价；平均 {kills} 只怪出 1 个"),
                (None, false) => format!("no market sales yet; about 1 in {kills} kills"),
            },
        ),
        Verdict::Buy { kills, market } => (
            v.ctx.lang.t("建议直接买", "Just buy it"),
            if zh {
                format!("市场 {}/个；自己打平均 {kills} 只怪才出 1 个", meso(market))
            } else {
                format!(
                    "market {} each; farming takes about {kills} kills per drop",
                    meso(market)
                )
            },
        ),
        Verdict::MarketOnly { market } => (
            v.ctx.lang.t("只能在市场买", "Market only"),
            if zh {
                format!("市场 {}/个", meso(market))
            } else {
                format!("market {} each", meso(market))
            },
        ),
        Verdict::Unknown => (
            v.ctx.lang.t("暂时没有来源", "No known source"),
            v.ctx
                .t(
                    "市场和图鉴里都还没有这件物品的来源",
                    "Neither the market nor the dex has a source yet",
                )
                .to_string(),
        ),
    }
}

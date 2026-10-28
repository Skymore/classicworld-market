//! The item page's market sections, ported from `itemPhone()` / `itemDesk()`
//! in `design/mockups-v2/mock.html`. Each section is wrapped in
//! `[data-market=<name>]`: `item.js` swaps exactly these when the poll
//! reports new data, so this is the only renderer of market markup.

use std::collections::BTreeSet;

use market_core::item::is_equipment;
use market_core::sales::SaleKind;
use maud::{html, Markup, PreEscaped};
use sqlx::types::chrono::{DateTime, Utc};

use super::shell::{icon, Ctx, Icon};
use super::{loc, slot};
use crate::bestiary::format::{ago, change, grouped, meso, meso_f, Lang};
use crate::bestiary::model::*;

/// Listings not seen for two days are drawn dashed and left out of minimums.
const STALE_SECONDS: i64 = 48 * 3600;
/// Channel groups shown before "more": phone, desktop.
const CHANNELS_PHONE: usize = 6;
const CHANNELS_DESKTOP: usize = 8;
/// Free-market rooms per channel.
const ROOMS: i16 = 22;
const SALES_SHOWN: usize = 12;
const VARIANTS_SHOWN: usize = 8;
/// Fewer 24-hour sales than this is a thin sample (plan v1 §4.2).
const FEW_SALES: i32 = 5;

/// Everything a market section needs.
pub struct View<'a> {
    pub ctx: &'a Ctx,
    pub page: &'a ItemPage,
    /// Reference point of relative times: the latest observation.
    pub as_of: DateTime<Utc>,
}

impl<'a> View<'a> {
    pub fn new(ctx: &'a Ctx, page: &'a ItemPage) -> Self {
        let as_of = page
            .market
            .as_of
            .or(page.stats.as_ref().map(|s| s.as_of))
            .unwrap_or(ctx.now);
        Self { ctx, page, as_of }
    }

    fn t(&self, zh: &'a str, en: &'a str) -> &'a str {
        self.ctx.t(zh, en)
    }

    fn ago(&self, at: DateTime<Utc>) -> String {
        ago((self.ctx.now - at).num_seconds(), self.ctx.lang)
    }

    fn stale(&self, at: DateTime<Utc>) -> bool {
        (self.ctx.now - at).num_seconds() > STALE_SECONDS
    }

    fn stats(&self) -> Option<&'a MarketStats> {
        self.page.stats.as_ref()
    }
}

/// Signature of the market data, compared by `item.js` with the poll answer
/// (listings, newest sale time, typical price) to skip identical refreshes.
pub fn mark(page: &ItemPage) -> String {
    let newest = page
        .market
        .sales
        .first()
        .map(|s| s.detected_at.timestamp().to_string())
        .unwrap_or_default();
    let typical = page
        .stats
        .as_ref()
        .and_then(|s| s.typical)
        .map(|t| t.to_string())
        .unwrap_or_default();
    format!("{}|{newest}|{typical}", page.market.listings.len())
}

// ---------- head ----------

pub fn head(v: &View) -> Markup {
    let item = &v.page.item;
    let names = item.names();
    let lang = v.ctx.lang;
    let level = match item.req_level {
        Some(lv) if lv > 0 => Some(match lang {
            Lang::Zh => format!("{lv} 级"),
            Lang::En => format!("Lv. {lv}"),
        }),
        _ => None,
    };
    // "消耗 / 消耗品" says the same thing twice.
    let sub = item
        .subcategory
        .as_deref()
        .filter(|sub| !sub.contains(item.category.as_str()) && !item.category.contains(sub));
    let stats = v.stats();
    let typical = stats.and_then(|s| s.typical);
    let few = stats.is_some_and(|s| s.typical.is_some() && s.sales_24h < FEW_SALES);
    let change = html! {
        @if let Some(pct) = stats.and_then(|s| s.change_24h) {
            @let (class, text) = change(pct, lang);
            span class={"chg " (class)} { (text) }
        }
        @if few { span.few { (v.t("样本少", "few sales")) } }
    };
    let big = html! {
        span.big { @match typical { Some(p) => (meso(p)), None => "—" } }
    };
    html! {
        div data-market="head" {
            div.ihead {
                (slot(item.icon_url.as_deref(), 44))
                div {
                    h1 { (names.get(lang)) }
                    @if let Some(other) = names.secondary(lang) { div.en { (other) } }
                    div.tags {
                        span.tagx { (category_label(&item.category, lang)) }
                        @if lang == Lang::Zh { @if let Some(sub) = sub { span.tagx { (sub) } } }
                        @if let Some(level) = &level { span.tagx { (level) } }
                        @if item.is_cash { span.tagx { (v.t("商城", "Cash")) } }
                    }
                }
                div.iprice-d {
                    div { (big) }
                    div.row {
                        @if typical.is_some() { (v.t("成交中位", "typical sale")) } @else { (v.t("还没有成交价", "no sales yet")) }
                        @if crate::external::unit(item.id)=="set" { (v.t(" · 每组", " · per set")) }
                        (change)
                    }
                    div.row { (range_line(v)) }
                }
            }
            div.iprice {
                (big)
                span.unit {
                    @if typical.is_some() { (v.t("金币 · 成交中位", "mesos · typical sale")) }
                    @else { (v.t("还没有成交价", "no sales yet")) }
                    @if crate::external::unit(item.id)=="set" { (v.t(" · 每组", " · per set")) }
                }
                (change)
                span.range { (range_line(v)) }
            }
        }
    }
}

fn range_line(v: &View) -> Markup {
    let Some(s) = v.stats() else {
        return html! { (v.t("市场数据暂无", "No market data yet")) };
    };
    html! {
        @if let (Some(lo), Some(hi)) = (s.typical_low, s.typical_high) {
            (v.t("常见 ", "usual ")) b { (meso(lo)) "–" (meso(hi)) } " · "
        }
        (if v.ctx.here.contains("hours=all") { v.t("全部 ", "All time ") } else { "72h " }) b { (s.sales_24h) } (v.t(" 笔", " sales"))
        // Where to buy counts merged offers; the head shows the lowest ask instead of a second count.
        @if let Some(ask) = s.lowest_ask { (v.t(" · 在售最低 ", " · lowest ask ")) b { (meso(ask)) } }
    }
}

/// `items.category` is Chinese; English pages get the game's own names.
pub(super) fn category_label(category: &str, lang: Lang) -> &str {
    if lang == Lang::Zh {
        return category;
    }
    match category {
        "装备" => "Equip",
        "消耗" | "消耗品" => "Use",
        "装饰" => "Setup",
        "其他" => "Etc",
        "商城" | "商城物品" => "Cash",
        other => other,
    }
}

// ---------- where to buy ----------

/// Listings of one channel; `channel: None` is "location unknown".
#[derive(Debug)]
pub struct Group<'a> {
    pub channel: Option<i16>,
    /// Cheapest first.
    pub listings: Vec<&'a Listing>,
    /// Lowest fresh unit price (all listings when none is fresh).
    pub min: f64,
    pub shops: usize,
}

fn fresh_min<'a, I>(listings: I, stale: impl Fn(&Listing) -> bool) -> f64
where
    I: Iterator<Item = &'a Listing> + Clone,
{
    let min = |it: &mut dyn Iterator<Item = f64>| it.fold(f64::INFINITY, f64::min);
    let fresh = min(&mut listings.clone().filter(|l| !stale(l)).map(|l| l.unit_price));
    if fresh.is_finite() {
        fresh
    } else {
        min(&mut listings.map(|l| l.unit_price))
    }
}

/// Channels by their lowest fresh price; unknown location last.
pub fn channel_groups<'a>(
    listings: &'a [Listing],
    stale: impl Fn(&Listing) -> bool,
) -> Vec<Group<'a>> {
    let channels: BTreeSet<Option<i16>> = listings.iter().map(|l| l.channel).collect();
    let mut groups: Vec<Group> = channels
        .into_iter()
        .map(|channel| {
            let mut ls: Vec<&Listing> = listings.iter().filter(|l| l.channel == channel).collect();
            ls.sort_by(|a, b| a.unit_price.total_cmp(&b.unit_price));
            let shops = ls
                .iter()
                .map(|l| (l.shop.as_str(), l.room))
                .collect::<BTreeSet<_>>()
                .len();
            Group {
                channel,
                min: fresh_min(ls.iter().copied(), &stale),
                listings: ls,
                shops,
            }
        })
        .collect();
    groups.sort_by(|a, b| {
        (a.channel.is_none(), a.min)
            .partial_cmp(&(b.channel.is_none(), b.min))
            .unwrap_or(std::cmp::Ordering::Equal)
    });
    groups
}

pub fn where_well(v: &View) -> Markup {
    let listings = &v.page.market.listings;
    let groups = channel_groups(listings, |l| v.stale(l.seen_at));
    let shops = listings
        .iter()
        .map(|l| (l.shop.as_str(), l.channel, l.room))
        .collect::<BTreeSet<_>>()
        .len();
    let rest = |shown: usize| groups.len().saturating_sub(shown);
    html! {
        div data-market="where" {
            section.well.where-well {
                div.well-h {
                    h3 { (v.t("在哪买", "Where to buy")) }
                    small { (count(v, listings.len(), "条挂单", "listings")) " · " (count(v, shops, "摊", "shops")) }
                    @if !groups.is_empty() {
                        label.sortb.right { span.sr { (v.t("报价排序", "Offer order")) }
                            select data-offer-sort title=(v.t("时间按最近采集到报价的时间计算", "Time is when an offer was last observed")) {
                                option value="price" { (v.t("最低价优先", "Lowest price first")) }
                                option value="recent" { (v.t("最新报价优先", "Latest offers first")) }
                            }
                        }
                    }
                }
                @if groups.is_empty() {
                    p.note { (v.t("最近 72 小时没有看到在售挂单。", "No listings seen in the last 72 hours.")) }
                } @else {
                    div.legend {
                        span { i {} (v.t("有货（数字为该洞最低价）", "in stock (lowest price in the room)")) }
                        span { i.best {} (v.t("本频道最低", "cheapest in channel")) }
                        span { i.stale {} (v.t("2 天没更新", "not seen for 2 days")) }
                    }
                    @for (i, g) in groups.iter().enumerate() {
                        (channel_group(v, g, i))
                    }
                    @if rest(CHANNELS_PHONE) > 0 {
                        button.more.on-phone type="button" data-more="where" { (more_channels(v, rest(CHANNELS_PHONE))) (PreEscaped(icon(Icon::Chev))) }
                    }
                    @if rest(CHANNELS_DESKTOP) > 0 {
                        button.more.on-desktop type="button" data-more="where" { (more_channels(v, rest(CHANNELS_DESKTOP))) (PreEscaped(icon(Icon::Chev))) }
                    }
                }
            }
        }
    }
}

fn more_channels(v: &View, n: usize) -> String {
    match v.ctx.lang {
        Lang::Zh => format!("显示其余 {n} 个频道 "),
        Lang::En => format!("Show {n} more channels "),
    }
}

/// "3 件" / "3 listed".
fn count(v: &View, n: usize, zh_unit: &str, en_unit: &str) -> String {
    match v.ctx.lang {
        Lang::Zh => format!("{n} {zh_unit}"),
        Lang::En => format!("{n} {en_unit}"),
    }
}

fn channel_group(v: &View, g: &Group, index: usize) -> Markup {
    let open = index == 0;
    let key = g
        .channel
        .map_or_else(|| "unknown".to_string(), |c| c.to_string());
    html! {
        div.cgroup.open[open].xp[index >= CHANNELS_PHONE].xd[index >= CHANNELS_DESKTOP] data-ch-key=(key) {
            button.cg-head type="button" data-ch aria-expanded=(open) {
                @match g.channel {
                    Some(ch) => span.chno { (super::channel_label(v.ctx.lang, ch)) },
                    None => span.chno.unk { (v.t("位置未知", "unknown")) },
                }
                span.cg-meta { (count(v, g.shops, "摊", "shops")) " · " (count(v, g.listings.len(), "条挂单", "listings")) }
                span.cg-min { (v.t("最低 ", "from ")) b { (meso_f(g.min)) } }
                span.caret { (PreEscaped(icon(Icon::Caret))) }
            }
            div.cg-body {
                @if g.channel.is_some() { (holes(v, g)) }
                div.cg-list {
                    @for l in &g.listings { (listing_row(v, l)) }
                }
            }
        }
    }
}

fn holes(v: &View, g: &Group) -> Markup {
    html! {
        div.holes aria-label=(v.t("22 个洞的在售情况", "Listings in the 22 rooms")) {
            @for room in 1..=ROOMS {
                @let here: Vec<&&Listing> = g.listings.iter().filter(|l| l.room == Some(room)).collect();
                @if here.is_empty() {
                    span.hole { i { (room) } }
                } @else {
                    @let all_stale = here.iter().all(|l| v.stale(l.seen_at));
                    @let price = fresh_min(here.iter().map(|l| **l), |l| v.stale(l.seen_at));
                    @let best = !all_stale && price == g.min;
                    span.hole.lit.stale[all_stale].best[best] title=(hole_title(v, room, price)) {
                        i { (room) } b { (meso_f(price)) }
                    }
                }
            }
        }
    }
}

fn hole_title(v: &View, room: i16, price: f64) -> String {
    match v.ctx.lang {
        Lang::Zh => format!("{room} 洞 最低 {}", meso_f(price)),
        Lang::En => format!("room {room}, from {}", meso_f(price)),
    }
}

fn listing_row(v: &View, l: &Listing) -> Markup {
    let key = format!(
        "{}|{:?}|{:?}|{:?}|{}|{}",
        l.shop,
        l.channel,
        l.room,
        l.variant.as_ref().map(|x| x.id),
        l.unit_price,
        l.seen_at.timestamp()
    );
    if !is_equipment(i64::from(v.page.item.id)) {
        return html! {
            div.lrow.stale[v.stale(l.seen_at)] data-quote=(key) data-observed=(l.seen_at.timestamp()) data-unit-price=(l.unit_price) {
                span.lshop { (l.shop) }
                span.lroom { (l.room.map(|r| room_label(v.ctx.lang, r)).unwrap_or_else(|| v.t("洞未知", "room ?").into())) }
                span.lp { (meso_f(l.unit_price)) }
                span.lq title=(v.t("库存数量，未知时显示 —", "Stock; — means unknown")) { @if let Some(stock)=l.stock { "×" (stock) } @else { "—" } }
                span.la data-relative-time=(l.seen_at.timestamp()) { (v.ago(l.seen_at)) }
            }
        };
    }
    let key = format!(
        "{}|{:?}|{:?}|{:?}|{}|{}",
        l.shop,
        l.channel,
        l.room,
        l.variant.as_ref().map(|x| x.id),
        l.unit_price,
        l.seen_at.timestamp()
    );
    html! {
        details.listing-offer.stale[v.stale(l.seen_at)] data-quote=(key) data-offer=(key) data-observed=(l.seen_at.timestamp()) data-unit-price=(l.unit_price) data-bonus=[bonus_attr(v, l.variant.as_ref())] {
        summary.lrow {
            span.lshop { span.offer-chevron aria-hidden="true" { "›" } span { (l.shop) } }
            span.lroom {
                @match l.room {
                    Some(room) => (room_label(v.ctx.lang, room)),
                    None => (v.t("洞未知", "room ?")),
                }
            }
            span.lp { (meso_f(l.unit_price)) }
            span.lq title=(v.t("库存数量，未知时显示 —", "Stock; — means unknown")) { @if let Some(stock)=l.stock { "×" (stock) } @else { "—" } }
            span.la data-relative-time=(l.seen_at.timestamp()) { (v.ago(l.seen_at)) }
        }
            div.offer-body {
                @if let Some(variant) = &l.variant {
                    div.tip { (variant_stats(v, variant)) }

                } @else {
                    p.note { (v.t("暂无属性", "Stats unavailable")) }
                }
                p.fnote { (v.t("最近观察：", "Last observed: ")) time data-local-time=(l.seen_at.timestamp()) { (l.seen_at.format("%Y-%m-%d %H:%M UTC").to_string()) }
                    @if v.stale(l.seen_at) { " · " (v.t("已过期", "Outdated")) } }
            }
        }
    }
}

pub fn room_label(lang: Lang, room: i16) -> String {
    match lang {
        Lang::Zh => format!("{room}洞"),
        Lang::En => format!("room {room}"),
    }
}

// ---------- price ladder ----------

#[derive(Debug, Clone, PartialEq)]
pub struct Tier {
    pub lo: i64,
    /// `None`: open-ended top tier.
    pub hi: Option<i64>,
    pub listings: usize,
}

impl Tier {
    fn holds(&self, price: f64) -> bool {
        let p = price.floor() as i64;
        p >= self.lo && self.hi.is_none_or(|hi| p <= hi)
    }

    /// "400–449" as in the mockup; round bounds from 1K up read "2.5K–5K"
    /// (the band up to, not including, 5K).
    fn label(&self) -> String {
        let round = |v: i64| {
            if v >= 1_000_000 {
                v % 100_000 == 0
            } else {
                v >= 1_000 && v % 100 == 0
            }
        };
        let short = |v: i64| if round(v) { meso(v) } else { v.to_string() };
        match self.hi {
            None => format!("{}+", short(self.lo)),
            Some(hi) if self.lo == 0 => format!("< {}", short(hi + 1)),
            Some(hi) if hi == self.lo => hi.to_string(),
            Some(hi) if round(self.lo) && round(hi + 1) => {
                format!("{}–{}", meso(self.lo), meso(hi + 1))
            }
            Some(hi) => format!("{}–{hi}", self.lo),
        }
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct Ladder {
    /// Cheapest first.
    pub tiers: Vec<Tier>,
    /// Sales per tier per day.
    pub grid: Vec<Vec<u32>>,
}

impl Ladder {
    fn index(&self, price: f64) -> Option<usize> {
        self.tiers.iter().position(|t| t.holds(price))
    }
}

/// At most this many tiers between the open bottom and top ones.
const INNER_TIERS: i64 = 8;

/// 1, 2, 5, 10, 20, 25, 50, 100, 200, 250, 500, ...
fn nice_steps() -> impl Iterator<Item = i64> {
    (0..12u32).flat_map(|exp| {
        let base = 10_i64.pow(exp);
        let quarter = (exp > 0).then(|| base * 25 / 10);
        [Some(base), Some(base * 2), quarter, Some(base * 5)]
            .into_iter()
            .flatten()
    })
}

/// Tier bounds over the middle 80% of `prices`, so a few far-off listings do
/// not stretch the range. Skewed prices (the dear end at least ten times the
/// cheap end, like white gear next to rolled gear) step by 1-2-5 multiples;
/// otherwise the smallest round step that fits in eight tiers, within 1.5
/// interquartile ranges of the middle half. Open tiers below and above. Mirrors `tierBounds` in frontend/src/lib/item-market.ts,
/// which redraws this first paint: keep the two in step.
pub fn tier_bounds(prices: &[f64]) -> Vec<(i64, Option<i64>)> {
    let mut sorted: Vec<i64> = prices
        .iter()
        .filter(|p| p.is_finite() && **p >= 0.0)
        .map(|p| p.floor() as i64)
        .collect();
    if sorted.is_empty() {
        return Vec::new();
    }
    sorted.sort_unstable();
    let rank = |q: f64| sorted[((sorted.len() - 1) as f64 * q).round() as usize];
    let (lo, hi) = (rank(0.1), rank(0.9));
    if lo > 0 && hi >= lo.saturating_mul(10) {
        let mut marks = Vec::new();
        let mut base = 10_i64.pow(lo.ilog10());
        while base <= hi.saturating_mul(10) {
            for mark in [base, base * 2, base * 5] {
                if mark > lo && mark <= hi {
                    marks.push(mark);
                }
            }
            base = base.saturating_mul(10);
        }
        if marks.len() >= 2 {
            let mut bounds = vec![(0, Some(marks[0] - 1))];
            bounds.extend(marks.windows(2).map(|pair| (pair[0], Some(pair[1] - 1))));
            bounds.push((marks[marks.len() - 1], None));
            return bounds;
        }
    }
    // Without skew a long tail of far-off listings would still stretch equal
    // tiers: keep the range within 1.5 interquartile ranges of the middle half.
    let (q1, q3) = (rank(0.25), rank(0.75));
    let fence = (q3 - q1) * 3 / 2;
    let (lo, hi) = (lo.max(q1 - fence), hi.min(q3 + fence));
    let (step, start, inner) = nice_steps()
        .map(|step| {
            let start = lo / step * step;
            (step, start, (hi - start) / step + 1)
        })
        .find(|(_, _, inner)| *inner <= INNER_TIERS)
        .expect("a large enough step exists");
    let mut bounds = Vec::new();
    if start > 0 {
        bounds.push((0, Some(start - 1)));
    }
    for i in 0..inner {
        let from = start + i * step;
        bounds.push((from, Some(from + step - 1)));
    }
    bounds.push((start + inner * step, None));
    bounds
}

pub fn ladder(market: &ItemMarket) -> Option<Ladder> {
    let mut prices: Vec<f64> = market.listings.iter().map(|l| l.unit_price).collect();
    prices.extend(market.sale_points.iter().map(|p| p.price));
    let bounds = tier_bounds(&prices);
    if bounds.is_empty() {
        return None;
    }
    let tiers: Vec<Tier> = bounds
        .into_iter()
        .map(|(lo, hi)| Tier {
            lo,
            hi,
            listings: 0,
        })
        .collect();
    let mut ladder = Ladder {
        grid: vec![vec![0; market.days.len().max(1)]; tiers.len()],
        tiers,
    };
    for l in &market.listings {
        if let Some(i) = ladder.index(l.unit_price) {
            ladder.tiers[i].listings += 1;
        }
    }
    for p in &market.sale_points {
        if let Some(i) = ladder.index(p.price) {
            if let Some(cell) = ladder.grid[i].get_mut(p.day) {
                *cell += 1;
            }
        }
    }
    Some(ladder)
}

/// The sentence under a selected tier: how many are on sale at or below it,
/// and how many recent sales paid more.
fn ladder_read(v: &View, ladder: &Ladder, ti: usize) -> Markup {
    let tier = &ladder.tiers[ti];
    let stock: usize = ladder.tiers[..=ti].iter().map(|t| t.listings).sum();
    let Some(cap) = tier.hi else {
        return html! {
            (v.t("不限价：在售 ", "Any price: ")) b { (stock) } (v.t(" 条", " listed"))
        };
    };
    let points = &v.page.market.sale_points;
    let head = html! {
        "≤ " b { (grouped(cap)) } (v.t("：在售 ", ": ")) b { (stock) } (v.t(" 条 · ", " listed · "))
    };
    if points.is_empty() {
        return html! { (head) (v.t("近 7 天没有成交", "no sales in 7 days")) };
    }
    let above = points
        .iter()
        .filter(|p| p.price.floor() as i64 > cap)
        .count();
    let pct = (above as f64 * 100.0 / points.len() as f64).round() as i64;
    let (class, verdict) = if pct >= 65 {
        ("", v.t("好价，能买", "good price, buy"))
    } else if pct >= 35 {
        ("mid", v.t("正常价", "normal price"))
    } else {
        ("high", v.t("偏贵，可以等", "pricey, can wait"))
    };
    html! {
        (head)
        (v.t("近 7 天 ", "")) b { (pct) "%" } (v.t(" 的成交更贵", " of 7-day sales paid more"))
        span class={"v " (class)} { (verdict) }
    }
}

fn day_labels(v: &View) -> Vec<String> {
    let today = v.ctx.now.date_naive();
    v.page
        .market
        .days
        .iter()
        .map(|d| {
            if d.date == today {
                v.t("今", "now").to_string()
            } else {
                d.date.format("%-d").to_string()
            }
        })
        .collect()
}

/// Square size class `d5`..`d16`, bar width class `f0`..`f20` (no inline
/// styles under the CSP; `item.css` maps them to the mockup's sizes).
fn square_class(count: u32, max: u32) -> String {
    let d = 5.0 + 11.0 * (f64::from(count) / f64::from(max.max(1))).sqrt();
    format!("d{}", d.round() as u32)
}

fn bar_class(n: usize, max: usize) -> String {
    format!("f{}", (n as f64 * 20.0 / max.max(1) as f64).round() as u32)
}

fn ladder_pane(v: &View) -> Markup {
    let Some(ladder) = ladder(&v.page.market) else {
        return html! { p.note { (v.t("还没有挂单和成交，画不出价格分布。", "No listings or sales yet, so no price bands.")) } };
    };
    let stats = v.stats();
    let pick = |price: Option<i64>| price.and_then(|p| ladder.index(p as f64));
    let busiest = (0..ladder.tiers.len())
        .max_by_key(|&i| ladder.tiers[i].listings)
        .unwrap_or(0);
    let selected = pick(stats.and_then(|s| s.typical_low)).unwrap_or(busiest);
    let median = pick(stats.and_then(|s| s.typical));
    let max_stock = ladder.tiers.iter().map(|t| t.listings).max().unwrap_or(0);
    let max_count = ladder.grid.iter().flatten().copied().max().unwrap_or(0);
    html! {
        @for i in 0..ladder.tiers.len() {
            p.ladder-read data-read=(i) hidden[i != selected] { (ladder_read(v, &ladder, i)) }
        }
        div.ladder {
            div.rung-h {
                span.l { (v.t("挂单", "Listed")) }
                span.c { (v.t("价格", "price")) }
                span.r { @for day in &v.page.market.days {
                    time datetime=(day.date.format("%Y-%m-%d")) title=(day.date.format("%Y-%m-%d")) data-ladder-date=(day.date.format("%Y-%m-%d")) {
                        small { (day.date.format("%-m")) (v.t("月", "/")) }
                        b { (day.date.format("%-d")) }
                    }
                } }
            }
            @for (i, tier) in ladder.tiers.iter().enumerate().rev() {
                button.rung.sel[i == selected].med[median == Some(i)] type="button" data-tier=(i) aria-pressed=(i == selected) {
                    span.rung-l { (tier.listings) i class=(bar_class(tier.listings, max_stock)) {} }
                    span.rung-p { (tier.label()) }
                    span.rung-r {
                        @for &c in &ladder.grid[i] {
                            span { @if c > 0 { i class=(square_class(c, max_count)) title=(sales_title(v, c)) {} } }
                        }
                    }
                }
            }
        }
        div.ladder-foot {
            span {
                i {}
                (v.t("每日成交", "daily sales"))
            }
            @if median.is_some() { span { i.tri {} (v.t("成交中位", "typical sale")) } }
        }
    }
}

fn sales_title(v: &View, n: u32) -> String {
    match v.ctx.lang {
        Lang::Zh => format!("{n} 笔"),
        Lang::En => format!("{n} sales"),
    }
}

// ---------- trend ----------

fn trend_pane(v: &View) -> Markup {
    let days = &v.page.market.days;
    let highs: Vec<f64> = days
        .iter()
        .filter(|d| d.median.is_some())
        .filter_map(|d| d.high.or(d.median))
        .collect();
    if highs.is_empty() || days.len() < 2 {
        return html! { p.note { (v.t("近 7 天没有成交，画不出走势。", "No sales in the last 7 days, so no trend.")) } };
    }
    let (w, h, pl, pr, pt, pb) = (340.0, 170.0, 40.0, 8.0, 12.0, 26.0);
    let top = highs.iter().copied().fold(0.0, f64::max).max(1.0);
    let step = 10_f64.powf(top.log10().floor());
    let hi = ((top * 1.05) / step).ceil() * step;
    let max_count = f64::from(days.iter().map(|d| d.count).max().unwrap_or(1).max(1));
    let x = |i: usize| pl + (i as f64 / (days.len() - 1) as f64) * (w - pl - pr);
    let y = |val: f64| pt + (1.0 - val / hi) * (h - pt - pb);
    let mut path = String::new();
    let mut pen = false;
    for (i, d) in days.iter().enumerate() {
        match d.median {
            Some(m) => {
                path.push_str(&format!(
                    "{}{:.1},{:.1}",
                    if pen { 'L' } else { 'M' },
                    x(i),
                    y(m)
                ));
                pen = true;
            }
            None => pen = false,
        }
    }
    let labels = day_labels(v);
    let label = v.t("7 日成交走势", "7-day sale trend");
    html! {
        div.trend {
            svg viewBox={"0 0 " (w) " " (h)} role="img" aria-label=(label) {
                @for tick in [0.0, hi / 2.0, hi] {
                    text x=(format!("{:.1}", pl - 6.0)) y=(format!("{:.1}", y(tick) + 4.0)) text-anchor="end" font-size="12" fill="var(--ink-3)" { (meso(tick.round() as i64)) }
                    line x1=(pl) x2=(w - pr) y1=(format!("{:.1}", y(tick))) y2=(format!("{:.1}", y(tick))) stroke="var(--rule)" stroke-dasharray="2 3" {}
                }
                @for (i, d) in days.iter().enumerate() {
                    @let bar = f64::from(d.count) / max_count * 34.0;
                    rect x=(format!("{:.1}", x(i) - 7.0)) y=(format!("{:.1}", h - pb - bar)) width="14" height=(format!("{bar:.1}")) fill="var(--ink-3)" opacity=".28" {}
                    @if let (Some(_), Some(lo), Some(top)) = (d.median, d.low, d.high) {
                        rect x=(format!("{:.1}", x(i) - 2.0)) y=(format!("{:.1}", y(top))) width="4" height=(format!("{:.1}", y(lo) - y(top))) fill="var(--mark)" opacity=".35" {}
                    }
                }
                path d=(path) fill="none" stroke="var(--mark)" stroke-width="2" {}
                @for (i, d) in days.iter().enumerate() {
                    @if let Some(m) = d.median {
                        rect x=(format!("{:.1}", x(i) - 3.0)) y=(format!("{:.1}", y(m) - 3.0)) width="6" height="6" fill="var(--mark)" {}
                    }
                }
                @for (i, l) in labels.iter().enumerate() {
                    text x=(format!("{:.1}", x(i))) y=(h - 8.0) text-anchor="middle" font-size="12" fill="var(--ink-3)" { (l) }
                }
                @for (i, _) in days.iter().enumerate() {
                    @let left = if i == 0 { pl } else { (x(i-1)+x(i))/2.0 };
                    @let right = if i+1 == days.len() { w-pr } else { (x(i)+x(i+1))/2.0 };
                    g data-trend-marker=(i) aria-hidden="true" {
                        line x1=(x(i)) x2=(x(i)) y1=(pt) y2=(h-pb) stroke="var(--bar-text)" stroke-dasharray="3 3" {}
                    }
                    rect.trend-hit data-trend-hit=(i) x=(left) y=(pt) width=(right-left) height=(h-pt-pb) fill="transparent" aria-hidden="true" {}
                }
            }
            div.trend-days role="group" aria-label=(v.t("选择日期查看精确值", "Select a day for exact values")) {
                @for (i, d) in days.iter().enumerate() {
                    button type="button" data-trend-day=(i) data-date=(d.date.to_string())
                        data-start=(d.date.and_hms_opt(0,0,0).unwrap().and_utc().timestamp())
                        data-median=[d.median.map(|n|n.to_string())] data-low=[d.low.map(|n|n.to_string())]
                        data-high=[d.high.map(|n|n.to_string())] data-count=(d.count) aria-pressed="false"
                        title={ (d.date) " UTC · " (v.t("中位价", "Median")) " " (d.median.map(|n|grouped(n as i64)).unwrap_or_else(||"—".into())) " · " (d.count) " " (v.t("笔", "sales")) } {
                        (d.date.format("%m/%d"))
                    }
                }
            }
            div.trend-readout role="status" aria-live="polite" aria-atomic="true" {
                div.trend-range data-trend-range { (v.t("移到图上或点日期查看精确值", "Hover over the chart or select a date for exact values")) }
                dl {
                    div { dt { (v.t("中位价", "Median")) } dd data-trend-value="median" { "—" } }
                    div { dt { (v.t("最低价", "Low")) } dd data-trend-value="low" { "—" } }
                    div { dt { (v.t("最高价", "High")) } dd data-trend-value="high" { "—" } }
                    div { dt { (v.t("成交笔数", "Sales")) } dd data-trend-value="count" { "—" } }
                }
            }
            div.lg {
                span { i.k-med {} (v.t("每日成交中位", "daily median")) }
                span { i.k-span {} (v.t("最低–最高", "low–high")) }
                span { i.k-count {} (v.t("成交笔数", "sales")) }
            }
        }
    }
}

// ---------- recent sales ----------

pub fn evidence(kind: SaleKind, lang: Lang) -> &'static str {
    match kind {
        SaleKind::Drop => lang.t("看到卖出", "seen sold"),
        SaleKind::SoldOut => lang.t("看到卖光", "seen sold out"),
        SaleKind::FoundSold => lang.t("发现已售", "found sold"),
    }
}

/// "6 slots in one shop" on a sale that stands for several shop slots.
fn merged_title(v: &View, s: &Sale) -> Option<String> {
    (s.merged_count > 1).then(|| match v.ctx.lang {
        Lang::Zh => format!("同店 {} 格合计", s.merged_count),
        Lang::En => format!("{} slots in one shop", s.merged_count),
    })
}

fn sale_row(v: &View, s: &Sale, with_shop: bool, extra: bool) -> Markup {
    html! {
        div.sale.extra[extra] data-bonus=[bonus_attr(v, s.variant.as_ref())] {
            span class={"evi " (s.kind.as_str())} title=[merged_title(v, s)] { (evidence(s.kind, v.ctx.lang)) }
            span {
                span.sp { (meso_f(s.unit_price)) }
                span.sq {
                    @match s.quantity {
                        Some(q) => { "×" (q) },
                        None if s.merged_count > 1 => {
                            @match v.ctx.lang {
                                Lang::Zh => { (s.merged_count) " 格" },
                                Lang::En => { (s.merged_count) " slots" },
                            }
                        },
                        None => (v.t("数量未知", "qty unknown")),
                    }
                }
            }
            @if let Some(place) = &s.observed_location {
                span.loc title=(v.t("采集时所在地图，不保证摊位仍在此处", "Observed map; current shop location is not guaranteed")) {
                    @if let Some(ch)=s.channel { b { (super::channel_label(v.ctx.lang, ch)) } }
                    span { (place) }
                }
            } @else { (loc(v.ctx.lang, s.channel, s.room)) }
            @if with_shop { span.ss { (s.shop) } }
            span.sa data-relative-time=(s.detected_at.timestamp()) title=(s.detected_at.format("%Y-%m-%d %H:%M UTC").to_string()) { (v.ago(s.detected_at)) }
        }
    }
}

fn sales_list(v: &View, with_shop: bool) -> Markup {
    let sales = &v.page.market.sales;
    html! {
        @if sales.is_empty() {
            p.note { (v.t("还没有看到这件物品的成交。", "No sales of this item seen yet.")) }
        } @else {
            div.sales-list.salegrid[with_shop] {
                @for (i, s) in sales.iter().enumerate() {
                    (sale_row(v, s, with_shop, i >= SALES_SHOWN))
                }
            }
            @if sales.len() > SALES_SHOWN {
                button.more type="button" data-more="sales" {
                    @match v.ctx.lang {
                        Lang::Zh => { "显示全部 " (sales.len()) " 条 " },
                        Lang::En => { "Show all " (sales.len()) " " },
                    }
                    (PreEscaped(icon(Icon::Chev)))
                }
            }
        }
    }
}

/// Ladder / trend tabs; on phones "recent sales" is a third tab.
pub fn tabs_well(v: &View) -> Markup {
    let n = v.page.market.sales.len();
    html! {
        div data-market="tabs" {
            section.well.tabs-well {
                div.tabs role="tablist" {
                    button.tab.on type="button" role="tab" aria-selected="true" data-tab="ladder" { (v.t("价格分布", "Price bands")) }
                    button.tab type="button" role="tab" aria-selected="false" data-tab="trend" { (v.t("走势", "Trend")) }
                    button.tab.on-phone type="button" role="tab" aria-selected="false" data-tab="sales" {
                        (v.t("最近成交", "Sales")) " " (n)
                    }
                }
                div.pane data-pane="ladder" { (ladder_pane(v)) }
                div.pane data-pane="trend" hidden { (trend_pane(v)) }
                div.pane data-pane="sales" hidden { (sales_list(v, false)) }
            }
        }
    }
}

/// Desktop: recent sales in their own panel, two columns.
pub fn sales_well(v: &View) -> Markup {
    let n = v.page.market.sales.len();
    html! {
        div.on-desktop data-market="sales" {
            section.well.sales-well {
                div.well-h {
                    h3 { (v.t("最近成交", "Recent sales")) }
                    small {
                        @match v.ctx.lang {
                            Lang::Zh => { (n) " 条 · 新的在前" },
                            Lang::En => { (n) " · newest first" },
                        }
                    }
                }
                (sales_list(v, true))
            }
        }
    }
}

// ---------- equipment stats ----------

/// A listed instance has bonus stats when a stat beats the item's reference
/// value (or the reference lacks it), excluding physical and magic defence.
pub fn has_bonus(variant: &Variant, base: &[(String, i64)]) -> bool {
    variant.stats.iter().any(|s| {
        if matches!(
            s.key.as_str(),
            "weapon_defense" | "magic_defense" | "pdd" | "mdd"
        ) {
            return false;
        }
        let reference = base.iter().find(|(k, _)| *k == s.key).map(|(_, b)| *b);
        s.value > reference.unwrap_or(0)
    })
}

fn bonus_attr(v: &View, variant: Option<&Variant>) -> Option<&'static str> {
    let variant = variant?;
    Some(if has_bonus(variant, &v.page.market.base_stats) {
        "1"
    } else {
        "0"
    })
}

/// English names of the decoder's stat keys.
fn stat_label(stat: &Stat, lang: Lang) -> &str {
    if lang == Lang::Zh {
        return &stat.label;
    }
    match stat.key.as_str() {
        "weapon_attack" => "Weapon ATT",
        "magic_attack" => "Magic ATT",
        "weapon_defense" => "Weapon DEF",
        "magic_defense" => "Magic DEF",
        "str" => "STR",
        "dex" => "DEX",
        "int" => "INT",
        "luk" => "LUK",
        "accuracy" => "Accuracy",
        "avoid" => "Avoidability",
        "speed" => "Speed",
        "jump" => "Jump",
        "hp" => "Max HP",
        "mp" => "Max MP",
        _ => &stat.label,
    }
}

fn variant_stats(v: &View, variant: &Variant) -> Markup {
    let name = v.page.item.names();
    let base = &v.page.market.base_stats;
    html! {
                                div.tip-h {
                                    b { (name.get(v.ctx.lang)) }
                                    @if let Some(e) = variant.enhancements.filter(|e| *e > 0) { span.tip-up { "+" (e) } }
                                }
                                ul {
                                    @for s in &variant.stats {
                                        @let reference = base.iter().find(|(k, _)| *k == s.key).map(|(_, b)| *b);
                                        @let up = s.value > reference.unwrap_or(0);
                                        li.up[up] {
                                            span { (stat_label(s, v.ctx.lang)) } b { "+" (s.value) }
                                            @if let Some(r) = reference.filter(|r| s.value > *r) { i { "(+" (s.value - r) ")" } }
                                        }
                                    }
                                    @if variant.stats.is_empty() { li { (v.t("没有解析到属性", "no stats decoded")) } }
                                }
                                @if let Some(left) = variant.remaining_upgrades {
                                    div.tip-s { (v.t("可升级次数：", "Upgrades available: ")) (left) }
                                }

        @if let Some(other) = name.secondary(v.ctx.lang) { div.tip-s { (other) } }
    }
}

struct VariantOffer<'a> {
    variant: &'a Variant,
    listings: Vec<&'a Listing>,
}

/// One tooltip box per equipment instance on sale, cheapest first, with a
/// "bonus stats only" switch (rows of plain instances hide too).
pub fn equipment_well(v: &View) -> Option<Markup> {
    if !is_equipment(i64::from(v.page.item.id)) {
        return None;
    }
    let mut offers: Vec<VariantOffer> = Vec::new();
    for l in &v.page.market.listings {
        let Some(variant) = &l.variant else { continue };
        match offers.iter_mut().find(|o| o.variant.id == variant.id) {
            Some(o) => o.listings.push(l),
            None => offers.push(VariantOffer {
                variant,
                listings: vec![l],
            }),
        }
    }
    let base = &v.page.market.base_stats;
    Some(html! {
        div data-market="equip" {
            section.well.equip-well {
                div.well-h {
                    h3 { (v.t("装备属性", "Equipment stats")) }
                    small { (count(v, offers.len(), "种在售", "on sale")) }
                }
                @if offers.is_empty() {
                    p.note { (v.t("最近 72 小时没有看到带属性的在售装备。", "No listed instance with decoded stats in the last 72 hours.")) }
                } @else {
                    div.tips {
                        @for (i, o) in offers.iter().enumerate() {
                            @let bonus = has_bonus(o.variant, base);
                            a.tip.equipment-group-link.extra[i >= VARIANTS_SHOWN] href=(format!("/item/{}?variant={}&hours={}&lang={}", v.page.item.id, o.variant.id, if v.ctx.here.contains("hours=all") {"all"} else {"72"}, if v.ctx.lang==Lang::En {"en"} else {"zh"})) data-bonus=(if bonus { "1" } else { "0" }) {
                                (variant_stats(v, o.variant))
                                div.tip-f {
                                    @let cheapest = o.listings[0];
                                    (v.t("最低 ", "from ")) b { (meso_f(cheapest.unit_price)) }
                                    " · " (count(v, o.listings.len(), "件", "listed")) " · "
                                    (loc(v.ctx.lang, cheapest.channel, cheapest.room))
                                }
                                span.tip-link { (v.t("查看报价 ›", "View offers ›")) }
                            }
                        }
                    }
                    @if offers.len() > VARIANTS_SHOWN {
                        button.more type="button" data-more="equip" {
                            @match v.ctx.lang {
                                Lang::Zh => { "显示全部 " (offers.len()) " 件 " },
                                Lang::En => { "Show all " (offers.len()) " " },
                            }
                            (PreEscaped(icon(Icon::Chev)))
                        }
                    }
                }
            }
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use sqlx::types::chrono::TimeZone;

    fn listing(channel: Option<i16>, room: i16, price: f64, age_hours: i64) -> Listing {
        Listing {
        owner_name: None,
        invalidated_at: None,
            grouping: None,
            shop: format!("shop{room}"),
            channel,
            room: Some(room),
            unit_price: price,
            stock: Some(1),
            seen_at: Utc
                .timestamp_opt(as_of().timestamp() - age_hours * 3600, 0)
                .unwrap(),
            variant: None,
        }
    }

    fn as_of() -> DateTime<Utc> {
        Utc.with_ymd_and_hms(2026, 10, 19, 5, 0, 0).unwrap()
    }

    #[test]
    fn groups_sort_by_fresh_minimum_and_put_unknown_last() {
        let ls = vec![
            listing(Some(14), 8, 299.0, 1),
            listing(Some(10), 3, 250.0, 60), // stale: ignored for the minimum
            listing(Some(10), 4, 345.0, 1),
            listing(None, 1, 100.0, 1),
        ];
        let stale = |l: &Listing| (as_of() - l.seen_at).num_seconds() > STALE_SECONDS;
        let groups = channel_groups(&ls, stale);
        let order: Vec<Option<i16>> = groups.iter().map(|g| g.channel).collect();
        assert_eq!(order, vec![Some(14), Some(10), None]);
        assert_eq!(groups[1].min, 345.0);
        assert_eq!(groups[1].listings[0].unit_price, 250.0, "cheapest first");
        assert_eq!(groups[1].shops, 2);
    }

    #[test]
    fn iron_ore_gets_fifty_meso_tiers() {
        // The mockup's range: most prices 250-599, outliers either side.
        let mut prices: Vec<f64> = (0..100).map(|i| 250.0 + f64::from(i) * 3.5).collect();
        prices.extend([55.0, 750.0]);
        let bounds = tier_bounds(&prices);
        assert_eq!(bounds.first(), Some(&(0, Some(249))));
        assert_eq!(bounds[1], (250, Some(299)));
        assert_eq!(bounds.last(), Some(&(600, None)));
        assert_eq!(bounds.len(), 9);
    }

    /// The same fixtures as web/tests/react-item-market.test.mjs: both sides draw the same bands.
    #[test]
    fn tier_bounds_match_the_browser() {
        // Most stars at 1.7K-2.4K, some to 4.9K, five listed from 17.5K up.
        let mut stars: Vec<f64> = (0..70).map(|i| 1700.0 + f64::from(i) * 10.0).collect();
        stars.extend((0..25).map(|i| 2500.0 + f64::from(i) * 100.0));
        stars.extend((0..5).map(|i| 17_500.0 + f64::from(i) * 1000.0));
        assert_eq!(
            tier_bounds(&stars),
            vec![
                (0, Some(1499)),
                (1500, Some(1999)),
                (2000, Some(2499)),
                (2500, Some(2999)),
                (3000, Some(3499)),
                (3500, Some(3999)),
                (4000, Some(4499)),
                (4500, None),
            ]
        );
        // White gear around 1K next to rolled gear up to 200K: 1-2-5 steps.
        let mut gear: Vec<f64> = (0..60).map(|i| 900.0 + f64::from(i) * 10.0).collect();
        gear.extend((0..40).map(|i| 5000.0 + f64::from(i) * 5000.0));
        assert_eq!(
            tier_bounds(&gear),
            vec![
                (0, Some(1999)),
                (2000, Some(4999)),
                (5000, Some(9999)),
                (10_000, Some(19_999)),
                (20_000, Some(49_999)),
                (50_000, Some(99_999)),
                (100_000, None),
            ]
        );
        // 60 at 2K-2.6K, 30 at 3K-5.9K, 15 from 8K up: the tail stays in the open top tier.
        let mut tail: Vec<f64> = (0..60).map(|i| 2000.0 + f64::from(i) * 10.0).collect();
        tail.extend((0..30).map(|i| 3000.0 + f64::from(i) * 100.0));
        tail.extend((0..15).map(|i| 8000.0 + f64::from(i) * 1000.0));
        let mut expected = vec![(0, Some(1999))];
        expected.extend((2..9).map(|k| (k * 1000, Some(k * 1000 + 999))));
        expected.push((9000, None));
        assert_eq!(tier_bounds(&tail), expected);
    }

    #[test]
    fn tier_counts_stay_between_six_and_ten() {
        for (lo, hi) in [(10.0, 30.0), (900.0, 5_000.0), (1.0e5, 9.0e6), (45.0, 46.0)] {
            let prices: Vec<f64> = (0..50)
                .map(|i| lo + (hi - lo) * f64::from(i) / 49.0)
                .collect();
            let n = tier_bounds(&prices).len();
            assert!((3..=10).contains(&n), "{lo}-{hi}: {n} tiers");
            if hi - lo > 10.0 {
                assert!(n >= 6, "{lo}-{hi}: {n} tiers");
            }
        }
        assert!(tier_bounds(&[]).is_empty());
    }

    #[test]
    fn tier_labels() {
        let t = |lo, hi| Tier {
            lo,
            hi,
            listings: 0,
        };
        assert_eq!(t(0, Some(249)).label(), "< 250");
        assert_eq!(t(250, Some(299)).label(), "250–299");
        assert_eq!(t(600, None).label(), "600+");
        assert_eq!(t(45, Some(45)).label(), "45");
        assert_eq!(t(10_000, Some(19_999)).label(), "10K–20K");
        assert_eq!(t(2_500, Some(4_999)).label(), "2.5K–5K");
        assert_eq!(t(0, Some(2_499)).label(), "< 2.5K");
        assert_eq!(t(17_500, None).label(), "17.5K+");
        assert_eq!(t(1_250, Some(1_299)).label(), "1250–1299");
        assert_eq!(t(0, Some(9_999)).label(), "< 10K");
        assert_eq!(t(60_000, None).label(), "60K+");
        assert!(t(400, Some(449)).holds(449.6));
    }

    #[test]
    fn bonus_compares_with_reference() {
        let variant = |value: i64, enhancements: i64| Variant {
            id: 1,
            stats: vec![Stat {
                key: "weapon_attack".into(),
                label: "物理攻击".into(),
                value,
            }],
            remaining_upgrades: Some(7),
            enhancements: Some(enhancements),
            unknown_fields: 0,
        };
        let base = vec![("weapon_attack".to_string(), 17)];
        assert!(!has_bonus(&variant(17, 0), &base));
        assert!(has_bonus(&variant(18, 0), &base));
        assert!(
            !has_bonus(&variant(15, 1), &base),
            "enhancements alone do not imply useful bonus stats"
        );
        for key in ["weapon_defense", "magic_defense"] {
            let mut defence_only = variant(25, 1);
            defence_only.stats[0].key = key.into();
            assert!(!has_bonus(&defence_only, &[]));
        }
        assert!(
            has_bonus(&variant(1, 0), &[]),
            "no reference: any stat counts"
        );
    }

    #[test]
    fn size_classes() {
        assert_eq!(square_class(1, 1), "d16");
        assert_eq!(square_class(0, 9), "d5");
        assert_eq!(bar_class(50, 100), "f10");
        assert_eq!(bar_class(0, 0), "f0");
    }
}

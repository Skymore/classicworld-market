//! Small, escaped fragment for the shared item hover/touch preview.
use super::market::{category_label, View};
use super::{slot, Ctx};
use crate::bestiary::{
    format::{grouped, Lang},
    model::ItemPage,
};
use maud::{html, Markup};

fn stat_name(key: &str, lang: Lang) -> &str {
    let (zh, en) = match key {
        "weapon_attack" => ("物理攻击", "Weapon ATT"),
        "magic_attack" => ("魔法攻击", "Magic ATT"),
        "weapon_defense" => ("物理防御", "Weapon DEF"),
        "magic_defense" => ("魔法防御", "Magic DEF"),
        "str" => ("力量", "STR"),
        "dex" => ("敏捷", "DEX"),
        "int" => ("智力", "INT"),
        "luk" => ("幸运", "LUK"),
        "accuracy" => ("命中", "Accuracy"),
        "avoid" => ("回避", "Avoidability"),
        "speed" => ("移动速度", "Speed"),
        "jump" => ("跳跃", "Jump"),
        "hp" => ("最大生命", "Max HP"),
        "mp" => ("最大魔法", "Max MP"),
        _ => (key, key),
    };
    lang.t(zh, en)
}

pub fn item_preview(page: &ItemPage, ctx: &Ctx) -> Markup {
    let item = &page.item;
    let names = item.names();
    let v = View::new(ctx, page);
    let all = ctx.here.contains("hours=all");
    let stats = page.stats.as_ref();
    let price = |n: Option<i64>| n.map(grouped).unwrap_or_else(|| "—".into());
    html! {
        div.peek-content data-preview-item=(item.id) {
            header.peek-head {
                (slot(item.icon_url.as_deref(),44))
                div { h2 { (names.get(ctx.lang)) } @if let Some(other)=names.secondary(ctx.lang) { p.peek-secondary { (other) } }
                    div.peek-tags {
                        span { (category_label(&item.category,ctx.lang)) }
                        @if let Some(level)=item.req_level { span { (ctx.t("等级 ","Lv. ")) (level) } }
                        @if let Some(sub)=&item.subcategory { @if ctx.lang==Lang::Zh { span { (sub) } } }
                    }
                }
            }
            @if !page.market.base_stats.is_empty() {
                section.peek-section {
                    h3 { (ctx.t("图鉴基础属性", "Catalogue base stats")) }
                    dl.peek-stats { @for (key,value) in &page.market.base_stats { @if *value!=0 {
                        div { dt { (stat_name(key,ctx.lang)) } dd { (value) } }
                    } } }
                    p.peek-note { (ctx.t("具体摊位装备可能有随机或强化属性。", "Listed equipment may have rolled or upgraded stats.")) }
                }
            } @else if item.id / 1_000_000 == 1 {
                p.peek-note { (ctx.t("暂无图鉴基础属性，请在详情页核对具体装备。", "Base stats unavailable. Check individual equipment on the detail page.")) }
            }
            section.peek-section {
                h3 { (ctx.t("市场参考", "Market reference")) " · " (if all {ctx.t("全部记录", "All records")} else {"72h"}) }
                div.peek-price { (price(stats.and_then(|s|s.typical))) small { (ctx.t("金币 / 件 · 成交中位", "mesos / item · median sale")) } }
                dl.peek-stats {
                    div { dt { (ctx.t("在售最低", "Lowest ask")) } dd { (price(stats.and_then(|s|s.lowest_ask))) } }
                    div { dt { (ctx.t("成交笔数", "Sales")) } dd { (stats.map(|s|grouped(s.sales_24h.into())).unwrap_or_else(||"—".into())) } }
                    div { dt { (ctx.t("在售数量", "Listed stock")) } dd { (stats.map(|s|grouped(s.listings_count.into())).unwrap_or_else(||"—".into())) } }
                    div { dt { (ctx.t("在售摊位", "Shops")) } dd { (stats.map(|s|grouped(s.shops_count.into())).unwrap_or_else(||"—".into())) } }
                }
                @if stats.is_some() {
                    p.peek-note { (ctx.t("最近数据：", "Latest data: ")) time data-relative-time=(v.as_of.timestamp()) { (v.as_of.format("%Y-%m-%d %H:%M UTC")) } }
                    @if (ctx.now-v.as_of).num_hours()>=48 { p.peek-warning { (ctx.t("历史报价，请先确认是否仍在售。", "Historical offers. Confirm availability in game.")) } }
                } @else { p.peek-note { (ctx.t("还没有市场记录。", "No market records yet.")) } }
            }
            @if page.npc_sell.is_some() || !page.npc_offers.is_empty() {
                section.peek-section { h3 { "NPC" }
                    dl.peek-stats {
                        div { dt { (ctx.t("商店售价", "Shop price")) } dd { (price(page.npc_offers.iter().map(|o|o.price).min())) } }
                        div { dt { (ctx.t("回收价", "Sell-back")) } dd { (price(page.npc_sell)) } }
                    }
                }
            }
            footer.peek-footer {
                a href=(ctx.href(&format!("/item/{}{}",item.id,if all {"?hours=all"} else {"?hours=72"}))) { (ctx.t("查看完整详情 →", "Open full details →")) }
            }
        }
    }
}

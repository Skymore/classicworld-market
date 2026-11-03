//! Each page rendered from hand-built view models; no database.

use market_core::sales::SaleKind;
use market_web::bestiary::{format::Lang, model::*, pages, pages::Ctx, route::EdgeKind};
use sqlx::types::chrono::{DateTime, NaiveDate, TimeZone, Utc};

fn map(id: i32, name: &str) -> MapRef {
    MapRef::new(id, name, format!("{name} (en)"))
}

fn mob(id: i32, name: &str) -> MobRef {
    MobRef {
        id,
        names: Names::new(name, "Snail"),
        level: Some(7),
        image_id: Some(100100),
    }
}

fn at(day: u32, hour: u32) -> DateTime<Utc> {
    Utc.with_ymd_and_hms(2026, 10, day, hour, 0, 0).unwrap()
}

fn zh() -> Ctx {
    Ctx {
        here: "/item/4000019".into(),
        now: at(20, 0),
        ..Ctx::default()
    }
}

#[test]
fn item_bootstrap_reuses_public_data_and_escapes_script_delimiters() {
    let mut page = item_page(Some(stats()), market());
    page.item.name_en = "</script><script>alert('shop')</script>&\u{2028}".into();
    let ctx = zh();
    let rendered = pages::page_data_script(&ctx, "item", pages::item_data(&page)).unwrap();
    let raw = rendered.split("<script id=\"catalog-snapshot\" type=\"application/json\">")
        .nth(1).unwrap().split("</script>").next().unwrap();
    assert!(!raw.contains('<'));
    assert!(!raw.contains('&'));
    let snapshot: serde_json::Value = serde_json::from_str(raw).unwrap();
    assert_eq!(snapshot["url"], ctx.here);
    assert_eq!(snapshot["updatedAt"], ctx.now.timestamp_millis());
    assert_eq!(snapshot["data"]["kind"], "item");
    // The bootstrap adds the pricing unit, matching the catalog page API.
    let mut expected = serde_json::to_value(&page).unwrap();
    expected["unit"] = "item".into();
    assert_eq!(snapshot["data"]["page"], expected);
}

#[test]
fn item_window_and_observed_location_are_explicit() {
    let mut page = item_page(Some(stats()), market());
    page.market.sales[0].room = None;
    page.market.sales[0].observed_location = Some("勇士部落东入口".into());
    let mut ctx = zh();
    ctx.here.push_str("?hours=all");
    let rendered = pages::item_page(&page, &ctx).into_string();
    assert!(rendered.contains("全部 <b>12</b>"));
    assert!(rendered.contains("勇士部落东入口"));
    assert!(rendered.contains("采集时所在地图"));
    assert!(!rendered.contains("24h <b>"));
    assert!(rendered.contains("data-item-period"));
}

#[test]
fn outdated_item_does_not_recommend_buying_now() {
    let mut page = item_page(Some(stats()), market());
    page.market.as_of = Some(at(19, 23));
    for offer in &mut page.market.listings {
        offer.seen_at = at(17, 0);
    }
    let rendered = pages::item_page(&page, &zh()).into_string();
    assert!(!rendered.contains("打还是买") && !rendered.contains("建议直接买"));
}

#[test]
fn equipment_scrolls_and_etc_offers_all_expose_precise_sort_metadata() {
    for id in [1462004, 2040305, 4000019] {
        let mut page = item_page(Some(stats()), market());
        page.item.id = id;
        let count = page.market.listings.len();
        // item.js sorts the rows of the market fragment, which lists them all.
        let rendered = pages::item_market_fragment(&page, &zh()).into_string();
        assert_eq!(rendered.matches("data-quote=").count(), count, "item {id}");
        assert_eq!(
            rendered.matches("data-observed=").count(),
            count,
            "item {id}"
        );
        assert_eq!(
            rendered.matches("data-unit-price=").count(),
            count,
            "item {id}"
        );
    }
}

fn en() -> Ctx {
    Ctx {
        lang: Lang::En,
        ..zh()
    }
}

fn stats() -> MarketStats {
    MarketStats {
        typical: Some(1_234),
        typical_low: Some(1_000),
        typical_high: Some(1_500),
        sales_24h: 12,
        change_24h: Some(-6.1),
        lowest_ask: Some(900),
        listings_count: 3,
        shops_count: 3,
        as_of: at(19, 23),
    }
}

fn listing(
    shop: &str,
    channel: Option<i16>,
    room: i16,
    price: f64,
    seen: DateTime<Utc>,
) -> Listing {
    Listing {
        owner_name: None,
        invalidated_at: None,
        grouping: None,
        shop: shop.into(),
        channel,
        room: Some(room),
        unit_price: price,
        stock: Some(5),
        seen_at: seen,
        variant: None,
    }
}

fn market() -> ItemMarket {
    let days = (13..=19)
        .map(|d| Day {
            date: NaiveDate::from_ymd_opt(2026, 10, d).unwrap(),
            median: (d != 15).then_some(1_200.0),
            low: (d != 15).then_some(1_000.0),
            high: (d != 15).then_some(1_500.0),
            count: if d == 15 { 0 } else { 2 },
        })
        .collect();
    ItemMarket {
        expired_listings: vec![],
        as_of: Some(at(19, 23)),
        listings: vec![
            listing("Cheap<b>", Some(14), 8, 950.0, at(19, 20)),
            listing("Old", Some(14), 2, 900.0, at(17, 1)), // > 48 h before as_of: stale
            listing("Far", Some(3), 5, 1_100.0, at(19, 22)),
        ],
        sales: vec![Sale {
            observed_location: None,
            kind: SaleKind::FoundSold,
            unit_price: 1_250.0,
            quantity: None,
            shop: "Seller".into(),
            channel: Some(4),
            room: Some(8),
            detected_at: at(19, 21),
            variant: None,
            merged_count: 1,
        }],
        days,
        listing_days: vec![],
        sale_points: vec![
            SalePoint {
                day: 6,
                price: 1_250.0,
            },
            SalePoint {
                day: 5,
                price: 1_000.0,
            },
        ],
        base_stats: Vec::new(),
    }
}

fn item_page(stats: Option<MarketStats>, market: ItemMarket) -> ItemPage {
    ItemPage {
        selected_variant: None,
        equipment: None,
        item: ItemSummary {
            id: 4000019,
            name_zh: Some("蜗牛壳<script>".into()),
            name_en: "Snail Shell".into(),
            category: "其他".into(),
            subcategory: Some("其他道具".into()),
            req_level: None,
            req_job_mask: None,
            icon_url: Some("https://mxdgcw.dvg.cn/dbsource/icon/item/4000019.png".into()),
            is_cash: false,
        },
        stats,
        droppers: vec![Dropper {
            mob: mob(2, "蜗牛"),
            votes: Some(60),
            maps: vec![map(10001010, "射手训练场Ⅰ"), map(40, "蜗牛猎场Ⅰ")],
        }],
        npc_offers: vec![],
        npc_sell: Some(20),
        quest_rewards: vec![QuestReward {
            quest: quest(1019, "瑞恩的问答 7", "Rain's Maple Quiz 7"),
            quantity: 10,
            kind: "random".into(),
            job: Some("Warrior".into()),
            chance_pct: Some(14.3),
        }],
        quest_needs: vec![QuestNeed {
            quest: quest(1035, "小石球的石片", "Jr. Sentinel Shellpiece"),
            quantity: 3,
        }],
        market,
    }
}

fn quest(id: i32, zh: &str, en: &str) -> QuestRef {
    QuestRef {
        id,
        names: Names::new(zh, en),
        npc: Some(NpcRef {
            id: 2100,
            names: Some(Names::new("瑞恩", "Rain")),
        }),
        level_min: Some(5),
        repeats: Some("daily".into()),
        ends_at: None,
    }
}

/// CSP: no inline scripts or style attributes anywhere.
fn assert_csp_clean(html: &str) {
    assert!(!html.contains("<script>"), "no inline script");
    assert!(!html.contains(" style="), "no style attribute");
    assert!(!html.contains("onclick"), "no inline handler");
}

#[test]
fn item_page_head_sources_and_shell() {
    let html = pages::item_page(&item_page(Some(stats()), market()), &zh()).into_string();
    assert!(html.starts_with("<!DOCTYPE html>"));
    assert_csp_clean(&html);
    assert!(html.contains("蜗牛壳&lt;script&gt;"), "names are escaped");
    assert!(
        html.contains(r#"data-device="phone""#),
        "boot.js sets the device; the markup is the same for all"
    );
    assert!(html.contains(r#"<script type="module" src="/web/react/shell.js"#));
    assert!(!html.contains(r#"src="/web/js/pages/item.js"#));
    assert!(
        html.contains(r#"href="/web/css/base.css?"#)
            && html.contains(r#"href="/web/css/item.css?v="#)
    );
    assert!(
        html.contains(r#"class="ptop""#)
            && html.contains(r#"class="dhead""#)
            && html.contains(r#"class="dock""#)
    );
    assert!(html.contains("1234") && !html.contains("1.2K"), "Chinese pages show mesos below 1万 in full");
    assert!(html.contains("▼ 6.1%"));
    assert!(html.contains("数据 1小时前更新"), "freshness from as_of");
    assert!(html.contains(r#"href="/mob/2""#));
    assert!(!html.contains("人确认") && !html.contains("60%"), "neither confirmations nor a rate");
    assert!(html.contains("任务奖励") && html.contains("瑞恩的问答 7") && html.contains("×10"));
    assert!(html.contains("瑞恩 · Lv.5 · 每日 · 战士 随机 14.3%"), "NPC, level, repeat and how it is given");
    assert!(html.contains("任务要用") && html.contains("×3"));
    assert!(!html.contains("60%"));
    assert!(html.contains("射手训练场Ⅰ · 蜗牛猎场Ⅰ"));
    assert!(html.contains("NPC 不卖"));
    assert!(html.contains("回收") && html.contains("<b>20</b>") && !html.contains("回收价"));
    assert!(!html.contains("打还是买"), "no farm-or-buy verdict");
    assert!(!html.contains("无等级限制"), "no level tag without a level requirement");
    assert!(html.contains("https://maplestory.io/api/GMS/83/mob/100100/render/stand"));
    assert!(
        html.contains(r#"href="/item/4000019?lang=en""#),
        "language switch"
    );
    assert!(html.contains(r#"data-star="4000019""#));
}

#[test]
fn equipment_strip_follows_the_game_tooltip() {
    use market_web::bestiary::equipment::{EquipmentReference, Requirements};
    let mut page = item_page(Some(stats()), market());
    assert!(!pages::item_page(&page, &zh())
        .into_string()
        .contains("data-equipment-strip"));
    page.equipment = Some(EquipmentReference {
        req: Some(Requirements { level: 30, str: 0, dex: 30, int: 0, luk: 65 }),
        jobs: Some(8),
        weapon: true,
        kind: Some("拳套"),
        kind_en: Some("Claw"),
        attack_speed: Some(4),
        upgrades: Some(7),
    });
    page.market.base_stats = vec![("weapon_attack".into(), 23), ("critical_rate".into(), 1)];
    let html = pages::item_page(&page, &zh()).into_string();
    assert!(html.contains(r#"<dl class="eq-strip" data-equipment-strip>"#));
    assert!(html.contains(r#"<span class="zero">力量 <b>0</b></span>"#));
    assert!(html.contains("运气 <b>65</b>"));
    assert!(html.contains(">新手</span>") && !html.contains(r#"class="on">新手"#), "beginners cannot wear a thief claw");
    assert!(html.contains(r#"<span class="on">飞侠</span>"#));
    assert!(!html.contains("海盗"), "MSCW has no pirates");
    assert!(html.contains("攻击速度 <b>快</b>"));
    assert!(html.contains("物理攻击 <b>+23</b>"));
    assert!(html.contains("暴击率 <b>+1</b>"));
    assert!(html.find("data-equipment-strip") < html.find(r#"class="ibox""#));
    let english = pages::item_page(&page, &en()).into_string();
    assert!(english.contains("Attack speed <b>Fast</b>"));
    assert!(english.contains("<span>Claw</span>"));
}

#[test]
fn where_to_buy_groups_by_channel() {
    let html = pages::item_page(&item_page(Some(stats()), market()), &zh()).into_string();
    assert!(html.contains("Cheap&lt;b&gt;"));
    // CH 14 first (cheapest fresh 950; the stale 900 does not count), open, with the 22-room grid.
    let ch14 = html.find("14频道").unwrap();
    let ch3 = html.find("3频道<").unwrap();
    assert!(ch14 < ch3);
    assert!(html.contains(r#"<div class="cgroup open" data-ch-key="14">"#));
    assert!(html.contains("最低 <b>950</b>"));
    assert!(html.contains(r#"class="hole lit best" title="8 洞 最低 950""#));
    assert!(
        html.contains(r#"class="hole lit stale""#),
        "room 2 only has a stale listing"
    );
    assert!(html.contains(r#"<div class="lrow stale" "#));
    assert!(html.contains("3 条挂单 · 3 摊"));
}

#[test]
fn first_paint_lists_only_the_open_channels_cheapest_listings() {
    let mut market = market();
    // 30 channels with 20 listings each; channel 1 is the cheapest.
    market.listings = (0..600)
        .map(|i| {
            let channel = (i % 30) as i16 + 1;
            listing(
                &format!("Shop {i}"),
                Some(channel),
                (i % 22) as i16 + 1,
                1_000.0 + f64::from(i),
                at(19, 20),
            )
        })
        .collect();
    let page = item_page(Some(stats()), market);
    let first = pages::item_page(&page, &zh()).into_string();
    let full = pages::item_market_fragment(&page, &zh()).into_string();
    assert_eq!(full.matches(r#"<div class="lrow""#).count(), 600);
    assert_eq!(first.matches(r#"<div class="lrow""#).count(), 10);
    assert!(first.contains("还有 10 条挂单"));
    assert_eq!(
        first.matches(r#"<span class="hole"#).count(),
        22,
        "rooms of the open channel only"
    );
    assert!(first.contains(r#"<div class="cgroup open" data-ch-key="1">"#));
    // Channel heads keep the full counts.
    assert!(first.contains("600 条挂单"));
    assert_eq!(first.matches(r#"class="cg-head""#).count(), 30);
    // Bytes of the "where to buy" section, up to the next market section.
    let where_well = |html: &str| {
        let start = html.find(r#"data-market="where""#).unwrap() + 1;
        html[start..]
            .find("data-market=")
            .unwrap_or(html.len() - start)
    };
    eprintln!(
        "where to buy, 600 listings: every listing {} bytes, first paint {} bytes",
        where_well(&full),
        where_well(&first)
    );
}

#[test]
fn ladder_trend_and_sales() {
    let html = pages::item_page(&item_page(Some(stats()), market()), &zh()).into_string();
    assert!(html.contains(r#"data-tab="ladder""#) && html.contains(r#"data-tab="trend""#));
    assert!(html.contains("≤ <b>"), "ladder sentence");
    assert!(html.contains("的成交更贵"));
    assert!(html.contains(r#"class="rung sel"#), "a tier is selected");
    assert!(html.contains("每日成交"), "short legend");
    assert!(html.contains(r#"role="img" aria-label="7 日成交走势""#));
    assert_eq!(html.matches("data-trend-day=").count(), 7);
    assert!(html.contains("data-median=\"1200\""));
    assert!(html.contains("data-low=\"1000\""));
    assert!(html.contains("data-high=\"1500\""));
    assert!(
        html.contains("data-count=\"0\""),
        "days without sales remain selectable"
    );
    assert!(
        html.contains("data-start=\"1791849600\""),
        "UTC bucket boundaries travel to the browser"
    );
    assert!(
        html.contains(r#"font-size="12""#),
        "chart text stays at 12 px"
    );
    assert!(html.contains("卖光") && !html.contains("发现已售"));
    assert!(html.contains("数量未知"));
    assert!(!html.contains("时间是发现时间，不是实际成交时间"));
    assert!(html.contains(r#"<span class="loc"><b>4频道</b><span>8洞</span></span>"#));
}

#[test]
fn item_without_market_data_says_so() {
    let mut page = item_page(None, ItemMarket::default());
    page.droppers.clear();
    page.npc_offers.push(NpcOffer {
        npc: NpcRef {
            id: 212,
            names: None,
        },
        price: 50,
    });
    let html = pages::item_page(&page, &zh()).into_string();
    assert!(html.contains("还没有成交价"));
    assert!(html.contains("市场数据暂无"));
    assert!(html.contains("还没有玩家确认的怪物掉落"));
    assert!(html.contains("NPC #212") && html.contains("<b>50</b>"));
    assert!(html.contains("最近 72 小时没有看到在售挂单"));
    assert!(html.contains("画不出价格分布"));
    assert!(
        !html.contains("样本少"),
        "no typical price: nothing to call thin"
    );
}

#[test]
fn english_page() {
    let html = pages::item_page(&item_page(Some(stats()), market()), &en()).into_string();
    assert!(html.contains(r#"<html lang="en" data-lang="en""#));
    assert!(html.contains("<h1>Snail Shell</h1>"));
    assert!(html.contains("Where to buy"));
    assert!(html.contains("sold out"));
    assert!(!html.contains("Farm or buy"));
    assert!(
        html.contains(r#"href="/mob/2?lang=en""#),
        "links keep the language"
    );
    assert!(
        html.contains(r#"<input type="hidden" name="lang" value="en">"#),
        "search keeps it too"
    );
    assert!(
        html.contains(r#"href="/item/4000019""#),
        "switch back to Chinese"
    );
    assert!(!html.contains("怎么拿到"));
}

#[test]
fn market_fragment_holds_only_the_market_sections() {
    let page = item_page(Some(stats()), market());
    let html = pages::item_market_fragment(&page, &zh()).into_string();
    assert!(html.starts_with(r#"<div data-mark="3|"#));
    for part in ["head", "where", "tabs", "sales"] {
        assert!(html.contains(&format!(r#"data-market="{part}""#)), "{part}");
    }
    assert!(!html.contains("来源"), "bestiary sections are static");
    assert!(!html.contains("<html"));
}

#[test]
fn equipment_tooltips_mark_bonus_stats() {
    let variant = |id, value| Variant {
        id,
        stats: vec![Stat {
            key: "weapon_attack".into(),
            label: "物理攻击".into(),
            value,
        }],
        remaining_upgrades: Some(7),
        enhancements: Some(0),
        unknown_fields: 0,
    };
    let mut market = market();
    market.base_stats = vec![("weapon_attack".into(), 17)];
    market.listings[0].variant = Some(variant(1, 19));
    market.listings[2].variant = Some(variant(2, 17));
    let mut page = item_page(Some(stats()), market);
    page.item.id = 1302000;
    let html = pages::item_page(&page, &zh()).into_string();
    assert!(html.contains("装备属性"));
    assert!(!html.contains("data-bonus-only"));
    assert!(html.contains("equipment-group-link"));
    assert!(html.contains("variant=1") && html.contains("variant=2"));
    assert!(html.contains("<b>+19</b><i>(+2)</i>"));
    assert!(html.contains("可升级次数：7"));
    assert!(!html.contains("报价来自摊位快照"));
    assert!(!html.contains("属性是采集器从数据包解析的"));
    assert!(
        html.contains(r#"<details class="listing-offer""#)
            && html.contains(r#"data-bonus="1"><summary class="lrow">"#),
        "expandable offers carry the bonus flag for the switch"
    );
    // The first paint lists the open channel; the market fragment lists all.
    assert_eq!(html.matches("<summary class=\"lrow\">").count(), 2);
    assert_eq!(
        pages::item_market_fragment(&page, &zh())
            .into_string()
            .matches("<summary class=\"lrow\">")
            .count(),
        page.market.listings.len()
    );
    assert!(!html.contains("点击查看属性与位置"));
    assert!(html.contains("offer-chevron"));
    assert!(html.contains("暂无属性"));
    assert!(!html.contains("这条报价未采集到装备的实际属性"));
    let en_html = pages::item_page(&page, &en()).into_string();
    assert!(!en_html.contains("View stats and location"));
    assert!(en_html.contains("offer-chevron"));
    assert!(!en_html.contains("Where to buy: Free Market"));
}

#[test]
fn mob_page_lists_maps_and_every_drop_kind() {
    let page = MobPage {
        mob: MobDetail {
            id: 2,
            names: Names::new("蜗牛", "Snail"),
            level: Some(1),
            image_id: Some(100100),
            hp: Some(2_100_000_000),
            mp: None,
            exp: Some(3),
            pad: Some(12),
            pdd: None,
            mad: None,
            mdd: None,
            acc: None,
            eva: None,
            speed: Some(-60),
            is_boss: true,
            is_undead: false,
            description: Some("第一行\n第二行".into()),
        },
        spawns: vec![Spawn {
            map: map(40, "蜗牛猎场Ⅰ"),
            street: Some(Names::new("彩虹岛", "Maple Island")),
            spawn_count: 12,
        }],
        drops: vec![
            MobDrop {
                what: DropTarget::Meso { min: 4, max: 6 },
                votes: None,
                quest_id: None,
            },
            MobDrop {
                what: DropTarget::Item {
                    id: 4000019,
                    names: Names::new("蜗牛壳", "Snail Shell"),
                    icon_url: None,
                    typical: Some(450),
                    lowest_ask: Some(233),
                },
                votes: Some(60),
                quest_id: None,
            },
            MobDrop {
                what: DropTarget::Unlisted {
                    id: Some(2040002),
                    names: None,
                },
                votes: Some(3),
                quest_id: Some(1035),
            },
        ],
        quests: vec![QuestNeed {
            quest: quest(1036, "小石球的威胁", "Jr. Sentinel threat"),
            quantity: 10,
        }],
    };
    let html = pages::mob_page(&page, &zh()).into_string();
    assert!(html.contains("相关任务") && html.contains("击败 10"));
    assert!(html.contains(r#"href="https://meowdb.com/msclassic/quest-tracker/1036""#));
    assert_csp_clean(&html);
    assert!(html.contains(r#"href="/web/css/dex.css?v="#));
    assert!(html.contains("2,100,000,000"));
    assert!(html.contains("首领"));
    assert!(html.contains(r#"href="/map/40""#));
    assert!(html.contains("12 个刷怪点"));
    assert!(html.contains("4–6"));
    assert!(html.contains(r#"href="/item/4000019""#));
    assert!(html.contains("成交价 450 · 在售最低 233"));
    assert!(html.contains("物品 #2040002"));
    assert!(html.contains("任务 #1035 期间"));
    assert!(!html.contains("人确认") && !html.contains("NiaDB"));
    assert!(html.contains("<p>第二行</p>"));
    let english = pages::mob_page(&page, &en()).into_string();
    assert!(english.contains("<h1>Snail</h1>") && english.contains("Maple Island"));
    assert!(english.contains("typical 450 · lowest ask 233"));
}

#[test]
fn map_page_shows_links_and_route_entry() {
    let page = MapPage {
        map: MapDetail {
            id: 10001010,
            names: Names::new("射手训练场Ⅰ", "Henesys Hunting Ground I"),
            street: Some(Names::new("金银岛", "Victoria Road")),
            description: None,
            is_town: false,
            mob_rate: Some(1.5),
            minimap_url: None,
        },
        return_map: Some(map(10001000, "射手村")),
        mobs: vec![MapMob {
            mob: mob(2, "蜗牛"),
            spawn_count: 4,
        }],
        npcs: vec![NpcRef {
            id: 200,
            names: None,
        }],
        exits: vec![Link {
            other: map(10001000, "射手村"),
            kind: EdgeKind::Return,
            portal_name: None,
        }],
        entrances: vec![],
        view: None,
        quests_given: vec![],
        quests_hunted: vec![],
        from_henesys: None,
        on_world_map: false,
    };
    let html = pages::map_page(&page, &zh()).into_string();
    assert!(html.contains(r#"href="/route?from=10001000&amp;to=10001010""#));
    assert!(html.contains("回城点：射手村"));
    assert!(html.contains(r#"href="/mob/2""#));
    assert!(html.contains("NPC #200"));
    assert!(
        html.contains(r#"href="/npc/200""#),
        "NPC rows open the NPC page"
    );
    assert!(!html.contains("mapvis"), "no view without NiaDB's box");
    assert!(!html.contains("NPC 名字还没有导入"));
    assert!(html.contains("用回城卷轴"));
    assert!(html.contains("还没有到这里的连接"));
}

fn small_view() -> MapView {
    MapView {
        width: 1000,
        height: 500,
        shown_width: 880,
        shown_height: 440,
        icon: 27,
        image_url: Some("/web/images/minimaps/10001010.png".into()),
        scene: None,
        spawns: vec![SpawnPoint {
            mob_id: 2,
            x: 300,
            y: 400,
            mob_time: 0,
        }],
        portals: vec![PortalPoint {
            x: 950,
            y: 420,
            to: map(10001000, "射手村"),
            name: Some("east00".into()),
            portal_type: Some(2),
        }],
        npcs: vec![NpcPoint {
            npc: NpcRef {
                id: 200,
                names: Some(Names::new("赫丽娜", "Athena Pierce")),
            },
            x: 500,
            y: 300,
        }],
        player_spawn: Some(Point { x: 100, y: 400 }),
    }
}

fn npc_quest(id: i32, name: &str) -> QuestRef {
    QuestRef {
        id,
        names: Names::new(name, format!("{name} (en)")),
        npc: Some(NpcRef {
            id: 200,
            names: Some(Names::new("赫丽娜", "Athena Pierce")),
        }),
        level_min: Some(10),
        repeats: None,
        ends_at: None,
    }
}

#[test]
fn map_page_draws_the_view_route_strip_and_quests() {
    let page = MapPage {
        map: MapDetail {
            id: 10001010,
            names: Names::new("射手训练场Ⅰ", "Henesys Hunting Ground I"),
            street: None,
            description: None,
            is_town: false,
            mob_rate: None,
            minimap_url: Some("/web/images/minimaps/10001010.png".into()),
        },
        return_map: None,
        mobs: vec![MapMob {
            mob: mob(2, "蜗牛"),
            spawn_count: 1,
        }],
        npcs: vec![],
        exits: vec![],
        entrances: vec![],
        view: Some(small_view()),
        quests_given: vec![npc_quest(1, "弓箭手的考验")],
        quests_hunted: vec![QuestHunt {
            quest: npc_quest(2, "蜗牛壳"),
            mob: mob(2, "蜗牛"),
            quantity: 10,
        }],
        from_henesys: Some(vec![map(10001000, "射手村"), map(10001010, "射手训练场Ⅰ")]),
        on_world_map: true,
    };
    let html = pages::map_page(&page, &zh()).into_string();
    assert!(html.contains(r#"<figure class="mapvis">"#));
    assert!(
        html.contains(r#"href="/web/images/mobs/head/2.png""#),
        "the head on its spawn point"
    );
    assert!(html.contains("<title>传送口 → 射手村</title>"));
    assert!(
        html.contains(r#"class="mv-chip""#),
        "legend chip per monster"
    );
    assert!(html.contains("从射手村过来"));
    assert!(
        html.contains(r#"href="/world?map=10001010""#),
        "world map button"
    );
    assert!(html.contains("1 步"));
    assert!(html.contains("在这里接") && html.contains("弓箭手的考验"));
    assert!(html.contains("要打这里的怪") && html.contains("蜗牛 ×10"));
    assert!(
        !html.contains(r#"class="minimap""#),
        "the view replaces the plain image"
    );
}

#[test]
fn npc_page_marks_the_npc_and_lists_quests_and_shop() {
    let page = NpcPage {
        npc: NpcRef {
            id: 200,
            names: Some(Names::new("赫丽娜", "Athena Pierce")),
        },
        places: vec![NpcPlace {
            map: map(10001010, "射手训练场Ⅰ"),
            view: Some(small_view()),
        }],
        quests: vec![npc_quest(1, "弓箭手的考验")],
        shop: vec![NpcShopItem {
            id: 2000000,
            names: Names::new("红色药水", "Red Potion"),
            icon_url: None,
            price: 50,
        }],
    };
    let html = pages::npc_page(&page, &zh()).into_string();
    assert!(html.contains("<h1>赫丽娜</h1>"));
    assert!(
        html.contains("mv-npc here"),
        "the NPC stands out on its map"
    );
    assert!(
        !html.contains(r#"href="/npc/200""#),
        "no link to the page itself"
    );
    assert!(html.contains("弓箭手的考验"));
    assert!(html.contains(r#"href="/item/2000000""#) && html.contains("红色药水"));
}

#[test]
fn route_steps_circle_the_portal_to_take() {
    let html = route(RouteOutcome::Found {
        from: map(10001010, "甲"),
        to: map(10001000, "乙"),
        steps: vec![Step {
            from: map(10001010, "甲"),
            to: map(10001000, "乙"),
            kind: EdgeKind::Portal,
            portal_name: Some("east00".into()),
            view: Some(small_view()),
            exit: Some(Point { x: 950, y: 420 }),
            npc: None,
            exit_hidden: false,
            arrival: Some(Point { x: 100, y: 400 }),
        }],
        overview: None,
    });
    assert!(html.contains("走地图上圈出的传送口"));
    assert!(html.contains("mv-exit") && html.contains("mv-arrival"));
}

#[test]
fn town_lists_return_scroll_entrances_on_one_line() {
    let entrance = |id, kind| Link {
        other: map(id, &format!("野外{id}")),
        kind,
        portal_name: None,
    };
    let page = MapPage {
        map: MapDetail {
            id: 10001000,
            names: Names::new("射手村", "Henesys"),
            street: None,
            description: None,
            is_town: true,
            mob_rate: None,
            minimap_url: None,
        },
        return_map: None,
        mobs: vec![],
        npcs: vec![],
        exits: vec![],
        entrances: vec![
            entrance(1, EdgeKind::Portal),
            entrance(2, EdgeKind::Return),
            entrance(3, EdgeKind::Return),
        ],
        view: None,
        quests_given: vec![],
        quests_hunted: vec![],
        from_henesys: None,
        on_world_map: false,
    };
    let html = pages::map_page(&page, &zh()).into_string();
    assert!(html.contains("用回城卷轴回到这里<small>2 张地图</small>"));
    assert!(html.contains(r#"<a href="/map/2">野外2<span class="name-secondary">野外2 (en)</span></a> · <a href="/map/3">野外3<span class="name-secondary">野外3 (en)</span></a>"#));
    assert!(
        html.contains(r#"<a class="drow" href="/map/1">"#),
        "walked entrances keep their row"
    );
    assert!(html.contains("从这里出发去哪"));
}

fn route(outcome: RouteOutcome) -> String {
    pages::route_page(
        &RoutePage {
            from_input: "射手训练场".into(),
            to_input: "射手村".into(),
            mob_input: String::new(),
            mob_mode: false,
            taxi: false,
            known_edges: 393,
            outcome,
        },
        &zh(),
    )
    .into_string()
}

#[test]
fn route_page_outcomes() {
    let found = route(RouteOutcome::Found {
        from: map(1, "甲"),
        to: map(3, "丙"),
        steps: vec![
            Step {
                from: map(1, "甲"),
                to: map(2, "乙"),
                kind: EdgeKind::Portal,
                portal_name: Some("east00".into()),
                view: None,
                exit: None,
                npc: None,
                exit_hidden: false,
                arrival: None,
            },
            Step {
                from: map(2, "乙"),
                to: map(3, "丙"),
                kind: EdgeKind::Return,
                portal_name: None,
                view: None,
                exit: None,
                npc: None,
                exit_hidden: false,
                arrival: None,
            },
        ],
        overview: None,
    });
    assert!(found.contains("甲 → 丙"));
    assert!(found.contains("2 步"));
    assert!(found.contains("走传送口"));
    assert!(!found.contains("east00"), "internal portal names stay hidden");
    assert!(found.contains(r#"<span class="no">2</span>"#));
    assert!(
        found.contains(r#"<li class="step scroll">"#),
        "return scroll steps look different"
    );
    assert!(found.contains(r#"value="射手训练场""#));
    assert!(!found.contains("现有 393 条"), "no explanatory note under the route");

    let no_path = route(RouteOutcome::NoPath {
        from: map(1, "甲"),
        to: map(3, "丙"),
    });
    assert!(no_path.contains("暂时查不到路线"));
    assert!(no_path.contains(r#"href="/map/1""#) && no_path.contains(r#"href="/map/3""#));

    let many = route(RouteOutcome::Unresolved {
        end: RouteEnd::From,
        query: "射手训练场".into(),
        candidates: vec![map(10001010, "射手训练场Ⅰ"), map(10001011, "射手训练场Ⅱ")],
    });
    assert!(many.contains("有多个地图"));
    let to = "%E5%B0%84%E6%89%8B%E6%9D%91";
    assert!(many.contains(&format!(r#"href="/route?from=10001010&amp;to={to}""#)));

    let missing = route(RouteOutcome::Unresolved {
        end: RouteEnd::To,
        query: "火星".into(),
        candidates: vec![],
    });
    assert!(missing.contains("没有找到目的地「火星」"));
    assert!(route(RouteOutcome::Same(map(1, "甲"))).contains("同一张地图"));
    assert!(!route(RouteOutcome::Form).contains("输入出发和目的地"));
}

#[test]
fn search_page_states() {
    let empty = pages::search_page(&SearchPage::default(), &zh()).into_string();
    assert!(empty.contains("暂无图鉴数据"));
    assert!(
        empty.contains("https://maplestory.io/api/GMS/83/mob/"),
        "empty state has a mob"
    );

    let none = pages::search_page(
        &SearchPage {
            query: "火星".into(),
            ..Default::default()
        },
        &zh(),
    )
    .into_string();
    assert!(none.contains("没有找到「火星」"));

    let hits = pages::search_page(
        &SearchPage {
            query: "蜗牛".into(),
            page_size: 20,
            items: Hits {
                rows: vec![ItemHit {
                    level: None,
                    id: 4000019,
                    names: Names::new("蜗牛壳", "Snail Shell"),
                    icon_url: None,
                    subcategory: Some("其他道具".into()),
                }],
                more: true,
                total: 25,
            },
            mobs: Hits {
                rows: vec![mob(2, "蜗牛")],
                more: false,
                total: 1,
            },
            ..Default::default()
        },
        &zh(),
    )
    .into_string();
    assert!(hits.contains(r#"href="/item/4000019""#));
    assert!(hits.contains("Snail Shell · 其他道具"));
    assert!(hits.contains(r#"href="/mob/2""#));
    assert!(hits.contains("共 25 件"), "group totals");
    assert!(
        hits.contains("查看全部 25 件")
            && hits.contains("/search?q=%E8%9C%97%E7%89%9B&amp;kind=item"),
        "a group with more rows links to its full list"
    );
    assert!(
        hits.contains("<h3>地图</h3>"),
        "search keeps all three result groups visible"
    );
    assert!(hits.contains(r#"value="蜗牛""#), "query kept in the box");
    assert!(
        !hits.contains("data-cats"),
        "no filter bar over three catalogues"
    );
    assert!(
        hits.contains("/search?q=%E8%9C%97%E7%89%9B&amp;kind=mob"),
        "kind tabs"
    );
}

#[test]
fn not_found_page() {
    let html = pages::not_found_page("怪物", "monster", &zh()).into_string();
    assert!(html.contains("没有这个怪物"));
    assert!(pages::not_found_page("怪物", "monster", &en())
        .into_string()
        .contains("No such monster"));
}

#[test]
fn quick_preview_has_escaped_names_reference_stats_and_period() {
    let mut page = item_page(Some(stats()), market());
    page.market.base_stats = vec![("weapon_attack".into(), 52), ("dex".into(), 1)];
    let preview = pages::item_preview(&page, &zh()).into_string();
    assert!(preview.contains("蜗牛壳&lt;script&gt;"));
    assert!(preview.contains("Snail Shell"));
    assert!(preview.contains("图鉴基础属性"));
    assert!(preview.contains("物理攻击"));
    assert!(preview.contains("<dd>52</dd>"));
    assert!(!preview.contains("具体摊位装备可能有随机或强化属性"));
    assert!(preview.contains("?hours=72"));
    assert!(!preview.contains("<html"));
    assert!(!preview.contains("data-market=\"where\""));
    let mut ctx = en();
    ctx.here = "/item/4000019?hours=all".into();
    let english = pages::item_preview(&page, &ctx).into_string();
    assert!(english.contains("All records"));
    assert!(english.contains("Weapon ATT"));
    assert!(english.contains("?hours=all&amp;lang=en"));
}

#[test]
fn region_controls_survive_empty_results_and_keep_url_state() {
    let page = SearchPage {
        kind: Some(SearchKind::Map),
        region: "victoria".into(),
        area: "Deep Passage".into(),
        areas: vec![AreaChoice {
            region: "victoria".into(),
            key: "Deep Passage".into(),
            names: Names::new("深层通道", "Deep Passage"),
        }],
        offset: 60,
        page_size: 60,
        town: true,
        ..Default::default()
    };
    let rendered = pages::search_page(&page, &zh()).into_string();
    assert!(rendered.contains("没有符合筛选条件的结果"));
    assert!(rendered.contains("清空搜索和筛选"));
    assert!(rendered.contains("共 0 张"));
    assert!(rendered.contains(r#"class="tab on""#));
    assert!(rendered.contains("地区 <b>金银岛</b>"), "region token");
    assert!(rendered.contains("区域 <b>深层通道</b>"), "area token");
    assert!(rendered.contains("<b>只看城镇</b>"));
    assert!(
        rendered.contains("/search?kind=map&amp;region=victoria&amp;area=Deep%20Passage"),
        "the town token keeps the place"
    );
    assert!(
        rendered.contains("/search?kind=map&amp;town=1\""),
        "the region token drops the area too"
    );
    assert!(
        rendered.contains("/search?kind=mob&amp;region=victoria&amp;area=Deep%20Passage"),
        "monsters share the place"
    );
    let english = pages::search_page(&page, &en()).into_string();
    assert!(english.contains("Victoria Island"));
    assert!(english.contains("Deep Passage"));
}

#[test]
fn item_bar_shows_category_counts_and_the_normalized_category() {
    let page = SearchPage {
        kind: Some(SearchKind::Item),
        filters: ItemFilters {
            cat: "equip".into(),
            job: "warrior".into(),
            shared: false,
            slot: "weapon".into(),
            weapon: Some(140),
            ..Default::default()
        },
        facets: Some(ItemFacets {
            categories: vec![
                Facet {
                    key: "".into(),
                    names: Names::new("全部", "All"),
                    count: 2962,
                },
                Facet {
                    key: "equip".into(),
                    names: Names::new("装备", "Equip"),
                    count: 1203,
                },
            ],
            ..Default::default()
        }),
        page_size: 60,
        ..Default::default()
    };
    let html = pages::search_page(&page, &zh()).into_string();
    assert!(html.contains("全部<small>2,962</small>"));
    assert!(html.contains(r#"class="cat on" href="/search?kind=item&amp;job=warrior&amp;shared=0&amp;type=weapon&amp;weapon=140&amp;cat=equip""#));
    assert!(html.contains("职业 <b>战士</b> ×"));
    assert!(html.contains("<b>不含通用装备</b> ×"));
    assert!(html.contains("类型 <b>武器</b> ×"));
    assert!(html.contains("武器 <b>双手剑</b> ×"));
    assert!(
        html.contains(r#"name="job" value="warrior""#),
        "a new query keeps the filters"
    );
}

#[test]
fn monster_finder_lists_the_nearest_map_first() {
    let page = RoutePage {
        from_input: "10001000".into(),
        to_input: String::new(),
        mob_input: "蜗牛".into(),
        mob_mode: true,
        taxi: true,
        known_edges: 1,
        outcome: RouteOutcome::MobFound {
            from: map(10001000, "射手村"),
            mob: mob(2, "蜗牛"),
            to: map(10001010, "射手训练场Ⅰ"),
            steps: vec![Step {
                from: map(10001000, "射手村"),
                to: map(10001010, "射手训练场Ⅰ"),
                kind: EdgeKind::Portal,
                portal_name: None,
                view: None,
                exit: None,
                npc: None,
                exit_hidden: false,
                arrival: None,
            }],
            overview: Some(RouteOverview {
                regions: vec![OverviewRegion {
                    id: "VictoriaIsland".into(),
                    names: Names::new("金银岛", "Victoria Island"),
                    image_url: "/web/images/worldmap/victoria-island.webp".into(),
                    width: 636,
                    height: 466,
                    stops: vec![
                        OverviewStop {
                            x: 300,
                            y: 200,
                            map: map(10001000, "射手村"),
                        },
                        OverviewStop {
                            x: 320,
                            y: 230,
                            map: map(10001010, "射手训练场Ⅰ"),
                        },
                    ],
                }],
            }),
            places: vec![
                MobPlace {
                    map: map(10001010, "射手训练场Ⅰ"),
                    spawn_count: 4,
                    steps: Some(1),
                },
                MobPlace {
                    map: map(1, "远方"),
                    spawn_count: 2,
                    steps: None,
                },
            ],
        },
    };
    let html = pages::route_page(&page, &zh()).into_string();
    assert!(html.contains("射手村 → 最近的蜗牛：射手训练场Ⅰ"));
    assert!(html.contains(r#"name="mob" value="蜗牛""#));
    assert!(html.contains("polyline"), "the route over the world map");
    assert!(html.contains("1 步 · 4 个刷怪点"));
    assert!(html.contains("到不了 · 2 个刷怪点"));
    assert!(
        html.contains(r#"<a class="drow here""#),
        "the nearest map stands out"
    );
}

#[test]
fn world_page_links_every_spot() {
    let page = WorldPage {
        regions: vec![WorldRegion {
            id: "MapleIsland".into(),
            names: Names::new("彩虹岛", "Maple Island"),
            image_url: "/web/images/worldmap/maple-island.webp".into(),
            width: 634,
            height: 446,
            spots: vec![WorldSpot {
                key: "WorldMap000.img:7".into(),
                x: 385,
                y: 234,
                kind: 3,
                map: map(1000, "彩虹村西边草原"),
                map_count: 1,
                level_min: Some(1),
                level_max: Some(8),
            }],
        }],
        here: None,
        here_spots: vec![],
    };
    let html = pages::world_page(&page, &zh()).into_string();
    assert!(html.contains("<figcaption>彩虹岛</figcaption>"));
    assert!(
        html.contains(r#"href="/map/1000""#)
            && html.contains("<title>彩虹村西边草原 · Lv.1–8</title>")
    );
    assert!(html.contains("marker-field.png"));
}

#[test]
fn ship_steps_circle_the_npc() {
    let html = route(RouteOutcome::Found {
        from: map(60, "南港"),
        to: map(10000000, "明珠港"),
        steps: vec![Step {
            from: map(60, "南港"),
            to: map(10000000, "明珠港"),
            kind: EdgeKind::Ship,
            portal_name: None,
            view: Some(small_view()),
            exit: Some(Point { x: 500, y: 300 }),
            npc: Some(NpcRef {
                id: 15,
                names: Some(Names::new("桑克斯", "Shanks")),
            }),
            exit_hidden: false,
            arrival: Some(Point { x: 100, y: 400 }),
        }],
        overview: None,
    });
    assert!(
        html.contains("找圈出的桑克斯坐船") && !html.contains("单程"),
        "{html}"
    );
    assert!(html.contains("<title>找这个 NPC</title>"));
}

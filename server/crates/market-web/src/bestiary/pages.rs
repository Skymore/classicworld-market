//! Server-rendered HTML for the bestiary pages in the redesigned look
//! (`design/mockups-v2/`). Pure: view model and context in, markup out.
//! maud escapes every interpolated value; there are no inline styles or
//! scripts, so the pages run under a strict CSP (sizes are classes).
//!
//! - `shell`: chrome shared with the SPA (`web/js/lib/chrome.js`), icons.
//! - `item` + `market`: `/item/<id>`; `market` also renders the fragment
//!   `item.js` swaps in after a poll.
//! - `dex`: mob, map, route, search and error pages.

mod dex;
mod item;
mod mapview;
mod market;
mod preview;
mod shell;
mod worldmap;

use maud::{html, Markup};

use super::format::Lang;
use super::model::{MapRef, Names, QuestHunt, QuestNeed, QuestRef, QuestReward};

pub use dex::{error_page, map_page, mob_page, not_found_page, npc_page, route_page, search_page};
pub use item::{item_data, item_market_fragment, item_page};
pub use market::{channel_groups, has_bonus, ladder, tier_bounds, Ladder, Tier};
pub use preview::item_preview;
pub use shell::{page_data_script, Ctx};

fn secondary_name(names: &Names, lang: Lang) -> Markup {
    html! { @if let Some(other) = names.secondary(lang) { span.name-secondary { (other) } } }
}

pub fn mob_image_url(gms_id: i32) -> String {
    format!("https://maplestory.io/api/GMS/83/mob/{gms_id}/render/stand")
}

/// Classic World client sprites in `web/images/mobs/` (listed with their
/// sources in its `sources.json`), for mobs the GMS v83 renderer lacks or shows
/// as another mob. Keep in step with `LOCAL_SPRITES` in `catalogue.tsx`.
const LOCAL_SPRITES: &[i32] = &[
    39, 42, 54, 55, 56, 57, 58, 59, 60, 61, 62, 63, 64, 65, 66, 67, 68, 69, 1059, 700003, 700006,
    700007, 700008, 800019, 800020, 800021, 800022, 800023, 800024, 800025, 810000, 810001, 810002,
    810003, 810004, 810005, 900000, 910000,
];

fn mob_picture_url(mob_id: i32, image_id: Option<i32>) -> Option<String> {
    if LOCAL_SPRITES.contains(&mob_id) {
        return Some(format!("/web/images/mobs/{mob_id}.png"));
    }
    image_id.map(mob_image_url)
}

/// Item icon in a bevelled slot; `size` is one of the `.s<N>` classes.
fn slot(icon_url: Option<&str>, size: u32) -> Markup {
    html! {
        span class={"slot s" (size)} {
            @if let Some(url) = icon_url { img src=(url) alt="" width=(size) height=(size) loading="lazy"; }
        }
    }
}

fn mob_pic(mob_id: i32, image_id: Option<i32>) -> Markup {
    html! {
        span.mobpic {
            @if let Some(url) = mob_picture_url(mob_id, image_id) { img src=(url) alt="" loading="lazy"; }
        }
    }
}

fn channel_label(lang: Lang, channel: i16) -> String {
    match lang {
        Lang::Zh => format!("{channel}频道"),
        Lang::En => format!("CH {channel}"),
    }
}

/// `14频道 | 8洞` in Chinese, with abbreviated English labels.
fn loc(lang: Lang, channel: Option<i16>, room: Option<i16>) -> Markup {
    match (channel, room) {
        (Some(ch), Some(room)) => html! {
            span.loc { b { (channel_label(lang, ch)) } span { (market::room_label(lang, room)) } }
        },
        _ => html! { span.loc.unk { (lang.t("位置未知", "location unknown")) } },
    }
}

/// "A · B · C 等 5 张地图"; plain text because the row is already a link.
fn map_list(maps: &[MapRef], lang: Lang) -> String {
    const SHOWN: usize = 3;
    if maps.is_empty() {
        return lang.t("没有出现地图记录", "no maps recorded").to_string();
    }
    let names: Vec<&str> = maps.iter().take(SHOWN).map(|m| m.names.get(lang)).collect();
    let mut text = names.join(" · ");
    if maps.len() > SHOWN {
        text.push_str(&match lang {
            Lang::Zh => format!(" 等 {} 张地图", maps.len()),
            Lang::En => format!(" and {} more", maps.len() - SHOWN),
        });
    }
    text
}

/// NiaDB's page for a quest; quest rows credit and link it.
pub(crate) fn quest_url(id: i32) -> String {
    format!("https://meowdb.com/msclassic/quest-tracker/{id}")
}

/// NiaDB's job (or gender) names in the reader's language.
fn job_label(job: &str, lang: Lang) -> String {
    let zh = match job {
        "Beginner" => "新手",
        "Warrior" => "战士",
        "Magician" => "魔法师",
        "Bowman" => "弓箭手",
        "Thief" => "飞侠",
        "Male" => "男",
        "Female" => "女",
        other => other,
    };
    lang.t(zh, job).to_string()
}

/// "NPC · Lv.10 · 每日 · 活动至 11-12".
fn quest_meta(q: &QuestRef, lang: Lang) -> String {
    let mut parts: Vec<String> = Vec::new();
    if let Some(npc) = &q.npc {
        parts.push(npc.label(lang));
    }
    if let Some(level) = q.level_min {
        parts.push(format!("Lv.{level}"));
    }
    match q.repeats.as_deref() {
        Some("daily") => parts.push(lang.t("每日", "daily").into()),
        Some("weekly") => parts.push(lang.t("每周", "weekly").into()),
        _ => {}
    }
    if let Some(end) = q.ends_at {
        let day = end.format("%m-%d");
        parts.push(match lang {
            Lang::Zh => format!("活动至 {day}"),
            Lang::En => format!("event until {day}"),
        });
    }
    parts.join(" · ")
}

/// How a reward is given, when not simply to everyone.
fn reward_note(r: &QuestReward, lang: Lang) -> Option<String> {
    let job = r.job.as_deref().map(|j| job_label(j, lang));
    match (r.kind.as_str(), job, lang) {
        ("choice", Some(job), Lang::Zh) => Some(format!("{job}可选其一")),
        ("choice", Some(job), Lang::En) => Some(format!("{job} pick one")),
        ("choice", None, _) => Some(lang.t("可选其一", "pick one").into()),
        ("random", job, _) => {
            let chance = r
                .chance_pct
                .map(|c| format!(" {}%", (c * 10.0).round() / 10.0))
                .unwrap_or_default();
            let who = job.map(|j| format!("{j} ")).unwrap_or_default();
            Some(match lang {
                Lang::Zh => format!("{who}随机{chance}"),
                Lang::En => format!("{who}random{chance}"),
            })
        }
        (_, Some(job), Lang::Zh) => Some(format!("仅{job}")),
        (_, Some(job), Lang::En) => Some(format!("{job} only")),
        _ => None,
    }
}

fn quest_line(lang: Lang, q: &QuestRef, note: Option<String>, amount: String) -> Markup {
    let meta = quest_meta(q, lang);
    html! {
        a.quest href=(quest_url(q.id)) target="_blank" rel="noopener noreferrer" {
            b { (q.names.get(lang)) }
            span.qn { (amount) }
            span.qm {
                (meta)
                @if let Some(note) = note { @if !meta.is_empty() { " · " } (note) }
            }
        }
    }
}

/// Quests that give an item.
pub fn quest_rewards(lang: Lang, rewards: &[QuestReward]) -> Markup {
    html! {
        div.quests {
            @for r in rewards { (quest_line(lang, &r.quest, reward_note(r, lang), format!("×{}", r.quantity))) }
        }
    }
}

/// Quests that ask for an item, or (`defeat`) to defeat a monster.
pub fn quest_needs(lang: Lang, needs: &[QuestNeed], defeat: bool) -> Markup {
    html! {
        div.quests {
            @for n in needs {
                (quest_line(lang, &n.quest, None, match (defeat, lang) {
                    (true, Lang::Zh) => format!("击败 {}", n.quantity),
                    (true, Lang::En) => format!("defeat {}", n.quantity),
                    (false, _) => format!("×{}", n.quantity),
                }))
            }
        }
    }
}

/// Quests an NPC gives (`with_npc`: the map page names the NPC).
pub fn quest_list(lang: Lang, quests: &[QuestRef], with_npc: bool) -> Markup {
    html! {
        div.quests {
            @for q in quests {
                @let shown = if with_npc { q.clone() } else { QuestRef { npc: None, ..q.clone() } };
                (quest_line(lang, &shown, None, String::new()))
            }
        }
    }
}

/// Quests that ask to defeat monsters found on a map.
pub fn quest_hunts(lang: Lang, hunts: &[QuestHunt]) -> Markup {
    html! {
        div.quests {
            @for h in hunts {
                (quest_line(lang, &h.quest, None, match lang {
                    Lang::Zh => format!("{} ×{}", h.mob.names.get(lang), h.quantity),
                    Lang::En => format!("{} ×{}", h.mob.names.get(lang), h.quantity),
                }))
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn classic_world_mobs_have_their_own_verified_sprites() {
        let dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../web/images/mobs");
        for &id in LOCAL_SPRITES {
            assert!(
                dir.join(format!("{id}.png")).is_file(),
                "missing sprite for {id}"
            );
            let url = mob_picture_url(id, Some(100100)).unwrap();
            assert_eq!(
                url,
                format!("/web/images/mobs/{id}.png"),
                "the local sprite wins"
            );
        }
        // 800022 is Flyeye (alt) in Classic World, not Mapledex's Rotten Mushmom copy.
        assert_ne!(mob_picture_url(800022, None), mob_picture_url(700003, None));
        assert_eq!(
            mob_picture_url(2, Some(100100)),
            Some(mob_image_url(100100))
        );
        assert_eq!(mob_picture_url(999999, None), None);
    }

    #[test]
    fn map_list_truncates() {
        let maps: Vec<MapRef> = (1..=5)
            .map(|i| MapRef::new(i, format!("m{i}"), format!("e{i}")))
            .collect();
        assert_eq!(map_list(&maps, Lang::Zh), "m1 · m2 · m3 等 5 张地图");
        assert_eq!(map_list(&maps, Lang::En), "e1 · e2 · e3 and 2 more");
        assert_eq!(map_list(&maps[..1], Lang::Zh), "m1");
        assert_eq!(map_list(&[], Lang::Zh), "没有出现地图记录");
    }

    #[test]
    fn location_chip() {
        let html = loc(Lang::Zh, Some(14), Some(8)).into_string();
        assert_eq!(
            html,
            r#"<span class="loc"><b>14频道</b><span>8洞</span></span>"#
        );
        assert!(loc(Lang::En, Some(14), Some(8))
            .into_string()
            .contains("<b>CH 14</b>"));
        assert!(loc(Lang::En, None, None)
            .into_string()
            .contains("location unknown"));
    }
}

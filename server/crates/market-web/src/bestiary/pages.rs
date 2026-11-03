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
mod market;
mod preview;
mod shell;

use maud::{html, Markup};

use super::format::Lang;
use super::model::{MapRef, Names};

pub use dex::{error_page, map_page, mob_page, not_found_page, route_page, search_page};
pub use item::{item_market_fragment, item_page};
pub use market::{channel_groups, has_bonus, ladder, tier_bounds, Ladder, Tier};
pub use preview::item_preview;
pub use shell::{Ctx, Device};

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

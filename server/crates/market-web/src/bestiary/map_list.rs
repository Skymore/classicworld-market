//! Maps the map list shows as one card: rooms of one place that are the same
//! map in every way (same NPCs, same exits). Reviewed by hand with every
//! other same-name and numbered group, which stay separate (蚂蚁洞Ⅰ–Ⅳ, the
//! subway's areas, 蘑菇村 10 and 20, the two 蘑菇山, 捷径 I and II).

use super::format::Lang;

pub struct Rooms {
    /// The card links this map; the others are not listed.
    pub first: i32,
    pub last: i32,
    /// The card's name, when the first room's is not right for all of them.
    pub names: Option<(&'static str, &'static str)>,
    pub copies: (&'static str, &'static str),
}

pub const ROOMS: &[Rooms] = &[
    Rooms {
        first: 90_040_200,
        last: 90_040_202,
        names: None,
        copies: ("3 个场地", "3 fields"),
    },
    Rooms {
        first: 80_002_001,
        last: 80_002_020,
        names: Some(("自由市场 <1>–<20>", "Free Market <1>–<20>")),
        copies: ("20 个房间", "20 rooms"),
    },
];

pub fn card(map_id: i32) -> Option<&'static Rooms> {
    ROOMS.iter().find(|r| r.first == map_id)
}

/// SQL: `alias` is not one of the rooms a card stands for.
pub fn listed_sql(alias: &str) -> String {
    let rooms: Vec<String> = ROOMS
        .iter()
        .map(|r| format!("{alias}.id BETWEEN {} AND {}", r.first + 1, r.last))
        .collect();
    format!("NOT ({})", rooms.join(" OR "))
}

impl Rooms {
    pub fn copies(&self, lang: Lang) -> &'static str {
        match lang {
            Lang::Zh => self.copies.0,
            Lang::En => self.copies.1,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_the_first_room_is_listed() {
        assert_eq!(
            listed_sql("m"),
            "NOT (m.id BETWEEN 90040201 AND 90040202 OR m.id BETWEEN 80002002 AND 80002020)"
        );
        assert!(card(80_002_001).is_some() && card(80_002_002).is_none());
    }
}

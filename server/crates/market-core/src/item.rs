//! Item facts the reports derive from the item id and the catalogue.

/// `market_dashboard.CATEGORIES`: inventory tab name from the item id.
pub fn category_name(item_id: i64) -> &'static str {
    match item_id / 1_000_000 {
        1 => "装备",
        2 => "消耗品",
        3 => "装饰",
        4 | 6 => "其他",
        5 => "商城物品",
        _ => "未知",
    }
}

/// Category shown in market lists: cash-shop equipment (时装/暖暖) sits with
/// the other cash-shop items instead of among the equipment.
pub fn listing_category(item_id: i64, is_cash: bool) -> &'static str {
    if is_cash && is_equipment(item_id) {
        "商城物品"
    } else {
        category_name(item_id)
    }
}

/// SQL for the listing category's id range of `item` (an item-id column),
/// matching `listing_category`, for `?category=` filters.
pub fn listing_kind_sql(item: &str) -> String {
    format!(
        "(CASE WHEN {item} / 1000000 = 1 AND EXISTS (SELECT 1 FROM items ck WHERE ck.id = {item} AND ck.is_cash) THEN 5 ELSE {item} / 1000000 END)"
    )
}

/// Item-id range of a category name, for `?category=` filters.
pub fn category_kinds(name: &str) -> &'static [i64] {
    match name {
        "装备" => &[1],
        "消耗品" => &[2],
        "装饰" => &[3],
        "其他" => &[4, 6],
        "商城物品" => &[5],
        _ => &[],
    }
}

pub fn is_equipment(item_id: i64) -> bool {
    item_id / 1_000_000 == 1
}

/// `market_dashboard.equipment_jobs`: job names from the Mapledex reqJob mask.
pub fn equipment_jobs(mask: Option<i64>) -> Vec<&'static str> {
    match mask {
        None => vec![],
        Some(0) => vec!["通用"],
        Some(-1) => vec!["新手"],
        Some(mask) => [
            (1, "战士"),
            (2, "魔法师"),
            (4, "弓箭手"),
            (8, "飞侠"),
            (16, "海盗"),
        ]
        .into_iter()
        .filter(|(bit, _)| mask & bit != 0)
        .map(|(_, label)| label)
        .collect(),
    }
}

/// The stats that set an equipment piece's price: the main and secondary stat
/// of every job that can wear it (all four for common or unknown items),
/// weapon and magic attack (gloves and others take attack scrolls) and
/// critical rate and damage. Defence, HP/MP, accuracy, avoid, speed and jump
/// do not split prices. Mirrors `keyStats` in frontend/src/lib/item-market.ts.
pub fn key_stats(mask: Option<i64>) -> Vec<&'static str> {
    const JOBS: [(i64, [&str; 2]); 5] = [
        (1, ["str", "dex"]),
        (2, ["int", "luk"]),
        (4, ["dex", "str"]),
        (8, ["luk", "dex"]),
        (16, ["str", "dex"]),
    ];
    let mut keys = vec!["weapon_attack", "magic_attack", "critical_rate", "critical_damage"];
    let worn: Vec<&str> = JOBS
        .iter()
        .filter(|(bit, _)| mask.is_some_and(|m| m > 0 && m & bit != 0))
        .flat_map(|(_, stats)| *stats)
        .collect();
    let stats = if worn.is_empty() { vec!["str", "dex", "int", "luk"] } else { worn };
    for stat in stats {
        if !keys.contains(&stat) {
            keys.push(stat);
        }
    }
    keys
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn key_stats_follow_the_jobs() {
        let mut magician = key_stats(Some(2));
        magician.sort_unstable();
        assert_eq!(
            magician,
            ["critical_damage", "critical_rate", "int", "luk", "magic_attack", "weapon_attack"]
        );
        assert!(key_stats(Some(9)).contains(&"luk") && !key_stats(Some(9)).contains(&"int"));
        for common in [None, Some(0), Some(-1)] {
            assert!(["str", "dex", "int", "luk"].iter().all(|s| key_stats(common).contains(s)));
        }
    }

    #[test]
    fn categories_and_jobs() {
        assert_eq!(category_name(1_040_020), "装备");
        assert_eq!(category_name(4_010_001), "其他");
        assert_eq!(listing_category(1_047_185, true), "商城物品");
        assert_eq!(listing_category(1_040_020, false), "装备");
        assert_eq!(listing_category(5_000_015, true), "商城物品");
        assert_eq!(listing_category(2_000_000, true), "消耗品");
        assert_eq!(equipment_jobs(Some(9)), vec!["战士", "飞侠"]);
        assert_eq!(equipment_jobs(Some(0)), vec!["通用"]);
        assert!(equipment_jobs(None).is_empty());
    }
}

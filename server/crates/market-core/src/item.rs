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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn categories_and_jobs() {
        assert_eq!(category_name(1_040_020), "装备");
        assert_eq!(category_name(4_010_001), "其他");
        assert_eq!(equipment_jobs(Some(9)), vec!["战士", "飞侠"]);
        assert_eq!(equipment_jobs(Some(0)), vec!["通用"]);
        assert!(equipment_jobs(None).is_empty());
    }
}

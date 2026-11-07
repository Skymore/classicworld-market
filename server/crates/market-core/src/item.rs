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

#[cfg(test)]
mod tests {
    use super::*;

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

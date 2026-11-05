//! What the game's equipment tooltip shows for an item: requirements, the
//! jobs that can wear it, its category, attack speed and upgrade slots.
//! Read from the catalogue record (`item_records.record`): NiaDB's stats
//! first (Classic World values), then Mapledex, then DVG's `requirements`.
//! Base stats stay in `queries::reference_stats`.

use serde::Serialize;
use serde_json::{Map, Value};

use super::catalog::subcategory_for;
use super::model::ItemSummary;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Requirements {
    pub level: i64,
    pub str: i64,
    pub dex: i64,
    pub int: i64,
    pub luk: i64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct EquipmentReference {
    /// `None` when no source lists the requirements.
    pub req: Option<Requirements>,
    /// Job bits (1 warrior, 2 magician, 4 bowman, 8 thief); 0 every job,
    /// -1 beginners only. `None` when unknown.
    pub jobs: Option<i64>,
    pub weapon: bool,
    /// Weapon type for weapons (拳套), slot for the rest (帽子).
    pub kind: Option<&'static str>,
    pub kind_en: Option<&'static str>,
    /// The client's attack speed number (lower is faster); weapons only.
    pub attack_speed: Option<i64>,
    /// Upgrade slots of an unscrolled piece (`tuc`).
    pub upgrades: Option<i64>,
}

/// Classic World weapon types by `id / 10000`.
const WEAPONS: [(i32, &str, &str); 16] = [
    (130, "单手剑", "One-Handed Sword"),
    (131, "单手斧", "One-Handed Axe"),
    (132, "单手钝器", "One-Handed Blunt Weapon"),
    (133, "短刀", "Dagger"),
    (137, "短杖", "Wand"),
    (138, "长杖", "Staff"),
    (140, "双手剑", "Two-Handed Sword"),
    (141, "双手斧", "Two-Handed Axe"),
    (142, "双手钝器", "Two-Handed Blunt Weapon"),
    (143, "枪", "Spear"),
    (144, "矛", "Pole Arm"),
    (145, "弓", "Bow"),
    (146, "弩", "Crossbow"),
    (147, "拳套", "Claw"),
    (148, "指节", "Knuckle"),
    (149, "短枪", "Gun"),
];

fn slot_en(zh: &str) -> Option<&'static str> {
    Some(match zh {
        "帽子" => "Hat",
        "脸饰" => "Face Accessory",
        "眼饰" => "Eye Accessory",
        "耳环" => "Earrings",
        "上衣" => "Top",
        "套服" => "Overall",
        "裤裙" => "Bottom",
        "鞋子" => "Shoes",
        "手套" => "Gloves",
        "盾牌" => "Shield",
        "披风" => "Cape",
        "戒指" => "Ring",
        "武器" => "Weapon",
        "宠物装备" => "Pet Equipment",
        _ => return None,
    })
}

fn kind(id: i32) -> (Option<&'static str>, Option<&'static str>) {
    if let Some((_, zh, en)) = WEAPONS.iter().find(|(prefix, _, _)| *prefix == id / 10_000) {
        return (Some(zh), Some(en));
    }
    let zh = subcategory_for(id);
    (zh, zh.and_then(slot_en))
}

fn int(map: &Map<String, Value>, key: &str) -> Option<i64> {
    map.get(key).and_then(Value::as_i64)
}

/// NiaDB names the jobs instead of giving the mask ("Warrior/Thief").
pub fn niadb_job(names: &str) -> Option<i64> {
    let mut mask = 0;
    for name in names.split('/') {
        mask |= match name.trim() {
            "Warrior" => 1,
            "Mage" | "Magician" => 2,
            "Bowman" | "Archer" => 4,
            "Thief" => 8,
            "Beginner" => return Some(-1),
            _ => return None,
        };
    }
    Some(mask)
}

/// The job mask of NiaDB equipment stats: no `reqJob` means every job.
pub fn niadb_jobs(stats: &Map<String, Value>) -> Option<i64> {
    match stats.get("reqJob") {
        None | Some(Value::Null) => Some(0),
        Some(value) => niadb_job(value.as_str()?),
    }
}

/// `None` for anything but equipment.
pub fn equipment_reference(
    item: &ItemSummary,
    record: Option<&Value>,
) -> Option<EquipmentReference> {
    if item.id / 1_000_000 != 1 {
        return None;
    }
    let object = |pointer: &str| {
        record
            .and_then(|r| r.pointer(pointer))
            .and_then(Value::as_object)
    };
    let mapledex = object("/mapledex_reference/data");
    let dvg = object("/requirements");
    let niadb = object("/niadb_reference/stats");
    let level = item.req_level.map(i64::from);
    let mapledex_level = mapledex.and_then(|m| int(m, "reqLevel"));
    // NiaDB has Classic World's numbers; Mapledex is GMS data and differs on
    // some weapons (Coconut Knife: 35 vs 38 attack). Mapledex and NiaDB leave
    // out zero requirements; DVG lists all four.
    let req = if let Some(n) = niadb {
        Some(Requirements {
            level: mapledex_level.or(level).unwrap_or(0),
            str: int(n, "reqStr").unwrap_or(0),
            dex: int(n, "reqDex").unwrap_or(0),
            int: int(n, "reqInt").unwrap_or(0),
            luk: int(n, "reqLuk").unwrap_or(0),
        })
    } else if let Some(m) = mapledex {
        Some(Requirements {
            level: mapledex_level.or(level).unwrap_or(0),
            str: int(m, "reqSTR").unwrap_or(0),
            dex: int(m, "reqDEX").unwrap_or(0),
            int: int(m, "reqINT").unwrap_or(0),
            luk: int(m, "reqLUK").unwrap_or(0),
        })
    } else if let Some(d) = dvg {
        Some(Requirements {
            level: level.unwrap_or(0),
            str: int(d, "str").unwrap_or(0),
            dex: int(d, "dex").unwrap_or(0),
            int: int(d, "int").unwrap_or(0),
            luk: int(d, "luk").unwrap_or(0),
        })
    } else {
        None
    };
    let jobs = niadb
        .and_then(niadb_jobs)
        .or_else(|| mapledex.and_then(|m| int(m, "reqJob")))
        .or(item.req_job_mask.map(i64::from))
        // Mapledex leaves the mask out for gear every job can wear.
        .or(mapledex.map(|_| 0));
    let weapon = (130..=170).contains(&(item.id / 10_000));
    let (kind, kind_en) = kind(item.id);
    let attack_speed = weapon
        .then(|| {
            niadb
                .and_then(|n| int(n, "attackSpeed"))
                .or_else(|| mapledex.and_then(|m| int(m, "attackSpeed")))
        })
        .flatten();
    let upgrades = niadb
        .and_then(|n| int(n, "slots"))
        .or_else(|| mapledex.and_then(|m| int(m, "tuc")));
    Some(EquipmentReference {
        req,
        jobs,
        weapon,
        kind,
        kind_en,
        attack_speed,
        upgrades,
    })
}

/// The tooltip's word for an attack speed number: 2-3 很快, 4-5 快, 6 普通,
/// 7-8 慢, 9 很慢 (NiaDB: Faster, Fast, Normal, Slow).
pub fn attack_speed_label(speed: i64) -> (&'static str, &'static str) {
    match speed {
        i64::MIN..=3 => ("很快", "Faster"),
        4 | 5 => ("快", "Fast"),
        6 => ("普通", "Normal"),
        7 | 8 => ("慢", "Slow"),
        _ => ("很慢", "Slower"),
    }
}

/// Variant stat keys in the tooltip's order, with its names.
pub const STATS: [(&str, &str, &str); 16] = [
    ("str", "力量", "STR"),
    ("dex", "敏捷", "DEX"),
    ("int", "智力", "INT"),
    ("luk", "运气", "LUK"),
    ("hp", "最大HP", "MaxHP"),
    ("mp", "最大MP", "MaxMP"),
    ("weapon_attack", "物理攻击", "Weapon Attack"),
    ("magic_attack", "魔法攻击", "Magic Attack"),
    ("critical_rate", "暴击率", "Critical Rate"),
    ("critical_damage", "暴击伤害", "Critical Damage"),
    ("weapon_defense", "物理防御", "Weapon Defense"),
    ("magic_defense", "魔法防御", "Magic Defense"),
    ("accuracy", "命中值", "Accuracy"),
    ("avoid", "回避值", "Avoidability"),
    ("speed", "移动速度", "Speed"),
    ("jump", "跳跃力", "Jump"),
];

/// Jobs as the tooltip lists them, with their bits; MSCW has no pirates.
pub const JOBS: [(i64, &str, &str); 5] = [
    (0, "新手", "Beginner"),
    (1, "战士", "Warrior"),
    (2, "魔法师", "Magician"),
    (4, "弓箭手", "Bowman"),
    (8, "飞侠", "Thief"),
];

/// Whether the tooltip lights a job: every job for 0, beginners for -1.
pub fn job_allowed(mask: i64, bit: i64) -> bool {
    match mask {
        0 => true,
        -1 => bit == 0,
        mask => bit != 0 && mask & bit != 0,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn speed_words_and_jobs() {
        assert_eq!(attack_speed_label(4).0, "快");
        assert_eq!(attack_speed_label(3).0, "很快");
        assert_eq!(attack_speed_label(6).1, "Normal");
        assert_eq!(attack_speed_label(8).0, "慢");
        assert!(JOBS.iter().all(|(bit, _, _)| job_allowed(0, *bit)));
        assert!(job_allowed(-1, 0) && !job_allowed(-1, 1));
        let thief: Vec<_> = JOBS
            .iter()
            .filter(|(b, _, _)| job_allowed(9, *b))
            .map(|j| j.1)
            .collect();
        assert_eq!(thief, ["战士", "飞侠"]);
    }

    fn item(id: i32, req_level: Option<i16>, req_job_mask: Option<i16>) -> ItemSummary {
        ItemSummary {
            id,
            name_zh: None,
            name_en: String::new(),
            category: "装备".into(),
            subcategory: None,
            req_level,
            req_job_mask,
            icon_url: None,
            is_cash: false,
        }
    }

    #[test]
    fn mapledex_claw() {
        let record = json!({"mapledex_reference": {"data": {"attackSpeed": 4, "incPAD": 23,
            "reqDEX": 30, "reqJob": 8, "reqLUK": 65, "reqLevel": 30, "slot": "Claw", "tuc": 7}}});
        let r = equipment_reference(&item(1_472_009, Some(30), Some(8)), Some(&record)).unwrap();
        assert_eq!(
            r,
            EquipmentReference {
                req: Some(Requirements {
                    level: 30,
                    str: 0,
                    dex: 30,
                    int: 0,
                    luk: 65
                }),
                jobs: Some(8),
                weapon: true,
                kind: Some("拳套"),
                kind_en: Some("Claw"),
                attack_speed: Some(4),
                upgrades: Some(7),
            }
        );
    }

    #[test]
    fn every_job_hat_without_attack_speed() {
        let record =
            json!({"mapledex_reference": {"data": {"reqLevel": 10, "tuc": 7, "attackSpeed": 6}}});
        let r = equipment_reference(&item(1_002_008, Some(10), None), Some(&record)).unwrap();
        assert_eq!(r.jobs, Some(0));
        assert!(!r.weapon);
        assert_eq!((r.kind, r.kind_en), (Some("帽子"), Some("Hat")));
        assert_eq!(r.attack_speed, None);
        assert_eq!(r.req.unwrap().level, 10);
    }

    #[test]
    fn falls_back_to_dvg_then_niadb() {
        let dvg = json!({"requirements": {"str": 35, "dex": 0, "int": 0, "luk": 0}});
        let r = equipment_reference(&item(1_302_004, Some(25), Some(1)), Some(&dvg)).unwrap();
        assert_eq!(
            r.req,
            Some(Requirements {
                level: 25,
                str: 35,
                dex: 0,
                int: 0,
                luk: 0
            })
        );
        assert_eq!((r.jobs, r.upgrades), (Some(1), None));

        let niadb = json!({"niadb_reference": {"stats": {"reqStr": 35, "reqJob": "Warrior",
            "attackSpeed": 5, "slots": 7}}});
        let r = equipment_reference(&item(1_302_004, Some(25), None), Some(&niadb)).unwrap();
        assert_eq!(r.req.as_ref().map(|q| q.str), Some(35));
        assert_eq!(
            (r.jobs, r.attack_speed, r.upgrades),
            (Some(1), Some(5), Some(7))
        );
        assert_eq!(r.kind, Some("单手剑"));
    }

    #[test]
    fn niadb_wins_over_mapledex() {
        // Coconut Knife: Mapledex (GMS) says speed 3 and warrior/thief.
        let record = json!({
            "mapledex_reference": {"data": {"reqLevel": 20, "reqDEX": 15, "reqLUK": 30,
                "reqJob": 9, "incPAD": 35, "tuc": 7, "attackSpeed": 3}},
            "niadb_reference": {"stats": {"reqDex": 15, "reqLuk": 30, "watk": 38, "slots": 7,
                "attackSpeed": 4, "reqJob": "Thief"}},
        });
        let r = equipment_reference(&item(1_332_005, Some(20), Some(9)), Some(&record)).unwrap();
        assert_eq!(
            (r.jobs, r.attack_speed, r.upgrades),
            (Some(8), Some(4), Some(7))
        );
        assert_eq!(r.req.unwrap().level, 20);
        // Iron Dagger: Mapledex has STR 20 where Classic World has DEX 20.
        let record = json!({
            "mapledex_reference": {"data": {"reqLevel": 25, "reqSTR": 20, "reqLUK": 40}},
            "niadb_reference": {"stats": {"reqDex": 20, "reqLuk": 40, "reqJob": "Warrior/Thief"}},
        });
        let r = equipment_reference(&item(1_332_007, Some(25), None), Some(&record)).unwrap();
        let req = r.req.unwrap();
        assert_eq!((req.str, req.dex, req.luk), (0, 20, 40));
        assert_eq!(r.jobs, Some(9));
        assert_eq!(niadb_job("Warrior/Bowman/Thief"), Some(13));
        assert_eq!(niadb_jobs(&serde_json::Map::new()), Some(0));
    }

    #[test]
    fn unknown_without_a_record() {
        let r = equipment_reference(&item(1_040_002, Some(0), None), None).unwrap();
        assert_eq!((r.req, r.jobs, r.upgrades), (None, None, None));
        assert_eq!(r.kind, Some("上衣"));
        assert!(equipment_reference(&item(2_000_000, None, None), None).is_none());
    }
}

//! Port of the notification rules in `web/js/lib/watch-reminders.js`
//! (`watchGroups`, `watchSelection(..., 'notify')`, `reminderSelection`,
//! `prepareReminderRows`) and the reminder conditions of
//! `web/js/lib/item-offer-filters.js`. Rows are `grouped_listings` rows of
//! `views::watch_listings`. `web/tests/fixtures/watch-match.json` is checked
//! by both this module and `web/tests/watch-match-parity.test.mjs`; change the
//! JavaScript, this file and the fixture together.

use serde_json::Value;
use std::collections::HashSet;

const EQUIPMENT_STATS: [&str; 14] = [
    "weapon_attack",
    "magic_attack",
    "str",
    "dex",
    "int",
    "luk",
    "hp",
    "mp",
    "accuracy",
    "avoid",
    "speed",
    "jump",
    "weapon_defense",
    "magic_defense",
];
/// Defense never counts as a bonus over the item's base stats.
const NOT_BONUS: [&str; 4] = ["weapon_defense", "magic_defense", "pdd", "mdd"];
const MAX_SAFE_INTEGER: f64 = 9_007_199_254_740_991.0;

/// `watch_listings` context shared by every item of one account.
pub struct Reference<'a> {
    /// All grouped rows: the percentile baseline.
    pub rows: &'a [Value],
    /// `percentile_caps`: `{item: {"10"|"25"|"50": price}}`.
    pub percentiles: &'a Value,
    /// `base_stats`: `{item: [[stat, value], ...]}`.
    pub base_stats: &'a Value,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Stock {
    All,
    Known,
    Unknown,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Gear {
    All,
    Captured,
    Missing,
    Bonus,
}

#[derive(Debug, Clone, PartialEq)]
struct StatFloor {
    stat: &'static str,
    min: Option<f64>,
}

/// `normalizeReminder`: offer conditions without time or a maximum price.
#[derive(Debug, Clone, PartialEq)]
struct Reminder {
    percentile: Option<&'static str>,
    min_price: Option<f64>,
    stock: Stock,
    min_stock: Option<f64>,
    equipment: Gear,
    stats: Vec<StatFloor>,
    min_upgrades: Option<f64>,
    max_upgrades: Option<f64>,
}

struct Group {
    cap: Option<f64>,
    notify: bool,
    reminder: Reminder,
}

/// JavaScript truthiness of a JSON value (`undefined` is `Null`).
fn truthy(value: &Value) -> bool {
    match value {
        Value::Null => false,
        Value::Bool(b) => *b,
        Value::Number(n) => n.as_f64().is_some_and(|n| n != 0.0),
        Value::String(s) => !s.is_empty(),
        Value::Array(_) | Value::Object(_) => true,
    }
}

/// `Number.isFinite(value)`: numbers only, no coercion.
fn finite(value: &Value) -> Option<f64> {
    value.as_f64().filter(|n| n.is_finite())
}

fn integer(n: f64) -> bool {
    n.is_finite() && n.fract() == 0.0
}

/// `nonnegative` in item-offer-filters.js. Stored settings are numbers; the
/// string and boolean cases follow `Number()` for older local values.
fn nonnegative(value: Option<&Value>) -> Option<f64> {
    let number = match value? {
        Value::Null => return None,
        Value::Number(n) => n.as_f64()?,
        Value::Bool(b) => f64::from(u8::from(*b)),
        Value::String(s) if s.trim().is_empty() => return None,
        Value::String(s) => s.trim().parse::<f64>().ok()?,
        Value::Array(_) | Value::Object(_) => return None,
    };
    (number.is_finite() && (0.0..=MAX_SAFE_INTEGER).contains(&number)).then_some(number)
}

fn ordered(low: Option<f64>, high: Option<f64>) -> (Option<f64>, Option<f64>) {
    match (low, high) {
        (Some(a), Some(b)) if a > b => (Some(b), Some(a)),
        pair => pair,
    }
}

fn normalize_stats(value: &Value) -> Vec<StatFloor> {
    let legacy;
    let source: &[Value] = match value.get("stats") {
        Some(Value::Array(rows)) => rows,
        _ => {
            legacy = [serde_json::json!({
                "stat": value.get("stat").cloned().unwrap_or(Value::Null),
                "min": value.get("minStat").cloned().unwrap_or(Value::Null),
            })];
            &legacy
        }
    };
    let mut stats: Vec<StatFloor> = Vec::new();
    for condition in source.iter().take(28) {
        if !truthy(condition) {
            continue;
        }
        let Some(stat) = condition
            .get("stat")
            .and_then(Value::as_str)
            .and_then(|s| EQUIPMENT_STATS.iter().copied().find(|key| *key == s))
        else {
            continue;
        };
        let minimum = nonnegative(condition.get("min"))
            .filter(|n| *n <= 65535.0)
            .map(f64::floor);
        if let Some(previous) = stats.iter_mut().find(|row| row.stat == stat) {
            previous.min = Some(previous.min.unwrap_or(1.0).max(minimum.unwrap_or(1.0)));
        } else {
            stats.push(StatFloor { stat, min: minimum });
        }
    }
    stats
}

/// `String(value)` is one of the reminder percentiles.
fn percentile(value: Option<&Value>) -> Option<&'static str> {
    let text = match value? {
        Value::String(s) => s.clone(),
        Value::Number(n) => match n.as_f64() {
            Some(f) if integer(f) => format!("{f:.0}"),
            _ => return None,
        },
        _ => return None,
    };
    ["10", "25", "50"].into_iter().find(|p| *p == text)
}

fn normalize_reminder(value: &Value) -> Reminder {
    let upgrades = |key| nonnegative(value.get(key)).filter(|n| integer(*n) && *n <= 15.0);
    let (min_upgrades, max_upgrades) = ordered(upgrades("minUpgrades"), upgrades("maxUpgrades"));
    let text = |key| value.get(key).and_then(Value::as_str);
    Reminder {
        percentile: percentile(value.get("percentile")),
        min_price: nonnegative(value.get("minPrice")),
        stock: match text("stock") {
            Some("known") => Stock::Known,
            Some("unknown") => Stock::Unknown,
            _ => Stock::All,
        },
        min_stock: nonnegative(value.get("minStock"))
            .filter(|n| *n >= 1.0)
            .map(f64::floor),
        equipment: match text("equipment") {
            Some("captured") => Gear::Captured,
            Some("missing") => Gear::Missing,
            Some("bonus") => Gear::Bonus,
            _ => Gear::All,
        },
        stats: normalize_stats(value),
        min_upgrades,
        max_upgrades,
    }
}

/// `watchGroups`: a missing `groups` list is the legacy single condition set.
fn watch_groups(setting: &Value) -> Vec<Group> {
    let field = |g: &Value, key: &str| g.get(key).cloned().unwrap_or(Value::Null);
    let legacy;
    let source: &[Value] = match setting.get("groups") {
        Some(Value::Array(groups)) => groups,
        _ => {
            legacy = [serde_json::json!({
                "cap": field(setting, "cap"),
                "notify": field(setting, "notify"),
                "reminder": field(setting, "reminder"),
            })];
            &legacy
        }
    };
    source
        .iter()
        .take(12)
        .map(|g| Group {
            cap: g.get("cap").and_then(finite).filter(|c| *c >= 0.0),
            notify: g.get("notify") != Some(&Value::Bool(false)),
            reminder: normalize_reminder(g.get("reminder").unwrap_or(&Value::Null)),
        })
        .collect()
}

fn is_equipment(item: f64) -> bool {
    (item / 1_000_000.0).floor() == 1.0
}

fn same_item(row: &Value, item: f64) -> bool {
    row.get("item_id").and_then(Value::as_f64) == Some(item)
}

/// `activeOffers`.
fn active(row: &Value) -> bool {
    let field = |key| row.get(key).unwrap_or(&Value::Null);
    !truthy(field("invalidated_at"))
        && finite(field("unit_price")).is_some_and(|p| p >= 0.0)
        && (field("stock").is_null() || finite(field("stock")).is_some_and(|s| s > 0.0))
}

/// One row of `prepareReminderRows`.
struct Prepared<'a> {
    row: &'a Value,
    price: f64,
    variant: Option<&'a serde_json::Map<String, Value>>,
    equipment: bool,
    has_stats: bool,
    bonus: bool,
}

fn variant_ok(variant: &serde_json::Map<String, Value>) -> bool {
    variant
        .get("status")
        .is_none_or(|s| !truthy(s) || s == "candidate")
}

fn prepare<'a>(row: &'a Value, base_stats: &Value) -> Prepared<'a> {
    // `typeof value === 'object'`: an array is chosen too, but carries no stats.
    let pick = |value: Option<&'a Value>| match value {
        Some(Value::Object(map)) => Some(Some(map)),
        Some(Value::Array(_)) => Some(None),
        _ => None,
    };
    let variant = pick(row.get("equipment"))
        .or_else(|| pick(row.get("variant")))
        .flatten();
    let item = row["item_id"].as_f64().unwrap_or(f64::NAN);
    let stats = variant
        .and_then(|v| v.get("stats"))
        .and_then(Value::as_array);
    let has_stats = variant.is_some_and(variant_ok) && stats.is_some();
    let key = row
        .get("item_id")
        .map(|id| match id {
            Value::Number(n) => n.to_string(),
            other => other.as_str().unwrap_or_default().to_owned(),
        })
        .unwrap_or_default();
    let base: &[Value] = base_stats
        .get(&key)
        .and_then(Value::as_array)
        .map_or(&[], Vec::as_slice);
    let base_value = |stat: &str| {
        base.iter()
            .find(|pair| pair.get(0).and_then(Value::as_str) == Some(stat))
            .and_then(|pair| pair.get(1))
            .and_then(Value::as_f64)
            .unwrap_or(0.0)
    };
    let bonus = has_stats
        && !base.is_empty()
        && stats.into_iter().flatten().any(|stat| {
            let key = stat.get("key").and_then(Value::as_str).unwrap_or_default();
            !NOT_BONUS.contains(&key)
                && stat
                    .get("value")
                    .and_then(finite)
                    .is_some_and(|v| v > base_value(key))
        });
    Prepared {
        row,
        price: row["unit_price"].as_f64().unwrap_or(f64::NAN),
        variant,
        equipment: is_equipment(item),
        has_stats,
        bonus,
    }
}

/// `matchesEquipmentStats`.
fn has_stat_floors(variant: Option<&serde_json::Map<String, Value>>, floors: &[StatFloor]) -> bool {
    let stats = variant
        .and_then(|v| v.get("stats"))
        .and_then(Value::as_array)
        .map_or(&[][..], Vec::as_slice);
    floors.iter().all(|floor| {
        stats.iter().any(|stat| {
            stat.get("key").and_then(Value::as_str) == Some(floor.stat)
                && stat
                    .get("value")
                    .and_then(Value::as_f64)
                    .is_some_and(|v| integer(v) && v >= floor.min.unwrap_or(1.0) && v <= 65535.0)
        })
    })
}

/// The `filterOffers` conditions a reminder can set.
fn passes(row: &Prepared, f: &Reminder) -> bool {
    if f.min_price
        .is_some_and(|min| !(row.price.is_finite() && row.price >= min))
    {
        return false;
    }
    let stock = row.row.get("stock").and_then(finite);
    let known = !truthy(row.row.get("invalidated_at").unwrap_or(&Value::Null))
        && stock.is_some_and(|s| s >= 0.0);
    if (f.stock == Stock::Known && !known) || (f.stock == Stock::Unknown && known) {
        return false;
    }
    if f.min_stock
        .is_some_and(|min| !(known && stock.unwrap() >= min))
    {
        return false;
    }
    match f.equipment {
        Gear::Captured if !row.has_stats => return false,
        Gear::Missing if !row.equipment || row.has_stats => return false,
        Gear::Bonus if !row.bonus => return false,
        _ => {}
    }
    if !f.stats.is_empty() && (!row.equipment || !has_stat_floors(row.variant, &f.stats)) {
        return false;
    }
    if f.min_upgrades.is_some() || f.max_upgrades.is_some() {
        let n = row
            .variant
            .and_then(|v| v.get("remaining_upgrades"))
            .and_then(Value::as_f64);
        let unsupported = row.variant.is_some_and(|v| !variant_ok(v));
        let Some(n) = n.filter(|n| integer(*n) && (0.0..=15.0).contains(n)) else {
            return false;
        };
        if !row.equipment || unsupported {
            return false;
        }
        if f.min_upgrades.is_some_and(|min| n < min) || f.max_upgrades.is_some_and(|max| n > max) {
            return false;
        }
    }
    true
}

/// `reminderSelection(rows, item, group, reference).rows`.
fn group_selection<'a>(
    rows: &'a [Value],
    item: f64,
    group: &Group,
    reference: &Reference,
) -> Vec<&'a Value> {
    let f = &group.reminder;
    let mut cap = group.cap;
    if let Some(p) = f.percentile {
        let mut prices: Vec<f64> = reference
            .rows
            .iter()
            .filter(|row| same_item(row, item) && active(row))
            .map(|row| row["unit_price"].as_f64().unwrap())
            .collect();
        prices.sort_by(f64::total_cmp);
        let index = (prices.len() * p.parse::<usize>().unwrap()).div_ceil(100);
        let key = format!("{item:.0}");
        cap = reference
            .percentiles
            .get(&key)
            .and_then(|caps| caps.get(p))
            .and_then(Value::as_f64)
            .or_else(|| index.checked_sub(1).and_then(|i| prices.get(i).copied()));
        if cap.is_none() {
            return Vec::new();
        }
    }
    let equipment = is_equipment(item);
    let conditions = Reminder {
        equipment: if equipment { f.equipment } else { Gear::All },
        stats: if equipment {
            f.stats.clone()
        } else {
            Vec::new()
        },
        ..f.clone()
    };
    rows.iter()
        .filter(|row| same_item(row, item) && active(row))
        .map(|row| prepare(row, reference.base_stats))
        .filter(|row| {
            cap.is_none_or(|cap| row.price <= cap)
                && (!equipment || f.stats.is_empty() || row.has_stats)
        })
        .filter(|row| passes(row, &conditions))
        .map(|row| row.row)
        .collect()
}

/// `watchSelection(rows, item, setting, reference, 'notify').rows`: offers
/// matching any notifying group, each once, in first-match order.
pub fn notify_selection<'a>(
    rows: &'a [Value],
    item: i64,
    setting: &Value,
    reference: &Reference,
) -> Vec<&'a Value> {
    let mut seen = HashSet::new();
    let mut found = Vec::new();
    for group in watch_groups(setting).iter().filter(|g| g.notify) {
        for row in group_selection(rows, item as f64, group, reference) {
            if seen.insert(row.get("id").map(Value::to_string).unwrap_or_default()) {
                found.push(row);
            }
        }
    }
    found
}

/// Whether any group of a watch setting asks for notifications.
pub fn notifies(setting: &Value) -> bool {
    watch_groups(setting).iter().any(|g| g.notify)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    /// The shared fixture also checked by `web/tests/watch-match-parity.test.mjs`.
    #[test]
    fn shared_fixture_matches_the_javascript_rules() {
        let fixture: Value = serde_json::from_str(include_str!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../../web/tests/fixtures/watch-match.json"
        )))
        .unwrap();
        let rows = fixture["grouped_listings"].as_array().unwrap();
        let cases = fixture["cases"].as_array().unwrap();
        assert!(cases.len() >= 15);
        for case in cases {
            let reference = Reference {
                rows,
                percentiles: case
                    .get("percentile_caps")
                    .unwrap_or(&fixture["percentile_caps"]),
                base_stats: &fixture["base_stats"],
            };
            let item = case["item_id"].as_i64().unwrap();
            let found: Vec<&str> = notify_selection(rows, item, &case["setting"], &reference)
                .into_iter()
                .map(|row| row["id"].as_str().unwrap())
                .collect();
            let expected: Vec<&str> = case["expected"]
                .as_array()
                .unwrap()
                .iter()
                .map(|id| id.as_str().unwrap())
                .collect();
            assert_eq!(found, expected, "{}", case["name"]);
            assert_eq!(
                notifies(&case["setting"]),
                case["notifies"].as_bool().unwrap(),
                "{}",
                case["name"]
            );
        }
    }

    #[test]
    fn reminder_normalization_follows_javascript_coercions() {
        let r = normalize_reminder(&json!({"percentile": 25, "minPrice": "  ", "minStock": 2.7,
            "minUpgrades": 9, "maxUpgrades": 3, "stats": [{"stat":"str","min":4},{"stat":"str","min":null},{"stat":"bad","min":9}]}));
        assert_eq!(r.percentile, Some("25"));
        assert_eq!(r.min_price, None);
        assert_eq!(r.min_stock, Some(2.0));
        assert_eq!((r.min_upgrades, r.max_upgrades), (Some(3.0), Some(9.0)));
        assert_eq!(
            r.stats,
            vec![StatFloor {
                stat: "str",
                min: Some(4.0)
            }]
        );
        let legacy = normalize_reminder(&json!({"stat": "dex", "minStat": 70000}));
        assert_eq!(
            legacy.stats,
            vec![StatFloor {
                stat: "dex",
                min: None
            }]
        );
        assert_eq!(
            normalize_reminder(&json!({"percentile": "75"})).percentile,
            None
        );
        assert_eq!(nonnegative(Some(&json!(-1))), None);
        assert_eq!(nonnegative(Some(&json!(true))), Some(1.0));
    }
}

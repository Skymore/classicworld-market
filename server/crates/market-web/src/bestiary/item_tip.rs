//! The game tooltip of use, etc, set-up and cash items: the catalogue's
//! Chinese description (DVG) plus what the Classic World client says —
//! English description and the `info` / `spec` fields (success rate, stats,
//! recovery, duration, stack size, trade flags). `item-tips.json` is written
//! by `tools/export_item_tips.cs` from the client's Item.wz and String.wz.

use std::{collections::HashMap, sync::OnceLock};

use serde_json::{json, Value};

fn client() -> &'static HashMap<i64, Value> {
    static TIPS: OnceLock<HashMap<i64, Value>> = OnceLock::new();
    TIPS.get_or_init(|| {
        let rows: Vec<Value> =
            serde_json::from_str(include_str!("item-tips.json")).expect("item-tips.json parses");
        rows.into_iter()
            .filter_map(|row| Some((row["id"].as_i64()?, row)))
            .collect()
    })
}

/// None for equipment, and for items neither source describes.
pub fn item_tip(id: i32, record: Option<&Value>) -> Option<Value> {
    if id < 2_000_000 {
        return None;
    }
    let client = client().get(&i64::from(id));
    let desc_zh = record
        .and_then(|r| r["description_zh"].as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty());
    if client.is_none() && desc_zh.is_none() {
        return None;
    }
    let field = |key: &str| client.and_then(|c| c.get(key)).cloned();
    Some(json!({
        "desc_zh": desc_zh,
        "desc_en": field("desc"),
        "info": field("info"),
        "spec": field("spec"),
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn client_fields_and_catalogue_description() {
        let record = json!({"description_zh": "可提升头盔的命中率。\n成功率：100%，命中率+1"});
        let tip = item_tip(2040000, Some(&record)).unwrap();
        assert_eq!(tip["info"]["success"], 100);
        assert_eq!(tip["info"]["incACC"], 1);
        assert!(tip["desc_en"].as_str().unwrap().contains("Accuracy +1"));
        assert!(tip["desc_zh"].as_str().unwrap().starts_with("可提升"));
        let potion = item_tip(2000001, None).unwrap();
        assert_eq!(potion["spec"]["hp"], 250);
        assert!(potion["desc_zh"].is_null());
        assert!(item_tip(1302000, Some(&record)).is_none());
        assert!(item_tip(2999999, None).is_none());
        assert!(client().len() > 1000);
    }
}

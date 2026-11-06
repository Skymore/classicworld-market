//! The game tooltip of use, etc, set-up and cash items, all from the Classic
//! World client: its English description and the `info` / `spec` fields
//! (success rate, stats, recovery, duration, stack size, trade flags), and
//! our Chinese translation of that description. `item-tips.json` is written
//! by `tools/export_item_tips.cs` from the client's Item.wz and String.wz;
//! `item-tips-zh.json` maps each English description to its translation
//! (numbers kept as the client has them).

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

fn chinese() -> &'static HashMap<String, String> {
    static ZH: OnceLock<HashMap<String, String>> = OnceLock::new();
    ZH.get_or_init(|| {
        serde_json::from_str(include_str!("item-tips-zh.json")).expect("item-tips-zh.json parses")
    })
}

/// None for equipment and for items the client does not have.
pub fn item_tip(id: i32) -> Option<Value> {
    if id < 2_000_000 {
        return None;
    }
    let client = client().get(&i64::from(id))?;
    let desc = client.get("desc").and_then(Value::as_str);
    Some(json!({
        "desc_zh": desc.and_then(|d| chinese().get(d)),
        "desc_en": desc,
        "info": client.get("info"),
        "spec": client.get("spec"),
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn client_fields_and_translation() {
        let tip = item_tip(2040000).unwrap();
        assert_eq!(tip["info"]["success"], 100);
        assert_eq!(tip["info"]["incACC"], 1);
        assert!(tip["desc_en"].as_str().unwrap().contains("Accuracy +1"));
        assert_eq!(tip["desc_zh"], "提升头盔的命中率。\n成功率：100%，命中率+1");
        // Classic World's numbers, not another version's.
        let elixir = item_tip(2000004).unwrap();
        assert_eq!(elixir["spec"]["hpR"], 35);
        assert!(elixir["desc_zh"].as_str().unwrap().contains("35%"));
        assert!(item_tip(1302000).is_none());
        assert!(item_tip(2999999).is_none());
    }

    #[test]
    fn every_description_is_translated() {
        let missing: Vec<_> = client()
            .values()
            .filter_map(|c| c["desc"].as_str())
            .filter(|d| !chinese().contains_key(*d))
            .collect();
        assert!(missing.is_empty(), "untranslated: {missing:?}");
    }
}

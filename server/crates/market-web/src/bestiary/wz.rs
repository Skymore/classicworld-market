//! Portals from the client's Map.wz, via the JSON `market_map_resources.py`
//! writes (`--wz Map.wz --map-id N --output N.json`, one map per file; a
//! file may also hold an array of such objects). Map.wz is not on the build
//! machine, so this has only been run on synthetic files.

use std::collections::BTreeSet;

use anyhow::{Context, Result};
use serde::Deserialize;
use serde_json::json;
use sqlx::PgPool;

use super::import::{insert_json, record_version, PORTAL_COLUMNS};
use super::rows::PortalRow;

/// WZ `tm` for a portal that leads nowhere (spawn points, scripted portals).
pub const NO_TARGET: i64 = 999_999_999;

#[derive(Debug, Deserialize)]
pub struct WzMap {
    pub map_id: i32,
    pub wz_version: Option<i64>,
    #[serde(default)]
    pub portals: Vec<WzPortal>,
}

#[derive(Debug, Deserialize)]
pub struct WzPortal {
    pub pn: Option<String>,
    pub tm: Option<i64>,
    pub tn: Option<String>,
    pub x: Option<i64>,
    pub y: Option<i64>,
}

#[derive(Debug, Deserialize)]
#[serde(untagged)]
enum OneOrMany {
    One(WzMap),
    Many(Vec<WzMap>),
}

/// Parses one output file of `market_map_resources.py`.
pub fn parse(json: &str) -> Result<Vec<WzMap>> {
    Ok(
        match serde_json::from_str(json).context("parsing map resource JSON")? {
            OneOrMany::One(map) => vec![map],
            OneOrMany::Many(maps) => maps,
        },
    )
}

#[derive(Debug, Default)]
pub struct WzPortals {
    /// Maps whose portals the import replaces.
    pub map_ids: Vec<i32>,
    pub portals: Vec<PortalRow>,
    pub wz_version: Option<i64>,
}

/// Keeps portals that lead to another map.
pub fn portals_from(maps: &[WzMap]) -> WzPortals {
    let mut map_ids = BTreeSet::new();
    let mut out = WzPortals::default();
    for map in maps {
        map_ids.insert(map.map_id);
        out.wz_version = out.wz_version.or(map.wz_version);
        for portal in &map.portals {
            let Some(to) = portal.tm.filter(|&tm| tm != NO_TARGET) else {
                continue;
            };
            let Ok(to) = i32::try_from(to) else { continue };
            if to == map.map_id {
                continue;
            }
            out.portals.push(PortalRow {
                from_map_id: map.map_id,
                to_map_id: to,
                kind: "portal",
                portal_name: portal.pn.clone().filter(|s| !s.is_empty()),
                target_portal: portal.tn.clone().filter(|s| !s.is_empty()),
                x: portal.x.and_then(|v| i32::try_from(v).ok()),
                y: portal.y.and_then(|v| i32::try_from(v).ok()),
                source: "wz",
            });
        }
    }
    out.map_ids = map_ids.into_iter().collect();
    out
}

/// Replaces the WZ portals of the maps in `wz`; other maps keep theirs.
pub async fn import(pool: &PgPool, wz: &WzPortals, source: &str) -> Result<u64> {
    let mut tx = pool.begin().await?;
    sqlx::query("DELETE FROM map_portals WHERE source = 'wz' AND from_map_id = ANY($1)")
        .bind(&wz.map_ids)
        .execute(&mut *tx)
        .await
        .context("deleting old WZ portals")?;
    let inserted = insert_json(&mut tx, "map_portals", PORTAL_COLUMNS, &wz.portals).await?;
    let version = wz
        .wz_version
        .map_or_else(|| "unknown".to_string(), |v| format!("wz-{v}"));
    record_version(
        &mut tx,
        "wz_portals",
        &version,
        source,
        json!({ "maps": wz.map_ids.len(), "portals": inserted }),
    )
    .await?;
    tx.commit().await?;
    Ok(inserted)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keeps_portals_to_other_maps() {
        let maps = parse(
            r#"{"map_id": 10001000, "wz_version": 83, "footholds": [], "portals": [
                {"pn": "sp", "pt": 0, "x": 0, "y": 0, "tm": 999999999, "tn": ""},
                {"pn": "east00", "pt": 2, "x": 1200, "y": 300, "tm": 10001010, "tn": "west00"},
                {"pn": "in00", "pt": 2, "x": 10, "y": 5, "tm": 10001000, "tn": "out00"}
            ]}"#,
        )
        .unwrap();
        let wz = portals_from(&maps);
        assert_eq!(wz.map_ids, vec![10001000]);
        assert_eq!(wz.wz_version, Some(83));
        assert_eq!(wz.portals.len(), 1);
        let p = &wz.portals[0];
        assert_eq!(
            (p.from_map_id, p.to_map_id, p.kind),
            (10001000, 10001010, "portal")
        );
        assert_eq!(p.portal_name.as_deref(), Some("east00"));
        assert_eq!(p.target_portal.as_deref(), Some("west00"));
    }

    #[test]
    fn accepts_an_array_of_maps() {
        let maps = parse(r#"[{"map_id": 1, "portals": []}, {"map_id": 2}]"#).unwrap();
        assert_eq!(portals_from(&maps).map_ids, vec![1, 2]);
    }
}

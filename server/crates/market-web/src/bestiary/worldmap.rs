//! The world map and the rendered map scenes, from the files
//! `tools/niadb_map_assets.py` saves in the NiaDB directory:
//!
//! - `worldmap-spots.json` (NiaDB `/_data/worldmap-spots.json`): each region of
//!   the client's world map with its spots (position on the region picture,
//!   marker type, the map it is named after).
//! - `worldmap-previews.json` (`/_data/worldmap-previews.json`): the maps each
//!   spot covers.
//! - `worldmap-images.json`: each region's picture under `web/images/worldmap/`
//!   and its size.
//! - `scenes.json`: each map's scene picture under `web/images/scenes/` and the
//!   world rectangle it covers.
//!
//! All four are optional: without them the import has no world map and the
//! map view keeps the minimap.

use std::collections::{BTreeMap, HashSet};
use std::path::Path;

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};

use super::mapledex::{nia_id, Dataset};
use super::rows::{WorldRegionRow, WorldSpotMapRow, WorldSpotRow};

#[derive(Deserialize)]
struct Spots {
    regions: Vec<Region>,
}

#[derive(Deserialize)]
struct Region {
    id: String,
    order: i16,
    #[serde(default)]
    spots: Vec<Spot>,
}

#[derive(Deserialize)]
struct Spot {
    key: String,
    x: i32,
    y: i32,
    #[serde(rename = "type")]
    kind: i16,
    title: Option<String>,
    #[serde(rename = "mapId")]
    map_id: Option<String>,
}

#[derive(Deserialize)]
struct Previews {
    spots: BTreeMap<String, Vec<PreviewMap>>,
}

#[derive(Deserialize)]
struct PreviewMap {
    id: String,
}

#[derive(Deserialize)]
struct Images {
    regions: BTreeMap<String, Image>,
}

#[derive(Deserialize)]
struct Image {
    image: String,
    width: i32,
    height: i32,
}

#[derive(Deserialize)]
struct Scenes {
    maps: BTreeMap<i32, Scene>,
}

#[derive(Deserialize)]
struct Scene {
    x: i32,
    y: i32,
    w: i32,
    h: i32,
}

/// What `add_map_pictures_dir` added.
#[derive(Debug, Default, Clone, PartialEq, Eq, Serialize)]
pub struct MapPictureCounts {
    pub world_regions: usize,
    pub world_spots: usize,
    /// (spot, map) pairs.
    pub world_spot_maps: usize,
    /// Maps with a scene picture.
    pub scenes: usize,
    /// Of those, maps without a minimap whose view box is the scene's.
    pub scene_boxes: usize,
}

fn read_optional(dir: &Path, name: &str) -> Result<Option<String>> {
    let path = dir.join(name);
    if !path.exists() {
        return Ok(None);
    }
    std::fs::read_to_string(&path)
        .map(Some)
        .with_context(|| format!("reading {}", path.display()))
}

impl Dataset {
    /// The world map and the map scenes from a NiaDB directory. Call after
    /// the maps are final (`add_niadb_bestiary`): spots and scenes of maps not
    /// in the bestiary are left out.
    pub fn add_map_pictures_dir(&mut self, dir: &Path) -> Result<MapPictureCounts> {
        let mut counts = MapPictureCounts::default();
        if let (Some(spots), Some(previews), Some(images)) = (
            read_optional(dir, "worldmap-spots.json")?,
            read_optional(dir, "worldmap-previews.json")?,
            read_optional(dir, "worldmap-images.json")?,
        ) {
            self.add_world_map(&spots, &previews, &images, &mut counts)?;
        }
        if let Some(scenes) = read_optional(dir, "scenes.json")? {
            self.add_scenes(&scenes, &mut counts)?;
        }
        Ok(counts)
    }

    fn add_world_map(
        &mut self,
        spots: &str,
        previews: &str,
        images: &str,
        counts: &mut MapPictureCounts,
    ) -> Result<()> {
        let spots: Spots = serde_json::from_str(spots).context("parsing worldmap-spots.json")?;
        let previews: Previews =
            serde_json::from_str(previews).context("parsing worldmap-previews.json")?;
        let images: Images =
            serde_json::from_str(images).context("parsing worldmap-images.json")?;
        let maps: HashSet<i32> = self.maps.iter().map(|m| m.id).collect();
        self.world_regions.clear();
        self.world_spots.clear();
        self.world_spot_maps.clear();
        for region in &spots.regions {
            let Some(image) = images.regions.get(&region.id) else {
                self.warnings
                    .push(format!("world map region {} has no picture", region.id));
                continue;
            };
            self.world_regions.push(WorldRegionRow {
                id: region.id.clone(),
                ord: region.order,
                image_url: image.image.clone(),
                width: image.width,
                height: image.height,
            });
            for (ord, spot) in region.spots.iter().enumerate() {
                let Some(map_id) = spot
                    .map_id
                    .as_deref()
                    .and_then(nia_id)
                    .filter(|id| maps.contains(id))
                else {
                    continue; // a spot for a map the bestiary does not have
                };
                if !(0..=4).contains(&spot.kind) {
                    self.warnings.push(format!(
                        "world map spot {}: marker type {}",
                        spot.key, spot.kind
                    ));
                    continue;
                }
                let covered: Vec<i32> = previews
                    .spots
                    .get(&spot.key)
                    .into_iter()
                    .flatten()
                    .filter_map(|m| nia_id(&m.id))
                    .filter(|id| maps.contains(id))
                    .chain(std::iter::once(map_id))
                    .collect::<std::collections::BTreeSet<_>>()
                    .into_iter()
                    .collect();
                for id in covered {
                    self.world_spot_maps.push(WorldSpotMapRow {
                        spot_key: spot.key.clone(),
                        map_id: id,
                    });
                }
                self.world_spots.push(WorldSpotRow {
                    key: spot.key.clone(),
                    region_id: region.id.clone(),
                    ord: i16::try_from(ord).unwrap_or(i16::MAX),
                    x: spot.x,
                    y: spot.y,
                    kind: spot.kind,
                    title_en: spot.title.clone().unwrap_or_default().trim().to_string(),
                    map_id,
                });
            }
        }
        counts.world_regions = self.world_regions.len();
        counts.world_spots = self.world_spots.len();
        counts.world_spot_maps = self.world_spot_maps.len();
        Ok(())
    }

    fn add_scenes(&mut self, scenes: &str, counts: &mut MapPictureCounts) -> Result<()> {
        let scenes: Scenes = serde_json::from_str(scenes).context("parsing scenes.json")?;
        for map in &mut self.maps {
            let Some(scene) = scenes.maps.get(&map.id).filter(|s| s.w > 0 && s.h > 0) else {
                continue;
            };
            // Shops and houses have no minimap; the scene gives the box.
            if map.minimap_w.is_none() {
                map.minimap_w = Some(scene.w);
                map.minimap_h = Some(scene.h);
                map.minimap_cx = Some(-scene.x);
                map.minimap_cy = Some(-scene.y);
                counts.scene_boxes += 1;
            }
            map.scene_url = Some(format!("/web/images/scenes/{}.webp", map.id));
            map.scene_x = Some(scene.x);
            map.scene_y = Some(scene.y);
            map.scene_w = Some(scene.w);
            map.scene_h = Some(scene.h);
            counts.scenes += 1;
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::bestiary::rows::MapRow;

    fn map(id: i32) -> MapRow {
        MapRow {
            id,
            gms_id: None,
            name_en: format!("map {id}"),
            name_zh: None,
            name_tw: None,
            street_en: None,
            street_zh: None,
            street_tw: None,
            description: None,
            is_town: false,
            return_map_id: None,
            mob_rate: None,
            bgm: None,
            minimap_url: None,
            unreleased: false,
            minimap_w: None,
            minimap_h: None,
            minimap_cx: None,
            minimap_cy: None,
            spawn_x: None,
            spawn_y: None,
            scene_url: None,
            scene_x: None,
            scene_y: None,
            scene_w: None,
            scene_h: None,
        }
    }

    #[test]
    fn spots_cover_their_maps_and_skip_unknown_ones() {
        let mut data = Dataset {
            maps: vec![map(10001000), map(10001001)],
            ..Dataset::default()
        };
        let mut counts = MapPictureCounts::default();
        data.add_world_map(
            r#"{"regions": [{"id": "VictoriaIsland", "order": 1, "spots": [
                {"key": "W:0", "x": 10, "y": 20, "type": 0, "title": "Henesys", "mapId": "010001000"},
                {"key": "W:1", "x": 30, "y": 40, "type": 3, "title": "Gone", "mapId": "099999999"}]}]}"#,
            r#"{"spots": {"W:0": [{"id": "010001000"}, {"id": "010001001"}, {"id": "010001002"}]}}"#,
            r#"{"regions": {"VictoriaIsland": {"image": "/web/images/worldmap/victoria-island.webp", "width": 636, "height": 466}}}"#,
            &mut counts,
        )
        .unwrap();
        assert_eq!(
            (
                counts.world_regions,
                counts.world_spots,
                counts.world_spot_maps
            ),
            (1, 1, 2)
        );
        assert_eq!(data.world_spots[0].map_id, 10001000);
        assert_eq!(
            data.world_spot_maps
                .iter()
                .map(|m| m.map_id)
                .collect::<Vec<_>>(),
            vec![10001000, 10001001]
        );
        data.add_scenes(
            r#"{"maps": {"10001000": {"key": "k", "x": -568, "y": -545, "w": 6896, "h": 1189}}}"#,
            &mut counts,
        )
        .unwrap();
        assert_eq!(counts.scenes, 1);
        assert_eq!(
            data.maps[0].scene_url.as_deref(),
            Some("/web/images/scenes/10001000.webp")
        );
        assert_eq!(
            (data.maps[0].scene_x, data.maps[0].scene_w),
            (Some(-568), Some(6896))
        );
        assert!(data.maps[1].scene_url.is_none());
        assert_eq!(
            data.maps[0].minimap_cx,
            Some(568),
            "no minimap: the scene is the box"
        );
        assert_eq!(counts.scene_boxes, 1);
    }
}

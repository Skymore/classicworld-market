//! Game data that `/route` and `/search` rebuilt on every request: the
//! portal graphs, the search area list, the hints for maps that share a
//! name and the map list's world map. Kept until `catalog_versions`
//! changes; every import records its version in the same transaction, so a
//! new import shows on the next request without a restart.

use std::collections::HashMap;
use std::sync::Arc;

use sqlx::PgPool;
use tokio::sync::Mutex;

use crate::bestiary::{
    model::{AreaChoice, MapHint, WorldRegion},
    queries,
    route::{EdgeKind, Graph},
};

/// Row count and newest import time: re-importing the same version moves
/// `imported_at`, a new version adds a row.
type Stamp = (i64, Option<i64>);

async fn stamp(db: &PgPool) -> sqlx::Result<Stamp> {
    sqlx::query_as(
        "SELECT count(*), (extract(epoch FROM max(imported_at)) * 1000000)::bigint FROM catalog_versions",
    )
    .fetch_one(db)
    .await
}

/// Map id to what tells it apart from open maps of the same name.
pub type MapHints = HashMap<i32, MapHint>;

pub struct Routes {
    /// Every edge, the taxi included (`taxi=1`).
    pub all: Graph,
    /// Walking, scrolls and the ship.
    pub without_taxi: Graph,
}

/// The map list's world map: the regions with their spots, and the spot of
/// each open map that is on one (`queries::main_spots`).
pub struct WorldMap {
    pub regions: Vec<WorldRegion>,
    pub spot_of: HashMap<i32, String>,
}

impl WorldMap {
    /// The region (`world_regions.id`) the spot is in.
    pub fn region_of(&self, spot: &str) -> Option<&str> {
        self.regions
            .iter()
            .find(|r| r.spots.iter().any(|s| s.key == spot))
            .map(|r| r.id.as_str())
    }
}

#[derive(Default)]
pub struct CatalogCache {
    routes: Mutex<Option<(Stamp, Arc<Routes>)>>,
    areas: Mutex<Option<(Stamp, Arc<Vec<AreaChoice>>)>>,
    hints: Mutex<Option<(Stamp, Arc<MapHints>)>>,
    world: Mutex<Option<(Stamp, Arc<WorldMap>)>>,
}

impl CatalogCache {
    pub async fn routes(&self, db: &PgPool) -> sqlx::Result<Arc<Routes>> {
        // The stamp is read under the lock and before the data, so a waiter
        // never stores older data under a newer stamp.
        let mut slot = self.routes.lock().await;
        let current = stamp(db).await?;
        if let Some((cached, routes)) = slot.as_ref() {
            if *cached == current {
                return Ok(routes.clone());
            }
        }
        let edges = queries::load_edges(db).await?;
        let without_taxi = Graph::new(edges.iter().filter(|e| e.kind != EdgeKind::Taxi).cloned());
        let routes = Arc::new(Routes {
            all: Graph::new(edges),
            without_taxi,
        });
        *slot = Some((current, routes.clone()));
        Ok(routes)
    }

    pub async fn search_areas(&self, db: &PgPool) -> sqlx::Result<Arc<Vec<AreaChoice>>> {
        let mut slot = self.areas.lock().await;
        let current = stamp(db).await?;
        if let Some((cached, areas)) = slot.as_ref() {
            if *cached == current {
                return Ok(areas.clone());
            }
        }
        let areas = Arc::new(queries::search_areas(db).await?);
        *slot = Some((current, areas.clone()));
        Ok(areas)
    }

    /// `queries::map_hints`: what tells apart open maps of the same name.
    pub async fn map_hints(&self, db: &PgPool) -> sqlx::Result<Arc<MapHints>> {
        let mut slot = self.hints.lock().await;
        let current = stamp(db).await?;
        if let Some((cached, hints)) = slot.as_ref() {
            if *cached == current {
                return Ok(hints.clone());
            }
        }
        let hints = Arc::new(queries::map_hints(db).await?);
        *slot = Some((current, hints.clone()));
        Ok(hints)
    }

    pub async fn world(&self, db: &PgPool) -> sqlx::Result<Arc<WorldMap>> {
        let mut slot = self.world.lock().await;
        let current = stamp(db).await?;
        if let Some((cached, world)) = slot.as_ref() {
            if *cached == current {
                return Ok(world.clone());
            }
        }
        let world = Arc::new(WorldMap {
            regions: queries::world_page(db, None).await?.regions,
            spot_of: queries::main_spots(db).await?,
        });
        *slot = Some((current, world.clone()));
        Ok(world)
    }
}

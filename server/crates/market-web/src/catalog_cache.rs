//! Game data that `/route` and `/search` rebuilt on every request: the
//! portal graphs, the search area list and the hints for maps that share a
//! name. Kept until `catalog_versions`
//! changes; every import records its version in the same transaction, so a
//! new import shows on the next request without a restart.

use std::collections::HashMap;
use std::sync::Arc;

use sqlx::PgPool;
use tokio::sync::Mutex;

use crate::bestiary::{
    model::{AreaChoice, MapHint},
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

pub struct Routes {
    /// Every edge, the taxi included (`taxi=1`).
    pub all: Graph,
    /// Walking, scrolls and the ship.
    pub without_taxi: Graph,
}

#[derive(Default)]
pub struct CatalogCache {
    routes: Mutex<Option<(Stamp, Arc<Routes>)>>,
    areas: Mutex<Option<(Stamp, Arc<Vec<AreaChoice>>)>>,
    hints: Mutex<Option<(Stamp, Arc<HashMap<i32, MapHint>>)>>,
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
    pub async fn map_hints(&self, db: &PgPool) -> sqlx::Result<Arc<HashMap<i32, MapHint>>> {
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
}

//! Writes the catalogue and the bestiary dataset to Postgres in one
//! transaction. Re-running replaces the bestiary rows, upserts items and
//! records the versions again, so the same input always leaves the same tables.

use anyhow::{Context, Result};
use serde::Serialize;
use serde_json::json;
use sqlx::{PgConnection, PgPool};

use super::catalog::{Catalog, ItemReferences};
use super::mapledex::{Dataset, DvgMobCounts, NiaBestiaryCounts, ZhNameCounts};

/// Where the data came from, for `catalog_versions`.
pub struct Sources<'a> {
    pub items_path: &'a str,
    pub mapledex_path: &'a str,
    pub mapledex_version: &'a str,
}

/// NiaDB's directory and fetch date, for `catalog_versions`.
pub struct NiaDbSource<'a> {
    pub path: &'a str,
    pub version: &'a str,
    /// What its monsters, maps and drops changed, when they were applied.
    pub bestiary: Option<&'a NiaBestiaryCounts>,
}

/// The zh-names file `data` was filled from, for `catalog_versions`.
pub struct ZhNamesSource<'a> {
    pub path: &'a str,
    pub version: &'a str,
    pub counts: &'a ZhNameCounts,
}

/// DVG's mob list `data` took simplified mob names from, for `catalog_versions`.
pub struct DvgMobsSource<'a> {
    pub path: &'a str,
    pub version: &'a str,
    pub counts: &'a DvgMobCounts,
}

/// One full import: `catalog` already extended by `references`, and `data`
/// with the NiaDB additions, the zh names and resolved drops.
pub struct Input<'a> {
    pub catalog: &'a Catalog,
    pub references: &'a ItemReferences,
    pub data: &'a Dataset,
    pub sources: &'a Sources<'a>,
    pub niadb: Option<NiaDbSource<'a>>,
    pub zh_names: Option<ZhNamesSource<'a>>,
    pub dvg_mobs: Option<DvgMobsSource<'a>>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ImportSummary {
    pub items: u64,
    pub mobs: u64,
    /// Mobs and maps that are not open yet (kept, never shown).
    pub mobs_unreleased: i64,
    pub maps: u64,
    pub maps_unreleased: i64,
    /// Maps with a simplified name.
    pub maps_zh: i64,
    pub spawns: u64,
    pub drops: u64,
    /// Drops whose item is in `items` (and so gets a page).
    pub drops_in_catalog: i64,
    pub drops_meso: i64,
    /// Drops with a Classic World item id.
    pub drops_with_item_id: i64,
    /// Drops with a name of their own (from the item, or Mapledex's GMS name).
    pub drops_named: i64,
    pub npcs: u64,
    pub npcs_unreleased: i64,
    pub npcs_named: i64,
    /// NPCs with a simplified name.
    pub npcs_zh: i64,
    pub npc_placements: u64,
    pub npc_shops: u64,
    pub portals: u64,
}

/// items.sqlite plus the Mapledex bestiary, as R3 imported it.
pub async fn import_catalog(
    pool: &PgPool,
    catalog: &Catalog,
    data: &Dataset,
    sources: &Sources<'_>,
) -> Result<ImportSummary> {
    let references = ItemReferences::default();
    import(
        pool,
        &Input {
            catalog,
            references: &references,
            data,
            sources,
            niadb: None,
            zh_names: None,
            dvg_mobs: None,
        },
    )
    .await
}

pub async fn import(pool: &PgPool, input: &Input<'_>) -> Result<ImportSummary> {
    let data = input.data;
    let mut tx = pool.begin().await?;
    let items = upsert_items(&mut tx, input.catalog, input.references).await?;

    // Children go with their parents (ON DELETE CASCADE). Items are never
    // deleted: market rows reference them.
    for sql in [
        "DELETE FROM map_portals WHERE source IN ('mapledex', 'niadb')",
        "DELETE FROM npcs",
        "DELETE FROM mobs",
        "DELETE FROM maps",
    ] {
        sqlx::query(sql).execute(&mut *tx).await.context(sql)?;
    }

    let mobs = insert_json(&mut tx, "mobs", MOB_COLUMNS, &data.mobs).await?;
    let maps = insert_json(&mut tx, "maps", MAP_COLUMNS, &data.maps).await?;
    let spawns = insert_json(
        &mut tx,
        "mob_spawns",
        "map_id, mob_id, spawn_count",
        &data.spawns,
    )
    .await?;
    let drops = insert_json(&mut tx, "drops", DROP_COLUMNS, &data.drops).await?;
    let npcs = insert_json(
        &mut tx,
        "npcs",
        "id, name_en, name_zh, name_tw, unreleased",
        &data.npcs,
    )
    .await?;
    let npc_placements = insert_json(&mut tx, "map_npcs", "map_id, npc_id", &data.map_npcs).await?;
    let npc_shops = insert_json(
        &mut tx,
        "npc_shops",
        "npc_id, item_id, price, source",
        &data.npc_shops,
    )
    .await?;
    let portals = insert_json(&mut tx, "map_portals", PORTAL_COLUMNS, &data.portals).await?;

    let (drops_in_catalog, drops_meso, drops_with_item_id, drops_named): (i64, i64, i64, i64) =
        sqlx::query_as(
            "SELECT count(*) FILTER (WHERE i.id IS NOT NULL), count(*) FILTER (WHERE d.meso_max IS NOT NULL),
                    count(*) FILTER (WHERE d.item_id IS NOT NULL),
                    count(*) FILTER (WHERE COALESCE(d.name_zh, d.name_tw, d.name_en) IS NOT NULL)
             FROM drops d LEFT JOIN items i ON i.id = d.item_id",
        )
        .fetch_one(&mut *tx)
        .await?;
    let (npcs_named, npcs_zh): (i64, i64) = sqlx::query_as(
        "SELECT count(*) FILTER (WHERE COALESCE(name_zh, name_tw, name_en) IS NOT NULL),
                count(*) FILTER (WHERE name_zh IS NOT NULL)
         FROM npcs",
    )
    .fetch_one(&mut *tx)
    .await?;
    let maps_zh: i64 = sqlx::query_scalar("SELECT count(*) FROM maps WHERE name_zh IS NOT NULL")
        .fetch_one(&mut *tx)
        .await?;
    let (mobs_unreleased, maps_unreleased, npcs_unreleased): (i64, i64, i64) = sqlx::query_as(
        "SELECT (SELECT count(*) FROM mobs WHERE unreleased), (SELECT count(*) FROM maps WHERE unreleased),
                (SELECT count(*) FROM npcs WHERE unreleased)",
    )
    .fetch_one(&mut *tx)
    .await?;

    let summary = ImportSummary {
        items,
        mobs,
        mobs_unreleased,
        maps,
        maps_unreleased,
        maps_zh,
        spawns,
        drops,
        drops_in_catalog,
        drops_meso,
        drops_with_item_id,
        drops_named,
        npcs,
        npcs_unreleased,
        npcs_named,
        npcs_zh,
        npc_placements,
        npc_shops,
        portals,
    };
    let sources = input.sources;
    record_version(
        &mut tx,
        "items",
        &input.catalog.version,
        sources.items_path,
        json!({ "items": items }),
    )
    .await?;
    record_version(
        &mut tx,
        "mapledex",
        sources.mapledex_version,
        sources.mapledex_path,
        serde_json::to_value(&summary)?,
    )
    .await?;
    if let Some(niadb) = &input.niadb {
        record_version(
            &mut tx,
            "niadb",
            niadb.version,
            niadb.path,
            json!({
                "items": input.references.niadb_items,
                "npc_shops": npc_shops,
                "bestiary": niadb.bestiary,
            }),
        )
        .await?;
    }
    if let Some(dvg) = &input.dvg_mobs {
        record_version(
            &mut tx,
            "dvg-mobs",
            dvg.version,
            dvg.path,
            serde_json::to_value(dvg.counts)?,
        )
        .await?;
    }
    if let Some(zh) = &input.zh_names {
        record_version(
            &mut tx,
            "zh-names",
            zh.version,
            zh.path,
            serde_json::to_value(zh.counts)?,
        )
        .await?;
    }
    tx.commit().await?;
    Ok(summary)
}

async fn upsert_items(
    tx: &mut PgConnection,
    catalog: &Catalog,
    references: &ItemReferences,
) -> Result<u64> {
    if catalog.items.is_empty() {
        return Ok(0);
    }
    let result = sqlx::query(
        "INSERT INTO items (id, name_en, name_zh, name_tw, category, subcategory, req_level, req_job_mask,
                            icon_url, is_cash, gms_id)
         SELECT id, name_en, name_zh, name_tw, category, subcategory, req_level, req_job_mask, icon_url,
                is_cash, gms_id
         FROM jsonb_populate_recordset(NULL::items, $1::jsonb)
         ON CONFLICT (id) DO UPDATE SET
             name_en = EXCLUDED.name_en, name_zh = EXCLUDED.name_zh, name_tw = EXCLUDED.name_tw,
             category = EXCLUDED.category, subcategory = EXCLUDED.subcategory,
             req_level = EXCLUDED.req_level, req_job_mask = EXCLUDED.req_job_mask,
             icon_url = EXCLUDED.icon_url, is_cash = EXCLUDED.is_cash, gms_id = EXCLUDED.gms_id",
    )
    .bind(serde_json::to_string(&references.columns(catalog))?)
    .execute(&mut *tx)
    .await
    .context("upserting items")?;
    if !catalog.records.is_empty() {
        let records: Vec<serde_json::Value> = catalog
            .records
            .iter()
            .map(|(id, record)| serde_json::json!({ "id": id, "record": record }))
            .collect();
        sqlx::query(
            "INSERT INTO item_records (item_id, record)
             SELECT id, record FROM jsonb_to_recordset($1) AS x(id int, record jsonb)
             ON CONFLICT (item_id) DO UPDATE SET record = EXCLUDED.record",
        )
        .bind(serde_json::Value::Array(records))
        .execute(&mut *tx)
        .await
        .context("upserting item_records")?;
    }
    Ok(result.rows_affected())
}

const MOB_COLUMNS: &str = "id, gms_id, link_id, name_en, name_zh, name_tw, level, hp, mp, exp, \
    pad, pdd, mad, mdd, acc, eva, speed, is_boss, is_undead, description, drop_source, unreleased";
const MAP_COLUMNS: &str =
    "id, gms_id, name_en, name_zh, name_tw, street_en, street_zh, street_tw, \
    description, is_town, return_map_id, mob_rate, bgm, minimap_url, unreleased";
const DROP_COLUMNS: &str = "mob_id, ord, item_id, gms_item_id, name_en, name_zh, name_tw, \
    meso_min, meso_max, rate_pct, quest_id, source, upvotes, downvotes";
pub(crate) const PORTAL_COLUMNS: &str =
    "from_map_id, to_map_id, kind, portal_name, target_portal, x, y, source";

/// Inserts all rows with one statement. `table` and `columns` are constants
/// from this module, never user input.
pub(crate) async fn insert_json<T: Serialize>(
    tx: &mut PgConnection,
    table: &'static str,
    columns: &'static str,
    rows: &[T],
) -> Result<u64> {
    if rows.is_empty() {
        return Ok(0);
    }
    let sql = format!(
        "INSERT INTO {table} ({columns}) SELECT {columns} FROM jsonb_populate_recordset(NULL::{table}, $1::jsonb)"
    );
    let result = sqlx::query(&sql)
        .bind(serde_json::to_string(rows)?)
        .execute(&mut *tx)
        .await
        .with_context(|| format!("inserting {table}"))?;
    Ok(result.rows_affected())
}

pub(crate) async fn record_version(
    tx: &mut PgConnection,
    dataset: &str,
    version: &str,
    source: &str,
    counts: serde_json::Value,
) -> Result<()> {
    sqlx::query(
        "INSERT INTO catalog_versions (dataset, version, source, counts) VALUES ($1, $2, $3, $4::jsonb)
         ON CONFLICT (dataset, version) DO UPDATE
         SET source = EXCLUDED.source, counts = EXCLUDED.counts, imported_at = now()",
    )
    .bind(dataset)
    .bind(version)
    .bind(source)
    .bind(counts.to_string())
    .execute(&mut *tx)
    .await
    .with_context(|| format!("recording {dataset} version"))?;
    Ok(())
}

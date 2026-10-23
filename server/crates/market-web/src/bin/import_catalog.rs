//! Loads the item catalogue and the bestiary into Postgres: items.sqlite (the
//! market's items), Mapledex (items, equips, mobs, maps, NPCs), NiaDB
//! (items, the maps Mapledex lacks, NPC names, NPC shops) and zh-names.json
//! (simplified map and NPC names Mapledex lacks, from DVG or Mapledex's
//! traditional names). Idempotent: a re-run replaces the bestiary rows and
//! upserts items.
//!
//! ```sh
//! DATABASE_URL=postgres://... cargo run -p market-web --bin import_catalog -- \
//!     [--items ../data/fixture/items.sqlite] [--mapledex ../data/reference/mapledex] \
//!     [--mapledex-version "CW GMS_COT2_2026-08-11"] [--niadb ../data/reference/niadb] \
//!     [--niadb-version "fetched 2026-10-21"] [--zh-names ../data/reference/zh-names.json]
//! ```

use std::path::Path;

use anyhow::Result;
use market_web::bestiary::{
    catalog::{self, ItemReferences},
    cli::{self, Args},
    import::{import, Input, NiaDbSource, Sources, ZhNamesSource},
    mapledex::{Dataset, ZhNames, DEFAULT_VERSION},
};

/// Date the files in data/reference/niadb were fetched; update on refetch.
const NIADB_VERSION: &str = "fetched 2026-10-21";

#[tokio::main]
async fn main() -> Result<()> {
    let args = Args::parse(
        std::env::args().skip(1),
        &[
            "items",
            "mapledex",
            "mapledex-version",
            "niadb",
            "niadb-version",
            "zh-names",
        ],
    )?;
    let items_path = args.get_or("items", "../data/fixture/items.sqlite");
    let mapledex_path = args.get_or("mapledex", "../data/reference/mapledex");
    let mapledex_version = args.get_or("mapledex-version", DEFAULT_VERSION);
    let niadb_path = args.get_or("niadb", "../data/reference/niadb");
    let niadb_version = args.get_or("niadb-version", NIADB_VERSION);
    let zh_names_path = args.get_or("zh-names", "../data/reference/zh-names.json");

    let mut catalog = catalog::read_sqlite(Path::new(items_path)).await?;
    let market_items = catalog.items.len();
    let references = ItemReferences::from_dirs(Path::new(mapledex_path), Path::new(niadb_path))?;
    let added = references.extend(&mut catalog);
    let mut data = Dataset::from_dir(Path::new(mapledex_path))?;
    let niadb = data.add_niadb_dir(Path::new(niadb_path))?;
    let zh_names = ZhNames::from_file(Path::new(zh_names_path))?;
    let zh = data.add_zh_names(&zh_names);
    let resolution = references.resolve_drops(&catalog, &mut data.drops);
    let warnings: Vec<&String> = catalog
        .warnings
        .iter()
        .chain(&references.warnings)
        .chain(&data.warnings)
        .collect();
    for warning in &warnings {
        eprintln!("warning: {warning}");
    }

    let db = cli::connect().await?;
    let sources = Sources {
        items_path,
        mapledex_path,
        mapledex_version,
    };
    let s = import(
        &db,
        &Input {
            catalog: &catalog,
            references: &references,
            data: &data,
            sources: &sources,
            niadb: Some(NiaDbSource {
                path: niadb_path,
                version: niadb_version,
            }),
            zh_names: Some(ZhNamesSource {
                path: zh_names_path,
                version: &zh_names.version,
                counts: &zh,
            }),
        },
    )
    .await?;
    println!(
        "items    {:>5}  upserted ({market_items} from items.sqlite {:?}, {added} more from \
         Mapledex {} / NiaDB {})",
        s.items, catalog.version, references.mapledex_items, references.niadb_items
    );
    println!("mobs     {:>5}", s.mobs);
    println!(
        "maps     {:>5}  ({} only in NiaDB; {} with a simplified name, {} from DVG, {} from \
         Mapledex traditional)",
        s.maps, niadb.maps, s.maps_zh, zh.maps.dvg, zh.maps.mapledex_tw
    );
    println!("spawns   {:>5}", s.spawns);
    println!(
        "drops    {:>5}  ({} with an item id, {} in the catalogue, {} meso, {} named)",
        s.drops, s.drops_with_item_id, s.drops_in_catalog, s.drops_meso, s.drops_named
    );
    println!(
        "         GMS-only drops: {} resolved by GMS id, {} by name, {} left (no Classic World item)",
        resolution.by_gms_id, resolution.by_name, resolution.unresolved
    );
    println!(
        "npcs     {:>5}  ({} named, {} from NiaDB; {} with a simplified name, {} from DVG, {} \
         from Mapledex traditional; {} map placements)",
        s.npcs,
        s.npcs_named,
        niadb.npc_names,
        s.npcs_zh,
        zh.npcs.dvg,
        zh.npcs.mapledex_tw,
        s.npc_placements
    );
    println!("shops    {:>5}  NPC shop rows from NiaDB", s.npc_shops);
    println!(
        "portals  {:>5}  (return links: Mapledex, {} from NiaDB)",
        s.portals, niadb.return_links
    );
    println!(
        "mapledex {mapledex_version:?}; niadb {niadb_version:?}; zh-names {:?}; {} warnings",
        zh_names.version,
        warnings.len()
    );
    Ok(())
}

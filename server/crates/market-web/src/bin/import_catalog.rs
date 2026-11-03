//! Loads the item catalogue and the bestiary into Postgres: items.sqlite (the
//! market's items), Mapledex (items, equips, names of mobs, maps and NPCs),
//! NiaDB (items, NPC names and shops, and what exists in Classic World: maps,
//! spawns, mobs with launch stats, community-confirmed drops, unreleased
//! Orbis / El Nath content) and zh-names.json (simplified map, NPC, quest and
//! item names the other sources lack, from DVG, Mapledex's traditional names or
//! our translations). Idempotent: a re-run replaces the bestiary rows and
//! upserts items.
//!
//! ```sh
//! DATABASE_URL=postgres://... cargo run -p market-web --bin import_catalog -- \
//!     [--items ../data/fixture/items.sqlite] [--mapledex ../data/reference/mapledex] \
//!     [--mapledex-version "CW GMS_COT2_2026-08-11"] [--niadb ../data/reference/niadb] \
//!     [--niadb-version "fetched 2026-11-02"] [--zh-names ../data/reference/zh-names.json] \
//!     [--dvg ../data/reference/dvg]
//! ```

use std::path::Path;

use anyhow::Result;
use market_web::bestiary::{
    catalog::{self, ItemReferences},
    cli::{self, Args},
    import::{import, DvgSource, Input, NiaDbSource, Sources, ZhNamesSource},
    mapledex::{Dataset, DvgMobs, ZhNames, DEFAULT_VERSION},
    quests::DvgQuests,
};

/// Date the files in data/reference/niadb were fetched; update on refetch.
/// `monsters.json`, `maps.json` and `drops.json` come from `tools/niadb_bestiary.py`.
const NIADB_VERSION: &str = "fetched 2026-11-02";

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
            "dvg",
        ],
    )?;
    let items_path = args.get_or("items", "../data/fixture/items.sqlite");
    let mapledex_path = args.get_or("mapledex", "../data/reference/mapledex");
    let mapledex_version = args.get_or("mapledex-version", DEFAULT_VERSION);
    let niadb_path = args.get_or("niadb", "../data/reference/niadb");
    let niadb_version = args.get_or("niadb-version", NIADB_VERSION);
    let zh_names_path = args.get_or("zh-names", "../data/reference/zh-names.json");
    let dvg_path = args.get_or("dvg", "../data/reference/dvg");

    let mut catalog = catalog::read_sqlite(Path::new(items_path)).await?;
    let market_items = catalog.items.len();
    let references = ItemReferences::from_dirs(Path::new(mapledex_path), Path::new(niadb_path))?;
    let added = references.extend(&mut catalog);
    let niadb_stats = references.annotate_records(&mut catalog);
    let zh_names = ZhNames::from_file(Path::new(zh_names_path))?;
    let item_zh = zh_names.add_item_names(&mut catalog);
    let mut data = Dataset::from_dir(Path::new(mapledex_path))?;
    let (niadb, bestiary) =
        data.add_niadb_bestiary_dir(Path::new(niadb_path), chrono::Utc::now().date_naive())?;
    let today = chrono::Utc::now().date_naive();
    let dvg_mobs = DvgMobs::from_file(&Path::new(dvg_path).join("mob-list.json"))?;
    let dvg = data.add_dvg_mob_names(&dvg_mobs);
    let dvg_quests = DvgQuests::from_file(&Path::new(dvg_path).join("quest-list.json"))?;
    let quests = data.add_quests_from(Path::new(niadb_path), &dvg_quests, today)?;
    let mut zh = data.add_zh_names(&zh_names);
    zh.items = item_zh;
    // NiaDB drops carry Classic World ids; this fills their names from the items.
    references.resolve_drops(&catalog, &mut data.drops);
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
                bestiary: Some(&bestiary),
            }),
            zh_names: Some(ZhNamesSource {
                path: zh_names_path,
                version: &zh_names.version,
                counts: &zh,
            }),
            dvg: Some(DvgSource {
                path: dvg_path,
                version: &dvg_mobs.fetched,
                counts: serde_json::json!({ "mobs": &dvg, "quests": quests.named_zh }),
            }),
        },
    )
    .await?;
    println!(
        "items    {:>5}  upserted ({market_items} from items.sqlite {:?}, {added} more from \
         Mapledex {} / NiaDB {}; simplified names: {} from DVG, {} from Mapledex traditional, {} \
         translated)",
        s.items,
        catalog.version,
        references.mapledex_items,
        references.niadb_items,
        zh.items.dvg,
        zh.items.mapledex_tw,
        zh.items.translated
    );
    println!(
        "records  {:>5}  item records ({niadb_stats} with NiaDB equipment stats)",
        catalog.records.len()
    );
    println!(
        "mobs     {:>5}  NiaDB ({} not in Mapledex, {} replace a different Mapledex mob, {} \
         Mapledex-only dropped, {} unreleased; {} simplified names from DVG, {} of them renamed)",
        s.mobs,
        bestiary.mobs_added,
        bestiary.mobs_replaced,
        bestiary.mobs_removed,
        s.mobs_unreleased,
        dvg.named,
        dvg.renamed
    );
    println!(
        "maps     {:>5}  NiaDB ({} not in Mapledex, {} Mapledex-only dropped, {} unreleased; {} \
         with a simplified name, {} from DVG, {} from Mapledex traditional)",
        s.maps,
        niadb.maps,
        bestiary.maps_removed,
        s.maps_unreleased,
        s.maps_zh,
        zh.maps.dvg,
        zh.maps.mapledex_tw
    );
    println!(
        "spawns   {:>5}  NiaDB ({} spawn points with positions, for the map view)",
        s.spawns, s.spawn_points
    );
    println!("world    {:>5}  world map spots (NiaDB)", s.world_spots);
    println!(
        "drops    {:>5}  NiaDB: {} items with more up than down votes ({} in the catalogue; {} \
         reports left out), {} meso ranges ({} mobs whose reports NiaDB does not trust yet)",
        s.drops,
        bestiary.drops,
        s.drops_in_catalog,
        bestiary.drops_unconfirmed,
        s.drops_meso,
        bestiary.mesos_untrusted
    );
    println!(
        "npcs     {:>5}  ({} unreleased; {} named, {} from NiaDB; {} with a simplified name, {} \
         from DVG, {} from Mapledex traditional, {} translated; {} map placements)",
        s.npcs,
        s.npcs_unreleased,
        s.npcs_named,
        niadb.npc_names,
        s.npcs_zh,
        zh.npcs.dvg,
        zh.npcs.mapledex_tw,
        zh.npcs.translated,
        s.npc_placements
    );
    println!("shops    {:>5}  NPC shop rows from NiaDB", s.npc_shops);
    println!(
        "quests   {:>5}  NiaDB ({} unreleased; {} with a simplified name from DVG, {} from CMS, {} \
         translated, {} with an NPC; {} rewards, {} needs)",
        s.quests,
        s.quests_unreleased,
        quests.named_zh,
        zh.quests.cms,
        zh.quests.translated,
        quests.with_npc,
        s.quest_rewards,
        s.quest_needs
    );
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

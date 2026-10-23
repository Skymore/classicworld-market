//! Parsing the real Mapledex and NiaDB files, and the import round trip against Postgres.

#[path = "bestiary_common/mod.rs"]
mod common;

use std::path::{Path, PathBuf};

use axum::{
    body::Body,
    http::{header, Request, StatusCode},
};
use http_body_util::BodyExt;
use market_web::{
    app,
    bestiary::{
        catalog::{self, Catalog, DropResolution, ItemReferences},
        import::{
            import, import_catalog, ImportSummary, Input, NiaDbSource, Sources, ZhNamesSource,
        },
        mapledex::{Dataset, NiaDbCounts, ZhNameCounts, ZhNames, ZhSourceCounts},
        rows::ItemRow,
        wz,
    },
    AppState, Settings,
};
use tower::ServiceExt;

fn repo_data(path: &str) -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../../data")
        .join(path)
}

fn mapledex() -> Dataset {
    Dataset::from_dir(&repo_data("reference/mapledex")).expect("Mapledex files")
}

fn references() -> ItemReferences {
    ItemReferences::from_dirs(
        &repo_data("reference/mapledex"),
        &repo_data("reference/niadb"),
    )
    .expect("item lists")
}

fn item(id: i32, name_zh: &str, name_en: &str) -> ItemRow {
    ItemRow {
        id,
        name_en: name_en.into(),
        name_zh: Some(name_zh.into()),
        category: catalog::category_for(id).into(),
        subcategory: None,
        req_level: None,
        req_job_mask: None,
        icon_url: None,
        is_cash: false,
    }
}

fn catalog_of(items: Vec<ItemRow>) -> Catalog {
    Catalog {
        items,
        records: Vec::new(),
        version: "test".into(),
        warnings: Vec::new(),
    }
}

fn market_items() -> Vec<ItemRow> {
    vec![
        item(1002000, "褐色皮帽", "Brown Skullcap"),
        item(4000019, "蜗牛壳", "Snail Shell"),
    ]
}

const SOURCES: Sources<'static> = Sources {
    items_path: "test",
    mapledex_path: "data/reference/mapledex",
    mapledex_version: "CW GMS_COT2_2026-08-11",
};

#[test]
fn mapledex_counts() {
    let data = mapledex();
    assert_eq!(data.mobs.len(), 195);
    assert_eq!(data.maps.len(), 432);
    assert_eq!(data.drops.len(), 4575);
    assert_eq!(
        data.drops.iter().filter(|d| d.meso_max.is_some()).count(),
        142
    );
    assert_eq!(data.spawns.len(), 894);
    assert_eq!(data.npcs.len(), 266, "npcs.json adds 13 unplaced NPCs");
    assert!(
        data.npcs.iter().all(|n| n.name_en.is_some()),
        "npcs.json names every NPC"
    );
    assert_eq!(data.map_npcs.len(), 300);
    assert_eq!(
        data.portals.len(),
        393,
        "one return link per map with a listed return map"
    );
    assert!(data.warnings.is_empty(), "{:?}", data.warnings);

    let henesys = data.maps.iter().find(|m| m.id == 10001000).unwrap();
    assert_eq!(henesys.name_zh.as_deref(), Some("射手村"));
    assert!(henesys.is_town);
    assert!(
        data.maps
            .iter()
            .all(|m| !m.name_zh.as_deref().unwrap_or("").contains("&lt;")),
        "entities decoded"
    );
}

#[test]
fn niadb_fills_mapledex_gaps() {
    let mut data = mapledex();
    let counts = data
        .add_niadb_dir(&repo_data("reference/niadb"))
        .expect("NiaDB files");
    assert_eq!(
        counts,
        NiaDbCounts {
            maps: 12,
            spawns: 2,
            return_links: 11,
            npc_placements: 9,
            npc_names: 7,
            shop_rows: 877,
        }
    );
    assert_eq!(
        data.warnings,
        vec!["NiaDB map 10003111: unknown mob \"700006\"".to_string()]
    );
    // Every portal target NiaDB lists now has a map row.
    let maps: std::collections::HashSet<i32> = data.maps.iter().map(|m| m.id).collect();
    for id in [
        10001008, 10002005, 10003008, 10003098, 10003110, 10003111, 88001000,
    ] {
        assert!(maps.contains(&id), "map {id}");
    }
    assert!(data.npcs.iter().all(|n| n.name_en.is_some()));
}

fn zh_names() -> ZhNames {
    ZhNames::from_file(&repo_data("reference/zh-names.json")).expect("zh-names.json")
}

#[test]
fn zh_names_fill_map_and_npc_gaps() {
    let mut data = mapledex();
    data.add_niadb_dir(&repo_data("reference/niadb")).unwrap();
    let before = (
        data.maps.iter().filter(|m| m.name_zh.is_none()).count(),
        data.npcs.iter().filter(|n| n.name_zh.is_none()).count(),
    );
    assert_eq!(before, (186, 52));
    let mapledex_names: Vec<(i32, Option<String>)> = data
        .maps
        .iter()
        .map(|m| (m.id, m.name_zh.clone()))
        .collect();
    data.warnings.clear();

    let counts = data.add_zh_names(&zh_names());
    assert_eq!(
        counts,
        ZhNameCounts {
            maps: ZhSourceCounts {
                dvg: 163,
                mapledex_tw: 1
            },
            npcs: ZhSourceCounts {
                dvg: 51,
                mapledex_tw: 0
            },
        }
    );
    assert!(data.warnings.is_empty(), "{:?}", data.warnings);
    let still_english = (
        data.maps.iter().filter(|m| m.name_zh.is_none()).count(),
        data.npcs.iter().filter(|n| n.name_zh.is_none()).count(),
    );
    assert_eq!(still_english, (22, 1));
    for (map, (id, name)) in data.maps.iter().zip(&mapledex_names) {
        assert_eq!(map.id, *id);
        if name.is_some() {
            assert_eq!(&map.name_zh, name, "map {id}: Mapledex name kept");
        }
    }

    let map = |id: i32| data.maps.iter().find(|m| m.id == id).unwrap();
    let npc = |id: i32| data.npcs.iter().find(|n| n.id == id).unwrap();
    assert_eq!(map(10001007).name_zh.as_deref(), Some("射手村市政厅"));
    assert_eq!(map(10001008).name_zh.as_deref(), Some("黄蘑菇屋"));
    assert_eq!(map(10001000).name_zh.as_deref(), Some("射手村"));
    assert_eq!(
        (
            map(20000055).name_zh.as_deref(),
            map(20000055).name_tw.as_deref()
        ),
        (Some("天空阶梯 II"), Some("天空階梯 II")),
        "Mapledex traditional, converted"
    );
    assert_eq!(map(900000000).name_zh, None, "DVG's 测试 is not a name");
    assert_eq!(npc(231).name_zh.as_deref(), Some("比安卡"));
    assert_eq!(npc(231).name_en.as_deref(), Some("Bianca"));
    assert_eq!(npc(1024).name_zh, None);
}

#[test]
fn reference_items_cover_every_drop() {
    let refs = references();
    assert_eq!((refs.mapledex_items, refs.niadb_items), (2555, 2350));
    assert_eq!(refs.len(), 2919);
    assert!(refs.warnings.is_empty(), "{:?}", refs.warnings);

    let mut catalog = catalog_of(market_items());
    assert_eq!(refs.extend(&mut catalog), 2917);
    assert!(catalog.warnings.is_empty(), "{:?}", catalog.warnings);
    let mut data = mapledex();
    let resolution = refs.resolve_drops(&catalog, &mut data.drops);
    assert_eq!(
        resolution,
        DropResolution {
            by_gms_id: 0,
            by_name: 12,
            unresolved: 1395,
        },
        "Steel Pow and Mithril Axe need the simplified names items.sqlite has"
    );
    let ids: std::collections::HashSet<i32> = catalog.items.iter().map(|i| i.id).collect();
    for drop in &data.drops {
        if let Some(id) = drop.item_id {
            assert!(ids.contains(&id), "drop of mob {} item {id}", drop.mob_id);
        }
        assert!(
            drop.meso_max.is_some() || drop.name_en.is_some(),
            "mob {} drop {} has a name",
            drop.mob_id,
            drop.ord
        );
    }
}

/// `data/fixture` is a local symlink, not in Git; skip where it is missing.
#[tokio::test]
async fn items_sqlite_maps_every_row() {
    let path = repo_data("fixture/items.sqlite");
    if !path.exists() {
        eprintln!("{} missing; skipping", path.display());
        return;
    }
    let mut catalog = catalog::read_sqlite(&path).await.unwrap();
    assert_eq!(catalog.items.len(), 1001);
    assert!(catalog.warnings.is_empty(), "{:?}", catalog.warnings);
    let hat = catalog.items.iter().find(|i| i.id == 1002000).unwrap();
    assert_eq!(
        (hat.name_zh.as_deref(), hat.category.as_str()),
        (Some("褐色皮帽"), "装备")
    );
    assert_eq!(hat.req_level, Some(5));
    for item in &catalog.items {
        assert_eq!(
            item.subcategory.as_deref(),
            catalog::subcategory_for(item.id),
            "item {}: the prefix table reproduces DVG's label",
            item.id
        );
    }

    let refs = references();
    assert_eq!(refs.extend(&mut catalog), 1961);
    assert_eq!(catalog.items.len(), 2962);
    let mut data = mapledex();
    let resolution = refs.resolve_drops(&catalog, &mut data.drops);
    assert_eq!((resolution.by_name, resolution.unresolved), (15, 1392));
}

async fn count(pool: &sqlx::PgPool, table: &str) -> i64 {
    sqlx::query_scalar(&format!("SELECT count(*) FROM {table}"))
        .fetch_one(pool)
        .await
        .unwrap()
}

#[tokio::test]
async fn import_round_trip_is_idempotent() {
    let Some(db) = common::test_db().await else {
        return;
    };
    let data = mapledex();
    let mut items = market_items();

    let first = import_catalog(&db.pool, &catalog_of(items.clone()), &data, &SOURCES)
        .await
        .unwrap();
    assert_eq!(
        (
            first.items,
            first.mobs,
            first.maps,
            first.spawns,
            first.drops,
            first.npcs,
            first.npc_placements,
            first.portals
        ),
        (2, 195, 432, 894, 4575, 266, 300, 393)
    );
    assert_eq!(first.drops_meso, 142);
    assert!(first.drops_in_catalog > 0, "the two items have droppers");

    // Same input again, with one item renamed: counts unchanged, item updated.
    items[0].name_zh = Some("褐色皮帽子".into());
    let second = import_catalog(&db.pool, &catalog_of(items), &data, &SOURCES)
        .await
        .unwrap();
    assert_eq!(second, first);
    for (table, expected) in [
        ("items", 2),
        ("mobs", 195),
        ("maps", 432),
        ("mob_spawns", 894),
        ("drops", 4575),
        ("npcs", 266),
        ("map_npcs", 300),
        ("map_portals", 393),
        ("catalog_versions", 2),
        ("quests", 0),
        ("npc_shops", 0),
    ] {
        assert_eq!(count(&db.pool, table).await, expected, "{table}");
    }
    let renamed: String = sqlx::query_scalar("SELECT name_zh FROM items WHERE id = 1002000")
        .fetch_one(&db.pool)
        .await
        .unwrap();
    assert_eq!(renamed, "褐色皮帽子");

    // A stored mob reads back as parsed.
    let mob = data.mobs.iter().find(|m| m.id == 8).unwrap();
    let (name_zh, level, hp, gms_id): (Option<String>, Option<i16>, Option<i64>, Option<i32>) =
        sqlx::query_as("SELECT name_zh, level, hp, gms_id FROM mobs WHERE id = 8")
            .fetch_one(&db.pool)
            .await
            .unwrap();
    assert_eq!(
        (name_zh, level, hp, gms_id),
        (mob.name_zh.clone(), mob.level, mob.hp, mob.gms_id)
    );
    db.drop_schema().await;
}

/// Everything `import_catalog` builds from the repository's reference files,
/// on top of `items` standing in for items.sqlite.
struct Full {
    catalog: Catalog,
    refs: ItemReferences,
    data: Dataset,
    zh_names: ZhNames,
    zh: ZhNameCounts,
}

fn full(items: Vec<ItemRow>) -> Full {
    let refs = references();
    let mut catalog = catalog_of(items);
    refs.extend(&mut catalog);
    let mut data = mapledex();
    data.add_niadb_dir(&repo_data("reference/niadb")).unwrap();
    let zh_names = zh_names();
    let zh = data.add_zh_names(&zh_names);
    refs.resolve_drops(&catalog, &mut data.drops);
    Full {
        catalog,
        refs,
        data,
        zh_names,
        zh,
    }
}

async fn import_full(pool: &sqlx::PgPool, full: &Full) -> ImportSummary {
    import(
        pool,
        &Input {
            catalog: &full.catalog,
            references: &full.refs,
            data: &full.data,
            sources: &SOURCES,
            niadb: Some(NiaDbSource {
                path: "data/reference/niadb",
                version: "fetched 2026-10-21",
            }),
            zh_names: Some(ZhNamesSource {
                path: "data/reference/zh-names.json",
                version: &full.zh_names.version,
                counts: &full.zh,
            }),
        },
    )
    .await
    .unwrap()
}

/// The NiaDB portals as `import_portals` loads them (`tools/niadb_portals.py`
/// output, checked in as data/reference/niadb/portals.json).
async fn import_niadb_portals(pool: &sqlx::PgPool) -> u64 {
    let text = std::fs::read_to_string(repo_data("reference/niadb/portals.json")).unwrap();
    let portals = wz::portals_from(&wz::parse(&text).unwrap());
    wz::import(pool, &portals, "portals.json").await.unwrap()
}

/// Every bestiary table as text, for comparing two databases.
async fn dump(pool: &sqlx::PgPool) -> Vec<(String, String)> {
    let mut out = Vec::new();
    for (table, columns) in [
        ("items", "*"),
        ("item_records", "*"),
        ("mobs", "*"),
        ("maps", "*"),
        ("mob_spawns", "*"),
        ("drops", "*"),
        ("npcs", "*"),
        ("map_npcs", "*"),
        ("npc_shops", "*"),
        (
            "map_portals",
            "from_map_id, to_map_id, kind, portal_name, target_portal, x, y, source",
        ),
        ("catalog_versions", "dataset, version, source, counts"),
    ] {
        let sql = format!(
            "SELECT COALESCE(json_agg(x ORDER BY x::text), '[]')::text FROM (SELECT {columns} FROM {table}) x"
        );
        let rows: String = sqlx::query_scalar(&sql).fetch_one(pool).await.unwrap();
        out.push((table.to_string(), rows));
    }
    out
}

#[tokio::test]
async fn full_import_is_idempotent_and_upgrades_an_r3_database() {
    let (Some(fresh), Some(upgraded)) = (common::test_db().await, common::test_db().await) else {
        return;
    };
    let input = full(market_items());

    let first = import_full(&fresh.pool, &input).await;
    import_niadb_portals(&fresh.pool).await;
    assert_eq!(
        (
            first.items,
            first.maps,
            first.drops_with_item_id,
            first.drops_in_catalog,
            first.drops_named,
            first.npcs,
            first.npcs_named,
            first.npc_placements,
            first.npc_shops,
            first.portals
        ),
        (2919, 444, 3038, 3038, 4433, 273, 273, 309, 877, 404)
    );
    assert_eq!((first.maps_zh, first.npcs_zh), (444 - 22, 273 - 1));
    let before = dump(&fresh.pool).await;
    assert_eq!(import_full(&fresh.pool, &input).await, first);
    assert_eq!(dump(&fresh.pool).await, before, "a re-run changes nothing");

    // A database seeded the R3 way (as `dev` is) ends in the same state.
    let r3 = mapledex();
    import_catalog(&upgraded.pool, &catalog_of(market_items()), &r3, &SOURCES)
        .await
        .unwrap();
    import_niadb_portals(&upgraded.pool).await;
    assert_eq!(import_full(&upgraded.pool, &input).await, first);
    assert_eq!(dump(&upgraded.pool).await, before);

    let (name_tw, gms_id): (Option<String>, Option<i32>) =
        sqlx::query_as("SELECT name_tw, gms_id FROM items WHERE id = 1002000")
            .fetch_one(&fresh.pool)
            .await
            .unwrap();
    assert_eq!(
        (name_tw.as_deref(), gms_id),
        (Some("褐色皮帽"), Some(1002008))
    );
    let unnamed_targets: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM map_portals p WHERE NOT EXISTS (SELECT 1 FROM maps m WHERE m.id = p.to_map_id)",
    )
    .fetch_one(&fresh.pool)
    .await
    .unwrap();
    assert_eq!(unnamed_targets, 0, "every portal leads to a named map");
    let shop: (i64, Option<String>) = sqlx::query_as(
        "SELECT price, source FROM npc_shops WHERE npc_id = 21 AND item_id = 2000000",
    )
    .fetch_one(&fresh.pool)
    .await
    .unwrap();
    assert_eq!(shop.0, 50);
    assert!(shop.1.unwrap().contains("COT2"));
    let names: Vec<(String, Option<String>)> = sqlx::query_as(
        "SELECT name_en, name_zh FROM maps WHERE id IN (10001000, 10001007) UNION ALL
         SELECT name_en, name_zh FROM npcs WHERE id = 231 ORDER BY 1",
    )
    .fetch_all(&fresh.pool)
    .await
    .unwrap();
    assert_eq!(
        names,
        vec![
            ("Bianca".into(), Some("比安卡".into())),
            ("Henesys".into(), Some("射手村".into())),
            ("Henesys Town Hall".into(), Some("射手村市政厅".into())),
        ]
    );
    let zh_counts: serde_json::Value = sqlx::query_scalar(
        "SELECT counts FROM catalog_versions WHERE dataset = 'zh-names' AND version = $1",
    )
    .bind(&input.zh_names.version)
    .fetch_one(&fresh.pool)
    .await
    .unwrap();
    assert_eq!(zh_counts["maps"]["dvg"], 163);
    assert_eq!(zh_counts["npcs"]["dvg"], 51);
    fresh.drop_schema().await;
    upgraded.drop_schema().await;
}

#[tokio::test]
async fn wz_portals_survive_catalog_reimport() {
    let Some(db) = common::test_db().await else {
        return;
    };
    let data = mapledex();
    import_catalog(&db.pool, &catalog_of(Vec::new()), &data, &SOURCES)
        .await
        .unwrap();

    let file = r#"[{"map_id": 10001000, "wz_version": 83, "portals": [
        {"pn": "east00", "tm": 10001010, "tn": "west00"}, {"pn": "sp", "tm": 999999999}]},
        {"map_id": 10001010, "portals": [{"pn": "west00", "tm": 10001000}]}]"#;
    let portals = wz::portals_from(&wz::parse(file).unwrap());
    assert_eq!(wz::import(&db.pool, &portals, "test").await.unwrap(), 2);

    // Re-importing one map replaces only that map's portals.
    let one = wz::portals_from(&wz::parse(r#"{"map_id": 10001000, "portals": []}"#).unwrap());
    assert_eq!(wz::import(&db.pool, &one, "test").await.unwrap(), 0);
    let wz_count: i64 = sqlx::query_scalar("SELECT count(*) FROM map_portals WHERE source = 'wz'")
        .fetch_one(&db.pool)
        .await
        .unwrap();
    assert_eq!(wz_count, 1);

    import_catalog(&db.pool, &catalog_of(Vec::new()), &data, &SOURCES)
        .await
        .unwrap();
    assert_eq!(
        count(&db.pool, "map_portals").await,
        394,
        "393 return links + 1 WZ portal"
    );
    db.drop_schema().await;
}

async fn get(router: &axum::Router, if_none_match: Option<&str>) -> axum::response::Response {
    let mut request = Request::get("/api/v1/dex/dropped-items");
    if let Some(tag) = if_none_match {
        request = request.header(header::IF_NONE_MATCH, tag);
    }
    router
        .clone()
        .oneshot(request.body(Body::empty()).unwrap())
        .await
        .unwrap()
}

#[tokio::test]
async fn dropped_items_endpoint() {
    let Some(db) = common::test_db().await else {
        return;
    };
    let router = app(AppState::new(db.pool.clone(), Settings::default()));
    let empty = get(&router, None).await;
    assert_eq!(empty.status(), StatusCode::OK);
    let body = empty.into_body().collect().await.unwrap().to_bytes();
    assert_eq!(&body[..], br#"{"as_of":0,"item_ids":[]}"#);

    import_full(&db.pool, &full(market_items())).await;
    let response = get(&router, None).await;
    assert_eq!(response.status(), StatusCode::OK);
    let headers = response.headers().clone();
    assert_eq!(headers[header::CACHE_CONTROL], "public, max-age=3600");
    assert!(headers[header::CONTENT_TYPE]
        .to_str()
        .unwrap()
        .starts_with("application/json"));
    let tag = headers[header::ETAG].to_str().unwrap().to_string();
    let body: serde_json::Value =
        serde_json::from_slice(&response.into_body().collect().await.unwrap().to_bytes()).unwrap();
    assert!(body["as_of"].as_i64().unwrap() > 1_700_000_000);
    let ids: Vec<i64> = body["item_ids"]
        .as_array()
        .unwrap()
        .iter()
        .map(|v| v.as_i64().unwrap())
        .collect();
    let distinct: i64 =
        sqlx::query_scalar("SELECT count(DISTINCT item_id) FROM drops WHERE item_id IS NOT NULL")
            .fetch_one(&db.pool)
            .await
            .unwrap();
    assert_eq!(ids.len() as i64, distinct);
    assert!(ids.windows(2).all(|w| w[0] < w[1]), "sorted and distinct");
    assert!(ids.contains(&4000019) && ids.contains(&1072049));

    let cached = get(&router, Some(&tag)).await;
    assert_eq!(cached.status(), StatusCode::NOT_MODIFIED);
    assert_eq!(cached.headers()[header::ETAG], tag.as_str());
    assert_eq!(
        cached.headers()[header::CACHE_CONTROL],
        "public, max-age=3600"
    );
    db.drop_schema().await;
}

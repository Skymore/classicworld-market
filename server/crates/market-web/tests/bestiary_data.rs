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
            import, import_catalog, DvgSource, ImportSummary, Input, NiaDbSource, Sources,
            ZhNamesSource,
        },
        mapledex::{
            Dataset, DvgMobCounts, DvgMobs, NiaBestiaryCounts, NiaDbCounts, ZhNameCounts, ZhNames,
            ZhSourceCounts,
        },
        model::{DropTarget, MapRef, SceneImage, SearchKind},
        queries,
        quests::{DvgQuests, QuestCounts},
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
            maps: 36,
            spawns: 13,
            return_links: 33,
            npc_placements: 21,
            npc_names: 15,
            shop_rows: 877,
        }
    );
    // Mobs Mapledex lacks; `apply_niadb_bestiary` adds them from NiaDB's list.
    let nia_mobs = std::fs::read_to_string(repo_data("reference/niadb/monsters.json")).unwrap();
    assert!(!data.warnings.is_empty());
    for warning in &data.warnings {
        let id = warning
            .split("unknown mob \"")
            .nth(1)
            .and_then(|rest| rest.strip_suffix('"'))
            .unwrap_or_else(|| panic!("{warning}"));
        assert!(nia_mobs.contains(&format!("\"id\":{id},")), "{warning}");
    }
    // Every portal target NiaDB lists now has a map row.
    let maps: std::collections::HashSet<i32> = data.maps.iter().map(|m| m.id).collect();
    for id in [
        10001008, 10002005, 10003008, 10003098, 10003110, 10003111, 88001000,
    ] {
        assert!(maps.contains(&id), "map {id}");
    }
    assert!(data.npcs.iter().all(|n| n.name_en.is_some()));
}

#[test]
fn niadb_bestiary_decides_what_exists() {
    let mut data = mapledex();
    let (added, counts) = data
        .add_niadb_bestiary_dir(&repo_data("reference/niadb"), fetch_day())
        .expect("NiaDB monsters, maps, shops and drops");
    assert!(data.warnings.is_empty(), "{:?}", data.warnings);
    assert_eq!(
        (added.maps, added.spawns),
        (36, 35),
        "NiaDB's mobs are known before its maps are added"
    );
    assert_eq!(
        (
            counts.mobs,
            counts.mobs_added,
            counts.mobs_removed,
            counts.mobs_unreleased,
            counts.mob_copies,
        ),
        (206, 19, 8, 41 + 11 + 11, 11),
        "Orbis / El Nath, Forgotten Hollow's 11, and 11 GM-event / alt copies"
    );
    assert_eq!(
        (counts.maps, counts.maps_removed, counts.maps_unreleased),
        (453, 15, 92 + 27 + 1 + 2),
        "080003500, which the client leaves unnamed, and two dead copies of town houses"
    );
    assert_eq!(
        (counts.drops + counts.mesos, counts.drops_unconfirmed),
        (data.drops.len(), 110)
    );
    assert_eq!(
        (counts.mesos, counts.mesos_untrusted),
        (49, 0),
        "monsters with meso reports"
    );
    assert_eq!(counts.spawns, data.spawns.len());

    let mob = |id: i32| data.mobs.iter().find(|m| m.id == id);
    let map = |id: i32| data.maps.iter().find(|m| m.id == id);
    assert!(mob(9990000).is_none(), "Mapledex test mobs are gone");
    assert!(map(900000000).is_none(), "Mapledex test maps are gone");
    let zombie = mob(700002).unwrap();
    assert_eq!(
        (zombie.name_zh.is_some(), zombie.level, zombie.hp),
        (true, Some(55), Some(66640)),
        "launch stats from NiaDB, the name from Mapledex"
    );
    assert!(
        mob(1001).unwrap().unreleased,
        "Jr. Sentinel only spawns in Orbis"
    );
    assert!(!mob(3).unwrap().unreleased);
    assert!(map(20000000).unwrap().unreleased, "Orbis is not open yet");
    assert!(!map(10001000).unwrap().unreleased);
    let towns: Vec<i32> = data
        .maps
        .iter()
        .filter(|m| m.is_town && !m.unreleased)
        .map(|m| m.id)
        .collect();
    assert_eq!(towns.len(), 17, "{towns:?}");
    assert!(map(10001000).unwrap().is_town, "Henesys");
    assert!(
        !map(10001041).unwrap().is_town,
        "Henesys Weapon Store returns to Henesys"
    );
    assert!(
        !map(10002005).unwrap().is_town,
        "The Circulation Desk returns to Ellinia"
    );
    assert!(
        !map(10001021).unwrap().is_town,
        "Mushroom Garden has monsters"
    );
    assert!(map(10004130).is_some(), "Excavation Site I, new in NiaDB");
    assert!(
        map(10006000).unwrap().unreleased,
        "Forgotten Hollow opens on November 18"
    );
    assert!(mob(54).unwrap().unreleased, "Glowshroom only spawns there");
    assert!(
        mob(810000).unwrap().unreleased && mob(800020).unwrap().unreleased,
        "GM-event and alt copies that spawn nowhere"
    );
    assert!(
        !mob(800011).unwrap().unreleased,
        "the party-quest Zombie Mushroom spawns in 1st Accompaniment"
    );
    assert!(map(80003500).unwrap().unreleased, "unnamed in the client");
    let house = map(88000000).unwrap();
    assert_eq!(
        (
            house.name_en.as_str(),
            house.street_en.as_deref(),
            house.name_zh.as_deref()
        ),
        ("Yellow Mushroom House", Some("Victoria Road"), None),
        "NiaDB's name; Mapledex has name and street swapped"
    );

    // The map view: NiaDB's minimap box, spawn points and NPC positions.
    let field = map(1000).unwrap();
    assert_eq!(
        (
            field.minimap_w,
            field.minimap_h,
            field.minimap_cx,
            field.minimap_cy
        ),
        (Some(3928), Some(2050), Some(479), Some(1405))
    );
    assert_eq!(
        field.minimap_url.as_deref(),
        Some("/web/images/minimaps/1000.png")
    );
    assert_eq!((field.spawn_x, field.spawn_y), (Some(-91), Some(181)));
    let points: Vec<_> = data
        .spawn_points
        .iter()
        .filter(|p| p.map_id == 1000)
        .collect();
    assert_eq!(points.len(), 66, "NiaDB: 66 monster spawn points");
    assert_eq!(
        (points[0].mob_id, points[0].x, points[0].y),
        (4, 2242, -55),
        "Shroom, first in NiaDB's order"
    );
    let per_map: i64 = data
        .spawns
        .iter()
        .filter(|s| s.map_id == 1000)
        .map(|s| i64::from(s.spawn_count))
        .sum();
    assert_eq!(per_map, 66, "the per-mob totals agree");
    let mut keys: Vec<(i32, i16)> = data
        .spawn_points
        .iter()
        .map(|p| (p.map_id, p.ord))
        .collect();
    keys.sort_unstable();
    keys.dedup();
    assert_eq!(
        keys.len(),
        data.spawn_points.len(),
        "(map_id, ord) is the key"
    );
    let heena = data
        .map_npcs
        .iter()
        .find(|p| (p.map_id, p.npc_id) == (1, 1))
        .unwrap();
    assert_eq!((heena.x, heena.y), (Some(-46), Some(280)));

    // Only drops players confirmed and NiaDB's meso ranges; no rates.
    assert!(data
        .drops
        .iter()
        .all(|d| d.rate_pct.is_none() && d.source.as_deref() == Some("niadb")));
    let (items, mesos): (Vec<_>, Vec<_>) = data.drops.iter().partition(|d| d.item_id.is_some());
    assert!(items
        .iter()
        .all(|d| d.upvotes > d.downvotes && d.meso_max.is_none()));
    assert_eq!(mesos.len(), counts.mesos);
    assert!(mesos.iter().all(|d| d
        .meso_min
        .zip(d.meso_max)
        .is_some_and(|(lo, hi)| 0 <= lo && lo <= hi)));
    let snail_mesos = mesos.iter().find(|d| d.mob_id == 2).expect("Snail mesos");
    assert_eq!(
        (snail_mesos.meso_min, snail_mesos.meso_max),
        (Some(3), Some(4)),
        "NiaDB's median of 2-2 and 4-5"
    );
    let mut keys: Vec<(i32, i16)> = data.drops.iter().map(|d| (d.mob_id, d.ord)).collect();
    keys.sort_unstable();
    keys.dedup();
    assert_eq!(
        keys.len(),
        data.drops.len(),
        "(mob_id, ord) is the primary key"
    );
    let blue_snail: Vec<_> = data.drops.iter().filter(|d| d.mob_id == 3).collect();
    assert_eq!(
        (blue_snail[0].item_id, blue_snail[0].upvotes),
        (Some(4010001), Some(84.25)),
        "Iron Ore"
    );
    let mobs: std::collections::HashSet<i32> = data.mobs.iter().map(|m| m.id).collect();
    let maps: std::collections::HashSet<i32> = data.maps.iter().map(|m| m.id).collect();
    assert!(data
        .spawns
        .iter()
        .all(|s| mobs.contains(&s.mob_id) && maps.contains(&s.map_id)));
    assert!(data.map_npcs.iter().all(|p| maps.contains(&p.map_id)));
    assert!(data
        .portals
        .iter()
        .all(|p| maps.contains(&p.from_map_id) && maps.contains(&p.to_map_id)));
    assert!(counts.npcs_unreleased > 0);
    assert_eq!(
        data.npcs.iter().filter(|n| n.unreleased).count(),
        counts.npcs_unreleased
    );

    // Imported on its opening day, Forgotten Hollow shows; Orbis still does not.
    let mut later = mapledex();
    let opening = chrono::NaiveDate::from_ymd_opt(2026, 11, 18).unwrap();
    let (_, counts) = later
        .add_niadb_bestiary_dir(&repo_data("reference/niadb"), opening)
        .unwrap();
    assert_eq!(
        (counts.maps_unreleased, counts.mobs_unreleased),
        (92 + 1 + 2, 41 + 11)
    );
}

/// The day the NiaDB files were fetched: Forgotten Hollow is not open yet.
fn fetch_day() -> chrono::NaiveDate {
    chrono::NaiveDate::from_ymd_opt(2026, 11, 2).unwrap()
}

fn dvg_mobs() -> DvgMobs {
    DvgMobs::from_file(&repo_data("reference/dvg/mob-list.json")).expect("dvg/mob-list.json")
}

#[test]
fn dvg_names_mobs_and_niadb_replaces_reused_ids() {
    let mut data = mapledex();
    let (_, counts) = data
        .add_niadb_bestiary_dir(&repo_data("reference/niadb"), fetch_day())
        .unwrap();
    assert_eq!(counts.mobs_replaced, 7, "39, 42 and 800019-800023");
    let ghost = data.mobs.iter().find(|m| m.id == 39).unwrap();
    assert_eq!(
        (
            ghost.name_en.as_str(),
            ghost.name_zh.as_deref(),
            ghost.gms_id
        ),
        ("Ghost Stump", None, None),
        "Mapledex's id 39 is Nependeath, a different mob"
    );
    let counts = data.add_dvg_mob_names(&dvg_mobs());
    assert!(data.warnings.is_empty(), "{:?}", data.warnings);
    assert_eq!((counts.named, counts.renamed), (110, 11));
    let zh = |id: i32| {
        data.mobs
            .iter()
            .find(|m| m.id == id)
            .unwrap()
            .name_zh
            .as_deref()
    };
    assert_eq!(zh(39), Some("古木妖"));
    assert_eq!(zh(700000), Some("蘑菇王"), "not Mapledex's mush妈妈");
    assert_eq!(zh(64), Some("石面怪人"), "a mob only NiaDB lists");
    assert_eq!(
        zh(910000),
        Some("稻草训练假人"),
        "DVG spells it Straw Traning Dummy"
    );
    assert_eq!(zh(3), Some("蓝蜗牛"));
}

fn dvg_quests() -> DvgQuests {
    DvgQuests::from_file(&repo_data("reference/dvg/quest-list.json")).expect("dvg/quest-list.json")
}

#[test]
fn quests_give_and_ask_for_items() {
    let mut data = mapledex();
    data.add_niadb_bestiary_dir(&repo_data("reference/niadb"), fetch_day())
        .unwrap();
    data.warnings.clear();
    let counts = data
        .add_quests_from(&repo_data("reference/niadb"), &dvg_quests(), fetch_day())
        .unwrap();
    assert!(data.warnings.is_empty(), "{:?}", data.warnings);
    assert_eq!(counts.quests, 401);
    assert!(counts.named_zh > 300 && counts.with_npc > 390, "{counts:?}");
    let quest = |id: i32| data.quests.iter().find(|q| q.id == id).unwrap();
    let quiz = quest(1019);
    assert_eq!(
        (quiz.name_zh.as_deref(), quiz.level_min, quiz.unreleased),
        (Some("瑞恩的枫叶问答7"), Some(5), false)
    );
    assert!(data.quest_rewards.iter().any(|r| r.quest_id == 1019
        && r.item_id == 2010004
        && r.quantity == 10
        && r.kind == "fixed"));
    // Forgotten Hollow's quests wait for the area to open.
    assert!(quest(10600).unreleased && quest(10621).unreleased);
    let opening = chrono::NaiveDate::from_ymd_opt(2026, 11, 18).unwrap();
    let mut later = mapledex();
    later
        .add_niadb_bestiary_dir(&repo_data("reference/niadb"), opening)
        .unwrap();
    later
        .add_quests_from(&repo_data("reference/niadb"), &dvg_quests(), opening)
        .unwrap();
    assert!(
        !later
            .quests
            .iter()
            .find(|q| q.id == 10600)
            .unwrap()
            .unreleased
    );
    // Event quests keep their window; pages show them only inside it.
    let event = data
        .quests
        .iter()
        .find(|q| q.ends_at.is_some())
        .expect("an event quest");
    assert!(event.starts_at.is_some());
    let kinds: std::collections::HashSet<&str> =
        data.quest_rewards.iter().map(|r| r.kind).collect();
    assert_eq!(kinds, ["fixed", "choice", "random"].into_iter().collect());
    assert!(
        data.quest_needs.iter().any(|n| n.mob_id.is_some())
            && data.quest_needs.iter().any(|n| n.item_id.is_some())
    );
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
    assert_eq!(before, (210, 60));
    let mapledex_names: Vec<(i32, Option<String>)> = data
        .maps
        .iter()
        .map(|m| (m.id, m.name_zh.clone()))
        .collect();
    data.add_quests_from(&repo_data("reference/niadb"), &dvg_quests(), fetch_day())
        .unwrap();
    let quests_english = data.quests.iter().filter(|q| q.name_zh.is_none()).count();
    assert_eq!(quests_english, 59);
    data.warnings.clear();

    let counts = data.add_zh_names(&zh_names());
    assert_eq!(
        counts,
        ZhNameCounts {
            maps: ZhSourceCounts {
                dvg: 272,
                mapledex_tw: 1,
                cms: 0,
                translated: 0
            },
            npcs: ZhSourceCounts {
                dvg: 59,
                mapledex_tw: 0,
                cms: 0,
                translated: 0
            },
            quests: ZhSourceCounts {
                dvg: 0,
                mapledex_tw: 0,
                cms: 40,
                translated: 19
            },
            items: ZhSourceCounts::default(),
        }
    );
    assert!(data.warnings.is_empty(), "{:?}", data.warnings);
    let still_english = (
        data.maps.iter().filter(|m| m.name_zh.is_none()).count(),
        data.npcs.iter().filter(|n| n.name_zh.is_none()).count(),
        data.quests.iter().filter(|q| q.name_zh.is_none()).count(),
    );
    assert_eq!(
        still_english,
        (16, 1, 0),
        "Mapledex-only test maps, DVG placeholders, NiaDB maps DVG lacks and NPC 1024 ????"
    );
    // Mapledex names stay unless tools/zh_names.py replaces them: another
    // map's name (MAPLEDEX_WRONG there), or DVG's name for the same map.
    let file: serde_json::Value = serde_json::from_str(
        &std::fs::read_to_string(repo_data("reference/zh-names.json")).unwrap(),
    )
    .unwrap();
    let replaced: Vec<i32> = file["maps"]
        .as_object()
        .unwrap()
        .iter()
        .filter(|(_, entry)| entry["replaces_mapledex"] == true)
        .map(|(id, _)| id.parse().unwrap())
        .collect();
    assert_eq!(replaced.len(), 7 + 72);
    for (map, (id, name)) in data.maps.iter().zip(&mapledex_names) {
        assert_eq!(map.id, *id);
        if name.is_some() && !replaced.contains(id) {
            assert_eq!(&map.name_zh, name, "map {id}: Mapledex name kept");
        }
    }
    let map_zh = |id: i32| {
        data.maps
            .iter()
            .find(|m| m.id == id)
            .unwrap()
            .name_zh
            .clone()
    };
    assert_eq!(map_zh(1001).as_deref(), Some("小树林"), "not 蜗牛打猎场Ⅰ");
    assert_eq!(map_zh(1010).as_deref(), Some("彩虹村"));
    assert_eq!(
        map_zh(40).as_deref(),
        Some("蜗牛狩猎场Ⅰ"),
        "DVG's 蜗牛狩猎场 I"
    );
    assert_eq!(
        map_zh(41).as_deref(),
        Some("蜗牛狩猎场Ⅱ"),
        "not Mapledex's 蜗牛打猎场Ⅱ"
    );
    assert_eq!(map_zh(10002082).as_deref(), Some("北部森林训练场Ⅷ"));
    assert_eq!(map_zh(10003061).as_deref(), Some("地铁一号线 <第1地区>"));
    assert_eq!(
        map_zh(10003062).as_deref(),
        Some("换乘区"),
        "not DVG's typo 环乘区"
    );

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
        (Some("天空阶梯Ⅱ"), Some("天空階梯 II")),
        "Mapledex traditional, converted and numbered as the other maps"
    );
    assert_eq!(map(900000000).name_zh, None, "DVG's 测试 is not a name");
    assert_eq!(npc(231).name_zh.as_deref(), Some("比安卡"));
    assert_eq!(npc(231).name_en.as_deref(), Some("Bianca"));
    assert_eq!(npc(1024).name_zh, None);
    assert_eq!(npc(515).name_zh.as_deref(), Some("修安"), "DVG site search");
    let quest = |id: i32| data.quests.iter().find(|q| q.id == id).unwrap();
    assert_eq!(
        quest(12131).name_zh.as_deref(),
        Some("赫丽娜的拜托"),
        "CMS quest 3026"
    );
    assert_eq!(quest(10611).name_zh.as_deref(), Some("欢迎来到遗忘空洞"));
}

#[test]
fn reference_items_cover_every_drop() {
    let refs = references();
    assert_eq!((refs.mapledex_items, refs.niadb_items), (2555, 2400));
    assert_eq!(refs.len(), 2969);
    assert!(refs.warnings.is_empty(), "{:?}", refs.warnings);

    let mut catalog = catalog_of(market_items());
    assert_eq!(refs.extend(&mut catalog), 2967);
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
    let zh = zh_names().add_item_names(&mut catalog);
    assert_eq!((zh.dvg, zh.mapledex_tw, zh.translated), (682, 0, 7));
    assert!(catalog.warnings.is_empty(), "{:?}", catalog.warnings);
    let item_zh = |id: i32| {
        catalog
            .items
            .iter()
            .find(|i| i.id == id)
            .and_then(|i| i.name_zh.clone())
    };
    assert_eq!(item_zh(3000000).as_deref(), Some("橡木窗"));
    assert_eq!(item_zh(1007100).as_deref(), Some("精美黑色韩服帽"));
    assert_eq!(item_zh(5680002).as_deref(), Some("消耗栏5格扩展券"));
    assert!(catalog.items.iter().all(|i| i.name_zh.is_some()));
    let mut data = mapledex();
    let resolution = refs.resolve_drops(&catalog, &mut data.drops);
    assert_eq!((resolution.by_name, resolution.unresolved), (15, 1392));
}

/// `import_catalog` stores NiaDB's equipment stats on the item records; item
/// pages and quick previews read the base critical rate and the game
/// tooltip's requirements back from them.
#[tokio::test]
async fn niadb_stats_and_equipment_reach_item_pages() {
    let path = repo_data("fixture/items.sqlite");
    if !path.exists() {
        eprintln!("{} missing; skipping", path.display());
        return;
    }
    let Some(db) = common::test_db().await else {
        return;
    };
    let mut catalog = catalog::read_sqlite(&path).await.unwrap();
    let refs = references();
    refs.extend(&mut catalog);
    let annotated = refs.annotate_records(&mut catalog);
    assert!(
        annotated > 100 && annotated < catalog.records.len(),
        "{annotated} of {}",
        catalog.records.len()
    );
    let data = mapledex();
    let input = Input {
        catalog: &catalog,
        references: &refs,
        data: &data,
        sources: &SOURCES,
        niadb: None,
        zh_names: None,
        dvg: None,
    };
    import(&db.pool, &input).await.unwrap();
    let with_niadb: i64 =
        sqlx::query_scalar("SELECT count(*) FROM item_records WHERE record ? 'niadb_reference'")
            .fetch_one(&db.pool)
            .await
            .unwrap();
    assert_eq!(with_niadb, annotated as i64);

    let now = 1_793_000_000.0;
    let claw = queries::item_page(&db.pool, 1472009, now)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(
        claw.market.base_stats,
        vec![("weapon_attack".into(), 23), ("critical_rate".into(), 1)]
    );
    let e = claw.equipment.expect("equipment reference");
    assert_eq!(
        e.req.map(|r| (r.level, r.str, r.dex, r.int, r.luk)),
        Some((30, 0, 30, 0, 65))
    );
    assert_eq!(
        (e.jobs, e.kind, e.attack_speed, e.upgrades),
        (Some(8), Some("拳套"), Some(4), Some(7))
    );
    let preview = queries::item_preview(&db.pool, 1472009, false)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(preview["equipment"]["kind"], "拳套");
    assert_eq!(preview["equipment"]["req"]["luk"], 65);
    assert!(preview["market"]["base_stats"]
        .as_array()
        .unwrap()
        .contains(&serde_json::json!(["critical_rate", 1])));

    // A re-import leaves the same records; non-equipment has no reference.
    import(&db.pool, &input).await.unwrap();
    let again: i64 =
        sqlx::query_scalar("SELECT count(*) FROM item_records WHERE record ? 'niadb_reference'")
            .fetch_one(&db.pool)
            .await
            .unwrap();
    assert_eq!(again, with_niadb);
    let snail = queries::item_page(&db.pool, 4000019, now).await.unwrap();
    assert!(snail.is_none_or(|page| page.equipment.is_none()));
    db.drop_schema().await;
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
    bestiary: NiaBestiaryCounts,
    dvg_mobs: DvgMobs,
    dvg: DvgMobCounts,
    quests: QuestCounts,
    zh_names: ZhNames,
    zh: ZhNameCounts,
}

fn full(items: Vec<ItemRow>) -> Full {
    let refs = references();
    let mut catalog = catalog_of(items);
    refs.extend(&mut catalog);
    refs.annotate_records(&mut catalog);
    let zh_names = zh_names();
    let item_zh = zh_names.add_item_names(&mut catalog);
    let mut data = mapledex();
    let (_, bestiary) = data
        .add_niadb_bestiary_dir(&repo_data("reference/niadb"), fetch_day())
        .unwrap();
    let dvg_mobs = dvg_mobs();
    let dvg = data.add_dvg_mob_names(&dvg_mobs);
    let quests = data
        .add_quests_from(&repo_data("reference/niadb"), &dvg_quests(), fetch_day())
        .unwrap();
    let mut zh = data.add_zh_names(&zh_names);
    zh.items = item_zh;
    refs.resolve_drops(&catalog, &mut data.drops);
    Full {
        catalog,
        refs,
        data,
        bestiary,
        dvg_mobs,
        dvg,
        quests,
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
                version: "fetched 2026-11-02",
                bestiary: Some(&full.bestiary),
            }),
            zh_names: Some(ZhNamesSource {
                path: "data/reference/zh-names.json",
                version: &full.zh_names.version,
                counts: &full.zh,
            }),
            dvg: Some(DvgSource {
                path: "data/reference/dvg",
                version: &full.dvg_mobs.fetched,
                counts: serde_json::json!({ "mobs": &full.dvg, "quests": full.quests.named_zh }),
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
        (2969, 453, 1669, 1669, 1669, 281, 281, 315, 877, 426 + 21),
    );
    assert_eq!(
        (first.maps_zh, first.npcs_zh),
        (453 - 1, 281 - 1),
        "080003500; NPC 1024 ????"
    );
    assert_eq!(first.drops_meso as usize, input.bestiary.mesos);
    assert_eq!(
        (first.mobs_unreleased, first.maps_unreleased),
        (52 + 11, 119 + 1 + 2),
        "Orbis / El Nath and Forgotten Hollow; GM-event / alt copies; 080003500"
    );
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
    assert_eq!(zh_counts["maps"]["dvg"], 272);
    assert_eq!(zh_counts["npcs"]["dvg"], 59);
    assert_eq!(
        (
            zh_counts["quests"]["cms"].as_i64(),
            zh_counts["quests"]["translated"].as_i64()
        ),
        (Some(40), Some(19))
    );
    let item_names: Vec<(i32, Option<String>)> =
        sqlx::query_as("SELECT id, name_zh FROM items WHERE id IN (3000000, 5680002) ORDER BY id")
            .fetch_all(&fresh.pool)
            .await
            .unwrap();
    assert_eq!(
        item_names,
        vec![
            (3000000, Some("橡木窗".into())),
            (5680002, Some("消耗栏5格扩展券".into()))
        ]
    );
    fresh.drop_schema().await;
    upgraded.drop_schema().await;
}

/// Orbis / El Nath are imported but never shown: no page, no search hit, no
/// dropper, no NPC price, no route step. Drops show votes, not rates.
#[tokio::test]
async fn map_views_quests_and_npc_pages_come_from_the_import() {
    let Some(db) = common::test_db().await else {
        return;
    };
    let input = full(market_items());
    import_full(&db.pool, &input).await;
    let pool = &db.pool;
    // Portal positions come from `import_portals`, as in production.
    let text = std::fs::read_to_string(repo_data("reference/niadb/portals.json")).unwrap();
    let portals =
        market_web::bestiary::wz::portals_from(&market_web::bestiary::wz::parse(&text).unwrap());
    market_web::bestiary::wz::import(pool, &portals, "portals.json")
        .await
        .unwrap();

    // Hidden portals keep their WZ type: Henesys's in03 to An Empty House.
    let henesys_view = queries::map_view(pool, 10001000, queries::Layers::PORTALS)
        .await
        .unwrap()
        .unwrap();
    assert!(henesys_view
        .portals
        .iter()
        .any(|p| p.to.id == 10001002 && p.portal_type == Some(1)));
    // Southperry's ship and the taxis are routes too.
    let kinds: Vec<(i32, i32, String)> = sqlx::query_as(
        "SELECT from_map_id, to_map_id, kind FROM map_portals WHERE kind IN ('ship', 'taxi') ORDER BY 1, 2",
    )
    .fetch_all(pool)
    .await
    .unwrap();
    assert_eq!(kinds.len(), 21);
    assert!(kinds.contains(&(60, 10000000, "ship".to_string())));

    let field = queries::map_page(pool, 1000).await.unwrap().unwrap();
    let view = field.view.expect("NiaDB has the minimap box");
    assert_eq!((view.width, view.height), (3928, 2050));
    assert_eq!(
        view.image_url.as_deref(),
        Some("/web/images/minimaps/1000.png")
    );
    assert_eq!(view.spawns.len(), 66);
    let shroom = &view.spawns[0];
    assert_eq!(
        (shroom.mob_id, shroom.x, shroom.y),
        (4, 2242 + 479, -55 + 1405),
        "box units: world point + minimap centre"
    );
    assert!(view
        .spawns
        .iter()
        .all(|p| (0..=view.width).contains(&p.x) && (0..=view.height).contains(&p.y)));
    assert!(
        view.portals.iter().any(|p| p.to.id == 50),
        "west00 to A Split Road"
    );
    assert!(view.shown_width <= 880 && view.icon > 0);
    assert!(
        field.quests_hunted.iter().any(|h| h.mob.id == 9),
        "Orange Mushroom quests progress here"
    );

    let entrance = queries::map_page(pool, 1).await.unwrap().unwrap();
    assert!(
        entrance.quests_given.iter().any(|q| q.id == 1000),
        "Heena's mirror quest"
    );
    let entrance_view = entrance.view.unwrap();
    assert!(entrance_view.npcs.iter().any(|n| n.npc.id == 1));

    let heena = queries::npc_page(pool, 1).await.unwrap().unwrap();
    assert_eq!(heena.places.len(), 1);
    assert_eq!(heena.places[0].map.id, 1);
    let place = heena.places[0].view.as_ref().unwrap();
    assert!(place.spawns.is_empty() && place.npcs.iter().any(|n| n.npc.id == 1));
    assert!(heena.quests.iter().any(|q| q.id == 1000));

    assert!(queries::map_page(pool, 80003500).await.unwrap().is_none());
    assert!(queries::mob_page(pool, 810000).await.unwrap().is_none());
    assert!(queries::npc_page(pool, 999_999).await.unwrap().is_none());

    // Scenes: the picture covers the minimap box (NiaDB's terrain view).
    let scene = view_scene(pool, 1000).await;
    if let Some(scene) = scene {
        assert_eq!(
            (scene.x, scene.y, scene.width, scene.height),
            (0, 0, 3928, 2050)
        );
    }

    // The world map: Maple Island and Victoria Island; Ossyria and
    // Forgotten Hollow are not open.
    let world = queries::world_page(pool, Some(10001001)).await.unwrap();
    let ids: Vec<&str> = world.regions.iter().map(|r| r.id.as_str()).collect();
    assert_eq!(ids, ["MapleIsland", "VictoriaIsland"]);
    let victoria = &world.regions[1];
    assert!(
        victoria.spots.iter().all(|s| s.map.id != 10006000),
        "Forgotten Hollow"
    );
    let henesys = victoria
        .spots
        .iter()
        .find(|s| s.map.id == 10001000)
        .unwrap();
    assert_eq!(henesys.kind, 0, "a town marker");
    assert_eq!(henesys.map.names.zh, "射手村");
    assert!(henesys.map_count > 10, "Henesys and its shops and houses");
    assert_eq!(world.here.as_ref().map(|m| m.id), Some(10001001));
    assert_eq!(
        world.here_spots,
        vec![henesys.key.clone()],
        "Henesys Townstreet is on Henesys's spot"
    );
    assert_eq!(
        queries::map_page(pool, 10001000)
            .await
            .unwrap()
            .unwrap()
            .world_spot,
        Some(henesys.key.clone())
    );

    let path = vec![
        MapRef::new(10001000, "射手村", "Henesys"),
        MapRef::new(10001010, "射手训练场Ⅰ", "Henesys Hunting Ground I"),
        MapRef::new(10001011, "x", "x"),
    ];
    let overview = queries::route_overview(pool, &path).await.unwrap().unwrap();
    assert_eq!(overview.regions.len(), 1);
    assert!(overview.regions[0].stops.len() >= 2);

    // The monster finder's lookups.
    let one = |r: queries::MobResolution| match r {
        queries::MobResolution::One(m) => Some(m.id),
        queries::MobResolution::Many(_) => None,
    };
    assert_eq!(one(queries::resolve_mob(pool, "4").await.unwrap()), Some(4));
    assert_eq!(
        one(queries::resolve_mob(pool, "蓝蜗牛").await.unwrap()),
        Some(3)
    );
    assert_eq!(
        one(queries::resolve_mob(pool, "orange mushroom").await.unwrap()),
        Some(9)
    );
    assert!(
        one(queries::resolve_mob(pool, "蜗").await.unwrap()).is_none(),
        "several snails"
    );
    assert!(!queries::mob_spawn_maps(pool, 4).await.unwrap().is_empty());
}

async fn view_scene(pool: &sqlx::PgPool, map: i32) -> Option<SceneImage> {
    queries::map_view(pool, map, queries::Layers::ALL)
        .await
        .unwrap()
        .unwrap()
        .scene
}

#[tokio::test]
async fn unreleased_content_is_never_shown() {
    let Some(db) = common::test_db().await else {
        return;
    };
    let input = full(market_items());
    import_full(&db.pool, &input).await;
    let pool = &db.pool;
    let orbis = 20000000;
    let jr_sentinel = 1001;
    assert!(queries::map_page(pool, orbis).await.unwrap().is_none());
    assert!(queries::mob_page(pool, jr_sentinel)
        .await
        .unwrap()
        .is_none());
    let henesys = queries::map_page(pool, 10001000).await.unwrap().unwrap();
    assert!(henesys
        .exits
        .iter()
        .chain(&henesys.entrances)
        .all(|l| l.other.id != orbis));
    let blue_snail = queries::mob_page(pool, 3).await.unwrap().unwrap();
    assert_eq!(blue_snail.drops.len(), {
        input.data.drops.iter().filter(|d| d.mob_id == 3).count()
    });
    assert!(blue_snail.drops.iter().all(|d| d.votes.is_some()));
    let snail = queries::mob_page(pool, 2).await.unwrap().unwrap();
    assert_eq!(
        (&snail.drops[0].what, snail.drops[0].votes),
        (&DropTarget::Meso { min: 3, max: 4 }, Some(2)),
        "NiaDB's meso range comes first, with its report votes"
    );

    let hidden: Vec<i32> = sqlx::query_scalar("SELECT id FROM maps WHERE unreleased")
        .fetch_all(pool)
        .await
        .unwrap();
    assert_eq!(hidden.len(), 122, "with the two dead copies of town houses");
    let hits = queries::search(pool, "Orbis", Some(SearchKind::Map))
        .await
        .unwrap();
    assert!(hits.maps.rows.iter().all(|m| !hidden.contains(&m.id)));
    let hits = queries::search(pool, "Jr. Sentinel", Some(SearchKind::Mob))
        .await
        .unwrap();
    assert!(hits.mobs.rows.iter().all(|m| m.id != jr_sentinel));
    assert!(queries::load_edges(pool)
        .await
        .unwrap()
        .iter()
        .all(|e| e.from != orbis && e.to != orbis));

    let now = 1_793_000_000.0;
    let item = input
        .data
        .drops
        .iter()
        .find(|d| d.mob_id == jr_sentinel && d.item_id.is_some_and(|id| id / 1_000_000 == 4))
        .and_then(|d| d.item_id)
        .expect("a confirmed Jr. Sentinel drop");
    if let Some(page) = queries::item_page(pool, item, now).await.unwrap() {
        assert!(page.droppers.iter().all(|d| d.mob.id != jr_sentinel));
        assert!(page
            .droppers
            .iter()
            .flat_map(|d| &d.maps)
            .all(|m| m.id != orbis));
    }
    // Quests: open ones show on their items; Forgotten Hollow's and ended events' do not.
    let orange = queries::item_page(pool, 2010004, now)
        .await
        .unwrap()
        .unwrap();
    assert!(orange.quest_rewards.iter().any(|r| r.quest.id == 1019));
    let hidden_quests: Vec<i32> = sqlx::query_scalar(
        "SELECT id FROM quests WHERE unreleased OR ends_at < now() OR starts_at > now()",
    )
    .fetch_all(pool)
    .await
    .unwrap();
    assert!(hidden_quests.contains(&10601) && hidden_quests.len() > 20);
    for item in [2030007, 2000003, 2000006] {
        if let Some(page) = queries::item_page(pool, item, now).await.unwrap() {
            let shown = page.quest_rewards.iter().map(|r| r.quest.id);
            let shown: Vec<i32> = shown
                .chain(page.quest_needs.iter().map(|n| n.quest.id))
                .collect();
            assert!(
                shown.iter().all(|id| !hidden_quests.contains(id)),
                "item {item}: {shown:?}"
            );
        }
    }
    // Jr. Sentinel's tutorial quest asks to defeat it.
    let sentinel = queries::mob_page(pool, 1).await.unwrap();
    assert!(sentinel.is_none_or(|p| p.quests.iter().all(|q| q.quantity > 0)));
    let (npc, sold): (i32, i32) = sqlx::query_as(
        "SELECT s.npc_id, s.item_id FROM npc_shops s JOIN npcs n ON n.id = s.npc_id
         WHERE n.unreleased ORDER BY s.npc_id, s.item_id LIMIT 1",
    )
    .fetch_one(pool)
    .await
    .expect("an Orbis shop");
    if let Some(page) = queries::item_page(pool, sold, now).await.unwrap() {
        assert!(page.npc_offers.iter().all(|o| o.npc.id != npc));
    }
    db.drop_schema().await;
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
    let distinct: i64 = sqlx::query_scalar(
        "SELECT count(DISTINCT d.item_id) FROM drops d JOIN mobs m ON m.id = d.mob_id
         WHERE d.item_id IS NOT NULL AND NOT m.unreleased",
    )
    .fetch_one(&db.pool)
    .await
    .unwrap();
    assert_eq!(
        ids.len() as i64,
        distinct,
        "drops of unreleased mobs are not listed"
    );
    assert!(ids.windows(2).all(|w| w[0] < w[1]), "sorted and distinct");
    assert!(
        ids.contains(&4000001) && ids.contains(&1040001),
        "Snail Shell, White Undershirt"
    );

    let cached = get(&router, Some(&tag)).await;
    assert_eq!(cached.status(), StatusCode::NOT_MODIFIED);
    assert_eq!(cached.headers()[header::ETAG], tag.as_str());
    assert_eq!(
        cached.headers()[header::CACHE_CONTROL],
        "public, max-age=3600"
    );
    db.drop_schema().await;
}

/// Search reads names normalized at write time (`search_text`, migration
/// 0043). Over the whole imported catalogue it must hold exactly what the
/// per-row expression computed, and every keyword query must match the same
/// rows either way.
#[tokio::test]
async fn stored_search_text_matches_the_per_row_expression() {
    use market_web::search::{normalized_sql, patterns};
    let Some(db) = common::test_db().await else {
        return;
    };
    import_full(&db.pool, &full(market_items())).await;
    sqlx::query("UPDATE items SET name_en = 'Ｆｕｌｌ　Ｗｉｄｔｈ Cap' WHERE id = 1002000")
        .execute(&db.pool)
        .await
        .unwrap();
    let tables: [(&str, &[&str]); 3] = [
        ("items", &["name_zh", "name_en"]),
        ("mobs", &["name_zh", "name_tw", "name_en"]),
        ("maps", &["name_zh", "name_tw", "name_en"]),
    ];
    let mut queries: Vec<String> = [
        "",
        " ",
        "蘑菇",
        "绿水灵",
        "红色",
        "褐色 皮帽",
        "皮帽褐色",
        "移速宠物",
        "宠物 移动速度",
        "Snail",
        "snail shell",
        "SNAIL",
        "ｓｎａｉｌ",
        "full width",
        "ｆｕｌｌｗｉｄｔｈ",
        "1002000",
        "100",
        "Orbis",
        "jr. sentinel",
        "Jr.Sentinel",
        "50%",
        "a_b",
        "\\",
        "[",
        ".*",
        "(",
        "|",
        "?",
        "^",
        "$",
        "Henesys 射手村",
        "射手",
        "テスト",
        "ß",
        "İstanbul",
        "\u{1f}",
        "\u{3000}",
        "　蜗牛　",
    ]
    .iter()
    .map(|q| q.to_string())
    .collect();
    for (table, columns) in tables {
        let names: Vec<(Option<String>, Option<String>)> =
            sqlx::query_as(&format!("SELECT name_zh, name_en FROM {table} ORDER BY id"))
                .fetch_all(&db.pool)
                .await
                .unwrap();
        assert!(names.len() > 100, "{table} imported");
        // Fragments of real names: a Chinese prefix and an English word.
        for (zh, en) in names.iter().step_by(names.len() / 25) {
            if let Some(zh) = zh {
                queries.push(zh.chars().take(2).collect());
            }
            if let Some(word) = en.as_deref().and_then(|en| en.split_whitespace().last()) {
                queries.push(word.to_string());
            }
        }
        let normalized = normalized_sql("id", columns);
        let differing: i64 = sqlx::query_scalar(&format!(
            "SELECT count(*) FROM {table} WHERE search_text IS DISTINCT FROM {normalized}"
        ))
        .fetch_one(&db.pool)
        .await
        .unwrap();
        assert_eq!(differing, 0, "{table}");
    }
    for (table, columns) in tables {
        let normalized = normalized_sql("id", columns);
        for query in &queries {
            let ids = |condition: String| {
                let pool = db.pool.clone();
                let bound = patterns(query);
                async move {
                    sqlx::query_scalar::<_, i32>(&format!(
                        "SELECT id FROM {table} WHERE {condition} ~ ALL($1::text[]) ORDER BY id"
                    ))
                    .bind(bound)
                    .fetch_all(&pool)
                    .await
                    .unwrap()
                }
            };
            assert_eq!(
                ids(normalized.clone()).await,
                ids("search_text".into()).await,
                "{table} {query:?}"
            );
        }
    }
    db.drop_schema().await;
}

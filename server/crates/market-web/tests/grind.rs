mod common;
use common::TestDb;
use market_web::{
    grind::{self, Upload},
    unix_now,
};
use serde_json::json;

fn upload(now: f64, event: &str, segments: serde_json::Value) -> Upload {
    serde_json::from_value(json!({
        "event_id": event, "started_at": now - 3600., "ended_at": now, "segments": segments
    }))
    .unwrap()
}

fn segment(
    map: i32,
    level: i16,
    job: i32,
    seconds: i32,
    exp: i64,
    kills: i32,
) -> serde_json::Value {
    json!({"map_id": map, "job": job, "level": level, "active_seconds": seconds, "exp": exp,
           "kills": kills, "kills_estimated": false, "mesos": 1000, "item_value": 5000, "consume_cost": 500,
           "drops": [{"item_id": 4000019, "quantity": (kills / 10).max(1)}], "mobs": [{"mob_id": 1210100, "kills": kills}]})
}

#[test]
fn uploads_are_bounded_and_consistent() {
    let now = unix_now();
    let event = "0123456789abcdef0123456789abcdef";
    assert!(upload(
        now,
        event,
        json!([segment(104040000, 23, 410, 1800, 90000, 300)])
    )
    .valid(now));
    // Active time cannot exceed the run's span.
    assert!(!upload(
        now,
        event,
        json!([
            segment(1, 23, 410, 1800, 1, 1),
            segment(2, 23, 410, 1990, 1, 1)
        ])
    )
    .valid(now));
    // Event IDs are tracker run IDs: 32 hex digits.
    assert!(!upload(now, "short", json!([segment(1, 23, 410, 1800, 1, 1)])).valid(now));
    // Too-short segments are dropped by the tracker before upload.
    assert!(!upload(now, event, json!([segment(1, 23, 410, 30, 1, 1)])).valid(now));
    assert!(!upload(now, event, json!([])).valid(now));
    let mut duplicate = segment(1, 23, 410, 1800, 1, 20);
    duplicate["drops"] =
        json!([{"item_id": 4000019, "quantity": 1}, {"item_id": 4000019, "quantity": 2}]);
    assert!(!upload(now, event, json!([duplicate])).valid(now));
    // Unknown fields (a character name, say) are rejected outright.
    let mut named = segment(1, 23, 410, 1800, 1, 20);
    named["name"] = json!("Someone");
    assert!(serde_json::from_value::<Upload>(
        json!({"event_id": event, "started_at": now - 3600., "ended_at": now,
        "segments": [named]})
    )
    .is_err());
}

#[tokio::test]
async fn runs_store_once_and_map_results_group_by_level_band_and_job() {
    let Some(db) = TestDb::new().await else {
        return;
    };
    let who = db.collector("grinder").await;
    let now = unix_now();
    let map = 104040000;
    for (i, (level, job, exp)) in [
        (21, 410, 60000),
        (23, 410, 90000),
        (24, 410, 120000),
        (22, 200, 30000),
    ]
    .into_iter()
    .enumerate()
    {
        let run = upload(
            now,
            &format!("{i:032x}"),
            json!([segment(map, level, job, 1800, exp, 200)]),
        );
        assert!(grind::ingest(&db.pool, who.id, &run).await.unwrap());
    }
    // The same run uploaded twice counts once.
    let again = upload(
        now,
        &format!("{:032x}", 0),
        json!([segment(map, 21, 410, 1800, 60000, 200)]),
    );
    assert!(!grind::ingest(&db.pool, who.id, &again).await.unwrap());
    // Short segments are stored but not shown.
    let short = upload(
        now,
        &format!("{:032x}", 9),
        json!([segment(map, 23, 410, 120, 999999, 10)]),
    );
    assert!(grind::ingest(&db.pool, who.id, &short).await.unwrap());

    let summary = grind::map_summary(&db.pool, map, now).await.unwrap();
    let groups = summary["groups"].as_array().unwrap();
    assert_eq!(groups.len(), 2, "{summary}");
    let thief = groups.iter().find(|g| g["job"] == 410).unwrap();
    assert_eq!(thief["level_from"], 21);
    assert_eq!(thief["level_to"], 25);
    assert_eq!(thief["sessions"], 3);
    // 60k, 90k, 120k EXP in half an hour: 120k / 180k / 240k per hour.
    assert_eq!(thief["exp_per_hour"][1].as_f64().unwrap().round(), 180000.0);
    assert_eq!(thief["exp_per_hour"][0].as_f64().unwrap().round(), 150000.0);
    // (1000 + 5000 - 500) per half hour.
    assert_eq!(thief["net_per_hour"][1].as_f64().unwrap().round(), 11000.0);
    assert_eq!(summary["kills"], 800);
    let drop = &summary["drops"][0];
    assert_eq!(drop["item_id"], 4000019);
    assert_eq!(drop["quantity"], 80);
    assert_eq!(drop["per_1000_kills"].as_f64().unwrap().round(), 100.0);
    db.close().await;
}

#[tokio::test]
async fn equipment_prices_use_the_item_page_groups() {
    let Some(db) = TestDb::new().await else {
        return;
    };
    let now = unix_now();
    sqlx::query("INSERT INTO items (id, name_en, name_zh, category) VALUES (1082002, 'Work Gloves', '工地手套', '装备') ON CONFLICT DO NOTHING")
        .execute(&db.pool)
        .await
        .unwrap();
    let rows = grind::price_rows(&db.pool, &[1082002], &[], &[], now)
        .await
        .unwrap();
    let row = &rows["prices"]["1082002"];
    assert_eq!(row["name"], "工地手套");
    assert_eq!(row["groups"], json!([]));
    // The group key is the tracker's: attributes other than defence, sorted,
    // then remaining upgrades and the unknown field count.
    let key = market_web::bestiary::queries::equipment_group_json(&json!({
        "status": "candidate", "remaining_upgrades": 5, "unknown_fields": [],
        "stats": [{"key": "weapon_defense", "label": "物理防御", "value": 2},
                  {"key": "weapon_attack", "label": "物理攻击", "value": 2},
                  {"key": "dex", "label": "敏捷", "value": 1}]}));
    assert_eq!(key, r#"[[["dex",1],["weapon_attack",2]],5,0]"#);
    db.close().await;
}

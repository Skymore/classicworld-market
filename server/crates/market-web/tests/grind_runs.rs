mod common;
use common::TestDb;
use market_web::{grind, grind_runs, unix_now};
use serde_json::{json, Value};

fn run(now: f64, id: char, exp: i64) -> Value {
    json!({"id": id.to_string().repeat(32), "started_at": now - 4000.0, "ended_at": now - 100.0,
        "active_seconds": 3600, "exp": exp, "net": 20000, "kills": 500, "map_id": 10004141, "map_name": "第2军营",
        "exp_per_hour": exp, "net_per_hour": 20000, "mesos": 15000, "level": 68, "job_name": "猎人",
        "character": {"name": "Skyyyy", "key": "Skyyyy", "level": 68, "job": 310},
        "loot": [{"item_id": 4000049, "quantity": 664, "value": 38000}],
        "drops": [{"item_id": 4000049, "quantity": 664, "value": 38000}]})
}

async fn account(db: &TestDb, name: &str) -> i64 {
    sqlx::query_scalar("INSERT INTO accounts (public_id, google_sub) VALUES ($1, $1) RETURNING id")
        .bind(name)
        .fetch_one(&db.pool)
        .await
        .unwrap()
}

#[tokio::test]
async fn runs_sync_once_share_by_code_and_list_only_for_the_linked_account() {
    let Some(db) = TestDb::new().await else {
        return;
    };
    let now = unix_now();
    let mine = db.collector("mine").await;
    let other = db.collector("other").await;
    let me = account(&db, "me").await;
    let them = account(&db, "them").await;
    sqlx::query("UPDATE collectors SET account_id=$1 WHERE id=$2")
        .bind(me)
        .bind(mine.id)
        .execute(&db.pool)
        .await
        .unwrap();
    sqlx::query("UPDATE collectors SET account_id=$1 WHERE id=$2")
        .bind(them)
        .bind(other.id)
        .execute(&db.pool)
        .await
        .unwrap();

    let first = grind_runs::store(&db.pool, mine.id, &run(now, 'a', 196000), now)
        .await
        .unwrap()
        .unwrap();
    // The same run synced again updates the row instead of adding one.
    let again = grind_runs::store(&db.pool, mine.id, &run(now, 'a', 200000), now)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(first, again);
    grind_runs::store(&db.pool, other.id, &run(now, 'b', 1), now)
        .await
        .unwrap()
        .unwrap();
    assert!(
        grind_runs::store(&db.pool, mine.id, &json!({"id": "nope"}), now)
            .await
            .unwrap()
            .is_none()
    );

    assert!(grind_runs::owns(&db.pool, me, first).await.unwrap());
    assert!(!grind_runs::owns(&db.pool, them, first).await.unwrap());

    let listed = grind_runs::runs_of(&db.pool, me, 50).await.unwrap();
    let rows = listed.as_array().unwrap();
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0]["exp"], 200000);
    assert!(
        rows[0].get("loot").is_none(),
        "list rows leave out the bulky detail"
    );

    // One code per run and option set; hidden fields stay hidden.
    let code = grind_runs::share_code(&db.pool, first, false, false)
        .await
        .unwrap();
    assert_eq!(
        grind_runs::share_code(&db.pool, first, false, false)
            .await
            .unwrap(),
        code
    );
    assert_ne!(
        grind_runs::share_code(&db.pool, first, true, true)
            .await
            .unwrap(),
        code
    );
    let shared = grind_runs::load_share(&db.pool, &code, now)
        .await
        .unwrap()
        .unwrap();
    assert!(shared["run"]["character"].get("name").is_none());
    assert!(shared["run"].get("net").is_none());
    assert_eq!(
        shared["run"]["drops"][0],
        json!({"item_id": 4000049, "quantity": 664})
    );
    assert_eq!(shared["views"], 1);
    assert_eq!(
        shared["comparison"],
        Value::Null,
        "no comparable uploads yet"
    );
    assert!(grind_runs::load_share(&db.pool, "zzzzzzz", now)
        .await
        .unwrap()
        .is_none());
    let (title, _) = grind_runs::preview(&shared);
    assert_eq!(title, "一位猎人在第2军营刷了1小时0分 · 枫叶市集");
    db.close().await;
}

#[tokio::test]
async fn leaderboard_and_comparison_use_the_map_uploads() {
    let Some(db) = TestDb::new().await else {
        return;
    };
    let now = unix_now();
    let who = db.collector("grinder").await;
    for (i, exp) in [60000, 90000, 120000, 150000, 180000]
        .into_iter()
        .enumerate()
    {
        let upload: grind::Upload = serde_json::from_value(json!({"event_id": format!("{i:032x}"),
            "started_at": now - 3600., "ended_at": now, "segments": [{"map_id": 10004141, "job": 310, "level": 68,
            "active_seconds": 1800, "exp": exp, "kills": 200, "kills_estimated": false, "mesos": 1000,
            "item_value": 5000, "consume_cost": 500}]})).unwrap();
        assert!(grind::ingest(&db.pool, who.id, &upload).await.unwrap());
    }
    let board = grind_runs::leaderboard_rows(&db.pool, Some(66), None, now)
        .await
        .unwrap();
    assert_eq!(board[0]["map_id"], 10004141);
    assert_eq!(board[0]["runs"], 5);
    assert_eq!(board[0]["exp_per_hour"].as_f64().unwrap().round(), 240000.0);
    // 196k/h beats 120k and 180k... per hour: 120k, 180k beat; 240k, 300k, 360k do not.
    let compared = grind_runs::comparison(&db.pool, &run(now, 'c', 196000), now)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(compared["job"], 310);
    assert_eq!(compared["runs"], 5);
    assert_eq!(compared["exp_better_than"].as_f64().unwrap(), 0.4);
    db.close().await;
}

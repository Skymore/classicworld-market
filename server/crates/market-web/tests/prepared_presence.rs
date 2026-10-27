mod common;
use market_web::{
    presence::{self, Place},
    roster::{self, Roster},
};
use serde_json::Value;
use sqlx::postgres::PgPoolOptions;

fn bounded_scans(node: &Value, table: &str, maximum: u64) -> u64 {
    let mut scans = 0;
    if node["Relation Name"] == table {
        let loops = node["Actual Loops"].as_u64().unwrap();
        let visited = node["Actual Rows"].as_u64().unwrap()
            + node["Rows Removed by Filter"].as_u64().unwrap_or_default();
        assert!(
            visited * loops <= maximum,
            "scanned unrelated {table} rows: {node}"
        );
        scans += loops;
    }
    if let Some(children) = node["Plans"].as_array() {
        scans += children
            .iter()
            .map(|child| bounded_scans(child, table, maximum))
            .sum::<u64>();
    }
    scans
}

#[tokio::test]
async fn warmed_presence_writes_only_visit_the_selected_room_owner_or_shop() {
    let Some(db) = common::TestDb::new().await else {
        return;
    };
    for statement in [
        "INSERT INTO items(id,name_en,category) VALUES(4010001,'Target','etc'),(4010002,'Other','etc')",
        "INSERT INTO collectors(id,public_id,token_hash,source) VALUES(1,'fixture','\\x01','packet')",
        "INSERT INTO shops(id,shop_key,world,shop_id,title,first_seen_at,last_seen_at,public_key,
          channel,room,owner_character_id,owner_name)
          SELECT i,i::text,'ClassicWorld',i,'Shop','2026-10-25Z','2026-10-25Z',i::text,
            CASE WHEN i<=2 THEN 1 ELSE 3+i%200 END,CASE WHEN i<=2 THEN 1 ELSE 1+i%22 END,i,'Host'||i
          FROM generate_series(1,5000) i",
        "INSERT INTO observations(id,observation_id,collector_id,shop_id,source,observed_at,fingerprint,visit_key)
          SELECT i,i::text,1,i,'packet','2026-10-25Z',i::text,i::text FROM generate_series(1,5000) i",
        "INSERT INTO listings(shop_id,observation_id,slot,item_id,price,bundle,stock,first_seen_at,last_seen_at)
          SELECT i,i,1,CASE WHEN i<=2 THEN 4010001 ELSE 4010002 END,100,1,5,
            '2026-10-25Z','2026-10-25Z' FROM generate_series(1,5000) i",
        "INSERT INTO room_rosters(collector_id,event_id,world,channel,room,started_at,observed_at,character_ids)
          SELECT 1,md5(i::text),'ClassicWorld',3+i%200,1+i%22,'2026-10-25 01:00Z','2026-10-25 01:00Z',ARRAY[i::bigint]
          FROM generate_series(3,5000) i",
        "UPDATE market_state SET as_of='2026-10-25 01:00Z'",
        "ANALYZE shops", "ANALYZE observations", "ANALYZE listings", "ANALYZE room_rosters",
    ] { sqlx::query(statement).execute(&db.pool).await.unwrap(); }
    let pool = PgPoolOptions::new()
        .max_connections(1)
        .connect_with((*db.pool.connect_options()).clone())
        .await
        .unwrap();
    sqlx::query("SET plan_cache_mode=force_generic_plan")
        .execute(&pool)
        .await
        .unwrap();
    let now = chrono::DateTime::parse_from_rfc3339("2026-10-25T01:00:00Z")
        .unwrap()
        .timestamp() as f64;
    let event = Roster {
        version: 1,
        world: "ClassicWorld".into(),
        event_id: "f".repeat(32),
        location: Place {
            channel: 1,
            room: 1,
        },
        started_at: now,
        observed_at: now,
        character_ids: vec![2],
        complete: true,
        parser: "cw_room_roster_v1".into(),
    };
    assert!(roster::ingest(&pool, 1, &event, now).await.unwrap());
    let count: i64 = sqlx::query_scalar("SELECT count(*) FROM listings")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(count, 4999);
    let event_sql: String = sqlx::query_scalar("SELECT statement FROM pg_prepared_statements
        WHERE statement LIKE 'INSERT INTO player_departures%' AND statement LIKE '%r.event_id=$1%' LIMIT 1")
        .fetch_one(&pool).await.unwrap();
    let plan: Value = sqlx::query_scalar(&format!(
        "EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON) {event_sql}"
    ))
    .bind(&event.event_id)
    .bind(1_i64)
    .fetch_one(&pool)
    .await
    .unwrap();
    for (table, maximum) in [("room_rosters", 1), ("shops", 2), ("observations", 2)] {
        assert!(bounded_scans(&plan[0]["Plan"], table, maximum) > 0);
    }
    let mut connection = pool.acquire().await.unwrap();
    roster::reconcile(&mut connection, Some(1), None)
        .await
        .unwrap();
    drop(connection);
    let shop_sql: String = sqlx::query_scalar("SELECT statement FROM pg_prepared_statements
        WHERE statement LIKE 'INSERT INTO player_departures%' AND statement LIKE '%s.id=$1%' LIMIT 1")
        .fetch_one(&pool).await.unwrap();
    let plan: Value =
        sqlx::query_scalar(&format!("EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON) {shop_sql}"))
            .bind(1_i64)
            .fetch_one(&pool)
            .await
            .unwrap();
    for table in ["shops", "room_rosters", "observations"] {
        assert!(bounded_scans(&plan[0]["Plan"], table, 2) > 0);
    }
    // Restore only this synthetic listing, then roll each actual DELETE back.
    // Both the candidate lookup and the delete join must stay bounded.
    sqlx::query("INSERT INTO listings(shop_id,observation_id,slot,item_id,price,bundle,stock,first_seen_at,last_seen_at)
        VALUES(1,1,1,4010001,100,1,5,'2026-10-25Z','2026-10-25Z')").execute(&pool).await.unwrap();
    for scope in ["shop", "owner", "room"] {
        let mut tx = pool.begin().await.unwrap();
        let items = match scope {
            "shop" => presence::expire(&mut tx, Some(1), None).await,
            "owner" => presence::expire(&mut tx, None, Some(1)).await,
            _ => {
                presence::expire_room(
                    &mut tx,
                    &Place {
                        channel: 1,
                        room: 1,
                    },
                )
                .await
            }
        }
        .unwrap();
        assert_eq!(items, vec![4010001]);
        tx.rollback().await.unwrap();
        let needle = match scope {
            "shop" => "% AND id=$1%",
            "owner" => "% AND owner_character_id=$1%",
            _ => "% AND channel=$1%",
        };
        let statement: String = sqlx::query_scalar("SELECT statement FROM pg_prepared_statements
            WHERE statement LIKE 'WITH scoped_shops AS MATERIALIZED (%' AND statement LIKE $1 LIMIT 1")
            .bind(needle).fetch_one(&pool).await.unwrap();
        let explain = format!("EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON) {statement}");
        let mut tx = pool.begin().await.unwrap();
        let plan: Value = if scope == "room" {
            sqlx::query_scalar(&explain)
                .bind(1_i16)
                .bind(1_i16)
                .fetch_one(&mut *tx)
                .await
                .unwrap()
        } else {
            sqlx::query_scalar(&explain)
                .bind(1_i64)
                .fetch_one(&mut *tx)
                .await
                .unwrap()
        };
        tx.rollback().await.unwrap();
        for table in ["shops", "listings", "observations", "player_departures"] {
            assert!(bounded_scans(&plan[0]["Plan"], table, 4) > 0);
        }
    }
    pool.close().await;
    db.close().await;
}

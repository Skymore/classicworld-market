mod common;
use axum::{
    body::Body,
    http::{Request, StatusCode},
};
use common::TestDb;
use http_body_util::BodyExt;
use market_web::{app, auth, contributors, unix_now, AppState, Settings};
use serde_json::{json, Value};
use tower::ServiceExt;

#[tokio::test]
async fn account_totals_deduplicate_on_write_and_do_not_read_device_history() {
    let Some(db) = TestDb::new().await else { return };
    let state = AppState::new(db.pool.clone(), Settings::default());
    let a = auth::register(&db.pool, "account-rollup-a").await.unwrap();
    let b = auth::register(&db.pool, "account-rollup-b").await.unwrap();
    let owner: i64 = sqlx::query_scalar(
        "INSERT INTO accounts(public_id,google_sub) VALUES('rollup-owner','rollup-google') RETURNING id",
    ).fetch_one(&db.pool).await.unwrap();
    let now = unix_now();
    // Linking must include old captures; repeated devices must not double count.
    upload(&state, &a.token, "old-a", 101, now-60.0).await;
    upload(&state, &b.token, "old-b", 101, now-60.0).await;
    upload(&state, &b.token, "unique-b", 102, now-60.0).await;
    sqlx::query("UPDATE collectors SET account_id=$1").bind(owner)
        .execute(&db.pool).await.unwrap();
    let credentials = auth::new_credentials();
    contributors::new_session(&db.pool, owner, &credentials.token).await.unwrap();
    let cookie = [("cookie", format!("cwm_account={}", credentials.token))];
    let mut history = db.pool.begin().await.unwrap();
    sqlx::query("LOCK contribution_states IN ACCESS EXCLUSIVE MODE")
        .execute(&mut *history).await.unwrap();
    let response = tokio::time::timeout(std::time::Duration::from_secs(2),
        request(&state, "GET", "/api/v1/account", Value::Null, &cookie)).await
        .expect("profile must read account summaries, even when device history is locked");
    assert_eq!(response.0, StatusCode::OK);
    assert_eq!(response.2["stats"], json!({"shops":2,"quotes":2}));
    history.rollback().await.unwrap();

    upload(&state, &a.token, "live-a", 103, now-30.0).await;
    let ids: Vec<i64> = sqlx::query_scalar("SELECT id FROM collectors ORDER BY id")
        .fetch_all(&db.pool).await.unwrap();
    async fn check(db: &sqlx::PgPool, ids: &[i64], at: f64) {
        let cached: Vec<(i64,i64)> = sqlx::query_as(
            "SELECT * FROM contribution_shop_counts($1,0,to_timestamp($2)) ORDER BY shop_id")
            .bind(ids).bind(at).fetch_all(db).await.unwrap();
        let exact: Vec<(i64,i64)> = sqlx::query_as(
            "SELECT shop_id,count(*) FROM (SELECT DISTINCT shop_id,slot,item_id,variant_id,price,bundle,stock
             FROM contribution_states WHERE collector_id=ANY($1) AND first_seen<=to_timestamp($2)) s
             GROUP BY shop_id ORDER BY shop_id")
            .bind(ids).bind(at).fetch_all(db).await.unwrap();
        assert_eq!(cached,exact,"at={at} ids={ids:?}");
    }
    check(&db.pool, &ids, unix_now()).await;
    // Only future first-seen times expire cumulative totals; weekly expiry does not.
    upload(&state, &a.token, "future-a", 104, now+60.0).await;
    for at in [now-90.0,unix_now(),now+59.999,now+60.0,now+31.0*86400.0] {
        check(&db.pool,&ids,at).await;
    }
    sqlx::query("UPDATE collectors SET active=false WHERE id=$1")
        .bind(ids[1]).execute(&db.pool).await.unwrap();
    check(&db.pool,&ids[..1],unix_now()).await;
    // Removing a duplicate device retains the remaining copy; deleting states
    // and unlinking a device both update the derived account totals.
    sqlx::query("DELETE FROM contribution_states WHERE collector_id=$1 AND shop_id IN
        (SELECT id FROM shops WHERE shop_id=101)")
        .bind(ids[0]).execute(&db.pool).await.unwrap();
    check(&db.pool,&ids,unix_now()).await;
    sqlx::query("UPDATE collectors SET account_id=NULL WHERE id=$1")
        .bind(ids[1]).execute(&db.pool).await.unwrap();
    check(&db.pool,&ids[..1],unix_now()).await;
    check(&db.pool,&ids[1..],unix_now()).await;
    // Exercise upgrading an existing populated database, rather than only
    // installing empty tables and then recording new observations.
    sqlx::raw_sql(include_str!("../../../tools/rollback_account_contribution_rollups.sql"))
        .execute(&db.pool).await.unwrap();
    let mut upgrade = db.pool.begin().await.unwrap();
    sqlx::raw_sql(include_str!("../../../migrations/0044_account_contribution_rollups.sql"))
        .execute(&mut *upgrade).await.unwrap();
    upgrade.commit().await.unwrap();
    check(&db.pool,&ids[..1],unix_now()).await;
    check(&db.pool,&ids[1..],unix_now()).await;
    db.close().await;
}

#[tokio::test]
async fn expired_rollup_reads_only_its_shop_states() {
    let Some(db) = TestDb::new().await else { return };
    let state = AppState::new(db.pool.clone(), Settings::default());
    let credentials = auth::register(&db.pool, "expiry-plan").await.unwrap();
    let now = unix_now();
    upload(&state, &credentials.token, "small", 101, now-60.0).await;
    // Unrelated history must not be read to recount one expired shop.
    sqlx::query("INSERT INTO shops(shop_key,public_key,world,shop_id,title,first_seen_at,last_seen_at)
        SELECT 'history-'||n,'history-'||n,'ClassicWorld',1000+n,'History',now(),now()
        FROM generate_series(1,500) n")
        .execute(&db.pool).await.unwrap();
    sqlx::query("INSERT INTO contribution_states
        SELECT collector_id,s.id,slot,item_id,variant_id,price,bundle,n,
               first_seen,week_windows,month_windows
        FROM contribution_states CROSS JOIN shops s CROSS JOIN generate_series(10,19) n
        WHERE s.shop_key LIKE 'history-%'")
        .execute(&db.pool).await.unwrap();
    sqlx::query("UPDATE contribution_shop_rollups SET valid_until=now()-interval '1 second'
        WHERE shop_id=(SELECT min(shop_id) FROM contribution_states)")
        .execute(&db.pool).await.unwrap();
    sqlx::query("ANALYZE contribution_states").execute(&db.pool).await.unwrap();
    sqlx::query("ANALYZE contribution_shop_rollups").execute(&db.pool).await.unwrap();
    let ids: Vec<i64> = sqlx::query_scalar("SELECT id FROM collectors")
        .fetch_all(&db.pool).await.unwrap();
    for period in [0,7,30] {
        let (shops,quotes): (i64,i64) = sqlx::query_as(
            "SELECT count(*),sum(quotes)::bigint FROM contribution_shop_counts($1,$2,now())")
            .bind(&ids).bind(period).fetch_one(&db.pool).await.unwrap();
        assert_eq!((shops,quotes),(501,5001));
        // The public dispatcher is PL/pgSQL; inspect the SQL device branch
        // directly so EXPLAIN still exposes its exact history scan count.
        let plan: Value = sqlx::query_scalar(
            "EXPLAIN (ANALYZE,FORMAT JSON) SELECT * FROM contribution_device_shop_counts($1,$2,now())")
            .bind(&ids).bind(period).fetch_one(&db.pool).await.unwrap();
        fn examined(node: &Value) -> u64 {
            let own = if node["Relation Name"] == "contribution_states" {
                assert_ne!(node["Node Type"],"Seq Scan","{node}");
                node["Actual Rows"].as_u64().unwrap_or(0)*node["Actual Loops"].as_u64().unwrap_or(0)
            } else { 0 };
            own + node["Plans"].as_array().map(|p|p.iter().map(examined).sum()).unwrap_or(0)
        }
        assert_eq!(examined(&plan[0]["Plan"]),1,"{plan}");
    }
    db.close().await;
}

#[tokio::test]
async fn shop_rollups_match_exact_states_across_devices_and_window_boundaries() {
    let Some(db) = TestDb::new().await else { return };
    let state = AppState::new(db.pool.clone(), Settings::default());
    let a = auth::register(&db.pool, "rollup-a").await.unwrap();
    let b = auth::register(&db.pool, "rollup-b").await.unwrap();
    let now = unix_now();
    for (index, offset) in [-29.0*86400.0, -8.0*86400.0, -60.0, 60.0].into_iter().enumerate() {
        upload(&state, &a.token, &format!("a-{index}"), 101, now+offset).await;
        upload(&state, &b.token, &format!("b-{index}"), 101, now+offset).await;
    }
    upload(&state, &b.token, "b-unique", 102, now-60.0).await;
    upload(&state, &a.token, "a-future", 103, now+60.0).await;
    let ids: Vec<i64> = sqlx::query_scalar("SELECT id FROM collectors ORDER BY id")
        .fetch_all(&db.pool).await.unwrap();
    for selected in [&ids[..1], &ids[..]] {
        for period in [0, 7, 30] {
            for offset in [-36.0*86400.0, -86400.0, 0.0, 59.999, 60.0,
                7.0*86400.0+60.0,7.0*86400.0+60.001,31.0*86400.0] {
                let at = now+offset;
                let cached: Vec<(i64,i64)> = sqlx::query_as(
                    "SELECT * FROM contribution_shop_counts($1,$2,to_timestamp($3)) ORDER BY shop_id")
                    .bind(selected).bind(period).bind(at).fetch_all(&db.pool).await.unwrap();
                let exact: Vec<(i64,i64)> = sqlx::query_as(
                    "SELECT shop_id,count(*) FROM (SELECT DISTINCT shop_id,slot,item_id,variant_id,price,bundle,stock
                     FROM contribution_states WHERE collector_id=ANY($1) AND CASE $2 WHEN 0 THEN first_seen<=to_timestamp($3)
                       WHEN 7 THEN week_windows @> to_timestamp($3) ELSE month_windows @> to_timestamp($3) END) states
                     GROUP BY shop_id ORDER BY shop_id")
                    .bind(selected).bind(period).bind(at).fetch_all(&db.pool).await.unwrap();
                assert_eq!(cached,exact,"period={period} offset={offset} devices={}",selected.len());
            }
        }
    }
    db.close().await;
}

async fn request(
    state: &AppState,
    method: &str,
    path: &str,
    body: Value,
    headers: &[(&str, String)],
) -> (StatusCode, axum::http::HeaderMap, Value) {
    let mut req = Request::builder()
        .method(method)
        .uri(path)
        .header("content-type", "application/json");
    for (k, v) in headers {
        req = req.header(*k, v);
    }
    let r = app(state.clone())
        .oneshot(req.body(Body::from(body.to_string())).unwrap())
        .await
        .unwrap();
    let code = r.status();
    let headers = r.headers().clone();
    let bytes = r.into_body().collect().await.unwrap().to_bytes();
    (
        code,
        headers,
        serde_json::from_slice(&bytes).unwrap_or(Value::Null),
    )
}
async fn profile(state: &AppState, token: &str, name: &str, listed: bool) -> StatusCode {
    request(
        state,
        "POST",
        "/api/v1/collector/profile",
        json!({"nickname":name,"listed":listed}),
        &[("authorization", format!("Bearer {token}"))],
    )
    .await
    .0
}
async fn upload(state: &AppState, token: &str, id: &str, shop: i64, when: f64) {
    let body = json!({"version":1,"world":"ClassicWorld","complete":true,"observation_id":id,"observed_at":when,"shop_id":shop,"title":format!("Shop {shop}"),"location":{"channel":30,"room":3},
      "items":[{"item_id":4010001,"category":4,"slot":1,"price":100,"bundle":1,"stock":5}]});
    let result = request(
        state,
        "POST",
        "/api/v1/observations",
        body,
        &[("authorization", format!("Bearer {token}"))],
    )
    .await;
    assert_eq!(result.0, StatusCode::CREATED, "{}", result.2);
}

#[tokio::test]
async fn contributions_update_on_commit_without_a_time_cache_or_history_reads() {
    let Some(db) = TestDb::new().await else {
        return;
    };
    let state = AppState::new(db.pool.clone(), Settings::default());
    let credentials = auth::register(&db.pool, "realtime").await.unwrap();
    let token = &credentials.token;
    let headers = [("authorization", format!("Bearer {token}"))];
    for period in ["week", "month", "all"] {
        let board = request(
            &state,
            "GET",
            &format!("/api/v1/contributors?period={period}"),
            Value::Null,
            &[],
        )
        .await
        .2;
        assert_eq!(board["contributors"], json!([]));
    }
    assert_eq!(
        request(
            &state,
            "GET",
            "/api/v1/collector/profile",
            Value::Null,
            &headers
        )
        .await
        .2["stats"]["quotes"],
        0
    );
    let mut listener = sqlx::postgres::PgListener::connect_with(&db.pool)
        .await
        .unwrap();
    listener.listen("market_changed").await.unwrap();
    let now = unix_now();
    upload(&state, token, "live-first", 101, now - 60.).await;
    tokio::time::timeout(std::time::Duration::from_secs(2), listener.recv())
        .await
        .unwrap()
        .unwrap();
    for period in ["week", "month", "all"] {
        let board = request(
            &state,
            "GET",
            &format!("/api/v1/contributors?period={period}"),
            Value::Null,
            &[],
        )
        .await
        .2;
        assert_eq!(board["contributors"][0]["shops"], 1);
        assert_eq!(
            board["contributors"][0]["quotes"], 1,
            "first push must not return cached zero"
        );
    }
    assert_eq!(
        request(
            &state,
            "GET",
            "/api/v1/collector/profile",
            Value::Null,
            &headers
        )
        .await
        .2["stats"]["quotes"],
        1
    );
    upload(&state, token, "live-second", 102, now - 40.).await;
    let board = request(&state, "GET", "/api/v1/contributors", Value::Null, &[])
        .await
        .2;
    assert_eq!(
        board["contributors"][0]["shops"], 2,
        "next upload immediately invalidates the populated cache"
    );
    let burst = futures_util::future::join_all(
        (0..80).map(|_| request(&state, "GET", "/api/v1/contributors", Value::Null, &[])),
    )
    .await;
    assert!(burst.iter().all(
        |(status, _, body)| *status == StatusCode::OK && body["contributors"][0]["shops"] == 2
    ));
    upload(&state, token, "live-repeat", 102, now - 20.).await;
    upload(&state, token, "live-old", 103, now - 9. * 86400.).await;
    upload(&state, token, "live-future", 104, now + 60.).await;
    // Latest timestamp alone would incorrectly discard this valid prior visit.
    upload(&state, token, "live-future-repeat", 101, now + 80.).await;
    for (period, expected) in [("week", 2), ("month", 3), ("all", 3)] {
        let board = request(
            &state,
            "GET",
            &format!("/api/v1/contributors?period={period}"),
            Value::Null,
            &[],
        )
        .await
        .2;
        assert_eq!(board["contributors"][0]["shops"], expected);
        assert_eq!(board["contributors"][0]["quotes"], expected);
    }
    // Changing the state counts as an additional quote, without another shop.
    let changed = json!({"version":1,"world":"ClassicWorld","complete":true,"observation_id":"live-changed","observed_at":now-5.,"shop_id":102,"title":"Shop 102","location":{"channel":30,"room":3},"items":[{"item_id":4010001,"category":4,"slot":1,"price":90,"bundle":1,"stock":4}]});
    assert_eq!(
        request(&state, "POST", "/api/v1/observations", changed, &headers)
            .await
            .0,
        StatusCode::CREATED
    );
    // Fresh service + locked raw history: statistics must use the incrementally
    // maintained summaries, not merely a warmed in-process response cache.
    let fresh = AppState::new(db.pool.clone(), Settings::default());
    let mut locked = db.pool.begin().await.unwrap();
    sqlx::raw_sql("LOCK TABLE observations,observation_rows IN ACCESS EXCLUSIVE MODE")
        .execute(&mut *locked)
        .await
        .unwrap();
    let board = tokio::time::timeout(
        std::time::Duration::from_secs(2),
        request(&fresh, "GET", "/api/v1/contributors", Value::Null, &[]),
    )
    .await
    .unwrap()
    .2;
    assert_eq!(board["contributors"][0]["shops"], 2);
    assert_eq!(board["contributors"][0]["quotes"], 3);
    let own = tokio::time::timeout(
        std::time::Duration::from_secs(2),
        request(
            &fresh,
            "GET",
            "/api/v1/collector/profile",
            Value::Null,
            &headers,
        ),
    )
    .await
    .unwrap()
    .2;
    assert_eq!(own["stats"], json!({"shops":3,"quotes":4}));
    locked.rollback().await.unwrap();
    drop(listener);
    db.close().await;
}

#[tokio::test]
async fn contribution_windows_preserve_gaps_boundaries_and_backfill() {
    let Some(db) = TestDb::new().await else {
        return;
    };
    let state = AppState::new(db.pool.clone(), Settings::default());
    let credentials = auth::register(&db.pool, "windows").await.unwrap();
    let now = unix_now();
    upload(&state, &credentials.token, "old", 201, now - 9. * 86400.).await;
    upload(&state, &credentials.token, "future", 201, now + 60.).await;
    let exact: bool = sqlx::query_scalar("SELECT NOT(week_windows @> now()) AND month_windows @> now() AND week_windows @> first_seen AND week_windows @> (first_seen+interval '7 days') FROM contribution_states").fetch_one(&db.pool).await.unwrap();
    assert!(
        exact,
        "a future repeat must not bridge a gap in a rolling window"
    );
    let before: String = sqlx::query_scalar(
        "SELECT json_agg(s ORDER BY collector_id,shop_id,slot)::text FROM contribution_states s",
    )
    .fetch_one(&db.pool)
    .await
    .unwrap();
    let days_before: String = sqlx::query_scalar(
        "SELECT json_agg(d ORDER BY collector_id,day)::text FROM contribution_days d",
    )
    .fetch_one(&db.pool)
    .await
    .unwrap();
    let mut tx = db.pool.begin().await.unwrap();
    sqlx::raw_sql("DROP TRIGGER contribution_rows_inserted ON observation_rows; DROP TRIGGER contribution_shop_moved ON observations; DROP FUNCTION record_inserted_contributions(); DROP FUNCTION move_contribution_shop(); DROP FUNCTION record_contribution(bigint); DROP FUNCTION rebuild_contribution_shop(bigint,bigint); DROP TABLE contribution_states,contribution_days;").execute(&mut *tx).await.unwrap();
    sqlx::raw_sql(include_str!(
        "../../../migrations/0026_contribution_summaries.sql"
    ))
    .execute(&mut *tx)
    .await
    .unwrap();
    let after: String = sqlx::query_scalar(
        "SELECT json_agg(s ORDER BY collector_id,shop_id,slot)::text FROM contribution_states s",
    )
    .fetch_one(&mut *tx)
    .await
    .unwrap();
    let days_after: String = sqlx::query_scalar(
        "SELECT json_agg(d ORDER BY collector_id,day)::text FROM contribution_days d",
    )
    .fetch_one(&mut *tx)
    .await
    .unwrap();
    assert_eq!(before, after);
    assert_eq!(days_before, days_after);
    tx.rollback().await.unwrap();
    db.close().await;
}
#[tokio::test]
async fn nickname_board_preserves_identity_deduplicates_and_honors_privacy() {
    let Some(db) = TestDb::new().await else {
        return;
    };
    let state = AppState::new(db.pool.clone(), Settings::default());
    let a = auth::register(&db.pool, "legacy anonymous").await.unwrap();
    let b = auth::register(&db.pool, "other").await.unwrap();
    let now = unix_now();
    upload(&state, &a.token, "a1", 77, now - 120.).await;
    upload(&state, &a.token, "a2", 77, now - 60.).await;
    upload(&state, &a.token, "a3", 78, now - 9. * 86400.).await;
    upload(&state, &b.token, "b1", 79, now - 60.).await;
    let initial = request(&state, "GET", "/api/v1/contributors", Value::Null, &[])
        .await
        .2;
    assert_eq!(initial["contributors"].as_array().unwrap().len(), 2);
    let own = request(
        &state,
        "GET",
        "/api/v1/collector/profile",
        Value::Null,
        &[("authorization", format!("Bearer {}", a.token))],
    )
    .await
    .2;
    assert_eq!(own["temporary"], true);
    assert_eq!(own["listed"], true);
    let alias = own["nickname"].as_str().unwrap();
    assert!(alias.chars().count() >= 4);
    let again = request(
        &state,
        "GET",
        "/api/v1/collector/profile",
        Value::Null,
        &[("authorization", format!("Bearer {}", a.token))],
    )
    .await
    .2;
    assert_eq!(again["nickname"], alias);
    assert_eq!(
        profile(&state, &a.token, "枫叶探路者", true).await,
        StatusCode::OK
    );
    assert_eq!(
        profile(&state, &b.token, "Private", false).await,
        StatusCode::OK
    );
    assert_eq!(
        profile(&state, &a.token, "<script>", true).await,
        StatusCode::BAD_REQUEST
    );
    assert_eq!(
        profile(&state, &"x".repeat(43), "Stolen", true).await,
        StatusCode::UNAUTHORIZED
    );
    let week = request(
        &state,
        "GET",
        "/api/v1/contributors?period=week",
        Value::Null,
        &[],
    )
    .await
    .2;
    assert_eq!(week["contributors"].as_array().unwrap().len(), 1);
    assert_eq!(week["contributors"][0]["shops"], 1);
    assert_eq!(week["contributors"][0]["quotes"], 1);
    let all = request(
        &state,
        "GET",
        "/api/v1/contributors?period=all",
        Value::Null,
        &[],
    )
    .await
    .2;
    assert_eq!(all["contributors"][0]["shops"], 2);
    assert_eq!(all["contributors"][0]["quotes"], 2);
    assert!(!all.to_string().contains(&a.public_id));
    assert!(!all.to_string().contains(&a.token));
    assert_eq!(
        request(
            &state,
            "GET",
            "/api/v1/contributors?period=wrong",
            Value::Null,
            &[]
        )
        .await
        .0,
        StatusCode::BAD_REQUEST
    );
    profile(&state, &a.token, "改名之后", true).await;
    assert_eq!(
        request(&state, "GET", "/api/v1/contributors", Value::Null, &[])
            .await
            .2["contributors"][0]["nickname"],
        "改名之后"
    );
    profile(&state, &a.token, "改名之后", false).await;
    let custom = request(
        &state,
        "GET",
        "/api/v1/collector/profile",
        Value::Null,
        &[("authorization", format!("Bearer {}", a.token))],
    )
    .await
    .2;
    assert_eq!(custom["nickname"], "改名之后");
    assert_eq!(custom["temporary"], false);
    assert_eq!(custom["listed"], false);
    assert_eq!(
        request(&state, "GET", "/api/v1/contributors", Value::Null, &[])
            .await
            .2["contributors"],
        json!([])
    );
    assert!(auth::authenticate(&db.pool, Some(&a.token))
        .await
        .unwrap()
        .is_some());
    db.close().await;
}
#[tokio::test]
async fn temporary_name_migration_backfills_only_unnamed_and_preserves_opt_out() {
    let Some(db) = TestDb::new().await else {
        return;
    };
    let mut tx = db.pool.begin().await.unwrap();
    sqlx::raw_sql("CREATE SCHEMA legacy_fixture; SET LOCAL search_path=legacy_fixture; CREATE TABLE collectors(id serial,nickname text NOT NULL DEFAULT '',listed boolean NOT NULL DEFAULT false); CREATE TABLE accounts(id serial,nickname text NOT NULL DEFAULT '',listed boolean NOT NULL DEFAULT false); INSERT INTO collectors(nickname,listed) VALUES('',false),('Custom private',false),('Custom public',true); INSERT INTO accounts(nickname,listed) VALUES('',false),('Google custom',false);").execute(&mut *tx).await.unwrap();
    sqlx::raw_sql(include_str!(
        "../../../migrations/0018_temporary_nicknames.sql"
    ))
    .execute(&mut *tx)
    .await
    .unwrap();
    let rows: Vec<(String, bool, bool)> =
        sqlx::query_as("SELECT nickname,listed,nickname_temporary FROM collectors ORDER BY id")
            .fetch_all(&mut *tx)
            .await
            .unwrap();
    assert!(!rows[0].0.is_empty());
    assert_eq!((rows[0].1, rows[0].2), (true, true));
    assert_eq!(rows[1], ("Custom private".into(), false, false));
    assert_eq!(rows[2], ("Custom public".into(), true, false));
    let default: (String, bool, bool) = sqlx::query_as(
        "INSERT INTO collectors DEFAULT VALUES RETURNING nickname,listed,nickname_temporary",
    )
    .fetch_one(&mut *tx)
    .await
    .unwrap();
    assert!(!default.0.is_empty());
    assert_eq!((default.1, default.2), (true, true));
    tx.rollback().await.unwrap();
    db.close().await;
}
#[tokio::test]
async fn account_link_requires_session_csrf_one_time_code_and_existing_owner() {
    let Some(db) = TestDb::new().await else {
        return;
    };
    let state = AppState::new(db.pool.clone(), Settings::default());
    let collector = auth::register(&db.pool, "old").await.unwrap();
    let other = auth::register(&db.pool, "second device").await.unwrap();
    profile(&state, &collector.token, "OldNickname", true).await;
    let c = auth::authenticate(&db.pool, Some(&collector.token))
        .await
        .unwrap()
        .unwrap();
    let a: i64 = sqlx::query_scalar(
        "INSERT INTO accounts(public_id,google_sub) VALUES('test-a','fake-google-a') RETURNING id",
    )
    .fetch_one(&db.pool)
    .await
    .unwrap();
    let b: i64 = sqlx::query_scalar(
        "INSERT INTO accounts(public_id,google_sub) VALUES('test-b','fake-google-b') RETURNING id",
    )
    .fetch_one(&db.pool)
    .await
    .unwrap();
    let credentials = auth::new_credentials();
    contributors::new_session(&db.pool, a, &credentials.token)
        .await
        .unwrap();
    let cookie = ("cookie", format!("cwm_account={}", credentials.token));
    let me = request(
        &state,
        "GET",
        "/api/v1/account",
        Value::Null,
        std::slice::from_ref(&cookie),
    )
    .await
    .2;
    let headers = [
        cookie.clone(),
        ("origin", "https://mxd.ruit.me".into()),
        ("x-csrf-token", me["csrf"].as_str().unwrap().into()),
    ];
    let code = auth::new_credentials().token;
    sqlx::query(
        "INSERT INTO collector_account_links VALUES($1,$2,now()+interval '10 minutes',NULL)",
    )
    .bind(auth::token_hash(&code))
    .bind(c.id)
    .execute(&db.pool)
    .await
    .unwrap();
    assert_eq!(
        request(
            &state,
            "POST",
            "/api/v1/account/link",
            json!({"code":code}),
            &[]
        )
        .await
        .0,
        StatusCode::UNAUTHORIZED
    );
    assert_eq!(
        request(
            &state,
            "POST",
            "/api/v1/account/link",
            json!({"code":code}),
            std::slice::from_ref(&cookie)
        )
        .await
        .0,
        StatusCode::FORBIDDEN
    );
    let mut wrong = headers.clone();
    wrong[1].1 = "https://evil.example".into();
    assert_eq!(
        request(
            &state,
            "POST",
            "/api/v1/account/link",
            json!({"code":code}),
            &wrong
        )
        .await
        .0,
        StatusCode::FORBIDDEN
    );
    assert_eq!(
        request(
            &state,
            "POST",
            "/api/v1/account/link",
            json!({"code":code}),
            &headers
        )
        .await
        .0,
        StatusCode::OK
    );
    assert_eq!(
        request(
            &state,
            "POST",
            "/api/v1/account/link",
            json!({"code":code}),
            &headers
        )
        .await
        .0,
        StatusCode::CONFLICT
    );
    assert_eq!(
        request(
            &state,
            "GET",
            "/api/v1/account",
            Value::Null,
            std::slice::from_ref(&cookie)
        )
        .await
        .2["nickname"],
        "OldNickname"
    );
    assert_eq!(
        profile(&state, &collector.token, "Cannot rename account", true).await,
        StatusCode::CONFLICT
    );
    // The same known shop from two owned collectors counts once.
    let c2 = auth::authenticate(&db.pool, Some(&other.token))
        .await
        .unwrap()
        .unwrap();
    sqlx::query("UPDATE collectors SET account_id=$1 WHERE id=$2")
        .bind(a)
        .bind(c2.id)
        .execute(&db.pool)
        .await
        .unwrap();
    let now = unix_now();
    upload(&state, &collector.token, "same1", 99, now - 100.).await;
    upload(&state, &other.token, "same2", 99, now - 50.).await;
    assert_eq!(
        request(&state, "GET", "/api/v1/contributors", Value::Null, &[])
            .await
            .2["contributors"][0]["quotes"],
        1
    );
    // Another account cannot take ownership even with a newly issued link.
    let second = auth::new_credentials();
    contributors::new_session(&db.pool, b, &second.token)
        .await
        .unwrap();
    let other_cookie = ("cookie", format!("cwm_account={}", second.token));
    let other_me = request(
        &state,
        "GET",
        "/api/v1/account",
        Value::Null,
        std::slice::from_ref(&other_cookie),
    )
    .await
    .2;
    let other_headers = [
        other_cookie,
        ("origin", "https://mxd.ruit.me".into()),
        ("x-csrf-token", other_me["csrf"].as_str().unwrap().into()),
    ];
    let fresh = auth::new_credentials().token;
    sqlx::query(
        "INSERT INTO collector_account_links VALUES($1,$2,now()+interval '10 minutes',NULL)",
    )
    .bind(auth::token_hash(&fresh))
    .bind(c.id)
    .execute(&db.pool)
    .await
    .unwrap();
    assert_eq!(
        request(
            &state,
            "POST",
            "/api/v1/account/link",
            json!({"code":fresh}),
            &other_headers
        )
        .await
        .0,
        StatusCode::CONFLICT
    );
    sqlx::query("UPDATE collector_account_links SET expires_at=now()-interval '1 second' WHERE code_hash=$1").bind(auth::token_hash(&fresh)).execute(&db.pool).await.unwrap();
    assert_eq!(
        request(
            &state,
            "POST",
            "/api/v1/account/link",
            json!({"code":fresh}),
            &headers
        )
        .await
        .0,
        StatusCode::CONFLICT
    );
    assert_eq!(
        request(
            &state,
            "POST",
            "/api/v1/account",
            json!({"nickname":"GoogleNickname","listed":true}),
            &headers
        )
        .await
        .0,
        StatusCode::OK
    );
    let logout = request(
        &state,
        "POST",
        "/api/v1/account/logout",
        json!({}),
        &headers,
    )
    .await;
    assert_eq!(logout.0, StatusCode::OK);
    assert!(logout.1["set-cookie"]
        .to_str()
        .unwrap()
        .contains("Max-Age=0"));
    assert_eq!(
        request(&state, "GET", "/api/v1/account", Value::Null, &[cookie])
            .await
            .2["signed_in"],
        false
    );
    db.close().await;
}
#[tokio::test]
async fn google_start_uses_pkce_nonce_and_single_browser_state() {
    let Some(db) = TestDb::new().await else {
        return;
    };
    let mut state = AppState::new(db.pool.clone(), Settings::default());
    state.google=Some(std::sync::Arc::new(serde_json::from_value(json!({"client_id":"test.apps.googleusercontent.com","client_secret":"test-only","redirect_uri":"https://mxd.ruit.me/auth/google/callback"})).unwrap()));
    let result = request(&state, "GET", "/auth/google/start", Value::Null, &[]).await;
    assert_eq!(result.0, StatusCode::SEE_OTHER);
    let url = url::Url::parse(result.1["location"].to_str().unwrap()).unwrap();
    let params: std::collections::HashMap<_, _> = url.query_pairs().collect();
    assert_eq!(params["scope"], "openid");
    assert_eq!(params["code_challenge_method"], "S256");
    assert_eq!(
        params["redirect_uri"],
        "https://mxd.ruit.me/auth/google/callback"
    );
    assert_eq!(params["nonce"].len(), 43);
    assert!(!url.as_str().contains("test-only"));
    assert!(result.1["set-cookie"]
        .to_str()
        .unwrap()
        .contains("Secure; HttpOnly; SameSite=Lax"));
    let rejected = request(
        &state,
        "GET",
        &format!(
            "/auth/google/callback?code=forged&state={}",
            params["state"]
        ),
        Value::Null,
        &[("cookie", format!("cwm_google_state={}", "x".repeat(43)))],
    )
    .await;
    assert!(rejected.1["location"]
        .to_str()
        .unwrap()
        .contains("login_failed"));
    let count: i64 = sqlx::query_scalar("SELECT count(*) FROM accounts")
        .fetch_one(&db.pool)
        .await
        .unwrap();
    assert_eq!(count, 0);
    db.close().await;
}

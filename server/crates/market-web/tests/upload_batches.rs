mod common;
use common::TestDb;
use market_core::protocol::validate;
use market_web::{auth::Collector, ingest::{ingest, ingest_batch, IngestError, IngestOutcome, Received}, unix_now};
use serde_json::{json, Value};

fn observation(id: &str, at: f64, stock: i64, shop: i64) -> Value {
    json!({"version":1,"world":"ClassicWorld","observation_id":id,"complete":true,
        "observed_at":at,"title":"Batch shop","shop_id":shop,"location":{"channel":3,"room":4},
        "items":[{"item_id":4010001,"slot":1,"price":500,"bundle":1,"stock":stock}]})
}

async fn batch(db: &TestDb, collectors: &[Collector], data: &[(usize, Value)], now: f64)
    -> sqlx::Result<Vec<Result<IngestOutcome, IngestError>>>
{
    let uploads: Vec<_> = data.iter().map(|(_, value)| validate(value, now).unwrap()).collect();
    let raw: Vec<_> = data.iter().map(|(_, value)| serde_json::to_vec(value).unwrap()).collect();
    let inputs: Vec<_> = uploads.iter().zip(&raw).zip(data).map(|((upload, raw), (who, _))|
        Received {collector:&collectors[*who],upload,raw,received_at:now,now}).collect();
    ingest_batch(&db.pool, &inputs).await
}

async fn figures(db: &TestDb) -> Value {
    sqlx::query_scalar("SELECT jsonb_build_object(
        'stats',(SELECT jsonb_agg(to_jsonb(s)-'read_revision' ORDER BY item_id) FROM item_stats s),
        'all',(SELECT jsonb_agg(to_jsonb(s) ORDER BY item_id) FROM item_stats_all s),
        'daily',(SELECT jsonb_agg(to_jsonb(s) ORDER BY item_id,day) FROM item_daily s),
        'sales',(SELECT jsonb_agg(jsonb_build_array(item_id,kind,quantity,unit_price,detected_at) ORDER BY detected_at,kind) FROM market_sales),
        'listings',(SELECT jsonb_agg(jsonb_build_array(item_id,stock,price,last_seen_at) ORDER BY item_id,stock) FROM listings),
        'state',(SELECT to_jsonb(s)-'refreshed_at'-'refreshed_as_of'-'refreshed_cutoff' FROM market_state s))")
        .fetch_one(&db.pool).await.unwrap()
}

#[tokio::test]
async fn batch_matches_sequential_replay_and_recomputes_shared_items_once() {
    let Some(db) = TestDb::new().await else { return };
    let sequential = TestDb::new().await.unwrap();
    let a = vec![db.collector("one").await, db.collector("two").await];
    let b = [sequential.collector("one").await, sequential.collector("two").await];
    let now = unix_now();
    let first = observation("first", now-60.0, 8, 7);
    let mut conflict = first.clone(); conflict["items"][0]["price"] = json!(900);
    let second = observation("second", now-40.0, 5, 7);
    let mut failed = observation("fault", now-50.0, 9, 99);
    failed["items"][0]["item_id"] = json!(4010999);
    let data = vec![(0,first.clone()),(0,first),(0,conflict),(0,failed),(0,second.clone()),
        (0,observation("late",now-50.0,7,7)),(1,second),
        (1,observation("another-shop",now-30.0,10,8)),(0,observation("sold",now-20.0,0,7))];
    // Fault occurs after observations and rows were inserted, exercising rollback
    // of a partially applied observation while its neighbours still commit.
    sqlx::raw_sql("CREATE FUNCTION reject_fixture() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
        IF NEW.observation_id='fault' THEN RAISE EXCEPTION 'fixture failure'; END IF; RETURN NEW; END $$;
        CREATE TRIGGER fixture_fault BEFORE INSERT ON uploads_raw FOR EACH ROW EXECUTE FUNCTION reject_fixture();
        CREATE TABLE stats_writes (item_id int);
        CREATE FUNCTION count_stats() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
        INSERT INTO stats_writes VALUES(NEW.item_id); RETURN NEW; END $$;
        CREATE TRIGGER fixture_stats AFTER INSERT OR UPDATE ON item_stats FOR EACH ROW EXECUTE FUNCTION count_stats();")
        .execute(&db.pool).await.unwrap();
    let outcomes = batch(&db,&a,&data,now).await.unwrap();
    assert!(matches!(outcomes[0],Ok(IngestOutcome::Created(_))));
    assert!(matches!(outcomes[1],Ok(IngestOutcome::Duplicate)));
    assert!(matches!(outcomes[2],Err(IngestError::Conflict)));
    assert!(matches!(outcomes[3],Err(IngestError::Db(_))));
    assert!(outcomes[4..].iter().all(|outcome| matches!(outcome,Ok(IngestOutcome::Created(_)))));
    for (index,(who,value)) in data.iter().enumerate() {
        if index==3 {continue;}
        let upload=validate(value,now).unwrap();let raw=serde_json::to_vec(value).unwrap();
        let result=ingest(&sequential.pool,Received {collector:&b[*who],upload:&upload,raw:&raw,received_at:now,now}).await;
        assert_eq!(result.is_ok(),outcomes[index].is_ok());
    }
    assert_eq!(figures(&db).await,figures(&sequential).await);
    assert_eq!(sqlx::query_scalar::<_,i64>("SELECT count(*) FROM stats_writes").fetch_one(&db.pool).await.unwrap(),1);
    assert_eq!(sqlx::query_scalar::<_,i64>("SELECT count(*) FROM items WHERE id=4010999").fetch_one(&db.pool).await.unwrap(),0);
    assert_eq!(sqlx::query_scalar::<_,i64>("SELECT count(*) FROM uploads_raw").fetch_one(&db.pool).await.unwrap(),6);
    db.close().await;sequential.close().await;
}

#[tokio::test]
async fn unchanged_daily_figures_do_not_generate_writes_and_removed_sales_clear_history() {
    let Some(db)=TestDb::new().await else {return};
    let collectors=vec![db.collector("daily").await];let now=unix_now();
    batch(&db,&collectors,&[(0,observation("first",now-60.0,8,7)),
        (0,observation("sold",now-30.0,0,7))],now).await.unwrap();
    sqlx::raw_sql("CREATE TABLE daily_writes (operation text);
        CREATE FUNCTION count_daily_writes() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
        INSERT INTO daily_writes VALUES(TG_OP); RETURN COALESCE(NEW,OLD); END $$;
        CREATE TRIGGER fixture_daily AFTER INSERT OR UPDATE OR DELETE ON item_daily
        FOR EACH ROW EXECUTE FUNCTION count_daily_writes();").execute(&db.pool).await.unwrap();
    batch(&db,&collectors,&[(0,observation("same-stock",now-10.0,0,7))],now).await.unwrap();
    assert_eq!(sqlx::query_scalar::<_,i64>("SELECT count(*) FROM item_daily").fetch_one(&db.pool).await.unwrap(),1);
    assert_eq!(sqlx::query_scalar::<_,i64>("SELECT count(*) FROM daily_writes").fetch_one(&db.pool).await.unwrap(),0);
    batch(&db,&collectors,&[(0,observation("late-drop",now-45.0,5,7))],now).await.unwrap();
    assert_eq!(sqlx::query_scalar::<_,i64>("SELECT count(*) FROM daily_writes WHERE operation='UPDATE'").fetch_one(&db.pool).await.unwrap(),1);
    let mut tx=db.pool.begin().await.unwrap();
    sqlx::query("DELETE FROM sales WHERE item_id=4010001").execute(&mut *tx).await.unwrap();
    market_web::stats::recompute_items(&mut tx,&[4010001],now,now,&Default::default()).await.unwrap();
    tx.commit().await.unwrap();
    assert_eq!(sqlx::query_scalar::<_,i64>("SELECT count(*) FROM item_daily").fetch_one(&db.pool).await.unwrap(),0);
    assert_eq!(sqlx::query_scalar::<_,i64>("SELECT count(*) FROM daily_writes WHERE operation='DELETE'").fetch_one(&db.pool).await.unwrap(),1);
    db.close().await;
}

#[tokio::test]
async fn statistics_failure_rolls_back_entire_batch_and_retry_is_safe() {
    let Some(db) = TestDb::new().await else {return};
    let collectors=vec![db.collector("rollback").await];let now=unix_now();
    let data=vec![(0,observation("first",now-60.0,8,7)),(0,observation("second",now-30.0,5,7))];
    sqlx::raw_sql("CREATE FUNCTION reject_stats() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
        RAISE EXCEPTION 'fixture aggregate failure'; END $$;
        CREATE TRIGGER fixture_stats BEFORE INSERT ON item_stats FOR EACH ROW EXECUTE FUNCTION reject_stats();")
        .execute(&db.pool).await.unwrap();
    assert!(batch(&db,&collectors,&data,now).await.is_err());
    assert_eq!(sqlx::query_scalar::<_,i64>("SELECT count(*) FROM observations").fetch_one(&db.pool).await.unwrap(),0);
    assert_eq!(sqlx::query_scalar::<_,i64>("SELECT visits FROM market_state").fetch_one(&db.pool).await.unwrap(),0);
    sqlx::query("DROP TRIGGER fixture_stats ON item_stats").execute(&db.pool).await.unwrap();
    assert!(batch(&db,&collectors,&data,now).await.unwrap().iter().all(|r|matches!(r,Ok(IngestOutcome::Created(_)))));
    assert!(batch(&db,&collectors,&data,now).await.unwrap().iter().all(|r|matches!(r,Ok(IngestOutcome::Duplicate))));
    db.close().await;
}

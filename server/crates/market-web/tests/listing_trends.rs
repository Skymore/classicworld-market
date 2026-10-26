mod common;
use common::TestDb;
use market_web::bestiary::queries::item_page;

#[tokio::test]
async fn listing_history_deduplicates_scans_and_never_creates_sales() {
    let Some(db) = TestDb::new().await else { return; };
    for sql in [
        "INSERT INTO items(id,name_en,category) VALUES(4000019,'Shell','etc')",
        "INSERT INTO collectors(id,public_id,token_hash,source) VALUES(1,'fixture','\\x01','packet')",
        "INSERT INTO shops(id,shop_key,world,channel,room,shop_id,title,first_seen_at,last_seen_at,public_key) VALUES(1,'one','w',1,1,1,'One',now(),now(),'one'),(2,'two','w',1,1,2,'Two',now(),now(),'two')",
        "INSERT INTO observations(id,observation_id,collector_id,shop_id,source,observed_at,fingerprint,visit_key) VALUES(1,'a',1,1,'packet','2026-10-25 01:00Z','a','a'),(2,'b',1,1,'packet','2026-10-25 02:00Z','b','b'),(3,'c',1,2,'packet','2026-10-25 03:00Z','c','c'),(4,'d',1,1,'packet','2026-10-25 04:00Z','d','d')",
        "INSERT INTO observation_rows(observation_id,slot,item_id,price,bundle,stock,position) VALUES(1,1,4000019,100,1,5,0),(2,1,4000019,400,2,5,0),(3,1,4000019,600,2,5,0),(4,1,4000019,400,2,0,0)",
        "UPDATE market_state SET as_of='2026-10-25 04:00Z'",
    ] { sqlx::query(sql).execute(&db.pool).await.unwrap(); }
    let now = chrono::DateTime::parse_from_rfc3339("2026-10-25T05:00:00Z").unwrap().timestamp() as f64;
    let page = item_page(&db.pool,4000019,now).await.unwrap().unwrap();
    assert_eq!(page.market.listing_days.len(),7);
    let day = page.market.listing_days.last().unwrap();
    assert_eq!((day.low,day.median,day.high,day.count),(Some(200.),Some(250.),Some(300.),2));
    assert!(page.market.listings.is_empty(),"historical asks do not become current inventory");
    assert!(page.market.sales.is_empty());
    assert!(page.market.days.iter().all(|d| d.count == 0));
    assert!(page.market.listing_days[..6].iter().all(|d| d.median.is_none()));
    db.close().await;
}

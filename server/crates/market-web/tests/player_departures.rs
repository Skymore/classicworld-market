mod common;
use common::TestDb;
use market_core::protocol::validate;
use market_web::{
    ingest::{ingest, Received},
    presence::{self, Departure, Place},
    unix_now,
};
use serde_json::json;

fn event(now: f64, channel: i16) -> Departure {
    Departure {
        version: 1,
        world: "ClassicWorld".into(),
        event_id: format!("{channel:032x}"),
        location: Place { channel, room: 1 },
        character_id: 123,
        name: "ExampleHost".into(),
        seen_at: now - 60.,
        observed_at: now,
        parser: "cw_player_departure_v1".into(),
    }
}

#[tokio::test]
async fn departures_retire_only_matching_inventory_and_late_uploads_stay_expired() {
    let Some(db) = TestDb::new().await else {
        return;
    };
    let who = db.collector("presence").await;
    let now = unix_now();
    for (id, time, price) in [
        ("original", now - 30., 500),
        ("late", now - 20., 600),
        ("returned", now + 1., 700),
    ] {
        let v = json!({"version":1,"world":"ClassicWorld","complete":true,
          "observation_id":id,"observed_at":time,"shop_id":300,"title":"Example shop",
          "location":{"channel":26,"room":1},
          "owner":{"character_id":123,"name":"ExampleHost","parser":"cw_shop_owner_v1"},
          "items":[{"item_id":4010001,"slot":1,"price":price,"bundle":1,"stock":8}]});
        let upload = validate(&v, now + 1.).unwrap();
        let raw = serde_json::to_vec(&v).unwrap();
        ingest(
            &db.pool,
            Received {
                collector: &who,
                upload: &upload,
                raw: &raw,
                received_at: now,
                now,
            },
        )
        .await
        .unwrap();
        if id == "original" {
            presence::ingest(&db.pool, who.id, &event(now, 25), now)
                .await
                .unwrap();
            let live: i64 = sqlx::query_scalar("SELECT count(*) FROM listings")
                .fetch_one(&db.pool)
                .await
                .unwrap();
            assert_eq!(live, 1, "other channel must not expire this player");
            assert!(presence::ingest(&db.pool, who.id, &event(now, 26), now)
                .await
                .unwrap());
            assert!(!presence::ingest(&db.pool, who.id, &event(now, 26), now)
                .await
                .unwrap());
        }
        let live: i64 = sqlx::query_scalar("SELECT count(*) FROM listings")
            .fetch_one(&db.pool)
            .await
            .unwrap();
        assert_eq!(live, if id == "returned" { 1 } else { 0 });
        let watch =
            market_web::views::personal_watch_listings(&db.pool, who.id, &[4010001], now + 2.)
                .await
                .unwrap();
        assert_eq!(
            watch["listings"].as_array().unwrap().len(),
            if id == "returned" { 1 } else { 0 }
        );
    }
    let archived: Vec<i64> =
        sqlx::query_scalar("SELECT price FROM expired_listings ORDER BY price")
            .fetch_all(&db.pool)
            .await
            .unwrap();
    assert_eq!(archived, vec![500, 600]);
    let sales: i64 = sqlx::query_scalar("SELECT count(*) FROM sales")
        .fetch_one(&db.pool)
        .await
        .unwrap();
    assert_eq!(sales, 0, "departures are not sales");
    let ask: Option<f64> =
        sqlx::query_scalar("SELECT lowest_ask::float8 FROM item_stats WHERE item_id=4010001")
            .fetch_one(&db.pool)
            .await
            .unwrap();
    assert_eq!(ask, Some(700.));
    let page = market_web::bestiary::queries::item_page(&db.pool, 4010001, now + 2.)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(page.market.listings.len(), 1);
    assert_eq!(page.market.expired_listings.len(), 2);
    assert!(page
        .market
        .expired_listings
        .iter()
        .all(|r| r.invalidated_at.is_some() && r.owner_name.as_deref() == Some("ExampleHost")));
    db.close().await;
}

#[test]
fn reject_unproven_or_malformed_events() {
    let mut e = event(10000000., 26);
    assert!(e.valid(10000000.));
    e.location.room = 0;
    assert!(!e.valid(10000000.));
    e.location.room = 1;
    e.seen_at = e.observed_at + 1.;
    assert!(!e.valid(10000000.));
    e.seen_at = e.observed_at - 1.;
    e.parser = "roster_timeout".into();
    assert!(!e.valid(10000000.));
}

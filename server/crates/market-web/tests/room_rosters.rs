mod common;
use common::TestDb;
use market_core::protocol::validate;
use market_web::{
    ingest::{ingest, Received},
    presence::Place,
    roster::{self, Roster},
    unix_now,
};
use serde_json::json;

fn roster(now: f64, channel: i16, room: i16, ids: Vec<i64>) -> Roster {
    Roster {
        version: 1,
        world: "ClassicWorld".into(),
        event_id: format!("{channel:016x}{room:016x}"),
        location: Place { channel, room },
        started_at: now,
        observed_at: now + 0.1,
        character_ids: ids,
        complete: true,
        parser: "cw_room_roster_v1".into(),
    }
}

#[tokio::test]
async fn complete_rosters_expire_absent_owners_and_late_uploads_but_not_other_places_or_new_quotes()
{
    let Some(db) = TestDb::new().await else {
        return;
    };
    let who = db.collector("roster").await;
    let now = unix_now();
    // Snapshot may arrive before any old shop data: retain it for replay.
    assert!(roster::ingest(
        &db.pool,
        who.id,
        &roster(now, 26, 1, vec![999, 124]),
        now + 1.
    )
    .await
    .unwrap());
    for (id, owner, ch, room, time, expected) in [
        ("absent", 123, 26, 1, now - 30., 0),
        ("present", 124, 26, 1, now - 30., 1),
        ("other_channel", 125, 25, 1, now - 30., 2),
        ("other_room", 126, 26, 2, now - 30., 3),
        ("unknown", 0, 26, 1, now - 30., 4),
        ("observer", 999, 26, 1, now - 30., 5),
        ("returned", 123, 26, 1, now + 0.05, 6),
        ("late_old", 123, 26, 1, now - 20., 6),
        ("exact_boundary", 127, 26, 1, now, 7),
    ] {
        let mut v = json!({"version":1,"world":"ClassicWorld","complete":true,"observation_id":id,
            "observed_at":time,"shop_id":300+owner,"title":format!("Shop{owner}"),
            "location":{"channel":ch,"room":room},"items":[{"item_id":4010001,"slot":1,"price":500,"bundle":1,"stock":8}]});
        if owner != 0 {
            v["owner"] = json!({"character_id":owner,"name":format!("Host{owner}"),"parser":"cw_shop_owner_v1"});
        }
        let upload = validate(&v, now + 1.).unwrap();
        let raw = serde_json::to_vec(&v).unwrap();
        ingest(
            &db.pool,
            Received {
                collector: &who,
                upload: &upload,
                raw: &raw,
                received_at: now + 1.,
                now: now + 1.,
            },
        )
        .await
        .unwrap();
        let count: i64 = sqlx::query_scalar("SELECT count(*) FROM listings")
            .fetch_one(&db.pool)
            .await
            .unwrap();
        assert_eq!(count, expected, "{id}");
    }
    // A later complete rescan with just the observer removes all known absent
    // owners in this room, preserving unknown identities and the other places.
    let mut later = roster(now + 2., 26, 1, vec![999]);
    later.event_id = "f".repeat(32);
    assert!(roster::ingest(&db.pool, who.id, &later, now + 3.)
        .await
        .unwrap());
    assert!(!roster::ingest(&db.pool, who.id, &later, now + 3.)
        .await
        .unwrap());
    let count: i64 = sqlx::query_scalar("SELECT count(*) FROM listings")
        .fetch_one(&db.pool)
        .await
        .unwrap();
    assert_eq!(count, 4);
    let sales: i64 = sqlx::query_scalar("SELECT count(*) FROM sales")
        .fetch_one(&db.pool)
        .await
        .unwrap();
    assert_eq!(sales, 0);
    let expired: i64 = sqlx::query_scalar("SELECT count(*) FROM expired_listings")
        .fetch_one(&db.pool)
        .await
        .unwrap();
    assert!(expired >= 4);
    let watch = market_web::views::personal_watch_listings(&db.pool, who.id, &[4010001], now + 3.)
        .await
        .unwrap();
    assert_eq!(watch["listings"].as_array().unwrap().len(), 4);
    let page = market_web::bestiary::queries::item_page(&db.pool, 4010001, now + 3.)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(page.market.listings.len(), 4);
    assert!(!page.market.expired_listings.is_empty());
    db.close().await;
}

#[test]
fn rejects_incomplete_or_invalid_rosters() {
    let now = 10000000.;
    let mut r = roster(now, 26, 1, vec![999]);
    assert!(r.valid(now + 1.));
    r.complete = false;
    assert!(!r.valid(now + 1.));
    r.complete = true;
    r.character_ids = vec![];
    assert!(!r.valid(now + 1.));
    r.character_ids = vec![999, 999];
    assert!(!r.valid(now + 1.));
    r.character_ids = vec![999];
    r.observed_at = now + 11.;
    assert!(!r.valid(now + 11.));
    r.observed_at = now + 1.;
    r.location.room = 0;
    assert!(!r.valid(now + 1.));
    r.location.room = 1;
    r.parser = "timeout".into();
    assert!(!r.valid(now + 1.));
}

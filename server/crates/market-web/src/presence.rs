//! Only explicit, paired player enter/leave evidence can retire inventory.
use std::collections::HashMap;

use crate::write_timing::{Phase, WriteTiming};
use crate::{
    api::{bearer, error, internal},
    auth, stats, unix_now, AppState,
};
use axum::{
    body::Bytes,
    extract::State,
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    Json,
};
use serde::{Deserialize, Serialize};
use serde_json::json;
use sqlx::{PgConnection, PgPool, Postgres, QueryBuilder};

#[derive(Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Departure {
    pub version: u8,
    pub world: String,
    pub event_id: String,
    pub location: Place,
    pub character_id: i64,
    pub name: String,
    pub seen_at: f64,
    pub observed_at: f64,
    pub parser: String,
}
#[derive(Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Place {
    pub channel: i16,
    pub room: i16,
}

impl Departure {
    pub fn valid(&self, now: f64) -> bool {
        self.version == 1
            && self.world == "ClassicWorld"
            && self.parser == "cw_player_departure_v1"
            && (1..=255).contains(&self.location.channel)
            && (1..=22).contains(&self.location.room)
            && (1..=4_294_967_295).contains(&self.character_id)
            && !self.name.is_empty()
            && self.name.len() <= 24
            && self
                .name
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b == b'_')
            && self.event_id.len() == 32
            && self.event_id.bytes().all(|b| b.is_ascii_hexdigit())
            && self.observed_at.is_finite()
            && self.seen_at.is_finite()
            && self.observed_at <= now + 120.
            && self.observed_at >= now - 30. * 86400.
            && self.seen_at <= self.observed_at
            && self.seen_at >= self.observed_at - 7. * 86400.
    }
}

/// Called after inventory replay as well: late old uploads must not resurrect it.
pub async fn expire(
    conn: &mut PgConnection,
    shop: Option<i64>,
    owner: Option<i64>,
) -> sqlx::Result<Vec<i32>> {
    expire_at(conn, shop, owner, None).await
}

pub async fn expire_room(conn: &mut PgConnection, place: &Place) -> sqlx::Result<Vec<i32>> {
    expire_at(conn, None, None, Some(place)).await
}

async fn expire_at(
    conn: &mut PgConnection,
    shop: Option<i64>,
    owner: Option<i64>,
    place: Option<&Place>,
) -> sqlx::Result<Vec<i32>> {
    // Departures are constrained to ClassicWorld. Include the leading world
    // column and the partial-index predicate even for a room/owner lookup.
    let mut query = QueryBuilder::<Postgres>::new(
        "WITH scoped_shops AS MATERIALIZED (
          SELECT id,world,channel,room,owner_character_id FROM shops
          WHERE world='ClassicWorld' AND owner_character_id IS NOT NULL",
    );
    if let Some(shop) = shop {
        query.push(" AND id=").push_bind(shop);
    }
    if let Some(owner) = owner {
        query.push(" AND owner_character_id=").push_bind(owner);
    }
    if let Some(place) = place {
        query
            .push(" AND channel=")
            .push_bind(place.channel)
            .push(" AND room=")
            .push_bind(place.room);
    }
    query.push(
        "), candidates AS MATERIALIZED (
          SELECT l.shop_id,l.slot,d.invalidated_at FROM scoped_shops s
          JOIN LATERAL (SELECT shop_id,slot,observation_id FROM listings WHERE shop_id=s.id OFFSET 0) l ON true
          JOIN LATERAL (SELECT observed_at FROM observations WHERE id=l.observation_id OFFSET 0) o ON true
          JOIN LATERAL (
            SELECT observed_at AS invalidated_at FROM player_departures
            WHERE world=s.world AND character_id=s.owner_character_id AND channel=s.channel AND room=s.room
              AND observed_at>=o.observed_at AND (evidence_kind='player_departure' OR observed_at>o.observed_at)
            ORDER BY observed_at LIMIT 1
          ) d ON true
        ), retired AS (
          DELETE FROM listings l USING candidates c WHERE l.shop_id=c.shop_id AND l.slot=c.slot
          RETURNING l.*,c.invalidated_at
        ), archived AS (
          INSERT INTO expired_listings(shop_id,observation_id,slot,item_id,variant_id,price,bundle,stock,invalidated_at)
          SELECT l.shop_id,l.observation_id,l.slot,l.item_id,l.variant_id,l.price,l.bundle,l.stock,l.invalidated_at
          FROM retired l WHERE l.stock>0
          ON CONFLICT(observation_id,slot) DO UPDATE SET invalidated_at=LEAST(expired_listings.invalidated_at,EXCLUDED.invalidated_at)
        ) SELECT DISTINCT item_id FROM retired"
    ).build_query_scalar().fetch_all(conn).await
}

pub async fn ingest(
    db: &PgPool,
    collector: i64,
    event: &Departure,
    now: f64,
) -> sqlx::Result<bool> {
    let mut timing = WriteTiming::new("departure");
    let mut tx = db.begin().await?;
    timing.mark(Phase::Pool);
    stats::lock_writes(&mut tx).await?;
    timing.mark(Phase::Lock);
    let inserted=sqlx::query("INSERT INTO player_departures(collector_id,event_id,world,channel,room,character_id,name,seen_at,observed_at)
        VALUES($1,$2,$3,$4,$5,$6,$7,to_timestamp($8),to_timestamp($9)) ON CONFLICT DO NOTHING")
        .bind(collector).bind(&event.event_id).bind(&event.world).bind(event.location.channel).bind(event.location.room)
        .bind(event.character_id).bind(&event.name).bind(event.seen_at).bind(event.observed_at).execute(&mut *tx).await?.rows_affected();
    if inserted == 0 {
        timing.duplicate();
        return Ok(false);
    }
    let items = expire(&mut tx, None, Some(event.character_id)).await?;
    timing.items = items.len();
    timing.mark(Phase::Write);
    if !items.is_empty() {
        let as_of: f64 = sqlx::query_scalar(
            "UPDATE market_state SET version=version+1 RETURNING extract(epoch FROM as_of)::float8",
        )
        .fetch_one(&mut *tx)
        .await?;
        stats::recompute_items(&mut tx, &items, as_of, now, &HashMap::new()).await?;
        crate::realtime::notify_market(&mut tx, Some(&items[..])).await?;
    }
    timing.mark(Phase::Stats);
    tx.commit().await?;
    timing.committed();
    Ok(true)
}

pub async fn upload(State(state): State<AppState>, headers: HeaderMap, body: Bytes) -> Response {
    let collector = match auth::authenticate(&state.db, bearer(&headers)).await {
        Ok(Some(c)) => c,
        Ok(None) => return error(StatusCode::UNAUTHORIZED, "Collector token required"),
        Err(e) => return internal(e),
    };
    if !state
        .limiter
        .allow(&format!("player-departure:{}", collector.id), 120)
    {
        return error(StatusCode::TOO_MANY_REQUESTS, "Rate limited");
    }
    let now = unix_now();
    let event = match serde_json::from_slice::<Departure>(&body) {
        Ok(e) if e.valid(now) => e,
        _ => return error(StatusCode::BAD_REQUEST, "Invalid player departure"),
    };
    // Finish the write even if the collector gives up waiting: it waits for the
    // shared write lock and may recompute many items, which can outlast the
    // collector's timeout. Dropped mid-way, every retry rolled back the same
    // work again; finished, the retry is a quick duplicate.
    let db = state.write_db.clone();
    let id = collector.id;
    match tokio::spawn(async move { ingest(&db, id, &event, now).await }).await {
        Ok(Ok(created)) => Json(json!({"ok":true,"created":created})).into_response(),
        Ok(Err(e)) => internal(e),
        Err(e) => internal(e),
    }
}

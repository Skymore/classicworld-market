//! Only explicit, paired player enter/leave evidence can retire inventory.
use std::collections::HashMap;

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
use sqlx::{PgConnection, PgPool};

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
    sqlx::query_scalar(
        "WITH retired AS (
          DELETE FROM listings l USING shops s, observations o
          WHERE s.id=l.shop_id AND o.id=l.observation_id
            AND ($1::bigint IS NULL OR s.id=$1)
            AND ($2::bigint IS NULL OR s.owner_character_id=$2)
            AND EXISTS (SELECT 1 FROM player_departures d WHERE d.world=s.world
              AND d.character_id=s.owner_character_id AND d.channel=s.channel AND d.room=s.room
              AND d.observed_at >= o.observed_at)
          RETURNING l.*
        ), archived AS (
          INSERT INTO expired_listings(shop_id,observation_id,slot,item_id,variant_id,price,bundle,stock,invalidated_at)
          SELECT l.shop_id,l.observation_id,l.slot,l.item_id,l.variant_id,l.price,l.bundle,l.stock,
            (SELECT min(d.observed_at) FROM player_departures d JOIN shops s ON s.id=l.shop_id
              JOIN observations o ON o.id=l.observation_id WHERE d.world=s.world
              AND d.character_id=s.owner_character_id AND d.channel=s.channel AND d.room=s.room
              AND d.observed_at>=o.observed_at)
          FROM retired l WHERE l.stock>0
          ON CONFLICT(observation_id,slot) DO UPDATE SET invalidated_at=LEAST(expired_listings.invalidated_at,EXCLUDED.invalidated_at)
        ) SELECT DISTINCT item_id FROM retired"
    ).bind(shop).bind(owner).fetch_all(conn).await
}

pub async fn ingest(
    db: &PgPool,
    collector: i64,
    event: &Departure,
    now: f64,
) -> sqlx::Result<bool> {
    let mut tx = db.begin().await?;
    stats::lock_writes(&mut tx).await?;
    let inserted=sqlx::query("INSERT INTO player_departures(collector_id,event_id,world,channel,room,character_id,name,seen_at,observed_at)
        VALUES($1,$2,$3,$4,$5,$6,$7,to_timestamp($8),to_timestamp($9)) ON CONFLICT DO NOTHING")
        .bind(collector).bind(&event.event_id).bind(&event.world).bind(event.location.channel).bind(event.location.room)
        .bind(event.character_id).bind(&event.name).bind(event.seen_at).bind(event.observed_at).execute(&mut *tx).await?.rows_affected();
    if inserted == 0 {
        return Ok(false);
    }
    let items = expire(&mut tx, None, Some(event.character_id)).await?;
    if !items.is_empty() {
        let as_of: f64 = sqlx::query_scalar(
            "UPDATE market_state SET version=version+1 RETURNING extract(epoch FROM as_of)::float8",
        )
        .fetch_one(&mut *tx)
        .await?;
        stats::recompute_items(&mut tx, &items, as_of, now, &HashMap::new()).await?;
        sqlx::query("SELECT pg_notify('market_changed','')")
            .execute(&mut *tx)
            .await?;
    }
    tx.commit().await?;
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
    match ingest(&state.db, collector.id, &event, now).await {
        Ok(created) => Json(json!({"ok":true,"created":created})).into_response(),
        Err(e) => internal(e),
    }
}

//! Absence proven by a complete decoded map-entry roster, including the observer.
use crate::write_timing::{Phase, WriteTiming};
use crate::{
    api::{bearer, error, internal},
    auth, presence, stats, unix_now, AppState,
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
use std::collections::HashSet;

#[derive(Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Roster {
    pub version: u8,
    pub world: String,
    pub event_id: String,
    pub location: presence::Place,
    pub started_at: f64,
    pub observed_at: f64,
    pub character_ids: Vec<i64>,
    pub complete: bool,
    pub parser: String,
}
impl Roster {
    pub fn valid(&self, now: f64) -> bool {
        self.version == 1
            && self.world == "ClassicWorld"
            && self.complete
            && self.parser == "cw_room_roster_v1"
            && (1..=255).contains(&self.location.channel)
            && (1..=22).contains(&self.location.room)
            && self.event_id.len() == 32
            && self.event_id.bytes().all(|b| b.is_ascii_hexdigit())
            && self.started_at.is_finite()
            && self.observed_at.is_finite()
            && self.started_at >= now - 30. * 86400.
            && self.observed_at <= now + 120.
            && self.observed_at >= self.started_at
            && self.observed_at - self.started_at <= 10.
            && (1..=500).contains(&self.character_ids.len())
            && self
                .character_ids
                .iter()
                .all(|id| (1..=4_294_967_295).contains(id))
            && self.character_ids.iter().collect::<HashSet<_>>().len() == self.character_ids.len()
    }
}

/// Materialize absences for known owners; also run on delayed inventory replay.
/// This preserves existing alert/watch/history exclusions without hot-path array scans.
pub async fn reconcile(
    conn: &mut PgConnection,
    shop: Option<i64>,
    snapshot: Option<(&str, i64)>,
) -> sqlx::Result<()> {
    let mut query = QueryBuilder::<Postgres>::new("INSERT INTO player_departures
       (collector_id,event_id,world,channel,room,character_id,name,seen_at,observed_at,evidence_kind)
       SELECT DISTINCT r.collector_id,md5('roster:'||r.event_id||':'||s.owner_character_id::text),
         r.world,r.channel,r.room,s.owner_character_id,s.owner_name,r.started_at,r.started_at,'room_roster'
       FROM room_rosters r JOIN shops s ON s.world=r.world AND s.channel=r.channel AND s.room=r.room
       WHERE s.owner_character_id IS NOT NULL AND s.owner_name IS NOT NULL
         AND NOT (s.owner_character_id=ANY(r.character_ids))
         AND EXISTS (SELECT 1 FROM observations o WHERE o.shop_id=s.id AND o.observed_at < r.started_at)");
    // Separate query shapes retain index conditions in generic prepared plans.
    // Nullable OR predicates otherwise scan every shop while holding the writer lock.
    if let Some(shop) = shop {
        query.push(" AND s.id=").push_bind(shop);
    }
    if let Some((event, collector)) = snapshot {
        query
            .push(" AND r.event_id=")
            .push_bind(event)
            .push(" AND r.collector_id=")
            .push_bind(collector);
    }
    query
        .push(" ON CONFLICT DO NOTHING")
        .build()
        .execute(conn)
        .await?;
    Ok(())
}

pub async fn ingest(db: &PgPool, collector: i64, event: &Roster, now: f64) -> sqlx::Result<bool> {
    let mut timing = WriteTiming::new("roster");
    let mut tx = db.begin().await?;
    timing.mark(Phase::Pool);
    stats::lock_writes(&mut tx).await?;
    timing.mark(Phase::Lock);
    let inserted=sqlx::query("INSERT INTO room_rosters(collector_id,event_id,world,channel,room,started_at,observed_at,character_ids)
      VALUES($1,$2,$3,$4,$5,to_timestamp($6),to_timestamp($7),$8) ON CONFLICT DO NOTHING")
      .bind(collector).bind(&event.event_id).bind(&event.world).bind(event.location.channel).bind(event.location.room)
      .bind(event.started_at).bind(event.observed_at).bind(&event.character_ids).execute(&mut *tx).await?.rows_affected();
    if inserted == 0 {
        timing.duplicate();
        return Ok(false);
    }
    reconcile(&mut tx, None, Some((&event.event_id, collector))).await?;
    let items = presence::expire_room(&mut tx, &event.location).await?;
    timing.items = items.len();
    timing.mark(Phase::Write);
    if !items.is_empty() {
        let as_of: f64 = sqlx::query_scalar(
            "UPDATE market_state SET version=version+1 RETURNING extract(epoch FROM as_of)::float8",
        )
        .fetch_one(&mut *tx)
        .await?;
        stats::recompute_items(&mut tx, &items, as_of, now, &Default::default()).await?;
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
        .allow(&format!("room-roster:{}", collector.id), 120)
    {
        return error(StatusCode::TOO_MANY_REQUESTS, "Rate limited");
    }
    let now = unix_now();
    let event = match serde_json::from_slice::<Roster>(&body) {
        Ok(e) if e.valid(now) => e,
        _ => return error(StatusCode::BAD_REQUEST, "Invalid room roster"),
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

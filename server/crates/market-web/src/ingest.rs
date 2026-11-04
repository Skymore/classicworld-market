//! Write path (REDESIGN_PLAN_V2 §3.1). One transaction per bounded batch:
//!
//! 1. idempotency on (collector, observation_id): same fingerprint is a
//!    no-op, different content is a conflict;
//! 2. store the observation, its rows and the gzip body;
//! 3. replay that shop's observations: rewrite its listings, diff its sales;
//! 4. recompute the batch's distinct changed items once;
//! 5. bump the market version (the list ETag).
//!
//! Writers hold one transaction-scoped advisory lock, so uploads, refreshes
//! and replays never interleave. Concurrent HTTP uploads share a bounded
//! batch; each observation keeps its own savepoint and idempotency result.

use std::collections::{BTreeSet, HashMap, HashSet};
use std::io::{Read as _, Write as _};

use flate2::{write::GzEncoder, Compression};
use market_core::item::category_name;
use market_core::protocol::{Equipment, Upload, WORLD};
use market_core::sales::{replay, ShopRow, ShopVisit};
use market_core::{visit_key, Location, ShopIdentity};
use serde_json::{json, Value};
use sqlx::{Acquire, PgConnection, PgPool, Row};

use crate::auth::Collector;
use crate::stats::{lock_writes, recompute_items};
use crate::write_timing::{Phase, WriteTiming};

#[derive(Debug, thiserror::Error)]
pub enum IngestError {
    #[error("observation id reused with different content")]
    Conflict,
    #[error(transparent)]
    Db(#[from] sqlx::Error),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum IngestOutcome {
    Created(Ingested),
    Duplicate,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Ingested {
    pub observation: i64,
    pub touched_items: usize,
    pub sales_added: usize,
    pub sales_removed: usize,
}

pub struct Received<'a> {
    pub collector: &'a Collector,
    pub upload: &'a Upload,
    /// Request body as received; stored gzip-compressed in `uploads_raw`.
    pub raw: &'a [u8],
    pub received_at: f64,
    /// Clock for the 72-hour quote window.
    pub now: f64,
}

pub async fn ingest(db: &PgPool, input: Received<'_>) -> Result<IngestOutcome, IngestError> {
    ingest_batch(db, &[input]).await?.pop().expect("one upload")
}

struct PendingStats {
    items: Vec<i32>,
    seen_at: HashMap<i32, f64>,
    as_of: f64,
    now: f64,
}

/// A committed batch has exactly the same raw observations, listing replay and
/// sales as sequential uploads. Statistics are published with them atomically.
/// A bad observation rolls back to its own savepoint, not its neighbours.
pub async fn ingest_batch(
    db: &PgPool,
    inputs: &[Received<'_>],
) -> sqlx::Result<Vec<Result<IngestOutcome, IngestError>>> {
    if inputs.is_empty() {
        return Ok(Vec::new());
    }
    let mut timing = WriteTiming::new("upload");
    timing.units = inputs.len();
    // CPU-only preparation does not extend the global writer lock.
    let prepared: Vec<_> = inputs
        .iter()
        .map(|input| (input.upload.fingerprint(), gzip(input.raw)))
        .collect();
    timing.mark(Phase::Prepare);
    let mut tx = db.begin().await?;
    timing.mark(Phase::Pool);
    lock_writes(&mut tx).await?;
    timing.mark(Phase::Lock);
    let mut results = Vec::with_capacity(inputs.len());
    let mut items = BTreeSet::new();
    let mut seen_at: HashMap<i32, f64> = HashMap::new();
    let mut latest: Option<(f64, f64)> = None;
    for (input, (fingerprint, compressed)) in inputs.iter().zip(&prepared) {
        let mut savepoint = tx.begin().await?;
        match ingest_one(&mut savepoint, input, fingerprint, compressed).await {
            Ok((outcome, pending)) => {
                savepoint.commit().await?;
                if let Some(pending) = pending {
                    items.extend(pending.items);
                    for (id, seen) in pending.seen_at {
                        seen_at
                            .entry(id)
                            .and_modify(|old| *old = old.max(seen))
                            .or_insert(seen);
                    }
                    latest = Some(match latest {
                        Some((as_of, now)) => (as_of.max(pending.as_of), now.max(pending.now)),
                        None => (pending.as_of, pending.now),
                    });
                }
                results.push(Ok(outcome));
            }
            Err(error) => {
                savepoint.rollback().await?;
                results.push(Err(error));
            }
        }
    }
    timing.items = items.len();
    timing.mark(Phase::Write);
    if let Some((as_of, now)) = latest {
        let items: Vec<i32> = items.into_iter().collect();
        recompute_items(&mut tx, &items, as_of, now, &seen_at).await?;
        // One notification after all raw data and statistics commit together.
        crate::realtime::notify_market(&mut tx, Some(&items[..])).await?;
    }
    timing.mark(Phase::Stats);
    tx.commit().await?;
    timing.committed();
    Ok(results)
}

async fn ingest_one(
    tx: &mut PgConnection,
    input: &Received<'_>,
    fingerprint: &str,
    compressed: &[u8],
) -> Result<(IngestOutcome, Option<PendingStats>), IngestError> {
    let upload = input.upload;

    let existing: Option<String> = sqlx::query_scalar(
        "SELECT fingerprint FROM observations WHERE collector_id = $1 AND observation_id = $2",
    )
    .bind(input.collector.id)
    .bind(&upload.observation_id)
    .fetch_optional(&mut *tx)
    .await?;
    if let Some(stored) = existing {
        return if stored == fingerprint {
            Ok((IngestOutcome::Duplicate, None))
        } else {
            Err(IngestError::Conflict)
        };
    }

    let observed = upload.observed_seconds();
    let (shop, new_shop) = upsert_shop(tx, input.collector, upload, observed).await?;
    ensure_items(tx, upload).await?;
    let variants = upsert_variants(tx, upload).await?;
    let observation: i64 = sqlx::query_scalar(
        "INSERT INTO observations (observation_id, collector_id, shop_id, source, reader_version, observed_at,
             received_at, fingerprint, visit_key)
         VALUES ($1, $2, $3, $4, $5, to_timestamp($6), to_timestamp($7), $8, $9) RETURNING id",
    )
    .bind(&upload.observation_id)
    .bind(input.collector.id)
    .bind(shop)
    .bind(upload.source.as_str())
    .bind(&upload.reader_version)
    .bind(observed)
    .bind(input.received_at)
    .bind(fingerprint)
    .bind(visit_key(&input.collector.public_id, &upload.observation_id))
    .fetch_one(&mut *tx)
    .await?;
    // Optional map metadata is separate from Free Market shop identity.
    if let Some((channel, map_id)) = map_context(input.raw) {
        sqlx::query("UPDATE observations SET map_channel=$2, map_id=$3 WHERE id=$1")
            .bind(observation)
            .bind(channel)
            .bind(map_id)
            .execute(&mut *tx)
            .await?;
    }
    insert_rows(tx, observation, upload, &variants).await?;
    bind_owner(tx, shop, observation, upload.owner.as_ref()).await?;
    sqlx::query("INSERT INTO uploads_raw (collector_id, observation_id, received_at, body) VALUES ($1, $2, to_timestamp($3), $4)")
        .bind(input.collector.id)
        .bind(&upload.observation_id)
        .bind(input.received_at)
        .bind(compressed)
        .execute(&mut *tx)
        .await?;
    sqlx::query("UPDATE collectors SET last_seen_at = GREATEST(last_seen_at, to_timestamp($2)) WHERE id = $1")
        .bind(input.collector.id)
        .bind(input.received_at)
        .execute(&mut *tx)
        .await?;
    let as_of: f64 = sqlx::query_scalar(
        "UPDATE market_state SET version = version + 1, as_of = GREATEST(as_of, to_timestamp($1)),
             visits = visits + 1, observation_rows = observation_rows + $2, shops = shops + $3
         RETURNING extract(epoch FROM as_of)::float8",
    )
    .bind(observed)
    .bind(upload.items.len() as i64)
    .bind(i64::from(new_shop))
    .fetch_one(&mut *tx)
    .await?;

    let mut changes = replay_shop(tx, shop).await?;
    changes
        .items
        .extend(reconcile_owner_listings(tx, shop).await?);
    // Read the stored time back so last_seen_at has the database precision.
    let seen: f64 = sqlx::query_scalar(
        "SELECT extract(epoch FROM observed_at)::float8 FROM observations WHERE id = $1",
    )
    .bind(observation)
    .fetch_one(&mut *tx)
    .await?;
    let in_upload: HashSet<i32> = upload.items.iter().map(|r| r.item_id as i32).collect();
    let mut touched: BTreeSet<i32> = changes.items;
    touched.extend(&in_upload);
    let touched: Vec<i32> = touched.into_iter().collect();
    let seen_at: HashMap<i32, f64> = in_upload.iter().map(|&id| (id, seen)).collect();
    Ok((
        IngestOutcome::Created(Ingested {
            observation,
            touched_items: touched.len(),
            sales_added: changes.sales_added,
            sales_removed: changes.sales_removed,
        }),
        Some(PendingStats {
            items: touched,
            seen_at,
            as_of,
            now: input.now,
        }),
    ))
}

/// Fill a missing location for this collector's own immutable observation.
/// All original fields, including prices, quantities and time, must match.
pub async fn repair_location(db: &PgPool, input: Received<'_>) -> Result<bool, IngestError> {
    let upload = input.upload;
    let location = upload.location.ok_or(IngestError::Conflict)?;
    if map_context(input.raw)
        != Some((location.channel as i16, 80002000 + i32::from(location.room)))
    {
        return Err(IngestError::Conflict);
    }
    let mut tx = db.begin().await?;
    lock_writes(&mut tx).await?;
    let row = sqlx::query("SELECT o.id,o.shop_id,s.channel,s.room,r.body,to_jsonb(s) original_shop,o.map_channel,o.map_id
        FROM observations o JOIN shops s ON s.id=o.shop_id
        JOIN uploads_raw r USING(collector_id,observation_id)
        WHERE o.collector_id=$1 AND o.observation_id=$2")
        .bind(input.collector.id).bind(&upload.observation_id).fetch_optional(&mut *tx).await?;
    let Some(row) = row else {
        return Ok(false);
    };
    let raw: Vec<u8> = row.get("body");
    let mut text = String::new();
    flate2::read::GzDecoder::new(raw.as_slice())
        .read_to_string(&mut text)
        .map_err(|_| IngestError::Conflict)?;
    let original = serde_json::from_str::<Value>(&text)
        .ok()
        .and_then(|v| market_core::protocol::validate(&v, input.now).ok())
        .ok_or(IngestError::Conflict)?;
    let mut unchanged = upload.clone();
    unchanged.location = None;
    if original.location.is_some() || unchanged.fingerprint() != original.fingerprint() {
        return Err(IngestError::Conflict);
    }
    let channel: Option<i16> = row.get("channel");
    let room: Option<i16> = row.get("room");
    if channel.is_some() || room.is_some() {
        return if channel == Some(location.channel as i16) && room == Some(location.room as i16) {
            Ok(false)
        } else {
            Err(IngestError::Conflict)
        };
    }
    let map_channel: Option<i16> = row.get("map_channel");
    let map_id: Option<i32> = row.get("map_id");
    if map_channel.is_some_and(|c| c != location.channel as i16)
        || map_id.is_some_and(|m| m != 80002000 + i32::from(location.room))
    {
        return Err(IngestError::Conflict);
    }
    let id: i64 = row.get("id");
    let old_shop: i64 = row.get("shop_id");
    let original_shop: Value = row.get("original_shop");
    let (shop, new_shop) =
        upsert_shop(&mut tx, input.collector, upload, upload.observed_seconds()).await?;
    sqlx::query("INSERT INTO observation_location_repairs(observation_id,collector_id,original_shop,channel,room)
        VALUES($1,$2,$3,$4,$5)")
        .bind(id).bind(input.collector.id).bind(original_shop).bind(location.channel as i16).bind(location.room as i16)
        .execute(&mut *tx).await?;
    sqlx::query("UPDATE observations SET shop_id=$2,map_channel=$3,map_id=$4 WHERE id=$1")
        .bind(id)
        .bind(shop)
        .bind(location.channel as i16)
        .bind(80002000 + i32::from(location.room))
        .execute(&mut *tx)
        .await?;
    // Replay both sides so a known shop and its formerly unknown copy do not double-count stock.
    bind_owner(&mut tx, shop, id, upload.owner.as_ref()).await?;
    let mut touched = replay_shop(&mut tx, old_shop).await?.items;
    touched.extend(replay_shop(&mut tx, shop).await?.items);
    touched.extend(reconcile_owner_listings(&mut tx, shop).await?);
    let removed = sqlx::query(
        "DELETE FROM shops WHERE id=$1 AND NOT EXISTS(SELECT 1 FROM observations WHERE shop_id=$1)",
    )
    .bind(old_shop)
    .execute(&mut *tx)
    .await?
    .rows_affected();
    sqlx::query("UPDATE shops SET first_seen_at=a.first_at,last_seen_at=a.last_at FROM
        (SELECT min(observed_at) first_at,max(observed_at) last_at FROM observations WHERE shop_id=$1) a
        WHERE id=$1 AND a.first_at IS NOT NULL").bind(old_shop).execute(&mut *tx).await?;
    let as_of: f64 = sqlx::query_scalar("UPDATE market_state SET version=version+1,shops=shops+$1 RETURNING extract(epoch FROM as_of)::float8")
        .bind(i64::from(new_shop)-removed as i64).fetch_one(&mut *tx).await?;
    let touched: Vec<i32> = touched.into_iter().collect();
    recompute_items(&mut tx, &touched, as_of, input.now, &HashMap::new()).await?;
    crate::realtime::notify_market(&mut tx, Some(&touched[..])).await?;
    tx.commit().await?;
    Ok(true)
}

/// Attach evidence to this collector's existing observation without changing
/// its immutable payload, fingerprint, timestamp, item rows, or contribution count.
pub async fn repair_owner(db: &PgPool, input: Received<'_>) -> Result<bool, IngestError> {
    let owner = input.upload.owner.as_ref().ok_or(IngestError::Conflict)?;
    let mut tx = db.begin().await?;
    lock_writes(&mut tx).await?;
    let record = sqlx::query(
        "SELECT o.id,o.shop_id,r.body FROM observations o
        JOIN uploads_raw r USING(collector_id,observation_id)
        WHERE o.collector_id=$1 AND o.observation_id=$2",
    )
    .bind(input.collector.id)
    .bind(&input.upload.observation_id)
    .fetch_optional(&mut *tx)
    .await?;
    let Some(record) = record else {
        return Err(IngestError::Conflict);
    };
    let bytes: Vec<u8> = record.get("body");
    let mut text = String::new();
    flate2::read::GzDecoder::new(bytes.as_slice())
        .read_to_string(&mut text)
        .map_err(|_| IngestError::Conflict)?;
    let original = serde_json::from_str::<Value>(&text)
        .ok()
        .and_then(|v| market_core::protocol::validate(&v, input.upload.observed_seconds()).ok())
        .ok_or(IngestError::Conflict)?;
    let mut unchanged = input.upload.clone();
    unchanged.owner = original.owner.clone();
    // Location may already have been separately enriched. This operation never
    // writes it; compare all the original observation facts independently of it.
    unchanged.location = original.location;
    // Older collector versions did not emit the optional enhancement count.
    // Re-decoding the same local record may add it. Ignore only that newly
    // available field for identity enrichment; never rewrite stored equipment.
    for (incoming, stored) in unchanged.items.iter_mut().zip(&original.items) {
        if let (Some(Equipment::Candidate(a)), Some(Equipment::Candidate(b))) =
            (&mut incoming.equipment, &stored.equipment)
        {
            if b.enhancements.is_none() {
                a.enhancements = None;
            }
            if b.remaining_upgrades.is_none() {
                a.remaining_upgrades = None;
            }
        }
    }
    if unchanged.fingerprint() != original.fingerprint()
        || original.owner.as_ref().is_some_and(|o| o != owner)
    {
        return Err(IngestError::Conflict);
    }
    let observation: i64 = record.get("id");
    let shop: i64 = record.get("shop_id");
    let existing: Option<(i64, String)> = sqlx::query_as(
        "SELECT character_id,name FROM observation_shop_owners WHERE observation_id=$1",
    )
    .bind(observation)
    .fetch_optional(&mut *tx)
    .await?;
    if let Some((id, name)) = existing {
        return if id == i64::from(owner.character_id) && name == owner.name {
            Ok(false)
        } else {
            Err(IngestError::Conflict)
        };
    }
    bind_owner(&mut tx, shop, observation, Some(owner)).await?;
    // Enrichment changes identity metadata only. Existing instances already
    // have their latest complete lists; replaying unchanged history here would
    // rewrite every item and emit thousands of unnecessary live updates.
    let touched = reconcile_owner_listings(&mut tx, shop).await?;
    if touched.is_empty() {
        tx.commit().await?;
        return Ok(true);
    }
    let as_of: f64 = sqlx::query_scalar(
        "UPDATE market_state SET version=version+1 RETURNING extract(epoch FROM as_of)::float8",
    )
    .fetch_one(&mut *tx)
    .await?;
    let touched: Vec<i32> = touched.into_iter().collect();
    recompute_items(&mut tx, &touched, as_of, input.now, &HashMap::new()).await?;
    crate::realtime::notify_market(&mut tx, Some(&touched[..])).await?;
    tx.commit().await?;
    Ok(true)
}

async fn bind_owner(
    conn: &mut PgConnection,
    shop: i64,
    observation: i64,
    owner: Option<&market_core::protocol::ShopOwner>,
) -> Result<(), IngestError> {
    let evidence = if let Some(owner) = owner {
        Some((i64::from(owner.character_id), owner.name.clone()))
    } else {
        sqlx::query_as::<_, (i64, String)>(
            "SELECT character_id,name FROM observation_shop_owners WHERE observation_id=$1",
        )
        .bind(observation)
        .fetch_optional(&mut *conn)
        .await?
    };
    let Some((id, name)) = evidence else {
        return Ok(());
    };
    let changed = sqlx::query(
        "UPDATE shops SET owner_character_id=$2,owner_name=$3
        WHERE id=$1 AND (owner_character_id IS NULL OR owner_character_id=$2)",
    )
    .bind(shop)
    .bind(id)
    .bind(&name)
    .execute(&mut *conn)
    .await?
    .rows_affected();
    if changed != 1 {
        return Err(IngestError::Conflict);
    }
    sqlx::query(
        "INSERT INTO observation_shop_owners(observation_id,character_id,name,parser)
        VALUES($1,$2,$3,'cw_shop_owner_v1') ON CONFLICT(observation_id) DO NOTHING",
    )
    .bind(observation)
    .bind(id)
    .bind(name)
    .execute(&mut *conn)
    .await?;
    Ok(())
}

/// All shop instances remain in history. Only the latest complete observation
/// for a known host may supply live listings, even when an old upload arrives late.
async fn reconcile_owner_listings(
    conn: &mut PgConnection,
    shop: i64,
) -> sqlx::Result<BTreeSet<i32>> {
    let removed: Vec<i32> = sqlx::query_scalar(
        "WITH family AS (
            SELECT sibling.id FROM shops s JOIN shops sibling
            ON sibling.world=s.world AND sibling.owner_character_id=s.owner_character_id
            WHERE s.id=$1 AND s.owner_character_id IS NOT NULL
        ), latest AS (
            SELECT o.shop_id FROM observations o JOIN family f ON f.id=o.shop_id
            ORDER BY o.observed_at DESC,o.visit_key DESC LIMIT 1
        ) DELETE FROM listings l WHERE l.shop_id IN (SELECT id FROM family)
          AND l.shop_id <> (SELECT shop_id FROM latest) RETURNING l.item_id",
    )
    .bind(shop)
    .fetch_all(&mut *conn)
    .await?;
    let mut changed: BTreeSet<i32> = removed.into_iter().collect();
    crate::roster::reconcile(conn, Some(shop), None).await?;
    changed.extend(crate::presence::expire(conn, Some(shop), None).await?);
    Ok(changed)
}

fn map_context(raw: &[u8]) -> Option<(i16, i32)> {
    let body: Value = serde_json::from_slice(raw).ok()?;
    let context = body.get("map_context")?;
    let channel = context.get("channel")?.as_i64()?;
    let map = context.get("map_id")?.as_i64()?;
    ((1..=i64::from(market_core::protocol::MAX_CHANNEL)).contains(&channel)
        && (0..1_000_000_000).contains(&map))
    .then_some((channel as i16, map as i32))
}

fn gzip(bytes: &[u8]) -> Vec<u8> {
    let mut encoder = GzEncoder::new(Vec::new(), Compression::default());
    encoder.write_all(bytes).expect("writing to memory");
    encoder.finish().expect("writing to memory")
}

pub fn shop_identity(collector: &Collector, upload: &Upload) -> ShopIdentity {
    ShopIdentity {
        world: WORLD.to_string(),
        location: upload.location.map(|l| Location {
            channel: l.channel,
            room: l.room,
        }),
        shop_id: upload.shop_id,
        title: upload.title.clone(),
        collector: collector.public_id.clone(),
    }
}

/// Shop row id, and whether this upload created it.
async fn upsert_shop(
    conn: &mut PgConnection,
    collector: &Collector,
    upload: &Upload,
    observed: f64,
) -> sqlx::Result<(i64, bool)> {
    let identity = shop_identity(collector, upload);
    sqlx::query_as(
        "INSERT INTO shops (shop_key, public_key, world, channel, room, shop_id, title, first_seen_at, last_seen_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, to_timestamp($8), to_timestamp($8))
         ON CONFLICT (shop_key) DO UPDATE SET
             first_seen_at = LEAST(shops.first_seen_at, EXCLUDED.first_seen_at),
             last_seen_at = GREATEST(shops.last_seen_at, EXCLUDED.last_seen_at)
         RETURNING id, xmax = 0",
    )
    .bind(identity.key())
    .bind(identity.public_key())
    .bind(&identity.world)
    .bind(upload.location.map(|l| l.channel as i16))
    .bind(upload.location.map(|l| l.room as i16))
    .bind(i64::from(upload.shop_id))
    .bind(&upload.title)
    .bind(observed)
    .fetch_one(conn)
    .await
}

/// Items missing from the catalogue get a placeholder row, as Python lists
/// unknown ids under their number. The catalogue import overwrites it.
async fn ensure_items(conn: &mut PgConnection, upload: &Upload) -> sqlx::Result<()> {
    let ids: Vec<i32> = upload.items.iter().map(|r| r.item_id as i32).collect();
    let categories: Vec<&str> = ids.iter().map(|&id| category_name(i64::from(id))).collect();
    sqlx::query(
        "INSERT INTO items (id, name_en, category, subcategory)
         SELECT id, '', category, '未知' FROM UNNEST($1::int4[], $2::text[]) AS t(id, category)
         ON CONFLICT (id) DO NOTHING",
    )
    .bind(&ids)
    .bind(&categories)
    .execute(conn)
    .await?;
    Ok(())
}

type VariantIds = HashMap<(u32, [u8; 32]), i64>;

async fn upsert_variants(conn: &mut PgConnection, upload: &Upload) -> sqlx::Result<VariantIds> {
    let rows: Vec<Value> = upload
        .items
        .iter()
        .filter_map(|row| match (&row.equipment, row.variant()) {
            (Some(eq @ Equipment::Candidate(_)), market_core::protocol::Variant::Stats(hash)) => {
                Some(json!({"item_id": row.item_id, "stats_hash": hex::encode(hash), "stats": eq.to_json()}))
            }
            _ => None,
        })
        .collect();
    if rows.is_empty() {
        return Ok(VariantIds::new());
    }
    let rows = Value::Array(rows);
    sqlx::query(
        "INSERT INTO equipment_variants (item_id, stats_hash, stats)
         SELECT DISTINCT ON (item_id, stats_hash) item_id, decode(stats_hash, 'hex'), stats
         FROM jsonb_to_recordset($1) AS x(item_id int, stats_hash text, stats jsonb)
         ON CONFLICT (item_id, stats_hash) DO NOTHING",
    )
    .bind(&rows)
    .execute(&mut *conn)
    .await?;
    let found = sqlx::query(
        "SELECT v.id, v.item_id, v.stats_hash FROM equipment_variants v
         JOIN jsonb_to_recordset($1) AS x(item_id int, stats_hash text)
           ON v.item_id = x.item_id AND v.stats_hash = decode(x.stats_hash, 'hex')",
    )
    .bind(&rows)
    .fetch_all(conn)
    .await?;
    Ok(found
        .into_iter()
        .map(|row| {
            let hash: Vec<u8> = row.get(2);
            let item: i32 = row.get(1);
            ((item as u32, hash.try_into().expect("sha256")), row.get(0))
        })
        .collect())
}

async fn insert_rows(
    conn: &mut PgConnection,
    observation: i64,
    upload: &Upload,
    variants: &VariantIds,
) -> sqlx::Result<()> {
    let rows = upload.encoded_rows();
    let position: Vec<i16> = (0..rows.len() as i16).collect();
    let slot: Vec<i32> = rows.iter().map(|(slot, _)| *slot).collect();
    let item: Vec<i32> = rows.iter().map(|(_, r)| r.item_id as i32).collect();
    let variant: Vec<Option<i64>> = rows
        .iter()
        .map(|(_, r)| match r.variant() {
            market_core::protocol::Variant::Stats(hash) => {
                variants.get(&(r.item_id, hash)).copied()
            }
            _ => None,
        })
        .collect();
    let price: Vec<i64> = rows.iter().map(|(_, r)| r.price as i64).collect();
    let bundle: Vec<i32> = rows.iter().map(|(_, r)| r.bundle as i32).collect();
    let stock: Vec<i32> = rows.iter().map(|(_, r)| r.stock as i32).collect();
    sqlx::query(
        "INSERT INTO observation_rows (observation_id, position, slot, item_id, variant_id, price, bundle, stock)
         SELECT $1, * FROM UNNEST($2::int2[], $3::int4[], $4::int4[], $5::int8[], $6::int8[], $7::int4[], $8::int4[])",
    )
    .bind(observation)
    .bind(&position)
    .bind(&slot)
    .bind(&item)
    .bind(&variant)
    .bind(&price)
    .bind(&bundle)
    .bind(&stock)
    .execute(conn)
    .await?;
    Ok(())
}

struct ShopChanges {
    /// Items whose listings or sales in this shop changed.
    items: BTreeSet<i32>,
    sales_added: usize,
    sales_removed: usize,
}

/// A sale as stored: identity (observation, slot) plus everything replay derives.
#[derive(Debug, Clone, PartialEq)]
struct SaleRecord {
    observation: i64,
    slot: i32,
    position: i16,
    item: i32,
    variant: Option<i64>,
    kind: &'static str,
    price: i64,
    bundle: i32,
    quantity: Option<i64>,
    window_start: Option<f64>,
    detected_at: f64,
}

/// (observation id, visit, row positions, source is `screen`)
type Visit = (i64, ShopVisit<Option<i64>>, Vec<i16>, bool);

async fn load_shop(conn: &mut PgConnection, shop: i64) -> sqlx::Result<Vec<Visit>> {
    let rows = sqlx::query(
        "SELECT o.id, extract(epoch FROM o.observed_at)::float8, r.position, r.slot, r.item_id, r.variant_id,
                r.price, r.bundle, r.stock, o.source = 'screen'
         FROM observations o LEFT JOIN observation_rows r ON r.observation_id = o.id
         WHERE o.shop_id = $1 ORDER BY o.observed_at, o.visit_key, r.position",
    )
    .bind(shop)
    .fetch_all(conn)
    .await?;
    let mut visits: Vec<Visit> = Vec::new();
    for row in rows {
        let id: i64 = row.get(0);
        if visits.last().is_none_or(|(last, ..)| *last != id) {
            visits.push((
                id,
                ShopVisit {
                    time: row.get(1),
                    rows: vec![],
                },
                vec![],
                row.get(9),
            ));
        }
        let Some(position) = row.get::<Option<i16>, _>(2) else {
            continue; // empty snapshot
        };
        let (_, visit, positions, _) = visits.last_mut().expect("pushed above");
        positions.push(position);
        visit.rows.push(ShopRow {
            slot: row.get(3),
            item_id: row.get(4),
            variant: row.get(5),
            price: row.get(6),
            bundle: row.get(7),
            stock: row.get(8),
        });
    }
    Ok(visits)
}

async fn replay_shop(conn: &mut PgConnection, shop: i64) -> sqlx::Result<ShopChanges> {
    let visits = load_shop(conn, shop).await?;
    let shop_visits: Vec<ShopVisit<Option<i64>>> =
        visits.iter().map(|(_, v, ..)| v.clone()).collect();
    let result = replay(&shop_visits);
    let desired: Vec<SaleRecord> = result
        .sales
        .iter()
        .map(|s| {
            let (observation, visit, positions, screen) = &visits[s.visit];
            let row = &visit.rows[s.row];
            // The screen reader cannot see stock (it sends 1 or 0), so a sale
            // it detects has an unknown quantity, like found_sold.
            let quantity = if *screen { None } else { s.quantity };
            SaleRecord {
                observation: *observation,
                slot: row.slot,
                position: positions[s.row],
                item: row.item_id,
                variant: row.variant,
                kind: s.kind.as_str(),
                price: s.sale_price,
                bundle: s.sale_bundle,
                quantity,
                window_start: s.previous_time,
                detected_at: visit.time,
            }
        })
        .collect();

    let existing: Vec<SaleRecord> = sqlx::query(
        "SELECT observation_id, slot, position, item_id, variant_id, kind, price, bundle, quantity,
                extract(epoch FROM window_start)::float8, extract(epoch FROM detected_at)::float8
         FROM sales WHERE shop_id = $1",
    )
    .bind(shop)
    .fetch_all(&mut *conn)
    .await?
    .into_iter()
    .map(|row| SaleRecord {
        observation: row.get(0),
        slot: row.get(1),
        position: row.get(2),
        item: row.get(3),
        variant: row.get(4),
        kind: market_core::sales::SaleKind::parse(row.get(5))
            .expect("sales.kind check constraint")
            .as_str(),
        price: row.get(6),
        bundle: row.get(7),
        quantity: row.get(8),
        window_start: row.get(9),
        detected_at: row.get(10),
    })
    .collect();

    let removed: Vec<&SaleRecord> = existing.iter().filter(|s| !desired.contains(s)).collect();
    let added: Vec<&SaleRecord> = desired.iter().filter(|s| !existing.contains(s)).collect();
    let mut items: BTreeSet<i32> = removed.iter().chain(&added).map(|s| s.item).collect();
    if !removed.is_empty() {
        sqlx::query(
            "DELETE FROM sales s USING UNNEST($1::int8[], $2::int4[]) AS d(observation_id, slot)
             WHERE s.observation_id = d.observation_id AND s.slot = d.slot",
        )
        .bind(removed.iter().map(|s| s.observation).collect::<Vec<_>>())
        .bind(removed.iter().map(|s| s.slot).collect::<Vec<_>>())
        .execute(&mut *conn)
        .await?;
    }
    if !added.is_empty() {
        sqlx::query(
            "INSERT INTO sales (observation_id, slot, position, item_id, variant_id, shop_id, kind, price, bundle,
                 quantity, window_start, detected_at)
             SELECT o, sl, p, i, v, $1, k, pr, b, q, to_timestamp(w), to_timestamp(d)
             FROM UNNEST($2::int8[], $3::int4[], $4::int2[], $5::int4[], $6::int8[], $7::text[], $8::int8[],
                         $9::int4[], $10::int8[], $11::float8[], $12::float8[])
                  AS t(o, sl, p, i, v, k, pr, b, q, w, d)",
        )
        .bind(shop)
        .bind(added.iter().map(|s| s.observation).collect::<Vec<_>>())
        .bind(added.iter().map(|s| s.slot).collect::<Vec<_>>())
        .bind(added.iter().map(|s| s.position).collect::<Vec<_>>())
        .bind(added.iter().map(|s| s.item).collect::<Vec<_>>())
        .bind(added.iter().map(|s| s.variant).collect::<Vec<_>>())
        .bind(added.iter().map(|s| s.kind).collect::<Vec<_>>())
        .bind(added.iter().map(|s| s.price).collect::<Vec<_>>())
        .bind(added.iter().map(|s| s.bundle).collect::<Vec<_>>())
        .bind(added.iter().map(|s| s.quantity).collect::<Vec<_>>())
        .bind(added.iter().map(|s| s.window_start).collect::<Vec<_>>())
        .bind(added.iter().map(|s| s.detected_at).collect::<Vec<_>>())
        .execute(&mut *conn)
        .await?;
    }

    // Listings are the latest observation's rows; rewrite them whole.
    let old: Vec<i32> =
        sqlx::query_scalar("DELETE FROM listings WHERE shop_id = $1 RETURNING item_id")
            .bind(shop)
            .fetch_all(&mut *conn)
            .await?;
    items.extend(old);
    if let Some(latest) = result.latest {
        let (observation, visit, ..) = &visits[latest];
        items.extend(visit.rows.iter().map(|r| r.item_id));
        sqlx::query(
            "INSERT INTO listings (shop_id, observation_id, slot, item_id, variant_id, price, bundle, stock,
                 first_seen_at, last_seen_at)
             SELECT $1, $2, sl, i, v, p, b, st, to_timestamp(f), to_timestamp($3)
             FROM UNNEST($4::int4[], $5::int4[], $6::int8[], $7::int8[], $8::int4[], $9::int4[], $10::float8[])
                  AS t(sl, i, v, p, b, st, f)",
        )
        .bind(shop)
        .bind(observation)
        .bind(visit.time)
        .bind(visit.rows.iter().map(|r| r.slot).collect::<Vec<_>>())
        .bind(visit.rows.iter().map(|r| r.item_id).collect::<Vec<_>>())
        .bind(visit.rows.iter().map(|r| r.variant).collect::<Vec<_>>())
        .bind(visit.rows.iter().map(|r| r.price).collect::<Vec<_>>())
        .bind(visit.rows.iter().map(|r| r.bundle).collect::<Vec<_>>())
        .bind(visit.rows.iter().map(|r| r.stock).collect::<Vec<_>>())
        .bind(&result.first_seen)
        .execute(&mut *conn)
        .await?;
    }
    Ok(ShopChanges {
        items,
        sales_added: added.len(),
        sales_removed: removed.len(),
    })
}

#[cfg(test)]
mod map_context_tests {
    use super::map_context;
    #[test]
    fn accepts_outside_market_and_rejects_invalid_metadata() {
        assert_eq!(
            map_context(br#"{"map_context":{"channel":4,"map_id":10004040}}"#),
            Some((4, 10004040))
        );
        assert_eq!(
            map_context(br#"{"map_context":{"channel":256,"map_id":10004040}}"#),
            None
        );
        for channel in [12, 19, 20, 21, 33, 40, 60, 255] {
            let raw = format!(r#"{{"map_context":{{"channel":{channel},"map_id":10004040}}}}"#);
            assert_eq!(map_context(raw.as_bytes()), Some((channel, 10004040)));
        }
        assert_eq!(
            map_context(br#"{"map_context":{"channel":4,"map_id":-1}}"#),
            None
        );
        assert_eq!(
            map_context(br#"{"map_context":{"channel":"4","map_id":10004040}}"#),
            None
        );
        assert_eq!(map_context(br#"{}"#), None);
    }
}

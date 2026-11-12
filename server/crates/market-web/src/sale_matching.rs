//! Conservative inferred cross-source duplicates. Never erase raw evidence.
use std::cmp::Ordering;
use std::collections::{HashMap, HashSet};

use sqlx::PgConnection;

const WINDOW_MICROS: i64 = 6 * 3600 * 1_000_000;

type MatchKey = (i32, String, u64, String);

// PostgreSQL float8 equality treats -0 and 0 as equal.
fn price_bits(p: f64) -> u64 {
    if p == 0.0 {
        0f64.to_bits()
    } else {
        p.to_bits()
    }
}

/// Called under the market write lock, before computing statistics. Rebuilding
/// just these items handles either arrival order, replay and owner enrichment.
///
/// Rule: same item, seller (observed owner, else shop owner), unit price and
/// unit, within 6 hours; nearest pairs win one-to-one. Each side is read with
/// its own index and paired in memory: a single SQL join let the planner walk
/// every sale by shop and held the write lock for minutes on busy items.
pub async fn reconcile(conn: &mut PgConnection, items: &[i32]) -> sqlx::Result<()> {
    let collector: Vec<(i64, i32, i64, Option<i64>, Option<i32>, Option<i64>, Option<f64>, Option<String>)> =
        sqlx::query_as(
            "SELECT id,item_id,(extract(epoch FROM detected_at)*1000000)::bigint,observation_id,slot,shop_id,
                    market_unit_price(item_id,price,bundle),market_price_unit(item_id)
             FROM sales WHERE source='collector' AND item_id=ANY($1) AND item_id>=2000000 AND shop_id IS NOT NULL",
        )
        .bind(items)
        .fetch_all(&mut *conn)
        .await?;
    if collector.is_empty() {
        return replace(conn, items, Vec::new()).await;
    }
    let mut shop_ids: Vec<i64> = collector.iter().filter_map(|r| r.5).collect();
    shop_ids.sort_unstable();
    shop_ids.dedup();
    let mut observation_ids: Vec<i64> = collector.iter().filter_map(|r| r.3).collect();
    observation_ids.sort_unstable();
    observation_ids.dedup();
    let shops: HashMap<i64, Option<String>> =
        sqlx::query_as("SELECT id,owner_name FROM shops WHERE id=ANY($1)")
            .bind(&shop_ids)
            .fetch_all(&mut *conn)
            .await?
            .into_iter()
            .collect();
    let owners: HashMap<i64, String> = sqlx::query_as(
        "SELECT observation_id,name FROM observation_shop_owners WHERE observation_id=ANY($1)",
    )
    .bind(&observation_ids)
    .fetch_all(&mut *conn)
    .await?
    .into_iter()
    .collect();
    // source_key rank keeps the database collation for tie-breaks (NULLS LAST).
    let external: Vec<(i64, i32, String, f64, String, i64, i64)> = sqlx::query_as(
        "SELECT id,item_id,source_seller,source_price,source_unit,
                (extract(epoch FROM detected_at)*1000000)::bigint,dense_rank() OVER (ORDER BY source_key)
         FROM sales WHERE source='mesowatch' AND item_id=ANY($1) AND item_id>=2000000
           AND NULLIF(btrim(source_seller),'') IS NOT NULL
           AND source_price IS NOT NULL AND source_unit IS NOT NULL",
    )
    .bind(items)
    .fetch_all(&mut *conn)
    .await?;
    let mut groups: HashMap<MatchKey, Vec<(i64, i64, i64)>> = HashMap::new();
    for (id, item, seller, price, unit, at, key_rank) in external {
        groups
            .entry((item, seller, price_bits(price), unit))
            .or_default()
            .push((at, key_rank, id));
    }
    for g in groups.values_mut() {
        g.sort_unstable();
    }
    struct Candidate {
        external: i64,
        collector: i64,
        item: i32,
        delta: i64,
        key_rank: i64,
        at: i64,
        observation: Option<i64>,
        slot: Option<i32>,
    }
    let mut candidates = Vec::new();
    let mut key = (0, String::new(), 0, String::new());
    for (id, item, at, observation, slot, shop, price, unit) in collector {
        let (Some(price), Some(unit)) = (price, unit) else {
            continue;
        };
        let Some(shop_owner) = shop.and_then(|s| shops.get(&s)) else {
            continue; // inner join on shops
        };
        let Some(seller) = observation
            .and_then(|o| owners.get(&o))
            .or(shop_owner.as_ref())
        else {
            continue;
        };
        key.0 = item;
        key.1.clone_from(seller);
        key.2 = price_bits(price);
        key.3 = unit;
        let Some(group) = groups.get(&key) else {
            continue;
        };
        let start = group.partition_point(|e| e.0 < at - WINDOW_MICROS);
        for &(e_at, key_rank, e_id) in group[start..]
            .iter()
            .take_while(|e| e.0 <= at + WINDOW_MICROS)
        {
            candidates.push(Candidate {
                external: e_id,
                collector: id,
                item,
                delta: (e_at - at).abs(),
                key_rank,
                at,
                observation,
                slot,
            });
        }
    }
    // ORDER BY delta,e.source_key,c.detected_at,c.observation_id,c.slot,c.id (NULLS LAST).
    fn nulls_last<T: Ord>(a: &Option<T>, b: &Option<T>) -> Ordering {
        match (a, b) {
            (Some(a), Some(b)) => a.cmp(b),
            (Some(_), None) => Ordering::Less,
            (None, Some(_)) => Ordering::Greater,
            (None, None) => Ordering::Equal,
        }
    }
    candidates.sort_unstable_by(|a, b| {
        a.delta
            .cmp(&b.delta)
            .then(a.key_rank.cmp(&b.key_rank))
            .then(a.at.cmp(&b.at))
            .then_with(|| nulls_last(&a.observation, &b.observation))
            .then_with(|| nulls_last(&a.slot, &b.slot))
            .then(a.collector.cmp(&b.collector))
            .then(a.external.cmp(&b.external))
    });
    let mut external = HashSet::new();
    let mut collector = HashSet::new();
    let mut chosen = Vec::new();
    for c in candidates {
        // One native event can suppress at most one external event, even for
        // identical prices/quantities in several slots. Nearest pairs win.
        if external.contains(&c.external) || collector.contains(&c.collector) {
            continue;
        }
        external.insert(c.external);
        collector.insert(c.collector);
        chosen.push((c.external, c.collector, c.item, c.delta as f64 / 1e6));
    }
    replace(conn, items, chosen).await
}

async fn replace(
    conn: &mut PgConnection,
    items: &[i32],
    chosen: Vec<(i64, i64, i32, f64)>,
) -> sqlx::Result<()> {
    sqlx::query("DELETE FROM cross_source_sale_matches WHERE item_id=ANY($1)")
        .bind(items)
        .execute(&mut *conn)
        .await?;
    if !chosen.is_empty() {
        sqlx::query("INSERT INTO cross_source_sale_matches(external_sale_id,collector_sale_id,item_id,delta_seconds)
            SELECT * FROM UNNEST($1::bigint[],$2::bigint[],$3::int[],$4::float8[])")
            .bind(chosen.iter().map(|r| r.0).collect::<Vec<_>>())
            .bind(chosen.iter().map(|r| r.1).collect::<Vec<_>>())
            .bind(chosen.iter().map(|r| r.2).collect::<Vec<_>>())
            .bind(chosen.iter().map(|r| r.3).collect::<Vec<_>>())
            .execute(conn).await?;
    }
    Ok(())
}

/// Explicit historical backfill; commit/release the upload lock for each item.
pub async fn backfill(db: &sqlx::PgPool, now: f64) -> sqlx::Result<u64> {
    // Suppress redundant clock refreshes during the explicit historical pass.
    // This is the refresh coordinator, NOT the collector's write lock; uploads
    // still run between the individual item transactions below.
    let mut coordinator = db.begin().await?;
    sqlx::query("SELECT pg_advisory_xact_lock($1)")
        .bind(crate::stats::WRITE_LOCK + 1)
        .execute(&mut *coordinator)
        .await?;
    let items: Vec<i32> = sqlx::query_scalar("SELECT DISTINCT e.item_id FROM sales e WHERE e.source='mesowatch'
        AND EXISTS(SELECT 1 FROM sales c WHERE c.item_id=e.item_id AND c.source='collector') ORDER BY e.item_id")
        .fetch_all(db).await?;
    for item in items {
        let mut tx = db.begin().await?;
        crate::stats::lock_writes(&mut tx).await?;
        let as_of: f64 = sqlx::query_scalar("UPDATE market_state SET version=version+1 RETURNING COALESCE(extract(epoch FROM as_of)::float8,$1)")
            .bind(now).fetch_one(&mut *tx).await?;
        crate::stats::recompute_items(&mut tx, &[item], as_of, now, &Default::default()).await?;
        crate::realtime::notify_market(&mut tx, Some(&[item])).await?;
        tx.commit().await?;
        tokio::task::yield_now().await;
    }
    let count = sqlx::query_scalar::<_, i64>("SELECT count(*) FROM cross_source_sale_matches")
        .fetch_one(db)
        .await?;
    coordinator.commit().await?;
    Ok(count as u64)
}

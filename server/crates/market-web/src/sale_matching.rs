//! Conservative inferred cross-source duplicates. Never erase raw evidence.
use std::collections::HashSet;

use sqlx::PgConnection;

/// Called under the market write lock, before computing statistics. Rebuilding
/// just these items handles either arrival order, replay and owner enrichment.
pub async fn reconcile(conn: &mut PgConnection, items: &[i32]) -> sqlx::Result<()> {
    let candidates: Vec<(i64, i64, i32, f64)> = sqlx::query_as(
        "SELECT e.id,c.id,c.item_id,abs(extract(epoch FROM e.detected_at-c.detected_at))::float8 AS delta
         FROM sales c JOIN shops sh ON sh.id=c.shop_id
         LEFT JOIN observation_shop_owners owner ON owner.observation_id=c.observation_id
         JOIN sales e ON e.source='mesowatch' AND e.item_id=c.item_id
           AND e.source_seller=COALESCE(owner.name,sh.owner_name)
           AND e.source_price=market_unit_price(c.item_id,c.price,c.bundle)
           AND e.source_unit=market_price_unit(c.item_id)
           AND e.detected_at BETWEEN c.detected_at-interval '6 hours' AND c.detected_at+interval '6 hours'
         WHERE c.source='collector' AND c.item_id=ANY($1) AND c.item_id>=2000000
           AND NULLIF(btrim(e.source_seller),'') IS NOT NULL
         ORDER BY delta,e.source_key,c.detected_at,c.observation_id,c.slot,c.id",
    )
    .bind(items)
    .fetch_all(&mut *conn)
    .await?;
    let mut external = HashSet::new();
    let mut collector = HashSet::new();
    let mut chosen = Vec::new();
    for (e, c, item, delta) in candidates {
        // One native event can suppress at most one external event, even for
        // identical prices/quantities in several slots. Nearest pairs win.
        if external.contains(&e) || collector.contains(&c) {
            continue;
        }
        external.insert(e);
        collector.insert(c);
        chosen.push((e, c, item, delta));
    }
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

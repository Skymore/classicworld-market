//! Precomputed per-item figures: `item_stats` (sale stats + 72-hour quote
//! window), `item_stats_all` (all-records quote window) and `item_daily`.
//!
//! An upload recomputes only the items it touched. Two inputs are global and
//! move without that item being touched: the sale anchor (minute after the
//! latest observation anywhere) and the 72-hour cutoff (wall clock).
//! `refresh_if_due` recomputes small batches when either moved past data, so
//! untouched items lag by at most one refresh interval.

use std::collections::HashMap;

use market_core::pricing::UpgradeState;
use market_core::report::{item_figures, ItemFigures, Listing, SaleEvent, Window, WindowFigures};
use market_core::sales::SaleKind;
use market_core::stats::SalesStats;
use market_core::stats::{anchor, bucket_start};
use serde_json::{json, Value};
use sqlx::{PgConnection, PgPool, Row};

/// Serialises writers (uploads, refreshes, replays) across processes.
pub const WRITE_LOCK: i64 = 0x6377_6d77;

pub async fn lock_writes(conn: &mut PgConnection) -> sqlx::Result<()> {
    sqlx::query("SELECT pg_advisory_xact_lock($1)")
        .bind(WRITE_LOCK)
        .execute(conn)
        .await?;
    Ok(())
}

type ItemData = HashMap<i32, (Vec<Listing>, Vec<SaleEvent>)>;

/// Live listings and all sales (detection order) of `items`, or of every item.
/// Single-table index scans, so an upload costs what its items hold, not
/// what `shops`, `observations` or `equipment_variants` hold.
async fn load(conn: &mut PgConnection, items: Option<&[i32]>) -> sqlx::Result<ItemData> {
    let item_filter = match items {
        Some(_) => "AND item_id = ANY($1)",
        None => "",
    };
    let ids: Vec<i32> = items.map(<[i32]>::to_vec).unwrap_or_default();
    // A listing's last_seen_at is its shop's latest observation.
    let listings = sqlx::query(&format!(
        "SELECT item_id, shop_id, extract(epoch FROM last_seen_at)::float8, variant_id,
                market_unit_price(item_id,price,bundle) AS unit_price
         FROM listings WHERE stock > 0 {item_filter}
         UNION ALL SELECT item_id,-external_shop_id,extract(epoch FROM seen_at)::float8,NULL::bigint,unit_price
         FROM external_market_listings WHERE up {item_filter}"
    ))
    .bind(&ids)
    .fetch_all(&mut *conn)
    .await?;
    // Equal times keep arrival order; Python uses visit id order. They differ
    // only for one item's sales found in the same microsecond by two uploads.
    let sales = sqlx::query(&format!(
        "SELECT item_id, extract(epoch FROM detected_at)::float8 AS detected, kind, grouping_shop_id,
                COALESCE(slot,0), variant_id, unit_price
         FROM market_sales WHERE true {item_filter} ORDER BY item_id, detected_at, observation_id NULLS LAST, position NULLS LAST,id"
    ))
    .bind(&ids)
    .fetch_all(&mut *conn)
    .await?;

    let mut variants: Vec<i64> = listings
        .iter()
        .chain(&sales)
        .filter_map(|row| row.get::<Option<i64>, _>("variant_id"))
        .collect();
    variants.sort_unstable();
    variants.dedup();
    let upgrades: HashMap<i64, UpgradeState> =
        sqlx::query_as::<_, (i64, Option<i64>, Option<i64>)>(
            "SELECT id, (stats->>'enhancements')::int8, (stats->>'remaining_upgrades')::int8
         FROM equipment_variants WHERE id = ANY($1)",
        )
        .bind(&variants)
        .fetch_all(&mut *conn)
        .await?
        .into_iter()
        .map(|(id, enhancements, remaining_upgrades)| {
            (
                id,
                UpgradeState {
                    enhancements,
                    remaining_upgrades,
                },
            )
        })
        .collect();
    let upgrade = |variant: Option<i64>| variant.and_then(|v| upgrades.get(&v).copied());

    let mut data = ItemData::new();
    for row in listings {
        let variant: Option<i64> = row.get(3);
        data.entry(row.get(0)).or_default().0.push(Listing {
            shop: row.get(1),
            shop_seen: row.get(2),
            variant,
            unit_price: row.get(4),
            upgrade: upgrade(variant),
        });
    }
    for row in sales {
        let variant: Option<i64> = row.get(5);
        let kind: String = row.get(2);
        data.entry(row.get(0)).or_default().1.push(SaleEvent {
            time: row.get(1),
            kind: SaleKind::parse(&kind).expect("sales.kind check constraint"),
            shop: row.get(3),
            slot: row.get(4),
            variant,
            unit_price: row.get(6),
            upgrade: upgrade(variant),
        });
    }
    Ok(data)
}

fn window_json(w: &WindowFigures) -> Value {
    json!({
        "lowest_ask": w.low, "median_ask": w.median, "highest_ask": w.high,
        "listings_count": w.listings, "shops_count": w.shops, "variant_count": w.variants,
        "sold_out_count": w.sold_out_count, "sold_out_median": w.sold_out_median, "sales_count": w.sales_count,
        "quick_sell": w.recommendation.fast_price, "normal_sell": w.recommendation.price,
        "recommendation": w.recommendation.json,
    })
}

fn stats_json(
    item_id: i32,
    f: &ItemFigures,
    anchor: f64,
    as_of: f64,
    last_seen: Option<f64>,
) -> Value {
    let s = &f.stats;
    let trend: Vec<Value> = s
        .trend_7d
        .iter()
        .enumerate()
        .map(|(i, b)| json!({"start": bucket_start(anchor, i), "count": b.count, "median": b.median, "low": b.low, "high": b.high}))
        .collect();
    let mut row = window_json(&f.recent);
    let map = row.as_object_mut().expect("object");
    for (key, value) in [
        ("item_id", json!(item_id)),
        ("typical", json!(s.typical)),
        ("typical_low", json!(s.typical_low)),
        ("typical_high", json!(s.typical_high)),
        ("sample_size", json!(s.typical_count)),
        ("typical_basis", json!(s.typical_basis.as_str())),
        ("low_data", json!(s.low_data)),
        ("sales_24h", json!(s.sales_24h)),
        ("sales_prev_24h", json!(s.sales_prev_24h)),
        ("change_24h", json!(s.change_24h)),
        ("sales_10d", json!(s.sales_10d)),
        ("last_sale_at", json!(s.last_sale_at)),
        ("last_sale_price", json!(s.last_sale_price)),
        ("last3_avg", json!(s.last3_avg)),
        ("trend", Value::Array(trend)),
        ("as_of", json!(as_of)),
        ("last_seen", json!(last_seen)),
        (
            "list_fields",
            json!(list_fields(item_id, &f.stats, &f.recent)),
        ),
    ] {
        map.insert(key.into(), value);
    }
    row
}

/// Market members of the list entry (`market_views.LIST_FIELDS`) for one
/// quote window, as JSON object members without the braces. Catalogue
/// fields and `last_seen` are added when the list is read.
fn list_fields(item_id: i32, s: &SalesStats, w: &WindowFigures) -> String {
    let trend: Vec<Option<f64>> = s.trend_7d.iter().map(|b| b.median).collect();
    let members = json!({
        "unit_basis": crate::external::unit(item_id),
        "low": w.low, "median": w.median, "listings": w.listings, "shops": w.shops,
        "typical": s.typical, "typical_low": s.typical_low, "typical_high": s.typical_high,
        "typical_basis": s.typical_basis.as_str(), "low_data": s.low_data, "sales_24h": s.sales_24h,
        "change_24h": s.change_24h, "sales_10d": s.sales_10d, "last_sale_at": s.last_sale_at,
        "last_sale_price": s.last_sale_price, "variant_count": w.variants, "trend": trend,
        "fast_price": w.recommendation.fast_price,
    })
    .to_string();
    members[1..members.len() - 1].to_string()
}

// Raw selected-period sales, matching the former list SQL. Pricing filters
// for equipment/outliers must not change these transaction-count metrics.
fn add_period_fields(row: &mut Value, sales: &[SaleEvent], window: Window, now: f64) {
    let mut current = Vec::new();
    let mut previous = Vec::new();
    for sale in sales.iter().filter(|s| s.time <= now) {
        if sale.time >= window.cutoff {
            current.push(sale.unit_price);
        } else if window.hours.is_some() && sale.time >= window.cutoff - 259200.0 {
            previous.push(sale.unit_price);
        }
    }
    current.sort_by(f64::total_cmp);
    previous.sort_by(f64::total_cmp);
    let percentile = |v: &[f64], q: f64| -> Option<f64> {
        if v.is_empty() {
            return None;
        }
        let p = (v.len() - 1) as f64 * q;
        let i = p as usize;
        Some(v[i] + (v[(i + 1).min(v.len() - 1)] - v[i]) * (p - i as f64))
    };
    let median = percentile(&current, 0.5);
    let change = percentile(&previous, 0.5)
        .filter(|v| *v > 0.0)
        .and_then(|p| median.map(|m| (m / p - 1.0) * 100.0));
    // The baseline count lets pages mark a change measured against only a few sales.
    let previous_count = window.hours.map(|_| previous.len());
    let fields = json!({"sales_window":current.len(), "typical_window":median,
        "typical_window_low":percentile(&current,0.25), "typical_window_high":percentile(&current,0.75),
        "change_window":change, "sales_prev_window":previous_count}).to_string();
    row["list_fields"] = json!(format!(
        "{},{}",
        row["list_fields"].as_str().unwrap(),
        &fields[1..fields.len() - 1]
    ));
}

const WINDOW_COLUMNS: &str = "lowest_ask float8, median_ask float8, highest_ask float8, listings_count int, \
    shops_count int, variant_count int, sold_out_count int, sold_out_median float8, sales_count int, \
    quick_sell float8, normal_sell float8, recommendation jsonb, list_fields text";

/// Upsert figures. `exact_last_seen` replaces `last_seen_at`; otherwise the
/// given value only raises it (an upload can only add observations).
async fn write(
    conn: &mut PgConnection,
    figures: &[(i32, ItemFigures)],
    as_of: f64,
    now: f64,
    last_seen: &HashMap<i32, f64>,
    exact_last_seen: bool,
    data: &ItemData,
) -> sqlx::Result<()> {
    let anchor = now;
    let stats: Vec<Value> = figures
        .iter()
        .map(|(id, f)| {
            let mut row = stats_json(*id, f, anchor, as_of, last_seen.get(id).copied());
            add_period_fields(
                &mut row,
                data.get(id).map(|d| d.1.as_slice()).unwrap_or(&[]),
                Window::recent(now),
                now,
            );
            row
        })
        .collect();
    let all: Vec<Value> = figures
        .iter()
        .map(|(id, f)| {
            let mut row = window_json(&f.all);
            row["item_id"] = json!(id);
            row["list_fields"] = json!(list_fields(*id, &f.stats, &f.all));
            add_period_fields(
                &mut row,
                data.get(id).map(|d| d.1.as_slice()).unwrap_or(&[]),
                Window::ALL,
                now,
            );
            row
        })
        .collect();
    let daily: Vec<Value> = figures
        .iter()
        .flat_map(|(id, f)| {
            f.daily.iter().map(move |d| {
                json!({"item_id": id, "day": d.day, "median": d.bucket.median, "low": d.bucket.low,
                       "high": d.bucket.high, "count": d.bucket.count})
            })
        })
        .collect();
    let ids: Vec<i32> = figures.iter().map(|(id, _)| *id).collect();

    sqlx::query(&format!(
        "INSERT INTO item_stats (item_id, typical, typical_low, typical_high, sample_size, sales_24h, change_24h,
             lowest_ask, listings_count, shops_count, quick_sell, normal_sell, last_sale_at, as_of, typical_basis,
             low_data, sales_prev_24h, sales_10d, last_sale_price, last3_avg, trend, last_seen_at, median_ask,
             highest_ask, variant_count, sold_out_count, sold_out_median, sales_count, recommendation, list_fields)
         SELECT item_id, typical, typical_low, typical_high, sample_size, sales_24h, change_24h,
             lowest_ask, listings_count, shops_count, quick_sell, normal_sell, to_timestamp(last_sale_at),
             to_timestamp(as_of), typical_basis, low_data, sales_prev_24h, sales_10d, last_sale_price, last3_avg,
             trend, to_timestamp(last_seen), median_ask, highest_ask, variant_count, sold_out_count,
             sold_out_median, sales_count, recommendation, list_fields
         FROM jsonb_to_recordset($1) AS x(item_id int, typical float8, typical_low float8, typical_high float8,
             sample_size int, sales_24h int, change_24h float8, last_sale_at float8, as_of float8,
             typical_basis text, low_data bool, sales_prev_24h int, sales_10d int, last_sale_price float8,
             last3_avg float8, trend jsonb, last_seen float8, {WINDOW_COLUMNS})
         ON CONFLICT (item_id) DO UPDATE SET
             typical = EXCLUDED.typical, typical_low = EXCLUDED.typical_low, typical_high = EXCLUDED.typical_high,
             sample_size = EXCLUDED.sample_size, sales_24h = EXCLUDED.sales_24h, change_24h = EXCLUDED.change_24h,
             lowest_ask = EXCLUDED.lowest_ask, listings_count = EXCLUDED.listings_count,
             shops_count = EXCLUDED.shops_count, quick_sell = EXCLUDED.quick_sell,
             normal_sell = EXCLUDED.normal_sell, last_sale_at = EXCLUDED.last_sale_at, as_of = EXCLUDED.as_of,
             typical_basis = EXCLUDED.typical_basis, low_data = EXCLUDED.low_data,
             sales_prev_24h = EXCLUDED.sales_prev_24h, sales_10d = EXCLUDED.sales_10d,
             last_sale_price = EXCLUDED.last_sale_price, last3_avg = EXCLUDED.last3_avg, trend = EXCLUDED.trend,
             last_seen_at = CASE WHEN $2 THEN EXCLUDED.last_seen_at
                                 ELSE GREATEST(item_stats.last_seen_at, EXCLUDED.last_seen_at) END,
             median_ask = EXCLUDED.median_ask, highest_ask = EXCLUDED.highest_ask,
             variant_count = EXCLUDED.variant_count, sold_out_count = EXCLUDED.sold_out_count,
             sold_out_median = EXCLUDED.sold_out_median, sales_count = EXCLUDED.sales_count,
             recommendation = EXCLUDED.recommendation, list_fields = EXCLUDED.list_fields"
    ))
    .bind(Value::Array(stats))
    .bind(exact_last_seen)
    .execute(&mut *conn)
    .await?;

    sqlx::query(&format!(
        "INSERT INTO item_stats_all (item_id, lowest_ask, median_ask, highest_ask, listings_count, shops_count,
             variant_count, sold_out_count, sold_out_median, sales_count, quick_sell, normal_sell, recommendation,
             list_fields)
         SELECT item_id, lowest_ask, median_ask, highest_ask, listings_count, shops_count, variant_count,
             sold_out_count, sold_out_median, sales_count, quick_sell, normal_sell, recommendation, list_fields
         FROM jsonb_to_recordset($1) AS x(item_id int, {WINDOW_COLUMNS})
         ON CONFLICT (item_id) DO UPDATE SET
             lowest_ask = EXCLUDED.lowest_ask, median_ask = EXCLUDED.median_ask, highest_ask = EXCLUDED.highest_ask,
             listings_count = EXCLUDED.listings_count, shops_count = EXCLUDED.shops_count,
             variant_count = EXCLUDED.variant_count, sold_out_count = EXCLUDED.sold_out_count,
             sold_out_median = EXCLUDED.sold_out_median, sales_count = EXCLUDED.sales_count,
             quick_sell = EXCLUDED.quick_sell, normal_sell = EXCLUDED.normal_sell,
             recommendation = EXCLUDED.recommendation, list_fields = EXCLUDED.list_fields"
    ))
    .bind(Value::Array(all))
    .execute(&mut *conn)
    .await?;

    // Re-observing unchanged stock must not delete/reinsert every historical
    // day. That churn generates WAL and vacuum work even for identical data.
    sqlx::query(
        "WITH incoming AS MATERIALIZED (
         SELECT item_id, date '1970-01-01' + day AS day, median, low, high, count
         FROM jsonb_to_recordset($1) AS x(item_id int, day int, median float8, low float8, high float8, count int)
         ), removed AS (
           DELETE FROM item_daily d WHERE d.item_id=ANY($2) AND NOT EXISTS (
             SELECT 1 FROM incoming n WHERE n.item_id=d.item_id AND n.day=d.day
           )
         ) INSERT INTO item_daily (item_id,day,median,low,high,count)
         SELECT item_id,day,median,low,high,count FROM incoming
         ON CONFLICT (item_id,day) DO UPDATE SET
           median=EXCLUDED.median,low=EXCLUDED.low,high=EXCLUDED.high,count=EXCLUDED.count
         WHERE (item_daily.median,item_daily.low,item_daily.high,item_daily.count)
           IS DISTINCT FROM (EXCLUDED.median,EXCLUDED.low,EXCLUDED.high,EXCLUDED.count)",
    )
    .bind(Value::Array(daily))
    .bind(&ids)
    .execute(&mut *conn)
    .await?;
    Ok(())
}

fn compute(items: &[i32], data: &ItemData, _as_of: f64, now: f64) -> Vec<(i32, ItemFigures)> {
    let anchor = anchor(None, now);
    items
        .iter()
        .map(|&id| {
            let (listings, sales) = data
                .get(&id)
                .map(|(l, s)| (l.as_slice(), s.as_slice()))
                .unwrap_or((&[], &[]));
            (
                id,
                item_figures(i64::from(id), &listings, &sales, anchor, now),
            )
        })
        .collect()
}

/// Recompute `items` inside the caller's write transaction. `seen_at` raises
/// `last_seen_at` for the items the upload showed.
pub async fn recompute_items(
    conn: &mut PgConnection,
    items: &[i32],
    as_of: f64,
    now: f64,
    seen_at: &HashMap<i32, f64>,
) -> sqlx::Result<()> {
    if items.is_empty() {
        return Ok(());
    }
    let data = load(conn, Some(items)).await?;
    let figures = compute(items, &data, as_of, now);
    write(conn, &figures, as_of, now, seen_at, false, &data).await
}

/// Recompute every observed item. Returns the number of items written.
pub async fn refresh_all(conn: &mut PgConnection, now: f64) -> sqlx::Result<usize> {
    let as_of: Option<f64> =
        sqlx::query_scalar("SELECT extract(epoch FROM max(t))::float8 FROM (
             SELECT max(observed_at) t FROM observations UNION ALL SELECT max(detected_at) FROM sales
             UNION ALL SELECT max(seen_at) FROM external_market_listings) activity")
            .fetch_one(&mut *conn)
            .await?;
    let Some(as_of) = as_of else {
        return Ok(0);
    };
    let last_seen: HashMap<i32, f64> = sqlx::query_as(
        "SELECT item_id,extract(epoch FROM max(t))::float8 FROM (
          SELECT r.item_id,o.observed_at t FROM observation_rows r JOIN observations o ON o.id=r.observation_id
          UNION ALL SELECT item_id,detected_at FROM sales WHERE source='mesowatch'
          UNION ALL SELECT item_id,seen_at FROM external_market_listings) activity GROUP BY item_id",
    )
    .fetch_all(&mut *conn)
    .await?
    .into_iter()
    .collect();
    let mut items: Vec<i32> = last_seen.keys().copied().collect();
    items.sort_unstable();
    let data = load(conn, None).await?;
    let figures = compute(&items, &data, as_of, now);
    write(conn, &figures, as_of, now, &last_seen, true, &data).await?;
    sqlx::query(
        "UPDATE market_state SET version = version + 1, as_of = to_timestamp($1), refreshed_at = to_timestamp($2),
             refreshed_cutoff = to_timestamp($3), refreshed_as_of = to_timestamp($1),
             visits = (SELECT count(*) FROM observations), observation_rows = (SELECT count(*) FROM observation_rows),
             shops = (SELECT count(*) FROM shops)",
    )
    .bind(as_of)
    .bind(now)
    .bind(Window::recent(now).cutoff)
    .execute(&mut *conn)
    .await?;
    sqlx::query("SELECT pg_notify('market_changed', '')")
        .execute(&mut *conn)
        .await?;
    Ok(items.len())
}

/// Batched refresh when the anchor minute moved or data left the 72-hour
/// window since the last one. Returns whether it ran.
pub async fn refresh_if_due(db: &PgPool, now: f64) -> sqlx::Result<bool> {
    // Serialize refresh workers across candidate/active processes without
    // holding the upload lock for the duration of the entire refresh.
    let mut coordinator = db.begin().await?;
    let acquired: bool = sqlx::query_scalar("SELECT pg_try_advisory_xact_lock($1)")
        .bind(WRITE_LOCK + 1).fetch_one(&mut *coordinator).await?;
    if !acquired { return Ok(false); }
    let mut tx = db.begin().await?;
    lock_writes(&mut tx).await?;
    let (as_of, refreshed_at, old_cutoff, refreshed_as_of): (Option<f64>, Option<f64>, Option<f64>, Option<f64>) =
        sqlx::query_as(
            "SELECT extract(epoch FROM as_of)::float8, extract(epoch FROM refreshed_at)::float8,
                    extract(epoch FROM refreshed_cutoff)::float8, extract(epoch FROM refreshed_as_of)::float8
             FROM market_state",
        )
        .fetch_one(&mut *tx)
        .await?;
    if as_of.is_none() {
        return Ok(false);
    }
    let cutoff = Window::recent(now).cutoff;
    let due = match (refreshed_at, old_cutoff) {
        (Some(last_refresh), Some(old_cutoff)) => {
            now - last_refresh >= 60.0
                || anchor(as_of, now) != anchor(refreshed_as_of, now)
                || {
                    let crossed: bool = sqlx::query_scalar(
                    "SELECT EXISTS (SELECT 1 FROM shops WHERE last_seen_at >= to_timestamp($1) AND last_seen_at < to_timestamp($2))
                         OR EXISTS (SELECT 1 FROM sales WHERE detected_at >= to_timestamp($1) AND detected_at < to_timestamp($2))",
                )
                .bind(old_cutoff)
                .bind(cutoff)
                .fetch_one(&mut *tx)
                .await?;
                    crossed
                }
        }
        _ => true,
    };
    if due {
        // Discover IDs without rescanning observation history. Uploads already
        // maintain last_seen_at and market_state's exact counters atomically.
        let items: Vec<i32> = sqlx::query_scalar("SELECT item_id FROM item_stats ORDER BY item_id")
            .fetch_all(&mut *tx).await?;
        tx.commit().await?;
        let started = std::time::Instant::now();
        for batch in items.chunks(16) {
            let mut batch_tx = db.begin().await?;
            lock_writes(&mut batch_tx).await?;
            let as_of: f64 = sqlx::query_scalar(
                "SELECT extract(epoch FROM as_of)::float8 FROM market_state")
                .fetch_one(&mut *batch_tx).await?;
            recompute_items(&mut batch_tx, batch, as_of, now + started.elapsed().as_secs_f64(), &HashMap::new()).await?;
            sqlx::query("UPDATE market_state SET version=version+1")
                .execute(&mut *batch_tx).await?;
            batch_tx.commit().await?;
            // Let an upload waiting for the writer lock proceed between batches.
            tokio::task::yield_now().await;
        }
        tx = db.begin().await?;
        lock_writes(&mut tx).await?;
        sqlx::query("UPDATE market_state SET refreshed_at=to_timestamp($1),
            refreshed_cutoff=to_timestamp($2),refreshed_as_of=as_of")
            .bind(now).bind(cutoff).execute(&mut *tx).await?;
        sqlx::query("SELECT pg_notify('market_changed','')").execute(&mut *tx).await?;
    } else {
        // Nothing left the window; only move the window start.
        sqlx::query("UPDATE market_state SET refreshed_cutoff = to_timestamp($1)")
            .bind(cutoff)
            .execute(&mut *tx)
            .await?;
    }
    tx.commit().await?;
    // Refresh a bounded number of aged contribution summaries. Reads fall back
    // to exact state counts until their summary has been renewed.
    let expired: Vec<(i64, i64)> = sqlx::query_as(
        "SELECT collector_id,shop_id FROM contribution_shop_rollups
         WHERE valid_until<=now() ORDER BY valid_until LIMIT 256")
        .fetch_all(&mut *coordinator).await?;
    for batch in expired.chunks(16) {
        let mut tx = db.begin().await?;
        lock_writes(&mut tx).await?;
        for &(collector, shop) in batch {
            sqlx::query("SELECT refresh_contribution_rollup($1,$2)")
                .bind(collector).bind(shop).execute(&mut *tx).await?;
        }
        tx.commit().await?;
    }
    coordinator.commit().await?;
    Ok(due)
}

#[cfg(test)]
mod period_tests {
    use super::*;

    #[test]
    fn period_metrics_preserve_boundaries_quartiles_and_all_history() {
        let now = 1_000_000.0;
        let cutoff = Window::recent(now).cutoff;
        let sales: Vec<SaleEvent> = [
            (cutoff - 259201.0, 1.0),
            (cutoff - 259200.0, 5.0),
            (cutoff - 1.0, 15.0),
            (cutoff, 10.0),
            (now - 2.0, 20.0),
            (now - 1.0, 30.0),
            (now, 40.0),
            (now + 1.0, 999.0),
        ]
        .into_iter()
        .map(|(time, unit_price)| SaleEvent {
            time,
            unit_price,
            kind: SaleKind::parse("found_sold").unwrap(),
            shop: 1,
            slot: 1,
            variant: None,
            upgrade: None,
        })
        .collect();
        let read = |window, time| {
            let mut row = json!({"list_fields":"\"existing\":true"});
            add_period_fields(&mut row, &sales, window, time);
            serde_json::from_str::<Value>(&format!("{{{}}}", row["list_fields"].as_str().unwrap()))
                .unwrap()
        };
        let recent = read(Window::recent(now), now);
        assert_eq!(recent["sales_window"], 4);
        assert_eq!(recent["typical_window"], 25.0);
        assert_eq!(recent["typical_window_low"], 17.5);
        assert_eq!(recent["typical_window_high"], 32.5);
        assert_eq!(recent["change_window"], 150.0);
        assert_eq!(
            recent["sales_prev_window"], 2,
            "the change compares with two earlier sales"
        );
        let all = read(Window::ALL, now);
        assert_eq!(all["sales_window"], 7);
        assert_eq!(all["typical_window"], 15.0);
        assert_eq!(all["change_window"], Value::Null);
        assert_eq!(all["sales_prev_window"], Value::Null);
        let later = now + 7.0 * 86400.0;
        let empty = read(Window::recent(later), later);
        assert_eq!(empty["sales_window"], 0);
        assert_eq!(empty["typical_window"], Value::Null);
    }
}

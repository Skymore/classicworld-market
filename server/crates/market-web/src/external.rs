//! Authorized external evidence, imported without fabricating collector visits.
use std::collections::{HashMap, HashSet};

use anyhow::{ensure, Context, Result};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use sqlx::{PgConnection, PgPool, Row};

use crate::stats;

#[derive(Debug, Deserialize)]
pub struct Points {
    pub version: u32,
    pub source: String,
    pub world: String,
    pub generated_at: f64,
    pub manifest: Value,
    pub items: Vec<Item>,
    pub sales: Vec<Sale>,
    #[serde(default)]
    pub listings: Vec<Listing>,
}

#[derive(Debug, Deserialize, Clone)]
pub struct Item {
    pub source_item_id: String,
    pub item_id: i32,
    pub name_en: String,
    pub unit_basis: String,
    pub listings_generated_at: Option<f64>,
}

#[derive(Debug, Deserialize, Serialize, Clone)]
pub struct Sale {
    pub source_key: String,
    pub source_item_id: String,
    pub time: f64,
    pub kind: String,
    pub unit_price: f64,
    pub seller: Option<String>,
    pub location: Value,
    pub raw: Value,
}

#[derive(Debug, Deserialize, Serialize, Clone)]
pub struct Listing {
    pub source_key: String,
    pub source_item_id: String,
    pub time: f64,
    pub generated_at: f64,
    pub unit_price: f64,
    pub seller: Option<String>,
    pub location: Value,
    pub up: bool,
    pub raw: Value,
}

#[derive(Debug, Serialize, Default)]
pub struct Outcome {
    pub sales_added: usize,
    pub duplicate_sales: usize,
    pub listing_points: usize,
    pub skipped_items: Vec<String>,
    pub skipped_points: usize,
    pub duplicate_import: bool,
    pub changed_sales: usize,
    pub listings_removed: u64,
    pub items_refreshed: usize,
}

fn name(value: &str) -> String {
    value
        .chars()
        .filter(char::is_ascii_alphanumeric)
        .flat_map(char::to_lowercase)
        .collect()
}

pub fn unit(item: i32) -> &'static str {
    if item / 10000 == 207 {
        "set"
    } else {
        "item"
    }
}

pub fn price(item: i32, price: i64, bundle: i32) -> f64 {
    if unit(item) == "set" {
        price as f64
    } else {
        price as f64 / f64::from(bundle)
    }
}

fn valid_time(value: f64, now: f64) -> bool {
    value.is_finite() && value > 0.0 && value <= now + 120.0
}

fn digest(value: &Value) -> String {
    hex::encode(Sha256::digest(serde_json::to_vec(value).expect("JSON")))
}

async fn shop(
    conn: &mut PgConnection,
    seller: &Option<String>,
    location: &Value,
    unknown: &str,
    cache: &mut HashMap<String, i64>,
) -> Result<i64> {
    let key = digest(&json!([
        seller,
        location,
        if seller.is_some() { "" } else { unknown }
    ]));
    if let Some(id) = cache.get(&key) {
        return Ok(*id);
    }
    let id = sqlx::query_scalar(
        "INSERT INTO external_market_shops(source,source_key) VALUES ('mesowatch',$1)
         ON CONFLICT(source,source_key) DO UPDATE SET source_key=EXCLUDED.source_key RETURNING id",
    )
    .bind(&key)
    .fetch_one(conn)
    .await?;
    cache.insert(key, id);
    Ok(id)
}

/// Commit one item at a time, releasing the upload lock between items. A retry
/// resumes through durable per-item receipts; changed events are quarantined.
pub async fn import(db: &PgPool, points: &Points, fingerprint: &str, now: f64) -> Result<Outcome> {
    let mut coordinator = db.begin().await?;
    sqlx::query("SELECT pg_advisory_xact_lock($1)")
        .bind(stats::WRITE_LOCK + 2)
        .execute(&mut *coordinator)
        .await?;
    let mut ids = HashSet::new();
    let mut sources = HashSet::new();
    for item in &points.items {
        ensure!(
            ids.insert(item.item_id) && sources.insert(item.source_item_id.as_str()),
            "Duplicate item mapping"
        );
        ensure!(
            (item.source_item_id == format!("basil:{:08}", item.item_id)
                || item.source_item_id == format!("cash:{:08}", item.item_id)),
            "Source item id mismatch"
        );
    }
    let mut sales: HashMap<&str, Vec<Sale>> = HashMap::new();
    let mut listings: HashMap<&str, Vec<Listing>> = HashMap::new();
    let mut total = Outcome {
        duplicate_import: true,
        ..Outcome::default()
    };
    for sale in &points.sales {
        if sources.contains(sale.source_item_id.as_str()) {
            sales
                .entry(&sale.source_item_id)
                .or_default()
                .push(sale.clone());
        } else {
            total.skipped_points += 1;
        }
    }
    for listing in &points.listings {
        if sources.contains(listing.source_item_id.as_str()) {
            listings
                .entry(&listing.source_item_id)
                .or_default()
                .push(listing.clone());
        } else {
            total.skipped_points += 1;
        }
    }
    // Validate the envelope even when there are no mapped items.
    ensure!(
        points.version == 1 && points.source == "mesowatch" && points.world == "ClassicWorld",
        "Unsupported evidence format"
    );
    ensure!(valid_time(points.generated_at, now), "Invalid export time");
    for item in &points.items {
        let part = Points {
            version: points.version,
            source: points.source.clone(),
            world: points.world.clone(),
            generated_at: points.generated_at,
            manifest: json!({"parent_fingerprint": fingerprint, "source_item_id": item.source_item_id,
                "raw_points_only": points.manifest.get("raw_points_only"),
                "files": points.manifest.get("files").and_then(Value::as_array).map(|files| files.iter()
                    .filter(|file| file.get("path").and_then(Value::as_str)
                        .is_some_and(|path| path == format!("items/{}.json", item.source_item_id.replace(':', "_"))))
                    .cloned().collect::<Vec<_>>())}),
            items: vec![item.clone()],
            sales: sales
                .remove(item.source_item_id.as_str())
                .unwrap_or_default(),
            listings: listings
                .remove(item.source_item_id.as_str())
                .unwrap_or_default(),
        };
        let receipt = format!("{fingerprint}:{}", item.source_item_id);
        let result = import_item(db, &part, &receipt, now).await?;
        total.sales_added += result.sales_added;
        total.duplicate_sales += result.duplicate_sales;
        total.listing_points += result.listing_points;
        total.skipped_points += result.skipped_points;
        total.changed_sales += result.changed_sales;
        total.listings_removed += result.listings_removed;
        total.items_refreshed += result.items_refreshed;
        total.skipped_items.extend(result.skipped_items);
        total.duplicate_import &= result.duplicate_import;
        tokio::task::yield_now().await;
    }
    coordinator.commit().await?;
    Ok(total)
}

async fn import_item(db: &PgPool, points: &Points, fingerprint: &str, now: f64) -> Result<Outcome> {
    ensure!(
        points.version == 1 && points.source == "mesowatch" && points.world == "ClassicWorld",
        "Unsupported evidence format"
    );
    ensure!(valid_time(points.generated_at, now), "Invalid export time");
    let mut tx = db.begin().await?;
    let duplicate: bool = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM external_market_imports WHERE source='mesowatch' AND fingerprint=$1)")
        .bind(fingerprint).fetch_one(&mut *tx).await?;
    if duplicate {
        return Ok(Outcome {
            duplicate_import: true,
            ..Outcome::default()
        });
    }
    let item_ids: Vec<i32> = points.items.iter().map(|i| i.item_id).collect();
    let catalogue: HashMap<i32, String> =
        sqlx::query_as("SELECT id,name_en FROM items WHERE id=ANY($1)")
            .bind(&item_ids)
            .fetch_all(&mut *tx)
            .await?
            .into_iter()
            .collect();
    let mut outcome = Outcome::default();
    let mut mapped = HashMap::new();
    let mut destination_ids = HashSet::new();
    for item in &points.items {
        ensure!(
            (1_000_000..=5_999_999).contains(&item.item_id),
            "Invalid item id"
        );
        if item.item_id / 1_000_000 == 1 {
            outcome.skipped_items.push(item.source_item_id.clone());
            continue;
        }
        ensure!(
            item.unit_basis == unit(item.item_id),
            "Incompatible unit for {}",
            item.source_item_id
        );
        if !catalogue
            .get(&item.item_id)
            .is_some_and(|n| name(n) == name(&item.name_en))
        {
            outcome.skipped_items.push(item.source_item_id.clone());
            continue;
        }
        ensure!(
            destination_ids.insert(item.item_id),
            "Ambiguous item id {}",
            item.item_id
        );
        ensure!(
            mapped.insert(item.source_item_id.clone(), item).is_none(),
            "Duplicate source item id"
        );
    }
    // A rejected catalogue mapping is not a successful import receipt: a
    // catalogue correction must be able to retry the exact same evidence.
    if mapped.is_empty() {
        return Ok(outcome);
    }
    let keys: Vec<&str> = points.sales.iter().map(|s| s.source_key.as_str()).collect();
    let existing: HashMap<String, Value> =
        sqlx::query_as("SELECT source_key,source_payload FROM sales WHERE source='mesowatch' AND source_key=ANY($1)")
            .bind(&keys)
            .fetch_all(&mut *tx)
            .await?
            .into_iter()
            .collect();
    let mut seen = HashMap::new();
    let mut shops = HashMap::new();
    let mut inserts = Vec::new();
    let source_ids: Vec<&str> = points
        .items
        .iter()
        .map(|i| i.source_item_id.as_str())
        .collect();
    let mut listing_versions: HashMap<String,f64> = sqlx::query_as(
        "SELECT source_item_id,extract(epoch FROM generated_at)::float8 FROM external_market_item_state WHERE source='mesowatch' AND source_item_id=ANY($1)")
        .bind(&source_ids).fetch_all(&mut *tx).await?.into_iter().collect();
    let mut accepted_listings = HashSet::new();
    let mut touched = HashSet::new();
    let mut last_seen: HashMap<i32, f64> = HashMap::new();
    for item in mapped.values() {
        if let Some(generated) = item.listings_generated_at {
            ensure!(valid_time(generated, now), "Invalid listing export time");
            if listing_versions
                .get(&item.source_item_id)
                .is_some_and(|old| *old >= generated)
            {
                continue;
            }
            listing_versions.insert(item.source_item_id.clone(), generated);
            accepted_listings.insert(item.source_item_id.as_str());
            touched.insert(item.item_id);
            sqlx::query("INSERT INTO external_market_item_state(source,source_item_id,generated_at) VALUES ('mesowatch',$1,to_timestamp($2))
                ON CONFLICT(source,source_item_id) DO UPDATE SET generated_at=EXCLUDED.generated_at")
                .bind(&item.source_item_id).bind(generated).execute(&mut *tx).await?;
            outcome.listings_removed += sqlx::query("DELETE FROM external_market_listings WHERE source='mesowatch' AND source_item_id=$1 AND source_generated_at<to_timestamp($2)")
                .bind(&item.source_item_id).bind(generated).execute(&mut *tx).await?.rows_affected();
        }
    }
    for sale in &points.sales {
        let Some(item) = mapped.get(&sale.source_item_id) else {
            outcome.skipped_points += 1;
            continue;
        };
        ensure!(
            valid_time(sale.time, now) && sale.unit_price.is_finite() && sale.unit_price > 0.0,
            "Invalid sale point {}",
            sale.source_key
        );
        ensure!(
            market_core::sales::SaleKind::parse(&sale.kind).is_some(),
            "Unknown sale evidence"
        );
        ensure!(
            sale.source_key
                .starts_with(&format!("{}:", sale.source_item_id))
                && sale.source_key.len() <= 256,
            "Invalid source key"
        );
        let payload = serde_json::to_value(sale)?;
        if let Some(old) = existing
            .get(&sale.source_key)
            .or_else(|| seen.get(&sale.source_key))
        {
            if old != &payload {
                sqlx::query("INSERT INTO external_market_sale_conflicts(source,source_key,payload_hash,original_payload,incoming_payload) VALUES ('mesowatch',$1,$2,$3,$4) ON CONFLICT(source,source_key,payload_hash) DO NOTHING")
                    .bind(&sale.source_key).bind(digest(&payload)).bind(old).bind(&payload)
                    .execute(&mut *tx).await?;
                outcome.changed_sales += 1;
                continue;
            }
            outcome.duplicate_sales += 1;
            continue;
        }
        let group = shop(
            &mut tx,
            &sale.seller,
            &sale.location,
            &sale.source_key,
            &mut shops,
        )
        .await?;
        inserts.push(json!({"item_id":item.item_id,"kind":sale.kind,"time":sale.time,"source_key":sale.source_key,
          "price":sale.unit_price,"unit":item.unit_basis,"seller":sale.seller,"location":sale.location,
          "payload":payload,"group":group}));
        seen.insert(sale.source_key.clone(), payload);
        outcome.sales_added += 1;
        touched.insert(item.item_id);
        last_seen
            .entry(item.item_id)
            .and_modify(|v| *v = v.max(sale.time))
            .or_insert(sale.time);
    }
    for batch in inserts.chunks(1000) {
        sqlx::query("INSERT INTO sales(item_id,kind,detected_at,source,source_key,source_price,source_unit,source_seller,source_location,source_payload,external_shop_id)
          SELECT item_id,kind,to_timestamp(time),'mesowatch',source_key,price,unit,seller,location,payload,\"group\"
          FROM jsonb_to_recordset($1) AS x(item_id int,kind text,time float8,source_key text,price float8,unit text,
            seller text,location jsonb,payload jsonb,\"group\" bigint)")
            .bind(json!(batch)).execute(&mut *tx).await.context("inserting external sale batch")?;
    }
    for listing in &points.listings {
        let Some(item) = mapped.get(&listing.source_item_id) else {
            outcome.skipped_points += 1;
            continue;
        };
        ensure!(
            item.listings_generated_at == Some(listing.generated_at),
            "Listing version differs from item export"
        );
        if !accepted_listings.contains(listing.source_item_id.as_str()) {
            continue;
        }
        ensure!(
            valid_time(listing.time, now)
                && valid_time(listing.generated_at, now)
                && listing.unit_price.is_finite()
                && listing.unit_price > 0.0,
            "Invalid listing point"
        );
        let group = shop(
            &mut tx,
            &listing.seller,
            &listing.location,
            &listing.source_key,
            &mut shops,
        )
        .await?;
        sqlx::query("INSERT INTO external_market_listings(source,source_key,source_item_id,item_id,external_shop_id,unit_price,unit_basis,seller,location,seen_at,source_generated_at,up,raw)
          VALUES ('mesowatch',$1,$2,$3,$4,$5,$6,$7,$8,to_timestamp($9),to_timestamp($10),$11,$12)
          ON CONFLICT(source,source_key) DO UPDATE SET unit_price=EXCLUDED.unit_price,location=EXCLUDED.location,
            seen_at=EXCLUDED.seen_at,source_generated_at=EXCLUDED.source_generated_at,up=EXCLUDED.up,raw=EXCLUDED.raw
          WHERE external_market_listings.source_generated_at<=EXCLUDED.source_generated_at")
            .bind(&listing.source_key).bind(&listing.source_item_id).bind(item.item_id).bind(group).bind(listing.unit_price)
            .bind(&item.unit_basis).bind(&listing.seller).bind(&listing.location).bind(listing.time)
            .bind(listing.generated_at).bind(listing.up).bind(&listing.raw).execute(&mut *tx).await?;
        outcome.listing_points += 1;
        last_seen
            .entry(item.item_id)
            .and_modify(|v| *v = v.max(listing.time))
            .or_insert(listing.time);
    }
    sqlx::query("INSERT INTO external_market_imports(source,fingerprint,source_generated_at,manifest) VALUES ('mesowatch',$1,to_timestamp($2),$3)")
        .bind(fingerprint).bind(points.generated_at).bind(&points.manifest).execute(&mut *tx).await?;
    if !touched.is_empty() {
        // Stage source-owned rows without the collector's lock. Only the final
        // statistics read/write needs serialization; after acquiring it the
        // READ COMMITTED queries see any collector uploads committed meanwhile.
        stats::lock_writes(&mut tx).await?;
        let latest = last_seen.values().copied().reduce(f64::max);
        let as_of: f64 = sqlx::query_scalar("UPDATE market_state SET version=version+1, as_of=GREATEST(as_of,to_timestamp($1)) RETURNING COALESCE(extract(epoch FROM as_of)::float8,$2)")
            .bind(latest).bind(now).fetch_one(&mut *tx).await?;
        let mut items: Vec<i32> = touched.into_iter().collect();
        items.sort_unstable();
        stats::recompute_items(&mut tx, &items, as_of, now, &last_seen).await?;
        crate::realtime::notify_market(&mut tx, Some(&items)).await?;
        outcome.items_refreshed = items.len();
    }
    tx.commit().await?;
    Ok(outcome)
}

/// Bounded housekeeping for old imports, including items not changed this run.
/// The watermark survives deletion, so replaying an old export stays harmless.
pub async fn prune_superseded(db: &PgPool) -> Result<u64> {
    let result = sqlx::query(
        "WITH stale AS (
        SELECT q.source,q.source_key FROM external_market_listings q
        JOIN external_market_item_state s USING(source,source_item_id)
        WHERE q.source='mesowatch' AND NOT q.up AND q.source_generated_at<s.generated_at
        LIMIT 1000 FOR UPDATE OF q SKIP LOCKED
      ) DELETE FROM external_market_listings q USING stale s
        WHERE q.source=s.source AND q.source_key=s.source_key",
    )
    .execute(db)
    .await?;
    Ok(result.rows_affected())
}

/// Move previously imported equipment to an excluded-evidence ledger. It has
/// no reliable per-piece attributes and must not affect native equipment prices.
pub async fn exclude_equipment(db: &PgPool, now: f64) -> Result<usize> {
    let mut coordinator = db.begin().await?;
    sqlx::query("SELECT pg_advisory_xact_lock($1)")
        .bind(stats::WRITE_LOCK + 2)
        .execute(&mut *coordinator)
        .await?;
    let items: Vec<i32> = sqlx::query_scalar("SELECT item_id FROM sales WHERE source='mesowatch' AND item_id>=1000000 AND item_id<2000000
        UNION SELECT item_id FROM external_market_listings WHERE source='mesowatch' AND item_id>=1000000 AND item_id<2000000 ORDER BY item_id")
        .fetch_all(&mut *coordinator).await?;
    for &item in &items {
        let mut tx = db.begin().await?;
        sqlx::query("INSERT INTO external_market_excluded_evidence(source,kind,source_key,item_id,payload)
            SELECT source,'sale',source_key,item_id,to_jsonb(s) FROM sales s WHERE source='mesowatch' AND item_id=$1
            ON CONFLICT(source,kind,source_key) DO NOTHING")
            .bind(item).execute(&mut *tx).await?;
        sqlx::query("INSERT INTO external_market_excluded_evidence(source,kind,source_key,item_id,payload)
            SELECT source,'listing',source_key,item_id,to_jsonb(q) FROM external_market_listings q WHERE source='mesowatch' AND item_id=$1
            ON CONFLICT(source,kind,source_key) DO NOTHING")
            .bind(item).execute(&mut *tx).await?;
        sqlx::query("DELETE FROM sales WHERE source='mesowatch' AND item_id=$1")
            .bind(item)
            .execute(&mut *tx)
            .await?;
        sqlx::query("DELETE FROM external_market_listings WHERE source='mesowatch' AND item_id=$1")
            .bind(item)
            .execute(&mut *tx)
            .await?;
        stats::lock_writes(&mut tx).await?;
        let as_of: f64 = sqlx::query_scalar("UPDATE market_state SET version=version+1 RETURNING COALESCE(extract(epoch FROM as_of)::float8,$1)")
            .bind(now).fetch_one(&mut *tx).await?;
        stats::recompute_items(&mut tx, &[item], as_of, now, &HashMap::new()).await?;
        crate::realtime::notify_market(&mut tx, Some(&[item])).await?;
        tx.commit().await?;
        tokio::task::yield_now().await;
    }
    coordinator.commit().await?;
    Ok(items.len())
}

pub async fn quote_rows(
    db: &PgPool,
    items: &[i32],
    cutoff: f64,
) -> sqlx::Result<Vec<serde_json::Map<String, Value>>> {
    let rows=sqlx::query("SELECT q.*,extract(epoch FROM q.seen_at)::float8 AS time,i.name_zh,i.name_en,i.icon_url,i.subcategory
        FROM external_market_listings q JOIN items i ON i.id=q.item_id
        WHERE q.item_id=ANY($1) AND q.up AND q.seen_at>=to_timestamp($2)")
        .bind(items).bind(cutoff).fetch_all(db).await?;
    Ok(quote_values(rows))
}

pub async fn latest_quote_rows(
    db: &PgPool,
    cutoff: f64,
) -> sqlx::Result<Vec<serde_json::Map<String, Value>>> {
    let rows = sqlx::query(
        "SELECT DISTINCT ON (q.item_id) q.*,extract(epoch FROM q.seen_at)::float8 AS time,
        i.name_zh,i.name_en,i.icon_url,i.subcategory,i.is_cash FROM external_market_listings q
        JOIN items i ON i.id=q.item_id WHERE q.up AND q.seen_at>=to_timestamp($1)
        ORDER BY q.item_id,q.seen_at DESC,q.source,q.source_key",
    )
    .bind(cutoff)
    .fetch_all(db)
    .await?;
    Ok(quote_values(rows))
}

fn quote_values(rows: Vec<sqlx::postgres::PgRow>) -> Vec<serde_json::Map<String, Value>> {
    rows.into_iter().map(|r| {
        let item:i32=r.get("item_id");
        json!({"world":"ClassicWorld","item_id":item,"name_zh":r.get::<Option<String>,_>("name_zh"),
          "name_en":r.get::<String,_>("name_en"),"icon_url":r.get::<Option<String>,_>("icon_url"),
          "subcategory":r.get::<Option<String>,_>("subcategory"),"category":market_core::item::listing_category(i64::from(item),r.try_get::<bool,_>("is_cash").unwrap_or(false)),
          "source":"mesowatch","source_key":r.get::<String,_>("source_key"),"unit_basis":r.get::<String,_>("unit_basis"),
          "unit_price":r.get::<f64,_>("unit_price"),"price":null,"bundle":null,"stock":null,
          "shop":r.get::<Option<String>,_>("seller"),"shop_id":null,"slot":null,"visit_id":null,
          "shop_key":format!("mesowatch:{}",r.get::<i64,_>("external_shop_id")),
          "time":r.get::<f64,_>("time"),"location":r.get::<Value,_>("location"),
          "variant":if item/1_000_000==1 {"unknown"} else {"standard"},"equipment":null,
          "experimental":false,"requires_validation":true,"raw_available":false})
          .as_object().unwrap().clone()
    }).collect()
}

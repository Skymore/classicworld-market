//! Authorized external evidence, imported without fabricating collector visits.
use std::collections::{HashMap, HashSet};

use anyhow::{bail, ensure, Context, Result};
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

#[derive(Debug, Deserialize)]
pub struct Item {
    pub source_item_id: String,
    pub item_id: i32,
    pub name_en: String,
    pub unit_basis: String,
    pub listings_generated_at: Option<f64>,
}

#[derive(Debug, Deserialize, Serialize)]
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

#[derive(Debug, Deserialize, Serialize)]
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

/// Atomic and repeatable. Same source event id with different facts is a conflict.
/// Names are checked against the destination catalogue as well as by the exporter.
pub async fn import(db: &PgPool, points: &Points, fingerprint: &str, now: f64) -> Result<Outcome> {
    ensure!(
        points.version == 1 && points.source == "mesowatch" && points.world == "ClassicWorld",
        "Unsupported evidence format"
    );
    ensure!(valid_time(points.generated_at, now), "Invalid export time");
    let mut tx = db.begin().await?;
    stats::lock_writes(&mut tx).await?;
    let duplicate: bool = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM external_market_imports WHERE source='mesowatch' AND fingerprint=$1)")
        .bind(fingerprint).fetch_one(&mut *tx).await?;
    if duplicate {
        return Ok(Outcome {
            duplicate_import: true,
            ..Outcome::default()
        });
    }
    let catalogue: HashMap<i32, String> = sqlx::query_as("SELECT id,name_en FROM items")
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
    let existing: HashMap<String, Value> =
        sqlx::query_as("SELECT source_key,source_payload FROM sales WHERE source='mesowatch'")
            .fetch_all(&mut *tx)
            .await?
            .into_iter()
            .collect();
    let mut seen = HashMap::new();
    let mut shops: HashMap<String, i64> =
        sqlx::query_as("SELECT source_key,id FROM external_market_shops WHERE source='mesowatch'")
            .fetch_all(&mut *tx)
            .await?
            .into_iter()
            .collect();
    let mut inserts = Vec::new();
    let mut listing_versions: HashMap<String,f64> = sqlx::query_as(
        "SELECT source_item_id,extract(epoch FROM generated_at)::float8 FROM external_market_item_state WHERE source='mesowatch'")
        .fetch_all(&mut *tx).await?.into_iter().collect();
    for item in mapped.values() {
        if let Some(generated) = item.listings_generated_at {
            ensure!(valid_time(generated, now), "Invalid listing export time");
            if listing_versions
                .get(&item.source_item_id)
                .is_some_and(|old| *old > generated)
            {
                continue;
            }
            listing_versions.insert(item.source_item_id.clone(), generated);
            sqlx::query("INSERT INTO external_market_item_state(source,source_item_id,generated_at) VALUES ('mesowatch',$1,to_timestamp($2))
                ON CONFLICT(source,source_item_id) DO UPDATE SET generated_at=EXCLUDED.generated_at")
                .bind(&item.source_item_id).bind(generated).execute(&mut *tx).await?;
            sqlx::query("UPDATE external_market_listings SET up=false WHERE source='mesowatch' AND source_item_id=$1 AND source_generated_at<=to_timestamp($2)")
                .bind(&item.source_item_id).bind(generated).execute(&mut *tx).await?;
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
            !sale.source_key.is_empty() && sale.source_key.len() <= 256,
            "Invalid source key"
        );
        let payload = serde_json::to_value(sale)?;
        if let Some(old) = existing
            .get(&sale.source_key)
            .or_else(|| seen.get(&sale.source_key))
        {
            if old != &payload {
                bail!("Source event changed: {}", sale.source_key);
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
        if listing_versions
            .get(&listing.source_item_id)
            .is_some_and(|latest| *latest > listing.generated_at)
        {
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
    }
    sqlx::query("INSERT INTO external_market_imports(source,fingerprint,source_generated_at,manifest) VALUES ('mesowatch',$1,to_timestamp($2),$3)")
        .bind(fingerprint).bind(points.generated_at).bind(&points.manifest).execute(&mut *tx).await?;
    stats::refresh_all(&mut tx, now).await?;
    tx.commit().await?;
    Ok(outcome)
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

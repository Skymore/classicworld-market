//! The Python site's SQLite stores, for the seed and replay tools:
//! the item catalogue (`items.sqlite`) and the shared market
//! (`market.sqlite`: `members`, `uploads`, `visits`).

use std::path::Path;

use anyhow::{Context, Result};
use market_core::item::category_name;
use market_core::visit_key;
use rusqlite::{Connection, OpenFlags};
use serde_json::{json, Value};
use sqlx::PgPool;

fn open(path: &Path) -> Result<Connection> {
    Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY)
        .with_context(|| format!("opening {}", path.display()))
}

#[derive(Debug, Clone)]
pub struct CatalogItem {
    pub id: i32,
    pub name_zh: Option<String>,
    pub name_en: Option<String>,
    /// items.category of the catalogue (帽子, 消耗品, ...).
    pub subcategory: Option<String>,
    pub icon_url: Option<String>,
    pub record: Value,
}

pub fn read_catalog(path: &Path) -> Result<Vec<CatalogItem>> {
    let db = open(path)?;
    let mut statement =
        db.prepare("SELECT item_id, name_zh, name_en, category, icon_url, record_json FROM items ORDER BY item_id")?;
    let rows = statement.query_map([], |r| {
        Ok((
            r.get::<_, i32>(0)?,
            r.get(1)?,
            r.get(2)?,
            r.get(3)?,
            r.get(4)?,
            r.get::<_, String>(5)?,
        ))
    })?;
    rows.map(|row| {
        let (id, name_zh, name_en, subcategory, icon_url, record) = row?;
        Ok(CatalogItem {
            id,
            name_zh,
            name_en,
            subcategory,
            icon_url,
            record: serde_json::from_str(&record)
                .with_context(|| format!("record_json of {id}"))?,
        })
    })
    .collect()
}

/// Minimal `items` + `item_records` loader for tests and the parity run.
/// The canonical importer is R3's `import_catalog`.
pub async fn seed_items(db: &PgPool, items: &[CatalogItem]) -> Result<usize> {
    let rows: Vec<Value> = items
        .iter()
        .map(|item| {
            let reference = &item.record["mapledex_reference"]["data"];
            json!({
                "id": item.id, "name_zh": item.name_zh, "name_en": item.name_en.clone().unwrap_or_default(),
                "category": category_name(i64::from(item.id)), "subcategory": item.subcategory,
                "req_level": item.record.get("level").and_then(Value::as_i64),
                "req_job_mask": reference.get("reqJob").and_then(Value::as_i64),
                "icon_url": item.icon_url, "is_cash": item.record.get("cash") == Some(&Value::Bool(true)),
                "record": item.record,
            })
        })
        .collect();
    let rows = Value::Array(rows);
    let mut tx = db.begin().await?;
    sqlx::query(
        "INSERT INTO items (id, name_zh, name_en, category, subcategory, req_level, req_job_mask, icon_url, is_cash)
         SELECT id, name_zh, name_en, category, subcategory, req_level, req_job_mask, icon_url, is_cash
         FROM jsonb_to_recordset($1) AS x(id int, name_zh text, name_en text, category text, subcategory text,
              req_level int2, req_job_mask int2, icon_url text, is_cash bool)
         ON CONFLICT (id) DO UPDATE SET name_zh = EXCLUDED.name_zh, name_en = EXCLUDED.name_en,
             category = EXCLUDED.category, subcategory = EXCLUDED.subcategory, req_level = EXCLUDED.req_level,
             req_job_mask = EXCLUDED.req_job_mask, icon_url = EXCLUDED.icon_url, is_cash = EXCLUDED.is_cash",
    )
    .bind(&rows)
    .execute(&mut *tx)
    .await?;
    sqlx::query(
        "INSERT INTO item_records (item_id, record) SELECT id, record FROM jsonb_to_recordset($1) AS x(id int, record jsonb)
         ON CONFLICT (item_id) DO UPDATE SET record = EXCLUDED.record",
    )
    .bind(&rows)
    .execute(&mut *tx)
    .await?;
    tx.commit().await?;
    Ok(items.len())
}

#[derive(Debug, Clone)]
pub struct LegacyMember {
    pub id: String,
    pub name: Option<String>,
    /// sha256 hex of the token.
    pub hash: String,
    pub active: bool,
    pub created: Option<f64>,
}

pub fn read_members(path: &Path) -> Result<Vec<LegacyMember>> {
    let db = open(path)?;
    let mut statement =
        db.prepare("SELECT id, name, hash, active, created FROM members ORDER BY created, id")?;
    let rows = statement.query_map([], |r| {
        Ok(LegacyMember {
            id: r.get(0)?,
            name: r.get(1)?,
            hash: r.get(2)?,
            active: r.get::<_, Option<i64>>(3)?.unwrap_or(0) != 0,
            created: r.get(4)?,
        })
    })?;
    Ok(rows.collect::<rusqlite::Result<_>>()?)
}

/// One upload to replay, with the clock it was validated against.
#[derive(Debug, Clone)]
pub struct LegacyUpload {
    pub collector: String,
    pub payload: Value,
    pub received: f64,
    /// Python's stored fingerprint, when the source kept one.
    pub fingerprint: Option<String>,
    /// Python visit id: the replay order is (observed, visit id) as in reports.
    pub visit_id: String,
    pub observed: f64,
}

/// The `uploads` table: each row is the cleaned v1 payload Python accepted.
pub fn read_uploads(path: &Path) -> Result<Vec<LegacyUpload>> {
    let db = open(path)?;
    let mut statement = db.prepare("SELECT member, oid, hash, received, payload FROM uploads")?;
    let rows = statement.query_map([], |r| {
        Ok((
            r.get::<_, String>(0)?,
            r.get::<_, String>(1)?,
            r.get::<_, String>(2)?,
            r.get::<_, f64>(3)?,
            r.get::<_, String>(4)?,
        ))
    })?;
    let mut uploads = rows
        .map(|row| {
            let (member, oid, hash, received, payload) = row?;
            let payload: Value = serde_json::from_str(&payload)
                .with_context(|| format!("payload of {member}/{oid}"))?;
            let observed = payload["observed_at"].as_f64().unwrap_or(received);
            Ok(LegacyUpload {
                visit_id: visit_key(&member, &oid),
                collector: member,
                payload,
                received,
                fingerprint: Some(hash),
                observed,
            })
        })
        .collect::<Result<Vec<_>>>()?;
    sort(&mut uploads);
    Ok(uploads)
}

/// Rebuild v1 uploads from `visits` (what `dev_fixture.py build` writes; its
/// `uploads` table is empty). Stored slots decode as
/// category*1000 + slot + repeat*1000000, and the rows go back in
/// (category, slot, repeat) order so re-encoding gives the same slots.
pub fn uploads_from_visits(path: &Path) -> Result<Vec<LegacyUpload>> {
    let db = open(path)?;
    let mut statement =
        db.prepare("SELECT id, observed, payload FROM visits WHERE source = 'shared'")?;
    let rows = statement.query_map([], |r| {
        Ok((
            r.get::<_, String>(0)?,
            r.get::<_, f64>(1)?,
            r.get::<_, String>(2)?,
        ))
    })?;
    let mut uploads = rows
        .map(|row| {
            let (id, observed, payload) = row?;
            let visit: Value = serde_json::from_str(&payload).with_context(|| format!("visit {id}"))?;
            let mut items: Vec<(i64, Value)> = visit["items"]
                .as_array()
                .context("visit items")?
                .iter()
                .map(|row| {
                    let encoded = row["slot"].as_i64().unwrap_or(0);
                    let base = encoded % 1_000_000;
                    let mut item = json!({
                        "item_id": row["item_id"], "category": base / 1000, "slot": base % 1000,
                        "price": row["price_mesos_candidate"], "bundle": row["bundle_quantity_candidate"],
                        "stock": row["available_quantity_candidate"],
                    });
                    if !row["shared_equipment"].is_null() {
                        item["equipment"] = row["shared_equipment"].clone();
                    }
                    (base * 1000 + encoded / 1_000_000, item)
                })
                .collect();
            items.sort_by_key(|(order, _)| *order);
            let location = match &visit["market_location"] {
                Value::Object(l) => json!({"channel": l["channel"], "room": l["room"]}),
                _ => Value::Null,
            };
            let payload = json!({
                "version": 1, "world": "ClassicWorld", "complete": true, "observation_id": id,
                "observed_at": visit["time"], "shop_id": visit["shop_id"], "title": visit["title"],
                "location": location, "items": items.into_iter().map(|(_, item)| item).collect::<Vec<_>>(),
            });
            Ok(LegacyUpload {
                collector: visit["session"].as_str().unwrap_or("fixture").to_string(),
                payload,
                received: observed,
                fingerprint: None,
                visit_id: id,
                observed,
            })
        })
        .collect::<Result<Vec<_>>>()?;
    sort(&mut uploads);
    Ok(uploads)
}

fn sort(uploads: &mut [LegacyUpload]) {
    uploads.sort_by(|a, b| {
        a.observed
            .total_cmp(&b.observed)
            .then_with(|| a.visit_id.cmp(&b.visit_id))
    });
}

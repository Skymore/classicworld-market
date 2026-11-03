//! Background rounds: match each subscribed account's watches against new
//! offers and push one notification per item.

use std::collections::{BTreeMap, HashSet};
use std::time::Duration;

use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use sqlx::PgPool;

use super::{
    client::{Delivery, Message, Stored, WebPush},
    matching::{self, Reference},
};

pub const ROUND: Duration = Duration::from_secs(30);
/// Offers older than this are never pushed, e.g. after a restart.
const FRESH_SECONDS: f64 = 600.0;
/// Uploads arrive a little after their observation time; the 24-hour offer
/// keys stop the overlap from repeating a notification.
const OVERLAP_SECONDS: f64 = 120.0;
const DEDUPE_SECONDS: f64 = 86400.0;
/// More items than this in one round become a single summary.
const ITEM_NOTIFICATIONS: usize = 3;
/// Only one process runs rounds, e.g. while a deploy candidate is starting.
pub const ROUND_LOCK: i64 = 0x0063_776d_7075_7368; // "cwmpush"

#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct Round {
    pub accounts: usize,
    /// Messages accepted by push services.
    pub sent: usize,
    /// Subscriptions removed after 404/410.
    pub removed: usize,
}

pub async fn run(db: PgPool, push: std::sync::Arc<WebPush>) {
    let mut tick = tokio::time::interval(ROUND);
    tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    loop {
        tick.tick().await;
        match run_round(&db, &push, crate::unix_now()).await {
            Ok(r) if r.sent + r.removed > 0 => {
                tracing::info!(
                    accounts = r.accounts,
                    sent = r.sent,
                    removed = r.removed,
                    "web push round"
                )
            }
            Ok(_) => {}
            Err(err) => tracing::warn!(error = %err, "web push round failed"),
        }
    }
}

/// One round at `now` (seconds). Skipped while another process holds the lock.
pub async fn run_round(db: &PgPool, push: &WebPush, now: f64) -> anyhow::Result<Round> {
    let mut lock = db.acquire().await?;
    let held: bool = sqlx::query_scalar("SELECT pg_try_advisory_lock($1)")
        .bind(ROUND_LOCK)
        .fetch_one(&mut *lock)
        .await?;
    if !held {
        return Ok(Round::default());
    }
    let result = round(db, push, now).await;
    sqlx::query("SELECT pg_advisory_unlock($1)")
        .bind(ROUND_LOCK)
        .execute(&mut *lock)
        .await?;
    result
}

async fn round(db: &PgPool, push: &WebPush, now: f64) -> anyhow::Result<Round> {
    sqlx::query("DELETE FROM push_deliveries WHERE sent_at<to_timestamp($1)")
        .bind(now - DEDUPE_SECONDS)
        .execute(db)
        .await?;
    // A later subscription starts with a quiet first round again.
    sqlx::query("DELETE FROM push_cursors c WHERE NOT EXISTS (SELECT 1 FROM push_subscriptions s WHERE s.account_id=c.account_id)")
        .execute(db)
        .await?;
    let accounts: Vec<i64> = sqlx::query_scalar(
        "SELECT DISTINCT p.account_id FROM push_subscriptions p
         JOIN account_sessions s ON s.token_hash=p.session_hash WHERE s.expires_at>now() ORDER BY 1",
    )
    .fetch_all(db)
    .await?;
    let mut total = Round {
        accounts: accounts.len(),
        ..Round::default()
    };
    for account in accounts {
        let (sent, removed) = account_round(db, push, account, now).await?;
        total.sent += sent;
        total.removed += removed;
    }
    Ok(total)
}

/// Advances the cursor and returns the lower bound for new offers, or `None`
/// on the account's first round, which only records the cursor.
async fn advance(db: &PgPool, account: i64, now: f64) -> sqlx::Result<Option<f64>> {
    let previous: Option<(f64, f64)> = sqlx::query_as(
        "SELECT extract(epoch FROM started_at)::float8,extract(epoch FROM cursor_at)::float8
         FROM push_cursors WHERE account_id=$1",
    )
    .bind(account)
    .fetch_optional(db)
    .await?;
    sqlx::query(
        "INSERT INTO push_cursors(account_id,started_at,cursor_at) VALUES($1,to_timestamp($2),to_timestamp($2))
         ON CONFLICT(account_id) DO UPDATE SET cursor_at=EXCLUDED.cursor_at",
    )
    .bind(account)
    .bind(now)
    .execute(db)
    .await?;
    Ok(previous.map(|(started, cursor)| {
        started
            .max(cursor - OVERLAP_SECONDS)
            .max(now - FRESH_SECONDS)
    }))
}

/// Watched items with a notifying group, and their settings.
async fn notifying_watches(db: &PgPool, account: i64) -> sqlx::Result<BTreeMap<i32, Value>> {
    let rows: Vec<(String, Value)> = sqlx::query_as(
        "SELECT key,value FROM account_data WHERE account_id=$1 AND kind='watch' AND value IS NOT NULL",
    )
    .bind(account)
    .fetch_all(db)
    .await?;
    Ok(rows
        .into_iter()
        .filter(|(_, setting)| matching::notifies(setting))
        .filter_map(|(key, setting)| Some((key.parse().ok()?, setting)))
        .collect())
}

/// Shop, item, unit price, bundle and equipment; not time or visit.
fn offer_key(row: &Value) -> Vec<u8> {
    let gear = row["item_id"]
        .as_i64()
        .is_some_and(|id| id / 1_000_000 == 1);
    let equipment = if gear {
        &row["equipment"]
    } else {
        &Value::Null
    };
    let identity = json!([
        row["shop_key"],
        row["item_id"],
        row["unit_price"],
        row["bundle"],
        equipment
    ]);
    Sha256::digest(identity.to_string().as_bytes()).to_vec()
}

/// New matching offers per item, each offer key claimed for 24 hours.
async fn new_offers(
    db: &PgPool,
    account: i64,
    watches: &BTreeMap<i32, Value>,
    after: f64,
    now: f64,
) -> sqlx::Result<Vec<Vec<Value>>> {
    let items: Vec<i32> = watches.keys().copied().collect();
    let data = crate::views::watch_listings(db, &items, now).await?;
    let rows = data["grouped_listings"]
        .as_array()
        .map_or(&[][..], Vec::as_slice);
    let reference = Reference {
        rows,
        percentiles: &data["percentile_caps"],
        base_stats: &data["base_stats"],
    };
    let mut found: Vec<(Vec<u8>, &Value)> = Vec::new();
    for (item, setting) in watches {
        for row in matching::notify_selection(rows, i64::from(*item), setting, &reference) {
            if row["observed"].as_f64().is_some_and(|t| t > after) {
                found.push((offer_key(row), row));
            }
        }
    }
    if found.is_empty() {
        return Ok(Vec::new());
    }
    let keys: Vec<Vec<u8>> = found.iter().map(|(key, _)| key.clone()).collect();
    let claimed: HashSet<Vec<u8>> = sqlx::query_scalar(
        "INSERT INTO push_deliveries(account_id,offer_key,sent_at)
         SELECT $1,k,to_timestamp($3) FROM unnest($2::bytea[]) k ON CONFLICT DO NOTHING RETURNING offer_key",
    )
    .bind(account)
    .bind(&keys)
    .bind(now)
    .fetch_all(db)
    .await?
    .into_iter()
    .collect();
    let mut taken = HashSet::new();
    let mut per_item: BTreeMap<i64, Vec<Value>> = BTreeMap::new();
    for (key, row) in found {
        if claimed.contains(&key) && taken.insert(key) {
            per_item
                .entry(row["item_id"].as_i64().unwrap_or_default())
                .or_default()
                .push(row.clone());
        }
    }
    Ok(per_item.into_values().collect())
}

/// Mesos as the site shows them: 万 / 亿 in Chinese, K / M in English.
fn meso(value: f64, en: bool) -> String {
    use crate::bestiary::format::{meso_f, Lang};
    meso_f(value, if en { Lang::En } else { Lang::Zh })
}

fn item_name(row: &Value, en: bool) -> String {
    let text = |key: &str| row[key].as_str().filter(|s| !s.is_empty());
    let id = row["item_id"].to_string();
    // `name_zh` falls back to the id when the catalogue has no Chinese name.
    let zh = text("name_zh").filter(|name| *name != id);
    let name = if en {
        text("name_en").or(zh)
    } else {
        zh.or(text("name_en"))
    };
    name.map_or(id, str::to_owned)
}

fn offer_line(row: &Value, en: bool) -> String {
    let mut parts = vec![
        item_name(row, en),
        meso(row["unit_price"].as_f64().unwrap_or_default(), en),
    ];
    parts.push(match row["stock"].as_i64() {
        Some(n) if en => format!("stock {n}"),
        Some(n) => format!("库存 {n}"),
        None if en => "stock unknown".into(),
        None => "库存未知".into(),
    });
    if let Some(channel) = row["location"]["channel"].as_i64() {
        parts.push(match (row["location"]["room"].as_i64(), en) {
            (Some(room), true) => format!("CH {channel} room {room}"),
            (Some(room), false) => format!("{channel}频道 {room}洞"),
            (None, true) => format!("CH {channel}"),
            (None, false) => format!("{channel}频道"),
        });
    }
    if let Some(shop) = row["shop"].as_str().filter(|s| !s.is_empty()) {
        parts.push(shop.to_owned());
    }
    parts.join(" · ")
}

/// One message per item, or one summary for more than three items.
pub fn messages(items: &[Vec<Value>], en: bool) -> Vec<Message> {
    let title = if en { "Watch alert" } else { "关注提醒" };
    if items.len() > ITEM_NOTIFICATIONS {
        let body = if en {
            format!("{} watched items have new offers", items.len())
        } else {
            format!("{} 件关注有新报价", items.len())
        };
        return vec![Message::new(title, body, "/watch", "watch-summary")];
    }
    items
        .iter()
        .filter_map(|rows| {
            let first = rows.first()?;
            let item = first["item_id"].as_i64()?;
            let body = if let [row] = rows.as_slice() {
                offer_line(row, en)
            } else {
                let lowest = rows
                    .iter()
                    .filter_map(|r| r["unit_price"].as_f64())
                    .fold(f64::INFINITY, f64::min);
                let (name, count, low) = (item_name(first, en), rows.len(), meso(lowest, en));
                if en {
                    format!("{name} · {count} new offers · from {low}")
                } else {
                    format!("{name} · {count} 条新报价 · 最低 {low}")
                }
            };
            Some(Message::new(
                title,
                body,
                format!("/item/{item}"),
                format!("watch-{item}"),
            ))
        })
        .collect()
}

/// Returns (messages sent, subscriptions removed).
async fn account_round(
    db: &PgPool,
    push: &WebPush,
    account: i64,
    now: f64,
) -> anyhow::Result<(usize, usize)> {
    let Some(after) = advance(db, account, now).await? else {
        return Ok((0, 0));
    };
    let watches = notifying_watches(db, account).await?;
    if watches.is_empty() {
        return Ok((0, 0));
    }
    let items = new_offers(db, account, &watches, after, now).await?;
    if items.is_empty() {
        return Ok((0, 0));
    }
    let subscriptions: Vec<Stored> = sqlx::query_as(&format!(
        "SELECT {} FROM push_subscriptions p JOIN account_sessions s ON s.token_hash=p.session_hash
         WHERE p.account_id=$1 AND s.expires_at>now() ORDER BY p.id",
        Stored::COLUMNS
    ))
    .bind(account)
    .fetch_all(db)
    .await?;
    let (zh, en) = (messages(&items, false), messages(&items, true));
    let (mut sent, mut removed) = (0, 0);
    for subscription in subscriptions {
        let mut delivered = false;
        for message in if subscription.lang == "en" { &en } else { &zh } {
            match push.send(&subscription.target(), message).await {
                Delivery::Sent => {
                    delivered = true;
                    sent += 1;
                }
                Delivery::Gone => {
                    sqlx::query("DELETE FROM push_subscriptions WHERE id=$1")
                        .bind(subscription.id)
                        .execute(db)
                        .await?;
                    removed += 1;
                    break;
                }
                outcome @ (Delivery::Busy | Delivery::Failed) => {
                    tracing::info!(
                        subscription = subscription.public_id,
                        ?outcome,
                        "web push skipped this round"
                    );
                    break;
                }
            }
        }
        if delivered {
            sqlx::query("UPDATE push_subscriptions SET last_sent_at=now() WHERE id=$1")
                .bind(subscription.id)
                .execute(db)
                .await?;
        }
    }
    Ok((sent, removed))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn row(item: i64, price: f64, stock: Option<i64>) -> Value {
        json!({"item_id": item, "unit_price": price, "stock": stock, "name_zh": "红色药水", "name_en": "Red Potion",
            "shop": "店名", "shop_key": "k", "bundle": 1, "equipment": null, "location": {"channel": 12, "room": 3}})
    }

    #[test]
    fn copy_follows_the_brief_in_both_languages() {
        let one = messages(&[vec![row(2000000, 41.0, Some(100))]], false);
        assert_eq!(
            one,
            vec![Message::new(
                "关注提醒",
                "红色药水 · 41 · 库存 100 · 12频道 3洞 · 店名",
                "/item/2000000",
                "watch-2000000"
            )]
        );
        let en = messages(&[vec![row(2000000, 41.0, None)]], true);
        assert_eq!(en[0].title, "Watch alert");
        assert_eq!(
            en[0].body,
            "Red Potion · 41 · stock unknown · CH 12 room 3 · 店名"
        );
        let many = messages(
            &[vec![
                row(2000000, 45.0, Some(1)),
                row(2000000, 41.0, Some(1)),
                row(2000000, 1500.0, None),
            ]],
            false,
        );
        assert_eq!(many[0].body, "红色药水 · 3 条新报价 · 最低 41");
        assert_eq!(
            messages(
                &[vec![
                    row(2000000, 1_250_000.0, Some(1)),
                    row(2000000, 2000.0, Some(1))
                ]],
                true
            )[0]
            .body,
            "Red Potion · 2 new offers · from 2K"
        );
        let items: Vec<Vec<Value>> = (0..5)
            .map(|i| vec![row(2000000 + i, 10.0, Some(1))])
            .collect();
        assert_eq!(
            messages(&items, false),
            vec![Message::new(
                "关注提醒",
                "5 件关注有新报价",
                "/watch",
                "watch-summary"
            )]
        );
        assert_eq!(
            messages(&items, true)[0].body,
            "5 watched items have new offers"
        );
        assert_eq!(messages(&items[..3], false).len(), 3);
        let mut unnamed = row(2000000, 41.0, Some(1));
        unnamed["name_zh"] = json!("2000000");
        unnamed["location"] = json!({"channel": 7, "room": null});
        assert_eq!(
            offer_line(&unnamed, false),
            "Red Potion · 41 · 库存 1 · 7频道 · 店名"
        );
    }

    #[test]
    fn meso_matches_the_site_format() {
        for (value, text) in [
            (41.0, "41"),
            (12.5, "12.5"),
            (1000.0, "1K"),
            (1250.0, "1.3K"),
            (999_999.0, "1M"),
            (2_500_000.0, "2.5M"),
        ] {
            assert_eq!(meso(value, true), text);
        }
        for (value, text) in [
            (1250.0, "1250"),
            (12_500.0, "1.3万"),
            (2_500_000.0, "250万"),
        ] {
            assert_eq!(meso(value, false), text);
        }
    }

    #[test]
    fn offer_keys_ignore_time_and_visit_but_not_price_or_gear() {
        let base = row(2000000, 41.0, Some(1));
        let mut later = base.clone();
        later["observed"] = json!(1);
        later["visit_id"] = json!("other");
        later["stock"] = json!(5);
        assert_eq!(offer_key(&base), offer_key(&later));
        let mut cheaper = base.clone();
        cheaper["unit_price"] = json!(40.0);
        assert_ne!(offer_key(&base), offer_key(&cheaper));
        let mut gear = row(1452003, 10.0, Some(1));
        let plain = offer_key(&gear);
        gear["equipment"] = json!({"stats": [{"key": "str", "value": 1}]});
        assert_ne!(offer_key(&gear), plain);
    }
}

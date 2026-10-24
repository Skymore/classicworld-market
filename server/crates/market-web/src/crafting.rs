//! Recipe facts are a versioned public NiaDB snapshot. Only our own quote
//! tables price ingredients; unknown prices stay null.
use std::sync::LazyLock;

use serde::Serialize;
use sqlx::PgPool;

static ITEM_IDS: LazyLock<Vec<i32>> = LazyLock::new(|| {
    let catalog: serde_json::Value =
        serde_json::from_str(include_str!("../../../../web/data/crafting.json"))
            .expect("validated crafting snapshot");
    catalog["items"]
        .as_object()
        .expect("crafting items")
        .keys()
        .map(|id| id.parse().expect("exact Classic World item ID"))
        .collect()
});

#[derive(Serialize, sqlx::FromRow)]
pub struct IngredientPrice {
    item_id: i32,
    name_zh: Option<String>,
    name_en: String,
    icon_url: Option<String>,
    market_price: Option<f64>,
    ask_price: Option<f64>,
    market_at: Option<f64>,
    low_data: Option<bool>,
    npc_price: Option<f64>,
    npc_source: Option<String>,
}

pub async fn prices(db: &PgPool, now: f64) -> sqlx::Result<Vec<IngredientPrice>> {
    sqlx::query_as(
        "SELECT i.id AS item_id, i.name_zh, i.name_en, i.icon_url,
         CASE WHEN s.last_sale_at >= to_timestamp($2 - 72*3600)
                   AND s.last_sale_at <= to_timestamp($2)
              THEN s.typical ELSE NULL END AS market_price,
         CASE WHEN s.listings_count > 0 AND s.last_seen_at >= to_timestamp($2 - 72*3600)
                   AND s.last_seen_at <= to_timestamp($2)
              THEN s.lowest_ask ELSE NULL END AS ask_price,
         extract(epoch FROM s.last_sale_at)::float8 AS market_at, s.low_data,
         n.price AS npc_price, n.source AS npc_source
         FROM items i LEFT JOIN item_stats s ON s.item_id = i.id
         LEFT JOIN LATERAL (
           SELECT price::float8 AS price, source FROM npc_shops
           WHERE item_id=i.id AND price >= 0 ORDER BY price, npc_id LIMIT 1
         ) n ON true WHERE i.id = ANY($1) ORDER BY i.id",
    )
    .bind(&*ITEM_IDS)
    .bind(now)
    .fetch_all(db)
    .await
}

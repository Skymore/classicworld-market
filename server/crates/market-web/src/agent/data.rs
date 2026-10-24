use crate::{unix_now, views};
use serde::Deserialize;
use serde_json::{json, Value};
use sqlx::PgPool;

pub fn definitions() -> Value {
    let id = json!({"type":"integer","minimum":1000000,"maximum":5999999,"description":"Classic World item ID. Resolve names with search_items first."});
    let limit = json!({"type":"integer","minimum":1,"maximum":20,"default":10});
    let hours = json!({"type":"integer","minimum":1,"maximum":720,"default":72});
    let def = |name, description, mut properties: Value, required: Value| {
        for (key, field) in properties.as_object_mut().unwrap() {
            if !required
                .as_array()
                .unwrap()
                .iter()
                .any(|v| v.as_str() == Some(key.as_str()))
                && !matches!(key.as_str(), "query" | "limit" | "hours" | "sort")
            {
                field["type"] = json!([field["type"], "null"]);
                field["default"] = Value::Null;
                if let Some(values) = field.get_mut("enum").and_then(Value::as_array_mut) {
                    values.push(Value::Null);
                }
                field["description"] = json!(format!("{} Optional filter: use null unless explicitly requested by the user. Do not fill with zero, empty string, beginner, channel 1, or a minimum/maximum placeholder.", field["description"].as_str().unwrap_or("")));
            }
        }
        json!({"type":"function","function":{
        "name":name,"description":description,"strict":false,"parameters":{"type":"object",
        "properties":properties,"required":required,"additionalProperties":false}}})
    };
    let mut tools = json!([
        def("search_items", "Search item names/IDs OR recommend equipment using structured filters. Put ONLY item name keywords in query, not job/level requirements. Example: 40-50级弓手披风 -> query:'', subcategory:'披风', job:'archer', min_level:40, max_level:50. Universal equipment is included for each job. Returns at most 12 candidates, requirements and observed market prices; compare these candidates instead of asking users to choose just because several valid options exist.",
            json!({"query":{"type":"string","maxLength":100,"default":"","description":"Item name keywords or item ID only. For a named material such as 铁矿石, set query and leave ALL equipment filters null."},
                "subcategory":{"type":"string","maxLength":30,"description":"Equipment slot in Chinese, e.g. 披风, 手套, 鞋子, 弓, 弩"},
                "job":{"type":"string","enum":["beginner","warrior","magician","archer","thief","pirate"]},
                "min_level":{"type":"integer","minimum":0,"maximum":250},
                "max_level":{"type":"integer","minimum":0,"maximum":250}}), json!([])),
        def("get_item", "Item identity, requirements, NPC purchase offers with maps, and NPC resale reference. NPC buy/sell prices are different.",
            json!({"item_id":id}), json!(["item_id"])),
        def("get_listings", "Cheapest observed offers in the past 72 hours with channel, room/map, shop, stock, equipment, source and observation time. Listings are not guaranteed still available. purchase_details distinguishes remaining bundles from individual items.",
            json!({"item_id":id,"limit":limit,"channel":{"type":"integer","minimum":1,"maximum":99},"max_unit_price":{"type":"number","minimum":0}}), json!(["item_id"])),
        def("get_recent_sales", "Recent inferred sale evidence, newest first. Optional item filter. Not confirmed transactions or whole-market volume. Time window is measured from now. sale_details distinguishes price per purchase from inferred total value.",
            json!({"item_id":id,"limit":limit,"hours":hours}), json!([])),
        def("get_price_advice", "Sell pricing: the site's quick/normal sale recommendations and their evidence, current asks, and sale median/quartiles/count for the selected window. Compare equipment attributes separately.",
            json!({"item_id":id,"hours":hours}), json!(["item_id"])),
        def("get_market_overview", "Market overview and observed item activity, sorted by recent sale evidence (active) or 24h price drops (falling). Does not know the user's bag.",
            json!({"limit":limit,"sort":{"type":"string","enum":["active","falling"],"default":"active"}}), json!([])),
    ]);
    tools
        .as_array_mut()
        .unwrap()
        .extend(super::adventure::definitions());
    tools
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Search {
    #[serde(default)]
    query: String,
    subcategory: Option<String>,
    job: Option<String>,
    min_level: Option<i16>,
    max_level: Option<i16>,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Item {
    item_id: i32,
}
fn ten() -> i64 {
    10
}
fn recent() -> i32 {
    72
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Listings {
    item_id: i32,
    #[serde(default = "ten")]
    limit: i64,
    channel: Option<i16>,
    max_unit_price: Option<f64>,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Sales {
    item_id: Option<i32>,
    #[serde(default = "ten")]
    limit: i64,
    #[serde(default = "recent")]
    hours: i32,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Advice {
    item_id: i32,
    #[serde(default = "recent")]
    hours: i32,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Overview {
    #[serde(default = "ten")]
    limit: i64,
    #[serde(default)]
    sort: Option<String>,
}
pub enum Args {
    Adventure(super::adventure::Request),
    Search(Search),
    Item(Item),
    Listings(Listings),
    Sales(Sales),
    Advice(Advice),
    Overview(Overview),
}

pub fn parse(name: &str, args: Value) -> Result<Args, &'static str> {
    let invalid = "invalid_tool_arguments";
    let item = |id| (1_000_000..=5_999_999).contains(&id);
    let limit = |n| (1..=20).contains(&n);
    let hours = |n| (1..=720).contains(&n);
    match name {
        "get_game_rules" | "get_skills" | "search_game_data" | "get_game_entity" => {
            super::adventure::parse(name, args).map(Args::Adventure)
        }
        "search_items" => {
            let a: Search = serde_json::from_value(args).map_err(|_| invalid)?;
            if a.query.chars().count() > 100
                || a.subcategory
                    .as_ref()
                    .is_some_and(|s| s.trim().is_empty() || s.chars().count() > 30)
                || (a.query.trim().is_empty()
                    && a.subcategory.is_none()
                    && a.job.is_none()
                    && a.min_level.is_none()
                    && a.max_level.is_none())
                || a.job.as_deref().is_some_and(|j| job_mask(j).is_none())
                || a.min_level.is_some_and(|v| !(0..=250).contains(&v))
                || a.max_level.is_some_and(|v| !(0..=250).contains(&v))
                || a.min_level.zip(a.max_level).is_some_and(|(lo, hi)| lo > hi)
            {
                return Err(invalid);
            }
            Ok(Args::Search(a))
        }
        "get_item" => {
            let a: Item = serde_json::from_value(args).map_err(|_| invalid)?;
            if !item(a.item_id) {
                return Err(invalid);
            }
            Ok(Args::Item(a))
        }
        "get_listings" => {
            let a: Listings = serde_json::from_value(args).map_err(|_| invalid)?;
            if !item(a.item_id)
                || !limit(a.limit)
                || a.channel.is_some_and(|c| !(1..=99).contains(&c))
                || a.max_unit_price.is_some_and(|p| !p.is_finite() || p < 0.0)
            {
                return Err(invalid);
            }
            Ok(Args::Listings(a))
        }
        "get_recent_sales" => {
            let a: Sales = serde_json::from_value(args).map_err(|_| invalid)?;
            if a.item_id.is_some_and(|id| !item(id)) || !limit(a.limit) || !hours(a.hours) {
                return Err(invalid);
            }
            Ok(Args::Sales(a))
        }
        "get_price_advice" => {
            let a: Advice = serde_json::from_value(args).map_err(|_| invalid)?;
            if !item(a.item_id) || !hours(a.hours) {
                return Err(invalid);
            }
            Ok(Args::Advice(a))
        }
        "get_market_overview" => {
            let a: Overview = serde_json::from_value(args).map_err(|_| invalid)?;
            if !limit(a.limit) || !matches!(a.sort.as_deref(), None | Some("active" | "falling")) {
                return Err(invalid);
            }
            Ok(Args::Overview(a))
        }
        _ => Err("unknown_tool"),
    }
}

pub async fn run(db: &PgPool, args: Args) -> sqlx::Result<Value> {
    let now = unix_now();
    let mut value = match args {
        Args::Adventure(a) => {
            let mut value = super::adventure::run(a);
            super::adventure::supplement(db, &mut value).await?;
            value["generated_at"] = json!(now);
            return Ok(value);
        }
        Args::Search(a) => search(db, a).await?,
        Args::Item(a) => item(db, a.item_id).await?,
        Args::Listings(a) => {
            views::agent_listings(db, a.item_id, a.limit, a.channel, a.max_unit_price, now).await?
        }
        Args::Sales(a) => views::agent_sales(db, a.item_id, a.limit, a.hours, now).await?,
        Args::Advice(a) => views::agent_advice(db, a.item_id, a.hours, now).await?,
        Args::Overview(a) => overview(db, a.limit, a.sort.as_deref() == Some("falling")).await?,
    };
    clarify_quantities(&mut value);
    value["generated_at"] = json!(now);
    value["limitations"] = json!(views::LIMITATION);
    Ok(value)
}

fn job_mask(job: &str) -> Option<i16> {
    match job {
        "beginner" => Some(-1),
        "warrior" => Some(1),
        "magician" => Some(2),
        "archer" => Some(4),
        "thief" => Some(8),
        "pirate" => Some(16),
        _ => None,
    }
}

async fn search(db: &PgPool, a: Search) -> sqlx::Result<Value> {
    let query = crate::search::normalize(a.query.trim());
    let filter = crate::search::filter_sql("i.id", &["i.name_zh", "i.name_en"], "$1");
    let mut rows: Vec<Value> = sqlx::query_scalar(&format!(
        "SELECT to_jsonb(x) FROM (SELECT i.id AS item_id,i.name_zh,i.name_en,i.subcategory,
         i.req_level AS level,i.req_job_mask,i.icon_url,
         st.lowest_ask,st.typical,st.listings_count,st.sales_24h,
         extract(epoch FROM st.as_of)::float8 AS market_observed_at
         FROM items i LEFT JOIN item_stats st ON st.item_id=i.id
         WHERE {filter}
         AND ($2::text IS NULL OR i.subcategory=$2)
         AND ($3::int2 IS NULL OR i.req_job_mask IS NULL OR i.req_job_mask=0 OR
              ($3=-1 AND i.req_job_mask=-1) OR ($3>0 AND i.req_job_mask>0 AND (i.req_job_mask & $3)>0))
         AND ($4::int2 IS NULL OR i.req_level >= $4)
         AND ($5::int2 IS NULL OR i.req_level <= $5)
         AND (NOT $6::bool OR i.id/1000000=1 AND NOT i.is_cash)
         ORDER BY CASE WHEN lower(i.name_zh)=$7 OR lower(i.name_en)=$7 OR i.id::text=$7 THEN 0 ELSE 1 END,
         (COALESCE(st.listings_count,0)>0) DESC,st.sales_24h DESC NULLS LAST,i.req_level DESC NULLS LAST,i.id LIMIT 13) x"))
        .bind(crate::search::patterns(&query)).bind(a.subcategory.as_deref())
        .bind(a.job.as_deref().and_then(job_mask)).bind(a.min_level).bind(a.max_level)
        .bind(a.job.is_some() || a.min_level.is_some() || a.max_level.is_some() || a.subcategory.is_some())
        .bind(&query).fetch_all(db).await?;
    let truncated = rows.len() > 12;
    rows.truncate(12);
    for row in &mut rows {
        row["jobs"] = json!(market_core::item::equipment_jobs(
            row["req_job_mask"].as_i64()
        ));
        row["job_compatibility"] = json!(match row["req_job_mask"].as_i64() {
            None => "unknown_verify_in_game",
            Some(0) => "universal",
            _ => "matches_requested_job_or_unfiltered",
        });
        row["item_url"] = json!(format!("/item/{}", row["item_id"]));
    }
    Ok(json!({"items":rows,"truncated":truncated,
        "filters":{"query":a.query,"subcategory":a.subcategory,"job":a.job,"min_level":a.min_level,"max_level":a.max_level},
        "search_hint":"If no results, simplify name keywords or relax filters. Jobs and levels are requirements, not item name keywords. Multiple equipment candidates are options to compare, not ambiguous item identity."}))
}

// Expose explicit counts instead of the legacy UI's ambiguous stock/bundle fields.
fn clarify_quantities(value: &mut Value) {
    if let Some(rows) = value.get_mut("listings").and_then(Value::as_array_mut) {
        for row in rows {
            let stock = row["stock"].as_i64();
            let bundle = row["bundle"].as_i64();
            let units = if row["unit_basis"] == "set" {
                stock
            } else {
                stock.zip(bundle).and_then(|(s, b)| s.checked_mul(b))
            };
            row["purchase_details"] = json!({"price_per_purchase":row["price"],
                "items_per_purchase":bundle,"purchases_remaining":stock,
                "comparable_units_remaining":units,"comparable_unit":row["unit_basis"]});
            let object = row.as_object_mut().expect("listing object");
            for key in [
                "stock",
                "bundle",
                "price",
                "visit_id",
                "shop_id",
                "shop_key",
                "slot",
                "raw_available",
                "requires_validation",
            ] {
                object.remove(key);
            }
        }
    }
    if let Some(rows) = value.get_mut("sales").and_then(Value::as_array_mut) {
        for row in rows {
            let purchases = row["quantity"]
                .as_i64()
                .zip(row["bundle"].as_i64())
                .filter(|(q, b)| *b > 0 && *q >= 0 && q % b == 0)
                .map(|(q, b)| q / b);
            let total = purchases
                .zip(row["sale_price"].as_i64())
                .and_then(|(n, p)| n.checked_mul(p));
            row["sale_details"] = json!({"quantity_items_inferred":row["quantity"],
                "purchases_inferred":purchases,"total_mesos_inferred":total});
            let object = row.as_object_mut().expect("sale object");
            for key in [
                "quantity",
                "bundle",
                "sale_price",
                "price",
                "visit_id",
                "shop_id",
                "shop_key",
                "slot",
                "raw_available",
                "requires_validation",
            ] {
                object.remove(key);
            }
        }
    }
}

async fn item(db: &PgPool, id: i32) -> sqlx::Result<Value> {
    let row: Option<Value> = sqlx::query_scalar(
        "SELECT to_jsonb(x) FROM (SELECT id AS item_id,name_zh,name_en,category,subcategory,
         req_level,req_job_mask,icon_url FROM items WHERE id=$1) x",
    )
    .bind(id)
    .fetch_optional(db)
    .await?;
    let offers: Vec<Value> = sqlx::query_scalar(
        "SELECT to_jsonb(x) FROM (SELECT n.id AS npc_id,n.name_zh,n.name_en,s.price AS purchase_price,
         s.source,mp.id AS map_id,mp.name_zh AS map_name_zh,mp.name_en AS map_name_en
         FROM npc_shops s JOIN npcs n ON n.id=s.npc_id
         LEFT JOIN map_npcs mn ON mn.npc_id=n.id LEFT JOIN maps mp ON mp.id=mn.map_id
         WHERE s.item_id=$1 ORDER BY s.price,n.id,mp.id LIMIT 20) x")
        .bind(id).fetch_all(db).await?;
    let record: Option<Value> =
        sqlx::query_scalar("SELECT record FROM item_records WHERE item_id=$1")
            .bind(id)
            .fetch_optional(db)
            .await?;
    let resale = record
        .as_ref()
        .and_then(|r| {
            r.get("npc_price")
                .filter(|p| p.as_f64().is_some_and(|v| v > 0.0))
                .or_else(|| {
                    r.pointer("/mapledex_reference/data/price")
                        .filter(|p| p.as_f64().is_some_and(|v| v > 0.0))
                })
        })
        .cloned();
    let droppers: Vec<Value> = sqlx::query_scalar(
        "SELECT to_jsonb(x) FROM (SELECT m.id AS mob_id,m.name_en,m.name_zh,m.level,
         d.rate_pct,d.quest_id,d.source FROM drops d JOIN mobs m ON m.id=d.mob_id
         WHERE d.item_id=$1 AND m.name_en !~* '^test([[:space:]]|[(]|$)'
         ORDER BY m.level,m.id LIMIT 12) x",
    )
    .bind(id)
    .fetch_all(db)
    .await?;
    Ok(
        json!({"item":row,"npc_offers":offers,"npc_resale_reference":resale,
        "drop_reference":{"monsters":droppers,"provenance":"Imported Mapledex catalogue includes CoT2 reference data. Drop rates/availability are not verified for the live launch. Quest-only drops must not be treated as ordinary drops."},
        "item_url":format!("/item/{id}"),"unit_basis":crate::external::unit(id)}),
    )
}

async fn overview(db: &PgPool, limit: i64, falling: bool) -> sqlx::Result<Value> {
    let rows: Vec<Value> = sqlx::query_scalar(
        "SELECT to_jsonb(x) FROM (SELECT i.id AS item_id,i.name_zh,i.name_en,
         st.typical,st.lowest_ask,st.sales_24h,st.change_24h,st.listings_count,
         extract(epoch FROM st.as_of)::float8 AS as_of,market_price_unit(i.id) AS unit_basis
         FROM item_stats st JOIN items i ON i.id=st.item_id
         WHERE NOT $2::bool OR st.change_24h<0
         ORDER BY CASE WHEN $2 THEN st.change_24h END ASC NULLS LAST,
         st.sales_24h DESC,st.item_id LIMIT $1) x",
    )
    .bind(limit)
    .bind(falling)
    .fetch_all(db)
    .await?;
    let head = views::header(db, views::Hours::Recent, crate::unix_now()).await?;
    Ok(
        json!({"items":rows,"as_of":head.as_of,"active_shops":head.active_shops,
        "observed_items":head.item_count,"sort":if falling {"falling"} else {"active"}}),
    )
}

#[cfg(test)]
mod quantity_tests {
    use super::*;

    #[test]
    fn bundle_stock_and_sale_totals_are_distinct_from_item_counts() {
        let mut value = json!({"listings":[{"price":1000,"bundle":2,"stock":3,"unit_basis":"item"},
            {"price":5000,"bundle":1000,"stock":3,"unit_basis":"set"},
            {"unit_basis":"item","stock":null}],
            "sales":[{"sale_price":1000,"bundle":2,"quantity":4},{"quantity":null,"bundle":null}]});
        clarify_quantities(&mut value);
        assert_eq!(
            value["listings"][0]["purchase_details"]["comparable_units_remaining"],
            6
        );
        assert_eq!(
            value["listings"][1]["purchase_details"]["comparable_units_remaining"],
            3
        );
        assert!(value["listings"][2]["purchase_details"]["comparable_units_remaining"].is_null());
        assert_eq!(
            value["sales"][0]["sale_details"]["total_mesos_inferred"],
            2000
        );
        assert_eq!(value["sales"][0]["sale_details"]["purchases_inferred"], 2);
        assert!(value["sales"][1]["sale_details"]["total_mesos_inferred"].is_null());
        assert!(value["listings"][0].get("stock").is_none());
        assert!(value["sales"][0].get("sale_price").is_none());
    }
}

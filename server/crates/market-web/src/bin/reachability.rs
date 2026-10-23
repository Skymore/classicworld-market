//! Acceptance check for R3 (plan §8): how many maps are reachable from a
//! start map (default 射手村 / Henesys) over `map_portals`, and which are not.
//!
//! ```sh
//! DATABASE_URL=postgres://... cargo run -p market-web --bin reachability -- [--from 10001000]
//! ```

use std::collections::{BTreeMap, HashSet};

use anyhow::{Context, Result};
use market_web::bestiary::{
    cli::{self, Args},
    queries,
    route::{Graph, HENESYS},
};

#[tokio::main]
async fn main() -> Result<()> {
    let args = Args::parse(std::env::args().skip(1), &["from"])?;
    let default_start = HENESYS.to_string();
    let start: i32 = args
        .get_or("from", &default_start)
        .parse()
        .context("--from must be a map id")?;
    let db = cli::connect().await?;

    let maps: BTreeMap<i32, (String, Option<String>)> = sqlx::query_as::<
        _,
        (i32, String, Option<String>),
    >(
        "SELECT id, COALESCE(name_zh, name_tw, name_en), COALESCE(street_zh, street_tw, street_en)
         FROM maps ORDER BY id",
    )
    .fetch_all(&db)
    .await?
    .into_iter()
    .map(|(id, name, street)| (id, (name, street)))
    .collect();
    let by_source: Vec<(String, i64)> = sqlx::query_as(
        "SELECT source || '/' || kind, count(*) FROM map_portals GROUP BY 1 ORDER BY 1",
    )
    .fetch_all(&db)
    .await?;
    let graph = Graph::new(queries::load_edges(&db).await?);

    let start_name = maps
        .get(&start)
        .map_or("(not in maps)", |(name, _)| name.as_str());
    let listed = |set: HashSet<i32>| set.into_iter().filter(|id| maps.contains_key(id)).count();
    let forward = graph.reachable_from(start);
    let edges: Vec<String> = by_source.iter().map(|(k, n)| format!("{k} {n}")).collect();

    println!("start: {start} {start_name}");
    println!(
        "maps: {}; edges: {} ({})",
        maps.len(),
        graph.edge_count(),
        edges.join(", ")
    );
    println!(
        "reachable from start:            {:>4} / {}",
        listed(forward.clone()),
        maps.len()
    );
    println!(
        "can reach start:                 {:>4} / {}",
        listed(graph.reaching(start)),
        maps.len()
    );
    println!(
        "connected ignoring direction:    {:>4} / {}",
        listed(graph.connected_to(start)),
        maps.len()
    );
    let outside = forward.iter().filter(|id| !maps.contains_key(id)).count();
    if outside > 0 {
        println!("also reachable, not in maps:     {outside:>4}");
    }

    let unreachable: Vec<_> = maps
        .iter()
        .filter(|(id, _)| !forward.contains(id))
        .collect();
    println!("unreachable from start ({}):", unreachable.len());
    for (id, (name, street)) in unreachable {
        println!("  {id:>9}  {name}  [{}]", street.as_deref().unwrap_or("-"));
    }
    Ok(())
}

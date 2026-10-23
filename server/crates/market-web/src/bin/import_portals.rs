//! Loads Map.wz portals from `market_map_resources.py` output. Replaces the
//! WZ portals of the maps in the input; other maps keep theirs.
//!
//! ```sh
//! # on a machine with the client:
//! python market_map_resources.py --wz <client>/Data/Map/Map.wz --map-id 10001000 --output portals/10001000.json
//! DATABASE_URL=postgres://... cargo run -p market-web --bin import_portals -- portals/
//! ```
//!
//! Arguments are JSON files or directories of them.

use std::path::{Path, PathBuf};

use anyhow::{bail, Context, Result};
use market_web::bestiary::{
    cli::{self, Args},
    wz,
};

#[tokio::main]
async fn main() -> Result<()> {
    let args = Args::parse(std::env::args().skip(1), &[])?;
    if args.positional.is_empty() {
        bail!("usage: import_portals <file.json | dir>...");
    }
    let mut maps = Vec::new();
    for path in json_files(&args.positional)? {
        let text = std::fs::read_to_string(&path)
            .with_context(|| format!("reading {}", path.display()))?;
        maps.extend(wz::parse(&text).with_context(|| path.display().to_string())?);
    }
    let portals = wz::portals_from(&maps);
    let db = cli::connect().await?;
    let inserted = wz::import(&db, &portals, &args.positional.join(" ")).await?;
    println!("maps {:>5}  portals {:>5}", portals.map_ids.len(), inserted);
    Ok(())
}

fn json_files(paths: &[String]) -> Result<Vec<PathBuf>> {
    let mut out = Vec::new();
    for path in paths.iter().map(Path::new) {
        if path.is_dir() {
            let mut files: Vec<PathBuf> = std::fs::read_dir(path)?
                .filter_map(|e| e.ok().map(|e| e.path()))
                .filter(|p| p.extension().is_some_and(|ext| ext == "json"))
                .collect();
            files.sort();
            out.extend(files);
        } else {
            out.push(path.to_path_buf());
        }
    }
    Ok(out)
}

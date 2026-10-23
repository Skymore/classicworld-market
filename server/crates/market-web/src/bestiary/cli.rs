//! Shared bits of the bestiary command-line tools.

use std::collections::HashMap;

use anyhow::{bail, Context, Result};
use sqlx::{postgres::PgPoolOptions, PgPool};

use crate::MIGRATOR;

/// Connects to `DATABASE_URL` and applies the embedded migrations, so the
/// tools work on an empty database.
pub async fn connect() -> Result<PgPool> {
    let url = std::env::var("DATABASE_URL").context("DATABASE_URL is not set")?;
    let db = PgPoolOptions::new()
        .max_connections(2)
        .connect(&url)
        .await
        .context("connecting to Postgres")?;
    MIGRATOR.run(&db).await.context("running migrations")?;
    Ok(db)
}

/// `--name value` pairs plus positional arguments.
#[derive(Debug, Default)]
pub struct Args {
    pub flags: HashMap<String, String>,
    pub positional: Vec<String>,
}

impl Args {
    /// Parses `args`; flags not in `known` are an error.
    pub fn parse(args: impl IntoIterator<Item = String>, known: &[&str]) -> Result<Self> {
        let mut out = Args::default();
        let mut args = args.into_iter();
        while let Some(arg) = args.next() {
            let Some(name) = arg.strip_prefix("--") else {
                out.positional.push(arg);
                continue;
            };
            if !known.contains(&name) {
                bail!("unknown flag --{name}; known: {}", known.join(", "));
            }
            let value = args
                .next()
                .with_context(|| format!("--{name} needs a value"))?;
            out.flags.insert(name.to_string(), value);
        }
        Ok(out)
    }

    pub fn get_or<'a>(&'a self, name: &str, default: &'a str) -> &'a str {
        self.flags.get(name).map_or(default, String::as_str)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn strings(args: &[&str]) -> Vec<String> {
        args.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn flags_and_positional() {
        let args = Args::parse(strings(&["--from", "1", "a.json", "b.json"]), &["from"]).unwrap();
        assert_eq!(args.get_or("from", "0"), "1");
        assert_eq!(args.get_or("to", "9"), "9");
        assert_eq!(args.positional, strings(&["a.json", "b.json"]));
        assert!(Args::parse(strings(&["--nope", "1"]), &["from"]).is_err());
        assert!(Args::parse(strings(&["--from"]), &["from"]).is_err());
    }
}

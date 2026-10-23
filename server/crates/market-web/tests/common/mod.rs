//! A throwaway database per test. Tests skip when DATABASE_URL is unset so
//! `cargo test` works without Postgres; CI sets it.

#![allow(dead_code)]

use std::str::FromStr;

use market_web::{auth::Collector, MIGRATOR};
use sqlx::postgres::{PgConnectOptions, PgPoolOptions};
use sqlx::{ConnectOptions, PgPool};

pub struct TestDb {
    pub pool: PgPool,
    admin: PgPool,
    name: String,
}

impl TestDb {
    pub async fn new() -> Option<Self> {
        let Ok(url) = std::env::var("DATABASE_URL") else {
            eprintln!("DATABASE_URL is not set; skipping database test");
            return None;
        };
        let options = PgConnectOptions::from_str(&url).expect("DATABASE_URL");
        let admin = PgPoolOptions::new()
            .max_connections(1)
            .connect_with(options.clone())
            .await
            .expect("connect admin");
        let mut suffix = [0u8; 6];
        getrandom::getrandom(&mut suffix).expect("rng");
        let name = format!("market_test_{}", hex::encode(suffix));
        sqlx::query(&format!("CREATE DATABASE {name}"))
            .execute(&admin)
            .await
            .expect("create test database");
        let pool = PgPoolOptions::new()
            .max_connections(4)
            .connect_with(options.database(&name).disable_statement_logging())
            .await
            .expect("connect test database");
        MIGRATOR.run(&pool).await.expect("migrations");
        Some(Self { pool, admin, name })
    }

    pub async fn collector(&self, name: &str) -> Collector {
        let (id, public_id): (i64, String) = sqlx::query_as(
            "INSERT INTO collectors (public_id, token_hash, source, name) VALUES ($1, $2, 'packet', $1)
             RETURNING id, public_id",
        )
        .bind(name)
        .bind(market_web::auth::token_hash(&format!("token-of-{name}-padding-to-thirty-chars")))
        .fetch_one(&self.pool)
        .await
        .expect("collector");
        Collector { id, public_id }
    }

    pub async fn close(self) {
        self.pool.close().await;
        sqlx::query(&format!(
            "DROP DATABASE IF EXISTS {} WITH (FORCE)",
            self.name
        ))
        .execute(&self.admin)
        .await
        .expect("drop test database");
    }
}

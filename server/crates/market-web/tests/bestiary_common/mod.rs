//! Postgres for integration tests. Each test gets its own schema in the
//! `DATABASE_URL` database, so tests run in parallel. Without `DATABASE_URL`
//! the database tests skip (CI always sets it).

#![allow(dead_code)]

use std::sync::atomic::{AtomicU32, Ordering};

use market_web::MIGRATOR;
use sqlx::{postgres::PgPoolOptions, Connection, Executor, PgConnection, PgPool};

static NEXT: AtomicU32 = AtomicU32::new(0);

pub struct TestDb {
    pub pool: PgPool,
    url: String,
    schema: String,
}

/// A migrated, empty schema; `None` (test skips) without `DATABASE_URL`.
pub async fn test_db() -> Option<TestDb> {
    let Ok(url) = std::env::var("DATABASE_URL") else {
        eprintln!("DATABASE_URL not set; skipping database test");
        return None;
    };
    let schema = format!(
        "test_{}_{}",
        std::process::id(),
        NEXT.fetch_add(1, Ordering::SeqCst)
    );
    let mut admin = PgConnection::connect(&url)
        .await
        .expect("connect to DATABASE_URL");
    sweep_stale(&mut admin).await;
    admin
        .execute(format!("CREATE SCHEMA {schema}").as_str())
        .await
        .expect("create schema");
    admin.close().await.ok();

    let search_path = format!("SET search_path TO {schema}");
    let pool = PgPoolOptions::new()
        .max_connections(4)
        .after_connect(move |conn, _| {
            let sql = search_path.clone();
            Box::pin(async move {
                conn.execute(sql.as_str()).await?;
                Ok(())
            })
        })
        .connect(&url)
        .await
        .expect("pool");
    MIGRATOR.run(&pool).await.expect("migrations");
    Some(TestDb { pool, url, schema })
}

static SWEPT: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

/// A test that panics leaves its schema in the shared database. Once per test
/// process, drop test schemas whose migration table was written over an hour
/// ago (a running test's is minutes old). Best effort: needs a superuser.
async fn sweep_stale(admin: &mut PgConnection) {
    if SWEPT.swap(true, Ordering::SeqCst) {
        return;
    }
    let stale: Vec<String> = sqlx::query_scalar(
        "SELECT n.nspname::text FROM pg_namespace n
         JOIN pg_class c ON c.relnamespace = n.oid AND c.relname = '_sqlx_migrations'
         WHERE n.nspname ~ '^test_[0-9]+_[0-9]+$'
           AND (pg_stat_file(pg_relation_filepath(c.oid))).modification < now() - interval '1 hour'",
    )
    .fetch_all(&mut *admin)
    .await
    .unwrap_or_default();
    for schema in stale {
        let _ = admin.execute(format!("DROP SCHEMA IF EXISTS {schema} CASCADE").as_str()).await;
    }
}

impl TestDb {
    pub async fn drop_schema(self) {
        self.pool.close().await;
        let mut admin = PgConnection::connect(&self.url).await.expect("connect");
        admin
            .execute(format!("DROP SCHEMA {} CASCADE", self.schema).as_str())
            .await
            .expect("drop schema");
    }
}

//! Collector identity and rate limits, as in `shared_store.py` and
//! `shared_server.py`: a random bearer token per collector, stored as its
//! sha256; sliding one-minute windows per key.

use std::collections::{HashMap, VecDeque};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use base64::Engine as _;
use sha2::{Digest, Sha256};
use sqlx::PgPool;

/// Python accepts tokens of 30..=128 characters only.
const TOKEN_CHARS: std::ops::RangeInclusive<usize> = 30..=128;
const WINDOW: Duration = Duration::from_secs(60);
/// Bounds bookkeeping for unauthenticated addresses.
const MAX_TRACKED_KEYS: usize = 2000;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Collector {
    pub id: i64,
    pub public_id: String,
}

pub struct Credentials {
    pub public_id: String,
    pub token: String,
}

fn random_bytes<const N: usize>() -> [u8; N] {
    let mut bytes = [0u8; N];
    getrandom::getrandom(&mut bytes).expect("operating system RNG");
    bytes
}

pub fn token_hash(token: &str) -> Vec<u8> {
    Sha256::digest(token.as_bytes()).to_vec()
}

/// `secrets.token_hex(12)` id and `secrets.token_urlsafe(32)` token.
pub fn new_credentials() -> Credentials {
    Credentials {
        public_id: hex::encode(random_bytes::<12>()),
        token: base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(random_bytes::<32>()),
    }
}

/// `SharedStore.invite`.
pub async fn register(db: &PgPool, name: &str) -> sqlx::Result<Credentials> {
    let credentials = new_credentials();
    sqlx::query("INSERT INTO collectors (public_id, token_hash, source, name) VALUES ($1, $2, 'packet', $3)")
        .bind(&credentials.public_id)
        .bind(token_hash(&credentials.token))
        .bind(name)
        .execute(db)
        .await?;
    Ok(credentials)
}

/// `SharedStore.authenticate`: active collector for a bearer token.
pub async fn authenticate(db: &PgPool, token: Option<&str>) -> sqlx::Result<Option<Collector>> {
    let Some(token) = token.filter(|t| TOKEN_CHARS.contains(&t.chars().count())) else {
        return Ok(None);
    };
    let row: Option<(i64, String)> =
        sqlx::query_as("SELECT id, public_id FROM collectors WHERE token_hash = $1 AND active")
            .bind(token_hash(token))
            .fetch_optional(db)
            .await?;
    Ok(row.map(|(id, public_id)| Collector { id, public_id }))
}

/// `SharedStore.revoke`.
pub async fn revoke(db: &PgPool, public_id: &str) -> sqlx::Result<bool> {
    let done = sqlx::query("UPDATE collectors SET active = false WHERE public_id = $1")
        .bind(public_id)
        .execute(db)
        .await?;
    Ok(done.rows_affected() > 0)
}

/// `allowed(key, limit)` in `shared_server.py`.
#[derive(Default)]
pub struct RateLimiter {
    windows: Mutex<HashMap<String, VecDeque<Instant>>>,
}

impl RateLimiter {
    pub fn allow(&self, key: &str, limit: usize) -> bool {
        self.allow_at(key, limit, Instant::now())
    }

    fn allow_at(&self, key: &str, limit: usize, now: Instant) -> bool {
        let mut windows = self.windows.lock().expect("rate limiter lock");
        if windows.len() > MAX_TRACKED_KEYS {
            windows.clear();
        }
        let hits = windows.entry(key.to_string()).or_default();
        while hits
            .front()
            .is_some_and(|t| now.duration_since(*t) > WINDOW)
        {
            hits.pop_front();
        }
        if hits.len() >= limit {
            return false;
        }
        hits.push_back(now);
        true
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn credentials_have_python_shapes() {
        let c = new_credentials();
        assert_eq!(c.public_id.len(), 24);
        assert_eq!(c.token.len(), 43);
        assert!(TOKEN_CHARS.contains(&c.token.len()));
        assert_eq!(token_hash("x").len(), 32);
    }

    #[test]
    fn limiter_slides_per_key() {
        let limiter = RateLimiter::default();
        let start = Instant::now();
        for _ in 0..5 {
            assert!(limiter.allow_at("register:a", 5, start));
        }
        assert!(!limiter.allow_at("register:a", 5, start));
        assert!(limiter.allow_at("register:b", 5, start));
        assert!(limiter.allow_at("register:a", 5, start + Duration::from_secs(61)));
    }
}

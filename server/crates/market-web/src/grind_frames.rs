//! Collectors' recorded game frames (captures/grind/frames, gzipped), uploaded so a
//! parser fix can be checked against everyone's recordings. Private: authenticated
//! upload only, no read route; kept 30 days under a total size cap.
use crate::{
    api::{bearer, error, internal},
    auth, unix_now, AppState,
};
use axum::{
    body::Bytes,
    extract::{DefaultBodyLimit, Query, State},
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    routing::post,
    Json, Router,
};
use serde::Deserialize;
use serde_json::json;
use std::{
    io::Write,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicU64, Ordering},
        Mutex,
    },
    time::{Duration, SystemTime},
};

const RETENTION: Duration = Duration::from_secs(30 * 86400);
const CAPACITY: u64 = 40 * 1024 * 1024 * 1024;
pub const MAX_FILE: usize = 64 * 1024 * 1024;
static STORAGE: Mutex<()> = Mutex::new(());
static USED: AtomicU64 = AtomicU64::new(0);

pub fn router() -> Router<AppState> {
    Router::new().route(
        "/api/v1/collector/grind-frames",
        post(upload).layer(DefaultBodyLimit::max(MAX_FILE)),
    )
}

fn root() -> PathBuf {
    PathBuf::from("shared_data/grind-frames")
}

/// frames_YYYYMMDD_HHMMSS_<session>.jsonl.gz, as grind_frames names them.
fn valid_name(name: &str) -> bool {
    let Some(stem) = name
        .strip_prefix("frames_")
        .and_then(|s| s.strip_suffix(".jsonl.gz"))
    else {
        return false;
    };
    let parts: Vec<&str> = stem.split('_').collect();
    parts.len() == 3
        && parts[0].len() == 8
        && parts[1].len() == 6
        && parts[0]
            .bytes()
            .chain(parts[1].bytes())
            .all(|b| b.is_ascii_digit())
        && (1..=16).contains(&parts[2].len())
        && parts[2].bytes().all(|b| b.is_ascii_alphanumeric())
}

fn save(root: &Path, collector: i64, name: &str, body: &[u8]) -> std::io::Result<bool> {
    let _guard = STORAGE
        .lock()
        .map_err(|_| std::io::Error::other("frame storage lock unavailable"))?;
    let folder = root.join(collector.to_string());
    std::fs::create_dir_all(&folder)?;
    let target = folder.join(name);
    if target.exists() {
        return Ok(false); // Already received: an upload retried after a lost reply.
    }
    if USED.load(Ordering::Relaxed) + body.len() as u64 > CAPACITY {
        return Err(std::io::Error::other("frame storage full"));
    }
    let pending = folder.join(format!("{name}.pending"));
    let mut file = std::fs::OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(true)
        .open(&pending)?;
    if let Err(e) = file.write_all(body).and_then(|_| file.sync_all()) {
        drop(file);
        let _ = std::fs::remove_file(&pending);
        return Err(e);
    }
    drop(file);
    std::fs::rename(pending, target)?;
    USED.fetch_add(body.len() as u64, Ordering::Relaxed);
    Ok(true)
}

fn cleanup(root: &Path, now: SystemTime) -> std::io::Result<()> {
    let _guard = STORAGE
        .lock()
        .map_err(|_| std::io::Error::other("frame storage lock unavailable"))?;
    let mut total = 0;
    if !root.exists() {
        return Ok(());
    }
    for entry in std::fs::read_dir(root)? {
        let entry = entry?;
        if !entry.file_type()?.is_dir() {
            continue;
        }
        for file in std::fs::read_dir(entry.path())? {
            let file = file?;
            if !file.file_type()?.is_file() {
                continue;
            }
            let metadata = file.metadata()?;
            let age = now.duration_since(metadata.modified()?).unwrap_or_default();
            if age >= RETENTION
                || (file.path().extension().is_some_and(|s| s == "pending")
                    && age >= Duration::from_secs(600))
            {
                std::fs::remove_file(file.path())?;
            } else {
                total += metadata.len();
            }
        }
    }
    USED.store(total, Ordering::Relaxed);
    Ok(())
}

pub async fn prune() {
    let mut tick = tokio::time::interval(Duration::from_secs(600));
    loop {
        tick.tick().await;
        match tokio::task::spawn_blocking(|| cleanup(&root(), SystemTime::now())).await {
            Ok(Ok(())) => {}
            _ => tracing::warn!("grind frame retention cleanup failed"),
        }
    }
}

#[derive(Deserialize)]
pub struct Named {
    name: String,
}

pub async fn upload(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(query): Query<Named>,
    body: Bytes,
) -> Response {
    if body.len() > MAX_FILE {
        return error(StatusCode::PAYLOAD_TOO_LARGE, "Recording too large");
    }
    let collector = match auth::authenticate(&state.db, bearer(&headers)).await {
        Ok(Some(c)) => c,
        Ok(None) => return error(StatusCode::UNAUTHORIZED, "Collector token required"),
        Err(e) => return internal(e),
    };
    if !state
        .limiter
        .allow(&format!("grind-frames:{}", collector.id), 60)
    {
        return error(StatusCode::TOO_MANY_REQUESTS, "Rate limited");
    }
    if !valid_name(&query.name) || !body.starts_with(&[0x1f, 0x8b]) {
        return error(StatusCode::BAD_REQUEST, "Invalid recording");
    }
    let name = query.name.clone();
    match tokio::task::spawn_blocking(move || save(&root(), collector.id, &query.name, &body)).await
    {
        Ok(Ok(stored)) => {
            Json(json!({"name": name, "stored": stored, "received_at": unix_now()})).into_response()
        }
        _ => error(
            StatusCode::SERVICE_UNAVAILABLE,
            "Recording storage temporarily unavailable",
        ),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn names_are_the_recorders_own() {
        assert!(valid_name("frames_20261115_124922_050ad778.jsonl.gz"));
        assert!(!valid_name("frames_20261115_124922_050ad778.jsonl"));
        assert!(!valid_name("../frames_20261115_124922_050ad778.jsonl.gz"));
        assert!(!valid_name("frames_2026111_124922_x.jsonl.gz"));
        assert!(!valid_name("frames_20261115_124922_a/b.jsonl.gz"));
    }

    #[test]
    fn a_retried_upload_is_kept_once() {
        let dir = std::env::temp_dir().join(format!("grind-frames-test-{}", std::process::id()));
        let name = "frames_20261115_124922_050ad778.jsonl.gz";
        assert!(save(&dir, 7, name, b"\x1f\x8bdata").unwrap());
        assert!(!save(&dir, 7, name, b"\x1f\x8bdata").unwrap());
        assert_eq!(
            std::fs::read(dir.join("7").join(name)).unwrap(),
            b"\x1f\x8bdata"
        );
        let _ = std::fs::remove_dir_all(dir);
    }
}

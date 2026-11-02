//! Private, authenticated collector diagnostics; no public read or static route.
use crate::{
    api::{bearer, error, internal},
    auth, unix_now, AppState,
};
use axum::{
    body::Bytes,
    extract::State,
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    Json,
};
use flate2::{write::GzEncoder, Compression};
use base64::Engine;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    collections::BTreeMap,
    io::{Read, Write},
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicU64, Ordering},
        Mutex,
    },
    time::{Duration, SystemTime},
};

const RETENTION: Duration = Duration::from_secs(7 * 86400);
const CAPACITY: u64 = 512 * 1024 * 1024;
pub const MAX_REPORT: usize = 1536000;
static STORAGE: Mutex<()> = Mutex::new(());
static USED: AtomicU64 = AtomicU64::new(0);

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct Report {
    schema: u8,
    id: String,
    version: String,
    created_at: f64,
    kind: String,
    state: BTreeMap<String, Value>,
    files: BTreeMap<String, String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    screenshot: Option<String>,
}

impl Report {
    fn valid(&self) -> bool {
        self.schema == 1
            && self.id.len() == 32
            && self.id.bytes().all(|b| b.is_ascii_hexdigit())
            && crate::collector_updates::stable_tag(&format!("v{}", self.version))
            && self.created_at.is_finite()
            && self.created_at > 0.
            && matches!(self.kind.as_str(), "manual" | "continuous")
            && self.state.len() <= 12
            && self.files.len() <= 16
            && self.screenshot.as_ref().is_none_or(|encoded| {
                self.kind == "manual" && encoded.len() <= 1400000 &&
                base64::engine::general_purpose::STANDARD.decode(encoded).is_ok_and(|data| {
                    data.len() <= 1024 * 1024 && data.starts_with(b"\xff\xd8\xff") && data.ends_with(b"\xff\xd9")
                })
            })
            && self.files.iter().all(|(name, data)| {
                !name.is_empty()
                    && name.len() <= 80
                    && name
                        .bytes()
                        .all(|b| b.is_ascii_alphanumeric() || b"._-".contains(&b))
                    && data.len() <= 24000
            })
    }
}

fn root() -> PathBuf {
    PathBuf::from("shared_data/diagnostics")
}

fn save(root: &Path, collector: i64, id: &str, body: &[u8]) -> std::io::Result<()> {
    let _guard = STORAGE
        .lock()
        .map_err(|_| std::io::Error::other("diagnostic lock unavailable"))?;
    let folder = root.join(collector.to_string());
    std::fs::create_dir_all(&folder)?;
    let final_path = folder.join(format!("{id}.json.gz"));
    if final_path.exists() {
        let mut previous = Vec::new();
        flate2::read::GzDecoder::new(std::fs::File::open(final_path)?)
            .take((MAX_REPORT + 1) as u64)
            .read_to_end(&mut previous)?;
        return if previous == body {
            Ok(())
        } else {
            Err(std::io::Error::other("report id collision"))
        };
    }
    let mut encoder = GzEncoder::new(Vec::new(), Compression::fast());
    encoder.write_all(body)?;
    let encoded = encoder.finish()?;
    if USED.load(Ordering::Relaxed) + encoded.len() as u64 > CAPACITY {
        return Err(std::io::Error::other("diagnostic storage full"));
    }
    let pending = folder.join(format!("{id}.pending"));
    let mut file = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&pending)?;
    if let Err(error) = (|| {
        file.write_all(&encoded)?;
        file.sync_all()
    })() {
        drop(file);
        let _ = std::fs::remove_file(pending);
        return Err(error);
    }
    drop(file);
    std::fs::rename(pending, final_path)?;
    USED.fetch_add(encoded.len() as u64, Ordering::Relaxed);
    Ok(())
}

fn cleanup(root: &Path, now: SystemTime) -> std::io::Result<()> {
    let _guard = STORAGE
        .lock()
        .map_err(|_| std::io::Error::other("diagnostic lock unavailable"))?;
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
                    && age >= Duration::from_secs(300))
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
    let mut tick = tokio::time::interval(Duration::from_secs(60));
    loop {
        tick.tick().await;
        match tokio::task::spawn_blocking(|| cleanup(&root(), SystemTime::now())).await {
            Ok(Ok(())) => {}
            _ => tracing::warn!("diagnostic retention cleanup failed"),
        }
    }
}

pub async fn upload(State(state): State<AppState>, headers: HeaderMap, body: Bytes) -> Response {
    if body.len() > MAX_REPORT {
        return error(StatusCode::PAYLOAD_TOO_LARGE, "Diagnostic batch too large");
    }
    let collector = match auth::authenticate(&state.db, bearer(&headers)).await {
        Ok(Some(c)) => c,
        Ok(None) => return error(StatusCode::UNAUTHORIZED, "Collector token required"),
        Err(e) => return internal(e),
    };
    if !state
        .limiter
        .allow(&format!("diagnostics:{}", collector.id), 6)
    {
        return error(StatusCode::TOO_MANY_REQUESTS, "Rate limited");
    }
    let report = match serde_json::from_slice::<Report>(&body) {
        Ok(r) if r.valid() => r,
        _ => return error(StatusCode::BAD_REQUEST, "Invalid diagnostics"),
    };
    if report.screenshot.is_none() && body.len() > 65536 {
        return error(StatusCode::PAYLOAD_TOO_LARGE, "Diagnostic batch too large");
    }
    let id = report.id.clone();
    let canonical = match serde_json::to_vec(&report) {
        Ok(v) => v,
        Err(e) => return internal(e),
    };
    match tokio::task::spawn_blocking(move || save(&root(), collector.id, &report.id, &canonical))
        .await
    {
        Ok(Ok(())) => Json(json!({"report_id":id,"retention_days":7,"received_at":unix_now()}))
            .into_response(),
        _ => error(
            StatusCode::SERVICE_UNAVAILABLE,
            "Diagnostics temporarily unavailable",
        ),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn endpoint_requires_identity_and_has_no_public_read() {
        use axum::{body::Body, http::Request};
        use tower::ServiceExt;
        let db = sqlx::postgres::PgPoolOptions::new()
            .connect_lazy("postgres://test@127.0.0.1:1/unused").unwrap();
        let app = crate::app(AppState::new(db, crate::Settings::default()));
        let response = app.clone().oneshot(Request::builder().method("POST")
            .uri("/api/v1/collector/diagnostics").body(Body::from("{}")).unwrap()).await.unwrap();
        assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
        let response = app.clone().oneshot(Request::builder().method("POST")
            .uri("/api/v1/collector/diagnostics").body(Body::from(vec![b'x'; 300000])).unwrap()).await.unwrap();
        assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
        let response = app.oneshot(Request::builder().uri("/api/v1/collector/diagnostics")
            .body(Body::empty()).unwrap()).await.unwrap();
        assert_eq!(response.status(), StatusCode::METHOD_NOT_ALLOWED);
    }
    #[test]
    fn private_storage_idempotency_and_seven_day_retention() {
        let root = std::env::temp_dir().join(format!("diagnostics-test-{}", std::process::id()));
        let id = "0123456789abcdef0123456789abcdef";
        save(&root, 9, id, b"synthetic diagnostics").unwrap();
        save(&root, 9, id, b"synthetic diagnostics").unwrap();
        assert!(save(&root, 9, id, b"changed").is_err());
        let path = root.join("9").join(format!("{id}.json.gz"));
        cleanup(
            &root,
            SystemTime::now() + RETENTION - Duration::from_secs(60),
        )
        .unwrap();
        assert!(path.exists());
        cleanup(
            &root,
            SystemTime::now() + RETENTION + Duration::from_secs(1),
        )
        .unwrap();
        assert!(!path.exists());
        std::fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn rejects_path_traversal_and_unknown_fields() {
        let value = json!({"schema":1,"id":"../bad","version":"0.6.52","created_at":1,"kind":"manual","state":{},"files":{}});
        assert!(!serde_json::from_value::<Report>(value.clone())
            .unwrap()
            .valid());
        let mut extra = value;
        extra["token"] = json!("secret");
        assert!(serde_json::from_value::<Report>(extra).is_err());
    }
    #[test]
    fn screenshots_are_bounded_manual_attachments_only() {
        let mut value = json!({"schema":1,"id":"0123456789abcdef0123456789abcdef","version":"0.6.53","created_at":1,"kind":"manual","state":{},"files":{},"screenshot":"/9j/2Q=="});
        assert!(serde_json::from_value::<Report>(value.clone()).unwrap().valid());
        value["kind"] = json!("continuous");
        assert!(!serde_json::from_value::<Report>(value.clone()).unwrap().valid());
        value["kind"] = json!("manual");
        value["screenshot"] = json!("not an image");
        assert!(!serde_json::from_value::<Report>(value.clone()).unwrap().valid());
        value["screenshot"] = json!("a".repeat(1400001));
        assert!(!serde_json::from_value::<Report>(value).unwrap().valid());
    }
}

//! Caching for `/web/**`, in front of `ServeDir`.
//!
//! * `Cache-Control` by URL: content-hashed chunks and `?v=` URLs are
//!   immutable, images are kept a week, everything else (HTML, unversioned
//!   entry files) revalidates.
//! * A strong `ETag` from the file's contents, so a redeploy of an unchanged
//!   file answers 304 even though its modification time moved.
//! * Text files are answered from memory as br (quality 11, made in the
//!   background) or gzip (level 9), within `BUDGET` bytes in all.
//!
//! Anything else (directories, missing files, ranges, HEAD, odd paths) goes
//! to `ServeDir` unchanged and only gets the headers above.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::SystemTime;

use axum::{
    body::{Body, Bytes},
    extract::{Request, State},
    http::{header, HeaderMap, HeaderValue, Method, StatusCode},
    middleware::Next,
    response::{IntoResponse, Response},
};
use sha2::{Digest, Sha256};
use tokio::sync::OnceCell;

use crate::encoding::{self, Accepted, Coding};

const IMMUTABLE: &str = "public, max-age=31536000, immutable";
const IMAGES: &str = "public, max-age=604800, stale-while-revalidate=86400";
const REVALIDATE: &str = "no-cache";
/// Compressed copies kept, all files together; least recently used go first.
const BUDGET: usize = 64 << 20;
/// Larger text files are compressed per response instead.
const MAX_TEXT: u64 = 8 << 20;
/// Larger files get no ETag (they would be read whole to hash).
const MAX_HASHED: u64 = 64 << 20;

/// `relative`: the path below `/web/`.
pub(crate) fn cache_control(relative: &str, query: Option<&str>) -> &'static str {
    let name = relative.rsplit('/').next().unwrap_or_default();
    if name.ends_with(".html") {
        return REVALIDATE;
    }
    if relative
        .strip_prefix("react/chunks/")
        .is_some_and(|rest| !rest.contains('/') && hashed(rest))
    {
        return IMMUTABLE;
    }
    let versioned = query.is_some_and(|query| {
        query.split('&').any(|pair| {
            pair.strip_prefix("v=")
                .is_some_and(|v| !v.is_empty() && v != "dev")
        })
    });
    if versioned {
        IMMUTABLE
    } else if relative.starts_with("images/") {
        IMAGES
    } else {
        REVALIDATE
    }
}

/// Rollup's `[name]-[hash].ext`: an 8-character base64url hash.
fn hashed(file: &str) -> bool {
    let Some((stem, _)) = file.rsplit_once('.') else {
        return false;
    };
    let bytes = stem.as_bytes();
    bytes.len() > 9
        && bytes[bytes.len() - 9] == b'-'
        && bytes[bytes.len() - 8..]
            .iter()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_'))
}

/// Types as `ServeDir` (mime_guess) labels them, for the files kept compressed.
fn text_type(relative: &str) -> Option<&'static str> {
    let extension = relative.rsplit_once('.')?.1.to_ascii_lowercase();
    Some(match extension.as_str() {
        "js" => "text/javascript",
        "mjs" => "application/javascript",
        "css" => "text/css",
        "json" => "application/json",
        "map" | "txt" => "text/plain",
        "svg" => "image/svg+xml",
        "html" => "text/html",
        "webmanifest" => "application/manifest+json",
        _ => return None,
    })
}

/// Plain relative paths only; anything that needs decoding or could leave
/// the tree is left to `ServeDir`'s own checks.
fn file_path(root: &Path, relative: &str) -> Option<PathBuf> {
    let plain = relative.split('/').all(|segment| {
        !segment.is_empty()
            && segment != "."
            && segment != ".."
            && !segment.contains(['%', '\\', ':', '\0'])
    });
    plain.then(|| root.join(relative))
}

struct Text {
    kind: &'static str,
    gzip: Bytes,
    br: OnceCell<Bytes>,
}

struct Entry {
    tag: HeaderValue,
    modified: Option<SystemTime>,
    text: Option<Text>,
}

impl Entry {
    fn size(&self) -> usize {
        self.text
            .as_ref()
            .map_or(0, |t| t.gzip.len() + t.br.get().map_or(0, Bytes::len))
    }
}

struct Slot {
    len: u64,
    modified: Option<SystemTime>,
    used: AtomicU64,
    entry: OnceCell<Arc<Entry>>,
}

pub(crate) struct StaticFiles {
    root: PathBuf,
    slots: Mutex<HashMap<String, Arc<Slot>>>,
    clock: AtomicU64,
}

impl StaticFiles {
    pub(crate) fn new(root: &Path) -> Arc<Self> {
        Arc::new(Self {
            root: root.to_owned(),
            slots: Mutex::default(),
            clock: AtomicU64::new(0),
        })
    }

    /// The cached entry for an unchanged file (same length and mtime), else a
    /// fresh read. Only one request reads a given file.
    async fn entry(
        self: &Arc<Self>,
        relative: &str,
        path: PathBuf,
        meta: &std::fs::Metadata,
    ) -> Option<Arc<Entry>> {
        if meta.len() > MAX_HASHED {
            return None;
        }
        let modified = meta.modified().ok();
        let (slot, fresh) = {
            let mut slots = self.slots.lock().expect("static file cache");
            match slots.get(relative) {
                Some(slot) if slot.len == meta.len() && slot.modified == modified => {
                    (slot.clone(), false)
                }
                _ => {
                    let slot = Arc::new(Slot {
                        len: meta.len(),
                        modified,
                        used: AtomicU64::new(0),
                        entry: OnceCell::new(),
                    });
                    slots.insert(relative.to_owned(), slot.clone());
                    (slot, true)
                }
            }
        };
        slot.used.store(
            self.clock.fetch_add(1, Ordering::Relaxed),
            Ordering::Relaxed,
        );
        let kind = text_type(relative).filter(|_| meta.len() <= MAX_TEXT);
        let files = self.clone();
        let entry = slot
            .entry
            .get_or_try_init(|| async move {
                tokio::task::spawn_blocking(move || {
                    let data = std::fs::read(&path)?;
                    let digest = hex::encode(Sha256::digest(&data));
                    let tag =
                        HeaderValue::from_str(&format!("\"{}\"", &digest[..32])).expect("hex tag");
                    let text = kind.map(|kind| Text {
                        kind,
                        gzip: encoding::gzip(&data, 9).into(),
                        br: OnceCell::new(),
                    });
                    Ok::<_, std::io::Error>((
                        Arc::new(Entry {
                            tag,
                            modified,
                            text,
                        }),
                        data,
                    ))
                })
                .await
                .map_err(std::io::Error::other)?
                .map(|(entry, data)| {
                    if entry.text.is_some() {
                        // br at quality 11 takes about a second per megabyte: gzip
                        // answers until it is ready.
                        let background = entry.clone();
                        tokio::spawn(async move {
                            let text = background.text.as_ref().expect("text entry");
                            text.br.get_or_init(|| brotli(data)).await;
                            files.evict();
                        });
                    }
                    entry
                })
            })
            .await
            .ok()?
            .clone();
        if fresh {
            self.evict();
        }
        Some(entry)
    }

    fn evict(&self) {
        let mut slots = self.slots.lock().expect("static file cache");
        let size = |slot: &Slot| slot.entry.get().map_or(0, |e| e.size());
        let mut total: usize = slots.values().map(|s| size(s)).sum();
        while total > BUDGET {
            let Some(oldest) = slots
                .iter()
                .filter(|(_, s)| size(s) > 0)
                .min_by_key(|(_, s)| s.used.load(Ordering::Relaxed))
                .map(|(key, _)| key.clone())
            else {
                break;
            };
            if let Some(slot) = slots.remove(&oldest) {
                total -= size(&slot);
            }
        }
    }
}

async fn brotli(data: Vec<u8>) -> Bytes {
    tokio::task::spawn_blocking(move || Bytes::from(encoding::brotli(&data, 11)))
        .await
        .expect("brotli task")
}

/// `If-None-Match` names this tag (weak comparison, `*` too).
fn matches(headers: &HeaderMap, tag: &HeaderValue) -> bool {
    let tag = tag.to_str().unwrap_or_default();
    crate::api::not_modified(headers, tag)
}

fn not_modified_since(headers: &HeaderMap, modified: Option<SystemTime>) -> bool {
    let (Some(since), Some(modified)) = (
        headers
            .get(header::IF_MODIFIED_SINCE)
            .and_then(|v| v.to_str().ok())
            .and_then(|v| httpdate::parse_http_date(v).ok()),
        modified,
    ) else {
        return false;
    };
    // HTTP dates have whole seconds.
    modified
        .duration_since(since)
        .map_or(true, |later| later.as_secs() == 0)
}

fn set(headers: &mut HeaderMap, policy: &'static str, tag: Option<&HeaderValue>, text: bool) {
    headers.insert(header::CACHE_CONTROL, HeaderValue::from_static(policy));
    if let Some(tag) = tag {
        headers.insert(header::ETAG, tag.clone());
    }
    if text {
        let varies = headers.get_all(header::VARY).iter().any(|v| {
            v.to_str()
                .is_ok_and(|v| v.to_ascii_lowercase().contains("accept-encoding"))
        });
        if !varies {
            headers.append(header::VARY, HeaderValue::from_static("accept-encoding"));
        }
    }
}

pub(crate) async fn layer(
    State(files): State<Arc<StaticFiles>>,
    mut request: Request,
    next: Next,
) -> Response {
    let path = request.uri().path().to_owned();
    let Some(relative) = path.strip_prefix("/web/") else {
        return next.run(request).await;
    };
    let policy = cache_control(relative, request.uri().query());
    let method = request.method().clone();
    let mut entry = None;
    let mut compressible = false;
    if method == Method::GET || method == Method::HEAD {
        if let Some(file) = file_path(&files.root, relative) {
            if let Ok(meta) = tokio::fs::metadata(&file).await {
                if meta.is_file() {
                    compressible = text_type(relative).is_some();
                    entry = files.entry(relative, file, &meta).await;
                }
            }
        }
    }
    if let Some(entry) = &entry {
        let headers = request.headers();
        let fresh = if headers.contains_key(header::IF_NONE_MATCH) {
            matches(headers, &entry.tag)
        } else {
            not_modified_since(headers, entry.modified)
        };
        if fresh {
            let mut response = StatusCode::NOT_MODIFIED.into_response();
            set(
                response.headers_mut(),
                policy,
                Some(&entry.tag),
                compressible,
            );
            return response;
        }
        // The tag changed, so the date must not answer 304 either.
        request.headers_mut().remove(header::IF_MODIFIED_SINCE);
        let whole = method == Method::GET && !request.headers().contains_key(header::RANGE);
        if let Some(text) = entry.text.as_ref().filter(|_| whole) {
            let accepted = Accepted::from_headers(request.headers());
            let br = text
                .br
                .get()
                .filter(|_| accepted.preferred() == Some(Coding::Br));
            let chosen = match br {
                Some(br) => Some((Coding::Br, br.clone())),
                None if accepted.gzip > 0.0 => Some((Coding::Gzip, text.gzip.clone())),
                None => None,
            };
            if let Some((coding, body)) = chosen {
                let mut response = Response::new(Body::from(body));
                let headers = response.headers_mut();
                headers.insert(header::CONTENT_TYPE, HeaderValue::from_static(text.kind));
                headers.insert(header::CONTENT_ENCODING, coding.header());
                if let Some(date) = entry.modified {
                    if let Ok(value) = HeaderValue::from_str(&httpdate::fmt_http_date(date)) {
                        headers.insert(header::LAST_MODIFIED, value);
                    }
                }
                set(headers, policy, Some(&entry.tag), true);
                return response;
            }
        }
    }
    let mut response = next.run(request).await;
    if matches!(
        response.status(),
        StatusCode::OK | StatusCode::PARTIAL_CONTENT | StatusCode::NOT_MODIFIED
    ) {
        // `CompressionLayer` may compress a text file answered here, so its
        // tag is weak; the tag still revalidates (weak comparison).
        let tag = entry.as_ref().map(|e| match compressible {
            true => HeaderValue::from_str(&format!("W/{}", e.tag.to_str().unwrap_or_default()))
                .unwrap_or_else(|_| e.tag.clone()),
            false => e.tag.clone(),
        });
        set(response.headers_mut(), policy, tag.as_ref(), compressible);
    } else {
        response
            .headers_mut()
            .insert(header::CACHE_CONTROL, HeaderValue::from_static(REVALIDATE));
    }
    response
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cache_policy_follows_url_shape() {
        assert_eq!(
            cache_control("react/chunks/account-B-ZAcW7c.js", None),
            IMMUTABLE
        );
        assert_eq!(
            cache_control("react/chunks/app_shell-x_Yz09Ab.js", None),
            IMMUTABLE
        );
        assert_eq!(cache_control("react/chunks/plain.js", None), REVALIDATE);
        assert_eq!(
            cache_control("react/chunks/sub/a-B-ZAcW7c.js", None),
            REVALIDATE
        );
        assert_eq!(
            cache_control("react/app.js", Some("v=133bd615d20f1bd1")),
            IMMUTABLE
        );
        assert_eq!(
            cache_control("css/base.css", Some("x=1&v=133bd615d20f1bd1")),
            IMMUTABLE
        );
        assert_eq!(cache_control("react/app.js", Some("v=dev")), REVALIDATE);
        assert_eq!(cache_control("react/app.js", Some("v=")), REVALIDATE);
        assert_eq!(cache_control("react/app.js", Some("vv=1")), REVALIDATE);
        assert_eq!(cache_control("react/app.js", None), REVALIDATE);
        assert_eq!(
            cache_control("index.html", Some("v=133bd615d20f1bd1")),
            REVALIDATE
        );
        assert_eq!(cache_control("images/scenes/a.webp", None), IMAGES);
        assert_eq!(
            cache_control("images/scenes/a.webp", Some("v=2")),
            IMMUTABLE
        );
        assert_eq!(cache_control("js/app.js", None), REVALIDATE);
    }

    #[test]
    fn only_plain_paths_are_read_directly() {
        let root = Path::new("/srv/web");
        assert_eq!(
            file_path(root, "react/.vite/manifest.json"),
            Some(root.join("react/.vite/manifest.json"))
        );
        for odd in [
            "../x", "a/../b", "a//b", "a/", "%2e%2e/x", "a\\b", "c:x", "./a",
        ] {
            assert_eq!(file_path(root, odd), None, "{odd}");
        }
    }
}

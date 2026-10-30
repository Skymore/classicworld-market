//! VAPID key configuration, the push service allowlist and message delivery.

use std::io::Write as _;
use std::path::Path;
use std::time::Duration;

use anyhow::{bail, Context};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use url::{Host, Url};

use super::crypto::{self, VapidKey};

pub const DEFAULT_SUBJECT: &str = "https://mxd.ruit.me";
pub const ICON: &str = "/web/icons/icon-192.png";
const MAX_ENDPOINT: usize = 1024;
/// Push services of the browsers we support. Subscriptions elsewhere are
/// refused, so the server never sends requests to user-chosen hosts.
const PUSH_SERVICES: [&str; 4] = [
    "fcm.googleapis.com",
    "push.apple.com",
    "push.services.mozilla.com",
    "notify.windows.com",
];
/// RFC 8292 allows up to 24 hours; stay well inside it.
const JWT_LIFETIME: u64 = 12 * 3600;
/// Seconds a push service keeps an undelivered message.
const TTL_SECONDS: &str = "600";

/// What a push service did with one message.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Delivery {
    Sent,
    /// 404/410: the browser dropped the subscription.
    Gone,
    /// 429, 5xx or a network error: try again in a later round.
    Busy,
    /// Anything else, including redirects and refused endpoints.
    Failed,
}

/// The JSON the service worker receives.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct Message {
    pub title: String,
    pub body: String,
    pub url: String,
    pub tag: String,
    #[serde(default = "icon")]
    pub icon: String,
}

fn icon() -> String {
    ICON.to_owned()
}

impl Message {
    pub fn new(
        title: impl Into<String>,
        body: impl Into<String>,
        url: impl Into<String>,
        tag: impl Into<String>,
    ) -> Self {
        Self {
            title: title.into(),
            body: body.into(),
            url: url.into(),
            tag: tag.into(),
            icon: icon(),
        }
    }
}

/// A stored browser subscription.
pub struct Subscription<'a> {
    pub endpoint: &'a str,
    pub p256dh: &'a [u8],
    pub auth: &'a [u8],
}

/// A `push_subscriptions` row as the sender needs it.
#[derive(sqlx::FromRow)]
pub(super) struct Stored {
    pub id: i64,
    pub public_id: String,
    pub endpoint: String,
    pub p256dh: Vec<u8>,
    pub auth: Vec<u8>,
    pub lang: String,
}

impl Stored {
    /// Columns of a `push_subscriptions p` select.
    pub const COLUMNS: &'static str = "p.id,p.public_id,p.endpoint,p.p256dh,p.auth,p.lang";

    pub fn target(&self) -> Subscription<'_> {
        Subscription {
            endpoint: &self.endpoint,
            p256dh: &self.p256dh,
            auth: &self.auth,
        }
    }
}

#[derive(Debug, Clone)]
enum Endpoints {
    PushServices,
    /// Tests only: exactly one plain-HTTP loopback origin and nothing else.
    Loopback(String),
}

impl Endpoints {
    fn check(&self, raw: &str) -> Option<Url> {
        if raw.is_empty() || raw.len() > MAX_ENDPOINT || !raw.bytes().all(|b| b.is_ascii_graphic())
        {
            return None;
        }
        let url = Url::parse(raw).ok()?;
        if !url.username().is_empty() || url.password().is_some() {
            return None;
        }
        let allowed = match self {
            Self::PushServices => {
                url.scheme() == "https"
                    && url.port().is_none()
                    && matches!(url.host(), Some(Host::Domain(host)) if PUSH_SERVICES
                        .iter()
                        .any(|s| host == *s || host.strip_suffix(s).is_some_and(|p| p.ends_with('.'))))
            }
            Self::Loopback(origin) => {
                url.scheme() == "http" && url.origin().ascii_serialization() == *origin
            }
        };
        allowed.then_some(url)
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct KeyFile {
    private_key: String,
    #[serde(default)]
    subject: Option<String>,
}

pub struct WebPush {
    key: VapidKey,
    subject: String,
    endpoints: Endpoints,
    client: reqwest::Client,
}

fn client() -> reqwest::Client {
    reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(Duration::from_secs(10))
        .build()
        .expect("HTTP client")
}

fn decode_key(value: &str) -> anyhow::Result<VapidKey> {
    let bytes = URL_SAFE_NO_PAD
        .decode(value.trim().trim_end_matches('='))
        .ok()
        .filter(|b| b.len() == 32)
        .context("Invalid Web Push private key")?;
    VapidKey::from_private(&bytes).map_err(|_| anyhow::anyhow!("Invalid Web Push private key"))
}

fn valid_subject(subject: &str) -> bool {
    (subject.starts_with("https://") || subject.starts_with("mailto:"))
        && subject.len() <= 256
        && subject.bytes().all(|b| b.is_ascii_graphic())
}

fn read_key_file(path: &Path) -> anyhow::Result<KeyFile> {
    let bytes = std::fs::read(path).context("Could not read the Web Push configuration")?;
    serde_json::from_slice(&bytes).map_err(|_| anyhow::anyhow!("Invalid Web Push configuration"))
}

/// Writes a new key without ever replacing a file another process wrote first.
fn create_key_file(path: &Path) -> anyhow::Result<KeyFile> {
    let key = VapidKey::generate();
    let private_key = URL_SAFE_NO_PAD.encode(key.private_bytes());
    let content = serde_json::to_vec_pretty(&serde_json::json!({
        "private_key": private_key, "subject": DEFAULT_SUBJECT,
    }))?;
    if let Some(parent) = path.parent().filter(|p| !p.as_os_str().is_empty()) {
        std::fs::create_dir_all(parent)
            .context("Could not create the Web Push configuration folder")?;
    }
    let pending = path.with_extension(format!("pending-{}", std::process::id()));
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    std::os::unix::fs::OpenOptionsExt::mode(&mut options, 0o600);
    let written = options.open(&pending).and_then(|mut file| {
        file.write_all(&content)?;
        file.sync_all()
    });
    let linked = written.and_then(|()| std::fs::hard_link(&pending, path));
    let _ = std::fs::remove_file(&pending);
    match linked {
        Ok(()) => Ok(KeyFile {
            private_key,
            subject: Some(DEFAULT_SUBJECT.into()),
        }),
        Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => read_key_file(path),
        Err(_) => bail!("Could not write the Web Push configuration"),
    }
}

impl WebPush {
    pub fn new(key: VapidKey, subject: impl Into<String>) -> Self {
        Self {
            key,
            subject: subject.into(),
            endpoints: Endpoints::PushServices,
            client: client(),
        }
    }

    /// Accepts only `origin` (e.g. `http://127.0.0.1:41234`), never a real push
    /// service, so a test cannot reach the network. No configuration enables it.
    pub fn for_loopback_tests(key: VapidKey, origin: &str) -> Self {
        assert!(
            origin.starts_with("http://127.0.0.1:"),
            "loopback origin only"
        );
        Self {
            endpoints: Endpoints::Loopback(origin.to_owned()),
            ..Self::new(key, DEFAULT_SUBJECT)
        }
    }

    /// `WEB_PUSH_PRIVATE_KEY` (base64url, 32 bytes) wins over the key in the
    /// `WEB_PUSH_CONFIG` file; a configured but missing file gets a new key.
    /// Neither set: push is off.
    pub fn from_env() -> anyhow::Result<Option<Self>> {
        let private = std::env::var("WEB_PUSH_PRIVATE_KEY")
            .ok()
            .filter(|v| !v.trim().is_empty());
        let path = std::env::var_os("WEB_PUSH_CONFIG").map(std::path::PathBuf::from);
        Self::from_sources(private.as_deref(), path.as_deref())
    }

    pub fn from_sources(
        private: Option<&str>,
        path: Option<&Path>,
    ) -> anyhow::Result<Option<Self>> {
        let file = match path {
            None if private.is_none() => return Ok(None),
            None => None,
            Some(path) if path.exists() => Some(read_key_file(path)?),
            // An environment key never writes a file.
            Some(_) if private.is_some() => None,
            Some(path) => Some(create_key_file(path)?),
        };
        let key = match private {
            Some(value) => decode_key(value)?,
            None => decode_key(&file.as_ref().expect("key file").private_key)?,
        };
        let subject = file
            .and_then(|f| f.subject)
            .unwrap_or_else(|| DEFAULT_SUBJECT.to_owned());
        if !valid_subject(&subject) {
            bail!("Invalid Web Push subject");
        }
        Ok(Some(Self::new(key, subject)))
    }

    /// base64url of the 65-byte uncompressed application server key.
    pub fn public_key(&self) -> String {
        self.key.public_base64()
    }

    pub fn endpoint_allowed(&self, endpoint: &str) -> bool {
        self.endpoints.check(endpoint).is_some()
    }

    pub async fn send(&self, target: &Subscription<'_>, message: &Message) -> Delivery {
        let Some(url) = self.endpoints.check(target.endpoint) else {
            return Delivery::Failed;
        };
        let Ok(receiver) = crypto::subscriber_key(target.p256dh) else {
            return Delivery::Failed;
        };
        let payload = serde_json::to_vec(message).expect("message JSON");
        let Ok(body) = crypto::encrypt(&payload, &receiver, target.auth) else {
            return Delivery::Failed;
        };
        let expires = crate::unix_now() as u64 + JWT_LIFETIME;
        let audience = url.origin().ascii_serialization();
        let response = self
            .client
            .post(url)
            .header("TTL", TTL_SECONDS)
            .header("Urgency", "normal")
            .header("Topic", topic(&message.tag))
            .header("Content-Encoding", "aes128gcm")
            .header("Content-Type", "application/octet-stream")
            .header(
                "Authorization",
                self.key.authorization(&audience, &self.subject, expires),
            )
            .body(body)
            .send()
            .await;
        match response.map(|r| r.status().as_u16()) {
            Ok(200..=299) => Delivery::Sent,
            Ok(404 | 410) => Delivery::Gone,
            Ok(429 | 500..=599) | Err(_) => Delivery::Busy,
            Ok(_) => Delivery::Failed,
        }
    }
}

/// RFC 8030 §5.4: at most 32 base64url characters. A newer message with the
/// same topic replaces an undelivered older one.
pub fn topic(tag: &str) -> String {
    URL_SAFE_NO_PAD.encode(Sha256::digest(tag.as_bytes()))[..32].to_owned()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn endpoints_must_be_https_push_services() {
        let push = WebPush::new(VapidKey::generate(), DEFAULT_SUBJECT);
        for ok in [
            "https://fcm.googleapis.com/fcm/send/abc:APA91b-x_y",
            "https://web.push.apple.com/QGr0Xyz",
            "https://updates.push.services.mozilla.com/wpush/v2/gAAAA",
            "https://wns2-par02p.notify.windows.com/w/?token=AwYAAAB",
            "https://fcm.googleapis.com:443/fcm/send/abc",
        ] {
            assert!(push.endpoint_allowed(ok), "{ok}");
        }
        let long = format!("https://fcm.googleapis.com/{}", "a".repeat(1000));
        for bad in [
            "http://fcm.googleapis.com/fcm/send/abc",
            "https://fcm.googleapis.com.evil.example/x",
            "https://evilfcm.googleapis.com/x",
            "https://evilpush.apple.com/x",
            "https://fcm.googleapis.com:8443/x",
            "https://user@fcm.googleapis.com/x",
            "https://127.0.0.1/x",
            "https://[::1]/x",
            "http://127.0.0.1:9/push",
            "https://fcm.googleapis.com/a b",
            "javascript:alert(1)",
            "",
            long.as_str(),
        ] {
            assert!(!push.endpoint_allowed(bad), "{bad}");
        }
        let test = WebPush::for_loopback_tests(VapidKey::generate(), "http://127.0.0.1:41234");
        assert!(test.endpoint_allowed("http://127.0.0.1:41234/push/a"));
        assert!(!test.endpoint_allowed("http://127.0.0.1:41235/push/a"));
        assert!(!test.endpoint_allowed("https://fcm.googleapis.com/fcm/send/abc"));
    }

    #[test]
    fn topics_fit_the_push_service_limit() {
        for tag in ["watch-1452003", "watch-summary", &"x".repeat(500)] {
            let t = topic(tag);
            assert_eq!(t.len(), 32);
            assert!(t
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_'));
        }
        assert_ne!(topic("watch-1"), topic("watch-2"));
    }

    #[test]
    fn configuration_generates_a_private_key_file_once_and_env_key_wins() {
        let folder = std::env::temp_dir().join(format!(
            "cwm-push-{}",
            crate::auth::new_credentials().public_id
        ));
        let path = folder.join("shared_data/web_push.json");
        assert!(WebPush::from_sources(None, None).unwrap().is_none());
        let created = WebPush::from_sources(None, Some(&path)).unwrap().unwrap();
        let saved: serde_json::Value =
            serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
        assert_eq!(saved["subject"], DEFAULT_SUBJECT);
        assert_eq!(
            URL_SAFE_NO_PAD
                .decode(saved["private_key"].as_str().unwrap())
                .unwrap()
                .len(),
            32
        );
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                std::fs::metadata(&path).unwrap().permissions().mode() & 0o777,
                0o600
            );
        }
        let again = WebPush::from_sources(None, Some(&path)).unwrap().unwrap();
        assert_eq!(again.public_key(), created.public_key());
        assert_eq!(
            URL_SAFE_NO_PAD.decode(created.public_key()).unwrap().len(),
            65
        );
        let other = URL_SAFE_NO_PAD.encode(VapidKey::generate().private_bytes());
        let env = WebPush::from_sources(Some(&other), Some(&path))
            .unwrap()
            .unwrap();
        assert_ne!(env.public_key(), created.public_key());
        let missing = folder.join("not-created.json");
        assert!(WebPush::from_sources(Some(&other), Some(&missing))
            .unwrap()
            .is_some());
        assert!(!missing.exists(), "an environment key never writes a file");
        assert!(WebPush::from_sources(Some("short"), None).is_err());
        std::fs::write(&path, br#"{"private_key":"x","extra":1}"#).unwrap();
        assert!(WebPush::from_sources(None, Some(&path)).is_err());
        std::fs::write(
            &path,
            format!(r#"{{"private_key":"{other}","subject":"http://x"}}"#),
        )
        .unwrap();
        assert!(WebPush::from_sources(None, Some(&path)).is_err());
        std::fs::remove_dir_all(folder).unwrap();
    }
}

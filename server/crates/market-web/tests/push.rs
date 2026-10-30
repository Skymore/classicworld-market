//! Web Push against a local fake push service on 127.0.0.1. Push states here
//! accept only that origin, so no test can send a request to a real service.
mod common;

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use axum::{
    body::{Body, Bytes},
    extract::{Path, State},
    http::{header, HeaderMap, Request, StatusCode},
    response::{IntoResponse, Response},
    routing::post,
    Router,
};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use common::TestDb;
use http_body_util::BodyExt;
use market_web::{
    app,
    push::{self, crypto, Message, WebPush},
    unix_now, AppState, Settings,
};
use serde_json::{json, Value};
use tower::ServiceExt;

const PASSWORD: &str = "a long unique maple passphrase";
static PASSWORDS: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

// ---- HTTP helpers -----------------------------------------------------------

struct Web {
    cookie: String,
    csrf: String,
}

async fn send(
    s: &AppState,
    method: &str,
    path: &str,
    headers: &[(&str, String)],
    body: Value,
) -> (StatusCode, Value) {
    let mut req = Request::builder()
        .method(method)
        .uri(path)
        .header("content-type", "application/json");
    for (k, v) in headers {
        req = req.header(*k, v);
    }
    let body = if body.is_null() {
        Body::empty()
    } else {
        Body::from(body.to_string())
    };
    let response = app(s.clone())
        .oneshot(req.body(body).unwrap())
        .await
        .unwrap();
    let status = response.status();
    let bytes = response.into_body().collect().await.unwrap().to_bytes();
    (
        status,
        serde_json::from_slice(&bytes).unwrap_or(Value::Null),
    )
}
fn browser(w: &Web) -> Vec<(&'static str, String)> {
    vec![
        ("cookie", w.cookie.clone()),
        ("origin", "https://mxd.ruit.me".into()),
        ("x-csrf-token", w.csrf.clone()),
    ]
}
async fn web(s: &AppState, method: &str, path: &str, w: &Web, body: Value) -> (StatusCode, Value) {
    send(s, method, path, &browser(w), body).await
}
async fn cookie_of(response: Response) -> (String, Value) {
    assert_eq!(response.status(), StatusCode::OK);
    let cookie = response.headers()["set-cookie"]
        .to_str()
        .unwrap()
        .split(';')
        .next()
        .unwrap()
        .to_string();
    let bytes = response.into_body().collect().await.unwrap().to_bytes();
    (cookie, serde_json::from_slice(&bytes).unwrap())
}
async fn signed_in(s: &AppState, path: &str, body: Value) -> (Web, Value) {
    let _guard = PASSWORDS.lock().await;
    let response = app(s.clone())
        .oneshot(
            Request::post(path)
                .header("content-type", "application/json")
                .header("origin", "https://mxd.ruit.me")
                .body(Body::from(body.to_string()))
                .unwrap(),
        )
        .await
        .unwrap();
    let (cookie, answer) = cookie_of(response).await;
    let me = send(
        s,
        "GET",
        "/api/v1/account",
        &[("cookie", cookie.clone())],
        Value::Null,
    )
    .await
    .1;
    (
        Web {
            cookie,
            csrf: me["csrf"].as_str().unwrap().to_owned(),
        },
        answer,
    )
}
async fn signup(s: &AppState, name: &str) -> Web {
    signed_in(
        s,
        "/api/v1/account/register",
        json!({"username": name, "password": PASSWORD}),
    )
    .await
    .0
}

// ---- Browser side and fake push service --------------------------------------

/// A browser's push subscription keys; it alone can decrypt its messages.
struct Device {
    secret: p256::SecretKey,
    auth: [u8; 16],
    endpoint: String,
}

impl Device {
    fn new(endpoint: impl Into<String>) -> Self {
        let mut auth = [0u8; 16];
        getrandom::getrandom(&mut auth).unwrap();
        Self {
            secret: crypto::random_secret(),
            auth,
            endpoint: endpoint.into(),
        }
    }
    fn subscription(&self, label: &str, lang: &str) -> Value {
        json!({"endpoint": self.endpoint, "expirationTime": null, "label": label, "lang": lang,
            "keys": {"p256dh": URL_SAFE_NO_PAD.encode(crypto::encode_public(&self.secret.public_key())),
                     "auth": URL_SAFE_NO_PAD.encode(self.auth)}})
    }
    fn open(&self, body: &[u8]) -> Message {
        serde_json::from_slice(&crypto::decrypt(body, &self.secret, &self.auth).unwrap()).unwrap()
    }
}

struct Delivered {
    name: String,
    headers: HeaderMap,
    body: Vec<u8>,
}

#[derive(Clone, Default)]
struct FakeService {
    received: Arc<Mutex<Vec<Delivered>>>,
    statuses: Arc<Mutex<HashMap<String, u16>>>,
}

async fn receive(
    State(fake): State<FakeService>,
    Path(name): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let status = fake
        .statuses
        .lock()
        .unwrap()
        .get(&name)
        .copied()
        .unwrap_or(201);
    fake.received.lock().unwrap().push(Delivered {
        name,
        headers,
        body: body.to_vec(),
    });
    if status == 307 {
        return (
            StatusCode::TEMPORARY_REDIRECT,
            [(header::LOCATION, "/push/redirected")],
        )
            .into_response();
    }
    StatusCode::from_u16(status).unwrap().into_response()
}

impl FakeService {
    async fn start() -> (Self, String) {
        let fake = Self::default();
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let origin = format!("http://{}", listener.local_addr().unwrap());
        let router = Router::new()
            .route("/push/{name}", post(receive))
            .with_state(fake.clone());
        tokio::spawn(async move { axum::serve(listener, router).await.unwrap() });
        (fake, origin)
    }
    fn status(&self, name: &str, status: u16) {
        self.statuses.lock().unwrap().insert(name.into(), status);
    }
    fn take(&self) -> Vec<Delivered> {
        std::mem::take(&mut *self.received.lock().unwrap())
    }
}

/// Checks the RFC 8030/8292 headers and returns the decrypted message.
fn verify(delivered: &Delivered, device: &Device, origin: &str, public_key: &str) -> Message {
    use jsonwebtoken::{decode, Algorithm, DecodingKey, Validation};
    let header = |name: &str| delivered.headers[name].to_str().unwrap().to_owned();
    assert_eq!(header("ttl"), "600");
    assert_eq!(header("urgency"), "normal");
    assert_eq!(header("content-encoding"), "aes128gcm");
    let auth = header("authorization");
    let (token, key) = auth
        .strip_prefix("vapid t=")
        .unwrap()
        .split_once(", k=")
        .unwrap();
    assert_eq!(key, public_key);
    let point = URL_SAFE_NO_PAD.decode(key).unwrap();
    let verifier = DecodingKey::from_ec_components(
        &URL_SAFE_NO_PAD.encode(&point[1..33]),
        &URL_SAFE_NO_PAD.encode(&point[33..]),
    )
    .unwrap();
    let mut rules = Validation::new(Algorithm::ES256);
    rules.set_audience(&[origin]);
    let claims = decode::<Value>(token, &verifier, &rules).unwrap().claims;
    assert_eq!(claims["sub"], push::DEFAULT_SUBJECT);
    assert!(claims["exp"].as_f64().unwrap() <= unix_now() + 12.0 * 3600.0 + 5.0);
    let message = device.open(&delivered.body);
    assert_eq!(header("topic"), push::topic(&message.tag));
    assert_eq!(message.icon, "/web/icons/icon-192.png");
    message
}

fn loopback_state(db: &TestDb, origin: &str) -> (AppState, String) {
    let mut s = AppState::new(db.pool.clone(), Settings::default());
    let push = WebPush::for_loopback_tests(crypto::VapidKey::generate(), origin);
    let key = push.public_key();
    s.push = Some(Arc::new(push));
    (s, key)
}

async fn subscribe(s: &AppState, w: &Web, device: &Device, label: &str, lang: &str) -> String {
    let (status, body) = web(
        s,
        "POST",
        "/api/v1/account/push/subscribe",
        w,
        device.subscription(label, lang),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    body["id"].as_str().unwrap().to_owned()
}

async fn listed(s: &AppState, w: &Web) -> Vec<Value> {
    let (status, body) = web(s, "GET", "/api/v1/account/push", w, Value::Null).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    body["subscriptions"].as_array().unwrap().clone()
}

async fn stored(db: &TestDb) -> i64 {
    sqlx::query_scalar("SELECT count(*) FROM push_subscriptions")
        .fetch_one(&db.pool)
        .await
        .unwrap()
}

// ---- Endpoints ----------------------------------------------------------------

#[tokio::test]
async fn push_off_reports_disabled_and_refuses_writes() {
    let Some(db) = TestDb::new().await else {
        return;
    };
    let s = AppState::new(db.pool.clone(), Settings::default());
    assert_eq!(
        send(&s, "GET", "/api/v1/push/config", &[], Value::Null).await,
        (StatusCode::OK, json!({"enabled": false}))
    );
    assert_eq!(
        send(&s, "GET", "/api/v1/account/push", &[], Value::Null).await,
        (StatusCode::UNAUTHORIZED, json!({"error": "login_required"}))
    );
    let w = signup(&s, "push_off").await;
    let device = Device::new("https://fcm.googleapis.com/fcm/send/off");
    for path in [
        "/api/v1/account/push/subscribe",
        "/api/v1/account/push/test",
    ] {
        let (status, body) = web(
            &s,
            "POST",
            path,
            &w,
            device.subscription("Android Chrome", "zh"),
        )
        .await;
        assert_eq!(
            (status, body),
            (
                StatusCode::SERVICE_UNAVAILABLE,
                json!({"error": "push_unavailable"})
            )
        );
    }
    assert_eq!(
        web(
            &s,
            "POST",
            "/api/v1/account/push/unsubscribe",
            &w,
            json!({"id": "x"})
        )
        .await,
        (StatusCode::OK, json!({"ok": true}))
    );
    assert_eq!(listed(&s, &w).await, Vec::<Value>::new());
    db.close().await;
}

#[tokio::test]
async fn subscriptions_check_endpoint_keys_and_ownership() {
    let Some(db) = TestDb::new().await else {
        return;
    };
    let mut s = AppState::new(db.pool.clone(), Settings::default());
    // Production allowlist; this test never sends, so real hosts are only stored.
    s.push = Some(Arc::new(WebPush::new(
        crypto::VapidKey::generate(),
        push::DEFAULT_SUBJECT,
    )));
    let (status, config) = send(&s, "GET", "/api/v1/push/config", &[], Value::Null).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(config["enabled"], true);
    let key = URL_SAFE_NO_PAD
        .decode(config["public_key"].as_str().unwrap())
        .unwrap();
    assert_eq!((key.len(), key[0]), (65, 4));

    let w = signup(&s, "push_owner").await;
    let phone = Device::new("https://fcm.googleapis.com/fcm/send/phone:APA91b");
    let anonymous = send(
        &s,
        "POST",
        "/api/v1/account/push/subscribe",
        &[("origin", "https://mxd.ruit.me".into())],
        phone.subscription("x", "zh"),
    )
    .await;
    assert_eq!(
        anonymous,
        (StatusCode::UNAUTHORIZED, json!({"error": "login_required"}))
    );
    let no_csrf = send(
        &s,
        "POST",
        "/api/v1/account/push/subscribe",
        &[
            ("cookie", w.cookie.clone()),
            ("origin", "https://mxd.ruit.me".into()),
        ],
        phone.subscription("x", "zh"),
    )
    .await;
    assert_eq!(no_csrf.0, StatusCode::FORBIDDEN);

    let id = subscribe(&s, &w, &phone, " Android Chrome ", "zh").await;
    assert_eq!(
        subscribe(&s, &w, &phone, "Android Chrome", "en").await,
        id,
        "one row per endpoint"
    );
    let rows = listed(&s, &w).await;
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0]["id"], id);
    assert_eq!(rows[0]["label"], "Android Chrome");
    assert_eq!(rows[0]["lang"], "en");
    assert!(rows[0]["created_at"].is_string());
    assert!(rows[0]["last_sent_at"].is_null());
    for endpoint in [
        "https://web.push.apple.com/QGr",
        "https://updates.push.services.mozilla.com/wpush/v2/x",
        "https://db5p.notify.windows.com/w/?token=x",
    ] {
        subscribe(&s, &w, &Device::new(endpoint), "", "zh").await;
    }

    let valid = phone.subscription("Android Chrome", "zh");
    let mut off_curve = URL_SAFE_NO_PAD
        .decode(valid["keys"]["p256dh"].as_str().unwrap())
        .unwrap();
    off_curve[64] ^= 1;
    let invalid = [
        ("endpoint", json!("http://fcm.googleapis.com/fcm/send/x")),
        (
            "endpoint",
            json!("https://fcm.googleapis.com.evil.example/x"),
        ),
        ("endpoint", json!("https://127.0.0.1/push")),
        (
            "endpoint",
            json!(format!("https://fcm.googleapis.com/{}", "a".repeat(1000))),
        ),
        ("p256dh", json!(URL_SAFE_NO_PAD.encode([4u8; 64]))),
        ("p256dh", json!(URL_SAFE_NO_PAD.encode(off_curve))),
        ("auth", json!(URL_SAFE_NO_PAD.encode([1u8; 15]))),
        ("label", json!("x".repeat(41))),
        ("label", json!("tab\tname")),
        ("lang", json!("fr")),
    ];
    for (field, value) in invalid {
        let mut body = valid.clone();
        if ["p256dh", "auth"].contains(&field) {
            body["keys"][field] = value;
        } else {
            body[field] = value;
        }
        let answer = web(&s, "POST", "/api/v1/account/push/subscribe", &w, body).await;
        assert_eq!(
            answer,
            (StatusCode::BAD_REQUEST, json!({"error": "invalid_request"})),
            "{field}"
        );
    }
    let missing_keys = web(
        &s,
        "POST",
        "/api/v1/account/push/subscribe",
        &w,
        json!({"endpoint": phone.endpoint}),
    )
    .await;
    assert_eq!(
        missing_keys,
        (StatusCode::BAD_REQUEST, json!({"error": "invalid_request"}))
    );

    // At most ten per account; the oldest goes first.
    for n in 0..8 {
        subscribe(
            &s,
            &w,
            &Device::new(format!("https://fcm.googleapis.com/fcm/send/extra{n}")),
            "",
            "zh",
        )
        .await;
    }
    let rows = listed(&s, &w).await;
    assert_eq!(rows.len(), 10);
    assert!(
        rows.iter().all(|r| r["id"] != id),
        "the oldest subscription was removed"
    );
    let first = subscribe(&s, &w, &phone, "Android Chrome", "zh").await;
    assert_ne!(first, id);

    // Another account on the same browser takes the endpoint over.
    let other = signup(&s, "push_other").await;
    let moved = subscribe(&s, &other, &phone, "iPhone", "zh").await;
    assert_ne!(moved, first);
    assert!(listed(&s, &w).await.iter().all(|r| r["id"] != first));
    assert_eq!(listed(&s, &other).await.len(), 1);

    // Unsubscribe only touches the caller's own rows.
    let ok = (StatusCode::OK, json!({"ok": true}));
    assert_eq!(
        web(
            &s,
            "POST",
            "/api/v1/account/push/unsubscribe",
            &w,
            json!({"id": moved})
        )
        .await,
        ok
    );
    assert_eq!(listed(&s, &other).await.len(), 1);
    assert_eq!(
        web(
            &s,
            "POST",
            "/api/v1/account/push/unsubscribe",
            &w,
            json!({})
        )
        .await
        .0,
        StatusCode::BAD_REQUEST
    );
    let mine = listed(&s, &w).await;
    assert_eq!(
        web(
            &s,
            "POST",
            "/api/v1/account/push/unsubscribe",
            &w,
            json!({"id": mine[0]["id"]})
        )
        .await,
        ok
    );
    assert_eq!(
        web(
            &s,
            "POST",
            "/api/v1/account/push/unsubscribe",
            &w,
            json!({"endpoint": "https://web.push.apple.com/QGr"})
        )
        .await,
        ok
    );
    assert_eq!(listed(&s, &w).await.len(), 8);
    assert_eq!(
        web(
            &s,
            "POST",
            "/api/v1/account/push/unsubscribe",
            &other,
            json!({"endpoint": phone.endpoint})
        )
        .await,
        ok
    );
    assert!(listed(&s, &other).await.is_empty());
    db.close().await;
}

#[tokio::test]
async fn test_push_delivers_encrypted_and_reports_expiry_and_failures() {
    let Some(db) = TestDb::new().await else {
        return;
    };
    let (fake, origin) = FakeService::start().await;
    let (s, key) = loopback_state(&db, &origin);
    let w = signup(&s, "push_tester").await;
    let real = WebPush::new(crypto::VapidKey::generate(), push::DEFAULT_SUBJECT);
    assert!(
        !real.endpoint_allowed(&format!("{origin}/push/zh")),
        "loopback is never allowed in production"
    );

    let zh = Device::new(format!("{origin}/push/zh"));
    let en = Device::new(format!("{origin}/push/en"));
    let zh_id = subscribe(&s, &w, &zh, "Android Chrome", "zh").await;
    let en_id = subscribe(&s, &w, &en, "Windows Edge", "en").await;
    assert_eq!(
        web(
            &s,
            "POST",
            "/api/v1/account/push/test",
            &w,
            json!({"id": zh_id})
        )
        .await,
        (StatusCode::OK, json!({"ok": true}))
    );
    assert_eq!(
        web(
            &s,
            "POST",
            "/api/v1/account/push/test",
            &w,
            json!({"id": en_id})
        )
        .await,
        (StatusCode::OK, json!({"ok": true}))
    );
    let delivered = fake.take();
    assert_eq!(delivered.len(), 2);
    assert_eq!(
        verify(&delivered[0], &zh, &origin, &key),
        Message::new("测试推送", "推送已开启", "/watch", "push-test")
    );
    assert_eq!(
        verify(&delivered[1], &en, &origin, &key).body,
        "Push notifications are on"
    );
    assert!(listed(&s, &w)
        .await
        .iter()
        .all(|r| r["last_sent_at"].is_string()));

    // Three tests per subscription per minute.
    for _ in 0..2 {
        assert_eq!(
            web(
                &s,
                "POST",
                "/api/v1/account/push/test",
                &w,
                json!({"id": zh_id})
            )
            .await
            .0,
            StatusCode::OK
        );
    }
    assert_eq!(
        web(
            &s,
            "POST",
            "/api/v1/account/push/test",
            &w,
            json!({"id": zh_id})
        )
        .await,
        (
            StatusCode::TOO_MANY_REQUESTS,
            json!({"error": "rate_limited"})
        )
    );

    let failing = Device::new(format!("{origin}/push/broken"));
    let failing_id = subscribe(&s, &w, &failing, "", "zh").await;
    for status in [500, 429, 400, 307] {
        fake.status("broken", status);
        let s = AppState {
            limiter: Arc::default(),
            ..s.clone()
        };
        assert_eq!(
            web(
                &s,
                "POST",
                "/api/v1/account/push/test",
                &w,
                json!({"id": failing_id})
            )
            .await,
            (StatusCode::BAD_GATEWAY, json!({"error": "push_failed"})),
            "{status}"
        );
    }
    assert!(
        fake.take().iter().all(|d| d.name != "redirected"),
        "redirects are not followed"
    );

    fake.status("en", 410);
    assert_eq!(
        web(
            &s,
            "POST",
            "/api/v1/account/push/test",
            &w,
            json!({"id": en_id})
        )
        .await,
        (StatusCode::GONE, json!({"error": "push_expired"}))
    );
    assert!(
        listed(&s, &w).await.iter().all(|r| r["id"] != en_id),
        "expired subscription removed"
    );
    assert_eq!(
        web(
            &s,
            "POST",
            "/api/v1/account/push/test",
            &w,
            json!({"id": en_id})
        )
        .await,
        (StatusCode::GONE, json!({"error": "push_expired"}))
    );
    assert_eq!(
        web(&s, "POST", "/api/v1/account/push/test", &w, json!({}))
            .await
            .0,
        StatusCode::BAD_REQUEST
    );
    db.close().await;
}

#[tokio::test]
async fn subscriptions_end_with_their_session() {
    let Some(db) = TestDb::new().await else {
        return;
    };
    let (_fake, origin) = FakeService::start().await;
    let (s, _) = loopback_state(&db, &origin);
    let device = |name: &str| Device::new(format!("{origin}/push/{name}"));

    let w = signup(&s, "push_logout").await;
    subscribe(&s, &w, &device("logout"), "", "zh").await;
    assert_eq!(
        web(&s, "POST", "/api/v1/account/logout", &w, Value::Null)
            .await
            .0,
        StatusCode::OK
    );
    assert_eq!(stored(&db).await, 0, "logout");

    let (a, _) = signed_in(
        &s,
        "/api/v1/account/login",
        json!({"username": "push_logout", "password": PASSWORD}),
    )
    .await;
    let (b, _) = signed_in(
        &s,
        "/api/v1/account/login",
        json!({"username": "push_logout", "password": PASSWORD}),
    )
    .await;
    subscribe(&s, &a, &device("a"), "", "zh").await;
    subscribe(&s, &b, &device("b"), "", "zh").await;
    let _guard = PASSWORDS.lock().await;
    let everywhere = web(
        &s,
        "POST",
        "/api/v1/account/logout-all",
        &a,
        json!({"current_password": PASSWORD}),
    )
    .await;
    drop(_guard);
    assert_eq!(everywhere.0, StatusCode::OK);
    assert_eq!(stored(&db).await, 0, "sign out everywhere");

    let (registered, answer) = signed_in(
        &s,
        "/api/v1/account/register",
        json!({"username": "push_password", "password": PASSWORD}),
    )
    .await;
    subscribe(&s, &registered, &device("password"), "", "zh").await;
    let _guard = PASSWORDS.lock().await;
    let changed = web(&s, "POST", "/api/v1/account/password", &registered,
        json!({"username": "push_password", "password": "another long maple passphrase", "current_password": PASSWORD})).await;
    drop(_guard);
    assert_eq!(changed.0, StatusCode::OK, "{}", changed.1);
    assert_eq!(stored(&db).await, 0, "password change");

    let (again, _) = signed_in(
        &s,
        "/api/v1/account/login",
        json!({"username": "push_password", "password": "another long maple passphrase"}),
    )
    .await;
    subscribe(&s, &again, &device("recover"), "", "zh").await;
    let code = changed.1["recovery_code"]
        .as_str()
        .unwrap_or(answer["recovery_code"].as_str().unwrap())
        .to_owned();
    let (_, recovered) = signed_in(
        &s,
        "/api/v1/account/recover",
        json!({"username": "push_password", "recovery_code": code, "password": PASSWORD}),
    )
    .await;
    assert_eq!(recovered["ok"], true);
    assert_eq!(stored(&db).await, 0, "password recovery");

    let expiring = signup(&s, "push_expiry").await;
    subscribe(&s, &expiring, &device("expiry"), "", "zh").await;
    sqlx::query("UPDATE account_sessions SET expires_at=now()-interval '1 second'")
        .execute(&db.pool)
        .await
        .unwrap();
    assert_eq!(
        web(&s, "GET", "/api/v1/account/push", &expiring, Value::Null)
            .await
            .0,
        StatusCode::UNAUTHORIZED
    );
    let account: i64 = sqlx::query_scalar("SELECT min(id) FROM accounts")
        .fetch_one(&db.pool)
        .await
        .unwrap();
    market_web::contributors::new_session(
        &db.pool,
        account,
        &market_web::auth::new_credentials().token,
    )
    .await
    .unwrap();
    assert_eq!(
        stored(&db).await,
        0,
        "expired sessions are purged with their subscriptions"
    );
    db.close().await;
}

// ---- Matching rounds ----------------------------------------------------------

struct Market {
    db: sqlx::PgPool,
    collector: i64,
    visits: i64,
}

impl Market {
    async fn new(db: &TestDb) -> Self {
        let collector = db.collector("push-fixture").await.id;
        sqlx::query(
            "INSERT INTO items(id,name_en,name_zh,category) VALUES
            (2000000,'Red Potion','红色药水','use'),(2000002,'White Potion','白色药水','use'),
            (2000003,'Blue Potion','蓝色药水','use'),(2000004,'Elixir','特殊药水','use'),
            (2000005,'Power Elixir','超级药水','use'),(2000006,'Mana Elixir','活力神水','use')",
        )
        .execute(&db.pool)
        .await
        .unwrap();
        Self {
            db: db.pool.clone(),
            collector,
            visits: 0,
        }
    }

    /// A shop visit at `observed` listing one item in slot 1.
    async fn offer(
        &mut self,
        shop: i64,
        title: &str,
        item: i32,
        price: i64,
        stock: i32,
        observed: f64,
    ) {
        self.visits += 1;
        sqlx::query("INSERT INTO shops(id,shop_key,world,shop_id,title,first_seen_at,last_seen_at,public_key,channel,room,owner_character_id,owner_name)
            VALUES($1,$1::text,'ClassicWorld',$1,$2,to_timestamp($3),to_timestamp($3),'shop'||$1,12,3,$1,'Host')
            ON CONFLICT(id) DO UPDATE SET last_seen_at=EXCLUDED.last_seen_at")
            .bind(shop).bind(title).bind(observed).execute(&self.db).await.unwrap();
        let observation: i64 = sqlx::query_scalar("INSERT INTO observations(observation_id,collector_id,shop_id,source,observed_at,fingerprint,visit_key)
            VALUES($1,$2,$3,'packet',to_timestamp($4),$1,$1) RETURNING id")
            .bind(format!("visit-{}", self.visits)).bind(self.collector).bind(shop).bind(observed)
            .fetch_one(&self.db).await.unwrap();
        sqlx::query("INSERT INTO listings(shop_id,observation_id,slot,item_id,price,bundle,stock,first_seen_at,last_seen_at)
            VALUES($1,$2,1,$3,$4,1,$5,to_timestamp($6),to_timestamp($6))
            ON CONFLICT(shop_id,slot) DO UPDATE SET observation_id=EXCLUDED.observation_id,item_id=EXCLUDED.item_id,
              price=EXCLUDED.price,stock=EXCLUDED.stock,last_seen_at=EXCLUDED.last_seen_at")
            .bind(shop).bind(observation).bind(item).bind(price).bind(stock).bind(observed)
            .execute(&self.db).await.unwrap();
    }
}

fn group(cap: i64, notify: bool) -> Value {
    json!({"cap": null, "notify": true, "position": 0, "groups": [{"id": "g", "name": "", "cap": cap, "notify": notify, "buy": false, "reminder": {}}]})
}

async fn watch(s: &AppState, w: &Web, watches: &[(i32, Value)]) {
    let operations: Vec<Value> = watches.iter()
        .map(|(item, value)| json!({"kind": "watch", "key": item.to_string(), "value": value, "version": 0}))
        .collect();
    let (status, body) = web(
        s,
        "POST",
        "/api/v1/account/data",
        w,
        json!({"operations": operations}),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");
}

/// Decrypted messages per device name.
fn opened(
    fake: &FakeService,
    devices: &[(&str, &Device)],
    origin: &str,
    key: &str,
) -> HashMap<String, Vec<Message>> {
    let mut found: HashMap<String, Vec<Message>> = HashMap::new();
    for delivered in fake.take() {
        let device = devices
            .iter()
            .find(|(name, _)| *name == delivered.name)
            .unwrap()
            .1;
        found
            .entry(delivered.name.clone())
            .or_default()
            .push(verify(&delivered, device, origin, key));
    }
    found
}

#[tokio::test]
async fn rounds_push_new_matches_once_and_merge_them() {
    let Some(db) = TestDb::new().await else {
        return;
    };
    let (fake, origin) = FakeService::start().await;
    let (s, key) = loopback_state(&db, &origin);
    let push = s.push.clone().unwrap();
    let mut market = Market::new(&db).await;
    let w = signup(&s, "push_rounds").await;
    watch(
        &s,
        &w,
        &[
            (2000000, group(50, true)),
            (2000002, group(1000, false)),
            (2000003, group(1000, true)),
            (2000004, group(1000, true)),
            (2000005, group(1000, true)),
            (2000006, group(1000, true)),
        ],
    )
    .await;
    let zh = Device::new(format!("{origin}/push/zh"));
    let en = Device::new(format!("{origin}/push/en"));
    let zh_id = subscribe(&s, &w, &zh, "Android Chrome", "zh").await;
    subscribe(&s, &w, &en, "Windows Edge", "en").await;
    let devices = [("zh", &zh), ("en", &en)];
    let t0 = unix_now().floor();

    // First round: an existing match only starts the cursor.
    market.offer(1, "早到的店", 2000000, 30, 5, t0 - 10.0).await;
    assert_eq!(
        push::run_round(&db.pool, &push, t0).await.unwrap(),
        push::Round {
            accounts: 1,
            sent: 0,
            removed: 0
        }
    );
    assert!(fake.take().is_empty());

    // A new matching offer is pushed once per subscription, in its language.
    market.offer(2, "店名", 2000000, 41, 100, t0 + 5.0).await;
    market.offer(3, "白药水店", 2000002, 10, 5, t0 + 5.0).await; // notify=false group
    assert_eq!(
        push::run_round(&db.pool, &push, t0 + 30.0)
            .await
            .unwrap()
            .sent,
        2
    );
    let got = opened(&fake, &devices, &origin, &key);
    assert_eq!(
        got["zh"],
        vec![Message::new(
            "关注提醒",
            "红色药水 · 41 · 库存 100 · 12频道 3洞 · 店名",
            "/item/2000000",
            "watch-2000000"
        )]
    );
    assert_eq!(
        got["en"],
        vec![Message::new(
            "Watch alert",
            "Red Potion · 41 · stock 100 · CH 12 room 3 · 店名",
            "/item/2000000",
            "watch-2000000"
        )]
    );
    assert!(listed(&s, &w)
        .await
        .iter()
        .all(|r| r["last_sent_at"].is_string()));

    // The same offer, also re-observed in a new visit with new stock, is not repeated.
    market.offer(2, "店名", 2000000, 41, 99, t0 + 50.0).await;
    assert_eq!(
        push::run_round(&db.pool, &push, t0 + 60.0)
            .await
            .unwrap()
            .sent,
        0
    );
    assert!(fake.take().is_empty());

    // Several offers of one item become one notification.
    for (shop, price) in [(10, 90), (11, 80), (12, 95)] {
        market
            .offer(shop, "蓝药水店", 2000003, price, 5, t0 + 70.0)
            .await;
    }
    assert_eq!(
        push::run_round(&db.pool, &push, t0 + 90.0)
            .await
            .unwrap()
            .sent,
        2
    );
    let got = opened(&fake, &devices, &origin, &key);
    assert_eq!(got["zh"][0].body, "蓝色药水 · 3 条新报价 · 最低 80");
    assert_eq!(got["en"][0].body, "Blue Potion · 3 new offers · from 80");
    assert_eq!(got["zh"][0].tag, "watch-2000003");

    // More than three items in a round: one summary.
    for (shop, item) in [(20, 2000003), (21, 2000004), (22, 2000005), (23, 2000006)] {
        market.offer(shop, "杂货店", item, 70, 5, t0 + 100.0).await;
    }
    assert_eq!(
        push::run_round(&db.pool, &push, t0 + 120.0)
            .await
            .unwrap()
            .sent,
        2
    );
    let got = opened(&fake, &devices, &origin, &key);
    assert_eq!(
        got["zh"],
        vec![Message::new(
            "关注提醒",
            "4 件关注有新报价",
            "/watch",
            "watch-summary"
        )]
    );
    assert_eq!(got["en"][0].body, "4 watched items have new offers");

    // 410 removes that subscription; the other still receives the offer.
    fake.status("zh", 410);
    market.offer(30, "新店", 2000000, 42, 7, t0 + 130.0).await;
    assert_eq!(
        push::run_round(&db.pool, &push, t0 + 150.0).await.unwrap(),
        push::Round {
            accounts: 1,
            sent: 1,
            removed: 1
        }
    );
    assert!(listed(&s, &w).await.iter().all(|r| r["id"] != zh_id));
    assert_eq!(fake.take().len(), 2);

    // After a long pause only the last ten minutes count.
    sqlx::query("UPDATE push_cursors SET started_at=to_timestamp($1),cursor_at=to_timestamp($1)")
        .bind(t0 - 7200.0)
        .execute(&db.pool)
        .await
        .unwrap();
    let now = t0 + 900.0;
    market.offer(31, "旧店", 2000000, 43, 7, now - 700.0).await;
    market.offer(32, "近店", 2000000, 44, 7, now - 300.0).await;
    assert_eq!(push::run_round(&db.pool, &push, now).await.unwrap().sent, 1);
    let got = opened(&fake, &[("en", &en)], &origin, &key);
    assert_eq!(
        got["en"][0].body,
        "Red Potion · 44 · stock 7 · CH 12 room 3 · 近店"
    );

    // Another process holding the round lock makes this round a no-op.
    let mut other = db.pool.acquire().await.unwrap();
    sqlx::query("SELECT pg_advisory_lock($1)")
        .bind(push::ROUND_LOCK)
        .execute(&mut *other)
        .await
        .unwrap();
    market.offer(33, "锁店", 2000000, 45, 7, now + 10.0).await;
    assert_eq!(
        push::run_round(&db.pool, &push, now + 30.0).await.unwrap(),
        push::Round::default()
    );
    sqlx::query("SELECT pg_advisory_unlock($1)")
        .bind(push::ROUND_LOCK)
        .execute(&mut *other)
        .await
        .unwrap();
    drop(other);
    assert!(fake.take().is_empty());

    // Without subscriptions the cursor is dropped; a new subscription starts quietly.
    assert_eq!(
        web(
            &s,
            "POST",
            "/api/v1/account/push/unsubscribe",
            &w,
            json!({"endpoint": en.endpoint})
        )
        .await
        .0,
        StatusCode::OK
    );
    assert_eq!(
        push::run_round(&db.pool, &push, now + 40.0)
            .await
            .unwrap()
            .accounts,
        0
    );
    let cursors: i64 = sqlx::query_scalar("SELECT count(*) FROM push_cursors")
        .fetch_one(&db.pool)
        .await
        .unwrap();
    assert_eq!(cursors, 0);
    db.close().await;
}

// ---- Static routes ------------------------------------------------------------

#[tokio::test]
async fn service_worker_and_manifest_are_served_from_the_root() {
    let web_dir = std::env::temp_dir().join(format!(
        "cwm-push-web-{}",
        market_web::auth::new_credentials().public_id
    ));
    std::fs::create_dir_all(&web_dir).unwrap();
    std::fs::write(web_dir.join("index.html"), "<!doctype html>").unwrap();
    let pool = sqlx::postgres::PgPoolOptions::new()
        .connect_lazy("postgres://nobody@127.0.0.1:1/none")
        .unwrap();
    let state = AppState::new(pool, Settings::default());
    let get = |path: &'static str| {
        market_web::app_with_web(state.clone(), Some(&web_dir))
            .oneshot(Request::get(path).body(Body::empty()).unwrap())
    };
    assert_eq!(get("/sw.js").await.unwrap().status(), StatusCode::NOT_FOUND);
    std::fs::write(
        web_dir.join("sw.js"),
        "self.addEventListener('push',()=>{});",
    )
    .unwrap();
    std::fs::write(
        web_dir.join("manifest.webmanifest"),
        r#"{"name":"枫叶市集"}"#,
    )
    .unwrap();
    for (path, kind) in [
        ("/sw.js", "text/javascript"),
        ("/manifest.webmanifest", "application/manifest+json"),
    ] {
        let response = get(path).await.unwrap();
        assert_eq!(response.status(), StatusCode::OK, "{path}");
        assert_eq!(response.headers()["content-type"], kind);
        assert_eq!(response.headers()["cache-control"], "no-cache");
        assert!(response.headers()["content-security-policy"]
            .to_str()
            .unwrap()
            .contains("manifest-src 'self'"));
    }
    let page = get("/watch").await.unwrap();
    assert!(page.headers()["content-security-policy"]
        .to_str()
        .unwrap()
        .contains("manifest-src 'self'"));
    std::fs::remove_dir_all(web_dir).unwrap();
}

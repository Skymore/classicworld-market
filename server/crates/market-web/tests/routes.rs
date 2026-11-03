use axum::{
    body::Body,
    http::{Request, StatusCode},
};
use http_body_util::BodyExt;
use market_web::{app, AppState, Settings};
use sqlx::postgres::PgPoolOptions;
use tower::ServiceExt;

/// A pool that never connects. `/healthz` must not need the database.
fn state() -> AppState {
    AppState::new(
        PgPoolOptions::new()
            .acquire_timeout(std::time::Duration::from_secs(2))
            .connect_lazy("postgres://nobody@127.0.0.1:1/none")
            .expect("lazy pool"),
        Settings::default(),
    )
}

#[tokio::test]
async fn healthz_is_ok_without_database() {
    let res = app(state())
        .oneshot(Request::get("/healthz").body(Body::empty()).unwrap())
        .await
        .unwrap();
    assert_eq!(res.status(), StatusCode::OK);
    let body: serde_json::Value =
        serde_json::from_slice(&res.into_body().collect().await.unwrap().to_bytes()).unwrap();
    assert_eq!(body["status"], "ok");
}

#[tokio::test]
async fn readyz_reports_database_outage() {
    let res = app(state())
        .oneshot(Request::get("/readyz").body(Body::empty()).unwrap())
        .await
        .unwrap();
    assert_eq!(res.status(), StatusCode::SERVICE_UNAVAILABLE);
}

#[tokio::test]
async fn version_names_the_crate() {
    let res = app(state())
        .oneshot(Request::get("/api/v1/version").body(Body::empty()).unwrap())
        .await
        .unwrap();
    assert_eq!(res.status(), StatusCode::OK);
    let body: serde_json::Value =
        serde_json::from_slice(&res.into_body().collect().await.unwrap().to_bytes()).unwrap();
    assert_eq!(body["name"], "market-web");
}

/// Page routes return the SPA shell (no-cache); assets live under `/web`.
#[tokio::test]
async fn web_shell_and_assets() {
    let web_dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../web");
    let get = |path: &str| {
        let req = Request::get(path).body(Body::empty()).unwrap();
        market_web::app_with_web(state(), Some(&web_dir)).oneshot(req)
    };
    for path in [
        "/",
        "/prices",
        "/agent",
        "/traffic",
        "/prices/4010001",
        "/sales",
        "/watch",
        "/alerts",
        "/tools",
        "/tools/enhancement",
        "/device",
        "/v2",
    ] {
        let res = get(path).await.unwrap();
        assert_eq!(res.status(), StatusCode::OK, "{path}");
        assert_eq!(res.headers()["cache-control"], "no-cache", "{path}");
        assert!(res.headers()["content-security-policy"]
            .to_str()
            .unwrap()
            .contains("script-src 'self'"));
        let body = res.into_body().collect().await.unwrap().to_bytes();
        assert!(body.starts_with(b"<!doctype html>"), "{path}");
    }
    let res = get("/web/js/app.js").await.unwrap();
    assert_eq!(res.status(), StatusCode::OK);
    assert_eq!(res.headers()["cache-control"], "no-cache");
    assert_eq!(res.headers()["content-type"], "text/javascript");
    let res = get("/web/nope.js").await.unwrap();
    assert_eq!(res.status(), StatusCode::NOT_FOUND);
    // SSR and API paths are not swallowed by the shell.
    let res = get("/api/v1/version").await.unwrap();
    assert_eq!(res.status(), StatusCode::OK);
}

#[tokio::test]
async fn collector_releases_survive_a_different_website_root() {
    let web_dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../web");
    let releases = std::env::temp_dir().join(format!(
        "market-release-route-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    std::fs::create_dir(&releases).unwrap();
    let manifest = b"{\"schema\":1,\"version\":\"v0.5.10\"}";
    std::fs::write(releases.join("stable.json"), manifest).unwrap();
    let response = market_web::web::routes_with_releases(&web_dir, &releases)
        .with_state(state())
        .oneshot(
            Request::get("/web/releases/stable.json")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(response.headers()["cache-control"], "no-cache");
    assert_eq!(
        response.into_body().collect().await.unwrap().to_bytes(),
        &manifest[..]
    );
    std::fs::remove_file(releases.join("stable.json")).unwrap();
    std::fs::remove_dir(releases).unwrap();
}

/// `/web/**`: cache policy by URL, content-hash ETags that survive a new
/// modification time, br/gzip from memory for text, nothing for images.
#[tokio::test]
async fn web_assets_cache_by_url_and_revalidate_by_content() {
    use std::io::Read as _;
    let root = std::env::temp_dir().join(format!(
        "market-web-cache-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    for dir in ["react/chunks", "css", "images/scenes"] {
        std::fs::create_dir_all(root.join(dir)).unwrap();
    }
    let script = "export const prices = [1, 2, 3];\n".repeat(200);
    let chunk = root.join("react/chunks/prices-B-ZAcW7c.js");
    std::fs::write(&chunk, &script).unwrap();
    std::fs::write(root.join("css/base.css"), "body{margin:0}\n".repeat(50)).unwrap();
    std::fs::write(root.join("index.html"), "<!doctype html>").unwrap();
    std::fs::write(root.join("images/scenes/a.webp"), [7u8; 4000]).unwrap();
    let router = market_web::app_with_web(state(), Some(&root));
    let get = |path: &str, headers: &[(&str, &str)]| {
        let mut request = Request::get(path);
        for (name, value) in headers {
            request = request.header(*name, *value);
        }
        router.clone().oneshot(request.body(Body::empty()).unwrap())
    };
    let immutable = "public, max-age=31536000, immutable";

    let gzip = get(
        "/web/react/chunks/prices-B-ZAcW7c.js",
        &[("accept-encoding", "gzip")],
    )
    .await
    .unwrap();
    assert_eq!(gzip.status(), StatusCode::OK);
    let headers = gzip.headers().clone();
    assert_eq!(headers["cache-control"], immutable);
    assert_eq!(headers["content-encoding"], "gzip");
    assert_eq!(headers["content-type"], "text/javascript");
    assert_eq!(headers["vary"], "accept-encoding");
    let tag = headers["etag"].to_str().unwrap().to_owned();
    assert!(tag.starts_with('"') && tag.len() == 34, "{tag}");
    let body = gzip.into_body().collect().await.unwrap().to_bytes();
    let mut text = String::new();
    flate2::read::GzDecoder::new(&body[..])
        .read_to_string(&mut text)
        .unwrap();
    assert_eq!(text, script);

    // br is made in the background; gzip answers until it is ready.
    let mut br = None;
    for _ in 0..100 {
        let response = get(
            "/web/react/chunks/prices-B-ZAcW7c.js",
            &[("accept-encoding", "gzip, br")],
        )
        .await
        .unwrap();
        if response.headers()["content-encoding"] == "br" {
            br = Some(response);
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(20)).await;
    }
    let br = br.expect("br copy");
    assert_eq!(br.headers()["etag"], tag.as_str());
    let body = br.into_body().collect().await.unwrap().to_bytes();
    let mut text = String::new();
    brotli::Decompressor::new(&body[..], 4096)
        .read_to_string(&mut text)
        .unwrap();
    assert_eq!(text, script);

    let touch = |seconds: u64| {
        std::fs::File::options()
            .write(true)
            .open(&chunk)
            .unwrap()
            .set_modified(std::time::SystemTime::now() + std::time::Duration::from_secs(seconds))
            .unwrap();
    };
    // A redeploy rewrites the file with a new mtime: still 304.
    std::fs::write(&chunk, &script).unwrap();
    touch(10);
    let again = get(
        "/web/react/chunks/prices-B-ZAcW7c.js",
        &[("if-none-match", &tag), ("accept-encoding", "br")],
    )
    .await
    .unwrap();
    assert_eq!(again.status(), StatusCode::NOT_MODIFIED);
    assert_eq!(again.headers()["etag"], tag.as_str());
    assert_eq!(again.headers()["cache-control"], immutable);
    // New content, new tag; the old tag and date no longer match.
    std::fs::write(&chunk, script.replace('3', "4")).unwrap();
    touch(20);
    let changed = get(
        "/web/react/chunks/prices-B-ZAcW7c.js",
        &[("if-none-match", &tag), ("accept-encoding", "gzip")],
    )
    .await
    .unwrap();
    assert_eq!(changed.status(), StatusCode::OK);
    assert_ne!(changed.headers()["etag"], tag.as_str());
    let date = changed.headers()["last-modified"]
        .to_str()
        .unwrap()
        .to_owned();
    let since = get(
        "/web/react/chunks/prices-B-ZAcW7c.js",
        &[("if-modified-since", &date)],
    )
    .await
    .unwrap();
    assert_eq!(since.status(), StatusCode::NOT_MODIFIED);

    // Identity goes to ServeDir with a weak tag (it may be compressed per response).
    let plain = get("/web/css/base.css", &[]).await.unwrap();
    assert_eq!(plain.status(), StatusCode::OK);
    assert_eq!(plain.headers()["cache-control"], "no-cache");
    assert!(plain.headers().get("content-encoding").is_none());
    assert!(plain.headers()["etag"]
        .to_str()
        .unwrap()
        .starts_with("W/\""));
    let weak = plain.headers()["etag"].to_str().unwrap().to_owned();
    let revalidated = get(
        "/web/css/base.css",
        &[("if-none-match", &weak), ("accept-encoding", "gzip")],
    )
    .await
    .unwrap();
    assert_eq!(revalidated.status(), StatusCode::NOT_MODIFIED);
    let versioned = get(
        "/web/css/base.css?v=133bd615d20f1bd1",
        &[("accept-encoding", "gzip")],
    )
    .await
    .unwrap();
    assert_eq!(versioned.headers()["cache-control"], immutable);

    let image = get(
        "/web/images/scenes/a.webp",
        &[("accept-encoding", "gzip, br")],
    )
    .await
    .unwrap();
    assert_eq!(image.status(), StatusCode::OK);
    assert_eq!(
        image.headers()["cache-control"],
        "public, max-age=604800, stale-while-revalidate=86400"
    );
    assert!(image.headers().get("content-encoding").is_none());
    let image_tag = image.headers()["etag"].to_str().unwrap().to_owned();
    assert!(image_tag.starts_with('"'));
    let cached = get(
        "/web/images/scenes/a.webp",
        &[("if-none-match", &image_tag)],
    )
    .await
    .unwrap();
    assert_eq!(cached.status(), StatusCode::NOT_MODIFIED);

    for (path, policy) in [
        ("/web/index.html?v=133bd615d20f1bd1", "no-cache"),
        ("/web/react/chunks/missing-B-ZAcW7c.js", "no-cache"),
    ] {
        let response = get(path, &[]).await.unwrap();
        assert_eq!(response.headers()["cache-control"], policy, "{path}");
    }
    assert_eq!(
        get("/web/react/chunks/missing-B-ZAcW7c.js", &[])
            .await
            .unwrap()
            .status(),
        StatusCode::NOT_FOUND
    );
    std::fs::remove_dir_all(root).unwrap();
}

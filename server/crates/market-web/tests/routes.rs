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
        "/prices/4010001",
        "/sales",
        "/watch",
        "/alerts",
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

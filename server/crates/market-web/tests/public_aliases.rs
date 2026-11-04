use axum::{
    body::Body,
    http::{Request, StatusCode},
};
use market_web::{app, AppState, Settings};
use sqlx::postgres::PgPoolOptions;
use tower::ServiceExt;

fn state() -> AppState {
    AppState::new(
        PgPoolOptions::new()
            .connect_lazy("postgres://nobody@127.0.0.1:1/none")
            .unwrap(),
        Settings::default(),
    )
}

#[tokio::test]
async fn aliases_allow_account_and_traffic_origins_but_keep_google_on_primary() {
    let router = app(state());
    for host in ["meso.ruit.me", "ms.ruit.me", "mscw.ruit.me"] {
        let response = router
            .clone()
            .oneshot(
                Request::post("/api/v1/account/register")
                    .header("host", host)
                    .header("origin", format!("https://{host}"))
                    .header("content-type", "application/json")
                    .body(Body::from(r#"{"username":"x","password":"short"}"#))
                    .unwrap(),
            )
            .await
            .unwrap();
        // Input validation runs after the origin guard, without touching a DB.
        assert_eq!(response.status(), StatusCode::BAD_REQUEST);
        let response = router.clone().oneshot(Request::post("/api/v1/traffic/event")
            .header("host", host).header("origin", format!("https://{host}"))
            .header("dnt", "1").header("content-type", "application/json")
            .body(Body::from(r#"{"event_id":"a","visitor":"b","path":"/","device":"phone","referrer":""}"#)).unwrap()).await.unwrap();
        assert_eq!(response.status(), StatusCode::NO_CONTENT);
        let response = router
            .clone()
            .oneshot(
                Request::get("/auth/google/start?link=example_code")
                    .header("host", host)
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::SEE_OTHER);
        assert_eq!(
            response.headers()["location"],
            "https://mxd.ruit.me/auth/google/start?link=example_code"
        );
    }
    for origin in [
        "http://ms.ruit.me",
        "https://ms.ruit.me.evil.example",
        "https://elsewhere.ruit.me",
    ] {
        let response = router
            .clone()
            .oneshot(
                Request::post("/api/v1/account/register")
                    .header("origin", origin)
                    .header("content-type", "application/json")
                    .body(Body::from(r#"{"username":"x","password":"short"}"#))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::FORBIDDEN);
    }
}

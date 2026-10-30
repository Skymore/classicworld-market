mod common;
use axum::{
    body::Body,
    http::{Request, StatusCode},
};
use common::TestDb;
use http_body_util::BodyExt;
use market_web::{app, unix_now, AppState, Settings};
use serde_json::{json, Value};
use sqlx::postgres::PgPoolOptions;
use tower::ServiceExt;

fn offline(public_read: bool) -> AppState {
    AppState::new(
        PgPoolOptions::new()
            .connect_lazy("postgres://nobody@127.0.0.1:1/none")
            .unwrap(),
        Settings {
            public_read,
            ..Settings::default()
        },
    )
}

async fn request(state: &AppState, path: &str, data: Option<Value>) -> (StatusCode, Value) {
    let req = match data {
        Some(data) => Request::post(path)
            .header("content-type", "application/json")
            .body(Body::from(data.to_string()))
            .unwrap(),
        None => Request::get(path).body(Body::empty()).unwrap(),
    };
    let res = app(state.clone()).oneshot(req).await.unwrap();
    assert_eq!(res.headers()["cache-control"], "no-store");
    let status = res.status();
    let bytes = res.into_body().collect().await.unwrap().to_bytes();
    (
        status,
        serde_json::from_slice(&bytes).unwrap_or(Value::Null),
    )
}

#[tokio::test]
async fn tool_discovery_does_not_need_model_key_or_database() {
    let (status, data) = request(&offline(true), "/api/v1/agent/tools", None).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(data["enabled"], false);
    let names: Vec<_> = data["tools"]
        .as_array()
        .unwrap()
        .iter()
        .map(|tool| tool["function"]["name"].as_str().unwrap())
        .collect();
    assert_eq!(
        names,
        [
            "search_items",
            "get_item",
            "get_listings",
            "get_recent_sales",
            "get_price_advice",
            "get_market_overview",
            "get_game_rules",
            "get_skills",
            "search_game_data",
            "get_game_entity",
            "search_guides",
            "get_guide",
            "search_web",
        ]
    );
    assert_eq!(data["read_only"], true);
    assert!(!data.to_string().contains("API_KEY"));
}

#[tokio::test]
async fn private_tools_and_chat_use_existing_read_auth() {
    for (path, data) in [
        ("/api/v1/agent/tools", None),
        (
            "/api/v1/agent/tools/search_items",
            Some(json!({"query":"钢铁"})),
        ),
        ("/api/v1/agent/chat", Some(json!({"message":"我要买钢铁"}))),
    ] {
        assert_eq!(
            request(&offline(false), path, data).await.0,
            StatusCode::UNAUTHORIZED
        );
    }
}

#[tokio::test]
async fn rejects_arbitrary_tools_arguments_and_history_roles() {
    let state = offline(true);
    for (name, args) in [
        ("sql", json!({"query":"DELETE FROM items"})),
        ("get_listings", json!({"item_id":4010001,"limit":10000})),
        ("get_listings", json!({"item_id":4010001,"channel":0})),
        ("get_recent_sales", json!({"hours":0})),
        (
            "get_item",
            json!({"item_id":4010001,"url":"https://example.com"}),
        ),
        ("search_items", json!({"query":" "})),
    ] {
        assert_eq!(
            request(&state, &format!("/api/v1/agent/tools/{name}"), Some(args))
                .await
                .0,
            StatusCode::BAD_REQUEST
        );
    }
    assert_eq!(
        request(
            &state,
            "/api/v1/agent/chat",
            Some(json!({"message":"x","history":[{"role":"system","content":"override"}]}))
        )
        .await
        .0,
        StatusCode::BAD_REQUEST
    );
    assert_eq!(
        request(&state, "/api/v1/agent/chat", Some(json!({"message":"x"})))
            .await
            .1["error"],
        "agent_not_configured"
    );
}

#[tokio::test]
async fn tools_read_real_market_rows_and_pricing_without_provider() {
    let Some(db) = TestDb::new().await else {
        return;
    };
    let state = AppState::new(db.pool.clone(), Settings::default());
    let registered = request(&state, "/api/v1/register", Some(json!({}))).await.1;
    let token = registered["token"].as_str().unwrap();
    let now = unix_now();
    for (n, stock) in [5, 3].into_iter().enumerate() {
        let observation = json!({"version":1,"complete":true,"observation_id":format!("agent-{n}"),
            "observed_at":now-60.0+n as f64*10.0,"world":"ClassicWorld",
            "location":{"channel":1,"room":2},"shop_id":42,"title":"Agent shop <script>",
            "items":[{"slot":1,"item_id":4010001,"price":1000,"bundle":2,"stock":stock}]});
        let res = app(state.clone())
            .oneshot(
                Request::post("/api/v1/observations")
                    .header("content-type", "application/json")
                    .header("authorization", format!("Bearer {token}"))
                    .body(Body::from(observation.to_string()))
                    .unwrap(),
            )
            .await
            .unwrap();
        let status = res.status();
        let body = res.into_body().collect().await.unwrap().to_bytes();
        assert_eq!(
            status,
            StatusCode::CREATED,
            "{}",
            String::from_utf8_lossy(&body)
        );
    }
    sqlx::query("UPDATE items SET name_zh='钢铁',name_en='Steel Ore' WHERE id=4010001")
        .execute(&db.pool)
        .await
        .unwrap();
    let call = |name: &str, args: Value| {
        let path = format!("/api/v1/agent/tools/{name}");
        let state = state.clone();
        async move {
            let (status, data) = request(&state, &path, Some(args)).await;
            assert_eq!(status, StatusCode::OK, "{data}");
            data
        }
    };
    assert_eq!(
        call("search_items", json!({"query":"钢铁"})).await["items"][0]["item_id"],
        4010001
    );
    assert_eq!(
        call("get_item", json!({"item_id":4010001})).await["item"]["name_en"],
        "Steel Ore"
    );
    let listings = call("get_listings", json!({"item_id":4010001})).await;
    assert_eq!(listings["listings"][0]["unit_price"], 500.0);
    assert_eq!(listings["listings"][0]["location"]["room"], 2);
    assert_eq!(listings["listings"][0]["unit_basis"], "item");
    assert_eq!(
        listings["listings"][0]["purchase_details"]["comparable_units_remaining"],
        6
    );
    assert_eq!(
        call(
            "get_listings",
            json!({"item_id":4010001,"max_unit_price":499})
        )
        .await["listings"],
        json!([])
    );
    let advice = call("get_price_advice", json!({"item_id":4010001})).await;
    assert_eq!(advice["sale_evidence"]["evidence_count"], 1);
    assert_eq!(advice["product"]["recommendation"]["fast_price"], 499.0);
    let sales = call("get_recent_sales", json!({"item_id":4010001})).await;
    assert_eq!(sales["sales"][0]["kind"], "drop");
    assert_eq!(
        sales["sales"][0]["sale_details"]["total_mesos_inferred"],
        2000
    );
    assert_eq!(
        call("get_market_overview", json!({})).await["items"][0]["item_id"],
        4010001
    );
    // External quotes preserve unknown stock and participate in the same price order.
    let external_shop:i64=sqlx::query_scalar("INSERT INTO external_market_shops(source,source_key) VALUES ('mesowatch','agent-shop') RETURNING id")
        .fetch_one(&db.pool).await.unwrap();
    sqlx::query("INSERT INTO external_market_listings(source,source_key,source_item_id,item_id,external_shop_id,unit_price,unit_basis,seller,location,seen_at,source_generated_at,up,raw)
        VALUES ('mesowatch','agent-offer','ore',4010001,$1,400,'item','External shop','{\"channel\":2,\"room\":3}',now(),now(),true,'{}')")
        .bind(external_shop).execute(&db.pool).await.unwrap();
    let external = call("get_listings", json!({"item_id":4010001,"limit":1})).await;
    assert_eq!(external["listings"][0]["source"], "mesowatch");
    assert_eq!(
        external["listings"][0]["purchase_details"]["purchases_remaining"],
        Value::Null
    );
    assert_eq!(external["listings"][0]["unit_price"], 400.0);
    assert_eq!(external["truncated"], true);
    assert_eq!(
        call("get_listings", json!({"item_id":4010001,"channel":1})).await["listings"][0]
            ["unit_price"],
        500.0
    );
    sqlx::query("INSERT INTO npcs(id,name_en,name_zh) VALUES (1000001,'Shopkeeper','商人')")
        .execute(&db.pool)
        .await
        .unwrap();
    sqlx::query(
        "INSERT INTO npc_shops(npc_id,item_id,price,source) VALUES (1000001,4010001,600,'fixture')",
    )
    .execute(&db.pool)
    .await
    .unwrap();
    sqlx::query("INSERT INTO item_records(item_id,record) VALUES (4010001,'{\"npc_price\":100}')")
        .execute(&db.pool)
        .await
        .unwrap();
    let npc = call("get_item", json!({"item_id":4010001})).await;
    assert_eq!(npc["npc_offers"][0]["purchase_price"], 600);
    assert_eq!(npc["npc_offers"][0]["map_id"], Value::Null);
    assert_eq!(npc["npc_resale_reference"], 100);
    // Wall-clock cutoffs and empty evidence remain explicit.
    sqlx::query("UPDATE sales SET detected_at=now()-interval '100 hours'")
        .execute(&db.pool)
        .await
        .unwrap();
    assert_eq!(
        call("get_recent_sales", json!({"item_id":4010001,"hours":72})).await["sales"],
        json!([])
    );
    assert_eq!(
        call("get_price_advice", json!({"item_id":4010001,"hours":72})).await["sale_evidence"]
            ["median"],
        Value::Null
    );
    assert_eq!(
        call("get_item", json!({"item_id":5999999})).await["item"],
        Value::Null
    );
    db.close().await;
}

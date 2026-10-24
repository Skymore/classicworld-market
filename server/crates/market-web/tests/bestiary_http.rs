//! One request per bestiary page against a seeded Postgres schema.

#[path = "bestiary_common/mod.rs"]
mod common;

use axum::{
    body::Body,
    http::{header, Request, StatusCode},
    Router,
};
use http_body_util::BodyExt;
use market_web::{
    app,
    bestiary::{
        catalog::Catalog,
        import::{import_catalog, Sources},
        mapledex::Dataset,
        rows::ItemRow,
        wz,
    },
    AppState, Settings,
};
use tower::ServiceExt;

const MONSTERS: &str = r#"{"items": [
    {"id": 2, "n": {"en": "Snail", "zh": "嫩寶", "cw": "蜗牛"}, "level": 1, "hp": 8, "src": 100100,
     "maps": [10001010], "dropSrc": "book",
     "drops": [{"p": 60, "id": 4000019}, {"meso": [4, 6], "p": 40},
               {"p": 0.03, "src": 2040002, "n": {"en": "Scroll for Helmet for DEF", "cw": "头盔防御卷轴10%"}}]},
    {"id": 8, "n": {"en": "Pig", "cw": "猪猪"}, "level": 7, "src": 1210100, "maps": [10001010],
     "drops": [{"p": 0.15, "id": 1002000}]}
]}"#;
const MAPS: &str = r#"{"items": [
    {"id": 10001000, "n": {"en": "Henesys", "zh": "弓箭手村", "cw": "射手村"}, "street": {"en": "Victoria Road", "cw": "金银岛"},
     "town": 1, "npcs": [200]},
    {"id": 10001010, "n": {"en": "Henesys Hunting Ground I", "cw": "射手训练场Ⅰ"}, "street": {"cw": "金银岛", "en": "Victoria Road"},
     "returnMap": 10001000, "mobs": [[2, 4], [8, 10]]},
    {"id": 10002000, "n": {"en": "Ellinia", "cw": "魔法密林"}, "town": 1}
]}"#;

fn item(id: i32, name_zh: &str, name_en: &str, category: &str) -> ItemRow {
    ItemRow {
        id,
        name_en: name_en.into(),
        name_zh: Some(name_zh.into()),
        category: category.into(),
        subcategory: None,
        req_level: None,
        req_job_mask: None,
        icon_url: Some(format!("https://mxdgcw.dvg.cn/dbsource/icon/item/{id}.png")),
        is_cash: false,
    }
}

async fn seeded() -> Option<(common::TestDb, Router)> {
    let db = common::test_db().await?;
    let catalog = Catalog {
        items: vec![
            item(4000019, "蜗牛壳", "Snail Shell", "其他"),
            item(1002000, "褐色皮帽", "Brown Skullcap", "装备"),
        ],
        records: vec![],
        version: "test".into(),
        warnings: vec![],
    };
    let data = Dataset::from_json(MONSTERS, MAPS).unwrap();
    let sources = Sources {
        items_path: "test",
        mapledex_path: "test",
        mapledex_version: "test",
    };
    import_catalog(&db.pool, &catalog, &data, &sources)
        .await
        .unwrap();
    let portals = wz::portals_from(
        &wz::parse(r#"{"map_id": 10001000, "portals": [{"pn": "east00", "tm": 10001010, "tn": "west00"}]}"#).unwrap(),
    );
    wz::import(&db.pool, &portals, "test").await.unwrap();
    sqlx::query(
        "INSERT INTO item_stats (item_id, typical, typical_low, typical_high, sample_size, sales_24h,
                                 change_24h, lowest_ask, listings_count, shops_count, as_of)
         VALUES (4000019, 450, 400, 480, 30, 93, -6.1, 233, 460, 366, '2026-10-20T23:45:00Z')",
    )
    .execute(&db.pool)
    .await
    .unwrap();
    seed_market(&db.pool).await;
    let router = app(AppState::new(db.pool.clone(), Settings::default()));
    Some((db, router))
}

/// One shop on CH 14 room 8 with a live listing and a sale of the snail
/// shell, seen an hour ago (inside the 72-hour window), and its daily row.
async fn seed_market(pool: &sqlx::PgPool) {
    for sql in [
        "INSERT INTO collectors (id, public_id, token_hash, source) VALUES (1, 'c1', '\\x01', 'packet')",
        "INSERT INTO shops (id, shop_key, world, channel, room, shop_id, title, first_seen_at, last_seen_at, public_key)
         VALUES (1, 'k1', 'w', 14, 8, 77, 'Shell Shop', now() - interval '2 hours', now() - interval '1 hour', 'p1')",
        "INSERT INTO observations (id, observation_id, collector_id, shop_id, source, observed_at, fingerprint, visit_key)
         VALUES (1, 'o1', 1, 1, 'packet', now() - interval '1 hour', 'f1', 'v1')",
        "INSERT INTO observation_rows (observation_id, slot, item_id, price, bundle, stock, position)
         VALUES (1, 0, 4000019, 449, 1, 5, 0), (1, 1, 4000019, 470, 1, 0, 1)",
        "INSERT INTO listings (shop_id, slot, item_id, price, bundle, stock, first_seen_at, last_seen_at, observation_id)
         VALUES (1, 0, 4000019, 449, 1, 5, now() - interval '2 hours', now() - interval '1 hour', 1)",
        "INSERT INTO sales (item_id, shop_id, slot, kind, price, bundle, detected_at, observation_id, position)
         VALUES (4000019, 1, 1, 'found_sold', 470, 1, now() - interval '1 hour', 1, 1)",
        "INSERT INTO item_daily (item_id, day, median, low, high, count)
         VALUES (4000019, (now() AT TIME ZONE 'UTC')::date, 470, 470, 470, 1)",
        "UPDATE market_state SET as_of = now() - interval '1 hour'",
    ] {
        sqlx::query(sql).execute(pool).await.unwrap();
    }
}

struct Page {
    status: StatusCode,
    cache: String,
    content_type: String,
    csp: String,
    vary: String,
    body: String,
}

async fn get(router: &Router, uri: &str) -> Page {
    get_with(router, uri, None).await
}

async fn get_with(router: &Router, uri: &str, mobile_hint: Option<&str>) -> Page {
    let mut req = Request::get(uri);
    if let Some(hint) = mobile_hint {
        req = req.header("sec-ch-ua-mobile", hint);
    }
    let res = router
        .clone()
        .oneshot(req.body(Body::empty()).unwrap())
        .await
        .unwrap();
    let header = |name| {
        res.headers()
            .get(name)
            .map(|v| v.to_str().unwrap().to_string())
            .unwrap_or_default()
    };
    let (status, cache, content_type, csp, vary) = (
        res.status(),
        header(header::CACHE_CONTROL),
        header(header::CONTENT_TYPE),
        header(header::CONTENT_SECURITY_POLICY),
        header(header::VARY),
    );
    let bytes = res.into_body().collect().await.unwrap().to_bytes();
    Page {
        status,
        cache,
        content_type,
        csp,
        vary,
        body: String::from_utf8(bytes.to_vec()).unwrap(),
    }
}

const EDGE: &str = "public, s-maxage=86400";
const ITEM_CACHE: &str = "public, max-age=0, s-maxage=60";
const MOB_CACHE: &str = "public, s-maxage=600";

#[tokio::test]
async fn item_page() {
    let Some((db, router)) = seeded().await else {
        return;
    };
    let page = get(&router, "/item/4000019").await;
    assert_eq!(page.status, StatusCode::OK);
    assert_eq!(page.cache, ITEM_CACHE, "market numbers: short edge cache");
    assert!(page.content_type.starts_with("text/html"));
    assert!(page.csp.contains("script-src 'self'") && page.csp.contains("connect-src 'self'"));
    assert!(page.csp.contains("style-src 'self'"));
    assert!(!page.csp.split(';').find(|part| part.trim_start().starts_with("script-src")).unwrap().contains("unsafe-inline"));
    assert_eq!(page.vary, "Sec-CH-UA-Mobile");
    let body = &page.body;
    assert!(body.contains("<h1>蜗牛壳</h1>"));
    assert!(body.contains("450"), "typical price from item_stats");
    assert!(body.contains(r#"href="/mob/2""#));
    assert!(body.contains("60%"));
    assert!(body.contains("射手训练场Ⅰ"), "dropper's map");
    // The cheapest channel is in the first paint, from the same rows as /api/v1/item.
    assert!(body.contains(r#"<div class="cgroup open" data-ch-key="14">"#));
    assert!(body.contains("Shell Shop"));
    assert!(body.contains(r#"title="8 洞 最低 449""#));
    assert!(body.contains("发现已售"));
    assert!(
        body.contains(r#"data-mark="1|"#),
        "one listing in the mark item.js compares"
    );
    assert!(body.contains(r#"data-device="phone""#));

    let desktop = get_with(&router, "/item/4000019", Some("?0")).await;
    assert!(desktop.body.contains(r#"data-device="desktop""#));

    let english = get(&router, "/item/4000019?lang=en").await.body;
    assert!(english.contains("<h1>Snail Shell</h1>"));
    assert!(english.contains("Where to buy"));

    let fragment = get(&router, "/item/4000019?part=market").await;
    assert_eq!(fragment.status, StatusCode::OK);
    assert_eq!(fragment.cache, "no-store");
    assert!(fragment.body.starts_with("<div data-mark="));
    assert!(fragment.body.contains(r#"data-market="where""#));
    assert!(!fragment.body.contains("<html"));

    let no_stats = get(&router, "/item/1002000").await;
    assert!(no_stats.body.contains("还没有成交价"));
    assert!(no_stats.body.contains("0.15%"));

    for missing in ["/item/999", "/item/abc"] {
        let page = get(&router, missing).await;
        assert_eq!(page.status, StatusCode::NOT_FOUND, "{missing}");
        assert!(page.body.contains("没有这个物品"));
    }
    db.drop_schema().await;
}

#[tokio::test]
async fn mob_page() {
    let Some((db, router)) = seeded().await else {
        return;
    };
    let page = get(&router, "/mob/2").await;
    assert_eq!(
        (page.status, page.cache.as_str()),
        (StatusCode::OK, MOB_CACHE)
    );
    let body = &page.body;
    assert!(body.contains("<h1>蜗牛</h1>"));
    assert!(body.contains("https://maplestory.io/api/GMS/83/mob/100100/render/stand"));
    assert!(body.contains(r#"href="/map/10001010""#));
    assert!(body.contains(r#"href="/item/4000019""#));
    assert!(body.contains("成交 450 · 在售最低 233"));
    assert!(body.contains("4–6"), "meso drop");
    assert!(
        body.contains("头盔防御卷轴10%"),
        "drop outside the catalogue keeps its Mapledex name"
    );
    assert_eq!(get(&router, "/mob/7").await.status, StatusCode::NOT_FOUND);
    db.drop_schema().await;
}

#[tokio::test]
async fn map_page() {
    let Some((db, router)) = seeded().await else {
        return;
    };
    let page = get(&router, "/map/10001010").await;
    assert_eq!((page.status, page.cache.as_str()), (StatusCode::OK, EDGE));
    let body = &page.body;
    assert!(body.contains("<h1>射手训练场Ⅰ</h1>"));
    assert!(body.contains(r#"href="/mob/8""#));
    assert!(body.contains("回城点：射手村"));
    assert!(body.contains("走传送口 · east00"), "entrance from Henesys");

    let town = get(&router, "/map/10001000").await.body;
    assert!(town.contains("NPC #200"));
    assert!(town.contains("城镇"));
    db.drop_schema().await;
}

#[tokio::test]
async fn route_page() {
    let Some((db, router)) = seeded().await else {
        return;
    };
    let back = get(
        &router,
        "/route?from=10001010&to=%E5%B0%84%E6%89%8B%E6%9D%91",
    )
    .await;
    assert_eq!((back.status, back.cache.as_str()), (StatusCode::OK, EDGE));
    assert!(back.body.contains("射手训练场Ⅰ → 射手村"));
    assert!(back.body.contains("用回城卷轴"));

    let out = get(&router, "/route?from=Henesys&to=10001010").await.body;
    assert!(out.contains("1 步"), "{out}");
    assert!(out.contains("走传送口 · east00"));

    let none = get(&router, "/route?from=10001000&to=10002000").await.body;
    assert!(none.contains("暂时查不到路线"));
    let unknown = get(&router, "/route?from=10001000&to=%E7%81%AB%E6%98%9F")
        .await
        .body;
    assert!(unknown.contains("没有找到目的地"));
    assert!(get(&router, "/route")
        .await
        .body
        .contains("输入出发和目的地"));
    db.drop_schema().await;
}

#[tokio::test]
async fn search_page() {
    let Some((db, router)) = seeded().await else {
        return;
    };
    let page = get(&router, "/search?q=%E8%9C%97%E7%89%9B").await; // 蜗牛
    assert_eq!(page.status, StatusCode::OK);
    assert_eq!(page.cache, "no-store", "search is not edge-cached");
    assert!(
        page.body.contains(r#"href="/item/4000019""#),
        "substring match on items"
    );
    assert!(page.body.contains(r#"href="/mob/2""#));
    let browse = get(&router, "/search?kind=mob").await;
    assert!(
        browse.body.contains(r#"href="/mob/2""#),
        "blank query browses the catalogue"
    );
    assert!(browse.body.contains("data-search-results"));
    // A complete catalogue must remain reachable beyond the first page.
    sqlx::query("INSERT INTO items(id,name_en,category) SELECT n, 'Browse item ' || n, '其他' FROM generate_series(8000001,8000065) n")
        .execute(&db.pool).await.unwrap();
    let first = get(&router, "/search?q=Browse&kind=item").await.body;
    let second = get(&router, "/search?q=Browse&kind=item&page=2").await.body;
    let last = get(&router, "/search?q=Browse&kind=item&page=4").await.body;
    assert!(first.contains("下一页"));
    assert!(!first.contains(r#"href="/item/8000065""#));
    assert!(second.contains(r#"href="/item/8000021""#));
    assert!(second.contains("上一页"));
    assert!(last.contains(r#"href="/item/8000065""#));
    let catalogue = get(&router, "/search?kind=item&page=2").await.body;
    assert!(catalogue.contains(r#"href="/item/8000065""#));

    let english = get(&router, "/search?q=hene").await.body;
    assert!(
        english.contains(r#"href="/map/10001000""#),
        "case-insensitive prefix"
    );
    assert!(english.contains(r#"href="/map/10001010""#));
    let traditional = get(&router, "/search?q=%E5%BC%93%E7%AE%AD%E6%89%8B")
        .await
        .body; // 弓箭手
    assert!(traditional.contains(r#"href="/map/10001000""#));
    let by_id = get(&router, "/search?q=1002000").await.body;
    assert!(by_id.contains(r#"href="/item/1002000""#));
    let cross_catalogue = get(&router, "/search?q=%E8%9C%97%E7%89%9B&kind=mob")
        .await
        .body; // 蜗牛
    assert!(cross_catalogue.contains(r#"href="/mob/2""#));
    assert!(
        cross_catalogue.contains(r#"href="/item/4000019""#),
        "a typed query searches every catalogue even when opened from mobs"
    );
    let wildcard = get(&router, "/search?q=%25").await.body;
    assert!(wildcard.contains("没有找到"), "% is literal");
    db.drop_schema().await;
}

#[tokio::test]
async fn old_stylesheet_url_still_answers() {
    let pool = sqlx::postgres::PgPoolOptions::new()
        .connect_lazy("postgres://nobody@127.0.0.1:1/none")
        .unwrap();
    let router = app(AppState::new(pool, Settings::default()));
    let css = get(&router, "/static/bestiary.css").await;
    assert_eq!(css.status, StatusCode::OK);
    assert!(css.content_type.starts_with("text/css"));
    assert!(
        css.body.contains("web/css"),
        "emptied: styles moved to web/css"
    );
}

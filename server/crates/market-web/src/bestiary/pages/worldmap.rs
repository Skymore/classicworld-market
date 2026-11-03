//! The client's world map as SVG: each region's picture with its spots
//! (the client's marker sprites), linking to their maps; and a route drawn
//! over it. Positions are SVG attributes, so no inline styles. The browser
//! side is `frontend/src/pages/worldmap.tsx`; keep the two in step.

use maud::{html, Markup};

use super::shell::Ctx;
use crate::bestiary::format::Lang;
use crate::bestiary::model::{OverviewRegion, RouteOverview, WorldPage, WorldRegion, WorldSpot};

/// Marker sprite and its size per spot kind (0 town … 4 facility).
pub(crate) fn marker(kind: i16) -> (&'static str, i32) {
    match kind {
        0 => ("/web/images/worldmap/marker-town.png", 22),
        1 => ("/web/images/worldmap/marker-spot.png", 17),
        2 => ("/web/images/worldmap/marker-cluster.png", 22),
        4 => ("/web/images/worldmap/marker-facility.png", 13),
        _ => ("/web/images/worldmap/marker-field.png", 16),
    }
}

/// The world map pictures are small; show them at 1.4x.
const WORLD_SCALE: f64 = 1.4;

pub(crate) fn spot_tip(spot: &WorldSpot, lang: Lang) -> String {
    let mut parts = vec![spot.map.names.get(lang).to_string()];
    match (spot.level_min, spot.level_max) {
        (Some(lo), Some(hi)) if lo == hi => parts.push(format!("Lv.{lo}")),
        (Some(lo), Some(hi)) => parts.push(format!("Lv.{lo}–{hi}")),
        _ => {}
    }
    if spot.map_count > 1 {
        parts.push(match lang {
            Lang::Zh => format!("{} 张地图", spot.map_count),
            Lang::En => format!("{} maps", spot.map_count),
        });
    }
    parts.join(" · ")
}

fn region_svg(ctx: &Ctx, region: &WorldRegion, here: &[String]) -> Markup {
    let lang = ctx.lang;
    let shown = |v: i32| (f64::from(v) * WORLD_SCALE).round() as i32;
    html! {
        figure.wm {
            figcaption { (region.names.get(lang)) }
            div.mapvis-scroll {
                svg.wm-svg xmlns="http://www.w3.org/2000/svg" viewBox={"0 0 " (region.width) " " (region.height)}
                    width=(shown(region.width)) height=(shown(region.height)) role="img"
                    aria-label={(ctx.t("世界地图：", "World map: ")) (region.names.get(lang))} {
                    image.wm-img href=(region.image_url) width=(region.width) height=(region.height) {}
                    @for spot in &region.spots {
                        @let (sprite, size) = marker(spot.kind);
                        @let is_here = here.contains(&spot.key);
                        a.wm-spot.here[is_here] href=(ctx.href(&format!("/map/{}", spot.map.id))) data-kind=(spot.kind) {
                            title { (spot_tip(spot, lang)) }
                            @if is_here { circle.wm-ring cx=(spot.x) cy=(spot.y) r="14" {} }
                            image href=(sprite) x=(spot.x - size / 2) y=(spot.y - size / 2) width=(size) height=(size) {}
                            @if spot.kind == 0 {
                                text.wm-label x=(spot.x) y=(spot.y + size / 2 + 11) { (spot.map.names.get(lang)) }
                            }
                            @if is_here {
                                image.wm-here href="/web/images/worldmap/curpos-0.png" x=(spot.x - 8) y=(spot.y - size / 2 - 35) width="17" height="35" {}
                            }
                        }
                    }
                }
            }
        }
    }
}

/// The world map page: every open region, the asked-for map's spot marked.
pub(crate) fn world_body(ctx: &Ctx, page: &WorldPage) -> Markup {
    html! {
        div.wm-regions {
            @for region in &page.regions { (region_svg(ctx, region, &page.here_spots)) }
        }
        div.wm-keys {
            @for (kind, zh, en) in [(0, "城镇", "Town"), (3, "野外", "Field"), (2, "地下城", "Dungeon"), (1, "地点", "Place"), (4, "设施", "Facility")] {
                @let (sprite, _) = marker(kind);
                span.wm-key { img src=(sprite) alt="" width="16" height="16"; (ctx.t(zh, en)) }
            }
        }
    }
}

/// One region of a route over the world map, zoomed to the stops.
fn overview_region(ctx: &Ctx, region: &OverviewRegion, first: bool, last: bool) -> Markup {
    let lang = ctx.lang;
    let xs = region.stops.iter().map(|s| s.x);
    let ys = region.stops.iter().map(|s| s.y);
    let (x0, x1) = (xs.clone().min().unwrap_or(0), xs.max().unwrap_or(0));
    let (y0, y1) = (ys.clone().min().unwrap_or(0), ys.max().unwrap_or(0));
    // Pad, keep at least 240 x 150, stay inside the picture.
    let pad = 40;
    let w = (x1 - x0 + 2 * pad).max(240).min(region.width);
    let h = (y1 - y0 + 2 * pad).max(150).min(region.height);
    let vx = ((x0 + x1) / 2 - w / 2).clamp(0, region.width - w);
    let vy = ((y0 + y1) / 2 - h / 2).clamp(0, region.height - h);
    let scale = (560.0 / f64::from(w)).min(2.0);
    let points: Vec<String> = region
        .stops
        .iter()
        .map(|s| format!("{},{}", s.x, s.y))
        .collect();
    let n = region.stops.len();
    html! {
        figure.wm.overview {
            figcaption { (region.names.get(lang)) }
            svg.wm-svg xmlns="http://www.w3.org/2000/svg" viewBox={(vx) " " (vy) " " (w) " " (h)}
                width=((f64::from(w) * scale).round() as i32) height=((f64::from(h) * scale).round() as i32) role="img"
                aria-label={(ctx.t("世界地图上的路线：", "Route on the world map: ")) (region.names.get(lang))} {
                image.wm-img href=(region.image_url) width=(region.width) height=(region.height) {}
                polyline.wm-path points=(points.join(" ")) {}
                @for (i, stop) in region.stops.iter().enumerate() {
                    @let start = first && i == 0;
                    @let end = last && i + 1 == n;
                    a href=(ctx.href(&format!("/map/{}", stop.map.id))) {
                        title { (i + 1) ". " (stop.map.names.get(lang)) }
                        circle.wm-stop.start[start].end[end] cx=(stop.x) cy=(stop.y) r=(if start || end { "7" } else { "4.5" }) {}
                    }
                    @if start || end {
                        text.wm-label.wm-stop-label x=(stop.x) y=(stop.y - 11) { (stop.map.names.get(lang)) }
                    }
                }
            }
        }
    }
}

pub(crate) fn route_overview(ctx: &Ctx, overview: &RouteOverview) -> Markup {
    let n = overview.regions.len();
    html! {
        div.wm-overview {
            @for (i, region) in overview.regions.iter().enumerate() {
                (overview_region(ctx, region, i == 0, i + 1 == n))
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::bestiary::model::{MapRef, Names, OverviewStop};

    fn ctx() -> Ctx {
        Ctx {
            lang: Lang::Zh,
            here: "/world".into(),
            now: chrono::Utc::now(),
        }
    }

    fn spot(key: &str, kind: i16, id: i32, name: &str) -> WorldSpot {
        WorldSpot {
            key: key.into(),
            x: 100,
            y: 200,
            kind,
            map: MapRef::new(id, name, "en"),
            map_count: 19,
            level_min: Some(8),
            level_max: Some(40),
        }
    }

    #[test]
    fn spots_link_their_maps_and_the_asked_map_is_marked() {
        let page = WorldPage {
            regions: vec![WorldRegion {
                id: "VictoriaIsland".into(),
                names: Names::new("金银岛", "Victoria Island"),
                image_url: "/web/images/worldmap/victoria-island.webp".into(),
                width: 636,
                height: 466,
                spots: vec![spot("W:10", 0, 10001000, "射手村")],
            }],
            here: Some(MapRef::new(10001001, "射手村民宅", "en")),
            here_spots: vec!["W:10".into()],
        };
        let html = world_body(&ctx(), &page).into_string();
        assert!(html.contains(r#"href="/map/10001000""#));
        assert!(html.contains("<title>射手村 · Lv.8–40 · 19 张地图</title>"));
        assert!(html.contains("marker-town.png") && html.contains("curpos-0.png"));
        assert!(
            html.contains(r#"<text class="wm-label" x="100" y="222">射手村</text>"#),
            "{html}"
        );
        assert!(!html.contains("style="));
    }

    #[test]
    fn a_route_is_a_line_through_its_spots() {
        let stop = |x, y, id| OverviewStop {
            x,
            y,
            map: MapRef::new(id, format!("m{id}"), "en"),
        };
        let html = route_overview(
            &ctx(),
            &RouteOverview {
                regions: vec![OverviewRegion {
                    id: "VictoriaIsland".into(),
                    names: Names::new("金银岛", "Victoria Island"),
                    image_url: "/x.webp".into(),
                    width: 636,
                    height: 466,
                    stops: vec![stop(300, 200, 1), stop(320, 230, 2), stop(400, 260, 3)],
                }],
            },
        )
        .into_string();
        assert!(html.contains(r#"points="300,200 320,230 400,260""#));
        assert!(html.contains("wm-stop start") && html.contains("wm-stop end"));
        assert!(
            html.contains(">m1</text>")
                && html.contains(">m3</text>")
                && !html.contains(">m2</text>")
        );
    }
}

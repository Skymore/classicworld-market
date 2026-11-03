//! The map view: the client minimap as an SVG with each monster's head on
//! its spawn points, portals that link to where they lead, and NPCs.
//! Positions and sizes are SVG attributes in the minimap's own units, so the
//! page still needs no inline styles. `frontend/src/pages/mapview.tsx` draws
//! the same picture and adds the toggles; keep the two in step.

use maud::{html, Markup};

use super::shell::Ctx;
use crate::bestiary::format::Lang;
use crate::bestiary::model::{MapMob, MapView, Point, PortalPoint, SceneImage};

/// A mob's head icon, made by `tools/niadb_map_assets.py heads`.
pub(crate) fn head_url(mob_id: i32) -> String {
    format!("/web/images/mobs/head/{mob_id}.png")
}

/// Wide maps keep a readable size on phones and scroll sideways instead.
fn wide(view: &MapView) -> bool {
    view.width > view.height * 5 / 2
}

#[derive(Default)]
pub(crate) struct Marks<'a> {
    /// Monster names for the spawn tooltips (the map page's mob list).
    pub mobs: &'a [MapMob],
    /// The NPC the page is about, drawn larger.
    pub npc: Option<i32>,
    /// A route step: the portal to take and where the player starts.
    pub exit: Option<Point>,
    pub arrival: Option<Point>,
    /// `exit` is an NPC (ship, taxi), not a portal.
    pub exit_npc: bool,
    /// Markers are links (map and NPC pages), not on a route step whose
    /// row is already one.
    pub links: bool,
    /// Draw the minimap instead of the scene: route steps after the first,
    /// whose scenes the browser side loads as they scroll into view.
    pub defer_scene: bool,
}

/// What the page around a map view takes from the screen width on phones: a
/// map page's margins (route steps sit further in, so for them `sizes` says a
/// little more than they show). Keep in step with `frontend/src/pages/mapview.tsx`.
const PHONE_MARGIN: i32 = 64;

/// `sizes` for the scene picture: about the svg's width on screen. Phones
/// show it at the page's width, and wide maps at least 640 px (dex.css).
pub(crate) fn scene_sizes(view: &MapView) -> String {
    let w = view.shown_width;
    let fit = format!(
        "(max-width: {}px) calc(100vw - {PHONE_MARGIN}px), {w}px",
        w + PHONE_MARGIN
    );
    if wide(view) {
        format!("(max-width: 700px) 640px, {fit}")
    } else {
        fit
    }
}

/// The scene as an `<img>`, so the browser picks the phone copy through
/// `srcset`; the `<foreignObject>` places it in the view's units like an
/// `<image>` would.
fn scene_picture(view: &MapView, scene: &SceneImage) -> Markup {
    let srcset = scene
        .small_url
        .as_ref()
        .zip(scene.small_px)
        .map(|(small, small_px)| format!("{small} {small_px}w, {} {}w", scene.url, scene.px));
    html! {
        foreignObject.mv-scene x=(scene.x) y=(scene.y) width=(scene.width) height=(scene.height) {
            img src=(scene.url) srcset=[srcset.as_ref()] sizes=[srcset.as_ref().map(|_| scene_sizes(view))] alt="";
        }
    }
}

fn respawn_note(seconds: i32, lang: Lang) -> Option<String> {
    (seconds > 0).then(|| {
        let minutes = (seconds + 30) / 60;
        match (lang, minutes) {
            (Lang::Zh, 0) => format!("{seconds} 秒后重生"),
            (Lang::Zh, m) => format!("约 {m} 分钟重生"),
            (Lang::En, 0) => format!("respawns in {seconds}s"),
            (Lang::En, m) => format!("respawns in ~{m} min"),
        }
    })
}

pub(crate) fn map_svg(ctx: &Ctx, view: &MapView, title: &str, marks: &Marks) -> Markup {
    let lang = ctx.lang;
    let u = f64::from(view.icon);
    let label = format!("{}{title}", ctx.t("小地图：", "Minimap: "));
    let mob_label = |id: i32| {
        marks.mobs.iter().find(|m| m.mob.id == id).map_or_else(
            || format!("#{id}"),
            |m| match m.mob.level {
                Some(lv) => format!("{} Lv.{lv}", m.mob.names.get(lang)),
                None => m.mob.names.get(lang).to_string(),
            },
        )
    };
    html! {
        div.mapvis-scroll {
            svg.mapvis-svg.wide[wide(view)] xmlns="http://www.w3.org/2000/svg"
                viewBox={"0 0 " (view.width) " " (view.height)}
                width=(view.shown_width) height=(view.shown_height) role="img" aria-label=(label) {
                rect.mv-bg width=(view.width) height=(view.height) {}
                @if let Some(scene) = view.scene.as_ref().filter(|_| !marks.defer_scene) {
                    (scene_picture(view, scene))
                } @else if let Some(url) = &view.image_url {
                    image.mv-img href=(url) width=(view.width) height=(view.height) preserveAspectRatio="none" {}
                }
                g.mv-mobs {
                    @for s in &view.spawns {
                        @let tip = match respawn_note(s.mob_time, lang) {
                            Some(note) => format!("{} · {note}", mob_label(s.mob_id)),
                            None => mob_label(s.mob_id),
                        };
                        @let body = html! {
                            title { (tip) }
                            ellipse.mv-shadow cx=(s.x) cy=(s.y) rx=(fmt(u * 0.36)) ry=(fmt(u * 0.12)) {}
                            @if s.mob_time > 0 {
                                circle.mv-timed cx=(s.x) cy=(fmt(f64::from(s.y) - u * 0.5)) r=(fmt(u * 0.62)) {}
                            }
                            image href=(head_url(s.mob_id)) x=(fmt(f64::from(s.x) - u / 2.0)) y=(fmt(f64::from(s.y) - u))
                                width=(view.icon) height=(view.icon) {}
                        };
                        @if marks.links {
                            a.mv-mob href=(ctx.href(&format!("/mob/{}", s.mob_id))) data-mob=(s.mob_id) { (body) }
                        } @else {
                            g.mv-mob data-mob=(s.mob_id) { (body) }
                        }
                    }
                }
                g.mv-npcs {
                    @for n in &view.npcs {
                        @let big = marks.npc == Some(n.npc.id);
                        @let r = if big { u * 0.55 } else { u * 0.34 };
                        @let cy = f64::from(n.y) - r - u * 0.1;
                        @let body = html! {
                            title { "NPC · " (n.npc.label(lang)) }
                            circle.mv-npc.here[big] cx=(n.x) cy=(fmt(cy)) r=(fmt(r)) {}
                            text.mv-npc-t x=(n.x) y=(fmt(cy + r * 0.38)) font-size=(fmt(r * 1.1)) { "N" }
                        };
                        @if marks.links && !big {
                            a href=(ctx.href(&format!("/npc/{}", n.npc.id))) { (body) }
                        } @else {
                            g { (body) }
                        }
                    }
                }
                g.mv-portals {
                    @for p in &view.portals {
                        @let cy = fmt(f64::from(p.y) - u * 0.45);
                        @let hidden = p.portal_type == Some(1);
                        @let body = html! {
                            title { (portal_tip(ctx, p)) }
                            circle.mv-portal.hidden[hidden] cx=(p.x) cy=(cy) r=(fmt(u * 0.36)) {}
                            circle.mv-portal-core cx=(p.x) cy=(cy) r=(fmt(u * 0.14)) {}
                        };
                        @if marks.links {
                            a href=(ctx.href(&format!("/map/{}", p.to.id))) { (body) }
                        } @else {
                            g { (body) }
                        }
                    }
                }
                @if marks.exit.is_some() || marks.arrival.is_some() {
                    g.mv-route {
                        @if let (Some(a), Some(e)) = (marks.arrival, marks.exit) {
                            line.mv-path x1=(a.x) y1=(fmt(f64::from(a.y) - u * 0.45)) x2=(e.x) y2=(fmt(f64::from(e.y) - u * 0.45))
                                stroke-width=(fmt(u * 0.12)) stroke-dasharray={(fmt(u * 0.4)) " " (fmt(u * 0.25))} {}
                        }
                        @if let Some(a) = marks.arrival {
                            circle.mv-arrival cx=(a.x) cy=(fmt(f64::from(a.y) - u * 0.45)) r=(fmt(u * 0.5)) stroke-width=(fmt(u * 0.14)) {
                                title { (ctx.t("你从这里进入", "You arrive here")) }
                            }
                        }
                        @if let Some(e) = marks.exit {
                            circle.mv-exit cx=(e.x) cy=(fmt(f64::from(e.y) - u * 0.45)) r=(fmt(u * 0.7)) stroke-width=(fmt(u * 0.16)) {
                                title { (if marks.exit_npc { ctx.t("找这个 NPC", "Talk to this NPC") } else { ctx.t("走这个传送口", "Take this portal") }) }
                            }
                        }
                    }
                }
            }
        }
    }
}

/// "传送口 → 射手村", noting portals the game does not draw.
pub(crate) fn portal_tip(ctx: &Ctx, p: &PortalPoint) -> String {
    let to = p.to.names.get(ctx.lang);
    match p.portal_type {
        Some(1) => format!(
            "{}{to}{}",
            ctx.t("隐藏传送口 → ", "Hidden portal → "),
            ctx.t(
                "（游戏里看不到，站在这里按↑）",
                " (not drawn in game; stand here and press up)"
            )
        ),
        Some(3) => format!(
            "{}{to}{}",
            ctx.t("传送口 → ", "Portal → "),
            ctx.t("（走进去就传送）", " (walk into it)")
        ),
        _ => format!("{}{to}", ctx.t("传送口 → ", "Portal → ")),
    }
}

/// The legend under a map page's view: each monster's head and spawn count.
pub(crate) fn mob_legend(ctx: &Ctx, mobs: &[MapMob]) -> Markup {
    html! {
        div.mv-legend {
            @for m in mobs {
                a.mv-chip href=(ctx.href(&format!("/mob/{}", m.mob.id))) {
                    img src=(head_url(m.mob.id)) alt="" width="20" height="20" loading="lazy";
                    span { (m.mob.names.get(ctx.lang)) }
                    small { (m.spawn_count) }
                }
            }
            span.mv-key.portal { (ctx.t("传送口", "Portal")) }
            span.mv-key.npc { "NPC" }
        }
    }
}

/// One decimal is plenty for coordinates in minimap units.
fn fmt(v: f64) -> String {
    let r = (v * 10.0).round() / 10.0;
    if r.fract() == 0.0 {
        format!("{r:.0}")
    } else {
        format!("{r:.1}")
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::bestiary::model::{
        MapRef, MobRef, Names, NpcPoint, NpcRef, PortalPoint, SpawnPoint,
    };

    fn ctx() -> Ctx {
        Ctx {
            lang: Lang::Zh,
            here: "/map/1000".into(),
            now: chrono::Utc::now(),
        }
    }

    fn view() -> MapView {
        MapView {
            width: 3928,
            height: 2050,
            shown_width: 880,
            shown_height: 459,
            icon: 107,
            image_url: Some("/web/images/minimaps/1000.png".into()),
            scene: None,
            spawns: vec![SpawnPoint {
                mob_id: 4,
                x: 2721,
                y: 1350,
                mob_time: 0,
            }],
            portals: vec![PortalPoint {
                x: 88,
                y: 1681,
                to: MapRef::new(50, "岔路", "A Split Road"),
                name: Some("west00".into()),
                portal_type: Some(1),
            }],
            npcs: vec![NpcPoint {
                npc: NpcRef {
                    id: 7,
                    names: Some(Names::new("NPC 七", "Seven")),
                },
                x: 500,
                y: 600,
            }],
            player_spawn: Some(Point { x: 388, y: 1586 }),
        }
    }

    #[test]
    fn markers_sit_on_their_points_and_link_out() {
        let ctx = ctx();
        let mobs = [MapMob {
            mob: MobRef {
                id: 4,
                names: Names::new("蘑菇仔", "Shroom"),
                level: Some(3),
                image_id: None,
            },
            spawn_count: 1,
        }];
        let html = map_svg(
            &ctx,
            &view(),
            "彩虹村西边草原",
            &Marks {
                mobs: &mobs,
                links: true,
                ..Marks::default()
            },
        )
        .into_string();
        assert!(html.contains(r#"viewBox="0 0 3928 2050""#), "{html}");
        // The head stands on the spawn point: bottom edge at y, centred on x.
        assert!(
            html.contains(r#"x="2667.5" y="1243" width="107" height="107""#),
            "{html}"
        );
        assert!(html.contains("<title>蘑菇仔 Lv.3</title>"));
        assert!(html.contains(r#"href="/map/50""#));
        assert!(
            html.contains("mv-portal hidden") && html.contains("站在这里按↑"),
            "hidden portal"
        );
        assert!(html.contains(r#"href="/npc/7""#));
        assert!(html.contains(r#"href="/mob/4""#));
        assert!(!html.contains("style="), "no inline styles under the CSP");
        assert!(html.contains("mv-img"), "the minimap without a scene");
        let mut with_scene = view();
        with_scene.scene = Some(SceneImage::new(
            "/web/images/scenes/1000.webp".into(),
            0,
            0,
            3928,
            2050,
        ));
        let html = map_svg(&ctx, &with_scene, "x", &Marks::default()).into_string();
        assert!(
            html.contains(r#"<foreignObject class="mv-scene" x="0" y="0" width="3928" height="2050"><img src="/web/images/scenes/1000.webp" srcset="/web/images/scenes/small/1000.webp 1100w, /web/images/scenes/1000.webp 1760w" sizes="(max-width: 944px) calc(100vw - 64px), 880px" alt=""></foreignObject>"#),
            "{html}"
        );
        assert!(!html.contains("mv-img"));
        // A later route step waits with the minimap.
        let html = map_svg(
            &ctx,
            &with_scene,
            "x",
            &Marks {
                defer_scene: true,
                ..Marks::default()
            },
        )
        .into_string();
        assert!(
            html.contains("mv-img") && !html.contains("scenes/"),
            "{html}"
        );
    }

    #[test]
    fn scene_widths_follow_the_tool() {
        // Wide: both copies limited by width.
        let s = SceneImage::new("/s/1.webp".into(), 0, 0, 3928, 2050);
        assert_eq!((s.px, s.small_px), (1760, Some(1100)));
        assert_eq!(s.small_url.as_deref(), Some("/s/small/1.webp"));
        // Tall: limited by height.
        let s = SceneImage::new("/s/2.webp".into(), 0, 0, 1082, 4498);
        assert_eq!((s.px, s.small_px), (250, Some(156)));
        // Small enough already: no phone copy.
        let s = SceneImage::new("/s/3.webp".into(), 0, 0, 900, 600);
        assert_eq!((s.px, s.small_px, s.small_url), (900, None, None));
        let mut wide = view();
        wide.width = 6000;
        wide.height = 1000;
        wide.shown_width = 560;
        assert_eq!(
            scene_sizes(&wide),
            "(max-width: 700px) 640px, (max-width: 624px) calc(100vw - 64px), 560px"
        );
    }

    #[test]
    fn route_steps_mark_the_exit_without_links() {
        let ctx = ctx();
        let html = map_svg(
            &ctx,
            &view(),
            "x",
            &Marks {
                exit: Some(Point { x: 88, y: 1681 }),
                arrival: Some(Point { x: 388, y: 1586 }),
                ..Marks::default()
            },
        )
        .into_string();
        assert!(
            html.contains("mv-exit") && html.contains("mv-arrival") && html.contains("mv-path")
        );
        assert!(!html.contains("<a "), "{html}");
    }

    #[test]
    fn timed_spawns_say_when_they_return() {
        assert_eq!(respawn_note(0, Lang::Zh), None);
        assert_eq!(respawn_note(45, Lang::Zh).as_deref(), Some("约 1 分钟重生"));
        assert_eq!(
            respawn_note(20, Lang::En).as_deref(),
            Some("respawns in 20s")
        );
        assert_eq!(fmt(12.0), "12");
        assert_eq!(fmt(12.34), "12.3");
    }
}

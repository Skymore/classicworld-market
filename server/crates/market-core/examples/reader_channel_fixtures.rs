//! Synthetic screen-share sequence for the browser collector regression test.
//! cargo run --release -p market-core --example reader_channel_fixtures -- DIR
#[path = "../tests/support/synth.rs"]
mod synth;

use synth::*;

fn main() {
    let dir = std::path::PathBuf::from(std::env::args().nth(1).expect("output directory"));
    std::fs::create_dir_all(&dir).expect("create directory");
    let mut scene = SceneSpec {
        seed: 3,
        map_bar: Some("Hidden Street : Free Market <4>"),
        ..SceneSpec::default()
    };
    for channel in [12, 21, 33, 60] {
        scene.menu = Some(MenuSpec {
            at: (480, 120),
            wb: 400,
            channels: 60,
            blue: channel,
            dark: None,
        });
        let frame = stretch_bilinear(&render_game(&scene), 1920, 1080);
        std::fs::write(dir.join(format!("channel_{channel}.raw")), frame.data).expect("write menu");
    }
    scene.menu = None;
    scene.shop = Some(ShopSpec {
        title: "Cheap ores here",
        seller: Some("Grantx"),
        at: (420, 90),
        rows: vec![
            row("Iron Ore", 10, 45_000, false),
            row("Red Potion", 100, 2_500, false),
            row("Mana Elixir", 1, 9_999, true),
            row("Arrows for Bows", 1_000, 45_000, false),
            row("Garnet Ore", 11, 1_234_567, true),
        ],
    });
    let frame = stretch_bilinear(&render_game(&scene), 1920, 1080);
    std::fs::write(dir.join("collect_e2e_1920x1080.raw"), frame.data).expect("write shop");
}

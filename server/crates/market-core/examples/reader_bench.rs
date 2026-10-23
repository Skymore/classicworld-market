//! Per-frame timings of the screen reader on synthetic 1920x1080 frames.
//! Run: cargo run --release -p market-core --example reader_bench

#[path = "../tests/support/synth.rs"]
mod synth;

use std::time::Instant;

use market_core::reader::pipeline::{find_window, read_frame_with, FrameOptions, ReaderCache};
use market_core::reader::{templates, RgbaBuf};
use synth::*;

fn shop() -> ShopSpec {
    ShopSpec {
        title: "Cheap ores here",
        seller: Some("Grantx"),
        at: (420, 90),
        rows: vec![
            row("Iron Ore", 10, 45_000, false),
            row("Red Potion", 100, 2_500, false),
            row("Mana Elixir", 1, 9_999, true),
            row("Arrows for Bows", 1_000, 45_000, false),
            row("Garnet Ore", 11, 1_234_567, true),
            row("Bronze Ore", 5, 300, false),
        ],
    }
}

/// The 1366x768 game drawn 1:1 in the middle of a 1920x1080 desktop share.
fn windowed(game: &RgbaBuf) -> RgbaBuf {
    let mut f = RgbaBuf::filled(1920, 1080, [32, 36, 44]);
    let (ox, oy) = (277, 156);
    for y in 0..game.height {
        for x in 0..game.width {
            let i = (y * game.width + x) * 4;
            f.set(
                ox + x,
                oy + y,
                [game.data[i], game.data[i + 1], game.data[i + 2]],
            );
        }
    }
    f
}

fn ms(f: impl FnOnce()) -> f64 {
    let t = Instant::now();
    f();
    t.elapsed().as_secs_f64() * 1000.0
}

fn stats(mut v: Vec<f64>) -> String {
    v.sort_by(f64::total_cmp);
    format!(
        "median {:7.2} ms  max {:7.2} ms",
        v[v.len() / 2],
        v[v.len() - 1]
    )
}

fn main() {
    let t0 = Instant::now();
    templates::get();
    println!(
        "templates parsed once: {:.1} ms",
        t0.elapsed().as_secs_f64() * 1000.0
    );
    let with_shop = SceneSpec {
        shop: Some(shop()),
        map_bar: Some("Hidden Street : Free Market <4>"),
        seed: 3,
        ..SceneSpec::default()
    };
    let empty = SceneSpec {
        map_bar: Some("Hidden Street : Free Market <4>"),
        seed: 3,
        ..SceneSpec::default()
    };
    let game = render_game(&with_shop);
    let cases = [
        (
            "fullscreen x1.406 (smooth)",
            stretch_bilinear(&game, 1920, 1080),
        ),
        ("windowed 1366x768 at 1x", windowed(&game)),
        (
            "no shop window",
            stretch_bilinear(&render_game(&empty), 1920, 1080),
        ),
        ("noise", noise_frame(1920, 1080, 1)),
    ];
    const N: usize = 15;
    // --dump DIR: also write each frame as raw RGBA (for the WASM timing script), and a
    // 5-row fullscreen frame for the page's headless check (server/tools/collect_e2e.mjs).
    let args: Vec<String> = std::env::args().collect();
    let dump = args
        .iter()
        .position(|a| a == "--dump")
        .and_then(|i| args.get(i + 1));
    if let Some(dir) = dump {
        let mut e2e = with_shop.clone();
        e2e.shop.as_mut().expect("shop").rows.pop();
        let f = stretch_bilinear(&render_game(&e2e), 1920, 1080);
        std::fs::write(format!("{dir}/collect_e2e_1920x1080.raw"), &f.data).expect("write frame");
    }
    for (i, (label, frame)) in cases.iter().enumerate() {
        if let Some(dir) = dump {
            let path = format!("{dir}/frame{i}_{}x{}.rgba", frame.width, frame.height);
            std::fs::write(&path, &frame.data).expect("write frame");
        }
        let img = frame.view();
        println!("\n{label} ({}x{})", img.width, img.height);
        // Window finding as the page does it: no hint, the session's scale lock once known.
        let mut cache = ReaderCache::default();
        let cold = ms(|| {
            find_window(&img, None, &mut cache);
        });
        let lock = find_window(&img, None, &mut cache).map(|w| w.ui_scale);
        let warm: Vec<f64> = (0..N)
            .map(|_| {
                ms(|| {
                    find_window(&img, lock, &mut cache);
                })
            })
            .collect();
        println!("  find window   first {cold:7.2} ms   then {}", stats(warm));
        // The whole frame: rows, title hash, seller, channel check, minimap.
        let opts = FrameOptions {
            lock_scale: lock,
            ..FrameOptions::default()
        };
        let mut cache = ReaderCache::default();
        let mut rows = 0;
        let first = ms(|| rows = read_frame_with(&img, &opts, &mut cache).rows.len());
        let warm: Vec<f64> = (0..N)
            .map(|_| ms(|| rows = read_frame_with(&img, &opts, &mut cache).rows.len()))
            .collect();
        println!(
            "  read frame    first {first:7.2} ms   then {}   ({rows} rows)",
            stats(warm)
        );
    }
}

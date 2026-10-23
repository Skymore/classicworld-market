//! The reader on synthetic frames: a shop window drawn from the embedded
//! templates at 1x, 1.5x and fullscreen 1080p, atlas-drawn rows, the channel
//! menu, the minimap bar, and garbage frames that must give no rows.

#[path = "support/synth.rs"]
mod synth;

use market_core::reader::pipeline::{read_frame_with, FrameOptions, ReaderCache};
use market_core::reader::row::{RowOptions, RowReader};
use market_core::reader::session::{Session, SessionConfig};
use market_core::reader::{read_frame, FrameRead, RgbaBuf};
use synth::*;

fn shop(at: (usize, usize), title: &'static str) -> ShopSpec {
    ShopSpec {
        title,
        seller: Some("Grantx"),
        at,
        rows: vec![
            row("Iron Ore", 10, 45_000, false),
            row("Red Potion", 100, 2_500, false),
            row("Mana Elixir", 1, 9_999, true),
            row("Arrows for Bows", 1_000, 45_000, false),
            row("Garnet Ore", 11, 1_234_567, true),
        ],
    }
}

/// (slot, item id, price, bundle, sold) of the rows `shop` draws.
const EXPECTED: [(u8, u32, u64, u32, bool); 5] = [
    (1, 4_010_001, 45_000, 10, false),
    (2, 2_000_000, 2_500, 100, false),
    (3, 2_000_006, 9_999, 1, true),
    (4, 2_060_000, 45_000, 1_000, false),
    (5, 4_020_000, 1_234_567, 11, true),
];

fn read(img: &RgbaBuf) -> FrameRead {
    read_frame(&img.view(), None)
}

fn assert_shop(fr: &FrameRead) {
    let w = fr.window.as_ref().expect("shop window found");
    assert!(!w.full, "5 rows leave the last band empty");
    assert!(fr.rejected.is_empty(), "rejected: {:?}", fr.rejected);
    let got: Vec<_> = fr
        .rows
        .iter()
        .map(|r| (r.slot, r.item_id, r.price, r.bundle, r.sold))
        .collect();
    assert_eq!(got, EXPECTED.to_vec());
    for r in &fr.rows {
        assert!(r.exact, "{r:?}");
        assert_eq!(r.confidence, 1.0);
        assert_eq!(r.stock, r.sold.then_some(0));
        assert!((r.unit_price - r.price as f64 / r.bundle as f64).abs() < 1e-9);
    }
    assert!(fr.title_hash.is_some());
    assert_eq!(fr.seller.as_deref(), Some("Grantx"));
}

fn scene(at: (usize, usize), title: &'static str) -> SceneSpec {
    SceneSpec {
        shop: Some(shop(at, title)),
        seed: 3,
        ..SceneSpec::default()
    }
}

#[test]
fn reads_a_shop_at_1x() {
    let game = render_game(&scene((300, 150), "Cheap ores here"));
    let fr = read(&game);
    assert_shop(&fr);
    let w = fr.window.unwrap();
    assert!((w.game_scale - 1.0).abs() < 0.03, "{w:?}");
}

#[test]
fn reads_a_shop_stretched_1_5x() {
    let game = render_game(&scene((300, 150), "Cheap ores here"));
    let frame = stretch_bilinear(&game, 2049, 1152);
    let fr = read(&frame);
    assert_shop(&fr);
    assert!((fr.window.unwrap().game_scale - 1.5).abs() < 0.03);
}

#[test]
fn reads_a_fullscreen_1080p_shop() {
    let game = render_game(&scene((420, 90), "Potions and ores"));
    let frame = stretch_bilinear(&game, 1920, 1080);
    let fr = read(&frame);
    assert_shop(&fr);
}

#[test]
fn reads_a_1x_window_in_a_1080p_desktop_share() {
    let game = render_game(&scene((300, 150), "Cheap ores here"));
    let mut frame = RgbaBuf::filled(1920, 1080, [32, 36, 44]);
    for y in 0..game.height {
        for x in 0..game.width {
            let i = (y * game.width + x) * 4;
            frame.set(
                277 + x,
                156 + y,
                [game.data[i], game.data[i + 1], game.data[i + 2]],
            );
        }
    }
    let fr = read(&frame);
    assert_shop(&fr);
    assert!((fr.window.unwrap().game_scale - 1.0).abs() < 0.03);
}

#[test]
fn a_sharp_stretch_reads_right_or_not_at_all() {
    let game = render_game(&scene((420, 90), "Potions and ores"));
    let fr = read(&stretch_nearest(&game, 1920, 1080));
    for r in &fr.rows {
        let e = EXPECTED.iter().find(|e| e.0 == r.slot).expect("slot");
        assert_eq!(
            (r.item_id, r.price, r.bundle, r.sold),
            (e.1, e.2, e.3, e.4),
            "{r:?}"
        );
    }
    assert_eq!(fr.rows.len() + fr.rejected.len(), 5);
}

#[test]
fn title_hash_follows_the_title_not_the_place() {
    let a = read(&render_game(&scene((300, 150), "Cheap ores here"))).title_hash;
    let b = read(&render_game(&scene((517, 203), "Cheap ores here"))).title_hash;
    let c = read(&render_game(&scene((300, 150), "Cheap ores her"))).title_hash;
    assert!(a.is_some());
    assert_eq!(a, b);
    assert_ne!(a, c);
}

#[test]
fn garbage_frames_give_no_rows() {
    let black = RgbaBuf::filled(1920, 1080, [0, 0, 0]);
    let fr = read(&black);
    assert!(!fr.game_seen && fr.rows.is_empty() && fr.window.is_none());
    let grey = RgbaBuf::filled(1366, 768, [128, 128, 128]);
    assert!(read(&grey).rows.is_empty());
    for (w, h, seed) in [(1366, 768, 1), (1920, 1080, 2), (2560, 1440, 3)] {
        let fr = read(&noise_frame(w, h, seed));
        assert!(
            fr.rows.is_empty() && fr.window.is_none(),
            "noise {w}x{h}: {:?}",
            fr.window
        );
        assert!(fr.channel.is_none() && fr.map.is_none());
    }
    let empty = render_game(&SceneSpec {
        seed: 9,
        ..SceneSpec::default()
    });
    let fr = read(&empty);
    assert!(fr.rows.is_empty() && fr.window.is_none());
}

#[test]
fn rows_of_noise_in_a_real_window_are_rejected() {
    let mut game = render_game(&scene((300, 150), "Cheap ores here"));
    let mut rng = Lcg::new(77);
    // Scramble the text boxes of all rows.
    for band in 0..5 {
        let top = 150 + 153 + 40 * band;
        for y in top + 2..top + 36 {
            for x in 300 + 41..300 + 203 {
                let v = (rng.next() % 256) as u8;
                game.set(x, y, [v, v, v]);
            }
        }
    }
    let fr = read(&game);
    assert!(fr.window.is_some());
    assert!(fr.rows.is_empty(), "{:?}", fr.rows);
}

#[test]
fn a_covered_row_is_rejected_and_the_rest_read() {
    let mut game = render_game(&scene((300, 150), "Cheap ores here"));
    // A cursor-like patch over the second row's price.
    let top = 150 + 153 + 40;
    for y in top + 20..top + 34 {
        for x in 300 + 110..300 + 130 {
            game.set(x, y, [255, 255, 255]);
        }
    }
    let fr = read(&game);
    assert_eq!(fr.rows.len(), 4);
    assert!(fr.rows.iter().all(|r| r.slot != 2));
    let rej = fr
        .rejected
        .iter()
        .find(|r| r.slot == 2)
        .expect("row 2 rejected");
    assert!(rej.covered, "{rej:?}");
}

#[test]
fn atlas_drawn_rows_read_with_the_matcher() {
    let cases = [
        (10, 45_000, "Iron Ore", false, 1.0),
        (3, 1_200, "Red Potion", true, 1.0),
        (250, 7_654_321, "Garnet Ore", false, 1.3),
        (1, 999, "Mana Elixir", false, 0.8),
    ];
    for (qty, price, name, sold, s) in cases {
        let img = atlas_row(qty, price, name, sold, s);
        let mut reader = RowReader::default();
        let r = reader.read(&img.view(), &RowOptions::default());
        assert!(!r.abstain, "{qty} for {price} at {s}: {r:?}");
        assert_eq!(
            (r.qty, r.price, r.sold),
            (Some(qty), Some(price), Some(sold)),
            "{r:?}"
        );
        assert!(!r.exact);
        assert!(r.confidence >= 0.05, "{r:?}");
        // The scale lock: a second row of the same size reads the same way.
        let again = reader.read(&img.view(), &RowOptions::default());
        assert_eq!((again.qty, again.price), (Some(qty), Some(price)));
    }
}

#[test]
fn channel_menu() {
    let mut s = SceneSpec {
        seed: 5,
        menu: Some(MenuSpec {
            at: (480, 220),
            wb: 400,
            channels: 20,
            blue: 7,
            dark: None,
        }),
        ..SceneSpec::default()
    };
    let fr = read(&render_game(&s));
    let ch = fr.channel.expect("menu read");
    assert_eq!((ch.channel, ch.picked, ch.buttons), (7, None, 20));
    // A pick: the picked button is blue, the player's own dark.
    s.menu.as_mut().unwrap().dark = Some(3);
    let ch = read(&stretch_bilinear(&render_game(&s), 1920, 1080))
        .channel
        .expect("menu read at 1080p");
    assert_eq!((ch.channel, ch.picked), (3, Some(7)));
    // Two blue buttons: no channel.
    s.menu.as_mut().unwrap().dark = None;
    let mut img = render_game(&s);
    let m = s.menu.as_ref().unwrap();
    let bx = m.at.0 + (0.1257 * 2.0 * m.wb as f64).round() as usize;
    let by = m.at.1 + (0.0729 * m.wb as f64).round() as usize;
    for y in by..by + 14 {
        for x in bx..bx + 48 {
            img.set(x, y, [40, 100, 230]);
        }
    }
    assert!(read(&img).channel.is_none());
}

#[test]
fn minimap_bar() {
    let s = SceneSpec {
        seed: 4,
        map_bar: Some("Hidden Street : Free Market <4>"),
        ..SceneSpec::default()
    };
    let m = read(&render_game(&s)).map.expect("bar read");
    assert_eq!(
        (m.name.as_str(), m.room, m.bar),
        ("Free Market <4>", Some(4), true)
    );
    let m = read(&stretch_bilinear(&render_game(&s), 1920, 1080))
        .map
        .expect("bar read at 1080p");
    assert_eq!(m.name, "Free Market <4>");
    // Not a catalog name: no map.
    let s = SceneSpec {
        seed: 4,
        map_bar: Some("Hidden Street : Free Markt <4>"),
        ..SceneSpec::default()
    };
    assert!(read(&render_game(&s)).map.is_none());
}

#[test]
fn extended_channel_menus_keep_ch12_and_read_high_channels() {
    for channels in [20, 21, 24, 32, 40, 50, 60, 80] {
        for blue in [12, channels as u8] {
            let spec = SceneSpec {
                seed: 5,
                menu: Some(MenuSpec {
                    at: (480, 120),
                    wb: 400,
                    channels,
                    blue,
                    dark: None,
                }),
                ..SceneSpec::default()
            };
            for (width, height) in [(1366, 768), (1920, 1080), (1366, 900)] {
                let image = stretch_bilinear(&render_game(&spec), width, height);
                let ch = read(&image).channel.unwrap_or_else(|| {
                    panic!("no channel in {channels}-button menu, CH{blue}, {width}x{height}")
                });
                assert_eq!((ch.channel, ch.buttons), (blue, channels));
            }
        }
    }
}

#[test]
fn extended_menu_pick_does_not_replace_current_channel() {
    let spec = SceneSpec {
        menu: Some(MenuSpec {
            at: (480, 120),
            wb: 400,
            channels: 60,
            blue: 33,
            dark: Some(12),
        }),
        ..SceneSpec::default()
    };
    let image = stretch_bilinear(&render_game(&spec), 1920, 1080);
    let channel = read(&image)
        .channel
        .expect("extended menu with pending selection");
    assert_eq!(
        (channel.channel, channel.picked, channel.buttons),
        (12, Some(33), 60)
    );
    // A cropped menu must not be mistaken for a shorter menu.
    let mut cropped = image.clone();
    for y in 300..cropped.height {
        for x in 0..cropped.width {
            cropped.set(x, y, [0, 0, 0]);
        }
    }
    assert!(read(&cropped).channel.is_none());
}

#[test]
fn session_submits_a_stable_shop_once_with_its_place() {
    assert_session_place(20, 7);
}

#[test]
fn session_upload_preserves_extended_channels() {
    for channel in [12, 19, 20, 21, 33, 60] {
        assert_session_place(60, channel);
    }
}

fn assert_session_place(channels: usize, channel: u8) {
    let menu = MenuSpec {
        at: (700, 300),
        wb: 400,
        channels,
        blue: channel,
        dark: None,
    };
    let mut s = SceneSpec {
        seed: 6,
        menu: Some(menu),
        map_bar: Some("Hidden Street : Free Market <4>"),
        ..SceneSpec::default()
    };
    let mut session = Session::new(SessionConfig::default());
    let mut t = 0.0;
    // The menu once, and three map reads a second apart.
    for _ in 0..3 {
        let step = session.push(&render_game(&s).view(), t);
        assert!(step.snapshots.is_empty());
        t += 1000.0;
    }
    s.menu = None;
    s.shop = Some(shop((300, 150), "Cheap ores here"));
    let frame = render_game(&s);
    let mut sent = Vec::new();
    for _ in 0..12 {
        let step = session.push(&frame.view(), t);
        assert_eq!(step.status.channel, Some(channel));
        sent.extend(step.snapshots);
        t += 250.0;
    }
    assert_eq!(sent.len(), 1, "submitted once");
    let snap = &sent[0];
    assert_eq!((snap.channel, snap.room), (Some(channel), Some(4)));
    let up = &snap.upload;
    assert_eq!(up["version"], 1);
    assert_eq!(up["source"], "screen");
    assert_eq!(up["world"], "ClassicWorld");
    assert_eq!(up["complete"], true);
    assert_eq!(up["title"], "Grantx");
    assert_eq!(up["location"]["channel"], channel);
    assert_eq!(up["location"]["room"], 4);
    assert!(up["observation_id"].as_str().unwrap().len() <= 64);
    let items = up["items"].as_array().unwrap();
    assert_eq!(items.len(), 5);
    for (it, e) in items.iter().zip(EXPECTED) {
        assert_eq!(it["slot"], e.0 as u64);
        assert_eq!(it["item_id"], e.1 as u64);
        assert_eq!(it["category"], (e.1 / 1_000_000) as u64);
        assert_eq!(it["price"], e.2);
        assert_eq!(it["bundle"], e.3 as u64);
        assert_eq!(it["stock"], if e.4 { 0 } else { 1 });
    }
}

#[test]
fn session_waits_while_a_row_is_covered_and_for_the_list_end() {
    let mut s = scene((300, 150), "Six rows");
    s.shop
        .as_mut()
        .unwrap()
        .rows
        .push(row("Bronze Ore", 5, 300, false));
    let full = render_game(&s);
    let mut session = Session::default();
    let mut t = 0.0;
    for _ in 0..12 {
        let step = session.push(&full.view(), t);
        assert!(
            step.snapshots.is_empty(),
            "a full window does not show the list's end"
        );
        t += 250.0;
    }
    assert_eq!(session.push(&full.view(), t).status.list.len(), 6);
}

#[test]
fn cached_reads_match_fresh_reads() {
    let frame = stretch_bilinear(
        &render_game(&scene((420, 90), "Potions and ores")),
        1920,
        1080,
    );
    let fresh = read(&frame);
    let mut cache = ReaderCache::default();
    let opts = FrameOptions::default();
    let first = read_frame_with(&frame.view(), &opts, &mut cache);
    let second = read_frame_with(&frame.view(), &opts, &mut cache);
    assert_eq!(fresh.rows, first.rows);
    assert_eq!(first.rows, second.rows);
    assert_eq!(first.title_hash, second.title_hash);
}

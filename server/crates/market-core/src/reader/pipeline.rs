//! One frame in, the shop's rows out (plus title hash, seller, channel, map).
//! Every row that does not read cleanly is rejected with its reason.

use serde::Serialize;

use super::channel::{find_channel_menu, maybe_menu, ChannelRead};
use super::image::{median, resample, Gray};
use super::map::{read_map, MapCache, MapRead};
use super::name::seller::read_seller;
use super::name::{snap, snap_exact};
use super::row::stretch::StretchCache;
use super::row::{RowOptions, RowReader};
use super::window::{find_shop, frame_cues, row_image, Hint, Kind, ShopWindow, WindowCache};
use super::{clamp_box, js_round, reader_version, Rgba};

/// What the reader keeps from frame to frame: scaled templates, the stretch
/// factor and phase found per reported scale, the minimap header's scale.
/// Only speed and the stretch refinement depend on it, not what is accepted.
#[derive(Default)]
pub struct ReaderCache {
    window: WindowCache,
    stretch: StretchCache,
    map: MapCache,
}

#[derive(Debug, Clone, Copy, Default)]
pub struct FrameOptions {
    /// The session's UI scale: only scales near it are searched.
    pub lock_scale: Option<f64>,
    /// The window found in the last frame.
    pub hint: Option<Hint>,
    /// Read the minimap (the session does it at most once a second).
    pub skip_map: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct WindowInfo {
    pub kind: Kind,
    pub score: f64,
    pub ui_scale: f64,
    pub game_scale: f64,
    pub bbox: [f64; 4],
    /// Bands holding a row.
    pub bands: usize,
    /// All 6 bands hold a row: the list may go on below.
    pub full: bool,
    pub hint: Hint,
}

/// A row read cleanly and matched to the catalog.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct ReadRow {
    /// Band in the window, 1 (top) to 6.
    pub slot: u8,
    pub item_id: u32,
    pub name: String,
    /// Price of one bundle, as the shop shows it ("N for P mesos": P).
    pub price: u64,
    /// `price / bundle`.
    pub unit_price: f64,
    /// Items in one bundle (N).
    pub bundle: u32,
    /// Bundles left: 0 for a sold row; the screen does not show it otherwise.
    pub stock: Option<u32>,
    pub sold: bool,
    /// 1 for an exact read; the smallest digit margin for the atlas matcher.
    pub confidence: f64,
    pub exact: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct RejectedRow {
    pub slot: u8,
    pub why: String,
    pub covered: bool,
    pub name_read: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct FrameRead {
    pub reader: String,
    pub width: usize,
    pub height: usize,
    /// Not a black or flat frame.
    pub game_seen: bool,
    pub window: Option<WindowInfo>,
    pub rows: Vec<ReadRow>,
    pub rejected: Vec<RejectedRow>,
    /// Hash of the window's title area (the shop's id for screen uploads).
    pub title_hash: Option<u32>,
    pub seller: Option<String>,
    pub channel: Option<ChannelRead>,
    pub map: Option<MapRead>,
}

/// Reads one frame with no state from earlier frames. `prev_scale`: the UI
/// scale found before (a search hint).
pub fn read_frame(frame: &Rgba, prev_scale: Option<f64>) -> FrameRead {
    let opts = FrameOptions {
        lock_scale: prev_scale,
        ..FrameOptions::default()
    };
    read_frame_with(frame, &opts, &mut ReaderCache::default())
}

/// The shop window alone (the browser's main thread, 8 times a second).
pub fn find_window(
    frame: &Rgba,
    prev_scale: Option<f64>,
    cache: &mut ReaderCache,
) -> Option<ShopWindow> {
    if !frame_cues(frame).game_seen {
        return None;
    }
    find_shop(frame, None, prev_scale, &mut cache.window)
}

pub fn read_frame_with(frame: &Rgba, opts: &FrameOptions, cache: &mut ReaderCache) -> FrameRead {
    let cues = frame_cues(frame);
    let mut out = FrameRead {
        reader: reader_version(),
        width: frame.width,
        height: frame.height,
        game_seen: cues.game_seen,
        window: None,
        rows: Vec::new(),
        rejected: Vec::new(),
        title_hash: None,
        seller: None,
        channel: None,
        map: None,
    };
    if !cues.game_seen {
        return out;
    }
    let win = opts
        .hint
        .and_then(|h| find_shop(frame, Some(h), opts.lock_scale, &mut cache.window))
        .or_else(|| find_shop(frame, None, opts.lock_scale, &mut cache.window));
    if let Some(win) = win {
        read_rows(frame, &win, cache, &mut out);
        out.title_hash = title_hash(frame, win.title_box, win.game_scale);
        let k_hint = cache.stretch.refined(win.game_scale);
        out.seller = win
            .seller_box
            .and_then(|b| clamp_box(b, frame.width, frame.height))
            .and_then(|b| read_seller(&frame.cut(b).view(), k_hint));
        out.window = Some(WindowInfo {
            kind: win.kind,
            score: win.score,
            ui_scale: win.ui_scale,
            game_scale: win.game_scale,
            bbox: win.bbox,
            bands: win.rows.len(),
            full: win.full,
            hint: win.hint,
        });
    }
    if maybe_menu(frame) {
        out.channel = find_channel_menu(frame).ok().map(|(r, _)| r);
    }
    if !opts.skip_map {
        out.map = read_map(frame, &mut cache.map);
    }
    out
}

fn read_rows(frame: &Rgba, win: &ShopWindow, cache: &mut ReaderCache, out: &mut FrameRead) {
    let mut reader = RowReader::with_stretch(std::mem::take(&mut cache.stretch));
    for band in &win.rows {
        let slot = band.index as u8 + 1;
        let reject = |why: &str, covered: bool, name: Option<String>| RejectedRow {
            slot,
            why: why.to_string(),
            covered,
            name_read: name,
        };
        if band.covered {
            out.rejected
                .push(reject("row covered (cursor or tooltip)", true, None));
            continue;
        }
        let Some(cut) = row_image(frame, band.bbox, win.game_scale) else {
            out.rejected
                .push(reject("row outside the frame", false, None));
            continue;
        };
        let opts = RowOptions {
            scale: Some(win.ui_scale * frame.width as f64 / 1920.0),
            k: Some(win.game_scale),
            pad: cut.pad,
            at: Some(cut.at),
        };
        let r = reader.read(&cut.image.view(), &opts);
        let (Some(price), Some(bundle), false) = (r.price, r.qty, r.abstain) else {
            out.rejected.push(reject(&r.why, r.covered, r.name));
            continue;
        };
        let Some(sold) = r.sold else {
            out.rejected.push(reject("sold mark unsure", false, r.name));
            continue;
        };
        if price == 0 || bundle == 0 {
            out.rejected
                .push(reject("price or bundle is 0", false, r.name));
            continue;
        }
        // An exact read is matched exactly; a scored read by 3-grams.
        let snapped = r.name.as_deref().and_then(|n| {
            if r.exact {
                snap_exact(n, r.grade)
            } else {
                snap(n)
            }
        });
        let Some(hit) = snapped else {
            let why = if r.name.is_some() {
                "name not in the catalog"
            } else {
                "name not read"
            };
            out.rejected.push(reject(why, false, r.name));
            continue;
        };
        out.rows.push(ReadRow {
            slot,
            item_id: hit.item_id,
            name: hit.name,
            price,
            unit_price: price as f64 / bundle as f64,
            bundle,
            stock: sold.then_some(0),
            sold,
            confidence: r.confidence,
            exact: r.exact,
        });
    }
    cache.stretch = reader.stretch;
}

/// A stable 32-bit id of the window's title area: the area on game pixels,
/// its far-from-median pixels as a bitmap; border lines and a 3 game px
/// margin dropped (the window box moves a few px between frames); the first
/// text line from the top, cropped to its ink and hashed (FNV-1a).
pub fn title_hash(frame: &Rgba, bx: [f64; 4], k: f64) -> Option<u32> {
    const MARGIN: usize = 3;
    let b = clamp_box(bx, frame.width, frame.height)?;
    let g = Gray::from_rgba(&frame.cut(b).view());
    let kr = js_round(k);
    let (gw, gh, d) = if kr >= 1.0 && (k - kr).abs() <= 0.03 {
        let ki = kr as usize;
        let (gw, gh, o) = (g.w / ki, g.h / ki, ki >> 1);
        let d: Vec<f32> = (0..gw * gh)
            .map(|i| g.at((i % gw) * ki + o, (i / gw) * ki + o))
            .collect();
        (gw, gh, d)
    } else {
        let gw = (g.w as f64 / k).round().max(1.0) as usize;
        let gh = (g.h as f64 / k).round().max(1.0) as usize;
        (gw, gh, resample(&g.d, g.w, g.h, gw, gh))
    };
    if gw < 4 * MARGIN || gh < 4 * MARGIN {
        return None;
    }
    let med = median(&mut d.iter().map(|&v| v as f64).collect::<Vec<_>>());
    let mut ink: Vec<bool> = d.iter().map(|&v| (v as f64 - med).abs() > 40.0).collect();
    // Border lines: rows or columns that are mostly ink.
    for y in 0..gh {
        if (0..gw).filter(|&x| ink[y * gw + x]).count() * 2 > gw {
            (0..gw).for_each(|x| ink[y * gw + x] = false);
        }
    }
    for x in 0..gw {
        if (0..gh).filter(|&y| ink[y * gw + x]).count() * 2 > gh {
            (0..gh).for_each(|y| ink[y * gw + x] = false);
        }
    }
    let inside =
        |x: usize, y: usize| x >= MARGIN && y >= MARGIN && x + MARGIN < gw && y + MARGIN < gh;
    let on = |x: usize, y: usize| inside(x, y) && ink[y * gw + x];
    // The first line of text from the top: rows with ink, 1-row gaps closed, 5+ rows tall.
    let rows: Vec<bool> = (0..gh).map(|y| (0..gw).any(|x| on(x, y))).collect();
    let mut line: Option<(usize, usize)> = None;
    let mut y = 0;
    while y < gh && line.is_none() {
        if !rows[y] {
            y += 1;
            continue;
        }
        let a = y;
        let mut e = y;
        while e + 1 < gh && (rows[e + 1] || (e + 2 < gh && rows[e + 2])) {
            e += 1;
        }
        if e - a + 1 >= 5 {
            line = Some((a, e));
        }
        y = e + 1;
    }
    let (y0, y1) = line?;
    let cols: Vec<usize> = (0..gw).filter(|&x| (y0..=y1).any(|y| on(x, y))).collect();
    let (x0, x1) = (*cols.first()?, *cols.last()?);
    let mut h: u32 = 0x811c_9dc5;
    let mut eat = |byte: u8| {
        h ^= byte as u32;
        h = h.wrapping_mul(0x0100_0193);
    };
    for v in [(x1 - x0 + 1) as u32, (y1 - y0 + 1) as u32] {
        v.to_le_bytes().into_iter().for_each(&mut eat);
    }
    let (mut acc, mut nbits) = (0u8, 0);
    for y in y0..=y1 {
        for x in x0..=x1 {
            acc = (acc << 1) | u8::from(on(x, y));
            nbits += 1;
            if nbits == 8 {
                eat(acc);
                acc = 0;
                nbits = 0;
            }
        }
    }
    eat(acc);
    // shop_id must be at least 1.
    Some(h.max(1))
}

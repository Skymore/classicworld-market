//! Finding the shop window in a frame (capture.js findShop): the window's
//! header is matched by normalised correlation against two templates
//! (player store, hired merchant) on a 320 px wide grey frame over a sweep
//! of UI scales, after a 160 px prescreen; the listing panel must be pale
//! (median value >= 170, median saturation <= 60); the listing is cut into
//! 6 row bands placed on the row separator lines, each put on the game
//! pixel grid when the window is at a whole-number scale.

use std::collections::HashMap;

use serde::Serialize;

use super::image::{
    downscale_gray, median, prepare, resize, value_saturation, Gray, Prepared, Searchable,
};
use super::templates::{self, WindowTemplate};
use super::{clamp_box, js_round, round_to, Rgba, RgbaBuf};

pub const ROWS: usize = 6;
const DET_THR: f64 = 0.5;
const PRE_THR: f64 = 0.3;
const ROW_SCORE: f64 = 0.25;
const SCALES: [f64; 15] = [
    0.5, 0.56, 0.62, 0.69, 0.76, 0.84, 0.92, 1.0, 1.1, 1.2, 1.32, 1.45, 1.6, 1.76, 1.94,
];
const ROW_PITCH: f64 = 18.67;
/// A shop row box in game px (the text box is game px 41-202, from row 2).
pub const ROW_GAME_W: f64 = 262.0;
const TXT: [f64; 3] = [41.0, 203.0, 2.0];
/// The game draws its UI 768 game px tall: at 1920x1080 a 1x window uses 768 of 1080 lines.
const UI_1080: f64 = 768.0 / 1080.0;
const UI_1080_MIN: f64 = 0.6;
/// NCC windows flatter than this (sum of squared deviations) are skipped.
const FLAT: f64 = 1.0 - 1e-9;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize)]
pub enum Kind {
    #[serde(rename = "player-store")]
    Player,
    #[serde(rename = "hired-merchant")]
    Hired,
}

impl Kind {
    const ALL: [Kind; 2] = [Kind::Player, Kind::Hired];

    fn template(self) -> &'static WindowTemplate {
        let w = &templates::get().windows;
        match self {
            Kind::Player => &w.player,
            Kind::Hired => &w.hired,
        }
    }

    fn areas(self) -> Areas {
        match self {
            Kind::Player => Areas {
                title: [0.0, 0.0, 1.0, 0.09],
                seller: Some([0.0, 0.22, 0.32, 0.40]),
                avatar: Some([0.03, 0.10, 0.20, 0.32]),
                rows_x: [0.0, 0.5],
                row_top: 71.3,
            },
            // The hired merchant's owner is in its title.
            Kind::Hired => Areas {
                title: [0.0, 0.0, 1.0, 0.10],
                seller: None,
                avatar: None,
                rows_x: [0.0, 0.5],
                row_top: 58.0,
            },
        }
    }
}

/// Window-relative areas as shares of the full window.
struct Areas {
    title: [f64; 4],
    seller: Option<[f64; 4]>,
    avatar: Option<[f64; 4]>,
    rows_x: [f64; 2],
    row_top: f64,
}

/// Where a window was found, to track it in the next frame.
#[derive(Debug, Clone, Copy, PartialEq, Serialize)]
pub struct Hint {
    pub kind: Kind,
    pub s: f64,
    /// Position on the 320 px wide frame.
    pub x: usize,
    pub y: usize,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct RowBand {
    pub index: usize,
    pub bbox: [f64; 4],
    pub score: f64,
    /// The cursor or a tooltip is over it in this frame.
    pub covered: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct ShopWindow {
    pub kind: Kind,
    pub score: f64,
    /// 1.0 for any 16:9 window, stretched or not.
    pub ui_scale: f64,
    /// Screen px per game px: 1 for 1366x768, 1.406 for 1366x768 stretched to 1920x1080.
    pub game_scale: f64,
    pub bbox: [f64; 4],
    /// Bands holding a row (icon and text).
    pub rows: Vec<RowBand>,
    /// All 6 bands were filled: the list may go on below.
    pub full: bool,
    pub title_box: [f64; 4],
    pub seller_box: Option<[f64; 4]>,
    pub avatar_box: Option<[f64; 4]>,
    pub hint: Hint,
}

/// Scaled header templates, kept across frames.
#[derive(Default)]
pub struct WindowCache {
    scaled: HashMap<(Kind, u64, u8), Prepared>,
}

impl WindowCache {
    fn scaled(&mut self, k: Kind, s: f64, level: u8) -> &Prepared {
        self.scaled
            .entry((k, s.to_bits(), level))
            .or_insert_with(|| {
                let h = &k.template().half;
                let w = (js_round(h.w as f64 * s / level as f64) as usize).max(4);
                let hh = (js_round(h.h as f64 * s / level as f64) as usize).max(4);
                let g = resize(&Gray::new(h.w, h.h, h.d.clone()), w, hh);
                prepare(&g.d, g.w, g.h)
            })
    }
}

#[inline]
fn grey_at(img: &Rgba, x: usize, y: usize) -> f64 {
    img.luma(x, y)
}

fn shape_fits(s: f64, s_exp: f64) -> bool {
    (s >= s_exp * 0.8 && s <= s_exp * 1.15) || one_x(s, s_exp)
}

fn one_x(s: f64, s_exp: f64) -> bool {
    s >= s_exp * UI_1080 * 0.94 && s <= s_exp * UI_1080 * 1.06
}

#[derive(Debug, Clone, Copy)]
struct Cand {
    k: Kind,
    s: f64,
    x: i64,
    y: i64,
    v: f64,
}

fn locate(
    img: &Rgba,
    hint: Option<Hint>,
    lock: Option<f64>,
    s_exp: f64,
    cache: &mut WindowCache,
) -> Option<Cand> {
    let g320 = downscale_gray(img, 320);
    let g160 = resize(&g320, 160, (js_round(g320.h as f64 / 2.0) as usize).max(1));
    let s320 = Searchable::of(&g320);
    let mut cands: Vec<Cand> = Vec::new();
    if let Some(h) = hint {
        cands.push(Cand {
            k: h.kind,
            s: h.s,
            x: h.x as i64,
            y: h.y as i64,
            v: 0.0,
        });
    } else {
        let s160 = Searchable::of(&g160);
        let mut pre: Vec<Cand> = Vec::new();
        for k in Kind::ALL {
            let in_lock = |s: f64| lock.is_none_or(|l| s >= l * 0.8 && s <= l * 1.25);
            let mut list: Vec<f64> = SCALES.iter().copied().filter(|&s| in_lock(s)).collect();
            list.retain(|&s| shape_fits(s, s_exp));
            let s1 = js_round(s_exp * UI_1080 * 1000.0) / 1000.0;
            if in_lock(s1) {
                list.push(s1);
            }
            if list.is_empty() {
                list.push(lock.unwrap_or(s_exp));
            }
            for s in list {
                let t = cache.scaled(k, s, 2);
                if t.w >= g160.w || t.h >= g160.h {
                    continue;
                }
                let x1 = (g160.w - t.w) as i64;
                let y1 = (g160.h - t.h) as i64;
                if let Some(r) = s160.best(t, 0, x1, 0, y1, 2, FLAT) {
                    if r.v >= PRE_THR {
                        pre.push(Cand {
                            k,
                            s,
                            x: r.x as i64 * 2,
                            y: r.y as i64 * 2,
                            v: r.v,
                        });
                    }
                }
            }
        }
        pre.sort_by(|a, b| b.v.total_cmp(&a.v));
        // The best 3 overall, and the frame-shape band's best 3 as well.
        let in_shape = |p: &Cand| p.s >= s_exp * 0.8 && p.s <= s_exp * 1.15;
        let mut picked: Vec<usize> = (0..pre.len().min(3)).collect();
        for i in (0..pre.len()).filter(|&i| in_shape(&pre[i])).take(3) {
            if !picked.contains(&i) {
                picked.push(i);
            }
        }
        cands = picked.into_iter().map(|i| pre[i]).collect();
    }
    let keep = |s: f64, v: f64| shape_fits(s, s_exp) && !(one_x(s, s_exp) && v < UI_1080_MIN);
    let mut best: Option<Cand> = None;
    for c in cands {
        let fine: Vec<f64> = if hint.is_some() {
            vec![c.s]
        } else {
            vec![c.s * 0.96, c.s * 0.98, c.s, c.s * 1.02, c.s * 1.04]
        };
        for s in fine {
            let s3 = js_round(s * 1000.0) / 1000.0;
            let t = cache.scaled(c.k, s3, 1);
            if t.w >= g320.w || t.h >= g320.h {
                continue;
            }
            let Some(r) = s320.best(t, c.x - 4, c.x + 4, c.y - 4, c.y + 4, 1, FLAT) else {
                continue;
            };
            if !keep(s3, r.v) {
                continue;
            }
            if best.is_none_or(|b| r.v > b.v) {
                best = Some(Cand {
                    k: c.k,
                    s: s3,
                    x: r.x as i64,
                    y: r.y as i64,
                    v: r.v,
                });
            }
        }
    }
    best
}

/// Finds an open shop window. `hint`: the window found in the last frame
/// (only its place and scale are checked); `lock`: the session's UI scale
/// (only scales within -20% / +25% of it are searched).
pub fn find_shop(
    img: &Rgba,
    hint: Option<Hint>,
    lock: Option<f64>,
    cache: &mut WindowCache,
) -> Option<ShopWindow> {
    let (wf, hf) = (img.width as f64, img.height as f64);
    // The UI is drawn 768 game px tall, so a window's scale follows the frame's shape.
    let s_exp = 1.778 * hf / wf;
    let m = locate(img, hint, lock, s_exp, cache)?;
    if m.v < DET_THR
        || m.x < 0
        || !shape_fits(m.s, s_exp)
        || (one_x(m.s, s_exp) && m.v < UI_1080_MIN)
    {
        return None;
    }
    let t = m.k.template();
    let f = wf / 320.0;
    let u = m.s * wf / 640.0;
    let (x, y) = (m.x as f64 * f, m.y as f64 * f);
    let (ww, wh) = (t.full_w * u, t.full_h * u);
    let l = t.listing;
    if !panel_ok(
        img,
        [x + l[0] * u, y + l[1] * u, x + l[2] * u, y + l[3] * u],
    ) {
        return None;
    }
    let a = m.k.areas();
    let rel = |r: [f64; 4]| [x + r[0] * ww, y + r[1] * wh, x + r[2] * ww, y + r[3] * wh];
    let grid = row_grid(
        img,
        x + a.rows_x[0] * ww,
        x + a.rows_x[1] * ww,
        y,
        u,
        a.row_top,
    );
    let mut rows = Vec::new();
    // The first row put on the game pixel grid: the rest are 40 game px apart from it.
    let mut anchor: Option<(usize, [f64; 4], f64)> = None;
    for r in 0..ROWS {
        let top = grid.top + grid.pitch * r as f64;
        let bot = top + grid.pitch;
        let sc = row_score(img, x + l[0] * u, top, bot, u);
        let mut rbox = [
            x + a.rows_x[0] * ww,
            top + 1.0,
            x + a.rows_x[1] * ww,
            bot - 1.0,
        ];
        if let Some((ar, ab, ak)) = anchor {
            let dk = 40.0 * ak * (r - ar) as f64;
            rbox = [ab[0], ab[1] + dk, ab[2], ab[3] + dk];
        }
        if let Some(crisp) = crisp_row(img, rbox) {
            rbox = crisp;
            if anchor.is_none() {
                anchor = Some((r, crisp, js_round((crisp[2] - crisp[0]) / ROW_GAME_W)));
            }
        }
        if sc >= ROW_SCORE {
            rows.push(RowBand {
                index: r,
                bbox: rbox,
                score: round_to(sc, 2),
                covered: row_covered(img, rbox),
            });
        }
    }
    let full = rows.len() == ROWS;
    Some(ShopWindow {
        kind: m.k,
        score: round_to(m.v, 3),
        ui_scale: m.s,
        game_scale: round_to(m.s * wf / 1366.0, 3),
        bbox: [js_round(x), js_round(y), js_round(x + ww), js_round(y + wh)],
        rows,
        full,
        title_box: rel(a.title),
        seller_box: a.seller.map(rel),
        avatar_box: a.avatar.map(rel),
        hint: Hint {
            kind: m.k,
            s: m.s,
            x: m.x as usize,
            y: m.y as usize,
        },
    })
}

fn panel_ok(img: &Rgba, bx: [f64; 4]) -> bool {
    let Some(b) = clamp_box(bx, img.width, img.height) else {
        return false;
    };
    let st = ((b[2] - b[0]) / 60).max(1);
    let (mut vs, mut ss) = (Vec::new(), Vec::new());
    for y in (b[1]..b[3]).step_by(st) {
        for x in (b[0]..b[2]).step_by(st) {
            let (r, g, bl) = img.rgb(x, y);
            let (v, s) = value_saturation(r, g, bl);
            vs.push(v);
            ss.push(s);
        }
    }
    median(&mut vs) >= 170.0 && median(&mut ss) <= 60.0
}

/// A frame line's busyness: share of pixels far from the line's median.
struct Grid {
    top: f64,
    pitch: f64,
}

/// The row grid placed on the separator lines (a thin busy line between quiet
/// ones) near the expected place; with no clear lines the expected place.
fn row_grid(img: &Rgba, x0: f64, x1: f64, wy: f64, u: f64, top0: f64) -> Grid {
    let (w, h) = (img.width, img.height);
    let pitch = ROW_PITCH * u;
    let ya = (wy + (top0 - 12.0) * u).floor().max(0.0) as i64;
    let yb = ((wy + (top0 + 8.0 + ROWS as f64 * ROW_PITCH) * u).ceil() as i64).min(h as i64 - 1);
    let st = (((x1 - x0) / 120.0).floor() as usize).max(1);
    let xs = js_round(x0).max(0.0) as usize;
    let xe = (w as f64).min(x1);
    let mut busy: Vec<f64> = Vec::new();
    for yy in ya..=yb.max(ya - 1) {
        let mut vals: Vec<f64> = Vec::new();
        let mut xx = xs;
        while (xx as f64) < xe {
            vals.push(grey_at(img, xx, yy as usize));
            xx += st;
        }
        let n = vals.len();
        let med = median(&mut vals.clone());
        let c = vals.iter().filter(|&&v| (v - med).abs() > 40.0).count();
        busy.push(if n > 0 { c as f64 / n as f64 } else { 0.0 });
    }
    let p_at = |y: i64| -> Option<f64> { (y >= ya && y <= yb).then(|| busy[(y - ya) as usize]) };
    let g = js_round(u * 1.5).max(2.0) as i64;
    let line = |yv: f64| -> f64 {
        let mut best = 0f64;
        for k in -1..=1 {
            let yq = js_round(yv) as i64 + k;
            let (Some(p), Some(pu), Some(pd)) = (p_at(yq), p_at(yq - g), p_at(yq + g)) else {
                continue;
            };
            let near = pu
                .max(pd)
                .max(p_at(yq - 2 * g).unwrap_or(0.0))
                .max(p_at(yq + 2 * g).unwrap_or(0.0));
            best = best.max(p - near);
        }
        best
    };
    let mut best = (wy + top0 * u, pitch, 0f64);
    let mut ps = 0.99;
    while ps <= 1.011 {
        let p2 = pitch * ps;
        let mut t = wy + (top0 - 1.5) * u;
        while t <= wy + (top0 + 1.5) * u {
            let sc: f64 = (1..ROWS).map(|k| line(t + k as f64 * p2)).sum();
            if sc > best.2 {
                best = (t, p2, sc);
            }
            t += 1.0;
        }
        ps += 0.01;
    }
    if best.2 < 0.5 {
        best = (wy + top0 * u, pitch, best.2);
    }
    Grid {
        top: best.0,
        pitch: best.1,
    }
}

/// A band holds a row when it shows an icon and text (capture.js rowScore,
/// sampled at template resolution; u = frame px per template px).
fn row_score(img: &Rgba, bx: f64, by0: f64, by1: f64, u: f64) -> f64 {
    let (w, h) = (img.width as f64, img.height as f64);
    let ht = (by1 - by0) / u;
    let m = (ht / 5.0).floor();
    let mut ys = Vec::new();
    let mut t = m;
    while t < ht - m {
        let yy = js_round(by0 + t * u);
        if yy >= 0.0 && yy < h {
            ys.push(yy as usize);
        }
        t += 1.0;
    }
    if ys.is_empty() {
        return 0.0;
    }
    let px = |tx: f64, yy: usize| {
        let xx = js_round(bx + tx * u);
        if xx >= 0.0 && xx < w {
            grey_at(img, xx as usize, yy)
        } else {
            0.0
        }
    };
    let mut icon = Vec::new();
    for &yy in &ys {
        for tx in 3..23 {
            icon.push(px(tx as f64, yy));
        }
    }
    let med = median(&mut icon.clone());
    let ic = icon.iter().filter(|&&v| (v - med).abs() > 20.0).count();
    let (mut tc, mut tn) = (0usize, 0usize);
    for &yy in &ys {
        let mut prev = px(26.0, yy);
        for tx in 27..56 {
            let v = px(tx as f64, yy);
            if (v - prev).abs() > 18.0 {
                tc += 1;
            }
            tn += 1;
            prev = v;
        }
    }
    ((ic as f64 / icon.len() as f64) / 0.3).min((tc as f64 / tn as f64) / 0.1)
}

/// Integer luma, -99 off the frame.
fn luma_i(img: &Rgba, x: i64, y: i64) -> f64 {
    if x < 0 || y < 0 || x >= img.width as i64 || y >= img.height as i64 {
        return -99.0;
    }
    js_round(img.luma(x as usize, y as usize))
}

fn is_paper(v: f64) -> bool {
    (v - 215.0).abs() <= 3.0 || (v - 244.0).abs() <= 1.0
}

/// A row box at a whole-number scale k put on the game pixel grid: shifts of
/// up to 4 px across and 2 down (4 game px at 2x) to where the text box's
/// edges are (game px 41-202 paper, 40 and 203 frame). `None` when the box
/// is not at a whole k, or a smooth stretch fakes the edges.
pub fn crisp_row(img: &Rgba, rbox: [f64; 4]) -> Option<[f64; 4]> {
    let w = rbox[2] - rbox[0];
    let k = js_round(w / ROW_GAME_W);
    if !(1.0..=4.0).contains(&k) || (w - ROW_GAME_W * k).abs() > 0.04 * ROW_GAME_W * k {
        return None;
    }
    let ki = k as i64;
    let o = ki >> 1;
    let l = |x: i64, y: i64| luma_i(img, x, y);
    let (x0r, y0r) = (js_round(rbox[0]) as i64, js_round(rbox[1]) as i64);
    let dy_max = if ki >= 2 { 4 * ki } else { 2 };
    let mut best: Option<(f64, i64, i64)> = None;
    for dy in -dy_max..=dy_max {
        for dx in -4..=4 {
            let (x0, y0) = (x0r + dx, y0r + dy);
            let (mut ok, mut n) = (0i64, 0i64);
            let mut gy = 2;
            while gy <= 35 {
                let py = y0 + gy * ki + o;
                n += 1;
                if !is_paper(l(x0 + 41 * ki - 1, py))
                    && is_paper(l(x0 + 41 * ki, py))
                    && is_paper(l(x0 + 203 * ki - 1, py))
                    && !is_paper(l(x0 + 203 * ki, py))
                {
                    ok += 1;
                }
                gy += 3;
            }
            if ki >= 2 {
                // Rows above and below the text box are not paper (three columns, most must hold).
                let mut tb = 0;
                for gx in [60, 120, 180] {
                    let px = x0 + gx * ki + o;
                    if !is_paper(l(px, y0 + ki - 1))
                        && is_paper(l(px, y0 + 2 * ki))
                        && is_paper(l(px, y0 + 36 * ki - 1))
                        && !is_paper(l(px, y0 + 36 * ki))
                    {
                        tb += 1;
                    }
                }
                if tb < 2 {
                    continue;
                }
            } else if is_paper(l(x0 + 120 * ki + o, y0 + o))
                || is_paper(l(x0 + 120 * ki + o, y0 + 37 * ki + o))
            {
                ok -= 2;
            }
            let sc = ok as f64 / n as f64 - (dx.abs() + dy.abs()) as f64 * 0.001;
            if best.is_none_or(|b| sc > b.0) {
                best = Some((sc, x0, y0));
            }
        }
    }
    let (sc, bx, by) = best?;
    if sc < 0.7 {
        return None;
    }
    // A smooth stretch near a whole number can pass the edge test; its text has ramps.
    let (mut off, mut ramp) = (0usize, 0usize);
    let (hx0, hx1, hy0, hy1) = (bx + 41 * ki, bx + 202 * ki, by + 2 * ki, by + 34 * ki);
    for y in hy0.max(1)..hy1.min(img.height as i64 - 1) {
        for x in hx0.max(1)..hx1.min(img.width as i64 - 1) {
            let v = l(x, y);
            if off_palette(v) {
                off += 1;
                let nb = [l(x - 1, y), l(x + 1, y), l(x, y - 1), l(x, y + 1)];
                let lo = nb.iter().copied().fold(f64::INFINITY, f64::min);
                let hi = nb.iter().copied().fold(f64::NEG_INFINITY, f64::max);
                if lo <= v - 15.0 && hi >= v + 15.0 {
                    ramp += 1;
                }
            }
        }
    }
    if off as f64 >= 40.0 * k && ramp as f64 >= 0.3 * off as f64 {
        return None;
    }
    Some([
        bx as f64,
        by as f64,
        bx as f64 + ROW_GAME_W * k,
        by as f64 + 38.0 * k,
    ])
}

/// Not paper (215 / 244), ink (0 / 187) or the underline (250+).
fn off_palette(v: f64) -> bool {
    !((v - 215.0).abs() <= 6.0
        || (v - 244.0).abs() <= 6.0
        || v <= 40.0
        || v >= 250.0
        || (v - 187.0).abs() <= 12.0)
}

/// 30%+ of the box's off-palette pixels are ramps between their neighbours:
/// a smooth stretch, not a cover (capture.js smoothBox).
fn smooth_box(img: &Rgba, x0: f64, y0: f64, x1: f64, y1: f64, k: f64) -> bool {
    let l = |x: i64, y: i64| img.luma(x as usize, y as usize);
    let btw =
        |a: f64, v: f64, b: f64| (a <= v - 6.0 && b >= v + 6.0) || (a >= v + 6.0 && b <= v - 6.0);
    let (mut off, mut ramp) = (0usize, 0usize);
    let (w, h) = (img.width as i64, img.height as i64);
    for y in (js_round(y0) as i64).max(1)..(js_round(y1) as i64).min(h - 1) {
        for x in (js_round(x0) as i64).max(1)..(js_round(x1) as i64).min(w - 1) {
            let v = l(x, y);
            if !off_palette(v) {
                continue;
            }
            off += 1;
            if btw(l(x - 1, y), v, l(x + 1, y)) || btw(l(x, y - 1), v, l(x, y + 1)) {
                ramp += 1;
            }
        }
    }
    off as f64 >= 40.0 * k && ramp as f64 >= 0.3 * off as f64
}

/// Share of a box in the slate blue of item tooltips.
fn tooltip_share(img: &Rgba, bx: [f64; 4]) -> f64 {
    let Some(b) = clamp_box(bx, img.width, img.height) else {
        return 1.0;
    };
    let st = ((b[3] - b[1]) / 24).max(1);
    let (mut n, mut hit) = (0usize, 0usize);
    for y in (b[1]..b[3]).step_by(st) {
        for x in (b[0]..b[2]).step_by(st) {
            let (r, g, bl) = img.rgb(x, y);
            let (mx, mn) = (r.max(g).max(bl) as f64, r.min(g).min(bl) as f64);
            n += 1;
            if mx == 0.0 || mx > 175.0 || (mx - mn) * 255.0 / mx < 55.0 || mx != bl as f64 {
                continue;
            }
            let hue = 240.0 + 60.0 * (r as f64 - g as f64) / (mx - mn);
            if (210.0..=264.0).contains(&hue) {
                hit += 1;
            }
        }
    }
    if n > 0 {
        hit as f64 / n as f64
    } else {
        1.0
    }
}

/// Whether the cursor or a tooltip is over a row in this frame. At a whole k
/// the text box must hold only the row's own colours; elsewhere the
/// tooltip blue decides.
pub fn row_covered(img: &Rgba, rbox: [f64; 4]) -> bool {
    let w = rbox[2] - rbox[0];
    let k = js_round(w / ROW_GAME_W);
    if (1.0..=4.0).contains(&k) && (w - ROW_GAME_W * k).abs() <= k {
        let ki = k as usize;
        let o = ki >> 1;
        let (x0, y0) = (js_round(rbox[0]) as i64, js_round(rbox[1]) as i64);
        let gh = ((js_round(rbox[3]) as i64 - y0) as f64 / k).floor() as i64;
        let mut vals = Vec::new();
        let mut hist = [0u32; 256];
        let (mut best, mut paper) = (0u32, 0f64);
        for gy in TXT[2] as i64..gh - 2 {
            for gx in TXT[0] as i64..TXT[1] as i64 {
                let px = x0 + gx * ki as i64 + o as i64;
                let py = y0 + gy * ki as i64 + o as i64;
                if px < 0 || py < 0 || px >= img.width as i64 || py >= img.height as i64 {
                    return true;
                }
                let v = js_round(img.luma(px as usize, py as usize));
                vals.push(v);
                let c = &mut hist[v.clamp(0.0, 255.0) as usize];
                *c += 1;
                if *c > best {
                    best = *c;
                    paper = v;
                }
            }
        }
        let sold = (paper - 244.0).abs() <= 6.0;
        let clean = sold || (paper - 215.0).abs() <= 6.0;
        let (ink, ink_tol) = if sold { (187.0, 12.0) } else { (0.0, 40.0) };
        let clean = clean
            && vals.iter().all(|&u| {
                (u - paper).abs() <= 6.0
                    || (u - ink).abs() <= ink_tol
                    || u >= 250.0
                    || (sold && (u - 215.0).abs() <= 6.0)
            });
        if clean {
            return false;
        }
        // A smooth stretch at a whole k is judged as at any other scale.
        let smooth = k >= 2.0
            && smooth_box(
                img,
                x0 as f64 + TXT[0] * k,
                y0 as f64 + TXT[2] * k,
                x0 as f64 + TXT[1] * k,
                js_round(rbox[3]) - 2.0 * k,
                k,
            );
        if !smooth {
            return true;
        }
    }
    let tw = w / ROW_GAME_W;
    let th = (rbox[3] - rbox[1]) / 38.0;
    tooltip_share(
        img,
        [
            rbox[0] + TXT[0] * tw,
            rbox[1] + 3.0 * th,
            rbox[0] + TXT[1] * tw,
            rbox[3] - 3.0 * th,
        ],
    ) > 0.02
}

/// A row's picture for the reader. At a stretched scale it is cut with a
/// margin of 16 game px across and 12 down, given as `pad`.
#[derive(Debug, Clone)]
pub struct RowCut {
    pub image: RgbaBuf,
    /// [left, top, right, bottom] frame px of margin around the row box.
    pub pad: Option<[usize; 4]>,
    /// The cut's top left in the frame.
    pub at: [usize; 2],
}

pub fn row_image(img: &Rgba, bx: [f64; 4], k: f64) -> Option<RowCut> {
    if !(k > 1.1 && (k - js_round(k)).abs() > 0.03) {
        let b = clamp_box(bx, img.width, img.height)?;
        return Some(RowCut {
            image: img.cut(b),
            pad: None,
            at: [b[0], b[1]],
        });
    }
    let (px, py) = (js_round(16.0 * k), js_round(12.0 * k));
    let (w, h) = (img.width as f64, img.height as f64);
    let bx0 = js_round(bx[0]).max(0.0);
    let by0 = js_round(bx[1]).max(0.0);
    let bx1 = js_round(bx[2]).min(w);
    let by1 = js_round(bx[3]).min(h);
    if !(bx1 > bx0 && by1 > by0) {
        return None;
    }
    let (x0, y0) = ((bx0 - px).max(0.0), (by0 - py).max(0.0));
    let (x1, y1) = ((bx1 + px).min(w), (by1 + py).min(h));
    let cut = [x0 as usize, y0 as usize, x1 as usize, y1 as usize];
    Some(RowCut {
        image: img.cut(cut),
        pad: Some([
            (bx0 - x0) as usize,
            (by0 - y0) as usize,
            (x1 - bx1) as usize,
            (y1 - by1) as usize,
        ]),
        at: [cut[0], cut[1]],
    })
}

/// Cheap per-frame cues.
#[derive(Debug, Clone, Copy, PartialEq, Serialize)]
pub struct FrameCues {
    /// Not a black or flat frame (a loading screen).
    pub game_seen: bool,
    pub has_minimap: bool,
    pub has_channel: bool,
}

struct AreaStats {
    sd: f64,
    edge: f64,
}

fn area_stats(img: &Rgba, bx: [f64; 4], step: usize) -> AreaStats {
    let Some(b) = clamp_box(bx, img.width, img.height) else {
        return AreaStats { sd: 0.0, edge: 0.0 };
    };
    let (mut s, mut q, mut n, mut e, mut en) = (0f64, 0f64, 0usize, 0usize, 0usize);
    for y in (b[1]..b[3]).step_by(step) {
        let mut prev: Option<f64> = None;
        for x in (b[0]..b[2]).step_by(step) {
            let v = grey_at(img, x, y);
            s += v;
            q += v * v;
            n += 1;
            if let Some(p) = prev {
                if (v - p).abs() > 40.0 {
                    e += 1;
                }
                en += 1;
            }
            prev = Some(v);
        }
    }
    let mean = if n > 0 { s / n as f64 } else { 0.0 };
    AreaStats {
        sd: if n > 0 {
            (q / n as f64 - mean * mean).max(0.0).sqrt()
        } else {
            0.0
        },
        edge: if en > 0 { e as f64 / en as f64 } else { 0.0 },
    }
}

pub fn frame_cues(img: &Rgba) -> FrameCues {
    let (w, h) = (img.width as f64, img.height as f64);
    let step = (img.width / 640).max(1);
    // The game area only: a shared window's title bar and border are left out.
    let all = area_stats(
        img,
        [
            js_round(w * 0.01),
            js_round(h * 0.06),
            js_round(w * 0.99),
            js_round(h * 0.99),
        ],
        (img.width / 160).max(2),
    );
    let mm = area_stats(img, [0.0, 0.0, 0.25 * w, 0.14 * h], step);
    let ch = area_stats(img, [0.0, 0.0, 0.25 * w, 0.035 * h], step);
    FrameCues {
        game_seen: all.sd > 12.0,
        has_minimap: mm.edge > 0.04 && mm.sd > 25.0,
        has_channel: ch.edge > 0.05 && ch.sd > 20.0,
    }
}

//! The seller's name tag in the player store window (reader.js
//! readSellerExact, unstretchTag): white text (255) on a dark tag (luma
//! 43-54 at UI scale 1), 15 x 85 game px, in the shop font. Read exactly or
//! not at all: there is no catalog to check a player's name against.

use super::super::font::{exact_line, fix_il};
use super::super::image::Gray;
use super::super::row::stretch::{fit_phase, palette_miss, unstretch_plane};
use super::super::templates;
use super::super::{js_round, Rgba, RgbaBuf};

/// The tag's own palette: ring, gradient, border, window, white text.
const TAG_PALETTE: [f64; 11] = [
    0.0, 43.0, 46.0, 49.0, 52.0, 55.0, 124.0, 176.0, 214.0, 222.0, 255.0,
];

/// The tag read in the pixel font at a whole-number scale.
pub fn read_seller_exact(img: &Rgba) -> Option<String> {
    let font = &templates::get().font;
    let (w, h) = (img.width, img.height);
    let l = |x: usize, y: usize| img.luma(x, y);
    let dark = |v: f64| (35.0..=70.0).contains(&v);
    let mut run: Option<(usize, usize)> = None;
    let mut cur: Option<(usize, usize)> = None;
    for y in 0..h {
        if (0..w).filter(|&x| dark(l(x, y))).count() >= 40 {
            let c = cur.map_or((y, y), |(a, _)| (a, y));
            cur = Some(c);
            if run.is_none_or(|r| c.1 - c.0 > r.1 - r.0) {
                run = Some(c);
            }
        } else {
            cur = None;
        }
    }
    let (ra, rb) = run?;
    let th = rb - ra + 1;
    let k = js_round(th as f64 / 15.0) as usize;
    if k < 1 || th.abs_diff(15 * k) > k {
        return None;
    }
    // The tag's columns: a letter's stroke whitens most of a column.
    let mut bx: Option<(usize, usize)> = None;
    let mut cx: Option<(usize, usize)> = None;
    for x in 0..w {
        if (ra..=rb).filter(|&y| dark(l(x, y))).count() >= 3 * k {
            let c = cx.map_or((x, x), |(a, _)| (a, x));
            cx = Some(c);
            if bx.is_none_or(|b| c.1 - c.0 > b.1 - b.0) {
                bx = Some(c);
            }
        } else {
            cx = None;
        }
    }
    let (ba, bb) = bx?;
    if (bb - ba + 1).abs_diff(85 * k) > 4 * k {
        return None;
    }
    let gw = ((bb - ba + 1) / k) as i64;
    let o = k >> 1;
    let ink = |x: i64, y: i64| {
        x >= 0
            && x < gw
            && (0..15).contains(&y)
            && l(ba + x as usize * k + o, ra + y as usize * k + o) >= 200.0
    };
    let rows: Vec<i64> = (0..15).filter(|&y| (0..gw).any(|x| ink(x, y))).collect();
    let (&lo, &hi) = (rows.first()?, rows.last()?);
    if hi - lo < 5 {
        return None;
    }
    for base in (lo + 6).max(0)..=hi {
        if let Some(t) = exact_line(font, &ink, 0, gw, base) {
            let text: String = t.text.chars().filter(|&c| c != ' ').collect();
            if t.unknown == 0 && text.chars().count() >= 2 {
                return Some(fix_il(&text));
            }
        }
    }
    None
}

/// The tag band of a smoothly stretched seller area back on game pixels.
fn unstretch_tag(img: &Rgba, k: f64) -> Option<RgbaBuf> {
    let (w, h) = (img.width, img.height);
    let lum = Gray::from_rgba709(img);
    let tagish = |v: f32| (30.0..=80.0).contains(&v);
    let (mut a, mut b): (i64, i64) = (-1, -1);
    let mut run: Option<(i64, i64)> = None;
    for y in 0..h as i64 {
        let m = (0..w)
            .filter(|&x| tagish(lum.d[y as usize * w + x]))
            .count();
        // Up to 3 rows of white text inside the band are bridged.
        if m as f64 >= 0.2 * w as f64 {
            if a < 0 || y > b + 4 {
                a = y;
            }
            b = y;
            if run.is_none_or(|r| b - a > r.1 - r.0) {
                run = Some((a, b));
            }
        }
    }
    let (ra, rb) = run?;
    if ((rb - ra + 1) as f64) < 15.0 * k - 3.0 {
        return None;
    }
    let need = 0.4 * (rb - ra + 1) as f64;
    let cols: Vec<usize> = (0..w)
        .filter(|&x| {
            (ra..=rb)
                .filter(|&y| tagish(lum.d[y as usize * w + x]))
                .count() as f64
                >= need
        })
        .collect();
    let (&x0, &x1) = (cols.first()?, cols.last()?);
    let (cx0, cx1) = (x0.saturating_sub(6), (x1 + 7).min(w));
    let (cy0, cy1) = ((ra - 6).max(0) as usize, ((rb + 7) as usize).min(h));
    let (cw, chh) = (cx1 - cx0, cy1 - cy0);
    let mut s = Vec::with_capacity(cw * chh);
    for y in cy0..cy1 {
        s.extend_from_slice(&lum.d[y * w + cx0..y * w + cx1]);
    }
    let miss = |p: &Gray| palette_miss(p, &TAG_PALETTE, 0.0, 1.0);
    let best = fit_phase(&s, cw, chh, k, 0.0, &miss, None, None)?;
    if best.e > 4.0 {
        return None;
    }
    let p = unstretch_plane(&s, cw, chh, k, best.px, best.py)?;
    let mut out = RgbaBuf::filled(p.w, p.h, [0, 0, 0]);
    for y in 0..p.h {
        for x in 0..p.w {
            let v = js_round(p.d[y * p.w + x] as f64).clamp(0.0, 255.0) as u8;
            out.set(x, y, [v, v, v]);
        }
    }
    Some(out)
}

/// The seller's name from the seller area, exactly, or `None`. `k_hint`: the
/// stretch the window's rows were found to have (the window's own scale can
/// be a few percent off; the rows' fit searched it).
pub fn read_seller(img: &Rgba, k_hint: Option<f64>) -> Option<String> {
    if let Some(s) = read_seller_exact(img) {
        return Some(s);
    }
    // The seller area is 236 px of a 1920 px window at UI scale 1.
    let base = k_hint.unwrap_or((img.width as f64 / 236.0) * 1920.0 / 1366.0);
    if !(base > 1.1 && (base - js_round(base)).abs() > 0.03) {
        return None;
    }
    let tries: &[f64] = if k_hint.is_some() {
        &[1.0]
    } else {
        &[1.0, 0.99, 1.01, 0.98, 1.02, 0.97, 1.03]
    };
    tries
        .iter()
        .find_map(|f| unstretch_tag(img, base * f).and_then(|flat| read_seller_exact(&flat.view())))
}

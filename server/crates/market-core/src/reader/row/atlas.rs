//! The atlas matcher (reader.js readGray/finish), for rows the exact reader
//! cannot read (a sharp stretch, a blurred capture):
//! 1. find the word "mesos" at any scale by NCC, then "for" on its line;
//! 2. resample the offer line so one digit is 39 canonical px wide;
//! 3. the "for" -> "mesos" distance gives the digit and comma count, else reject;
//! 4. match each digit cell; confidence = min over digits of (best - second best);
//! 5. the quantity is read right to left from "for";
//! 6. sold = the offer text's darkest pixels are grey, not black.
//!
//! Rows of one shop share a scale: the last row's scale is tried first.

use std::collections::HashMap;

use super::super::image::{percentile, prepare, resample, resample_rect, Prepared, Searchable};
use super::super::js_round;
use super::super::name::letters::{read_name, OfferLine, Recognized};
use super::super::templates::{self, Canonical};

/// What the atlas matcher read.
#[derive(Debug, Clone, PartialEq)]
pub struct AtlasRead {
    pub price: Option<u64>,
    pub qty: Option<u32>,
    pub name: Option<Recognized>,
    pub sold: Option<bool>,
    pub confidence: f64,
    pub abstain: bool,
    pub why: String,
    pub scale: Option<f64>,
    /// The raw read (also when abstaining), for the gates in `row`.
    pub raw: Option<Raw>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Raw {
    /// Left edge of the quantity, row px.
    pub qty_x0: f64,
    /// NCC of the word "mesos".
    pub mesos: f64,
}

fn fail(why: &str, scale: Option<f64>, name: Option<Recognized>) -> AtlasRead {
    AtlasRead {
        price: None,
        qty: None,
        name,
        sold: None,
        confidence: 0.0,
        abstain: true,
        why: why.to_string(),
        scale,
        raw: None,
    }
}

#[derive(Debug, Clone, Copy)]
struct Fine {
    s: f64,
    hy: f64,
    w: usize,
    h: usize,
    f: f64,
}

#[derive(Debug, Clone, Copy)]
struct Coarse {
    v: f64,
    x: f64,
    y: f64,
    s: f64,
    locked: bool,
}

struct Band {
    d: Vec<f32>,
    w: usize,
    h: usize,
    ex: f64,
    ey: f64,
    ya: f64,
}

struct Anchor {
    v: f64,
    m: usize,
    y: usize,
    s: f64,
    band: Band,
}

#[derive(Debug, Clone, Copy)]
struct Digit {
    d: u8,
    score: f64,
    margin: f64,
}

/// The matcher with its scale lock (one per frame).
#[derive(Default)]
pub struct AtlasReader {
    last_scale: Option<f64>,
    last_fine: Option<Fine>,
    coarse_cache: HashMap<u64, Prepared>,
}

impl AtlasReader {
    fn coarse_template(&mut self, s: f64) -> &Prepared {
        self.coarse_cache.entry(s.to_bits()).or_insert_with(|| {
            let a = &templates::get().atlas;
            let m = &a.mesos;
            let f = s / a.canonical.up;
            let w = (js_round(m.w as f64 * f) as usize).max(3);
            let h = (js_round(m.h as f64 * f) as usize).max(3);
            prepare(&resample(&m.d, m.w, m.h, w, h), w, h)
        })
    }

    /// Large scales are searched on the row shrunk 2x; the hit only seeds the fine search.
    fn coarse(&mut self, g: &[f32], w: usize, h: usize, list: &[f64]) -> Option<Coarse> {
        let mut best: Option<Coarse> = None;
        let mut half: Option<(Vec<f32>, usize, usize)> = None;
        for &s in list {
            let use_half = s >= 1.1;
            if use_half && half.is_none() {
                let (w2, h2) = (
                    (js_round(w as f64 / 2.0) as usize).max(1),
                    (js_round(h as f64 / 2.0) as usize).max(1),
                );
                half = Some((resample(g, w, h, w2, h2), w2, h2));
            }
            let t = self
                .coarse_template(if use_half { s / 2.0 } else { s })
                .clone();
            let (d, iw, ih) = match (&half, use_half) {
                (Some((d, w2, h2)), true) => (d.as_slice(), *w2, *h2),
                _ => (g, w, h),
            };
            if t.w > iw || t.h > ih {
                continue;
            }
            let sr = Searchable::new(d, iw, ih);
            let b = sr.best_all(&t, if t.w * t.h >= 120 { 2 } else { 1 });
            let f = if use_half { w as f64 / iw as f64 } else { 1.0 };
            if let Some(b) = b {
                if best.is_none_or(|c| b.v > c.v) {
                    best = Some(Coarse {
                        v: b.v,
                        x: b.x as f64 * f,
                        y: b.y as f64 * f,
                        s,
                        locked: false,
                    });
                }
            }
        }
        best
    }

    /// Reads one row picture (grey). `hint_scale`: the caller's expected scale.
    pub fn read(&mut self, g: &[f32], w: usize, h: usize, hint_scale: Option<f64>) -> AtlasRead {
        let a = &templates::get().atlas;
        let c = &a.canonical;
        // The row's width fixes the scale to within a few percent.
        let row_s = w as f64 / c.row_w;
        let near_row = |s: f64| {
            !(row_s >= c.scale_min && row_s <= c.scale_max)
                || (s >= row_s / c.row_scale_tol && s <= row_s * c.row_scale_tol)
        };
        // The scale lock: the last row's fine scale and line height, when this row is as big.
        if let Some(lf) = self.last_fine {
            if (h as f64 - lf.h as f64).abs() <= 1.0
                && (w as f64 - lf.w as f64).abs() <= 1.0
                && near_row(lf.s)
            {
                if let Some(read) = self.read_locked(g, w, h, lf) {
                    return read;
                }
            }
        }
        let mut hit: Option<Coarse> = None;
        if let Some(s0) = hint_scale.filter(|&s| near_row(s)) {
            hit = self
                .coarse(g, w, h, &[s0 * 0.995, s0 * 1.01, s0 * 1.025])
                .filter(|h| h.v >= 0.7);
        }
        if hit.is_none() {
            if let Some(ls) = self.last_scale.filter(|&s| near_row(s)) {
                let mut near = Vec::new();
                let mut s = ls / 1.1;
                while s <= ls * 1.1 {
                    near.push(s);
                    s *= 1.02;
                }
                hit = self.coarse(g, w, h, &near).filter(|h| h.v >= 0.7);
            }
        }
        let all = scales(c);
        if hit.is_none() {
            let list: Vec<f64> = all.iter().copied().filter(|&s| near_row(s)).collect();
            hit = self.coarse(g, w, h, &list).filter(|h| h.v >= 0.45);
        }
        if hit.is_none() {
            hit = self.coarse(g, w, h, &all);
        }
        let Some(hit) = hit.filter(|h| h.v >= 0.45) else {
            return fail("no \"mesos\" word found", None, None);
        };
        let mut best: Option<Anchor> = None;
        let mut s = hit.s * 0.97;
        while s <= hit.s * 1.0301 {
            if let Some(b) = mesos_on_band(g, w, h, &hit, s) {
                if best.as_ref().is_none_or(|x| b.v > x.v) {
                    best = Some(b);
                }
            }
            s += hit.s * 0.01;
        }
        match best {
            Some(b) if b.v >= c.min_anchor => self.finish(g, w, h, b, hit),
            _ => fail("\"mesos\" matched too weakly", Some(hit.s), None),
        }
    }

    fn read_locked(&mut self, g: &[f32], w: usize, h: usize, lf: Fine) -> Option<AtlasRead> {
        let c = &templates::get().atlas.canonical;
        let use_half = lf.s >= 1.1;
        let f = if use_half { 2.0 } else { 1.0 };
        let (d, iw, ih) = if use_half {
            let (w2, h2) = (
                (js_round(w as f64 / 2.0) as usize).max(1),
                (js_round(h as f64 / 2.0) as usize).max(1),
            );
            (resample(g, w, h, w2, h2), w2, h2)
        } else {
            (g.to_vec(), w, h)
        };
        let t = self
            .coarse_template(if use_half { lf.s / 2.0 } else { lf.s })
            .clone();
        if t.w > iw || t.h > ih {
            return None;
        }
        let yc = js_round(lf.hy / f) as i64;
        let sr = Searchable::new(&d, iw, ih);
        let b = sr.best_stepped(&t, 0, (iw - t.w) as i64, yc - 2, yc + 2, 2)?;
        if b.v < 0.7 {
            return None;
        }
        let sc = w as f64 / iw as f64;
        let locked = Coarse {
            v: b.v,
            x: b.x as f64 * sc,
            y: b.y as f64 * sc,
            s: lf.s,
            locked: true,
        };
        let mut best: Option<Anchor> = None;
        for &fct in &c.lock_scales {
            if let Some(a) = mesos_on_band(g, w, h, &locked, locked.s * fct) {
                if best.as_ref().is_none_or(|x| a.v > x.v) {
                    best = Some(a);
                }
            }
        }
        let best = best.filter(|b| b.v >= c.min_anchor)?;
        Some(self.finish(g, w, h, best, locked))
    }

    fn finish(&mut self, g: &[f32], w: usize, h: usize, best: Anchor, hit: Coarse) -> AtlasRead {
        let a = &templates::get().atlas;
        let c = &a.canonical;
        let Anchor {
            v: mesos_v,
            m,
            y,
            s,
            band,
        } = best;
        let sr = Searchable::new(&band.d, band.w, band.h);
        // "for" on the same line, left of "mesos".
        let y0 = (y as f64 - c.for_band_pad).max(0.0) as i64;
        let yb = (band.h as i64).min(y0 + c.cell_h as i64 + 10);
        let full_x1 = m as i64 - 20 - a.for_t.w as i64;
        let (mut fx0, mut fx1) = (0i64, full_x1);
        if hit.locked {
            if let Some(lf) = self.last_fine {
                fx0 = ((lf.f - 4.5 * c.digit_adv).floor() as i64).max(0);
                fx1 = fx1.min((lf.f + 4.5 * c.digit_adv).ceil() as i64);
            }
        }
        let fy1 = yb - a.for_t.h as i64;
        let mut fb = sr.best_stepped(&a.for_t, fx0, fx1, y0, fy1, c.for_step);
        if fb.is_none_or(|b| b.v < c.min_anchor) && (fx0 > 0 || fx1 < full_x1) {
            fb = sr.best_stepped(&a.for_t, 0, full_x1, y0, fy1, c.for_step);
        }
        let Some(fb) = fb.filter(|b| b.v >= c.min_anchor) else {
            return fail("\"for\" not found", Some(s), None);
        };
        let ff = fb.x as f64;
        let line_y0 = band.ya + y as f64 * s / c.up;
        // The item name is read even when the price is not (the anchors fix the name line).
        let named = |why: &str, nq: usize| {
            let line = OfferLine {
                qx0: Some(
                    (ff - c.qty_start - c.digit_adv * nq.saturating_sub(1) as f64) * s / c.up,
                ),
                x0: ff * s / c.up,
                y0: line_y0,
            };
            fail(why, Some(s), Some(read_name(g, w, h, line, s)))
        };
        let (n, k, res, res2) = pick_layout(c, ff, m as f64);
        if res > c.max_residual || res2 - res < c.min_residual_gap {
            return named("digit layout does not fit", 1);
        }
        let set = if s > c.class_a_min_scale {
            &a.digits_a
        } else {
            &a.digits_b
        };
        let mut digits = Vec::new();
        let mut stds = Vec::new();
        for x in cells_between(c, ff, m as f64, n, k) {
            let Some(p) = window_patch(&band, c, x, y as f64, c.jitter_x, c.jitter_y, c.digit_adv)
            else {
                return named("price cut at the row edge", 1);
            };
            digits.push(classify(&p, set));
            stds.push(inner_std(&p, c.jitter_x + 2, c.jitter_y));
        }
        if digits.len() > 1 && digits[0].d == 0 {
            return named("price starts with 0", 1);
        }
        let price = digits
            .iter()
            .try_fold(0u64, |acc, d| acc.checked_mul(10)?.checked_add(d.d as u64));
        let confidence = digits
            .iter()
            .map(|d| d.margin)
            .fold(f64::INFINITY, f64::min);
        // The quantity, right to left from "for", until a blank cell.
        let r = percentile(&stds, 0.5).unwrap_or(0.0);
        let mut qd: Vec<Digit> = Vec::new();
        let mut done = false;
        for j in 0..5 {
            let Some(p) = window_patch(
                &band,
                c,
                ff - c.qty_start - c.digit_adv * j as f64,
                y as f64,
                3,
                c.jitter_y,
                c.digit_adv,
            ) else {
                done = true;
                break;
            };
            if inner_std(&p, 6, c.jitter_y) < 0.4 * r {
                done = true;
                break;
            }
            let d = classify(&p, set);
            if d.score < c.qty_min_score {
                qd.clear();
                break;
            }
            qd.push(d);
        }
        let qty = if done && !qd.is_empty() {
            qd.reverse();
            let q = qd.iter().fold(0u32, |acc, d| acc * 10 + d.d as u32);
            (q >= 1 && qd[0].d != 0).then_some(q)
        } else {
            None
        };
        // Sold: the offer text's darkest pixels (5th percentile) are grey.
        let tx0 = ff.max(0.0) as usize;
        let tx1 = band.w.min(m + a.mesos_t.w);
        let ty0 = y;
        let ty1 = band.h.min(y + c.cell_h as usize);
        let mut vals = Vec::new();
        for yy in (ty0..ty1).step_by(2) {
            for xx in (tx0..tx1).step_by(2) {
                vals.push(band.d[yy * band.w + xx] as f64);
            }
        }
        let p5 = percentile(&vals, 0.05);
        let normal_max = c.normal_text_luma.unwrap_or(c.sold_text_luma);
        let sold = p5.and_then(|p| {
            if p > c.sold_text_luma {
                Some(true)
            } else if p < normal_max {
                Some(false)
            } else {
                None
            }
        });
        self.last_scale = Some(s);
        self.last_fine = Some(Fine {
            s,
            hy: hit.y,
            w,
            h,
            f: ff,
        });
        let min_margin = c.min_margin.unwrap_or(0.0);
        let abstain = qty.is_none() || price.is_none() || confidence < min_margin;
        let qty_x0 =
            (ff - c.qty_start - c.digit_adv * qd.len().saturating_sub(1) as f64) * s / c.up;
        let line = OfferLine {
            qx0: Some(qty_x0),
            x0: ff * s / c.up,
            y0: line_y0,
        };
        let nm = read_name(g, w, h, line, s);
        let why = if qty.is_none() {
            "quantity not read"
        } else if confidence < min_margin {
            "a price digit is unsure"
        } else if nm.text.is_none() {
            nm.why
        } else {
            "read"
        };
        AtlasRead {
            price: if abstain { None } else { price },
            qty: if abstain { None } else { qty },
            name: Some(nm),
            sold,
            confidence,
            abstain,
            why: why.to_string(),
            scale: Some(s),
            raw: Some(Raw {
                qty_x0,
                mesos: mesos_v,
            }),
        }
    }
}

fn scales(c: &Canonical) -> Vec<f64> {
    let mut out = Vec::new();
    let mut s = c.scale_min;
    while s <= c.scale_max + 1e-9 {
        out.push(s);
        s *= 1.06;
    }
    out
}

/// The offer line at canonical scale for scale s, with the coarse hit's place in it.
fn canonical_band(g: &[f32], w: usize, h: usize, hit: &Coarse, s: f64) -> Option<Band> {
    let a = &templates::get().atlas;
    let c = &a.canonical;
    let th = a.mesos.h as f64;
    let ya = (hit.y - c.band_above * s / c.up).max(0.0);
    let yb = (h as f64).min(hit.y + (th + c.band_below) * s / c.up);
    let k = c.up / s;
    let dw = js_round(w as f64 * k);
    let dh = js_round((yb - ya) * k);
    if dh < th || dw < a.mesos.w as f64 {
        return None;
    }
    let (dw, dh) = (dw as usize, dh as usize);
    Some(Band {
        d: resample_rect(g, w, h, dw, dh, 0.0, ya, w as f64, yb - ya),
        w: dw,
        h: dh,
        ex: hit.x * k,
        ey: (hit.y - ya) * k,
        ya,
    })
}

fn mesos_on_band(g: &[f32], w: usize, h: usize, hit: &Coarse, s: f64) -> Option<Anchor> {
    let a = &templates::get().atlas;
    let band = canonical_band(g, w, h, hit, s)?;
    let sr = Searchable::new(&band.d, band.w, band.h);
    let b = sr.best_stepped(
        &a.mesos_t,
        band.ex.floor() as i64 - 14,
        band.ex.ceil() as i64 + 14,
        band.ey.floor() as i64 - 14,
        band.ey.ceil() as i64 + 14,
        2,
    )?;
    Some(Anchor {
        v: b.v,
        m: b.x,
        y: b.y,
        s,
        band,
    })
}

/// Digit count n and comma count k that fit the gap between "for" and "mesos".
fn pick_layout(c: &Canonical, f: f64, m: f64) -> (usize, usize, f64, f64) {
    let g = m - f - c.gap0;
    let mut cand: Vec<(f64, usize, usize)> = Vec::new();
    for n in 1..=12usize {
        let mut ks = vec![0usize];
        if !ks.contains(&((n - 1) / 3)) {
            ks.push((n - 1) / 3);
        }
        for k in ks {
            cand.push((
                (g - c.layout_adv * n as f64 - c.comma_w * k as f64).abs(),
                n,
                k,
            ));
        }
    }
    cand.sort_by(|a, b| a.0.total_cmp(&b.0));
    (cand[0].1, cand[0].2, cand[0].0, cand[1].0)
}

fn cells_between(c: &Canonical, f: f64, m: f64, n: usize, k: usize) -> Vec<f64> {
    let start = f + c.for_to_digit;
    let end = m - c.digit_to_mesos;
    let adv = (end - start - c.comma_w * k as f64) / n as f64;
    let mut x = start;
    let mut xs = Vec::with_capacity(n);
    for i in 0..n {
        if k > 0 && i > 0 && (n - i).is_multiple_of(3) {
            x += c.comma_w;
        }
        xs.push(x + (adv - c.digit_adv) / 2.0);
        x += adv;
    }
    xs
}

struct Patch {
    d: Vec<f32>,
    w: usize,
    h: usize,
}

fn window_patch(
    band: &Band,
    c: &Canonical,
    x: f64,
    y: f64,
    jx: i64,
    jy: i64,
    w: f64,
) -> Option<Patch> {
    let (bw, bh) = (band.w as i64, band.h as i64);
    let x0 = js_round(x) as i64 - jx;
    let y0 = js_round(y) as i64 - jy;
    let pw = w as i64 + 2 * jx;
    let ph = c.cell_h as i64 + 2 * jy;
    let x1 = x0 + pw;
    if x1 <= 0 || x0 >= bw {
        return None;
    }
    let halfw = (w / 2.0).floor() as i64;
    if -x0 > halfw || x1 - bw > halfw {
        return None;
    }
    let mut d = vec![0f32; (pw * ph) as usize];
    for yy in 0..ph {
        let sy = (y0 + yy).clamp(0, bh - 1);
        for xx in 0..pw {
            let sx = (x0 + xx).clamp(0, bw - 1);
            d[(yy * pw + xx) as usize] = band.d[(sy * bw + sx) as usize];
        }
    }
    Some(Patch {
        d,
        w: pw as usize,
        h: ph as usize,
    })
}

fn inner_std(p: &Patch, jx: i64, jy: i64) -> f64 {
    let (jx, jy) = (jx.max(0) as usize, jy.max(0) as usize);
    let (mut s1, mut s2, mut n) = (0f64, 0f64, 0usize);
    for y in jy..p.h.saturating_sub(jy) {
        for x in jx..p.w.saturating_sub(jx) {
            let v = p.d[y * p.w + x] as f64;
            s1 += v;
            s2 += v * v;
            n += 1;
        }
    }
    if n == 0 {
        return 0.0;
    }
    let m = s1 / n as f64;
    (s2 / n as f64 - m * m).max(0.0).sqrt()
}

fn classify(p: &Patch, set: &[Prepared]) -> Digit {
    let sr = Searchable::new(&p.d, p.w, p.h);
    let mut sc: Vec<(f64, u8)> = set
        .iter()
        .enumerate()
        .map(|(d, t)| (sr.best_all(t, 1).map_or(-1.0, |h| h.v), d as u8))
        .collect();
    sc.sort_by(|a, b| b.0.total_cmp(&a.0));
    Digit {
        d: sc[0].1,
        score: sc[0].0,
        margin: sc[0].0 - sc[1].0,
    }
}

//! Letters matched against the atlas's letter templates (reader.js
//! recognize), for names the exact font cannot read (a stretched row read
//! by the atlas matcher). The band is turned into an ink map relative to its
//! own paper and darkest text, cut into ink blobs at empty columns, and each
//! blob matched; a blob wider than one letter may split into 2-4 letters.

use std::collections::HashMap;

use super::super::image::{ncc_flat, resample};
use super::super::js_round;
use super::super::templates::{self, Letter};

/// A band already at the letters' scale (dark text on a light ground).
pub struct Band {
    pub d: Vec<f32>,
    pub w: usize,
    pub h: usize,
    /// Where the band sits in the row picture: x0, y0, y1.
    pub at: [usize; 3],
    /// Expected top row of the capitals (from the offer line), if known.
    pub y_top: Option<f64>,
    /// Ink threshold of the ink map (default 0.5).
    pub thr: Option<f64>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Recognized {
    pub text: Option<String>,
    pub score: Option<f64>,
    pub why: &'static str,
}

impl Recognized {
    fn none(why: &'static str) -> Self {
        Self {
            text: None,
            score: None,
            why,
        }
    }
}

fn ink_map(b: &Band) -> Option<Vec<f32>> {
    let n = &templates::get().atlas.letters;
    let mut a: Vec<f32> = b.d.clone();
    a.sort_by(f32::total_cmp);
    let mut bg = a[(a.len() as f64 * 0.6) as usize] as f64;
    let mut dark = a[(a.len() as f64 * 0.01) as usize] as f64;
    if n.ink_bg.as_deref() == Some("mode") {
        // The paper is the most common grey; the text's dark is the 1st
        // percentile of the band's left 60% (where every name starts).
        let mut hist = [0u32; 64];
        for &v in &b.d {
            hist[((v as i32) >> 2).clamp(0, 63) as usize] += 1;
        }
        let mi = (0..64).fold(0, |m, i| if hist[i] > hist[m] { i } else { m });
        bg = (mi * 4 + 2) as f64;
        let xw = js_round(b.w as f64 * 0.6) as usize;
        let mut left: Vec<f32> = (0..b.h)
            .flat_map(|y| (0..xw).map(move |x| (y, x)))
            .map(|(y, x)| b.d[y * b.w + x])
            .collect();
        left.sort_by(f32::total_cmp);
        if let Some(&v) = left.get((left.len() as f64 * 0.01) as usize) {
            dark = v as f64;
        }
    }
    let span = bg - dark;
    if span < n.min_contrast {
        return None;
    }
    Some(
        b.d.iter()
            .map(|&v| ((bg - v as f64) / span * 1.6 - 0.3).clamp(0.0, 1.0) as f32)
            .collect(),
    )
}

struct Blobs {
    ya: usize,
    cols: Vec<(usize, usize)>,
}

fn ink_blobs(b: &Band, m: &mut [f32]) -> Option<Blobs> {
    let fh = templates::get().atlas.letters.fh as f64;
    let t = b.thr.unwrap_or(0.5) as f32;
    let (w, h) = (b.w, b.h);
    let mut rp: Vec<f64> = (0..h)
        .map(|y| (0..w).filter(|&x| m[y * w + x] > t).count() as f64)
        .collect();
    if let Some(top) = b.y_top {
        for (y, r) in rp.iter_mut().enumerate() {
            if (y as f64) < top - 6.0 || y as f64 > top + fh {
                *r = 0.0;
            }
        }
    }
    // A row of ink across most of the band is a border or a highlight edge.
    for y in 0..h {
        if rp[y] > 0.5 * w as f64 {
            rp[y] = 0.0;
            m[y * w..(y + 1) * w].fill(0.0);
        }
    }
    let mut best: Option<(usize, usize, f64)> = None;
    let mut cur: Option<(usize, f64)> = None;
    for (y, &r) in rp.iter().chain(std::iter::once(&0.0)).enumerate() {
        if r >= 1.0 {
            let c = cur.get_or_insert((y, 0.0));
            c.1 += r;
        } else if let Some((a, n)) = cur.take() {
            if best.is_none_or(|b| n > b.2) {
                best = Some((a, y, n));
            }
        }
    }
    let (ya, yb, _) = best?;
    let cp: Vec<f64> = (0..w)
        .map(|x| (ya..yb).filter(|&y| m[y * w + x] > t).count() as f64)
        .collect();
    let mut cols: Vec<(usize, usize)> = Vec::new();
    let mut st: Option<usize> = None;
    for x in 0..=w {
        let on = x < w && cp[x] >= 1.0;
        if on && st.is_none() {
            st = Some(x);
        }
        if !on {
            if let Some(s) = st.take() {
                if cp[s..x].iter().sum::<f64>() >= 3.0 {
                    if cols.last().is_some_and(|l| s - l.1 > 24) {
                        break;
                    }
                    cols.push((s, x));
                }
            }
        }
    }
    Some(Blobs { ya, cols })
}

/// Recognises the band's letters. `min_score` overrides the atlas's mean
/// letter score; `letters` the templates (the seller's own set).
pub fn recognize(
    b: &Band,
    min_score: Option<f64>,
    letters: Option<&[Letter]>,
    split_min_w: usize,
) -> Recognized {
    let atlas = &templates::get().atlas;
    let n = &atlas.letters;
    let ls = letters.unwrap_or(&atlas.letter_glyphs);
    let Some(mut m) = ink_map(b) else {
        return Recognized::none("name band has no text contrast");
    };
    let Some(blobs) = ink_blobs(b, &mut m) else {
        return Recognized::none("no name text");
    };
    if blobs.cols.is_empty() {
        return Recognized::none("no name text");
    }
    #[derive(Clone)]
    struct Glyph {
        ch: String,
        s: f64,
    }
    let mut memo: HashMap<(usize, usize, usize, bool), Glyph> = HashMap::new();
    let mut best = |ya: usize, c0: usize, c1: usize, strict: bool| -> Glyph {
        if let Some(g) = memo.get(&(ya, c0, c1, strict)) {
            return g.clone();
        }
        let gw = c1 - c0;
        let mut sub = vec![0f32; gw * n.fh];
        for y in 0..n.fh {
            let yy = ya + y;
            if yy >= b.h {
                break;
            }
            sub[y * gw..(y + 1) * gw].copy_from_slice(&m[yy * b.w + c0..yy * b.w + c1]);
        }
        let f = resample(&sub, gw, n.fh, n.gw, n.gh);
        let mut top = Glyph {
            ch: "?".into(),
            s: -9.0,
        };
        for l in ls {
            if strict && (gw as f64 - l.w).abs() > (n.width_tol * l.wsd).max(2.0) {
                continue;
            }
            let v = ncc_flat(&f, &l.t) - n.width_cost * (gw as f64 - l.w).abs();
            if v > top.s {
                top = Glyph {
                    ch: l.ch.clone(),
                    s: v,
                };
            }
        }
        memo.insert((ya, c0, c1, strict), top.clone());
        top
    };
    let decode = |ya: usize,
                  best: &mut dyn FnMut(usize, usize, usize, bool) -> Glyph|
     -> (String, f64) {
        let mut text = String::new();
        let mut scores = Vec::new();
        for (i, &(c0, c1)) in blobs.cols.iter().enumerate() {
            if i > 0 && c0 - blobs.cols[i - 1].1 >= n.space {
                text.push(' ');
            }
            let len = c1 - c0;
            // Best split of the blob into up to 4 letters.
            let mut dp: Vec<Option<(f64, Vec<Glyph>)>> = vec![None; len + 1];
            dp[0] = Some((0.0, Vec::new()));
            for e in 1..=len {
                for st in e.saturating_sub(22)..=e.saturating_sub(3) {
                    if e < 3 {
                        break;
                    }
                    let Some((ps, parts)) = dp[st].clone() else {
                        continue;
                    };
                    if parts.len() >= 4 {
                        continue;
                    }
                    let gl = best(ya, c0 + st, c0 + e, true);
                    let v = ps + (gl.s - 1.0) - if parts.is_empty() { 0.0 } else { n.split_cost };
                    if dp[e].as_ref().is_none_or(|d| v > d.0) {
                        let mut p = parts;
                        p.push(gl);
                        dp[e] = Some((v, p));
                    }
                }
            }
            let one = best(ya, c0, c1, false);
            let pick = match &dp[len] {
                Some((s, parts)) if parts.len() > 1 && *s > one.s - 1.0 && len > split_min_w => {
                    parts.clone()
                }
                _ => vec![one],
            };
            for g in pick {
                text.push_str(&g.ch);
                scores.push(g.s);
            }
        }
        let mean = scores.iter().sum::<f64>() / scores.len().max(1) as f64;
        (text, mean)
    };
    // The letters' top row: among the blob top +- ya_pick and the offer line's
    // prediction, the one where the first 3 blobs match best as whole letters.
    let mut ya0 = blobs.ya;
    if n.ya_pick > 0 {
        let mut cand: Vec<i64> = Vec::new();
        for d in -n.ya_pick..=n.ya_pick {
            for c in [
                Some(blobs.ya as i64 + d),
                b.y_top.map(|t| js_round(t) as i64 + d),
            ]
            .into_iter()
            .flatten()
            {
                if !cand.contains(&c) {
                    cand.push(c);
                }
            }
        }
        let mut bs = f64::NEG_INFINITY;
        for ya in cand {
            if ya < 0 || ya as usize + n.fh > b.h + 4 {
                continue;
            }
            let t: f64 = blobs
                .cols
                .iter()
                .take(3)
                .map(|&(c0, c1)| best(ya as usize, c0, c1, false).s)
                .sum();
            if t > bs + 1e-9 || ((t - bs).abs() <= 1e-9 && ya as usize == blobs.ya) {
                bs = t;
                ya0 = ya as usize;
            }
        }
    }
    let (mut text, mut mean) = decode(ya0, &mut best);
    let min_s = min_score.unwrap_or(n.min_mean_score);
    for d in 1..=n.ya_search {
        if mean >= min_s {
            break;
        }
        for ya in [ya0 as i64 - d, ya0 as i64 + d] {
            if ya < 0 || ya as usize + n.fh > b.h + 4 {
                continue;
            }
            let (t, m2) = decode(ya as usize, &mut best);
            if m2 > mean {
                text = t;
                mean = m2;
            }
        }
    }
    if mean < min_s {
        return Recognized {
            text: None,
            score: Some(mean),
            why: "letters match too weakly",
        };
    }
    Recognized {
        text: Some(text),
        score: Some(mean),
        why: "read",
    }
}

/// The offer line's place in a row picture (row px), from the atlas matcher.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct OfferLine {
    /// Left edge of the quantity.
    pub qx0: Option<f64>,
    /// Left edge of "for".
    pub x0: f64,
    pub y0: f64,
}

/// The item name band above the offer line, at the letters' scale.
pub fn name_band(g: &[f32], w: usize, h: usize, line: OfferLine, s: f64) -> Option<Band> {
    let n = &templates::get().atlas.letters;
    let y0 = js_round(line.y0 - n.band_top * s).max(0.0);
    let y1 = js_round(line.y0 - n.band_bottom * s).min(h as f64);
    let left = match (n.band_left_of_qty, line.qx0) {
        (Some(l), Some(q)) => q - l * s,
        _ => line.x0 - n.band_left * s,
    };
    let x0 = js_round(left).max(0.0);
    let x1 = js_round(line.x0 + n.band_right.unwrap_or(1e6) * s).min(w as f64);
    if y1 - y0 < 4.0 || x1 - x0 < 8.0 {
        return None;
    }
    let (x0, y0, x1, y1) = (x0 as usize, y0 as usize, x1 as usize, y1 as usize);
    let (sw, sh) = (x1 - x0, y1 - y0);
    let mut sub = Vec::with_capacity(sw * sh);
    for y in 0..sh {
        sub.extend_from_slice(&g[(y0 + y) * w + x0..(y0 + y) * w + x1]);
    }
    let k = n.nk / s;
    let (bw, bh) = (
        js_round(sw as f64 * k) as usize,
        js_round(sh as f64 * k) as usize,
    );
    if bw < 8 || bh < 8 {
        return None;
    }
    Some(Band {
        d: resample(&sub, sw, sh, bw, bh),
        w: bw,
        h: bh,
        at: [x0, y0, y1],
        y_top: n.name_top.map(|t| (line.y0 - t * s - y0 as f64) * k),
        thr: None,
    })
}

/// The item name above an offer line.
pub fn read_name(g: &[f32], w: usize, h: usize, line: OfferLine, s: f64) -> Recognized {
    match name_band(g, w, h, line, s) {
        Some(b) => recognize(&b, None, None, 0),
        None => Recognized::none("name band outside the row"),
    }
}

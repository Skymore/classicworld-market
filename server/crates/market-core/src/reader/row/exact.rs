//! Exact reading of a shop row at a whole-number scale (reader.js readExact).
//!
//! The row's text is a 1-bit pixel font on flat colours, so a clean row
//! reads glyph by glyph with no scores. Measured on recordings at UI scale 1,
//! within a 262 x 38 game px row box: an unsold row is ink 0 on paper 215, a
//! sold row ink 187 on paper 244 (its last row and column stay 215); the
//! underline between the two lines is 255. Any other colour in the text box
//! is the cursor or a tooltip: the row is covered in this frame.

use super::super::font::{exact_line, fix_il, Line};
use super::super::templates;
use super::super::{js_round, Rgba};

pub const ROW_W: usize = 262;
const X0: i64 = 41;
const X1: i64 = 203;
const Y0: i64 = 2;
const TOL: i32 = 6;
const LIGHT: i32 = 250;

/// Paper and ink of one row kind.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Kind {
    Unsold,
    Sold,
}

impl Kind {
    fn paper(self) -> i32 {
        match self {
            Kind::Unsold => 215,
            Kind::Sold => 244,
        }
    }
    fn ink(self) -> i32 {
        match self {
            Kind::Unsold => 0,
            Kind::Sold => 187,
        }
    }
    fn ink_tol(self) -> i32 {
        match self {
            Kind::Unsold => 40,
            Kind::Sold => 12,
        }
    }
}

#[derive(Debug, Clone, PartialEq)]
pub enum Exact {
    /// The cursor or a tooltip is over the text: not read in this frame.
    Covered {
        kind: Kind,
    },
    Read(ExactRow),
}

#[derive(Debug, Clone, PartialEq)]
pub struct ExactRow {
    pub kind: Kind,
    /// "?" where the font lacks a glyph; ends in "..." when cut.
    pub name: Option<String>,
    /// A scroll's grade from its icon, when the name is cut before it.
    pub grade: Option<&'static str>,
    pub offer: String,
    /// (bundle size, price of the bundle) when the offer is "N for P mesos".
    pub offer_parsed: Option<(u32, u64)>,
    pub k: usize,
}

/// The row in game pixels (the centre of each k x k block), integer luma.
pub struct GamePixels {
    pub y: Vec<i32>,
    pub w: usize,
    pub h: usize,
    pub k: usize,
}

pub fn game_pixels(img: &Rgba) -> Option<GamePixels> {
    let k = js_round(img.width as f64 / ROW_W as f64);
    if !(1.0..=4.0).contains(&k) || (img.width as f64 - ROW_W as f64 * k).abs() > k {
        return None;
    }
    let k = k as usize;
    let (w, h, o) = (img.width / k, img.height / k, k >> 1);
    let mut y = vec![0i32; w * h];
    for gy in 0..h {
        for gx in 0..w {
            y[gy * w + gx] = js_round(img.luma(gx * k + o, gy * k + o)) as i32;
        }
    }
    Some(GamePixels { y, w, h, k })
}

/// "N for P mesos" (the quantity may carry commas from 1,000). The tail may
/// be any start of "mesos" and an ellipsis.
pub fn parse_offer(text: &str) -> Option<(u32, u64)> {
    let (qty, rest) = text.split_once(" for ")?;
    let (price, tail) = rest.split_once(' ')?;
    let tail = tail.strip_suffix("...").unwrap_or(tail);
    if !"mesos".starts_with(tail) {
        return None;
    }
    let qty_ok = (qty.len() <= 4 && qty.chars().all(|c| c.is_ascii_digit()) && !qty.is_empty())
        || (qty.contains(',') && grouped(qty));
    if !qty_ok || !grouped(price) {
        return None;
    }
    let num = |s: &str| s.replace(',', "").parse::<u64>().ok();
    let q = u32::try_from(num(qty)?).ok()?;
    Some((q, num(price)?))
}

/// \d{1,3}(,\d{3})*
fn grouped(s: &str) -> bool {
    let mut parts = s.split(',');
    let first = parts.next().unwrap_or("");
    let digits = |p: &str| p.chars().all(|c| c.is_ascii_digit());
    (1..=3).contains(&first.len()) && digits(first) && parts.all(|p| p.len() == 3 && digits(p))
}

/// A scroll's grade from its icon's mean hue (Greater gold, Intermediate
/// red-orange, Lesser blue).
pub fn scroll_grade(img: &Rgba, k: usize) -> Option<&'static str> {
    const GRADES: [(&str, f64, f64); 3] = [
        ("Greater", 30.0, 50.0),
        ("Intermediate", 8.0, 28.0),
        ("Lesser", 170.0, 230.0),
    ];
    let (mut sx, mut sy, mut n, mut tot) = (0f64, 0f64, 0usize, 0usize);
    for y in 4 * k..(34 * k).min(img.height) {
        for x in 6 * k..(36 * k).min(img.width) {
            let (r, g, b) = img.rgb(x, y);
            let (r, g, b) = (r as f64, g as f64, b as f64);
            let (mx, mn) = (r.max(g).max(b), r.min(g).min(b));
            tot += 1;
            if mx < 60.0 || mx - mn < 18.0 {
                continue;
            }
            let sector = if mx == r {
                ((g - b) / (mx - mn)) % 6.0
            } else if mx == g {
                (b - r) / (mx - mn) + 2.0
            } else {
                (r - g) / (mx - mn) + 4.0
            };
            let h = sector * std::f64::consts::PI / 3.0;
            sx += h.cos();
            sy += h.sin();
            n += 1;
        }
    }
    if n == 0 || (n as f64) / (tot as f64) < 0.15 {
        return None;
    }
    let mut deg = sy.atan2(sx).to_degrees();
    if deg < 0.0 {
        deg += 360.0;
    }
    GRADES
        .iter()
        .find(|(_, lo, hi)| deg >= *lo && deg <= *hi)
        .map(|g| g.0)
}

/// Reads a row cut at a whole-number k. `tol`: an un-stretched row's own
/// tolerance (the least-squares fit adds a few luma of noise).
pub fn read_exact(img: &Rgba, tol: Option<i32>) -> Option<Exact> {
    let font = &templates::get().font;
    let p = game_pixels(img)?;
    let (w, h) = (p.w as i64, p.h as i64);
    let x1 = X1.min(w);
    let at = |x: i64, y: i64| p.y[(y * w + x) as usize];
    // The paper: the most common grey of the text box (first to reach it on ties).
    let mut hist = [0u32; 256];
    let (mut top, mut paper) = (0u32, -1i32);
    for y in Y0..h - 2 {
        for x in X0..x1 {
            let v = at(x, y).clamp(0, 255);
            hist[v as usize] += 1;
            if hist[v as usize] > top {
                top = hist[v as usize];
                paper = v;
            }
        }
    }
    if paper < 0 {
        return None;
    }
    let tolv = tol.unwrap_or(TOL);
    let kind = if (paper - Kind::Unsold.paper()).abs() <= tolv {
        Kind::Unsold
    } else if (paper - Kind::Sold.paper()).abs() <= tolv {
        Kind::Sold
    } else {
        return None;
    };
    let (ink_v, ink_tol) = (kind.ink(), kind.ink_tol());
    let is_ink = |v: i32| (v - ink_v).abs() <= ink_tol;
    // 1: off the palette, 2: the cursor's white glove.
    let mut odd = vec![0u8; (w * h) as usize];
    for y in Y0..h - 2 {
        for x in X0..x1 {
            let v = at(x, y);
            let glove = v >= LIGHT && !(18..=20).contains(&y);
            if tol.is_some()
                && (v - 246).abs() <= 4
                && (x <= X0 + 1 || x >= x1 - 2 || y <= Y0 + 1 || y >= h - 4)
            {
                continue;
            }
            if !glove
                && ((v - paper).abs() <= tolv
                    || is_ink(v)
                    || v >= LIGHT
                    || ((18..=20).contains(&y) && v >= 238)
                    || (kind == Kind::Sold && (v - Kind::Unsold.paper()).abs() <= tolv))
            {
                continue;
            }
            odd[(y * w + x) as usize] = if glove { 2 } else { 1 };
        }
    }
    // A speck: an odd pixel in an 8-connected patch of at most 2.
    let lone = |x: i64, y: i64| {
        let mut seen = vec![(x, y)];
        let mut s = 0;
        while s < seen.len() {
            let (px, py) = seen[s];
            for dy in -1..=1 {
                for dx in -1..=1 {
                    let (qx, qy) = (px + dx, py + dy);
                    if (dx != 0 || dy != 0)
                        && qx >= 0
                        && qx < w
                        && qy >= 0
                        && qy < h
                        && odd[(qy * w + qx) as usize] != 0
                        && !seen.contains(&(qx, qy))
                    {
                        seen.push((qx, qy));
                        if seen.len() > 2 {
                            return false;
                        }
                    }
                }
            }
            s += 1;
        }
        true
    };
    let (mut off, mut ramp) = (0usize, 0usize);
    let (mut cx, mut cy0, mut cy1) = (i64::MAX, i64::MAX, i64::MIN);
    for y in Y0..h - 2 {
        for x in X0..x1 {
            let o = odd[(y * w + x) as usize];
            if o == 0 {
                continue;
            }
            let v = at(x, y);
            if o == 1 {
                off += 1;
                let nb = [
                    if x > 0 { at(x - 1, y) } else { v },
                    if x + 1 < w { at(x + 1, y) } else { v },
                    if y > 0 { at(x, y - 1) } else { v },
                    if y + 1 < h { at(x, y + 1) } else { v },
                ];
                if nb.iter().any(|&u| u <= v - 15) && nb.iter().any(|&u| u >= v + 15) {
                    ramp += 1;
                }
            }
            if tol.is_some()
                && (v - paper).abs() <= 2 * tolv
                && (v - paper).abs() < (v - ink_v).abs()
                && lone(x, y)
            {
                continue;
            }
            cx = cx.min(x);
            cy0 = cy0.min(y);
            cy1 = cy1.max(y);
        }
    }
    // A blurred (smoothly stretched) row is not at a whole-number scale.
    if off >= 40 && ramp as f64 >= 0.3 * off as f64 {
        return None;
    }
    // A cover right of the text: each line it reaches is read up to 3 game px before it.
    let cut = (cx < i64::MAX).then(|| (cx - 3, cy0 - 3, cy1 + 3));
    let covered = Some(Exact::Covered { kind });
    if cut.is_some_and(|c| c.0 < X0 + 8) {
        return covered;
    }
    let ink = |x: i64, y: i64| {
        x >= X0
            && x < x1
            && y >= 0
            && y < h
            && is_ink(at(x, y))
            && !cut.is_some_and(|(cxx, a, b)| x >= cxx && y >= a && y <= b)
    };
    // The two lines: clusters of rows with ink.
    let count: Vec<usize> = (0..h)
        .map(|y| (X0..x1).filter(|&x| ink(x, y)).count())
        .collect();
    let mut clusters: Vec<(i64, i64)> = Vec::new();
    let mut cur: Option<(i64, i64)> = None;
    for y in 0..h {
        if count[y as usize] > 0 {
            cur = Some(cur.map_or((y, y), |(a, _)| (a, y)));
        } else if let Some((a, b)) = cur {
            if y - b > 1 {
                clusters.push((a, b));
                cur = None;
            }
        }
    }
    clusters.extend(cur);
    struct Read {
        line: Line,
        cut: bool,
        x1: i64,
    }
    let above = font.above as i64;
    let below = font.below as i64;
    let lines: Vec<Option<Read>> = clusters
        .iter()
        .filter(|(a, b)| b - a >= 5)
        .map(|&(a, b)| {
            let mut best: Option<Read> = None;
            for base in above.max(a + 6)..=b {
                let cut_here =
                    cut.is_some_and(|(_, c0, c1)| base - above <= c1 && base + below >= c0);
                let lx = if cut_here {
                    cut.map_or(x1, |c| c.0)
                } else {
                    x1
                };
                if let Some(t) = exact_line(font, &ink, X0, lx, base) {
                    let better = best.as_ref().is_none_or(|bst| {
                        t.unknown < bst.line.unknown
                            || (t.unknown == bst.line.unknown && t.n > bst.line.n)
                    });
                    if better {
                        best = Some(Read {
                            line: t,
                            cut: cut_here,
                            x1: lx,
                        });
                    }
                }
                if best.as_ref().is_some_and(|b| b.line.unknown == 0) {
                    break;
                }
            }
            best
        })
        .collect();
    let offer_line = match lines.as_slice() {
        [_, Some(l)] if l.line.unknown == 0 => l,
        _ => return if cut.is_some() { covered } else { None },
    };
    // The offer starts at game px 44-48 with one plain space each side of "for";
    // a wider space means a cover blurred into the paper hid a glyph.
    let l1 = &offer_line.line;
    let spaced = (44..=48).contains(&l1.start) && l1.gaps.len() >= 2 && l1.gaps[1] <= 5;
    let mut parsed = if spaced { parse_offer(&l1.text) } else { None };
    let words: Vec<&str> = l1.text.split(' ').collect();
    if parsed.is_some()
        && l1.gaps.iter().enumerate().any(|(i, &g)| {
            g > if words.get(i).is_some_and(|w| w.ends_with('1')) {
                7
            } else {
                5
            }
        })
    {
        parsed = None;
    }
    if cut.is_some() {
        let b = offer_line;
        if b.cut && (b.line.end >= b.x1 || parsed.is_none() || !b.line.text.ends_with(" mesos")) {
            return covered;
        }
        if let Some(a) = &lines[0] {
            if a.cut && (a.line.end >= a.x1 || a.line.unknown > 0) {
                return covered;
            }
        }
    }
    let mut name = lines[0]
        .as_ref()
        .filter(|a| a.line.unknown <= 3 && a.line.unknown < a.line.n)
        .map(|a| fix_il(&a.line.text));
    if let (Some(n), Some(a)) = (name.as_mut(), lines[0].as_ref()) {
        if a.cut && a.x1 - a.line.end < 10 && !n.ends_with("...") {
            n.push_str("...");
        }
    }
    let grade = name
        .as_deref()
        .filter(|n| (n.ends_with("...") || n.contains("Scroll")) && !has_grade(n))
        .and_then(|_| scroll_grade(img, p.k));
    Some(Exact::Read(ExactRow {
        kind,
        name,
        grade,
        offer: l1.text.clone(),
        offer_parsed: parsed,
        k: p.k,
    }))
}

fn has_grade(n: &str) -> bool {
    ["Greater", "Intermediate", "Lesser", "Chaos"]
        .iter()
        .any(|g| n.ends_with(&format!(": {g}")))
}

/// Whether a row cut at a whole k is blurred: 30%+ of its text box's
/// off-palette pixels are ramps (reader.js smoothRow).
pub fn smooth_row(img: &Rgba, k: f64) -> bool {
    let (w, h) = (img.width as i64, img.height as i64);
    let l = |x: i64, y: i64| img.luma(x as usize, y as usize);
    let btw =
        |a: f64, v: f64, b: f64| (a <= v - 6.0 && b >= v + 6.0) || (a >= v + 6.0 && b <= v - 6.0);
    let (mut off, mut ramp) = (0usize, 0usize);
    let y_lo = (js_round(2.0 * k) as i64).max(1);
    let y_hi = (h - 1).min(h - js_round(2.0 * k) as i64);
    let x_lo = (js_round(41.0 * k) as i64).max(1);
    let x_hi = (w - 1).min(js_round(203.0 * k) as i64);
    for y in y_lo..y_hi {
        for x in x_lo..x_hi {
            let v = l(x, y);
            if (v - 215.0).abs() <= 6.0
                || (v - 244.0).abs() <= 6.0
                || v <= 40.0
                || v >= 250.0
                || (v - 187.0).abs() <= 12.0
            {
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

/// Whether a row cut at a whole k sits on a sharp k x k grid, however
/// blurred: steps inside a block are under 45% of steps across block edges.
pub fn sharp_grid(img: &Rgba, k: usize) -> bool {
    let (w, h) = (img.width, img.height);
    let lum: Vec<f64> = (0..w * h).map(|i| img.luma(i % w, i / w)).collect();
    let kf = k as f64;
    let x0 = js_round(41.0 * kf) as usize;
    let x1 = (w - 1).min(js_round(203.0 * kf) as usize);
    let y0 = js_round(2.0 * kf) as usize;
    let y1 = (h - 1).min(h.saturating_sub(js_round(2.0 * kf) as usize));
    let axis = |dx: usize, dy: usize| {
        let mut best = f64::INFINITY;
        for p in 0..k {
            let (mut si, mut ni, mut sc, mut nc) = (0f64, 0usize, 0f64, 0usize);
            for y in y0..y1 {
                for x in x0..x1 {
                    let st = (lum[(y + dy) * w + x + dx] - lum[y * w + x]).abs();
                    let c = if dx > 0 { x } else { y };
                    if (c + k - p) % k == k - 1 {
                        sc += st;
                        nc += 1;
                    } else {
                        si += st;
                        ni += 1;
                    }
                }
            }
            if ni > 0 && nc > 0 && sc > 0.0 {
                best = best.min((si / ni as f64) / (sc / nc as f64));
            }
        }
        best
    };
    axis(1, 0).max(axis(0, 1)) < 0.45
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn offers_parse() {
        assert_eq!(parse_offer("10 for 45,000 mesos"), Some((10, 45_000)));
        assert_eq!(parse_offer("1,000 for 45,000 mesos"), Some((1000, 45_000)));
        assert_eq!(parse_offer("3 for 999 me..."), Some((3, 999)));
        assert_eq!(parse_offer("3 for 999 ..."), Some((3, 999)));
        assert_eq!(parse_offer("10 for 45,00 mesos"), None);
        assert_eq!(parse_offer("10000 for 5 mesos"), None);
        assert_eq!(parse_offer("10 for 45,000"), None);
        assert_eq!(parse_offer("10 for 45,000 mosos"), None);
    }
}

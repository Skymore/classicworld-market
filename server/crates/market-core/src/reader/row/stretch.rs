//! A smoothly stretched row back on game pixels (reader.js unstretchRow).
//!
//! Fullscreen 1920x1080 shows the game's 1366x768 picture stretched x1.406
//! with bilinear filtering, so each screen pixel is a known blend of at most
//! 2 x 2 game pixels. Least squares undoes the blend one axis at a time
//! (each axis is a tridiagonal system) and gives back the game's own pixels
//! for the exact reader. The grid phase is the one whose pixels sit closest
//! to the row palette; the stretch factor reported by the window finder can
//! be a few percent off, so it is searched within 5% once per reported
//! factor and the factor found is kept.

use std::collections::HashMap;

use super::super::image::Gray;
use super::super::{js_round, Rgba, RgbaBuf};
use super::exact::ROW_W;

/// One axis: `m` screen px at `s` screen px per game px, game px 0 at
/// screen (p + 0.5) * s - 0.5. Its LDL factors.
struct Axis {
    n: usize,
    xs: Vec<usize>,
    is: Vec<usize>,
    fs: Vec<f64>,
    c: Vec<f64>,
    dd: Vec<f64>,
}

fn axis(s: f64, p: f64, m: usize) -> Option<Axis> {
    let u = |x: f64| (x + 0.5) / s - 0.5 - p;
    let g0 = (u(0.0) - 1e-6).ceil();
    let n = (u(m as f64 - 1.0) + 1e-6).floor() - g0 + 1.0;
    if n < 2.0 {
        return None;
    }
    let n = n as usize;
    let (mut xs, mut is, mut fs) = (Vec::new(), Vec::new(), Vec::new());
    let mut dg = vec![0f64; n];
    let mut of = vec![0f64; n];
    for x in 0..m {
        let t = u(x as f64) - g0;
        if t < -1e-6 || t > (n - 1) as f64 + 1e-6 {
            continue;
        }
        let mut i = (t + 1e-6).floor().max(0.0) as usize;
        let mut f = (t - i as f64).max(0.0);
        if i >= n - 1 {
            i = n - 1;
            f = 0.0;
        }
        xs.push(x);
        is.push(i);
        fs.push(f);
        dg[i] += (1.0 - f) * (1.0 - f);
        if f > 0.0 {
            dg[i + 1] += f * f;
            of[i] += (1.0 - f) * f;
        }
    }
    let mut c = vec![0f64; n];
    let mut dd = vec![0f64; n];
    dd[0] = dg[0];
    for i in 1..n {
        c[i - 1] = of[i - 1] / dd[i - 1];
        dd[i] = dg[i] - of[i - 1] * c[i - 1];
        // A NaN pivot fails too.
        if dd[i].is_nan() || dd[i] <= 1e-6 {
            return None;
        }
    }
    Some(Axis {
        n,
        xs,
        is,
        fs,
        c,
        dd,
    })
}

/// Solves one line: `get(x)` reads screen px x, the result is in `b[..n]`.
fn solve(a: &Axis, get: impl Fn(usize) -> f64, b: &mut [f64]) {
    let n = a.n;
    b[..n].fill(0.0);
    for j in 0..a.xs.len() {
        let v = get(a.xs[j]);
        let (i, f) = (a.is[j], a.fs[j]);
        b[i] += (1.0 - f) * v;
        if f > 0.0 {
            b[i + 1] += f * v;
        }
    }
    for i in 1..n {
        b[i] -= a.c[i - 1] * b[i - 1];
    }
    b[n - 1] /= a.dd[n - 1];
    for i in (0..n - 1).rev() {
        b[i] = b[i] / a.dd[i] - a.c[i] * b[i + 1];
    }
}

/// A plane (w x h screen px) back on game px with phases px, py.
pub fn unstretch_plane(src: &[f32], w: usize, h: usize, s: f64, px: f64, py: f64) -> Option<Gray> {
    let ax = axis(s, px, w)?;
    let ay = axis(s, py, h)?;
    let (nx, ny) = (ax.n, ay.n);
    let mut t = vec![0f32; h * nx];
    let mut v = vec![0f32; ny * nx];
    let mut b = vec![0f64; nx.max(ny)];
    for y in 0..h {
        solve(&ax, |x| src[y * w + x] as f64, &mut b);
        for i in 0..nx {
            t[y * nx + i] = b[i] as f32;
        }
    }
    for x in 0..nx {
        solve(&ay, |y| t[y * nx + x] as f64, &mut b);
        for i in 0..ny {
            v[i * nx + x] = b[i] as f32;
        }
    }
    Some(Gray::new(nx, ny, v))
}

/// The row's palette (luma): ink, sold ink, paper, sold paper, frame, white.
pub const PALETTE: [f64; 7] = [0.0, 187.0, 215.0, 244.0, 246.0, 253.0, 255.0];

/// Summed distance to the palette (at most 40 a pixel) over columns
/// x0f..x1f of the plane.
pub fn palette_miss(p: &Gray, pal: &[f64], x0f: f64, x1f: f64) -> f64 {
    let (xa, xb) = (
        js_round(p.w as f64 * x0f) as usize,
        js_round(p.w as f64 * x1f) as usize,
    );
    let mut e = 0f64;
    for y in 0..p.h {
        for x in xa..xb.min(p.w) {
            let v = p.d[y * p.w + x] as f64;
            let mut d = 40f64;
            for &q in pal {
                d = d.min((v - q).abs());
            }
            e += d;
        }
    }
    e
}

#[inline]
pub fn mod1(v: f64) -> f64 {
    ((v % 1.0) + 1.0) % 1.0
}

#[derive(Debug, Clone, Copy)]
pub struct Phase {
    /// Mean miss a pixel.
    pub e: f64,
    pub px: f64,
    pub py: f64,
}

pub struct Seed {
    pub px: f64,
    pub py: f64,
    pub max: f64,
}

/// The grid phases of a stretched plane `s` (sw x h, its first column `x0`
/// screen px into the cut) whose unstretched pixels sit closest to the
/// palette: a coarse grid, then each phase alone in finer steps. `coarse`:
/// the coarse grid's size (default 8, 16 near a whole k).
#[allow(clippy::too_many_arguments)]
pub fn fit_phase(
    s: &[f32],
    sw: usize,
    h: usize,
    k: f64,
    x0: f64,
    miss: &dyn Fn(&Gray) -> f64,
    seed: Option<Seed>,
    coarse: Option<usize>,
) -> Option<Phase> {
    let sub = |px: f64| mod1(px - x0 / k);
    let mut best: Option<Phase> = None;
    let mut try_p = |px: f64, py: f64, best: &mut Option<Phase>| {
        if let Some(p) = unstretch_plane(s, sw, h, k, sub(px), py) {
            let e = miss(&p) / (p.w * p.h) as f64;
            if best.is_none_or(|b| e < b.e) {
                *best = Some(Phase { e, px, py });
            }
        }
    };
    let walk = |steps: &[f64],
                best: &mut Option<Phase>,
                try_p: &mut dyn FnMut(f64, f64, &mut Option<Phase>)| {
        for &st in steps {
            for j in [-2.0, -1.0, 1.0, 2.0] {
                if let Some(c) = *best {
                    try_p((c.px + j * st + 1.0) % 1.0, c.py, best);
                }
            }
            for j in [-2.0, -1.0, 1.0, 2.0] {
                if let Some(c) = *best {
                    try_p(c.px, (c.py + j * st + 1.0) % 1.0, best);
                }
            }
        }
    };
    if let Some(sd) = seed {
        try_p(sd.px, sd.py, &mut best);
        walk(&[1.0 / 64.0, 1.0 / 128.0], &mut best, &mut try_p);
        if best.is_some_and(|b| b.e <= sd.max) {
            return best;
        }
    }
    // At a whole k every game px has the same two blends: a finer coarse grid.
    let nc = coarse.unwrap_or(if (k - js_round(k)).abs() < 0.05 {
        16
    } else {
        8
    });
    for a in 0..nc {
        for b in 0..nc {
            try_p(a as f64 / nc as f64, b as f64 / nc as f64, &mut best);
        }
    }
    best?;
    walk(
        &[1.0 / 32.0, 1.0 / 64.0, 1.0 / 128.0],
        &mut best,
        &mut try_p,
    );
    best
}

#[derive(Debug, Clone, Copy)]
struct PhaseAt {
    k: f64,
    fx: f64,
    fy: f64,
    e: f64,
}

#[derive(Debug, Clone, Copy)]
struct Miss {
    skip: u32,
    wait: u32,
}

/// What un-stretching learns per reported stretch factor: the factor that
/// fits, the grid phase in frame terms (rows of one window share it), and
/// a backoff after searches that found no fit.
#[derive(Default)]
pub struct StretchCache {
    fix: HashMap<String, f64>,
    miss: HashMap<String, Miss>,
    phase_at: HashMap<String, PhaseAt>,
}

impl StretchCache {
    /// The stretch found for rows reported at `k0`, if a row fitted.
    pub fn refined(&self, k0: f64) -> Option<f64> {
        self.fix.get(&format!("{k0:.3}")).map(|f| k0 * f)
    }
}

/// An un-stretched row: 262 x 38 game px with the text box at game px
/// 41-202, and the tolerance its least-squares noise needs.
pub struct Flat {
    pub image: RgbaBuf,
    pub fit: f64,
    pub tol: i32,
}

/// A row cut at `k0` screen px per game px (not whole) back on game pixels,
/// or `None` when the fit or the row's place is not clean.
pub fn unstretch_row(
    img: &Rgba,
    k0: f64,
    pad: Option<[usize; 4]>,
    frame_at: Option<[usize; 2]>,
    cache: &mut StretchCache,
) -> Option<Flat> {
    let (w, h) = (img.width, img.height);
    let lum = Gray::from_rgba709(img);
    let pd = pad.unwrap_or([0; 4]);
    let (pl, pt) = (pd[0], pd[1]);
    let iw = w.checked_sub(pl + pd[2])?;
    let sh = h.checked_sub(pt + pd[3])?;
    let y0 = pt;
    // The phases are searched on the left of the text box (where names and prices start).
    let x0 = pl + js_round(iw as f64 * 0.12) as usize;
    let sw = js_round(iw as f64 * 0.43) as usize;
    if sw < 4 || sh < 4 || x0 + sw > w {
        return None;
    }
    let plane = |xa: usize, wa: usize| -> Vec<f32> {
        let mut s = Vec::with_capacity(wa * sh);
        for y in 0..sh {
            s.extend_from_slice(&lum.d[(y0 + y) * w + xa..(y0 + y) * w + xa + wa]);
        }
        s
    };
    let s = plane(x0, sw);
    let miss = |p: &Gray| palette_miss(p, &PALETTE, 0.17, 0.76);
    let key = format!("{k0:.3}");
    let mut k = k0 * cache.fix.get(&key).copied().unwrap_or(1.0);
    let seed = match (frame_at, cache.phase_at.get(&key)) {
        (Some(at), Some(pc)) if pc.k == k => Some(Seed {
            px: mod1(pc.fx - at[0] as f64 / k),
            py: mod1(pc.fy - at[1] as f64 / k - y0 as f64 / k),
            max: (2.0 * pc.e).clamp(0.6, 2.0),
        }),
        _ => None,
    };
    let mut best = fit_phase(&s, sw, sh, k, x0 as f64, &miss, seed, None);
    let fixed = cache.fix.contains_key(&key);
    let waiting = !fixed
        && cache.miss.get_mut(&key).is_some_and(|m| {
            if m.skip > 0 {
                m.skip -= 1;
                true
            } else {
                false
            }
        });
    if !fixed && !waiting {
        // Coarse: 4 x 4 phases at each k within 5% (a wrong k leaves every phase far off).
        let mut coarse: Option<(f64, f64)> = None;
        for j in -12..=12 {
            let kk = k0 * (1.0 + j as f64 * 0.004);
            for a in 0..4 {
                for b in 0..4 {
                    let Some(p) = unstretch_plane(
                        &s,
                        sw,
                        sh,
                        kk,
                        mod1(a as f64 / 4.0 - x0 as f64 / kk),
                        b as f64 / 4.0,
                    ) else {
                        continue;
                    };
                    let e = miss(&p) / (p.w * p.h) as f64;
                    if coarse.is_none_or(|c| e < c.0) {
                        coarse = Some((e, kk));
                    }
                }
            }
        }
        // Then refined on the whole text box, downhill from the coarse k.
        if let Some((_, ck)) = coarse {
            let x2 = pl + js_round(iw as f64 * 0.16) as usize;
            let sw2 = (js_round(iw as f64 * 0.6) as usize).min(w.saturating_sub(x2));
            let s2 = plane(x2, sw2);
            let at = |kk: f64| fit_phase(&s2, sw2, sh, kk, x2 as f64, &miss, None, None);
            let mut k2 = ck;
            let mut b2 = at(k2);
            for st in [0.001, -0.001, 0.00025, -0.00025] {
                for _ in 0..12 {
                    let Some(cur) = b2 else { break };
                    let kk = k2 * (1.0 + st);
                    match at(kk) {
                        Some(b) if b.e < cur.e => {
                            b2 = Some(b);
                            k2 = kk;
                        }
                        _ => break,
                    }
                }
            }
            // Taken when it fits the whole box clearly better than the reported k.
            let b0 = at(k);
            let better = b2.is_some_and(|b| {
                (k2 / k - 1.0).abs() > 0.001 && b0.is_none_or(|z| b.e < z.e * 0.97)
            });
            if better {
                if let Some(b) = fit_phase(&s, sw, sh, k2, x0 as f64, &miss, None, None) {
                    if best.is_none_or(|_| b.e <= 2.0) {
                        best = Some(b);
                        k = k2;
                    }
                }
            }
        }
        if best.is_some_and(|b| b.e <= 2.0) {
            cache.fix.insert(key.clone(), k / k0);
            cache.miss.remove(&key);
        } else {
            let next = cache.miss.get(&key).map_or(4, |m| (m.wait * 2).min(64));
            cache.miss.insert(
                key.clone(),
                Miss {
                    skip: next,
                    wait: next,
                },
            );
        }
    }
    let mut best = best?;
    if y0 > 0 {
        best.py = mod1(best.py + y0 as f64 / k);
    }
    // A bilinear stretch fits to 0.1-0.5 luma a pixel; a sharp one only to 5-6.
    if best.e > 2.0 {
        return None;
    }
    if let Some(at) = frame_at {
        cache.phase_at.insert(
            key,
            PhaseAt {
                k,
                fx: mod1(best.px + at[0] as f64 / k),
                fy: mod1(best.py + at[1] as f64 / k),
                e: best.e,
            },
        );
    }
    let p = unstretch_plane(&lum.d, w, h, k, best.px, best.py)?;
    let lv = |x: i64, y: i64| {
        if x >= 0 && y >= 0 && (x as usize) < p.w && (y as usize) < p.h {
            p.d[y as usize * p.w + x as usize] as f64
        } else {
            -99.0
        }
    };
    // Placed by the underline between the two lines: game px 45-199 of row 19, white.
    let light = |v: f64| v >= 249.5;
    let white = |v: f64| v >= 251.0;
    let (cx, cy) = (
        js_round(pl as f64 / k) as i64,
        js_round(pt as f64 / k) as i64,
    );
    let (rx, ry) = if pad.is_some() { (16, 12) } else { (6, 4) };
    let mut place: Option<(f64, i64, i64)> = None;
    for dy in cy - ry..=cy + ry {
        for dx in cx - rx..=cx + rx {
            let on = (45..=199).filter(|&x| light(lv(dx + x, dy + 19))).count();
            let mut sc = on as f64 / 155.0;
            if white(lv(dx + 44, dy + 19))
                || white(lv(dx + 200, dy + 19))
                || white(lv(dx + 120, dy + 18))
                || white(lv(dx + 120, dy + 20))
            {
                sc -= 0.5;
            }
            if place.is_none_or(|b| sc > b.0) {
                place = Some((sc, dx, dy));
            }
        }
    }
    let (sc, dx, dy) = place?;
    if sc < 0.8 {
        return None;
    }
    let channel = |c: usize| -> Vec<f32> {
        img.data
            .as_chunks::<4>()
            .0
            .iter()
            .map(|q| q[c] as f32)
            .collect()
    };
    let planes: Vec<Gray> = (0..3)
        .map(|c| unstretch_plane(&channel(c), w, h, k, best.px, best.py))
        .collect::<Option<_>>()?;
    let to_u8 = |v: f32| js_round(v as f64).clamp(0.0, 255.0) as u8;
    let mut out = RgbaBuf::filled(ROW_W, 38, [246, 246, 246]);
    for y in 0..38i64 {
        for x in 0..ROW_W as i64 {
            let (sx, sy) = (x + dx, y + dy);
            if sx < 0 || sy < 0 || sx as usize >= p.w || sy as usize >= p.h {
                continue;
            }
            let j = sy as usize * p.w + sx as usize;
            let rgb = if x >= 38 {
                let g = to_u8(p.d[j]);
                [g, g, g]
            } else {
                [
                    to_u8(planes[0].d[j]),
                    to_u8(planes[1].d[j]),
                    to_u8(planes[2].d[j]),
                ]
            };
            out.set(x as usize, y as usize, rgb);
        }
    }
    Some(Flat {
        image: out,
        fit: (best.e * 100.0).round() / 100.0,
        tol: 12,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Bilinear upscale with half-pixel centres (the model the solver undoes).
    fn stretch(src: &[f32], w: usize, h: usize, s: f64) -> (Vec<f32>, usize, usize) {
        let (ow, oh) = ((w as f64 * s) as usize, (h as f64 * s) as usize);
        let at = |x: f64, y: f64| {
            let x = x.clamp(0.0, (w - 1) as f64);
            let y = y.clamp(0.0, (h - 1) as f64);
            let (x0, y0) = (x.floor() as usize, y.floor() as usize);
            let (x1, y1) = ((x0 + 1).min(w - 1), (y0 + 1).min(h - 1));
            let (fx, fy) = (x - x0 as f64, y - y0 as f64);
            let top = src[y0 * w + x0] as f64 * (1.0 - fx) + src[y0 * w + x1] as f64 * fx;
            let bot = src[y1 * w + x0] as f64 * (1.0 - fx) + src[y1 * w + x1] as f64 * fx;
            top * (1.0 - fy) + bot * fy
        };
        let mut out = vec![0f32; ow * oh];
        for y in 0..oh {
            for x in 0..ow {
                out[y * ow + x] = at((x as f64 + 0.5) / s - 0.5, (y as f64 + 0.5) / s - 0.5) as f32;
            }
        }
        (out, ow, oh)
    }

    #[test]
    fn unstretch_inverts_a_bilinear_stretch() {
        let (w, h) = (40, 20);
        let src: Vec<f32> = (0..w * h)
            .map(|i| if (i * 7 + i / w) % 5 < 2 { 0.0 } else { 215.0 })
            .collect();
        let (big, bw, bh) = stretch(&src, w, h, 1.5);
        let p = unstretch_plane(&big, bw, bh, 1.5, 0.0, 0.0).unwrap();
        // Interior game pixels come back within a fraction of a luma level.
        let mut worst = 0f32;
        for y in 2..h - 2 {
            for x in 2..w - 2 {
                worst = worst.max((p.d[y * p.w + x] - src[y * w + x]).abs());
            }
        }
        assert!(worst < 1.0, "worst {worst}");
    }

    #[test]
    fn mod1_wraps_negatives() {
        assert!((mod1(-0.25) - 0.75).abs() < 1e-12);
        assert!((mod1(1.25) - 0.25).abs() < 1e-12);
    }
}

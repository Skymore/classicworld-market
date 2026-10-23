//! Grey planes and the matching primitives every reader step uses:
//! resizing, the triangle-filter resample, zero-mean templates, integral
//! images and normalised cross-correlation (TM_CCOEFF_NORMED).

use super::Rgba;

#[inline]
pub fn luma601(r: u8, g: u8, b: u8) -> f64 {
    0.299 * r as f64 + 0.587 * g as f64 + 0.114 * b as f64
}

/// BT.709 luma: a shared window arrives as I420, and only its Y plane
/// survives the round trip to RGB at glyph edges (reader.js unstretchRow).
#[inline]
pub fn luma709(r: u8, g: u8, b: u8) -> f64 {
    0.2126 * r as f64 + 0.7152 * g as f64 + 0.0722 * b as f64
}

/// Value and saturation of HSV, both 0..255.
#[inline]
pub fn value_saturation(r: u8, g: u8, b: u8) -> (f64, f64) {
    let mx = r.max(g).max(b) as f64;
    let mn = r.min(g).min(b) as f64;
    (
        mx,
        if mx > 0.0 {
            (mx - mn) * 255.0 / mx
        } else {
            0.0
        },
    )
}

/// A grey plane, row-major.
#[derive(Debug, Clone, PartialEq)]
pub struct Gray {
    pub w: usize,
    pub h: usize,
    pub d: Vec<f32>,
}

impl Gray {
    pub fn new(w: usize, h: usize, d: Vec<f32>) -> Self {
        debug_assert_eq!(d.len(), w * h);
        Self { w, h, d }
    }

    /// The whole frame as BT.601 grey.
    pub fn from_rgba(img: &Rgba) -> Self {
        let n = img.width * img.height;
        let mut d = Vec::with_capacity(n);
        for p in img.data.as_chunks::<4>().0 {
            d.push(luma601(p[0], p[1], p[2]) as f32);
        }
        Self::new(img.width, img.height, d)
    }

    pub fn from_rgba709(img: &Rgba) -> Self {
        let mut d = Vec::with_capacity(img.width * img.height);
        for p in img.data.as_chunks::<4>().0 {
            d.push(luma709(p[0], p[1], p[2]) as f32);
        }
        Self::new(img.width, img.height, d)
    }

    #[inline]
    pub fn at(&self, x: usize, y: usize) -> f32 {
        self.d[y * self.w + x]
    }
}

/// Area-average shrink of a frame to `out_w` wide grey, sampling every
/// `step` pixels so a 4K frame is not read in full (capture.js grey).
pub fn downscale_gray(img: &Rgba, out_w: usize) -> Gray {
    let (w, h) = (img.width, img.height);
    let out_h = ((out_w * h) as f64 / w as f64).round().max(1.0) as usize;
    let mut acc = vec![0f64; out_w * out_h];
    let mut cnt = vec![0u32; out_w * out_h];
    let fx = out_w as f64 / w as f64;
    let fy = out_h as f64 / h as f64;
    let step = (w / out_w / 2).max(1);
    for y in (0..h).step_by(step) {
        let oy = ((y as f64 * fy) as usize).min(out_h - 1);
        for x in (0..w).step_by(step) {
            let o = oy * out_w + ((x as f64 * fx) as usize).min(out_w - 1);
            acc[o] += img.luma(x, y);
            cnt[o] += 1;
        }
    }
    let d = acc
        .iter()
        .zip(&cnt)
        .map(|(a, &c)| if c > 0 { (a / c as f64) as f32 } else { 0.0 })
        .collect();
    Gray::new(out_w, out_h, d)
}

/// Box average when shrinking, bilinear when growing (capture.js resize).
pub fn resize(img: &Gray, w: usize, h: usize) -> Gray {
    let mut out = vec![0f32; w * h];
    let sx = img.w as f64 / w as f64;
    let sy = img.h as f64 / h as f64;
    for y in 0..h {
        let y0 = y as f64 * sy;
        let y1 = y0 + sy;
        for x in 0..w {
            let x0 = x as f64 * sx;
            let x1 = x0 + sx;
            out[y * w + x] = if sx <= 1.0 && sy <= 1.0 {
                let cx = (x0 + sx / 2.0 - 0.5).min((img.w - 1) as f64).max(0.0);
                let cy = (y0 + sy / 2.0 - 0.5).min((img.h - 1) as f64).max(0.0);
                let (ix, iy) = (cx as usize, cy as usize);
                let (ax, ay) = (cx - ix as f64, cy - iy as f64);
                let ix2 = (ix + 1).min(img.w - 1);
                let iy2 = (iy + 1).min(img.h - 1);
                let top = img.at(ix, iy) as f64 * (1.0 - ax) + img.at(ix2, iy) as f64 * ax;
                let bot = img.at(ix, iy2) as f64 * (1.0 - ax) + img.at(ix2, iy2) as f64 * ax;
                (top * (1.0 - ay) + bot * ay) as f32
            } else {
                let mut s = 0f64;
                let mut n = 0u32;
                let ya = y0 as usize;
                let yb = (y1.ceil() as usize).min(img.h);
                let xa = x0 as usize;
                let xb = (x1.ceil() as usize).min(img.w);
                for yy in ya..yb {
                    for xx in xa..xb {
                        s += img.at(xx, yy) as f64;
                        n += 1;
                    }
                }
                if n > 0 {
                    (s / n as f64) as f32
                } else {
                    0.0
                }
            };
        }
    }
    Gray::new(w, h, out)
}

/// One output sample's source taps and weights.
struct Taps {
    idx: Vec<usize>,
    w: Vec<f64>,
}

fn taps(sn: usize, s0: f64, s_len: f64, dn: usize) -> Vec<Taps> {
    let f = s_len / dn as f64;
    let sup = f.max(1.0);
    (0..dn)
        .map(|o| {
            let c = s0 + (o as f64 + 0.5) * f - 0.5;
            let lo = (c - sup).floor() as i64;
            let hi = (c + sup).ceil() as i64;
            let mut idx = Vec::new();
            let mut w = Vec::new();
            let mut tot = 0.0;
            for i in lo..=hi {
                let t = 1.0 - (i as f64 - c).abs() / sup;
                if t <= 0.0 {
                    continue;
                }
                idx.push(i.clamp(0, sn as i64 - 1) as usize);
                w.push(t);
                tot += t;
            }
            for v in &mut w {
                *v /= tot;
            }
            Taps { idx, w }
        })
        .collect()
}

/// Separable triangle-filter resample of the sub-rectangle
/// (`sx0`, `sy0`, `sxw` x `syh`) of `src` to `dw` x `dh` (reader.js resample).
#[allow(clippy::too_many_arguments)]
pub fn resample_rect(
    src: &[f32],
    sw: usize,
    sh: usize,
    dw: usize,
    dh: usize,
    sx0: f64,
    sy0: f64,
    sxw: f64,
    syh: f64,
) -> Vec<f32> {
    let wx = taps(sw, sx0, sxw, dw);
    let wy = taps(sh, sy0, syh, dh);
    let mut tmp = vec![0f32; sh * dw];
    for y in 0..sh {
        let row = &src[y * sw..(y + 1) * sw];
        for (x, t) in wx.iter().enumerate() {
            let mut v = 0f64;
            for (k, &i) in t.idx.iter().enumerate() {
                v += row[i] as f64 * t.w[k];
            }
            tmp[y * dw + x] = v as f32;
        }
    }
    let mut out = vec![0f32; dh * dw];
    for (y, t) in wy.iter().enumerate() {
        for x in 0..dw {
            let mut v = 0f64;
            for (k, &i) in t.idx.iter().enumerate() {
                v += tmp[i * dw + x] as f64 * t.w[k];
            }
            out[y * dw + x] = v as f32;
        }
    }
    out
}

pub fn resample(src: &[f32], sw: usize, sh: usize, dw: usize, dh: usize) -> Vec<f32> {
    resample_rect(src, sw, sh, dw, dh, 0.0, 0.0, sw as f64, sh as f64)
}

/// A zero-mean template and its norm.
#[derive(Debug, Clone)]
pub struct Prepared {
    pub w: usize,
    pub h: usize,
    pub z: Vec<f32>,
    pub norm: f64,
}

pub fn prepare(d: &[f32], w: usize, h: usize) -> Prepared {
    let n = (w * h) as f64;
    let mean = d.iter().map(|&v| v as f64).sum::<f64>() / n;
    let z: Vec<f32> = d.iter().map(|&v| (v as f64 - mean) as f32).collect();
    let norm = z
        .iter()
        .map(|&v| (v as f64) * (v as f64))
        .sum::<f64>()
        .sqrt();
    Prepared { w, h, z, norm }
}

/// Integral images of the values and their squares, one row and column larger.
pub struct Integral {
    w1: usize,
    s1: Vec<f64>,
    s2: Vec<f64>,
}

impl Integral {
    pub fn new(img: &[f32], w: usize, h: usize) -> Self {
        let w1 = w + 1;
        let mut s1 = vec![0f64; w1 * (h + 1)];
        let mut s2 = vec![0f64; w1 * (h + 1)];
        for y in 0..h {
            let (mut r1, mut r2) = (0f64, 0f64);
            for x in 0..w {
                let v = img[y * w + x] as f64;
                r1 += v;
                r2 += v * v;
                s1[(y + 1) * w1 + x + 1] = s1[y * w1 + x + 1] + r1;
                s2[(y + 1) * w1 + x + 1] = s2[y * w1 + x + 1] + r2;
            }
        }
        Self { w1, s1, s2 }
    }

    /// Sum and sum of squares of the `tw` x `th` window at (x, y).
    #[inline]
    fn window(&self, x: usize, y: usize, tw: usize, th: usize) -> (f64, f64) {
        let a = y * self.w1 + x;
        let b = a + tw;
        let c = a + th * self.w1;
        let d = c + tw;
        (
            self.s1[d] - self.s1[b] - self.s1[c] + self.s1[a],
            self.s2[d] - self.s2[b] - self.s2[c] + self.s2[a],
        )
    }
}

/// Dot product with 8 independent sums, so it vectorises the same way on
/// every target (a plain float reduction cannot be reordered).
#[inline]
pub fn dot(a: &[f32], b: &[f32]) -> f32 {
    let mut acc = [0f32; 8];
    let (ca, ra) = a.as_chunks::<8>();
    let (cb, rb) = b.as_chunks::<8>();
    for (x, y) in ca.iter().zip(cb) {
        for k in 0..8 {
            acc[k] += x[k] * y[k];
        }
    }
    let mut tail = 0f32;
    for (x, y) in ra.iter().zip(rb) {
        tail += x * y;
    }
    ((acc[0] + acc[1]) + (acc[2] + acc[3])) + ((acc[4] + acc[5]) + (acc[6] + acc[7])) + tail
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Hit {
    pub v: f64,
    pub x: usize,
    pub y: usize,
}

/// A plane with its integral images, searched by NCC.
pub struct Searchable<'a> {
    pub d: &'a [f32],
    pub w: usize,
    pub h: usize,
    ii: Integral,
}

impl<'a> Searchable<'a> {
    pub fn new(d: &'a [f32], w: usize, h: usize) -> Self {
        Self {
            d,
            w,
            h,
            ii: Integral::new(d, w, h),
        }
    }

    pub fn of(g: &'a Gray) -> Self {
        Self::new(&g.d, g.w, g.h)
    }

    /// Best NCC of `t` with top-left positions in [x0, x1] x [y0, y1]
    /// (clamped), every `step` px. Windows whose sum of squared deviations
    /// is at most `min_var` are skipped. `None` when no window was scored.
    #[allow(clippy::too_many_arguments)]
    pub fn best(
        &self,
        t: &Prepared,
        x0: i64,
        x1: i64,
        y0: i64,
        y1: i64,
        step: usize,
        min_var: f64,
    ) -> Option<Hit> {
        if t.norm <= 0.0 || t.w > self.w || t.h > self.h {
            return None;
        }
        let x0 = x0.max(0);
        let y0 = y0.max(0);
        let x1 = x1.min((self.w - t.w) as i64);
        let y1 = y1.min((self.h - t.h) as i64);
        if x1 < x0 || y1 < y0 {
            return None;
        }
        let n = (t.w * t.h) as f64;
        let mut best: Option<Hit> = None;
        let mut y = y0 as usize;
        while y as i64 <= y1 {
            let mut x = x0 as usize;
            while x as i64 <= x1 {
                let (s1, s2) = self.ii.window(x, y, t.w, t.h);
                let var = s2 - s1 * s1 / n;
                if var > min_var {
                    let mut s = 0f64;
                    for ty in 0..t.h {
                        let r = (y + ty) * self.w + x;
                        s += dot(&self.d[r..r + t.w], &t.z[ty * t.w..(ty + 1) * t.w]) as f64;
                    }
                    let v = s / (var.sqrt() * t.norm);
                    if best.is_none_or(|b| v > b.v) {
                        best = Some(Hit { v, x, y });
                    }
                }
                x += step;
            }
            y += step;
        }
        best
    }

    /// Every `k`-th position, then every position within `k` of the best
    /// (reader.js bestMatchStep / bestMatch2).
    pub fn best_stepped(
        &self,
        t: &Prepared,
        x0: i64,
        x1: i64,
        y0: i64,
        y1: i64,
        k: usize,
    ) -> Option<Hit> {
        let b = self.best(t, x0, x1, y0, y1, k, 1e-6)?;
        if b.v < 0.0 {
            return Some(b);
        }
        let k = k as i64;
        let (bx, by) = (b.x as i64, b.y as i64);
        self.best(
            t,
            x0.max(bx - k),
            x1.min(bx + k),
            y0.max(by - k),
            y1.min(by + k),
            1,
            1e-6,
        )
    }

    /// The whole plane.
    pub fn best_all(&self, t: &Prepared, step: usize) -> Option<Hit> {
        if t.w > self.w || t.h > self.h {
            return None;
        }
        let (x1, y1) = ((self.w - t.w) as i64, (self.h - t.h) as i64);
        if step <= 1 {
            self.best(t, 0, x1, 0, y1, 1, 1e-6)
        } else {
            self.best_stepped(t, 0, x1, 0, y1, step)
        }
    }
}

/// NCC of two equal-length vectors, the second already zero-mean.
pub fn ncc_flat(a: &[f32], t: &Prepared) -> f64 {
    let n = a.len() as f64;
    let ma = a.iter().map(|&v| v as f64).sum::<f64>() / n;
    let (mut s, mut sa) = (0f64, 0f64);
    for (i, &v) in a.iter().enumerate() {
        let x = v as f64 - ma;
        s += x * t.z[i] as f64;
        sa += x * x;
    }
    if sa > 0.0 && t.norm > 0.0 {
        s / sa.sqrt() / t.norm
    } else {
        0.0
    }
}

/// Upper median of a sample (capture.js median); 0 for none.
pub fn median(v: &mut [f64]) -> f64 {
    if v.is_empty() {
        return 0.0;
    }
    v.sort_by(f64::total_cmp);
    v[v.len() >> 1]
}

/// Value at share `q` of a sorted copy (reader.js percentile).
pub fn percentile(v: &[f64], q: f64) -> Option<f64> {
    if v.is_empty() {
        return None;
    }
    let mut a = v.to_vec();
    a.sort_by(f64::total_cmp);
    Some(a[((q * a.len() as f64) as usize).min(a.len() - 1)])
}

/// Standard base64 (the template files' grey pictures).
pub fn base64_decode(s: &str) -> Result<Vec<u8>, String> {
    fn val(c: u8) -> Option<u32> {
        match c {
            b'A'..=b'Z' => Some((c - b'A') as u32),
            b'a'..=b'z' => Some((c - b'a') as u32 + 26),
            b'0'..=b'9' => Some((c - b'0') as u32 + 52),
            b'+' => Some(62),
            b'/' => Some(63),
            _ => None,
        }
    }
    let bytes: Vec<u8> = s.bytes().filter(|c| !c.is_ascii_whitespace()).collect();
    let body = bytes
        .iter()
        .position(|&c| c == b'=')
        .map_or(&bytes[..], |p| &bytes[..p]);
    let mut out = Vec::with_capacity(body.len() * 3 / 4);
    let (mut acc, mut bits) = (0u32, 0u32);
    for &c in body {
        let v = val(c).ok_or_else(|| format!("bad base64 character {:?}", c as char))?;
        acc = (acc << 6) | v;
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out.push((acc >> bits) as u8);
            acc &= (1 << bits) - 1;
        }
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn base64_round_numbers() {
        assert_eq!(base64_decode("AAEC/w==").unwrap(), vec![0, 1, 2, 255]);
        assert_eq!(base64_decode("TWFu").unwrap(), b"Man");
        assert!(base64_decode("a$b").is_err());
    }

    #[test]
    fn ncc_finds_a_planted_patch() {
        let (w, h) = (40, 30);
        let mut d = vec![0f32; w * h];
        for (i, v) in d.iter_mut().enumerate() {
            *v = ((i * 37) % 11) as f32;
        }
        let patch: Vec<f32> = (0..6 * 5).map(|i| ((i * 7) % 5) as f32 * 40.0).collect();
        for y in 0..5 {
            for x in 0..6 {
                d[(12 + y) * w + 22 + x] = patch[y * 6 + x];
            }
        }
        let t = prepare(&patch, 6, 5);
        let s = Searchable::new(&d, w, h);
        let hit = s.best_all(&t, 1).unwrap();
        assert_eq!((hit.x, hit.y), (22, 12));
        assert!((hit.v - 1.0).abs() < 1e-6);
        assert_eq!(s.best_all(&t, 2).map(|h| (h.x, h.y)), Some((22, 12)));
    }

    #[test]
    fn resample_keeps_flat_planes_flat() {
        let src = vec![100f32; 10 * 7];
        let out = resample(&src, 10, 7, 23, 4);
        assert!(out.iter().all(|&v| (v - 100.0).abs() < 1e-3));
    }

    #[test]
    fn dot_matches_naive_sum() {
        let a: Vec<f32> = (0..37).map(|i| i as f32 * 0.5).collect();
        let b: Vec<f32> = (0..37).map(|i| (i % 3) as f32).collect();
        let naive: f32 = a.iter().zip(&b).map(|(x, y)| x * y).sum();
        assert!((dot(&a, &b) - naive).abs() < 1e-3);
    }

    #[test]
    fn median_is_the_upper_one() {
        assert_eq!(median(&mut [3.0, 1.0, 2.0, 4.0]), 3.0);
        assert_eq!(median(&mut []), 0.0);
        assert_eq!(percentile(&[5.0, 1.0, 3.0], 0.5), Some(3.0));
    }
}

//! The map name from the minimap (mapreader.js). Two ways:
//! - the full minimap: its header word "MINI MAP" found by NCC over UI
//!   scales 0.6-2.2 gives the place and scale; the map line of the title is
//!   cut into letters, and every catalog name the templates can spell is laid
//!   over it; the best fit must be strong and beat the next name;
//! - the minimap collapsed to its one-line bar ("Hidden Street : Free Market
//!   <4>"), read exactly in the shop font (smooth stretches put back on game
//!   pixels first).
//!
//! Only catalog names come out, and they must match
//! `^[A-Za-z' ]+( <\d{1,2}>)?$`. A failed check gives no map.

use std::collections::{HashMap, HashSet};
use std::sync::OnceLock;

use serde::Serialize;

use super::font::split_run;
use super::image::{ncc_flat, prepare, resample, Gray, Prepared, Searchable};
use super::row::stretch::{fit_phase, unstretch_plane};
use super::templates::{self, MapGlyph};
use super::{js_round, round_to, Rgba};

// mapreader.js DEF.
const GROUND_ROWS: [f64; 5] = [18.0, 19.0, 20.0, 21.0, 22.0];
const MIN_HEADER: f64 = 0.6;
const KEEP_HEADER: f64 = 0.8;
const SCALE_MIN: f64 = 0.6;
const SCALE_MAX: f64 = 2.2;
const TITLE_DX: f64 = 55.0;
const TITLE_W: f64 = 300.0;
const TITLE_Y0: f64 = 22.0;
const TITLE_Y1: f64 = 70.0;
const MAP_TOP: f64 = 50.0;
const LINE_TOL: f64 = 6.0;
const INK_LO: f64 = 0.25;
const INK_HI: f32 = 226.0;
const MK: f64 = 2.0;
const FH: usize = 30;
const GW: usize = 10;
const GH: usize = 16;
const SPACE: usize = 7;
const INK_COL: f32 = 0.3;
const VALLEY: f64 = 0.35;
const END_GAP: usize = 30;
const TAIL_GAP: usize = 12;
const WIDTH_COST: f64 = 0.02;
const MAX_GLYPH_W: usize = 40;
const MIN_MEAN_SCORE: f64 = 0.6;
const MIN_GLYPH_SCORE: f64 = 0.3;
const MIN_MARGIN: f64 = 0.15;
const LETTER_BASE: f64 = 0.7;
const UNKNOWN_LETTER: f64 = 0.9;
const STRONG_MEAN: f64 = 0.85;
const STRONG_MIN: f64 = 0.2;
const STRONG_MARGIN: f64 = 1.0;
const STRONG_WIDE_MARGIN: f64 = 10.0;
const STRONG_WIDE_MIN: f64 = 0.1;
/// The most a collapsed bar's fit may miss, luma a pixel.
const FIT_MAX: f64 = 8.0;

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct MapRead {
    pub name: String,
    /// The number inside "<n>", if any.
    pub room: Option<u8>,
    /// Read from the collapsed one-line bar.
    pub bar: bool,
}

/// What the map reader keeps across frames: the header scale found last
/// and the collapsed bar's stretch fit.
#[derive(Default)]
pub struct MapCache {
    last_scale: Option<f64>,
    last_off: i64,
    header: HashMap<u64, Prepared>,
    bar_fix: HashMap<String, f64>,
    bar_wait: HashMap<String, u32>,
}

struct Name {
    name: String,
    n: usize,
    spell: bool,
    wsum: f64,
}

struct Names {
    list: Vec<Name>,
    /// Names that are another name less one glyph (I and l as one): where it would go.
    short: HashMap<String, HashSet<usize>>,
    /// I-folded name -> catalog name.
    by_fold: HashMap<String, String>,
    glyphs: HashMap<char, MapGlyph>,
}

fn is_map_name(s: &str) -> bool {
    let (body, room) = match s.rfind(" <") {
        Some(i) if s.ends_with('>') => (&s[..i], Some(&s[i + 2..s.len() - 1])),
        _ => (s, None),
    };
    !body.is_empty()
        && body
            .chars()
            .all(|c| c.is_ascii_alphabetic() || c == '\'' || c == ' ')
        && room.is_none_or(|r| (1..=2).contains(&r.len()) && r.chars().all(|c| c.is_ascii_digit()))
}

fn room_of(name: &str) -> Option<u8> {
    let i = name.rfind('<')?;
    name.strip_suffix('>')?[i + 1..].parse().ok()
}

fn bar_fold(s: &str) -> String {
    s.replace('I', "l")
}

fn names() -> &'static Names {
    static N: OnceLock<Names> = OnceLock::new();
    N.get_or_init(|| {
        let m = &templates::get().maps;
        let glyphs: HashMap<char, MapGlyph> = m.glyphs.iter().map(|g| (g.ch, g.clone())).collect();
        let mean_w = if m.glyphs.is_empty() {
            16.0
        } else {
            m.glyphs.iter().map(|g| g.w).sum::<f64>() / m.glyphs.len() as f64
        };
        let list: Vec<Name> = m
            .names
            .iter()
            .filter(|n| is_map_name(n))
            .map(|name| Name {
                name: name.clone(),
                n: name.chars().filter(|&c| c != ' ').count(),
                spell: name.chars().all(|c| c == ' ' || glyphs.contains_key(&c)),
                wsum: name
                    .chars()
                    .map(|c| {
                        if c == ' ' {
                            10.0
                        } else {
                            glyphs.get(&c).map_or(mean_w, |g| g.w)
                        }
                    })
                    .sum(),
            })
            .collect();
        let all: HashSet<String> = list.iter().map(|n| bar_fold(&n.name)).collect();
        let mut short: HashMap<String, HashSet<usize>> = HashMap::new();
        for n in &list {
            let chars: Vec<char> = n.name.chars().collect();
            for i in 0..chars.len() {
                if chars[i] == ' ' {
                    continue;
                }
                let t: String = chars[..i].iter().chain(&chars[i + 1..]).collect();
                let t = bar_fold(&t);
                if all.contains(&t) {
                    short.entry(t).or_default().insert(i);
                }
            }
        }
        let by_fold = list
            .iter()
            .rev()
            .map(|n| (bar_fold(&n.name), n.name.clone()))
            .collect();
        Names {
            list,
            short,
            by_fold,
            glyphs,
        }
    })
}

/// The top-left corner the reader looks at.
fn corner(img: &Rgba) -> super::RgbaBuf {
    let (w, h) = (img.width as f64, img.height as f64);
    let cw = js_round((0.25 * w).max(420.0)).min(w) as usize;
    let ch = js_round((0.22 * h).max(200.0)).min(h) as usize;
    img.cut([0, 0, cw, ch])
}

/// The map in a frame, if read.
pub fn read_map(frame: &Rgba, cache: &mut MapCache) -> Option<MapRead> {
    let c = corner(frame);
    let img = c.view();
    let k0 = (frame.width as f64 / 1366.0).min(frame.height as f64 / 768.0);
    let g = Gray::from_rgba(&img);
    let Some(hd) = find_header(&g, cache) else {
        return read_bar(&g, &img, k0, cache);
    };
    let title = title_lines(&g, &img, &hd);
    let Some(line) = title.map else {
        return read_bar(&g, &img, k0, cache);
    };
    read_title(&g, &hd, title.xa, title.xb, line)
}

struct Header {
    x: f64,
    y: f64,
    s: f64,
}

fn header_tpl(cache: &mut MapCache, s: f64) -> Prepared {
    cache
        .header
        .entry(s.to_bits())
        .or_insert_with(|| {
            let t = &templates::get().maps.header;
            let w = (js_round(t.w as f64 * s) as usize).max(6);
            let h = (js_round(t.h as f64 * s) as usize).max(4);
            prepare(&resample(&t.d, t.w, t.h, w, h), w, h)
        })
        .clone()
}

fn find_header(g: &Gray, cache: &mut MapCache) -> Option<Header> {
    let (w, h) = (g.w, g.h);
    let sr = Searchable::of(g);
    let x_max = js_round(0.12 * w as f64 + 40.0) as i64;
    let y_max = js_round(0.7 * h as f64) as i64;
    let try_scales =
        |list: &[f64], off: i64, cache: &mut MapCache| -> Option<(f64, usize, usize, f64, i64)> {
            let mut best: Option<(f64, usize, usize, f64, i64)> = None;
            for &s in list {
                let t = header_tpl(cache, s);
                if t.w >= w || t.h >= h {
                    continue;
                }
                let Some(b) = sr.best(&t, off, x_max, off, y_max, 2, 1e-6) else {
                    continue;
                };
                if b.v < 0.3 {
                    continue;
                }
                let (bx, by) = (b.x as i64, b.y as i64);
                let Some(b) = sr.best(&t, bx - 2, bx + 2, by - 2, by + 2, 1, 1e-6) else {
                    continue;
                };
                if best.is_none_or(|x| b.v > x.0) {
                    best = Some((b.v, b.x, b.y, s, off));
                }
            }
            best
        };
    let sweep = |list: &[f64], off: i64, cache: &mut MapCache| {
        let mut hit = try_scales(list, off, cache);
        if let Some(hv) = hit.filter(|h| h.0 >= MIN_HEADER) {
            let mut cur = hv;
            for f in [1.03, 1.015, 1.0075] {
                if let Some(h3) = try_scales(&[cur.3 / f, cur.3 * f], off, cache) {
                    if h3.0 > cur.0 {
                        cur = h3;
                    }
                }
            }
            hit = Some(cur);
        }
        hit
    };
    let better = |a: Option<(f64, usize, usize, f64, i64)>,
                  b: Option<(f64, usize, usize, f64, i64)>| match (a, b) {
        (Some(x), Some(y)) => Some(if y.0 > x.0 { y } else { x }),
        (x, y) => x.or(y),
    };
    let mut hit = None;
    if let Some(ls) = cache.last_scale {
        let off = cache.last_off;
        hit = try_scales(&[ls / 1.03, ls, ls * 1.03], off, cache);
    }
    if hit.is_none_or(|h| h.0 < KEEP_HEADER) {
        let mut list = Vec::new();
        let mut s = SCALE_MIN;
        while s <= SCALE_MAX + 1e-9 {
            list.push(s);
            s *= 1.06;
        }
        hit = better(hit, sweep(&list, 0, cache));
        // A crisp 1x header 1 px off the 2 px grid: the small scales on the other grid.
        if hit.is_none_or(|h| h.0 < MIN_HEADER) {
            let small: Vec<f64> = list.iter().copied().filter(|&s| s < 0.9).collect();
            hit = better(hit, sweep(&small, 1, cache));
        }
    }
    let (v, x, y, s, off) = hit?;
    if v < MIN_HEADER {
        return None;
    }
    cache.last_scale = Some(s);
    cache.last_off = off;
    Some(Header {
        x: x as f64,
        y: y as f64,
        s,
    })
}

struct Title {
    xa: usize,
    xb: usize,
    map: Option<(usize, usize)>,
}

/// The title lines: groups of bright text rows right of the map's mark.
fn title_lines(g: &Gray, rgba: &Rgba, hd: &Header) -> Title {
    let (w, h) = (g.w, g.h);
    let s = hd.s;
    let xa = js_round(hd.x + TITLE_DX * s).max(0.0) as usize;
    let mut xb = js_round(hd.x + TITLE_W * s).min(w as f64) as usize;
    // The panel's right edge: where its blue-grey ground ends.
    let mut ends = Vec::new();
    for dy in GROUND_ROWS {
        let y = js_round(hd.y + dy * s);
        if y < 0.0 || y >= h as f64 {
            continue;
        }
        let y = y as usize;
        let (mut x, mut miss, mut last) = (xa, 0, xa);
        while x < w && miss <= 3 {
            let (r, gg, b) = rgba.rgb(x, y);
            let (r, gg, b) = (r as i32, gg as i32, b as i32);
            if (105..=195).contains(&r)
                && (145..=220).contains(&gg)
                && (160..=235).contains(&b)
                && b - r >= 25
                && (gg - b).abs() <= 35
            {
                miss = 0;
                last = x;
            } else {
                miss += 1;
            }
            x += 1;
        }
        ends.push(last);
    }
    ends.sort_unstable();
    let e = ends.get(ends.len() / 2).copied().unwrap_or(0);
    if e as f64 > xa as f64 + 40.0 * s {
        xb = xb.min(e + 1);
    }
    let ya = js_round(hd.y + TITLE_Y0 * s).max(0.0) as usize;
    let yb = js_round(hd.y + TITLE_Y1 * s).min(h as f64) as usize;
    if xb < xa + 20 || yb < ya + 10 {
        return Title { xa, xb, map: None };
    }
    let on: Vec<bool> = (ya..yb)
        .map(|y| (xa..xb).filter(|&x| g.at(x, y) > INK_HI).count() >= 2)
        .collect();
    let mut groups: Vec<(usize, usize)> = Vec::new();
    let mut st: Option<usize> = None;
    for i in 0..=on.len() {
        let v = i < on.len() && on[i];
        if v && st.is_none() {
            st = Some(i);
        }
        if !v {
            if let Some(a) = st.take() {
                match groups.last_mut() {
                    Some(l) if a - l.1 <= 1 => l.1 = i,
                    _ => groups.push((a, i)),
                }
            }
        }
    }
    let lines: Vec<(usize, usize)> = groups
        .into_iter()
        .filter(|q| (q.1 - q.0) as f64 >= 5.0 * s)
        .map(|q| (ya + q.0, ya + q.1))
        .collect();
    let want = hd.y + MAP_TOP * s;
    let map = lines
        .iter()
        .map(|&l| ((l.0 as f64 - want).abs(), l))
        .filter(|(d, _)| *d <= LINE_TOL * s)
        .min_by(|a, b| a.0.total_cmp(&b.0))
        .map(|(_, l)| l);
    Title { xa, xb, map }
}

/// One title line at canonical scale with its ink map and cut places.
struct Parts {
    ya: usize,
    h: usize,
    w: usize,
    m: Vec<f32>,
    cp: Vec<f64>,
    cuts: Vec<usize>,
    x0: usize,
    x1: usize,
    n_runs: usize,
}

impl Parts {
    fn blank(&self, c0: usize, c1: usize) -> bool {
        self.cp[c0..c1.min(self.w)].iter().all(|&v| v == 0.0)
    }

    fn gap_in(&self, mut c0: usize, mut c1: usize) -> usize {
        while c0 < c1 && self.cp[c0] == 0.0 {
            c0 += 1;
        }
        while c1 > c0 && self.cp[c1 - 1] == 0.0 {
            c1 -= 1;
        }
        let (mut best, mut run) = (0, 0);
        for x in c0..c1 {
            if self.cp[x] == 0.0 {
                run += 1;
                best = best.max(run);
            } else {
                run = 0;
            }
        }
        best
    }

    fn feat(&self, mut c0: usize, mut c1: usize) -> (Vec<f32>, usize) {
        while c0 + 1 < c1 && self.cp[c0] == 0.0 {
            c0 += 1;
        }
        while c1 > c0 + 1 && self.cp[c1 - 1] == 0.0 {
            c1 -= 1;
        }
        let cw = c1 - c0;
        let mut f = vec![0f32; cw * FH];
        for y in 0..FH {
            let yy = self.ya + y;
            if yy >= self.h {
                break;
            }
            f[y * cw..(y + 1) * cw].copy_from_slice(&self.m[yy * self.w + c0..yy * self.w + c1]);
        }
        (resample(&f, cw, FH, GW, GH), cw)
    }
}

fn line_parts(g: &Gray, hd: &Header, xa: usize, xb: usize, line: (usize, usize)) -> Parts {
    let s = hd.s;
    let pad = js_round(2.0 * s).max(1.0) as usize;
    let y0 = line.0.saturating_sub(pad);
    let y1 = (line.1 + pad).min(g.h);
    let (sw, sh) = (xb - xa, y1 - y0);
    let mut sub = Vec::with_capacity(sw * sh);
    for y in y0..y1 {
        sub.extend_from_slice(&g.d[y * g.w + xa..y * g.w + xb]);
    }
    let k = MK / s;
    let w = (js_round(sw as f64 * k) as usize).max(8);
    let h = (js_round(sh as f64 * k) as usize).max(8);
    let d = resample(&sub, sw, sh, w, h);
    let mut sorted = d.clone();
    sorted.sort_by(f32::total_cmp);
    let hi = sorted[(sorted.len() as f64 * 0.985) as usize] as f64;
    let bg = sorted[sorted.len() / 2] as f64;
    // The letters' thin strokes are dimmer after compression, so the cut sits low.
    let lo = bg + INK_LO * (hi - bg);
    let span = ((hi - lo) * 0.6).max(8.0);
    let m: Vec<f32> = d
        .iter()
        .map(|&v| ((v as f64 - lo) / span).clamp(0.0, 1.0) as f32)
        .collect();
    let mut ya = 0;
    while ya < h && (0..w).filter(|&x| m[ya * w + x] > 0.5).count() < 1 {
        ya += 1;
    }
    let cp: Vec<f64> = (0..w)
        .map(|x| {
            (ya..h.min(ya + FH))
                .filter(|&y| m[y * w + x] > INK_COL)
                .count() as f64
        })
        .collect();
    let mut runs: Vec<(usize, usize)> = Vec::new();
    let mut st: Option<usize> = None;
    for x in 0..=w {
        let on = x < w && cp[x] >= 1.0;
        if on && st.is_none() {
            st = Some(x);
        }
        if !on {
            if let Some(a) = st.take() {
                if cp[a..x].iter().sum::<f64>() >= 3.0 {
                    if runs.last().is_some_and(|l| a - l.1 > END_GAP) {
                        break;
                    }
                    runs.push((a, x));
                }
            }
        }
    }
    // Cuts: both edges of every run, and the valleys inside runs.
    let mut cuts: Vec<usize> = Vec::new();
    for &(a, b) in &runs {
        cuts.push(a);
        cuts.push(b);
        let mx = cp[a..b].iter().copied().fold(0.0, f64::max);
        for x in a + 2..b.saturating_sub(2) {
            if cp[x] <= cp[x - 1] && cp[x] <= cp[x + 1] && cp[x] <= VALLEY * mx {
                cuts.push(x);
            }
        }
    }
    cuts.sort_unstable();
    cuts.dedup();
    Parts {
        ya,
        h,
        w,
        m,
        cp,
        x0: runs.first().map_or(0, |r| r.0),
        x1: runs.last().map_or(0, |r| r.1),
        n_runs: runs.len(),
        cuts,
    }
}

/// Columns c0..c1 scored as letter `ch` (' ': an empty gap); -9 = impossible.
struct Scorer<'a> {
    parts: &'a Parts,
    neutral: Option<f64>,
    memo: HashMap<(usize, usize, char), f64>,
    feats: HashMap<(usize, usize), (Vec<f32>, usize)>,
}

impl Scorer<'_> {
    fn score(&mut self, c0: usize, c1: usize, ch: char) -> f64 {
        if let Some(&v) = self.memo.get(&(c0, c1, ch)) {
            return v;
        }
        let p = self.parts;
        let v = if ch == ' ' {
            if c1 - c0 >= SPACE && p.blank(c0, c1) {
                0.0
            } else {
                -9.0
            }
        } else if c1 - c0 > MAX_GLYPH_W
            || c1 - c0 < 3
            || p.blank(c0, c1)
            || p.gap_in(c0, c1) >= SPACE
        {
            -9.0
        } else {
            match names().glyphs.get(&ch) {
                None => self.neutral.unwrap_or(-9.0),
                Some(l) => {
                    let (f, fw) = self.feats.entry((c0, c1)).or_insert_with(|| p.feat(c0, c1));
                    ncc_flat(f, &l.t) - WIDTH_COST * (*fw as f64 - l.w).abs()
                }
            }
        };
        self.memo.insert((c0, c1, ch), v);
        v
    }
}

struct Fit {
    s: f64,
    mean: f64,
    min: f64,
}

/// Best placement of the name's characters over the line's cuts, in order,
/// from the first ink to the last (or before an empty tail).
fn align_name(sc: &mut Scorer, name: &str) -> Option<Fit> {
    let p = sc.parts;
    let c = &p.cuts;
    if c.is_empty() {
        return None;
    }
    let m = c.len() - 1;
    let chars: Vec<char> = name.chars().collect();
    let n = chars.len();
    if n > m {
        return None;
    }
    // (sum, min letter) at each cut.
    let mut dp: Vec<Option<(f64, f64)>> = vec![None; m + 1];
    dp[0] = Some((0.0, 9.0));
    for k in 1..=n {
        let ch = chars[k - 1];
        let mut nx: Vec<Option<(f64, f64)>> = vec![None; m + 1];
        let mut any = false;
        for e in k..=m {
            for st in (k - 1..e).rev() {
                if c[e] - c[st] > 44 {
                    break;
                }
                let Some((ps, pmin)) = dp[st] else { continue };
                let v = sc.score(c[st], c[e], ch);
                if v <= -9.0 {
                    continue;
                }
                let tot = ps + v;
                if nx[e].is_none_or(|x| tot > x.0) {
                    nx[e] = Some((tot, if ch == ' ' { pmin } else { pmin.min(v) }));
                    any = true;
                }
            }
        }
        dp = nx;
        if !any {
            return None;
        }
    }
    let mut end = dp[m];
    for e in (n..m).rev() {
        let Some(d) = dp[e] else { continue };
        if !p.blank(c[e], (c[e] + TAIL_GAP).min(c[m])) {
            continue;
        }
        if end.is_none_or(|x| d.0 > x.0) {
            end = Some(d);
        }
    }
    let (s, min) = end?;
    let nl = chars.iter().filter(|&&c| c != ' ').count().max(1);
    Some(Fit {
        s,
        mean: s / nl as f64,
        min,
    })
}

fn read_title(
    g: &Gray,
    hd: &Header,
    xa: usize,
    xb: usize,
    line: (usize, usize),
) -> Option<MapRead> {
    let parts = line_parts(g, hd, xa, xb, line);
    if parts.n_runs == 0 {
        return None;
    }
    let mut sc = Scorer {
        parts: &parts,
        neutral: None,
        memo: HashMap::new(),
        feats: HashMap::new(),
    };
    let mut sc_u = Scorer {
        parts: &parts,
        neutral: Some(UNKNOWN_LETTER),
        memo: HashMap::new(),
        feats: HashMap::new(),
    };
    let wpx = (parts.x1 - parts.x0) as f64;
    type Best<'a> = Option<(f64, Fit, &'a str)>;
    let (mut best, mut second, mut best_u): (Best, Option<f64>, Option<f64>) = (None, None, None);
    for nm in &names().list {
        if wpx < 0.7 * nm.wsum || wpx > 1.4 * nm.wsum {
            continue;
        }
        let fit = if nm.spell {
            align_name(&mut sc, &nm.name)
        } else {
            align_name(&mut sc_u, &nm.name)
        };
        let Some(fit) = fit else { continue };
        // A letter adds to a name's fit only when it matches better than LETTER_BASE.
        let key = fit.s - LETTER_BASE * nm.n as f64;
        if !nm.spell {
            if best_u.is_none_or(|b| key > b) {
                best_u = Some(key);
            }
            continue;
        }
        match &best {
            Some((bk, _, _)) if key <= *bk => {
                if second.is_none_or(|s| key > s) {
                    second = Some(key);
                }
            }
            _ => {
                second = best.as_ref().map(|b| b.0);
                best = Some((key, fit, &nm.name));
            }
        }
    }
    let (key, fit, name) = best?;
    let margin = second.map_or(f64::INFINITY, |s| key - s);
    let wide = second.is_some() && margin >= STRONG_WIDE_MARGIN;
    let strong = fit.mean >= STRONG_MEAN
        && margin >= STRONG_MARGIN
        && fit.min >= if wide { STRONG_WIDE_MIN } else { STRONG_MIN };
    if fit.mean < MIN_MEAN_SCORE || (fit.min < MIN_GLYPH_SCORE && !strong) {
        return None;
    }
    if second.is_some() && margin < MIN_MARGIN {
        return None;
    }
    // A name with letters not learned yet may fit as well: no map.
    if best_u.is_some_and(|u| u > key - MIN_MARGIN) {
        return None;
    }
    if !is_map_name(name) {
        return None;
    }
    Some(MapRead {
        name: name.to_string(),
        room: room_of(name),
        bar: false,
    })
}

// ---------------------------------------------------------------- the collapsed bar

fn read_bar(g: &Gray, rgba: &Rgba, k0: f64, cache: &mut MapCache) -> Option<MapRead> {
    for k in [1usize, 2] {
        let o = k >> 1;
        let (gw, gh) = (g.w / k, g.h / k);
        let l = |x: i64, y: i64| g.d[(y as usize * k + o) * g.w + x as usize * k + o] as f64;
        if let Some(r) = bar_text(&l, gw as i64, gh as i64) {
            return Some(r);
        }
    }
    // A smooth stretch (also a 2x Retina window): put back on game pixels first.
    if k0 > 1.1 && k0 <= 4.0 {
        let p = unstretch_bar(rgba, k0, cache)?;
        let l = |x: i64, y: i64| p.d[y as usize * p.w + x as usize] as f64;
        return bar_text(&l, p.w as i64, p.h as i64);
    }
    None
}

/// The bar's text on game pixels `l(x, y)` (`gw` x `gh`).
fn bar_text(l: &dyn Fn(i64, i64) -> f64, gw: i64, gh: i64) -> Option<MapRead> {
    let font = &templates::get().font;
    let nm = names();
    let above = font.above as i64;
    let band = font.band() as i64;
    let ink = |x: i64, y: i64| x >= 0 && y >= 0 && x < gw && y < gh && l(x, y) < 60.0;
    let span = gw.min(150);
    let far = gw.min(420);
    let mut y0 = 0;
    while y0 + band < gh && y0 < 80 {
        // The paper row over the text: light, even, and with no ink.
        let mut hist: Vec<(i64, usize)> = Vec::new();
        for x in 0..span {
            let v = js_round(l(x, y0) / 8.0) as i64;
            match hist.iter_mut().find(|e| e.0 == v) {
                Some(e) => e.1 += 1,
                None => hist.push((v, 1)),
            }
        }
        let mode = hist
            .iter()
            .fold((0i64, 0usize), |b, &e| if e.1 > b.1 { e } else { b })
            .0 as f64
            * 8.0;
        let even = (0..span)
            .filter(|&x| (l(x, y0) - mode).abs() <= 40.0)
            .count() as f64;
        let dark = (0..span).filter(|&x| l(x, y0) < 100.0).count() as f64;
        if mode < 180.0 || even < 0.8 * span as f64 || dark > 0.02 * span as f64 {
            y0 += 1;
            continue;
        }
        let mut base = y0 + above;
        while base <= y0 + above + 4 && base + 3 < gh {
            if let Some(r) = bar_line(l, &ink, base, span, far, gw, above, band, nm) {
                return Some(r);
            }
            base += 1;
        }
        y0 += 1;
    }
    None
}

#[allow(clippy::too_many_arguments)]
fn bar_line(
    l: &dyn Fn(i64, i64) -> f64,
    ink: &dyn Fn(i64, i64) -> bool,
    base: i64,
    span: i64,
    far: i64,
    gw: i64,
    above: i64,
    band: i64,
    nm: &Names,
) -> Option<MapRead> {
    let font = &templates::get().font;
    let top = base - above;
    let col = |x: i64| (top..top + band).any(|y| ink(x, y));
    let mut text = String::new();
    let mut x = 0;
    let mut last: Option<(i64, String)> = None;
    let mut wide = false;
    let mut spaces: Vec<(i64, usize)> = Vec::new();
    while x < far {
        if !col(x) {
            x += 1;
            // A wide gap ends the title (the buttons follow).
            if last.as_ref().is_some_and(|(e, _)| x - e > 12) {
                break;
            }
            continue;
        }
        let a = x;
        while x < far && col(x) {
            x += 1;
        }
        let rows: Vec<String> = (top..top + band)
            .map(|y| (a..x).map(|c| if ink(c, y) { '#' } else { '.' }).collect())
            .collect();
        let ch = split_run(font, &rows, 0)?;
        if let Some((end, prev)) = &last {
            let gap = a - end;
            let one = prev.ends_with('1');
            if gap >= if one { 6 } else { 3 } {
                text.push(' ');
                if !one {
                    spaces.push((gap, text.chars().count()));
                } else if gap > 9 {
                    wide = true;
                }
            } else if one && gap >= 4 {
                wide = true;
            }
        }
        text.push_str(&ch);
        last = Some((x, ch));
    }
    let (end, _) = last?;
    let (_street, map) = text.split_once(" : ")?;
    let want = bar_fold(map);
    let hit = nm.by_fold.get(&want)?;
    let total = text.chars().count();
    let from = total - map.chars().count();
    // A word space where a hidden glyph would make another catalog name.
    if let Some(at) = nm.short.get(&want) {
        for (i, &(gap, pos)) in spaces.iter().enumerate() {
            if pos < from || !at.contains(&(pos - from)) {
                continue;
            }
            let others: Vec<i64> = spaces
                .iter()
                .enumerate()
                .filter(|(j, _)| *j != i)
                .map(|(_, s)| s.0)
                .collect();
            if gap > 5 || others.iter().max().is_some_and(|&mx| gap >= mx + 2) {
                wide = true;
            }
        }
        if wide {
            return None;
        }
        // The bar right of the name is its own grey for 2 glyph widths.
        let x1 = gw.min(end + 10);
        let (mut off, mut all) = (0usize, 0usize);
        for y in top..top + band {
            let mut v: Vec<f64> = (0..span)
                .map(|xx| l(xx, y))
                .filter(|&v| v >= 100.0)
                .collect();
            if v.is_empty() {
                continue;
            }
            v.sort_by(f64::total_cmp);
            let r = v[v.len() >> 1];
            for xx in end..x1 {
                all += 1;
                if (l(xx, y) - r).abs() > 24.0 {
                    off += 1;
                }
            }
        }
        if x1 - end < 10 || off as f64 > 0.03 * all as f64 {
            return None;
        }
    }
    Some(MapRead {
        name: hit.clone(),
        room: room_of(hit),
        bar: true,
    })
}

/// The collapsed bar of a smoothly stretched corner on game pixels.
fn unstretch_bar(rgba: &Rgba, k0: f64, cache: &mut MapCache) -> Option<Gray> {
    let w = rgba.width.min(js_round(440.0 * k0) as usize);
    let h = rgba.height.min(js_round(100.0 * k0) as usize);
    let mut lum = vec![0f32; w * h];
    for y in 0..h {
        for x in 0..w {
            let (r, g, b) = rgba.rgb(x, y);
            lum[y * w + x] = super::image::luma709(r, g, b) as f32;
        }
    }
    const TOL: f64 = 10.0;
    // Paper rows: 120+ game px of one light grey in a run.
    let mut rows: Vec<Option<(usize, usize, f64)>> = Vec::with_capacity(h);
    for y in 0..h {
        let line = &lum[y * w..(y + 1) * w];
        let mut hist: Vec<(i32, usize)> = Vec::new();
        for &v in line {
            let q = (v as i32) >> 3;
            match hist.iter_mut().find(|e| e.0 == q) {
                Some(e) => e.1 += 1,
                None => hist.push((q, 1)),
            }
        }
        let q0 = hist
            .iter()
            .fold((0i32, 0usize), |b, &e| if e.1 > b.1 { e } else { b })
            .0;
        let near: Vec<f64> = line
            .iter()
            .filter(|&&v| (((v as i32) >> 3) - q0).abs() <= 1)
            .map(|&v| v as f64)
            .collect();
        let v = if near.is_empty() {
            0.0
        } else {
            near.iter().sum::<f64>() / near.len() as f64
        };
        let mut run: Option<(usize, usize)> = None;
        if v >= 180.0 && near.len() as f64 >= 120.0 * k0 {
            let (mut a, mut off): (Option<usize>, usize) = (None, 0);
            for x in 0..=w {
                let on = line.get(x).is_some_and(|&l| (l as f64 - v).abs() <= TOL);
                if on {
                    a.get_or_insert(x);
                    off = 0;
                    continue;
                }
                if a.is_some() && x < w {
                    off += 1;
                    if off <= 2 {
                        continue;
                    }
                }
                if let Some(st) = a.take() {
                    let b = x - off + usize::from(x < w);
                    if run.is_none_or(|r| b - st > r.1 - r.0) {
                        run = Some((st, b));
                    }
                    off = 0;
                }
            }
            if run.is_some_and(|r| ((r.1 - r.0) as f64) < 120.0 * k0) {
                run = None;
            }
        }
        rows.push(run.map(|(a, b)| (a, b, v)));
    }
    struct Group {
        y0: usize,
        y1: usize,
        v: f64,
        sum: f64,
        last: f64,
        a0: usize,
        a: usize,
        b: usize,
    }
    let mut groups: Vec<Group> = Vec::new();
    for (y, r) in rows.iter().enumerate() {
        let Some((ra, rb, rv)) = *r else { continue };
        match groups.last_mut() {
            Some(g) if g.y1 + 1 == y && (g.last - rv).abs() <= 8.0 && g.a0.abs_diff(ra) <= 4 => {
                g.y1 = y;
                g.a = g.a.max(ra);
                g.b = g.b.min(rb);
                g.sum += rv;
                g.v = g.sum / (y - g.y0 + 1) as f64;
                g.last = rv;
            }
            _ => groups.push(Group {
                y0: y,
                y1: y,
                v: rv,
                sum: rv,
                last: rv,
                a0: ra,
                a: ra,
                b: rb,
            }),
        }
    }
    let mut bar: Option<(usize, usize, usize, usize, f64)> = None;
    for i in 0..groups.len() {
        if bar.is_some() {
            break;
        }
        let ga = &groups[i];
        let Some(gb) = groups[i + 1..]
            .iter()
            .find(|g| g.a0.abs_diff(ga.a0) <= 4 && (g.v - ga.v).abs() <= 12.0)
        else {
            continue;
        };
        let gap = gb.y0 as f64 - ga.y1 as f64 - 1.0;
        let a = ga.a.max(gb.a) + 1;
        let b = ga.b.min(gb.b).saturating_sub(1);
        if gap < 6.0 * k0 || gap > 13.0 * k0 || (b as f64) - (a as f64) < 100.0 * k0 {
            continue;
        }
        let ink = (ga.y1 + 1..gb.y0)
            .flat_map(|y| (a..b).map(move |x| (x, y)))
            .filter(|&(x, y)| lum[y * w + x] < 60.0)
            .count();
        if ink >= 10 {
            let mut pp: Vec<f64> = (ga.y0..=gb.y1)
                .flat_map(|y| (a..b).step_by(2).map(move |x| (x, y)))
                .map(|(x, y)| lum[y * w + x] as f64)
                .filter(|&l| l >= 150.0)
                .collect();
            pp.sort_by(f64::total_cmp);
            let v = if pp.is_empty() {
                (ga.v + gb.v) / 2.0
            } else {
                pp[pp.len() >> 1]
            };
            bar = Some((ga.y0, gb.y1, a, b, v));
        }
    }
    let (ya, yb, a, b, pv) = bar?;
    let sh = yb - ya + 1;
    let sw = (b - a).min(js_round(200.0 * k0) as usize);
    let mut s = Vec::with_capacity(sw * sh);
    for y in 0..sh {
        s.extend_from_slice(&lum[(ya + y) * w + a..(ya + y) * w + a + sw]);
    }
    let miss = |p: &Gray| {
        p.d.iter()
            .map(|&v| (v as f64).abs().min((v as f64 - pv).abs()).min(40.0))
            .sum::<f64>()
    };
    let key = format!("{k0:.3}");
    let mut k = k0 * cache.bar_fix.get(&key).copied().unwrap_or(1.0);
    let best = if cache.bar_fix.contains_key(&key) {
        fit_phase(&s, sw, sh, k, 0.0, &miss, None, Some(8))
    } else if cache.bar_wait.get(&key).is_some_and(|&n| n > 0) {
        if let Some(n) = cache.bar_wait.get_mut(&key) {
            *n -= 1;
        }
        return None;
    } else {
        let mut coarse: Option<(f64, f64)> = None;
        for j in -12..=12 {
            let kk = k0 * (1.0 + j as f64 * 0.004);
            for pa in 0..4 {
                for pb in 0..4 {
                    let Some(p) = unstretch_plane(&s, sw, sh, kk, pa as f64 / 4.0, pb as f64 / 4.0)
                    else {
                        continue;
                    };
                    let e = miss(&p) / (p.w * p.h) as f64;
                    if coarse.is_none_or(|c| e < c.0) {
                        coarse = Some((e, kk));
                    }
                }
            }
        }
        let mut best = None;
        if let Some((_, ck)) = coarse {
            k = ck;
            best = fit_phase(&s, sw, sh, k, 0.0, &miss, None, Some(8));
            for st in [0.001, -0.001, 0.00025, -0.00025] {
                for _ in 0..12 {
                    let Some(cur) = best else { break };
                    let kk = k * (1.0 + st);
                    match fit_phase(&s, sw, sh, kk, 0.0, &miss, None, Some(8)) {
                        Some(nb) if nb.e < cur.e => {
                            best = Some(nb);
                            k = kk;
                        }
                        _ => break,
                    }
                }
            }
        }
        if best.is_some_and(|b| b.e <= FIT_MAX) {
            cache.bar_fix.insert(key, k / k0);
        } else {
            cache.bar_wait.insert(key, 10);
        }
        best
    };
    let best = best.filter(|b| b.e <= FIT_MAX)?;
    let fw = (w - a).min(js_round(300.0 * k0) as usize);
    let fh = (h - ya).min(sh + js_round(4.0 * k0) as usize);
    let mut fl = Vec::with_capacity(fw * fh);
    for y in 0..fh {
        fl.extend_from_slice(&lum[(ya + y) * w + a..(ya + y) * w + a + fw]);
    }
    unstretch_plane(&fl, fw, fh, k, best.px, best.py)
}

/// Scale of the header found last, for reports.
pub fn last_scale(cache: &MapCache) -> Option<f64> {
    cache.last_scale.map(|s| round_to(s, 3))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn map_names() {
        assert!(is_map_name("Free Market <4>"));
        assert!(is_map_name("Kerning City"));
        assert!(!is_map_name("Free Market <123>"));
        assert!(!is_map_name("Free-Market"));
        assert_eq!(room_of("Free Market <12>"), Some(12));
        assert_eq!(room_of("Kerning City"), None);
        assert!(names().list.len() > 1000);
    }
}

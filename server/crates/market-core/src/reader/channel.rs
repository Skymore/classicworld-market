//! The channel number from the game's CHANGE CHANNEL menu (channelreader.js).
//!
//! The menu: a wide flat blue bar with the world's name, whose width `wb`
//! sets the scale of everything below it; a grid of grey channel buttons,
//! 8 a row; the button under the menu's cursor is blue (the player's
//! channel when the menu opens; after a pick the picked one is blue and the
//! player's own turns dark); an orange CANCEL button at the bottom right.
//! Any check that fails gives no channel.

use serde::Serialize;

use super::{js_round, Rgba};

// Geometry relative to the bar's left edge, top and width.
const COL_PITCH: f64 = 0.1257;
const BTN_W: f64 = 0.1215;
const ROW0: f64 = 0.0729;
const ROW_PITCH: f64 = 0.0396;
const BTN_H: f64 = 0.036;
const CANCEL: [f64; 4] = [0.884, 0.214, 0.995, 0.243];
const BAR_MIN_W: f64 = 0.15;
const BAR_MAX_W: f64 = 0.8;
const BAR_MIN_H: f64 = 0.03;
const BAR_MAX_H: f64 = 0.075;
pub const MAX_CHANNEL: usize = crate::protocol::MAX_CHANNEL as usize;
const MAX_ROWS: usize = MAX_CHANNEL.div_ceil(8);

fn cancel_rect(rows: usize) -> [f64; 4] {
    let extra = rows.saturating_sub(3) as f64 * ROW_PITCH;
    [CANCEL[0], CANCEL[1] + extra, CANCEL[2], CANCEL[3] + extra]
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize)]
pub struct ChannelRead {
    /// The player's channel: the dark button when a pick is shown, else the blue one.
    pub channel: u8,
    /// The blue button when a dark one is also shown (the channel being changed to).
    pub picked: Option<u8>,
    pub buttons: usize,
}

/// The menu's blue bar and the height scale of the picture.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct MenuBox {
    pub x0: usize,
    pub y0: usize,
    pub x1: usize,
    pub y1: usize,
    pub wb: f64,
    pub ky: f64,
}

#[inline]
fn is_bar(r: u8, g: u8, b: u8) -> bool {
    let (r, g, b) = (r as i32, g as i32, b as i32);
    b > 150 && r < 120 && g > 90 && g < 185 && b - r > 60
}

#[inline]
fn bar_at(img: &Rgba, x: usize, y: usize) -> bool {
    let (r, g, b) = img.rgb(x, y);
    is_bar(r, g, b)
}

struct Run {
    y: usize,
    a: usize,
    b: usize,
}

fn bar_runs(img: &Rgba, s: usize, off: usize) -> Vec<Run> {
    let (w, h) = (img.width, img.height);
    let (min_w, max_w) = (BAR_MIN_W * w as f64, BAR_MAX_W * w as f64);
    let mut out = Vec::new();
    let mut y = off;
    while y < h {
        let (mut start, mut gap, mut last): (Option<usize>, usize, usize) = (None, 0, 0);
        let mut x = 0;
        while x <= w {
            let on = x < w && bar_at(img, x, y);
            if on {
                start.get_or_insert(x);
                last = x;
                gap = 0;
            } else if let Some(st) = start {
                // One missed sample is noise; two end the run.
                gap += 1;
                if gap > 1 {
                    let rw = (last - st + s) as f64;
                    if rw >= min_w && rw <= max_w {
                        out.push(Run { y, a: st, b: last });
                    }
                    start = None;
                    gap = 0;
                }
            }
            x += s;
        }
        y += s;
    }
    out
}

/// The bar's edges at full resolution from a clean row `y`.
fn refine(img: &Rgba, y: usize, a: usize, b: usize) -> (usize, usize, usize, usize, f64) {
    let (w, h) = (img.width, img.height);
    let (mut x0, mut x1) = (a, b);
    while x0 > 0 && bar_at(img, x0 - 1, y) {
        x0 -= 1;
    }
    while x1 < w - 1 && bar_at(img, x1 + 1, y) {
        x1 += 1;
    }
    let wb = (x1 - x0 + 1) as f64;
    let (mut y0, mut y1) = (y, y);
    for f in [0.03, 0.5, 0.97] {
        let x = js_round(x0 as f64 + f * (wb - 1.0)) as usize;
        let (mut t, mut u) = (y, y);
        while t > 0 && bar_at(img, x, t - 1) {
            t -= 1;
        }
        while u < h - 1 && bar_at(img, x, u + 1) {
            u += 1;
        }
        y0 = y0.min(t);
        y1 = y1.max(u);
    }
    (x0, y0, x1, y1, wb)
}

fn candidates(img: &Rgba) -> Vec<MenuBox> {
    let s = (img.width / 640).max(1);
    let mut runs: Vec<Run> = (0..s).flat_map(|off| bar_runs(img, s, off)).collect();
    runs.sort_by(|p, q| p.y.cmp(&q.y).then(p.a.cmp(&q.a)));
    let mut used = vec![false; runs.len()];
    let mut out = Vec::new();
    for i in 0..runs.len() {
        if used[i] {
            continue;
        }
        let r = &runs[i];
        let rw = (r.b - r.a) as f64;
        let tol = (2.0 * s as f64).max(0.015 * rw);
        for j in i + 1..runs.len() {
            let q = &runs[j];
            if (q.y - r.y) as f64 > BAR_MAX_H * rw + s as f64 {
                break;
            }
            if (q.a as f64 - r.a as f64).abs() <= tol && (q.b as f64 - r.b as f64).abs() <= tol {
                used[j] = true;
            }
        }
        let (x0, y0, x1, y1, wb) = refine(img, r.y, r.a, r.b);
        let bh = (y1 - y0 + 1) as f64;
        if bh < BAR_MIN_H * wb || bh > BAR_MAX_H * wb {
            continue;
        }
        if x0 <= 1 || x1 + 2 >= img.width {
            continue;
        }
        if y0 as f64 + (CANCEL[3] + 0.01) * wb >= img.height as f64 {
            continue;
        }
        out.push(MenuBox {
            x0,
            y0,
            x1,
            y1,
            wb,
            ky: 0.0,
        });
    }
    out
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Button {
    Blue,
    Dark,
    Grey,
    Empty,
    Unknown,
}

/// The inner part of a button: the share of pixels of each kind.
fn classify(img: &Rgba, bx: f64, by: f64, bw: f64, bh: f64) -> (Button, f64) {
    let xa = js_round(bx + 0.08 * bw) as usize;
    let xb = js_round(bx + 0.92 * bw) as usize;
    let ya = js_round(by + 0.2 * bh) as usize;
    let yb = js_round(by + 0.8 * bh) as usize;
    let step = ((xb.saturating_sub(xa)) / 40).max(1);
    let ystep = (step / 2).max(1);
    let (mut n, mut blue, mut dark, mut grey, mut white) = (0, 0, 0, 0, 0);
    let mut y = ya;
    while y <= yb {
        let mut x = xa;
        while x <= xb {
            let (r, g, b) = img.rgb(x, y);
            let (r, g, b) = (r as i32, g as i32, b as i32);
            let (mx, mn) = (r.max(g).max(b), r.min(g).min(b));
            n += 1;
            if b > 160 && b - r > 80 && r < 150 {
                blue += 1;
            } else if mx - mn < 30 && mx < 135 {
                dark += 1;
            } else if mx - mn < 30 && (140..=222).contains(&mx) {
                grey += 1;
            } else if mx - mn < 30 && mn > 222 {
                white += 1;
            }
            x += step;
        }
        y += ystep;
    }
    if n == 0 {
        return (Button::Unknown, 0.0);
    }
    let sh = |c: i32| c as f64 / n as f64;
    let (sb, sd, sg, sw) = (sh(blue), sh(dark), sh(grey), sh(white));
    if sb >= 0.3 && sd < 0.15 {
        (Button::Blue, sb)
    } else if sd >= 0.3 && sb < 0.1 {
        (Button::Dark, sd)
    } else if sg >= 0.45 && sb < 0.1 && sd < 0.1 {
        (Button::Grey, sg)
    } else if sw >= 0.75 {
        (Button::Empty, sw)
    } else {
        (Button::Unknown, sb.max(sd).max(sg).max(sw))
    }
}

fn is_orange(img: &Rgba, x: usize, y: usize) -> bool {
    let (r, g, b) = img.rgb(x, y);
    let (r, g, b) = (r as i32, g as i32, b as i32);
    r > 180 && r - b > 90 && g > 70 && g < 200
}

fn ky_tries(k: f64) -> Vec<f64> {
    if (k - 1.0).abs() <= 0.05 {
        vec![1.0, k]
    } else {
        vec![k, k - 0.015, k + 0.015, k - 0.03, k + 0.03]
    }
}

fn cancel_ok(img: &Rgba, bx: &MenuBox, rows: usize) -> bool {
    let cancel = cancel_rect(rows);
    let (wb, ky) = (bx.wb, bx.ky);
    let xa = js_round(bx.x0 as f64 + cancel[0] * wb) as usize;
    let xb = js_round(bx.x0 as f64 + cancel[2] * wb) as usize;
    let ya = js_round(bx.y0 as f64 + cancel[1] * ky * wb) as usize;
    let yb = js_round(bx.y0 as f64 + cancel[3] * ky * wb) as usize;
    if xb >= img.width || yb >= img.height {
        return false;
    }
    let step = ((xb - xa) / 40).max(1);
    let ystep = (js_round(step as f64 * ky) as usize).max(1);
    let (mut n, mut o) = (0, 0);
    let mut y = ya;
    while y <= yb {
        let mut x = xa;
        while x <= xb {
            n += 1;
            if is_orange(img, x, y) {
                o += 1;
            }
            x += step;
        }
        y += ystep;
    }
    n > 0 && o as f64 / n as f64 >= 0.3
}

/// Reads the grid under a bar with a known height scale; `Err` says why not.
fn read_grid(img: &Rgba, bx: &MenuBox, rows: usize) -> Result<ChannelRead, String> {
    if !cancel_ok(img, bx, rows) {
        return Err("no CANCEL button under the bar: not the channel menu".into());
    }
    let (wb, ky) = (bx.wb, bx.ky);
    let (bw, bh) = (BTN_W * wb, BTN_H * ky * wb);
    let mut kinds = Vec::with_capacity(rows * 8);
    for r in 0..rows {
        for c in 0..8 {
            let bxx = bx.x0 as f64 + COL_PITCH * c as f64 * wb;
            let by = bx.y0 as f64 + (ROW0 + ROW_PITCH * r as f64) * ky * wb;
            if bxx + bw >= img.width as f64 || by + bh >= img.height as f64 {
                return Err("the menu is cut by the edge of the picture".into());
            }
            kinds.push(classify(img, bxx, by, bw, bh).0);
        }
    }
    // Every row but the last is full. Never infer a channel from a partial grid.
    let mut buttons = 0;
    for (i, k) in kinds.iter().enumerate() {
        match k {
            Button::Empty => break,
            Button::Unknown => return Err(format!("button {} could not be told", i + 1)),
            _ => buttons += 1,
        }
    }
    if buttons < 16 {
        return Err(format!(
            "only {buttons} buttons in a row: not the channel menu"
        ));
    }
    if kinds[buttons..].iter().any(|&k| k != Button::Empty) {
        return Err("a button after an empty place".into());
    }
    if buttons > MAX_CHANNEL {
        return Err(format!("more than {MAX_CHANNEL} channels"));
    }
    let blue: Vec<usize> = (0..buttons)
        .filter(|&b| kinds[b] == Button::Blue)
        .map(|b| b + 1)
        .collect();
    let dark: Vec<usize> = (0..buttons)
        .filter(|&b| kinds[b] == Button::Dark)
        .map(|b| b + 1)
        .collect();
    if blue.len() != 1 {
        return Err(if blue.is_empty() {
            "no blue button"
        } else {
            "two blue buttons"
        }
        .into());
    }
    if dark.len() > 1 {
        return Err("two dark buttons".into());
    }
    let (channel, picked) = match dark.first() {
        Some(&d) => (d, Some(blue[0] as u8)),
        None => (blue[0], None),
    };
    Ok(ChannelRead {
        channel: channel as u8,
        picked,
        buttons,
    })
}

/// Reads the menu under a bar, using its height scale and validating the row count.
pub fn read_channel(img: &Rgba, bx: &MenuBox) -> Result<(ChannelRead, MenuBox), String> {
    let mut last = Err("no channel menu".to_string());
    // The title bar scales with the buttons but does not get taller when more
    // channel rows are added. CANCEL alone cannot distinguish extra rows from
    // a vertically stretched menu (it can misread CH32 as CH24).
    let header_scale = (bx.y1 - bx.y0 + 1) as f64 / (0.054 * bx.wb);
    for rows in 3..=MAX_ROWS {
        let scales = if bx.ky > 0.0 {
            vec![bx.ky]
        } else {
            ky_tries(header_scale)
        };
        for ky in scales {
            let b = MenuBox { ky, ..*bx };
            match read_grid(img, &b, rows) {
                Ok(r) => return Ok((r, b)),
                Err(e) => last = Err(e),
            }
        }
    }
    last
}

/// The channel menu in a frame (with its height scale), or why not.
pub fn find_channel_menu(img: &Rgba) -> Result<(ChannelRead, MenuBox), String> {
    let cands = candidates(img);
    if cands.is_empty() {
        return Err("no bar of the menu's shape".into());
    }
    let mut first_why: Option<String> = None;
    for c in cands {
        match read_channel(img, &c) {
            Ok(found) => return Ok(found),
            Err(e) => {
                first_why.get_or_insert(format!("{e} (a {} px bar)", c.wb));
            }
        }
    }
    Err(first_why.unwrap_or_default())
}

/// Under the bar's run, the first row of grey buttons.
fn buttons_under(img: &Rgba, xa: usize, xb: usize, y: usize) -> bool {
    let (w, h) = (img.width, img.height);
    let bw = xb.saturating_sub(xa);
    let (mut n, mut grey) = (0, 0);
    let mut dy = 0.06;
    while dy <= 0.13 + 1e-12 {
        let yy = js_round(y as f64 + dy * bw as f64) as usize;
        if yy >= h {
            break;
        }
        let mut x = xa;
        while x <= xb && x < w {
            let (r, g, b) = img.rgb(x, yy);
            let (mx, mn) = (r.max(g).max(b) as i32, r.min(g).min(b) as i32);
            n += 1;
            if mx - mn < 30 && (140..=222).contains(&mx) {
                grey += 1;
            }
            x += (bw / 40).max(1);
        }
        dy += 0.01;
    }
    n > 0 && grey as f64 / n as f64 >= 0.25
}

/// Cheap first look: a long run of bar blue with grey buttons under it.
pub fn maybe_menu(img: &Rgba) -> bool {
    let (w, h) = (img.width, img.height);
    let s = (w / 160).max(1);
    let need = ((BAR_MIN_W * w as f64 / s as f64).floor() as usize).max(3);
    let mut y = 0;
    while y < h {
        let (mut run, mut miss) = (0usize, 0usize);
        let mut x = 0;
        while x < w {
            if bar_at(img, x, y) {
                run += 1;
                miss = 0;
                if run >= need && buttons_under(img, x - (run - 1) * s, x, y) {
                    return true;
                }
            } else {
                miss += 1;
                if miss > 1 {
                    run = 0;
                    miss = 0;
                }
            }
            x += s;
        }
        y += s;
    }
    false
}

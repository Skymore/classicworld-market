//! Synthetic game frames for the reader's tests and benchmark: a player
//! store window drawn from the embedded header template, rows drawn in the
//! embedded pixel font (or from the atlas digit templates), a CHANGE CHANNEL
//! menu and the minimap's one-line bar, on a textured background. The game
//! picture is 1366 x 768 game px; frames at other scales are stretched from it.
#![allow(dead_code)]

use market_core::reader::font::draw_text;
use market_core::reader::image::resample;
use market_core::reader::templates;
use market_core::reader::RgbaBuf;

pub const GAME_W: usize = 1366;
pub const GAME_H: usize = 768;
/// Frame px per 640-space px at UI scale 1 in the 1366-wide game picture.
pub const U: f64 = GAME_W as f64 / 640.0;

#[derive(Debug, Clone)]
pub struct RowSpec {
    pub name: &'static str,
    pub qty: u32,
    pub price: u64,
    pub sold: bool,
}

pub fn row(name: &'static str, qty: u32, price: u64, sold: bool) -> RowSpec {
    RowSpec {
        name,
        qty,
        price,
        sold,
    }
}

#[derive(Debug, Clone)]
pub struct ShopSpec {
    pub title: &'static str,
    pub seller: Option<&'static str>,
    pub rows: Vec<RowSpec>,
    /// Window top-left, game px.
    pub at: (usize, usize),
}

#[derive(Debug, Clone)]
pub struct MenuSpec {
    pub at: (usize, usize),
    pub wb: usize,
    pub channels: usize,
    /// The blue button.
    pub blue: u8,
    /// A dark button (the player's own channel while another is picked).
    pub dark: Option<u8>,
}

#[derive(Debug, Clone, Default)]
pub struct SceneSpec {
    pub shop: Option<ShopSpec>,
    pub menu: Option<MenuSpec>,
    pub map_bar: Option<&'static str>,
    pub seed: u64,
}

pub fn commas(n: u64) -> String {
    let s = n.to_string();
    let mut out = String::new();
    for (i, c) in s.chars().enumerate() {
        if i > 0 && (s.len() - i).is_multiple_of(3) {
            out.push(',');
        }
        out.push(c);
    }
    out
}

/// A small deterministic noise source.
pub struct Lcg(u64);

impl Lcg {
    pub fn new(seed: u64) -> Self {
        Self(
            seed.wrapping_mul(6364136223846793005)
                .wrapping_add(1442695040888963407),
        )
    }
    pub fn next(&mut self) -> u32 {
        self.0 = self
            .0
            .wrapping_mul(6364136223846793005)
            .wrapping_add(1442695040888963407);
        (self.0 >> 33) as u32
    }
}

fn fill(img: &mut RgbaBuf, x0: usize, y0: usize, w: usize, h: usize, rgb: [u8; 3]) {
    for y in y0..(y0 + h).min(img.height) {
        for x in x0..(x0 + w).min(img.width) {
            img.set(x, y, rgb);
        }
    }
}

fn text(img: &mut RgbaBuf, s: &str, x: i64, base: i64, rgb: [u8; 3]) -> i64 {
    let font = &templates::get().font;
    let (w, h) = (img.width as i64, img.height as i64);
    draw_text(font, s, x, base, &mut |px, py| {
        if px >= 0 && py >= 0 && px < w && py < h {
            img.set(px as usize, py as usize, rgb);
        }
    })
}

fn background(seed: u64) -> RgbaBuf {
    let mut img = RgbaBuf::filled(GAME_W, GAME_H, [0, 0, 0]);
    let mut rng = Lcg::new(seed);
    for y in 0..GAME_H {
        for x in 0..GAME_W {
            let n = (rng.next() % 24) as i64;
            let (xi, yi) = (x as i64, y as i64);
            // A sky gradient with tiles and noise.
            let tile = ((xi / 40 + yi / 30) % 4) * 18;
            let r = 60 + yi * 110 / GAME_H as i64 + n;
            let g = 150 + tile - yi * 70 / GAME_H as i64;
            let b = 210 - yi * 130 / GAME_H as i64 + n;
            img.set(
                x,
                y,
                [
                    r.clamp(0, 255) as u8,
                    g.clamp(0, 255) as u8,
                    b.clamp(0, 255) as u8,
                ],
            );
        }
    }
    // Some blocky scenery (platforms).
    for i in 0..12 {
        let x = (i * 131 + seed as usize * 17) % (GAME_W - 200);
        let y = 300 + (i * 53) % 400;
        fill(&mut img, x, y.min(GAME_H - 20), 180, 14, [120, 90, 60]);
    }
    img
}

/// The header template (grey, 320-space) upsampled to game px.
fn draw_header(img: &mut RgbaBuf, wx: usize, wy: usize) -> (usize, usize) {
    let t = &templates::get().windows.player;
    let f = 2.0 * U;
    let (hw, hh) = (
        (t.half.w as f64 * f).round() as usize,
        (t.half.h as f64 * f).round() as usize,
    );
    let up = resample(&t.half.d, t.half.w, t.half.h, hw, hh);
    for y in 0..hh {
        for x in 0..hw {
            // Posterised: the game's UI is flat colours, the template a blurred VOD crop.
            let v = ((up[y * hw + x] / 32.0).round() * 32.0).clamp(0.0, 255.0) as u8;
            if wx + x < img.width && wy + y < img.height {
                img.set(wx + x, wy + y, [v, v, v]);
            }
        }
    }
    (hw, hh)
}

fn draw_icon(img: &mut RgbaBuf, x0: usize, y0: usize, seed: u32) {
    let hue = [
        [200, 60, 50],
        [60, 160, 70],
        [70, 90, 210],
        [200, 170, 40],
        [150, 70, 180],
    ][seed as usize % 5];
    for y in 0..30 {
        for x in 0..30 {
            let (dx, dy) = (x as i32 - 15, y as i32 - 15);
            let d = dx.abs() + dy.abs();
            let rgb = if d > 15 {
                continue;
            } else if d >= 14 {
                [30, 30, 30]
            } else if (d / 3) % 2 == 0 {
                hue
            } else {
                [hue[0] / 2 + 100, hue[1] / 2 + 100, hue[2] / 2 + 100]
            };
            img.set(x0 + x, y0 + y, [rgb[0] as u8, rgb[1] as u8, rgb[2] as u8]);
        }
    }
}

/// One shop row at its box's top-left (game px): 262 x 38.
pub fn draw_row(img: &mut RgbaBuf, x0: usize, y0: usize, r: &RowSpec, seed: u32) {
    let (paper, ink) = if r.sold { (244, 187) } else { (215, 0) };
    fill(img, x0, y0, 262, 38, [246, 246, 246]);
    if r.sold {
        fill(img, x0, y0, 262, 1, [253, 253, 253]);
    }
    draw_icon(img, x0 + 5, y0 + 4, seed);
    fill(img, x0 + 41, y0 + 2, 162, 34, [paper; 3]);
    if r.sold {
        fill(img, x0 + 202, y0 + 2, 1, 34, [215; 3]);
        fill(img, x0 + 41, y0 + 35, 162, 1, [215; 3]);
    }
    fill(img, x0 + 45, y0 + 19, 155, 1, [255; 3]);
    text(img, r.name, x0 as i64 + 46, y0 as i64 + 13, [ink; 3]);
    let offer = format!("{} for {} mesos", commas(r.qty as u64), commas(r.price));
    text(img, &offer, x0 as i64 + 46, y0 as i64 + 30, [ink; 3]);
}

/// The player store window; returns the window's game-px box.
pub fn draw_shop(img: &mut RgbaBuf, s: &ShopSpec) -> [usize; 4] {
    let t = &templates::get().windows.player;
    let (wx, wy) = s.at;
    let (ww, wh) = (
        (t.full_w * U).round() as usize,
        (t.full_h * U).round() as usize,
    );
    // The window body: luma 214, as the game's (the seller tag's fit expects it).
    fill(img, wx, wy, ww, wh, [222, 214, 198]);
    let (hw, _) = draw_header(img, wx, wy);
    // The shop's title in the header's bar, over the template's own.
    fill(img, wx + 14, wy + 6, 290, 16, [236, 236, 236]);
    text(img, s.title, wx as i64 + 18, wy as i64 + 18, [30, 30, 30]);
    if let Some(seller) = s.seller {
        fill(img, wx + 9, wy + 135, 87, 17, [222, 222, 222]);
        for y in 0..15 {
            let shade = 43 + (y as u8 * 11) / 15;
            fill(
                img,
                wx + 10,
                wy + 136 + y,
                85,
                1,
                [shade - 8, shade, shade + 16],
            );
        }
        text(
            img,
            seller,
            wx as i64 + 13,
            wy as i64 + 146,
            [255, 255, 255],
        );
    }
    // Six row slots with dotted separators above each.
    for band in 0..6 {
        let top = wy + 153 + 40 * band;
        for x in 0..262 {
            let v = if x % 2 == 0 { 110 } else { 246 };
            img.set(wx + x, top - 1, [v, v, v]);
        }
        if let Some(r) = s.rows.get(band) {
            draw_row(img, wx, top, r, band as u32 + 7);
        }
    }
    let _ = hw;
    [wx, wy, wx + ww, wy + wh]
}

pub fn draw_menu(img: &mut RgbaBuf, m: &MenuSpec) {
    let (x0, y0, wb) = (m.at.0, m.at.1, m.wb as f64);
    let extra_rows = m.channels.div_ceil(8).saturating_sub(3) as f64;
    fill(
        img,
        x0 - 6,
        y0 - 4,
        m.wb + 12,
        ((0.26 + extra_rows * 0.0396) * wb) as usize + 8,
        [240, 240, 240],
    );
    let bh = (0.054 * wb).round() as usize;
    fill(img, x0, y0, m.wb, bh, [40, 120, 220]);
    text(
        img,
        "WlNDlA",
        x0 as i64 + (m.wb as i64) / 2 - 20,
        y0 as i64 + bh as i64 / 2 + 4,
        [255, 255, 255],
    );
    let (bw, bhh) = (
        (0.1215 * wb).round() as usize,
        (0.036 * wb).round() as usize,
    );
    for i in 0..m.channels {
        let (r, c) = (i / 8, i % 8);
        let bx = x0 + (0.1257 * c as f64 * wb).round() as usize;
        let by = y0 + ((0.0729 + 0.0396 * r as f64) * wb).round() as usize;
        let ch = i as u8 + 1;
        let rgb = if ch == m.blue {
            [40, 100, 230]
        } else if Some(ch) == m.dark {
            [90, 90, 90]
        } else {
            [182, 182, 182]
        };
        fill(img, bx, by, bw, bhh, rgb);
        text(
            img,
            &format!("CH.{ch}"),
            bx as i64 + 8,
            by as i64 + bhh as i64 - 3,
            [250, 250, 250],
        );
    }
    let cx = x0 + (0.884 * wb).round() as usize;
    let cy = y0 + ((0.214 + extra_rows * 0.0396) * wb).round() as usize;
    fill(
        img,
        cx,
        cy,
        (0.111 * wb).round() as usize,
        (0.029 * wb).round() as usize,
        [230, 120, 40],
    );
}

pub fn draw_map_bar(img: &mut RgbaBuf, label: &str) {
    fill(img, 0, 0, 420, 20, [221, 221, 221]);
    text(img, label, 4, 13, [0, 0, 0]);
}

/// The game picture at 1x.
pub fn render_game(s: &SceneSpec) -> RgbaBuf {
    let mut img = background(s.seed);
    if let Some(bar) = s.map_bar {
        draw_map_bar(&mut img, bar);
    }
    if let Some(shop) = &s.shop {
        draw_shop(&mut img, shop);
    }
    if let Some(m) = &s.menu {
        draw_menu(&mut img, m);
    }
    img
}

/// Bilinear stretch with half-pixel centres (a browser's or the game's smooth scaling).
pub fn stretch_bilinear(src: &RgbaBuf, w: usize, h: usize) -> RgbaBuf {
    let (sx, sy) = (w as f64 / src.width as f64, h as f64 / src.height as f64);
    let mut out = RgbaBuf::filled(w, h, [0, 0, 0]);
    let xs: Vec<(usize, usize, f64)> = (0..w)
        .map(|x| {
            let u = ((x as f64 + 0.5) / sx - 0.5).clamp(0.0, (src.width - 1) as f64);
            let i = u.floor() as usize;
            (i, (i + 1).min(src.width - 1), u - i as f64)
        })
        .collect();
    for y in 0..h {
        let v = ((y as f64 + 0.5) / sy - 0.5).clamp(0.0, (src.height - 1) as f64);
        let j = v.floor() as usize;
        let (j1, fy) = ((j + 1).min(src.height - 1), v - j as f64);
        for (x, &(i, i1, fx)) in xs.iter().enumerate() {
            let p = |xx: usize, yy: usize, c: usize| src.data[(yy * src.width + xx) * 4 + c] as f64;
            let mut rgb = [0u8; 3];
            for (c, o) in rgb.iter_mut().enumerate() {
                let top = p(i, j, c) * (1.0 - fx) + p(i1, j, c) * fx;
                let bot = p(i, j1, c) * (1.0 - fx) + p(i1, j1, c) * fx;
                *o = (top * (1.0 - fy) + bot * fy).round() as u8;
            }
            out.set(x, y, rgb);
        }
    }
    out
}

/// Nearest-pixel stretch (a sharp scaling).
pub fn stretch_nearest(src: &RgbaBuf, w: usize, h: usize) -> RgbaBuf {
    let mut out = RgbaBuf::filled(w, h, [0, 0, 0]);
    for y in 0..h {
        let sy = (y * src.height / h).min(src.height - 1);
        for x in 0..w {
            let sx = (x * src.width / w).min(src.width - 1);
            let i = (sy * src.width + sx) * 4;
            out.set(x, y, [src.data[i], src.data[i + 1], src.data[i + 2]]);
        }
    }
    out
}

pub fn noise_frame(w: usize, h: usize, seed: u64) -> RgbaBuf {
    let mut rng = Lcg::new(seed);
    let mut img = RgbaBuf::filled(w, h, [0, 0, 0]);
    for y in 0..h {
        for x in 0..w {
            let v = rng.next();
            img.set(x, y, [v as u8, (v >> 8) as u8, (v >> 16) as u8]);
        }
    }
    img
}

/// An offer line drawn from the atlas templates at canonical px ("mesos",
/// "for" and the digit pictures), with a name line in the font above, then
/// shrunk to a row picture at atlas scale `s` (row 369 * s px wide).
pub fn atlas_row(qty: u32, price: u64, name: &str, sold: bool, s: f64) -> RgbaBuf {
    let a = &templates::get().atlas;
    let c = &a.canonical;
    let (cw, ch) = ((369.0 * c.up) as usize, (56.0 * c.up) as usize);
    let paper = 215.0;
    let mut canvas = vec![paper as f32; cw * ch];
    let paste = |canvas: &mut Vec<f32>, d: &[f32], w: usize, h: usize, x0: f64, y0: usize| {
        let x0 = x0.round() as usize;
        for y in 0..h {
            for x in 0..w {
                if x0 + x < cw && y0 + y < ch {
                    canvas[(y0 + y) * cw + x0 + x] = d[y * w + x];
                }
            }
        }
    };
    let line_y = 4 * 27;
    let digits: Vec<u8> = price.to_string().bytes().map(|b| b - b'0').collect();
    let n = digits.len();
    let k = (n - 1) / 3;
    let f = 330.0;
    let m = f + c.gap0 + c.layout_adv * n as f64 + c.comma_w * k as f64;
    paste(
        &mut canvas,
        &a.for_plane.d,
        a.for_plane.w,
        a.for_plane.h,
        f,
        line_y,
    );
    paste(&mut canvas, &a.mesos.d, a.mesos.w, a.mesos.h, m, line_y);
    let start = f + c.for_to_digit;
    let adv = c.layout_adv;
    let mut x = start;
    for (i, &d) in digits.iter().enumerate() {
        if k > 0 && i > 0 && (n - i).is_multiple_of(3) {
            // A comma: a short dark stroke on the baseline.
            for yy in 50..64 {
                for xx in 4..9 {
                    canvas[(line_y + yy) * cw + (x as usize + xx)] = 30.0;
                }
            }
            x += c.comma_w;
        }
        let g = &a.digit_planes_a[d as usize];
        paste(
            &mut canvas,
            &g.d,
            g.w,
            g.h,
            x + (adv - c.digit_adv) / 2.0,
            line_y,
        );
        x += adv;
    }
    let q: Vec<u8> = qty.to_string().bytes().map(|b| b - b'0').collect();
    for (j, &d) in q.iter().rev().enumerate() {
        let g = &a.digit_planes_a[d as usize];
        paste(
            &mut canvas,
            &g.d,
            g.w,
            g.h,
            f - c.qty_start - c.digit_adv * j as f64,
            line_y,
        );
    }
    if sold {
        for v in canvas.iter_mut() {
            *v = 244.0 - (244.0 - *v).max(0.0) * 0.25;
        }
    }
    let (rw, rh) = ((369.0 * s).round() as usize, (56.0 * s).round() as usize);
    let small = resample(&canvas, cw, ch, rw, rh);
    let mut img = RgbaBuf::filled(rw, rh, [215, 215, 215]);
    for y in 0..rh {
        for x in 0..rw {
            let v = small[y * rw + x].round().clamp(0.0, 255.0) as u8;
            img.set(x, y, [v, v, v]);
        }
    }
    // The name in the font, enlarged to the row's scale.
    let k_game = 1.406 * s;
    let ink = if sold { 187 } else { 0 };
    let mut name_img = RgbaBuf::filled(200, 16, [paper as u8; 3]);
    text(&mut name_img, name, 2, 11, [ink; 3]);
    let big = stretch_bilinear(
        &name_img,
        (200.0 * k_game).round() as usize,
        (16.0 * k_game).round() as usize,
    );
    let (ox, oy) = ((46.0 * k_game) as usize, (2.0 * k_game) as usize);
    for y in 0..big.height {
        for x in 0..big.width {
            if ox + x < rw && oy + y < rh {
                let i = (y * big.width + x) * 4;
                img.set(
                    ox + x,
                    oy + y,
                    [big.data[i], big.data[i + 1], big.data[i + 2]],
                );
            }
        }
    }
    img
}

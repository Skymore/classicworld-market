//! One shop row: price, bundle size, sold mark and name (reader.js readRow).
//!
//! A whole-number scale reads exactly with the pixel font; a smooth stretch
//! is put back on game pixels first and then reads exactly too; anything
//! else goes to the atlas matcher. A covered row, a cut price or an unsure
//! digit abstains.

pub mod atlas;
pub mod exact;
pub mod stretch;

use serde::Serialize;

use self::atlas::AtlasReader;
use self::exact::{read_exact, sharp_grid, smooth_row, Exact, Kind};
use self::stretch::{unstretch_row, StretchCache};
use super::image::{percentile, Gray};
use super::{js_round, Rgba};

/// The atlas matcher's quantity start (game px) and "mesos" score a read
/// must keep: past them a glyph was hidden or "mesos" covered.
const OLD_START_MAX: f64 = 49.0;
const OLD_MESOS_MIN: f64 = 0.68;

#[derive(Debug, Clone, Copy, Default)]
pub struct RowOptions {
    /// The atlas scale expected for this row (window UI scale x frame width / 1920).
    pub scale: Option<f64>,
    /// Screen px per game px.
    pub k: Option<f64>,
    /// Margin the row was cut with (stretched rows).
    pub pad: Option<[usize; 4]>,
    /// The cut's top left in the frame.
    pub at: Option<[usize; 2]>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct RowRead {
    /// Price of one bundle, as shown.
    pub price: Option<u64>,
    /// Items in one bundle (the number before "for").
    pub qty: Option<u32>,
    pub name: Option<String>,
    pub name_score: Option<f64>,
    pub grade: Option<&'static str>,
    pub sold: Option<bool>,
    pub confidence: f64,
    /// Read glyph by glyph with the font (the name is then matched exactly).
    pub exact: bool,
    pub covered: bool,
    pub abstain: bool,
    pub why: String,
    pub scale: Option<f64>,
}

fn fail(why: &str, exact: bool, covered: bool, sold: Option<bool>) -> RowRead {
    RowRead {
        price: None,
        qty: None,
        name: None,
        name_score: None,
        grade: None,
        sold,
        confidence: 0.0,
        exact,
        covered,
        abstain: true,
        why: why.to_string(),
        scale: None,
    }
}

/// Reads the rows of one window: the atlas scale lock and the stretch fit
/// carry from row to row.
#[derive(Default)]
pub struct RowReader {
    atlas: AtlasReader,
    pub(crate) stretch: StretchCache,
}

impl RowReader {
    pub fn with_stretch(stretch: StretchCache) -> Self {
        Self {
            atlas: AtlasReader::default(),
            stretch,
        }
    }

    pub fn read(&mut self, padded: &Rgba, opts: &RowOptions) -> RowRead {
        let cropped = opts.pad.map(|p| crop(padded, p));
        let image = match &cropped {
            Some(Some(c)) => c.view(),
            Some(None) => return fail("row too small", false, false, None),
            None => *padded,
        };
        let k = opts.k.filter(|&k| k > 0.0);
        let k_whole = k.is_none_or(|k| (k - js_round(k)).abs() <= 0.03);
        let mut flat = match k {
            Some(k) if !k_whole && k > 1.1 && k <= 4.0 => {
                unstretch_row(padded, k, opts.pad, opts.at, &mut self.stretch)
            }
            _ => None,
        };
        let mut x = if k_whole {
            read_exact(&image, None)
        } else {
            flat.as_ref()
                .and_then(|f| read_exact(&f.image.view(), Some(f.tol)))
        };
        // A whole k of 2+ can be a smooth stretch too (a Retina Mac's 2x).
        let covered_or_none = !matches!(x, Some(Exact::Read(_)));
        if let Some(kk) = k {
            if covered_or_none
                && k_whole
                && (1.97..=4.0).contains(&kk)
                && smooth_row(&image, kk)
                && !sharp_grid(&image, js_round(kk) as usize)
            {
                if let Some(f) = unstretch_row(padded, kk, opts.pad, opts.at, &mut self.stretch) {
                    let y = read_exact(&f.image.view(), Some(f.tol));
                    if y.as_ref()
                        .is_some_and(|y| x.is_none() || matches!(y, Exact::Read(_)))
                    {
                        x = y;
                        flat = Some(f);
                    }
                }
            }
        }
        match x {
            Some(Exact::Covered { .. }) => {
                return fail("row covered (cursor or tooltip)", true, true, None)
            }
            Some(Exact::Read(r)) => {
                let sold = Some(r.kind == Kind::Sold);
                return match r.offer_parsed {
                    Some((qty, price)) => RowRead {
                        price: Some(price),
                        qty: Some(qty),
                        name: r.name.clone(),
                        name_score: None,
                        grade: r.grade,
                        sold,
                        confidence: 1.0,
                        exact: true,
                        covered: false,
                        abstain: false,
                        why: if r.name.is_some() {
                            "read"
                        } else {
                            "name not read"
                        }
                        .to_string(),
                        scale: Some(if flat.is_some() {
                            k.unwrap_or(1.0)
                        } else {
                            r.k as f64
                        }),
                    },
                    // A cut price ("884 for 499,999..."): its digits may be cut too.
                    None => fail("price cut off or not a price line", true, false, sold),
                };
            }
            None => {}
        }
        let (g, w, h) = pad_bottom(&Gray::from_rgba(&image));
        let r = self.atlas.read(&g, w, h, opts.scale.filter(|&s| s > 0.0));
        let mut out = RowRead {
            price: r.price,
            qty: r.qty,
            name: r.name.as_ref().and_then(|n| n.text.clone()),
            name_score: r.name.as_ref().and_then(|n| n.score),
            grade: None,
            sold: r.sold,
            confidence: r.confidence,
            exact: false,
            covered: false,
            abstain: r.abstain,
            why: r.why.clone(),
            scale: r.scale,
        };
        // A glyph hidden at the line's start, or "mesos" half covered, moves the price cells.
        if !out.abstain {
            if let Some(raw) = &r.raw {
                let start = k.map(|k| raw.qty_x0 / k);
                let why = if start.is_some_and(|s| s > OLD_START_MAX) {
                    Some("quantity starts too far right (a glyph hidden)")
                } else if raw.mesos < OLD_MESOS_MIN {
                    Some("\"mesos\" matched weakly (covered)")
                } else {
                    None
                };
                if let Some(why) = why {
                    out.price = None;
                    out.qty = None;
                    out.abstain = true;
                    out.why = why.to_string();
                }
            }
        }
        out
    }
}

/// The row box from a cut with a margin.
fn crop(img: &Rgba, pad: [usize; 4]) -> Option<super::RgbaBuf> {
    let w = img.width.checked_sub(pad[0] + pad[2])?;
    let h = img.height.checked_sub(pad[1] + pad[3])?;
    if w == 0 || h == 0 {
        return None;
    }
    Some(img.cut([pad[0], pad[1], pad[0] + w, pad[1] + h]))
}

/// Plain paper added below a row cut a few px too high, so the price
/// line's search band fits (the paper: 60th percentile of the last 3 rows).
fn pad_bottom(t: &Gray) -> (Vec<f32>, usize, usize) {
    let f = super::templates::get().atlas.canonical.pad_bottom;
    let p = js_round(f * t.h as f64) as usize;
    if p < 1 {
        return (t.d.clone(), t.w, t.h);
    }
    let last: Vec<f64> = t.d[t.h.saturating_sub(3) * t.w..]
        .iter()
        .map(|&v| v as f64)
        .collect();
    let bg = percentile(&last, 0.6).unwrap_or(0.0) as f32;
    let mut out = t.d.clone();
    out.resize(t.w * (t.h + p), bg);
    (out, t.w, t.h + p)
}

//! The reader's template data, embedded from `assets/` (copied from
//! meso.watch's live reader with the owner's knowledge; see
//! THIRD_PARTY_NOTICES.md). Parsed once, on first use.

use std::collections::HashMap;
use std::fmt;
use std::sync::OnceLock;

use serde::de::{Deserializer, MapAccess, Visitor};
use serde::Deserialize;

use super::image::{base64_decode, prepare, Prepared};

const ATLAS_JSON: &str = include_str!("../../assets/atlas.json");
const CATALOG_JSON: &str = include_str!("../../assets/catalog.json");
const MAPS_JSON: &str = include_str!("../../assets/maps.json");
const FONT_JSON: &str = include_str!("../../assets/font.json");
const WINDOWS_JSON: &str = include_str!("../../assets/windows.json");

/// A grey picture as stored in the files: base64 bytes, one a pixel.
#[derive(Debug, Clone, Deserialize)]
struct GrayB64 {
    w: usize,
    h: usize,
    gray: String,
}

impl GrayB64 {
    fn decode(&self) -> Vec<f32> {
        let bytes = base64_decode(&self.gray).expect("template base64");
        assert_eq!(bytes.len(), self.w * self.h, "template size");
        bytes.into_iter().map(f32::from).collect()
    }
}

/// A decoded grey template.
#[derive(Debug, Clone)]
pub struct Plane {
    pub w: usize,
    pub h: usize,
    pub d: Vec<f32>,
}

impl Plane {
    fn from(g: &GrayB64) -> Self {
        Self {
            w: g.w,
            h: g.h,
            d: g.decode(),
        }
    }

    pub fn prepared(&self) -> Prepared {
        prepare(&self.d, self.w, self.h)
    }
}

/// Canonical geometry of the offer line (atlas.json "canonical").
#[derive(Debug, Clone, Deserialize)]
pub struct Canonical {
    pub up: f64,
    pub digit_adv: f64,
    pub cell_h: f64,
    pub for_to_digit: f64,
    pub digit_to_mesos: f64,
    pub gap0: f64,
    pub comma_w: f64,
    pub qty_start: f64,
    pub layout_adv: f64,
    pub jitter_x: i64,
    pub jitter_y: i64,
    pub min_anchor: f64,
    pub max_residual: f64,
    pub min_residual_gap: f64,
    pub band_above: f64,
    pub band_below: f64,
    pub for_band_pad: f64,
    pub scale_min: f64,
    pub scale_max: f64,
    pub class_a_min_scale: f64,
    pub qty_min_score: f64,
    pub sold_text_luma: f64,
    pub normal_text_luma: Option<f64>,
    pub min_margin: Option<f64>,
    #[serde(default = "default_lock_scales")]
    pub lock_scales: Vec<f64>,
    #[serde(default)]
    pub pad_bottom: f64,
    #[serde(default = "default_row_w")]
    pub row_w: f64,
    #[serde(default = "default_row_scale_tol")]
    pub row_scale_tol: f64,
    #[serde(default = "default_for_step")]
    pub for_step: usize,
}

fn default_lock_scales() -> Vec<f64> {
    vec![1.0]
}
fn default_row_w() -> f64 {
    369.0
}
fn default_row_scale_tol() -> f64 {
    1.15
}
fn default_for_step() -> usize {
    2
}

/// Letter recognition parameters (atlas.json "letters").
#[derive(Debug, Clone, Deserialize)]
pub struct LetterParams {
    pub nk: f64,
    pub fh: usize,
    pub gw: usize,
    pub gh: usize,
    pub band_top: f64,
    pub band_bottom: f64,
    pub band_left: f64,
    pub band_right: Option<f64>,
    pub band_left_of_qty: Option<f64>,
    pub name_top: Option<f64>,
    pub min_contrast: f64,
    pub width_tol: f64,
    pub width_cost: f64,
    pub split_cost: f64,
    pub space: usize,
    pub min_mean_score: f64,
    pub ink_bg: Option<String>,
    #[serde(default)]
    pub ya_pick: i64,
    #[serde(default)]
    pub ya_search: i64,
}

#[derive(Debug, Clone, Deserialize)]
struct LetterRaw {
    #[serde(flatten)]
    gray: GrayB64,
    mean_w: f64,
    w_sd: f64,
    ch: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct SellerParams {
    pub dark_luma: Option<f64>,
    pub min_run: Option<f64>,
    pub min_mean_score: Option<f64>,
    pub split_min_w: Option<usize>,
    pub ink_thr: Option<f64>,
}

/// One letter template: ink = 1 (the atlas grey inverted), zero-mean.
#[derive(Debug, Clone)]
pub struct Letter {
    pub ch: String,
    pub w: f64,
    pub wsd: f64,
    pub t: Prepared,
}

#[derive(Debug, Clone)]
pub struct Atlas {
    pub version: String,
    pub canonical: Canonical,
    pub mesos: Plane,
    pub mesos_t: Prepared,
    pub for_t: Prepared,
    /// Digit templates per set: "A" for large captures, "B" for small ones.
    pub digits_a: Vec<Prepared>,
    pub digits_b: Vec<Prepared>,
    /// Digit pictures, for rendering test rows.
    pub digit_planes_a: Vec<Plane>,
    pub for_plane: Plane,
    pub letters: LetterParams,
    pub letter_glyphs: Vec<Letter>,
    pub seller: SellerParams,
    pub seller_glyphs: Vec<Letter>,
}

#[derive(Deserialize)]
struct AtlasRaw {
    version: String,
    canonical: Canonical,
    words: HashMap<String, GrayB64>,
    glyphs: HashMap<String, HashMap<String, GrayB64>>,
    letters: LettersRaw,
}

#[derive(Deserialize)]
struct LettersRaw {
    #[serde(flatten)]
    params: LetterParams,
    #[serde(deserialize_with = "ordered_map")]
    glyphs: Vec<(String, LetterRaw)>,
    seller: SellerRaw,
}

#[derive(Deserialize)]
struct SellerRaw {
    #[serde(flatten)]
    params: SellerParams,
    #[serde(deserialize_with = "ordered_map", default)]
    glyphs: Vec<(String, LetterRaw)>,
}

fn letters_of(raw: &[(String, LetterRaw)]) -> Vec<Letter> {
    raw.iter()
        .map(|(key, g)| {
            let d: Vec<f32> = g.gray.decode().into_iter().map(|v| 255.0 - v).collect();
            Letter {
                ch: g.ch.clone().unwrap_or_else(|| key.clone()),
                w: g.mean_w,
                wsd: g.w_sd,
                t: prepare(&d, g.gray.w, g.gray.h),
            }
        })
        .collect()
}

fn parse_atlas() -> Atlas {
    let raw: AtlasRaw = serde_json::from_str(ATLAS_JSON).expect("atlas.json");
    let word = |k: &str| Plane::from(raw.words.get(k).expect("atlas word"));
    let digit = |d: usize, set: &str| Plane::from(&raw.glyphs[&d.to_string()][set]);
    let mesos = word("mesos");
    let for_plane = word("for");
    let digit_planes_a: Vec<Plane> = (0..10).map(|d| digit(d, "A")).collect();
    Atlas {
        version: raw.version,
        canonical: raw.canonical,
        mesos_t: mesos.prepared(),
        for_t: for_plane.prepared(),
        mesos,
        digits_a: digit_planes_a.iter().map(Plane::prepared).collect(),
        digits_b: (0..10).map(|d| digit(d, "B").prepared()).collect(),
        digit_planes_a,
        for_plane,
        letter_glyphs: letters_of(&raw.letters.glyphs),
        letters: raw.letters.params,
        seller_glyphs: letters_of(&raw.letters.seller.glyphs),
        seller: raw.letters.seller.params,
    }
}

/// The shop's 1-bit pixel font (font.js): rows above the baseline, the
/// baseline, rows below; '#' is ink. Capital I and lowercase l share "l".
#[derive(Debug, Clone)]
pub struct Font {
    pub above: usize,
    pub below: usize,
    /// Glyphs in font.js order (splitting touching glyphs tries them so).
    pub glyphs: Vec<(String, Vec<String>)>,
    by_key: HashMap<String, String>,
}

impl Font {
    pub fn band(&self) -> usize {
        self.above + 1 + self.below
    }

    /// The glyph whose rows (joined by '/') are exactly `key`.
    pub fn lookup(&self, key: &str) -> Option<&str> {
        self.by_key.get(key).map(String::as_str)
    }

    pub fn glyph(&self, ch: &str) -> Option<&[String]> {
        self.glyphs
            .iter()
            .find(|(c, _)| c == ch)
            .map(|(_, r)| r.as_slice())
    }
}

#[derive(Deserialize)]
struct FontRaw {
    above: usize,
    below: usize,
    glyphs: Vec<(String, Vec<String>)>,
}

fn parse_font() -> Font {
    let raw: FontRaw = serde_json::from_str(FONT_JSON).expect("font.json");
    let by_key = raw
        .glyphs
        .iter()
        .map(|(c, rows)| (rows.join("/"), c.clone()))
        .collect();
    Font {
        above: raw.above,
        below: raw.below,
        glyphs: raw.glyphs,
        by_key,
    }
}

/// A shop window's header template (capture.js TPL), 640-space geometry,
/// stored at half size (320-space).
#[derive(Debug, Clone)]
pub struct WindowTemplate {
    pub full_w: f64,
    pub full_h: f64,
    /// Listing panel box in 640-space px: x0, y0, x1, y1.
    pub listing: [f64; 4],
    pub half: Plane,
}

#[derive(Deserialize)]
struct WindowRaw {
    #[serde(rename = "fullW")]
    full_w: f64,
    #[serde(rename = "fullH")]
    full_h: f64,
    w: usize,
    h: usize,
    lst: [f64; 4],
    b64: String,
}

impl WindowRaw {
    fn into_template(self) -> WindowTemplate {
        let bytes = base64_decode(&self.b64).expect("window template base64");
        assert_eq!(bytes.len(), self.w * self.h);
        WindowTemplate {
            full_w: self.full_w,
            full_h: self.full_h,
            listing: self.lst,
            half: Plane {
                w: self.w,
                h: self.h,
                d: bytes.into_iter().map(f32::from).collect(),
            },
        }
    }
}

#[derive(Debug, Clone)]
pub struct Windows {
    pub player: WindowTemplate,
    pub hired: WindowTemplate,
}

fn parse_windows() -> Windows {
    #[derive(Deserialize)]
    struct Raw {
        player: WindowRaw,
        hired: WindowRaw,
    }
    let raw: Raw = serde_json::from_str(WINDOWS_JSON).expect("windows.json");
    Windows {
        player: raw.player.into_template(),
        hired: raw.hired.into_template(),
    }
}

/// One catalog item: the game's item id and its English name.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CatalogItem {
    pub item_id: u32,
    pub name: String,
}

fn parse_catalog() -> Vec<CatalogItem> {
    #[derive(Deserialize)]
    struct Raw {
        items: Vec<(String, String, Option<String>)>,
    }
    let raw: Raw = serde_json::from_str(CATALOG_JSON).expect("catalog.json");
    raw.items
        .into_iter()
        .filter_map(|(id, name, _icon)| {
            // "basil:04010001" / "cash:05680001": the game's item id after the colon.
            let num = id.rsplit(':').next()?.parse::<u32>().ok()?;
            Some(CatalogItem { item_id: num, name })
        })
        .collect()
}

/// The minimap's letter features (maps.json "glyphs").
#[derive(Debug, Clone)]
pub struct MapGlyph {
    pub ch: char,
    pub w: f64,
    pub t: Prepared,
}

#[derive(Debug, Clone)]
pub struct MapsData {
    pub version: String,
    /// The "MINI MAP" header word.
    pub header: Plane,
    pub glyphs: Vec<MapGlyph>,
    pub names: Vec<String>,
}

fn parse_maps() -> MapsData {
    #[derive(Deserialize)]
    struct GlyphRaw {
        w: f64,
        f: Vec<f32>,
    }
    #[derive(Deserialize)]
    struct Raw {
        version: String,
        header: GrayB64,
        #[serde(deserialize_with = "ordered_map")]
        glyphs: Vec<(String, GlyphRaw)>,
        names: Vec<String>,
    }
    let raw: Raw = serde_json::from_str(MAPS_JSON).expect("maps.json");
    let glyphs = raw
        .glyphs
        .into_iter()
        .filter_map(|(k, g)| {
            let ch = k.chars().next()?;
            let n = g.f.len();
            Some(MapGlyph {
                ch,
                w: g.w,
                t: prepare(&g.f, n, 1),
            })
        })
        .collect();
    MapsData {
        version: raw.version,
        header: Plane::from(&raw.header),
        glyphs,
        names: raw.names,
    }
}

/// Everything the reader reads with.
pub struct Templates {
    pub atlas: Atlas,
    pub font: Font,
    pub windows: Windows,
    pub catalog: Vec<CatalogItem>,
    pub maps: MapsData,
}

/// The embedded templates, parsed on first use.
pub fn get() -> &'static Templates {
    static T: OnceLock<Templates> = OnceLock::new();
    T.get_or_init(|| Templates {
        atlas: parse_atlas(),
        font: parse_font(),
        windows: parse_windows(),
        catalog: parse_catalog(),
        maps: parse_maps(),
    })
}

/// A JSON object read as (key, value) pairs in document order.
fn ordered_map<'de, D, V>(d: D) -> Result<Vec<(String, V)>, D::Error>
where
    D: Deserializer<'de>,
    V: Deserialize<'de>,
{
    struct Ordered<V>(std::marker::PhantomData<V>);
    impl<'de, V: Deserialize<'de>> Visitor<'de> for Ordered<V> {
        type Value = Vec<(String, V)>;
        fn expecting(&self, f: &mut fmt::Formatter) -> fmt::Result {
            f.write_str("a JSON object")
        }
        fn visit_map<A: MapAccess<'de>>(self, mut m: A) -> Result<Self::Value, A::Error> {
            let mut out = Vec::new();
            while let Some(kv) = m.next_entry()? {
                out.push(kv);
            }
            Ok(out)
        }
    }
    d.deserialize_map(Ordered(std::marker::PhantomData))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn templates_parse() {
        let t = get();
        assert_eq!(t.atlas.version, "atlas-v1");
        assert_eq!((t.atlas.mesos.w, t.atlas.mesos.h), (216, 70));
        assert_eq!(t.atlas.digits_a.len(), 10);
        assert!(t.atlas.letter_glyphs.len() > 50);
        assert_eq!(t.font.band(), 13);
        assert_eq!(t.font.glyphs[0].0, "0");
        assert_eq!(
            t.font.lookup(&t.font.glyph("7").unwrap().join("/")),
            Some("7")
        );
        assert_eq!(
            (t.windows.player.half.w, t.windows.player.half.h),
            (123, 31)
        );
        let ore = t.catalog.iter().find(|i| i.name == "Iron Ore").unwrap();
        assert_eq!(ore.item_id, 4_010_001);
        assert!(t.catalog.len() > 2000);
        assert!(t.maps.names.iter().any(|n| n == "Free Market <4>"));
        assert_eq!((t.maps.header.w, t.maps.header.h), (64, 13));
    }
}

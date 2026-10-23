//! Screen reader: reads player-store windows from screen-share frames.
//!
//! The algorithms follow meso.watch's live reader (capture.js, reader.js,
//! font.js, snap.js, channelreader.js, mapreader.js), rewritten in Rust and
//! using its template data (see `assets/`). There is no OCR model: every
//! step is pixel template matching, and every step that does not fit
//! rejects instead of guessing.
//!
//! The same code runs natively (uploaded recordings) and as WASM in the
//! browser collector, so it does no IO and starts no threads.

pub mod channel;
pub mod font;
pub mod image;
pub mod map;
pub mod name;
pub mod pipeline;
pub mod row;
pub mod session;
pub mod templates;
pub mod window;

pub use pipeline::{read_frame, FrameRead, ReadRow, RejectedRow};
pub use session::{Session, ShopSnapshot, Step};

/// Version reported with every observation: the reader code and the atlas
/// it reads with.
pub fn reader_version() -> String {
    format!(
        "cwm-reader-{}-channels-v2+{}",
        env!("CARGO_PKG_VERSION"),
        templates::get().atlas.version
    )
}

/// A borrowed RGBA frame: row-major, 4 bytes a pixel, alpha ignored.
#[derive(Debug, Clone, Copy)]
pub struct Rgba<'a> {
    pub data: &'a [u8],
    pub width: usize,
    pub height: usize,
}

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum FrameError {
    #[error("frame size {width}x{height} is empty or too large")]
    BadSize { width: usize, height: usize },
    #[error("frame buffer holds {got} bytes, {width}x{height} RGBA needs {want}")]
    BadLength {
        width: usize,
        height: usize,
        got: usize,
        want: usize,
    },
}

/// Largest frame side accepted (an 8K share); larger frames are refused.
pub const MAX_SIDE: usize = 8192;

impl<'a> Rgba<'a> {
    pub fn new(data: &'a [u8], width: usize, height: usize) -> Result<Self, FrameError> {
        if width == 0 || height == 0 || width > MAX_SIDE || height > MAX_SIDE {
            return Err(FrameError::BadSize { width, height });
        }
        let want = width * height * 4;
        if data.len() != want {
            return Err(FrameError::BadLength {
                width,
                height,
                got: data.len(),
                want,
            });
        }
        Ok(Self {
            data,
            width,
            height,
        })
    }

    #[inline]
    pub fn rgb(&self, x: usize, y: usize) -> (u8, u8, u8) {
        let i = (y * self.width + x) * 4;
        (self.data[i], self.data[i + 1], self.data[i + 2])
    }

    /// BT.601 luma (the reader's default grey).
    #[inline]
    pub fn luma(&self, x: usize, y: usize) -> f64 {
        let (r, g, b) = self.rgb(x, y);
        image::luma601(r, g, b)
    }

    /// Copy of a box (already clamped to the frame).
    pub fn cut(&self, b: [usize; 4]) -> RgbaBuf {
        let (w, h) = (b[2] - b[0], b[3] - b[1]);
        let mut out = Vec::with_capacity(w * h * 4);
        for y in b[1]..b[3] {
            let s = (y * self.width + b[0]) * 4;
            out.extend_from_slice(&self.data[s..s + w * 4]);
        }
        RgbaBuf {
            data: out,
            width: w,
            height: h,
        }
    }
}

/// An owned RGBA picture (a cut row, an un-stretched row).
#[derive(Debug, Clone, PartialEq)]
pub struct RgbaBuf {
    pub data: Vec<u8>,
    pub width: usize,
    pub height: usize,
}

impl RgbaBuf {
    pub fn filled(width: usize, height: usize, rgb: [u8; 3]) -> Self {
        let mut data = Vec::with_capacity(width * height * 4);
        for _ in 0..width * height {
            data.extend_from_slice(&[rgb[0], rgb[1], rgb[2], 255]);
        }
        Self {
            data,
            width,
            height,
        }
    }

    pub fn view(&self) -> Rgba<'_> {
        Rgba {
            data: &self.data,
            width: self.width,
            height: self.height,
        }
    }

    #[inline]
    pub fn set(&mut self, x: usize, y: usize, rgb: [u8; 3]) {
        let i = (y * self.width + x) * 4;
        self.data[i..i + 3].copy_from_slice(&rgb);
        self.data[i + 3] = 255;
    }
}

/// `Math.round` of JavaScript: halves round up, also for negative numbers.
#[inline]
pub(crate) fn js_round(v: f64) -> f64 {
    (v + 0.5).floor()
}

/// A box rounded and clamped to a `w` x `h` picture; `None` when empty.
pub(crate) fn clamp_box(b: [f64; 4], w: usize, h: usize) -> Option<[usize; 4]> {
    let x0 = js_round(b[0]).max(0.0);
    let y0 = js_round(b[1]).max(0.0);
    let x1 = js_round(b[2]).min(w as f64);
    let y1 = js_round(b[3]).min(h as f64);
    (x1 > x0 && y1 > y0).then_some([x0 as usize, y0 as usize, x1 as usize, y1 as usize])
}

/// Rounds to `places` decimals (for reported scores, not for decisions).
pub(crate) fn round_to(v: f64, places: i32) -> f64 {
    let f = 10f64.powi(places);
    js_round(v * f) / f
}

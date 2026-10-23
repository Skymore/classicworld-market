//! The screen reader in the browser. The JSON layer below is plain Rust (and
//! tested natively); the `wasm` module only wraps it for JavaScript.
//!
//! Exports (wasm32): `version()`, `read_frame(rgba, width, height,
//! prev_scale)`, `find_window(rgba, width, height, prev_scale)`, and the
//! `Reader` class (a session: `push(rgba, width, height, ts_ms)`).

use std::cell::RefCell;

use market_core::reader::pipeline::{self, ReaderCache};
use market_core::reader::window::{frame_cues, FrameCues, ShopWindow};
use market_core::reader::{reader_version, Rgba, Session, Step};
use serde::Serialize;

pub fn version() -> String {
    reader_version()
}

fn frame<'a>(rgba: &'a [u8], width: u32, height: u32) -> Result<Rgba<'a>, String> {
    Rgba::new(rgba, width as usize, height as usize).map_err(|e| e.to_string())
}

fn to_json(v: &impl Serialize) -> Result<String, String> {
    serde_json::to_string(v).map_err(|e| e.to_string())
}

/// One frame read with no state from earlier frames.
pub fn read_frame_json(
    rgba: &[u8],
    width: u32,
    height: u32,
    prev_scale: Option<f32>,
) -> Result<String, String> {
    let img = frame(rgba, width, height)?;
    to_json(&pipeline::read_frame(&img, prev_scale.map(f64::from)))
}

#[derive(Serialize)]
struct Found {
    cues: FrameCues,
    window: Option<ShopWindow>,
}

thread_local! {
    // The browser is single-threaded here: one cache of scaled templates.
    static CACHE: RefCell<ReaderCache> = RefCell::new(ReaderCache::default());
}

/// The shop window alone (cheap; the page's main thread calls it 8 times a second).
pub fn find_window_json(
    rgba: &[u8],
    width: u32,
    height: u32,
    prev_scale: Option<f32>,
) -> Result<String, String> {
    let img = frame(rgba, width, height)?;
    let cues = frame_cues(&img);
    let window =
        CACHE.with(|c| pipeline::find_window(&img, prev_scale.map(f64::from), &mut c.borrow_mut()));
    to_json(&Found { cues, window })
}

/// A reading session (see `market_core::reader::session`).
#[derive(Default)]
pub struct ReaderSession {
    session: Session,
}

impl ReaderSession {
    pub fn push(
        &mut self,
        rgba: &[u8],
        width: u32,
        height: u32,
        ts_ms: f64,
    ) -> Result<Step, String> {
        let img = frame(rgba, width, height)?;
        Ok(self.session.push(&img, ts_ms))
    }

    pub fn push_json(
        &mut self,
        rgba: &[u8],
        width: u32,
        height: u32,
        ts_ms: f64,
    ) -> Result<String, String> {
        to_json(&self.push(rgba, width, height, ts_ms)?)
    }
}

#[cfg(target_arch = "wasm32")]
mod wasm {
    use wasm_bindgen::prelude::*;

    fn parse(r: Result<String, String>) -> Result<JsValue, JsValue> {
        let s = r.map_err(|e| JsValue::from_str(&e))?;
        js_sys::JSON::parse(&s)
    }

    #[wasm_bindgen]
    pub fn version() -> String {
        super::version()
    }

    /// JSON of the pipeline output: rows, rejected rows, title hash, seller, channel, map.
    #[wasm_bindgen]
    pub fn read_frame(
        rgba: &[u8],
        width: u32,
        height: u32,
        prev_scale: Option<f32>,
    ) -> Result<JsValue, JsValue> {
        parse(super::read_frame_json(rgba, width, height, prev_scale))
    }

    #[wasm_bindgen]
    pub fn find_window(
        rgba: &[u8],
        width: u32,
        height: u32,
        prev_scale: Option<f32>,
    ) -> Result<JsValue, JsValue> {
        parse(super::find_window_json(rgba, width, height, prev_scale))
    }

    #[wasm_bindgen]
    pub struct Reader(super::ReaderSession);

    #[wasm_bindgen]
    impl Reader {
        #[wasm_bindgen(constructor)]
        pub fn new() -> Reader {
            Reader(super::ReaderSession::default())
        }

        /// One frame taken at `ts_ms`: the frame read, the session status, shops ready to upload.
        pub fn push(
            &mut self,
            rgba: &[u8],
            width: u32,
            height: u32,
            ts_ms: f64,
        ) -> Result<JsValue, JsValue> {
            parse(self.0.push_json(rgba, width, height, ts_ms))
        }
    }

    impl Default for Reader {
        fn default() -> Self {
            Self::new()
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn version_names_reader_and_atlas() {
        assert!(version().starts_with("cwm-reader-"));
        assert!(version().ends_with("+atlas-v1"));
    }

    #[test]
    fn bad_buffers_are_errors() {
        assert!(read_frame_json(&[0; 10], 2, 2, None)
            .unwrap_err()
            .contains("needs 16"));
        assert!(read_frame_json(&[], 0, 0, None).is_err());
    }

    #[test]
    fn a_black_frame_reads_to_json() {
        let px = vec![0u8; 64 * 48 * 4];
        let v: serde_json::Value =
            serde_json::from_str(&read_frame_json(&px, 64, 48, Some(1.0)).unwrap()).unwrap();
        assert_eq!(v["game_seen"], false);
        assert_eq!(v["rows"].as_array().map(Vec::len), Some(0));
        let w: serde_json::Value =
            serde_json::from_str(&find_window_json(&px, 64, 48, None).unwrap()).unwrap();
        assert!(w["window"].is_null());
        let mut s = ReaderSession::default();
        let step: serde_json::Value =
            serde_json::from_str(&s.push_json(&px, 64, 48, 0.0).unwrap()).unwrap();
        assert_eq!(step["snapshots"].as_array().map(Vec::len), Some(0));
    }
}

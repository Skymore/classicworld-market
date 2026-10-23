//! A reading session over a stream of frames: the shop's rows merged as the
//! list scrolls, submitted once they were stable for 2 s; the channel and
//! map carried between the frames that show them (channelreader.js and
//! mapreader.js watchers). The browser worker and a recording replay both
//! run this, so they submit the same snapshots.

use serde::Serialize;
use serde_json::{json, Value};

use super::image::luma601;
use super::map::MapRead;
use super::pipeline::{read_frame_with, FrameOptions, FrameRead, ReadRow, ReaderCache};
use super::window::Hint;
use super::Rgba;

#[derive(Debug, Clone, Copy)]
pub struct SessionConfig {
    /// A shop is submitted once its rows did not change for this long.
    pub stable_ms: f64,
    /// The minimap is read at most this often.
    pub map_every_ms: f64,
    /// A map is shown after this many equal reads.
    pub map_confirm: u32,
    /// A shop window gone this long ends the visit.
    pub visit_gap_ms: f64,
    /// A channel pick followed by a black screen within this is a channel change.
    pub pick_ms: f64,
    /// A black screen this soon after the menu was open may be a channel change.
    pub swap_ms: f64,
    /// Scene likeness after a black screen that counts as the same place.
    pub same_place: f64,
}

impl Default for SessionConfig {
    fn default() -> Self {
        Self {
            stable_ms: 2000.0,
            map_every_ms: 1000.0,
            map_confirm: 3,
            visit_gap_ms: 3000.0,
            pick_ms: 2500.0,
            swap_ms: 4000.0,
            same_place: 0.3,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct ListRow {
    pub item_id: u32,
    pub name: String,
    pub price: u64,
    pub bundle: u32,
    pub sold: bool,
    pub confidence: f64,
}

impl ListRow {
    fn of(r: &ReadRow) -> Self {
        Self {
            item_id: r.item_id,
            name: r.name.clone(),
            price: r.price,
            bundle: r.bundle,
            sold: r.sold,
            confidence: r.confidence,
        }
    }

    fn key(&self) -> (u32, u64, u32) {
        (self.item_id, self.price, self.bundle)
    }
}

struct Visit {
    shop_id: u32,
    seller: Option<String>,
    list: Vec<ListRow>,
    /// List place of the top band in the last clean frame.
    offset: i64,
    changed_at: f64,
    last_seen: f64,
    end_seen: bool,
    sent: Option<u64>,
}

/// A shop ready to upload.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct ShopSnapshot {
    pub shop_id: u32,
    pub title: String,
    pub seller: Option<String>,
    pub channel: Option<u8>,
    pub room: Option<u8>,
    pub map: Option<String>,
    pub observed_at_ms: f64,
    pub observation_id: String,
    pub rows: Vec<ListRow>,
    /// The body for POST /api/v1/upload (schema v1, source "screen").
    pub upload: Value,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Status {
    pub channel: Option<u8>,
    pub map: Option<String>,
    pub room: Option<u8>,
    pub shop_id: Option<u32>,
    pub list: Vec<ListRow>,
    pub end_seen: bool,
    /// How long the shop's rows have not changed.
    pub stable_ms: f64,
    /// Why the shop is not submitted yet.
    pub waiting: Option<&'static str>,
    pub ui_scale: Option<f64>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Step {
    pub frame: FrameRead,
    pub status: Status,
    pub snapshots: Vec<ShopSnapshot>,
}

pub struct Session {
    cfg: SessionConfig,
    cache: ReaderCache,
    lock: Option<f64>,
    hint: Option<Hint>,
    misses: u32,
    channel: Option<u8>,
    pending: Option<(u8, f64)>,
    menu_at: f64,
    in_black: bool,
    black: Option<(Vec<f32>, bool)>,
    last_scene: Option<Vec<f32>>,
    map_shown: Option<MapRead>,
    map_cand: Option<(MapRead, u32)>,
    map_at: f64,
    visit: Option<Visit>,
}

impl Default for Session {
    fn default() -> Self {
        Self::new(SessionConfig::default())
    }
}

/// Channels the upload schema takes.
const MAX_UPLOAD_CHANNEL: u8 = crate::protocol::MAX_CHANNEL as u8;

impl Session {
    pub fn new(cfg: SessionConfig) -> Self {
        Self {
            cfg,
            cache: ReaderCache::default(),
            lock: None,
            hint: None,
            misses: 0,
            channel: None,
            pending: None,
            menu_at: f64::NEG_INFINITY,
            in_black: false,
            black: None,
            last_scene: None,
            map_shown: None,
            map_cand: None,
            map_at: f64::NEG_INFINITY,
            visit: None,
        }
    }

    /// Reads one frame taken at `ts_ms` (milliseconds, any epoch).
    pub fn push(&mut self, frame: &Rgba, ts_ms: f64) -> Step {
        let skip_map = ts_ms - self.map_at < self.cfg.map_every_ms;
        if !skip_map {
            self.map_at = ts_ms;
        }
        let opts = FrameOptions {
            lock_scale: self.lock,
            hint: self.hint,
            skip_map,
        };
        let fr = read_frame_with(frame, &opts, &mut self.cache);
        self.track_scale(&fr);
        self.track_channel(frame, &fr, ts_ms);
        self.track_map(&fr, skip_map);
        let (waiting, snapshots) = self.track_visit(&fr, ts_ms);
        let (map, room) = self.place();
        let status = Status {
            channel: self.channel,
            map,
            room,
            shop_id: self.visit.as_ref().map(|v| v.shop_id),
            list: self
                .visit
                .as_ref()
                .map(|v| v.list.clone())
                .unwrap_or_default(),
            end_seen: self.visit.as_ref().is_some_and(|v| v.end_seen),
            stable_ms: self.visit.as_ref().map_or(0.0, |v| ts_ms - v.changed_at),
            waiting,
            ui_scale: self.lock,
        };
        Step {
            frame: fr,
            status,
            snapshots,
        }
    }

    fn track_scale(&mut self, fr: &FrameRead) {
        match &fr.window {
            Some(w) => {
                self.hint = Some(w.hint);
                self.misses = 0;
                if w.bands >= 3 {
                    self.lock = Some(w.ui_scale);
                }
            }
            None => {
                self.hint = None;
                // The player may have changed the UI scale: search all scales again.
                self.misses += 1;
                if self.misses >= 12 {
                    self.lock = None;
                }
            }
        }
    }

    fn track_channel(&mut self, frame: &Rgba, fr: &FrameRead, ts: f64) {
        if !fr.game_seen {
            // Decided once, on the first black frame: a pick just before it was a channel change.
            if !self.in_black {
                self.in_black = true;
                match self.pending {
                    Some((picked, at)) if ts - at <= self.cfg.pick_ms => {
                        self.channel = Some(picked)
                    }
                    _ => {
                        if self.channel.is_some() {
                            if let Some(before) = self.last_scene.take() {
                                self.black = Some((before, ts - self.menu_at <= self.cfg.swap_ms));
                            }
                        }
                    }
                }
                // A black screen is a map (or channel) change.
                self.map_shown = None;
                self.map_cand = None;
            }
            self.pending = None;
            self.hint = None;
            return;
        }
        self.in_black = false;
        let now = scene(frame);
        // Back to the same place with no pick read: likely another channel.
        if let Some((before, menu)) = self.black.take() {
            if menu || alike(&before, &now) >= self.cfg.same_place {
                self.channel = None;
            }
        }
        self.last_scene = Some(now);
        if self
            .pending
            .is_some_and(|(_, at)| ts - at > self.cfg.pick_ms)
        {
            self.pending = None;
        }
        if let Some(c) = fr.channel {
            self.channel = Some(c.channel);
            self.menu_at = ts;
            self.pending = c.picked.filter(|&p| p != c.channel).map(|p| (p, ts));
        }
    }

    fn track_map(&mut self, fr: &FrameRead, skipped: bool) {
        if skipped {
            return;
        }
        let Some(m) = &fr.map else { return };
        let n = match &self.map_cand {
            Some((c, n)) if c.name == m.name => n + 1,
            _ => 1,
        };
        self.map_cand = Some((m.clone(), n));
        if n >= self.cfg.map_confirm {
            self.map_shown = Some(m.clone());
        }
    }

    /// The confirmed map, and its Free Market room (1-22) if it is one.
    fn place(&self) -> (Option<String>, Option<u8>) {
        let Some(m) = &self.map_shown else {
            return (None, None);
        };
        let fm = m.name.starts_with("Free Market <");
        (
            Some(m.name.clone()),
            m.room.filter(|r| fm && (1..=22).contains(r)),
        )
    }

    fn track_visit(
        &mut self,
        fr: &FrameRead,
        ts: f64,
    ) -> (Option<&'static str>, Vec<ShopSnapshot>) {
        let (Some(w), Some(shop_id)) = (&fr.window, fr.title_hash) else {
            if self
                .visit
                .as_ref()
                .is_some_and(|v| ts - v.last_seen > self.cfg.visit_gap_ms)
            {
                self.visit = None;
            }
            return (None, Vec::new());
        };
        if self.visit.as_ref().is_none_or(|v| v.shop_id != shop_id) {
            self.visit = Some(Visit {
                shop_id,
                seller: None,
                list: Vec::new(),
                offset: 0,
                changed_at: ts,
                last_seen: ts,
                end_seen: false,
                sent: None,
            });
        }
        let channel = self
            .channel
            .filter(|&c| (1..=MAX_UPLOAD_CHANNEL).contains(&c));
        let (map, room) = self.place();
        let v = self.visit.as_mut().expect("visit just set");
        v.last_seen = ts;
        if fr.seller.is_some() {
            v.seller = fr.seller.clone();
        }
        // Clean: every band that holds a row was read, top to bottom.
        let contiguous = fr
            .rows
            .iter()
            .enumerate()
            .all(|(i, r)| r.slot as usize == i + 1);
        if !fr.rejected.is_empty() || fr.rows.is_empty() || !contiguous {
            v.changed_at = ts;
            return (Some("a row is covered or not read"), Vec::new());
        }
        let visible: Vec<ListRow> = fr.rows.iter().map(ListRow::of).collect();
        if align(&mut v.list, &mut v.offset, &visible) {
            v.changed_at = ts;
        }
        if !w.full {
            v.end_seen = true;
        }
        if !v.end_seen {
            return (
                Some("the list fills the window: its end is not seen"),
                Vec::new(),
            );
        }
        if ts - v.changed_at < self.cfg.stable_ms {
            return (
                Some("waiting for the rows to stay the same for 2 s"),
                Vec::new(),
            );
        }
        if v.list.len() > 200 {
            return (Some("more than 200 rows"), Vec::new());
        }
        let sig = signature(&v.list, channel, room, v.seller.as_deref());
        if v.sent == Some(sig) {
            return (None, Vec::new());
        }
        v.sent = Some(sig);
        let snap = snapshot(v, fr, ts, sig, channel, room, map);
        (None, vec![snap])
    }
}

/// Places the visible rows (top band first) in the visit's list: the list
/// scrolls by whole rows, so all of them go at one offset where every
/// overlapping row is the same (by item, price and bundle; the sold mark may
/// change). No offset fits: the list starts again. Returns whether it changed.
fn align(list: &mut Vec<ListRow>, offset: &mut i64, visible: &[ListRow]) -> bool {
    if list.is_empty() {
        *list = visible.to_vec();
        *offset = 0;
        return true;
    }
    let (n, m) = (list.len() as i64, visible.len() as i64);
    // (offset, overlap) of every offset where all overlapping rows agree.
    let fits: Vec<(i64, i64)> = (-(m - 1)..n)
        .filter_map(|o| {
            let over: Vec<i64> = (0..m).filter(|i| (0..n).contains(&(o + i))).collect();
            let same = over
                .iter()
                .all(|&i| list[(o + i) as usize].key() == visible[i as usize].key());
            (same && !over.is_empty()).then_some((o, over.len() as i64))
        })
        .collect();
    // The last offset if it still fits, else the largest overlap, nearest the last offset.
    let best = fits
        .iter()
        .copied()
        .min_by_key(|&(o, over)| (o != *offset, -over, (o - *offset).abs()));
    let Some((mut o, _)) = best else {
        *list = visible.to_vec();
        *offset = 0;
        return true;
    };
    let mut changed = false;
    if o < 0 {
        let k = (-o) as usize;
        list.splice(0..0, visible[..k].iter().cloned());
        o = 0;
        changed = true;
        for (i, row) in visible.iter().enumerate().skip(k) {
            let j = i - k;
            if list[j].sold != row.sold {
                list[j] = row.clone();
            }
        }
    } else {
        for (i, row) in visible.iter().enumerate() {
            let j = o as usize + i;
            if j < list.len() {
                if list[j].sold != row.sold {
                    list[j] = row.clone();
                    changed = true;
                }
            } else {
                list.push(row.clone());
                changed = true;
            }
        }
    }
    *offset = o;
    changed
}

fn fnv(bytes: impl IntoIterator<Item = u8>) -> u64 {
    let mut h: u64 = 0xcbf2_9ce4_8422_2325;
    for b in bytes {
        h ^= b as u64;
        h = h.wrapping_mul(0x0000_0100_0000_01b3);
    }
    h
}

fn signature(list: &[ListRow], channel: Option<u8>, room: Option<u8>, seller: Option<&str>) -> u64 {
    let mut s = String::new();
    for r in list {
        s.push_str(&format!(
            "{}|{}|{}|{};",
            r.item_id,
            r.price,
            r.bundle,
            u8::from(r.sold)
        ));
    }
    s.push_str(&format!("{channel:?}|{room:?}|{seller:?}"));
    fnv(s.into_bytes())
}

fn snapshot(
    v: &Visit,
    fr: &FrameRead,
    ts: f64,
    sig: u64,
    channel: Option<u8>,
    room: Option<u8>,
    map: Option<String>,
) -> ShopSnapshot {
    // The schema needs a title; the screen gives the seller's name when it reads exactly.
    let title = v
        .seller
        .clone()
        .unwrap_or_else(|| format!("screen-{:08x}", v.shop_id));
    let observation_id = format!(
        "scr-{:08x}-{:x}-{:08x}",
        v.shop_id,
        ts.max(0.0) as u64,
        sig as u32
    );
    let location = match (channel, room) {
        (Some(c), Some(r)) => json!({ "channel": c, "room": r }),
        _ => Value::Null,
    };
    // Stock: 0 for a sold row; the screen does not show it otherwise, so 1 (at least one bundle).
    let items: Vec<Value> = v
        .list
        .iter()
        .enumerate()
        .map(|(i, r)| {
            json!({
                "slot": i + 1,
                "item_id": r.item_id,
                "category": r.item_id / 1_000_000,
                "price": r.price,
                "bundle": r.bundle,
                "stock": if r.sold { 0 } else { 1 },
            })
        })
        .collect();
    let upload = json!({
        "version": 1,
        "source": "screen",
        "reader_version": fr.reader,
        "observation_id": observation_id,
        "observed_at": ts / 1000.0,
        "world": "ClassicWorld",
        "shop_id": v.shop_id,
        "title": title,
        "location": location,
        "items": items,
        "complete": true,
    });
    ShopSnapshot {
        shop_id: v.shop_id,
        title,
        seller: v.seller.clone(),
        channel,
        room,
        map,
        observed_at_ms: ts,
        observation_id,
        rows: v.list.clone(),
        upload,
    }
}

/// A small grey picture of the scene (96 x 44, the game area without the
/// status bar), mean-subtracted.
fn scene(img: &Rgba) -> Vec<f32> {
    let (w, h) = (img.width as f64, img.height as f64);
    let (x0, gw, y0, gh) = (w * 0.01, w * 0.98, h * 0.06, h * 0.93);
    let mut out = Vec::with_capacity(96 * 44);
    for y in 0..44 {
        for x in 0..96 {
            let py = ((y0 + (y as f64 + 0.5) * gh / 54.0) as usize).min(img.height - 1);
            let px = ((x0 + (x as f64 + 0.5) * gw / 96.0) as usize).min(img.width - 1);
            let (r, g, b) = img.rgb(px, py);
            out.push(luma601(r, g, b) as f32);
        }
    }
    let m = out.iter().map(|&v| v as f64).sum::<f64>() / out.len() as f64;
    out.iter_mut().for_each(|v| *v -= m as f32);
    out
}

fn alike(a: &[f32], b: &[f32]) -> f64 {
    let (mut s, mut sa, mut sb) = (0f64, 0f64, 0f64);
    for (x, y) in a.iter().zip(b) {
        let (x, y) = (*x as f64, *y as f64);
        s += x * y;
        sa += x * x;
        sb += y * y;
    }
    if sa > 0.0 && sb > 0.0 {
        s / (sa * sb).sqrt()
    } else {
        0.0
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn row(id: u32, price: u64, sold: bool) -> ListRow {
        ListRow {
            item_id: id,
            name: String::new(),
            price,
            bundle: 1,
            sold,
            confidence: 1.0,
        }
    }

    #[test]
    fn scrolled_lists_merge() {
        let mut list = Vec::new();
        let mut off = 0;
        let a: Vec<ListRow> = (1..=6).map(|i| row(i, 10, false)).collect();
        assert!(align(&mut list, &mut off, &a));
        assert!(!align(&mut list, &mut off, &a));
        // Scrolled down by two rows.
        let b: Vec<ListRow> = (3..=8).map(|i| row(i, 10, false)).collect();
        assert!(align(&mut list, &mut off, &b));
        assert_eq!(
            list.iter().map(|r| r.item_id).collect::<Vec<_>>(),
            (1..=8).collect::<Vec<_>>()
        );
        assert_eq!(off, 2);
        // A row turned sold in place.
        let mut c = b.clone();
        c[0].sold = true;
        assert!(align(&mut list, &mut off, &c));
        assert!(list[2].sold);
        // Rows that fit nowhere start the list again.
        let d: Vec<ListRow> = (20..=22).map(|i| row(i, 10, false)).collect();
        assert!(align(&mut list, &mut off, &d));
        assert_eq!(list.len(), 3);
    }

    #[test]
    fn scrolling_up_prepends() {
        let mut list: Vec<ListRow> = (3..=8).map(|i| row(i, 10, false)).collect();
        let mut off = 0;
        let up: Vec<ListRow> = (1..=6).map(|i| row(i, 10, false)).collect();
        assert!(align(&mut list, &mut off, &up));
        assert_eq!(
            list.iter().map(|r| r.item_id).collect::<Vec<_>>(),
            (1..=8).collect::<Vec<_>>()
        );
    }
}

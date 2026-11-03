/* MesoWatch live reader (beta, FEATURES.liveReader): learned glyphs for a UI scale that is not a whole number.
   At a whole-number scale the shop's pixel font reads exactly (font.js, reader.js readExact). A player in fullscreen
   1920x1080 sees the 1366x768 game stretched x1.406 (2560x1440: x1.875), so each game pixel is 1 or 2 screen pixels
   and the font's bitmaps never match. This file learns the font AT THE PLAYER'S SCALE from the player's own rows:
   - cutName / cutSeller (in the worker, called by reader.js): cut a row's name line (or the seller's tag) into glyph
     runs at blank columns, binarize each at a fixed threshold between the palette's paper and ink, and sample it back
     onto the game pixel grid (see "The game grid" below). The result is one "key" per glyph run (its
     bitmap in game pixels, rows joined with "/") and the gaps between runs in game pixels. No picture is kept.
   - teach (on the page, live.js): when the old matcher's name snapped to the catalog with a high score and the price
     read cleanly, the catalog name labels the runs, one letter per run. A row whose run count or spacing does not fit
     the name (touching letters, a merged run, a misread) teaches nothing.
   - read: each key looked up in the table of this scale; a key counts once NEED rows agreed on its letter (and no
     more than a quarter as many said another). A key the table does not know yet is read with font.js when it is
     exactly a font glyph on the game grid (the worker adds that letter to the cut: measured on a compressed 1080p
     recording, 96% of the glyphs are). live.js accepts a name only when every glyph was found AND the name snaps
     exactly to the catalog (snap.js snapExact); any miss falls back to the old matcher.
   The game grid: the stretch (sharp or smooth, x1.33-1.88 tested) is undone by fitting the grid's pitch and offsets
   to where the ink starts and stops, then reading the screen at each game pixel's centre (sharpened for a smooth one).
   The table lives in localStorage per scale (rounded to 0.01; a nearby scale reuses the same table), capped in size;
   every access is wrapped, so a private window just learns again. Seller tags use the same font (font.js), so their
   glyphs are read from the same table. */
(function (root) {
  'use strict';
  const ABOVE = 9, BELOW = 3;                 // font.js: rows above the baseline and below it
  const ROW_GAME_W = 262;                     // a shop row box in game px
  const PAL = { unsold: { paper: 215, ink: 0 }, sold: { paper: 244, ink: 187 } };   // reader.js EX (luma)
  const PAPER_TOL = 14;
  const SHARPEN = 0.7;   // the smooth stretch's sharpening (cutLine); 0.4-1 read the same on drawn and recorded rows
  const NEED = 3;                             // rows that must agree before a glyph is used
  const MAX_KEYS = 1500, MAX_SCALES = 4, SCALE_TOL = 0.012;
  const STORE = 'mesowatch.liveReader.glyphs.v1';
  // the letters most names use: once all of them read at this scale, live.js drops its "play at 1366x768" nudge
  const COMMON = 'abcdeghilmnoprstuwyABCDEGHLMPRST';

  const lumaAt = (d, i) => 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
  function toLuma(img) {
    const n = img.width * img.height, g = new Float32Array(n), d = img.data;
    for (let i = 0; i < n; i++) g[i] = lumaAt(d, i * 4);
    return g;
  }
  // The screen's luma at a point between pixels (a smooth stretch is read at each game pixel's centre).
  function bilinear(g, W, H, x, y) {
    const x0 = Math.max(0, Math.min(W - 1, Math.floor(x))), y0 = Math.max(0, Math.min(H - 1, Math.floor(y)));
    const x1 = Math.min(W - 1, x0 + 1), y1 = Math.min(H - 1, y0 + 1), fx = Math.max(0, Math.min(1, x - x0)), fy = Math.max(0, Math.min(1, y - y0));
    return (g[y0 * W + x0] * (1 - fx) + g[y0 * W + x1] * fx) * (1 - fy) + (g[y1 * W + x0] * (1 - fx) + g[y1 * W + x1] * fx) * fy;
  }
  function lerp(g, W, x, y) { const x0 = Math.max(0, Math.min(W - 2, Math.floor(x))), f = Math.max(0, Math.min(1, x - x0)); return g[y * W + x0] * (1 - f) + g[y * W + x0 + 1] * f; }
  function lerpY(g, W, H, x, y) { const y0 = Math.max(0, Math.min(H - 2, Math.floor(y))), f = Math.max(0, Math.min(1, y - y0)); return g[y0 * W + x] * (1 - f) + g[(y0 + 1) * W + x] * f; }

  // One text line in the window [x0, x1) x [y0, y1) of luma g: glyph runs as keys on the game pixel grid, and the gaps.
  // ink(v): is luma v ink. k: screen px per game px (about). fitWin: where the game pixel grid is fitted (default win).
  // tol: how far the pitch may be from k (a row's width gives k to 0.6%, a seller tag's to 1.5%).
  // Null when no line of text fits.
  function cutLine(g, W, H, win, ink, k, fitWin, tol = 0.006) {
    const x0 = Math.max(0, Math.round(win[0])), x1 = Math.min(W, Math.round(win[2])), y0 = Math.max(0, Math.round(win[1])), y1 = Math.min(H, Math.round(win[3]));
    if (x1 - x0 < 6 * k || y1 - y0 < 5 * k) return null;
    const on = (x, y) => ink(g[y * W + x]);
    // the line's rows: the cluster of inked rows (gaps of 1 px closed) with the most ink
    const rp = []; for (let y = y0; y < y1; y++) { let n = 0; for (let x = x0; x < x1; x++) if (on(x, y)) n++; rp.push(n); }
    let best = null, cur = null;
    for (let i = 0; i <= rp.length; i++) {
      if (i < rp.length && rp[i] > 0) { if (!cur) cur = { a: i, b: i, n: 0 }; cur.b = i; cur.n += rp[i]; }
      else if (cur && (i >= rp.length || !(rp[i + 1] > 0))) { if (!best || cur.n > best.n) best = cur; cur = null; }
    }
    if (!best) return null;
    const ya = y0 + best.a, yb = y0 + best.b;
    if (yb - ya + 1 < 4 * k || yb - ya + 1 > (ABOVE + BELOW + 1) * k + 3) return null;
    // glyph runs at blank columns; the name ends at a gap of 12 game px
    const cols = []; for (let x = x0; x < x1; x++) { let n = 0; for (let y = ya; y <= yb; y++) if (on(x, y)) n++; cols.push(n); }
    const runs = []; let st = -1;
    for (let i = 0; i <= cols.length; i++) {
      const o = i < cols.length && cols[i] > 0;
      if (o && st < 0) st = i;
      if (!o && st >= 0) {
        if (runs.length && x0 + st - runs[runs.length - 1].b - 1 > 12 * k) break;
        runs.push({ a: x0 + st, b: x0 + i - 1 }); st = -1;
      }
    }
    if (!runs.length || runs.length > 40) return null;
    // The game pixel grid: screen px x shows game px floor((x + c) / k), so every place where ink starts or stops (in a
    // row, or in a column) is the first pixel of a game pixel's block. k (near the caller's) and the offsets cx, cy are
    // the ones most of those places agree with.
    // The places come from the whole fit window (both lines of the row's text box, or the seller's tag), so the fit
    // spans up to 160 game px and k is right to a few in a thousand.
    const fw = fitWin || win, fx0 = Math.max(1, Math.round(fw[0])), fx1 = Math.min(W, Math.round(fw[2])), fy0 = Math.max(1, Math.round(fw[1])), fy1 = Math.min(H, Math.round(fw[3]));
    // (A place is where the ink test flips, the same test for a sharp or a smooth stretch.)
    // (Counted per position: the fit runs over at most a few hundred positions.)
    const hx = new Uint32Array(W + 1), hy = new Uint32Array(H + 1);
    for (let y = fy0; y < fy1; y++) for (let x = fx0; x < fx1; x++) if (on(x, y) !== on(x - 1, y)) hx[x]++;
    for (let x = fx0; x < fx1; x++) for (let y = fy0; y < fy1; y++) if (on(x, y) !== on(x, y - 1)) hy[y]++;
    const list = (h) => { const P = [], N = []; for (let i = 0; i < h.length; i++) if (h[i]) { P.push(i); N.push(h[i]); } return { P, N }; };
    const ex = list(hx), ey = list(hy);
    const fit = (E, kk, step) => {
      let bc = 0, bn = -1;
      for (let c = 0; c < kk; c += step) {
        let n = 0;
        for (let i = 0; i < E.P.length; i++) { const e = E.P[i]; if (Math.ceil(Math.floor((e + c) / kk) * kk - c - 1e-9) === e) n += E.N[i]; }
        if (n > bn) { bn = n; bc = c; }
      }
      return { c: bc, n: bn };
    };
    // (Several pitches can fit every place on a short line: the middle of those that fit best is taken.)
    const scan = (lo, hi, st, cs) => {
      const all = []; for (let kk = lo; kk <= hi + 1e-12; kk += st) all.push({ kk, n: fit(ex, kk, cs).n });
      const top = Math.max(...all.map((o) => o.n)), best = all.filter((o) => o.n === top);
      return best[best.length >> 1].kk;
    };
    let K = scan(k * (1 - tol), k * (1 + tol), 0.0005, 0.1);
    K = scan(K - 0.001, K + 0.001, 0.0002, 0.05);
    let gx;
    gx = fit(ex, K, 0.02);
    const gy = fit(ey, K, 0.02);
    // A smooth stretch (and video) blurs the places (some of them do not fit), so the offsets are then set where samples at the game pixels'
    // centres are the most contrasted (their spread is largest); for a sharp stretch every offset inside the right
    // range is equally contrasted, and the middle of that range is taken.
    const spread = (axis, c, kk, step = 1) => {
      let n = 0, s1 = 0, s2 = 0;
      if (axis === 'x') {
        for (let y = ya; y <= yb; y += step) for (let i = Math.ceil((fx0 + c) / kk); (i + 0.5) * kk - c - 0.5 < fx1 - 1; i++) { const v = lerp(g, W, (i + 0.5) * kk - c - 0.5, y); n++; s1 += v; s2 += v * v; }
      } else {
        for (let x = runs[0].a; x <= runs[runs.length - 1].b; x += step) for (let i = Math.ceil((ya - 2 + c) / kk); (i + 0.5) * kk - c - 0.5 < yb + 2; i++) { const v = lerpY(g, W, H, x, (i + 0.5) * kk - c - 0.5); n++; s1 += v; s2 += v * v; }
      }
      return n ? s2 / n - (s1 / n) ** 2 : 0;
    };
    // the offset (steps across one game px) with the largest spread at pitch kk: {c, v}
    const sharpen = (axis, kk, steps, step) => {
      let best = { c: 0, v: -1 };
      for (let j = 0; j < steps; j++) { const c = (j + 0.5) * kk / steps, v = spread(axis, c, kk, step); if (v > best.v) best = { c, v }; }
      return best;
    };
    // Sharp or smooth: a smooth stretch makes ramps (a pixel strictly between its left and right neighbours, by 8+
    // each way) at most edges; a sharp one makes steps only.
    let steps = 0, ramps = 0;
    for (let y = ya; y <= yb; y++) for (let x = Math.max(1, x0); x < Math.min(W - 1, x1); x++) {
      const a = g[y * W + x - 1], v = g[y * W + x], b = g[y * W + x + 1];
      if (Math.abs(b - a) < 40) continue;
      steps++; if (Math.min(Math.abs(v - a), Math.abs(b - v)) >= 8 && (v - a) * (b - v) > 0) ramps++;
    }
    const sharp = steps > 0 && ramps < 0.1 * steps;
    if (!sharp) {
      // the pitch too: 0.3% off drifts half a game px over a name, so it is searched with the offset (coarse, then fine)
      let bk = K, bx = sharpen('x', K, 16, 3);
      for (let kk = k * (1 - tol); kk <= k * (1 + tol); kk += k * 0.0006) { const o = sharpen('x', kk, 16, 3); if (o.v > bx.v) { bx = o; bk = kk; } }
      const k0 = bk; bx = sharpen('x', bk, 40);
      for (let kk = k0 - K * 0.001; kk <= k0 + K * 0.001; kk += K * 0.00025) { const o = sharpen('x', kk, 40); if (o.v > bx.v) { bx = o; bk = kk; } }
      K = bk; gx.c = bx.c; gy.c = sharpen('y', K, 40).c;
    }
    const gcol = (x) => Math.floor((x + gx.c) / K), grow = (y) => Math.floor((y + gy.c) / K);
    const mid = (i, c) => Math.floor((Math.ceil(i * K - c - 1e-9) + Math.ceil((i + 1) * K - c - 1e-9) - 1) / 2);   // a block's middle pixel
    // the baseline: the bottom ink row most runs share (descenders go lower, so the mode is the baseline)
    const bottoms = new Map();
    for (const r of runs) { let bot = -1; for (let y = yb; y >= ya && bot < 0; y--) for (let x = r.a; x <= r.b; x++) if (on(x, y)) { bot = y; break; } const gb = grow(bot); bottoms.set(gb, (bottoms.get(gb) || 0) + 1); }
    let base = null, nb = 0; for (const [y, n] of bottoms) if (n > nb || (n === nb && y < base)) { base = y; nb = n; }
    // The line read on the game pixel grid, then split into glyph runs at blank game columns (so a stroke the blur
    // thinned below the threshold splits nothing that the game did not split).
    // For a smooth stretch each sample is sharpened against its 4 neighbours (the blur spreads a game pixel into
    // them), so a 1 px gap or stroke stays one.
    const at = (i, d) => bilinear(g, W, H, (i + 0.5) * K - gx.c - 0.5, (base + d + 0.5) * K - gy.c - 0.5);
    // (only inside the line's window: the seller tag's light border or the next line is not ink)
    const inWin = (i, d) => {
      const x = sharp ? mid(i, gx.c) : Math.round((i + 0.5) * K - gx.c - 0.5), y = sharp ? mid(base + d, gy.c) : Math.round((base + d + 0.5) * K - gy.c - 0.5);
      return x >= x0 && x < x1 && y >= y0 && y < y1;
    };
    const px = (i, d) => !inWin(i, d) ? false : sharp
      ? on(Math.max(0, Math.min(W - 1, mid(i, gx.c))), Math.max(0, Math.min(H - 1, mid(base + d, gy.c))))
      : ink(at(i, d) + SHARPEN * (at(i, d) - (at(i - 1, d) + at(i + 1, d) + at(i, d - 1) + at(i, d + 1)) / 4));
    // Two spare game rows above and below the screen's baseline; the baseline on the grid is the bottom row most
    // runs end on (the blur can push the screen's bottom ink row one game row down).
    const SP = 2, i0 = gcol(runs[0].a) - 1, i1 = gcol(runs[runs.length - 1].b) + 1, all = [];
    for (let i = i0; i <= i1; i++) { const col = []; for (let d = -ABOVE - SP; d <= BELOW + SP; d++) col.push(px(i, d)); all.push(col); }
    const ends = new Map();
    { let a0 = -1;
      for (let j = 0; j <= all.length; j++) {
        const o = j < all.length && all[j].some(Boolean);
        if (o && a0 < 0) a0 = j;
        if (!o && a0 >= 0) { let bot = -1; for (let q = a0; q < j; q++) for (let d = all[q].length - 1; d > bot; d--) if (all[q][d]) { bot = d; break; } ends.set(bot, (ends.get(bot) || 0) + 1); a0 = -1; }
      } }
    let gb = ABOVE + SP, ne = 0; for (const [d, n] of ends) if (n > ne || (n === ne && d < gb)) { gb = d; ne = n; }
    if (gb - ABOVE < 0 || gb + BELOW >= all[0].length) return null;
    const colBits = all.map((col) => col.slice(gb - ABOVE, gb + BELOW + 1));
    const keys = [], gaps = [];
    let s0 = -1, lastEnd = null;
    for (let j = 0; j <= colBits.length; j++) {
      const o = j < colBits.length && colBits[j].some(Boolean);
      if (o && s0 < 0) s0 = j;
      if (!o && s0 >= 0) {
        if (j - s0 > 30) return null;
        const rows = [];
        for (let d = 0; d < ABOVE + 1 + BELOW; d++) { let r = ''; for (let q = s0; q < j; q++) r += colBits[q][d] ? '#' : '.'; rows.push(r); }
        keys.push(rows.join('/'));
        if (lastEnd != null) gaps.push(s0 - lastEnd - 1);
        lastEnd = j - 1; s0 = -1;
      }
    }
    if (!keys.length) return null;
    // font.js's letter for each run where the bitmap is exactly a font glyph (or 2-3 touching ones), else null
    const F = fontMap(), font = F ? keys.map((key) => splitKey(key, F, 0)) : null;
    // k: the scale the caller gave (the table is kept per scale, so a short line whose fitted pitch wanders by 1%
    // still goes to the same table); pitch: the fitted one
    return { k: Math.round(k * 1000) / 1000, pitch: Math.round(K * 1000) / 1000, keys, gaps, font };
  }

  // font.js (self.MesoShopFont) as a Map bitmap -> letter, in the worker where it is loaded; else null.
  let FM;
  function fontMap() {
    if (FM !== undefined) return FM;
    const F = root.MesoShopFont && root.MesoShopFont.FONT;
    FM = F && root.MesoShopFont.ABOVE === ABOVE && root.MesoShopFont.BELOW === BELOW ? new Map(Object.entries(F).map(([ch, rows]) => [rows.join('/'), ch])) : null;
    return FM;
  }

  // The most common luma (2-level bins) in a window, for the paper.
  function modeLuma(g, W, H, win) {
    const hist = new Uint32Array(128);
    for (let y = Math.max(0, win[1] | 0); y < Math.min(H, win[3]); y++) for (let x = Math.max(0, win[0] | 0); x < Math.min(W, win[2]); x++) hist[Math.min(127, g[y * W + x] >> 1)]++;
    let mi = 0; for (let i = 1; i < 128; i++) if (hist[i] > hist[mi]) mi = i;
    return mi * 2 + 1;
  }

  // A row's item name line. opts: {band: [x0, y0, y1] (reader.js nameInfo.band, row px), s (the reader's scale)}.
  // k from the row's width (the row box is 262 game px) when it agrees with the reader's scale, else from the scale.
  function cutName(img, opts) {
    const W = img.width, H = img.height, band = opts && opts.band;
    if (!Array.isArray(band) || band.length < 3) return null;
    // k: capture.js's game pixel size (opts.k) or the reader's scale, checked against the row's width
    const ks = opts.k > 0 ? opts.k : opts.s > 0 ? opts.s * 369 / ROW_GAME_W : null, kw = W / ROW_GAME_W;
    const k = ks == null || Math.abs(kw / ks - 1) < 0.04 ? kw : ks;
    if (!(k >= 0.6 && k <= 4.5)) return null;
    const g = toLuma(img);
    const win = [Math.max(38 * k, Math.min(band[0], 45 * k)), band[1], Math.min(W, 205 * k), band[2]];
    const paper = modeLuma(g, W, H, win);
    const kind = Math.abs(paper - PAL.unsold.paper) <= PAPER_TOL ? 'unsold' : Math.abs(paper - PAL.sold.paper) <= 10 ? 'sold' : null;
    if (!kind) return null;
    const thr = (paper + PAL[kind].ink) / 2;
    const c = cutLine(g, W, H, win, (v) => v < thr, k, [Math.max(0, 36 * k), 0, Math.min(W, 208 * k), H]);
    if (c) c.kind = kind;
    return c;
  }

  // The seller's name tag (white text on a dark tag, 15 x 85 game px; reader.js readSellerExact) at any scale.
  function cutSeller(img) {
    const W = img.width, H = img.height, g = toLuma(img);
    const dark = (v) => v >= 30 && v <= 75;
    let run = null, cur = null;
    for (let y = 0; y < H; y++) {
      let n = 0; for (let x = 0; x < W; x++) if (dark(g[y * W + x])) n++;
      if (n >= 40) { if (!cur) cur = { a: y, b: y }; else cur.b = y; if (!run || cur.b - cur.a > run.b - run.a) run = { ...cur }; } else cur = null;
    }
    if (!run) return null;
    const k = (run.b - run.a + 1) / 15;
    if (!(k >= 0.6 && k <= 4.5)) return null;
    // the tag's columns: the longest dark run on its top and bottom rows, which hold no letters (in the middle rows a
    // smooth stretch lightens the dark around every letter)
    let bx = null;
    for (const y of [run.a, run.a + 1, run.b - 1, run.b]) {
      let a = -1;
      for (let x = 0; x <= W; x++) {
        if (x < W && g[y * W + x] >= 25 && g[y * W + x] <= 90) { if (a < 0) a = x; }
        else if (a >= 0) { if (!bx || x - 1 - a > bx.b - bx.a) bx = { a, b: x - 1 }; a = -1; }
      }
    }
    if (!bx) return null;
    // The scale from the tag's width (85 game px): ~6x more precise than its height, whose top and bottom rows a
    // smooth stretch lightens (a recorded tag stretched to 1.98x shows 25 dark rows, not 30). The height must fit.
    const kw = (bx.b - bx.a + 1) / 85, hg = (run.b - run.a + 1) / kw;
    if (!(kw >= 0.6 && kw <= 4.5) || hg < 10 || hg > 17) return null;
    return cutLine(g, W, H, [bx.a, run.a, bx.b + 1, run.b + 1], (v) => v >= 150, kw, [bx.a - 3 * k, run.a - 3 * k, bx.b + 3 * k, run.b + 3 * k], 0.015);   // a tag's width is known to +-2 px only
  }

  // ---------------------------------------------------------------- the table (on the page)
  let T = null, dirty = 0, conf = new Map();   // conf: scale key -> Map(glyph key -> letter) of confirmed glyphs
  // A long session (Grant, 2026-10-16: "it really slows down when you've done a ton of listing"): a full table cost about
  // 11 ms a row (every teach counted, sorted and saved the whole table and dropped the confirmed glyphs). Now: the count of
  // glyphs per scale is kept (keyCount), the confirmed glyphs are updated for the glyphs taught, a full table drops its
  // least-seen tenth at once, and the table is saved at most every SAVE_MS.
  const keyCount = new Map(), SAVE_MS = 5000, PRUNE_TO = Math.floor(MAX_KEYS * 0.9);
  let savedAt = -Infinity;
  function store() {
    try {
      // Node's own localStorage (a getter on the global, with no window) is not the page's: not used
      const d = Object.getOwnPropertyDescriptor(root, 'localStorage');
      if (d && d.get && typeof root.window === 'undefined' && typeof root.document === 'undefined') return null;
      return root.localStorage || null;
    } catch { return null; }
  }
  function load() {
    if (T) return T;
    try { const s = store(), j = s && JSON.parse(s.getItem(STORE) || 'null'); if (j && j.v === 1 && j.scales) T = j; } catch { /* unreadable: start empty */ }
    if (!T) T = { v: 1, scales: {} };
    conf.clear(); keyCount.clear();
    return T;
  }
  function save() { savedAt = Date.now(); try { const s = store(); if (s) s.setItem(STORE, JSON.stringify(T)); dirty = 0; } catch { /* full or blocked: keep in memory */ } }
  function bucket(k, create) {
    load();
    let best = null, bd = Infinity;
    for (const key of Object.keys(T.scales)) { const d = Math.abs(Number(key) - k); if (d <= SCALE_TOL && d < bd) { best = key; bd = d; } }
    if (best || !create) return best;
    const key = (Math.round(k * 100) / 100).toFixed(2);
    const all = Object.keys(T.scales);
    if (all.length >= MAX_SCALES) { all.sort((a, b) => (T.scales[a].at || 0) - (T.scales[b].at || 0)); delete T.scales[all[0]]; conf.delete(all[0]); keyCount.delete(all[0]); }
    T.scales[key] = { at: Date.now(), keys: {} };
    return key;
  }
  function confirmedOf(e) {
    let top = null, n1 = 0, n2 = 0;
    for (const [ch, n] of Object.entries(e)) { if (n > n1) { n2 = n1; n1 = n; top = ch; } else if (n > n2) n2 = n; }
    return n1 >= NEED && n2 * 4 <= n1 ? top : null;
  }
  // The confirmed glyphs of a scale: a Map(glyph key -> letter) and m.seq = Map(key -> its place in the Map), so
  // splitKey looks its few candidates up instead of scanning every glyph, and still takes them in the Map's order.
  function confSet(m, key, ch) { if (!m.has(key)) m.seq.set(key, m.next++); m.set(key, ch); }
  function confDel(m, key) { if (m.delete(key)) m.seq.delete(key); }
  function newConf() { const m = new Map(); m.seq = new Map(); m.next = 0; return m; }
  function confirmed(sk) {
    if (!conf.has(sk)) {
      const m = newConf(), K = T.scales[sk] ? T.scales[sk].keys : {};
      for (const [key, e] of Object.entries(K)) { const ch = confirmedOf(e); if (ch) confSet(m, key, ch); }
      conf.set(sk, m);
    }
    return conf.get(sk);
  }
  const isSpace = (gap, prev) => gap >= (/1$/.test(prev || '') ? 5.5 : 2.5);
  const norm = (ch) => (ch === 'I' ? 'l' : ch);   // I and l are one glyph (font.js)
  // A "." glyph: one or two game px wide, its ink only on the baseline (and a row next to it, for a smooth stretch).
  function isDot(key) {
    const rows = key.split('/');
    return rows[0].length <= 2 && rows.every((r, y) => (y >= ABOVE - 1 && y <= ABOVE + 1) || !r.includes('#')) && rows[ABOVE].includes('#');
  }
  // The catalog name as the row may show it: the whole name, or its start cut with "..." (trailing space dropped).
  function shownForms(name) {
    const out = new Set([name]);
    for (let p = 1; p < name.length; p++) out.add(name.slice(0, p).trimEnd() + '...');
    return [...out];
  }
  // Does `shown` fit the cut: one glyph run per letter, and a space exactly where the gaps say so.
  function fits(cut, shown) {
    const chars = [], space = [];
    for (const ch of shown) { if (ch === ' ') { if (chars.length) space[chars.length - 1] = true; continue; } chars.push(ch); }
    if (chars.length !== cut.keys.length) return null;
    for (let i = 0; i < cut.gaps.length; i++) if (isSpace(cut.gaps[i], chars[i]) !== !!space[i]) return null;
    return chars;
  }
  // Teach the table one row: cut (cutName/cutSeller) and the text the row shows (a catalog name, or a seller's name
  // read some other sure way). Returns {learned: n} or {skipped: why}. A cut name ("...") is tried at every length;
  // exactly one length must fit.
  function teach(cut, name) {
    if (!cut || !Array.isArray(cut.keys) || !cut.keys.length || !(cut.k > 0) || typeof name !== 'string' || !name.trim()) return { skipped: 'nothing to learn' };
    // A row that ends in three dots shows a cut name; any other row shows the whole name (a cut and a whole name can
    // have the same count and spacing: "Selective 5-slot Coupon" and "Selective 5-slot Cou...").
    const n = cut.keys.length, cutShown = n > 3 && cut.keys.slice(n - 3).every(isDot);
    const forms = (cutShown ? shownForms(name.trim()).filter((f) => f.endsWith('...')) : [name.trim()]).map((f) => fits(cut, f)).filter(Boolean);
    if (!forms.length) return { skipped: 'counts disagree' };
    if (forms.length > 1 && new Set(forms.map((f) => f.join(''))).size > 1) return { skipped: 'several cuts fit' };
    const sk = bucket(cut.k, true), S = T.scales[sk];
    S.at = Date.now();
    let nk = keyCount.has(sk) ? keyCount.get(sk) : Object.keys(S.keys).length;
    forms[0].forEach((ch, i) => { let e = S.keys[cut.keys[i]]; if (!e) { e = S.keys[cut.keys[i]] = {}; nk++; } e[norm(ch)] = (e[norm(ch)] || 0) + 1; });
    const M = conf.get(sk);   // the confirmed glyphs, when made: only the glyphs taught can change
    if (M) for (const key of cut.keys) { const e = S.keys[key], ch = e ? confirmedOf(e) : null; if (ch) confSet(M, key, ch); else confDel(M, key); }
    if (nk > MAX_KEYS) {   // drop the least-seen glyphs, down to PRUNE_TO
      const tot = (e) => { let n = 0; for (const c in e) n += e[c]; return n; };
      const ks = Object.keys(S.keys).map((key) => [key, tot(S.keys[key])]);
      ks.sort((a, b) => a[1] - b[1]).slice(0, ks.length - PRUNE_TO).forEach(([key]) => { delete S.keys[key]; if (M) confDel(M, key); });
      nk = Math.min(ks.length, PRUNE_TO);
    }
    keyCount.set(sk, nk);
    { const c = counts.get(sk) || { exact: 0, taught: 0 }; c.taught++; counts.set(sk, c); }
    if (++dirty >= 5 && Date.now() - savedAt >= SAVE_MS) save();
    return { learned: forms[0].length };
  }
  // A run that is 2-3 touching glyphs: its columns split into confirmed glyphs (as reader.js splitRun does).
  function splitKey(key, M, depth) {
    const hit = M.get(key); if (hit) return hit;
    if (depth >= 2) return null;
    const rows = key.split('/'), w = rows[0].length;
    // A glyph fits the run's left side when its key is exactly the run's first gw columns: one lookup per width, taken
    // in the Map's order (M.seq), as the scan of every glyph took them.
    const cand = [];
    for (let gw = 1; gw < w; gw++) { const k2 = rows.map((r) => r.slice(0, gw)).join('/'); if (M.has(k2)) cand.push(k2); }
    if (M.seq) cand.sort((a, b) => M.seq.get(a) - M.seq.get(b));
    for (const k2 of cand) {
      const ch = M.get(k2), gw = k2.indexOf('/');
      const rest = splitKey(rows.map((r) => r.slice(gw)).join('/'), M, depth + 1);
      if (rest) return ch + rest;
    }
    return null;
  }
  function fixIl(text) {   // reader.js fixIl: I at a word's start or between capitals, else l
    return text.replace(/\S+/g, (w) => /^l+$/.test(w) ? w.replace(/l/g, 'I')
      : w.replace(/l/g, (m, i) => (i === 0 || (/[A-Z]/.test(w[i - 1] || '') && /[A-Z]/.test(w[i + 1] || '')) ? 'I' : m)));
  }
  // Read a cut with this scale's confirmed glyphs, else font.js's exact glyph (opts.font false: the table only):
  // {text, full (every glyph found), misses, fromFont}. Null when neither knows any glyph.
  function read(cut, opts) {
    if (!cut || !Array.isArray(cut.keys) || !cut.keys.length) return null;
    load();
    const sk = bucket(cut.k, false), M = sk ? confirmed(sk) : new Map();
    const font = opts && opts.font === false ? null : Array.isArray(cut.font) ? cut.font : null;
    if (!M.size && !(font && font.some(Boolean))) return null;
    let text = '', misses = 0, prev = null, fromFont = 0;
    cut.keys.forEach((key, i) => {
      // the learned glyph first; else font.js's, when the bitmap on the game grid is exactly that glyph
      let ch = M.get(key) || (key.split('/')[0].length >= 6 ? splitKey(key, M, 0) : null);
      if (!ch && font && font[i]) { ch = font[i]; fromFont++; }
      if (!ch) { ch = '?'; misses++; }
      if (i && isSpace(cut.gaps[i - 1], prev) && !(opts && opts.noSpaces)) text += ' ';
      text += ch; prev = ch;
    });
    return { text: fixIl(text), full: misses === 0, misses, fromFont };
  }
  // How much of the common letters this scale reads: {glyphs (confirmed keys), letters, share of COMMON}.
  function coverage(k) {
    load();
    const sk = k > 0 ? bucket(k, false) : null;
    if (!sk) return { glyphs: 0, letters: 0, share: 0 };
    const M = confirmed(sk), have = new Set([...M.values()].map((c) => (c === 'l' ? 'lI' : c)).join(''));
    let n = 0; for (const ch of COMMON) if (have.has(ch)) n++;
    return { glyphs: M.size, letters: have.size, share: n / COMMON.length };
  }
  // live.js counts the names read exactly with the glyphs (noteExact), and the log asks status(k):
  // {taught (rows taught), letters (common letters confirmed), total (common letters), exact (names read exactly)}.
  const counts = new Map();
  function bucketKey(k) { load(); return bucket(k, false) || (Math.round(k * 100) / 100).toFixed(2); }
  function noteExact(k) { if (!(k > 0)) return; const b = bucketKey(k), c = counts.get(b) || { exact: 0, taught: 0 }; c.exact++; counts.set(b, c); }
  function status(k) {
    if (!(k > 0)) return null;
    const b = bucketKey(k), c = counts.get(b) || { exact: 0, taught: 0 }, cov = coverage(k);
    return { taught: c.taught, letters: Math.round(cov.share * COMMON.length), total: COMMON.length, exact: c.exact };
  }
  function reset() { T = { v: 1, scales: {} }; conf.clear(); keyCount.clear(); counts.clear(); save(); }

  const api = { cutName, cutSeller, cutLine, teach, read, coverage, status, noteExact, load: () => { T = null; load(); return true; }, save, reset, NEED, COMMON, _fits: fits, _table: () => load(), _resetFont: () => { FM = undefined; } };
  root.MesoLearn = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof self !== 'undefined' ? self : globalThis);

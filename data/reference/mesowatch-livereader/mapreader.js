/* MesoWatch live reader, part D: the MAP NAME from the minimap title (beta, FEATURES.liveReader). No OCR model, no network.

   self.MesoMapReader = { load(maps), loaded(), readMap(imageData) }

   imageData: the top-left corner of the game frame (capture.js mapImage: at least 25% x 14% of the frame).
   readMap returns {map, room, street, score, why, ms}:
   - map: the map's name as the catalog writes it, with the room as " <n>" ("Free Market <7>", "Kerning City"), or null.
     null whenever any check fails: no minimap panel, no second title line, a letter matches too weakly, the text does not
     match ^[A-Za-z' ]+( <\d{1,2}>)?$, or the text is not a name in the map catalog (maps.json "names"). A failed check
     means no data, never a guess.
   - room: the number inside "<n>" as a string ("7"), or null.

   How it reads (the same idea as reader.js's item names, with templates for the minimap's own font, maps.json):
   1. The panel: the header word "MINI MAP", found by correlation with maps.json's header template over UI scales
      0.6-2.2 (1080p, 1440p, a small window, a scaled stream). Its match gives the position and the UI scale s.
   2. The title: rows of white text right of the map's mark, between the header and the minimap; the line near
      51 px under the header (x s) is the map name (the one above is the street). The panel's right edge is where
      its blue-grey ground ends, so signs beside the panel are not read.
   3. The line is resampled to mk/s px per frame px and turned into an ink map. Letters often touch, so it is cut at
      empty gaps and at columns where the ink dips ("cuts").
   4. Every catalog name the templates can spell is laid over the cuts (each letter between two cuts, a space on an
      empty gap); the best fit must have a mean letter score of at least min_mean_score, no letter under
      min_glyph_score, and beat the next name by min_margin. Only catalog names can come out.
   watcher() reads at most once a second and shows a name only after 3 equal reads in a row.
   Plain JS, no DOM: works in a Web Worker and in node (tests). */
(function (root) {
  'use strict';
  let M = null; // loaded maps.json with prepared templates

  const DEF = {
    white: 215,        // the header bar is brighter than this
    ground_rows: [18, 19, 20, 21, 22],  // rows of plain panel ground under the header bar (px at s = 1)
    // the header word must match at least this well: 0.6 since 2026-10-18 (crisp 1366x768 windows matched the 1080p-built
    // template at 0.62-0.69 and never read; at 0.6 they read Free Market <2>-<5>, each checked against the screen)
    min_header: 0.6,
    keep_header: 0.8,  // the last scale is kept without a full sweep when it matches this well
   // the header word must match at least this well
    scale_min: 0.6, scale_max: 2.2,
    // title geometry in px at s = 1, relative to the header template's top-left corner
    title_dx: 55, title_w: 300, title_y0: 22, title_y1: 70, street_top: 30, map_top: 50, line_tol: 6,
    ink_lo: 0.25,      // the ink cut: this share of the way from the ground to the brightest text
    ink_hi: 226,       // a title row holds text when it has pixels brighter than this
    mk: 2,             // canonical px per frame px at s = 1
    fh: 30,            // glyph box height in canonical px (capitals and descenders)
    gw: 10, gh: 16,    // glyph feature size
    space: 7,          // a gap of this many canonical px or more is a space
    ink_col: 0.3,      // a column holds ink where the ink map passes this
    valley: 0.35,      // a column whose ink count dips to this share of the word's highest is a possible cut
    end_gap: 30,       // a gap over this ends the title
    tail_gap: 12,      // a name may end before the line's last ink when this much empty space follows it
    width_cost: 0.02,
    max_glyph_w: 40,   // a letter is at most this wide (canonical px)
    min_mean_score: 0.6, min_glyph_score: 0.3, min_margin: 0.15, letter_base: 0.7, unknown_letter: 0.9,
    strong_mean: 0.85, strong_min: 0.2, strong_margin: 1,   // a read this strong may have one letter under min_glyph_score
    strong_wide_margin: 10, strong_wide_min: 0.1,   // ... down to strong_wide_min when the next name is at least strong_wide_margin behind
  };

  function decodeGray(t) {
    const bin = typeof atob === 'function' ? atob(t.gray) : Buffer.from(t.gray, 'base64').toString('binary');
    const d = new Float32Array(t.w * t.h); for (let i = 0; i < d.length; i++) d[i] = bin.charCodeAt(i);
    return { w: t.w, h: t.h, d };
  }

  function toGray(img) {
    const { width: W, height: H, data } = img, g = new Float32Array(W * H);
    for (let i = 0, j = 0; i < g.length; i++, j += 4) g[i] = 0.299 * data[j] + 0.587 * data[j + 1] + 0.114 * data[j + 2];
    return { g, W, H };
  }

  // Bilinear-ish resample of a sub-rectangle (triangle filter; area-like when shrinking).
  function resample(src, sw, sh, dw, dh, sx0 = 0, sy0 = 0, sxw = sw, syh = sh) {
    function weights(sn, s0, sLen, dn) {
      const f = sLen / dn, sup = Math.max(1, f), out = [];
      for (let o = 0; o < dn; o++) {
        const c = s0 + (o + 0.5) * f - 0.5, lo = Math.floor(c - sup), hi = Math.ceil(c + sup), idx = [], w = [];
        let tot = 0;
        for (let i = lo; i <= hi; i++) { const t = 1 - Math.abs(i - c) / sup; if (t <= 0) continue; idx.push(Math.min(sn - 1, Math.max(0, i))); w.push(t); tot += t; }
        out.push({ idx, w: w.map(v => v / tot) });
      }
      return out;
    }
    const wx = weights(sw, sx0, sxw, dw), wy = weights(sh, sy0, syh, dh), tmp = new Float32Array(sh * dw), out = new Float32Array(dh * dw);
    for (let y = 0; y < sh; y++) for (let x = 0; x < dw; x++) { const { idx, w } = wx[x]; let v = 0; for (let k = 0; k < idx.length; k++) v += src[y * sw + idx[k]] * w[k]; tmp[y * dw + x] = v; }
    for (let y = 0; y < dh; y++) { const { idx, w } = wy[y]; for (let x = 0; x < dw; x++) { let v = 0; for (let k = 0; k < idx.length; k++) v += tmp[idx[k] * dw + x] * w[k]; out[y * dw + x] = v; } }
    return out;
  }

  function prep(f) { // zero-mean, norm
    let m = 0; for (let i = 0; i < f.length; i++) m += f[i]; m /= f.length;
    const z = new Float32Array(f.length); let ss = 0;
    for (let i = 0; i < f.length; i++) { z[i] = f[i] - m; ss += z[i] * z[i]; }
    return { z, norm: Math.sqrt(ss) };
  }
  function ncc(a, t) {
    let ma = 0; for (let i = 0; i < a.length; i++) ma += a[i]; ma /= a.length;
    let s = 0, sa = 0; for (let i = 0; i < a.length; i++) { const x = a[i] - ma; s += x * t.z[i]; sa += x * x; }
    return sa && t.norm ? s / Math.sqrt(sa) / t.norm : 0;
  }

  // 1. The panel: the header word "MINI MAP" (dark letters on the white header bar), found by normalised correlation
  //    with maps.json's header template over a sweep of UI scales. The scale found last is tried first.
  let lastScale = null, lastOff = 0;   // and the coarse grid's offset it was found on (findHeader)
  const tplCache = new Map();
  let unWait = 0, hdBarWait = 0;   // reads left before the next un-enlarged bar, and the next bar under a header with no title
  let barSkips = 0, barSearches = 0;   // bar fits skipped by a wait, and fits run (a failed bar() that skipped one says nothing)
  function headerTpl(s) {
    const k = s.toFixed(4);
    if (!tplCache.has(k)) {
      const T = M._header, w = Math.max(6, Math.round(T.w * s)), h = Math.max(4, Math.round(T.h * s));
      tplCache.set(k, Object.assign(prep(resample(T.d, T.w, T.h, w, h)), { w, h }));
    }
    return tplCache.get(k);
  }
  function matchAt(g, W, T, x, y) {
    const n = T.w * T.h; let s = 0, s1 = 0, s2 = 0, k = 0;
    for (let ty = 0; ty < T.h; ty++) { let r = (y + ty) * W + x; for (let tx = 0; tx < T.w; tx++, r++, k++) { const v = g[r]; s += v * T.z[k]; s1 += v; s2 += v * v; } }
    const varI = s2 - s1 * s1 / n;
    return varI > 1e-6 && T.norm ? s / (Math.sqrt(varI) * T.norm) : -1;
  }
  function search(g, W, H, T, x0, x1, y0, y1, step) {
    let best = { v: -1, x: 0, y: 0 };
    x1 = Math.min(x1, W - T.w); y1 = Math.min(y1, H - T.h);
    for (let y = Math.max(0, y0); y <= y1; y += step) for (let x = Math.max(0, x0); x <= x1; x += step) {
      const v = matchAt(g, W, T, x, y); if (v > best.v) best = { v, x, y };
    }
    return best;
  }
  function findHeader(g, W, H, P) {
    const xMax = Math.round(0.12 * W + 40), yMax = Math.round(0.7 * H);
    // off: the coarse grid's offset (0, or 1 px across and down)
    const tryScales = (list, off = 0) => {
      let best = { v: -1 };
      for (const s of list) {
        const T = headerTpl(s);
        if (T.w >= W || T.h >= H) continue;
        let b = search(g, W, H, T, off, xMax, off, yMax, 2);
        if (b.v < 0.3) continue;
        b = search(g, W, H, T, b.x - 2, b.x + 2, b.y - 2, b.y + 2, 1);
        if (b.v > best.v) best = Object.assign(b, { s, off });
      }
      return best;
    };
    const sweep = (list, off) => {
      let hit = tryScales(list, off);
      if (hit.v >= P.min_header) { // refine the scale around the best one
        for (const f of [1.03, 1.015, 1.0075]) { const h3 = tryScales([hit.s / f, hit.s * f], off); if (h3.v > hit.v) hit = h3; }
      }
      return hit;
    };
    let hit = { v: -1 };
    if (lastScale) hit = tryScales([lastScale / 1.03, lastScale, lastScale * 1.03], lastOff);
    if (hit.v < P.keep_header) {
      const list = []; for (let s = P.scale_min; s <= P.scale_max + 1e-9; s *= 1.06) list.push(s);
      const h2 = sweep(list, 0); if (h2.v > hit.v) hit = h2;
      // A crisp 1x window's header (s 0.71-0.73, a 47 x 9 px template) 1 px off the 2 px grid across AND down matches under
      // 0.3 at every grid place and is never refined (R-EMVL3, Firefox: a 1374x802 window share, Kerning City
      // Construction Site plain to see, "minimap title not found"; one place in 4 of the window in the frame). When no
      // header was found at all, the small scales (under 0.9) are searched again on the grid 1 px across and down. Only
      // then: searched beside the first grid, it found other headers in frames that read before (review of #336: 1x
      // 80 -> 74 maps, x1.406 87 -> 86 on the reviewer's frames).
      if (hit.v < P.min_header) { const h4 = sweep(list.filter((s) => s < 0.9), 1); if (h4.v > hit.v) hit = h4; }
    }
    if (hit.v < P.min_header) return null;
    lastScale = hit.s; lastOff = hit.off || 0;
    return hit;
  }

  // 2. The title lines: row groups of bright text right of the map's mark, under the header bar.
  function titleLines(g, W, H, hd, P, rgba) {
    const s = hd.s, xa = Math.round(hd.x + P.title_dx * s);
    // the panel's right edge: on the rows between the header bar and the title, the panel's blue-grey ground runs from
    // the title's left to the panel's dark border (game scenery and shop signs beside the panel are not title text)
    let xb = Math.min(W, Math.round(hd.x + P.title_w * s));
    if (rgba) {
      const ends = [];
      for (const dy of P.ground_rows) {
        const y = Math.round(hd.y + dy * s); if (y < 0 || y >= H) continue;
        let x = xa, miss = 0, last = xa;
        for (; x < W && miss <= 3; x++) {
          const i = (y * W + x) * 4, r = rgba[i], gg = rgba[i + 1], b = rgba[i + 2];
          if (r >= 105 && r <= 195 && gg >= 145 && gg <= 220 && b >= 160 && b <= 235 && b - r >= 25 && Math.abs(gg - b) <= 35) { miss = 0; last = x; } else miss++;
        }
        ends.push(last);
      }
      ends.sort((p, q) => p - q);
      const e = ends.length ? ends[Math.floor(ends.length / 2)] : 0;
      if (e > xa + 40 * s) xb = Math.min(xb, e + 1);
    }
    const ya = Math.round(hd.y + P.title_y0 * s), yb = Math.min(H, Math.round(hd.y + P.title_y1 * s));
    if (xb - xa < 20 || yb - ya < 10) return { xa, xb, lines: [] };
    const on = [];
    for (let y = ya; y < yb; y++) { let n = 0; for (let x = xa; x < xb; x++) n += g[y * W + x] > P.ink_hi; on.push(n >= 2); }
    const groups = []; let st = -1;
    for (let i = 0; i <= on.length; i++) {
      const v = i < on.length && on[i];
      if (v && st < 0) st = i;
      if (!v && st >= 0) {
        if (groups.length && st - groups[groups.length - 1].b <= 1) groups[groups.length - 1].b = i; else groups.push({ a: st, b: i });
        st = -1;
      }
    }
    const lines = groups.filter(q => q.b - q.a >= 5 * s).map(q => ({ y0: ya + q.a, y1: ya + q.b }));
    // the street line and the map line, each the group nearest its expected top
    const near = (want) => { let b = null; for (const l of lines) { const d = Math.abs(l.y0 - (hd.y + want * s)); if (d <= P.line_tol * s && (!b || d < b.d)) b = { d, l }; } return b && b.l; };
    return { xa, xb, lines, street: near(P.street_top), map: near(P.map_top) };
  }

  // 3. One line as a canonical band with its ink map and blobs.
  function lineParts(g, W, H, hd, xa, xb, line, P) {
    const s = hd.s, pad = Math.max(1, Math.round(2 * s));
    const y0 = Math.max(0, line.y0 - pad), y1 = Math.min(H, line.y1 + pad), sw = xb - xa, sh = y1 - y0;
    const sub = new Float32Array(sw * sh);
    for (let y = 0; y < sh; y++) for (let x = 0; x < sw; x++) sub[y * sw + x] = g[(y0 + y) * W + xa + x];
    const k = P.mk / s, w = Math.max(8, Math.round(sw * k)), h = Math.max(8, Math.round(sh * k));
    const d = resample(sub, sw, sh, w, h);
    const sorted = Array.from(d).sort((a, b) => a - b), hi = sorted[Math.floor(sorted.length * 0.985)];
    // ink: brighter than the band's ground (its median) by a share of the text's contrast; the letters' thin strokes are
    // dimmer than their stems after video compression, so the cut sits low
    const bg = sorted[Math.floor(sorted.length * 0.5)], lo = bg + P.ink_lo * (hi - bg), span = Math.max(8, (hi - lo) * 0.6), m = new Float32Array(d.length);
    for (let i = 0; i < d.length; i++) m[i] = Math.min(1, Math.max(0, (d[i] - lo) / span));
    // the line's top: first canonical row with ink
    const rp = new Float32Array(h);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) rp[y] += m[y * w + x] > 0.5;
    let ya = 0; while (ya < h && rp[ya] < 1) ya++;
    // column ink counts; the letters touch each other often, so words are cut into letters by the alignment (step 4)
    // at "cuts": the middle of empty gaps and the columns where the ink count dips (valleys)
    const cp = new Float32Array(w);
    for (let x = 0; x < w; x++) for (let y = ya; y < Math.min(h, ya + P.fh); y++) cp[x] += m[y * w + x] > P.ink_col;
    const runs = []; let st = -1;
    for (let x = 0; x <= w; x++) {
      const on = x < w && cp[x] >= 1;
      if (on && st < 0) st = x;
      if (!on && st >= 0) {
        let n = 0; for (let i = st; i < x; i++) n += cp[i];
        if (n >= 3) { if (runs.length && st - runs[runs.length - 1][1] > P.end_gap) break; runs.push([st, x]); }
        st = -1;
      }
    }
    // cuts: both edges of every ink run, and the valleys inside runs
    const cutSet = new Set();
    for (const r of runs) {
      cutSet.add(r[0]); cutSet.add(r[1]);
      let mx = 0; for (let x = r[0]; x < r[1]; x++) mx = Math.max(mx, cp[x]);
      for (let x = r[0] + 2; x < r[1] - 2; x++) if (cp[x] <= cp[x - 1] && cp[x] <= cp[x + 1] && cp[x] <= P.valley * mx) cutSet.add(x);
    }
    const cuts = [...cutSet].sort((p, q) => p - q);
    // the widest empty gap inside columns c0..c1
    // the widest empty gap between the first and the last ink column of c0..c1 (blank edges do not count: a letter's
    // span may start or end in the gap before or after it)
    const gapIn = (c0, c1) => {
      while (c0 < c1 && cp[c0] === 0) c0++;
      while (c1 > c0 && cp[c1 - 1] === 0) c1--;
      let best = 0, run = 0; for (let x = c0; x < c1; x++) { if (cp[x] === 0) { run++; if (run > best) best = run; } else run = 0; } return best;
    };
    const blank = (c0, c1) => { for (let x = c0; x < c1; x++) if (cp[x] > 0) return false; return true; };
    // a glyph's feature: its ink columns (blank edges trimmed) resampled to gw x gh
    const feat = (c0, c1) => {
      while (c0 < c1 - 1 && cp[c0] === 0) c0++;
      while (c1 > c0 + 1 && cp[c1 - 1] === 0) c1--;
      const cw = c1 - c0, f = new Float32Array(cw * P.fh);
      for (let y = 0; y < P.fh; y++) { const yy = ya + y; if (yy >= h) break; for (let x = 0; x < cw; x++) f[y * cw + x] = m[yy * w + c0 + x]; }
      return { f: resample(f, cw, P.fh, P.gw, P.gh), w: cw };
    };
    return { w, h, ya, cuts, x0: runs.length ? runs[0][0] : 0, x1: runs.length ? runs[runs.length - 1][1] : 0, nRuns: runs.length, gapIn, blank, feat, hi, m };
  }

  // 4. Matching a line against a name. The line's ink blobs are grouped into words at gaps of `space` px or more. A name
  //    fits when it has as many words, and each word's letters can be laid over that word's blobs in order, each letter
  //    on 1-3 neighbouring blobs (a letter's thin strokes may fall apart into several blobs). The fit's score per
  //    letter is its template's correlation minus a width cost; the name's score is the mean over its letters.
  function scorer(parts, P, glyphs, neutral) {
    const memo = new Map(), byCh = new Map(glyphs.map(L => [L.ch, L])), fm = new Map();
    return (c0, c1, ch) => { // canonical columns c0..c1 as the letter ch (' ': an empty gap)
      const k = (c0 * 4096 + c1) * 128 + ch.charCodeAt(0);
      if (memo.has(k)) return memo.get(k);
      let v;
      if (ch === ' ') v = c1 - c0 >= P.space && parts.blank(c0, c1) ? 0 : -9;
      else {
        const L = byCh.get(ch);
        if (c1 - c0 > P.max_glyph_w || c1 - c0 < 3 || parts.blank(c0, c1) || parts.gapIn(c0, c1) >= P.space) v = -9;
        else if (!L) v = neutral == null ? -9 : neutral;
        else {
          const fk = c0 * 4096 + c1; let F = fm.get(fk); if (!F) { F = parts.feat(c0, c1); fm.set(fk, F); }
          v = ncc(F.f, L) - P.width_cost * Math.abs(F.w - L.w);
        }
      }
      memo.set(k, v); return v;
    };
  }
  // best placement of the name's characters over the line: each spans the columns between two cuts, in order, from the
  // line's first ink to its last; a space spans an empty gap. Score: the letters' mean (spaces do not count).
  function alignName(sc, parts, name, P, cache) {
    const C = parts.cuts, m = C.length - 1, n = name.length;
    if (n > m) return null;
    // rows of the dynamic programme are shared with the last name laid over this line (names are sorted, so
    // neighbours share their start: "Free Market <1>", "Free Market <2>", ...)
    let k0 = 0;
    if (cache && cache.name) { const L = Math.min(cache.name.length, n); while (k0 < L && cache.name[k0] === name[k0]) k0++; }
    const rows = cache && k0 > 0 ? cache.rows.slice(0, k0 + 1) : [(() => { const r = new Array(m + 1).fill(null); r[0] = { s: 0, min: 9, prev: null }; return r; })()];
    if (!cache || k0 === 0) k0 = 0;
    let dp = rows[k0];
    for (let k = k0 + 1; k <= n; k++) {
      const nx = new Array(m + 1).fill(null), ch = name[k - 1];
      let any = false;
      for (let e = k; e <= m; e++) for (let st = e - 1; st >= k - 1; st--) {
        if (C[e] - C[st] > 44) break;
        const prev = dp[st]; if (!prev) continue;
        const v = sc(C[st], C[e], ch); if (v <= -9) continue;
        const tot = prev.s + v;
        if (!nx[e] || tot > nx[e].s) { nx[e] = { s: tot, min: ch === ' ' ? prev.min : Math.min(prev.min, v), prev, span: [C[st], C[e]], ch }; any = true; }
      }
      dp = nx; rows.push(dp);
      if (!any) { if (cache) { cache.name = name.slice(0, k); cache.rows = rows; } return null; }
    }
    if (cache) { cache.name = name; cache.rows = rows; }
    // the name ends at the line's last ink, or before an empty gap of at least tail_gap px (scenery beside the panel)
    let end = dp[m];
    for (let e = m - 1; e >= n; e--) {
      if (!dp[e] || !parts.blank(C[e], Math.min(C[e] + P.tail_gap, C[m]))) continue;
      if (!end || dp[e].s > end.s) end = dp[e];
    }
    if (!end) return null;
    const spans = []; for (let q = end; q && q.span; q = q.prev) if (q.ch !== ' ') spans.unshift(q.span);
    const nl = name.replace(/ /g, '').length;
    return { s: end.s, mean: end.s / nl, min: end.min, spans };
  }

  const NAME_RE = /^[A-Za-z' ]+( <\d{1,2}>)?$/;

  // a 48x24 grey signature of a corner (box means), and the mean absolute difference of two
  function signature(c) {
    const gw = 48, gh = 24, out = new Float32Array(gw * gh), W = c.width, H = c.height, d = c.data;
    for (let j = 0; j < gh; j++) for (let i = 0; i < gw; i++) {
      const x0 = Math.floor(i * W / gw), x1 = Math.max(x0 + 1, Math.floor((i + 1) * W / gw)), y0 = Math.floor(j * H / gh), y1 = Math.max(y0 + 1, Math.floor((j + 1) * H / gh));
      let s = 0, n = 0;
      for (let y = y0; y < y1; y += 2) for (let x = x0; x < x1; x += 2) { const k = (y * W + x) * 4; s += d[k] + d[k + 1] + d[k + 2]; n++; }
      out[j * gw + i] = n ? s / n / 3 : 0;
    }
    return out;
  }
  function bytesKey(d) { // FNV-1a over every 3rd byte (R, G, B in turn) plus the length: a cheap key for an identical corner
    let h = 2166136261 >>> 0; for (let i = 0; i < d.length; i += 3) { h ^= d[i]; h = Math.imul(h, 16777619) >>> 0; }
    return h + ':' + d.length;
  }
  function sigDist(a, b) { let s = 0; for (let i = 0; i < a.length; i++) s += Math.abs(a[i] - b[i]); return s / a.length; }

  // 1b. The minimap collapsed to its one-line bar ("Hidden Street : Free Market <4>", Grant, 2026-10-18: 782 of 800 live
  // rows had no place): black text (luma under 60) on the bar's light grey (about 221) in the shop's own pixel font (font.js,
  // self.MesoShopFont; "<" and ">" were added for this), read exactly at a whole-number scale. The part after " : " is
  // the map; it counts only when it is a catalog name (I and l are one glyph, so they compare as one). Null otherwise.
  // At a stretched scale (k0: the reported screen px per game px, not a whole number) the bar is put back on game pixels
  // first (unstretchBar below) and then read the same way.
  let barFont = null;
  function readBar(g, W, H, rgba, k0) {
    const SF = root.MesoShopFont; if (!SF || !M) return null;
    if (!barFont || barFont.src !== SF) barFont = { src: SF, map: new Map(Object.entries(SF.FONT).map(([c, r]) => [r.join('/'), c])), list: Object.entries(SF.FONT) };
    for (const k of [1, 2]) {
      const o = k >> 1, r = barText((x, y) => g[(y * k + o) * W + x * k + o], Math.floor(W / k), Math.floor(H / k), SF);
      if (r) return Object.assign(r, { scale: k });
    }
    // also at a whole-number k: a 2x Retina Mac or a browser's own enlargement is a SMOOTH 2x, which the exact read above
    // (sampling every 2nd pixel) cannot read (Mac reports of 2026-10-19; R-8HMCG, R-YGKB8)
    if (rgba && k0 > 1.1 && k0 <= 4) {
      const P = unstretchBar(rgba, W, H, k0), r = P && barText((x, y) => P.v[y * P.w + x], P.w, P.h, SF);
      if (r) return Object.assign(r, { scale: +P.k.toFixed(3) });
    }
    return null;
  }
  // The bar's text on game pixels L(x, y) (gW x gH): {map, room, street, why, bar} or null.
  function barText(L, gW, gH, SF) {
    const F = barFont, above = SF.ABOVE, band = SF.ABOVE + 1 + SF.BELOW;
    const split = (rows, depth) => { const hit = F.map.get(rows.join('/')); if (hit) return hit; if (depth >= 3) return null; const w = rows[0].length;
      for (const [ch, gl] of F.list) { const gw = gl[0].length; if (gw >= w || !rows.every((r, y) => r.slice(0, gw) === gl[y])) continue; const rest = split(rows.map((r) => r.slice(gw)), depth + 1); if (rest) return ch + rest; }
      return null; };
    const norm = (s) => s.replace(/I/g, 'l');
    const ink = (x, y) => x >= 0 && y >= 0 && x < gW && y < gH && L(x, y) < 60;
    // the bar's text rows: a run of rows that are mostly the bar's grey over its first 150 game px, with ink in them
    const span = Math.min(gW, 150), far = Math.min(gW, 420);   // the bar's grey is checked on its first 150 game px; the text may run on as far as it is long
    for (let y0 = 0; y0 + band < gH && y0 < 80; y0++) {
      // the paper row over the text: light (180+), even (80% within 40 of its most common value; the bar's grey is 221, a
      // little lighter or darker while the mouse is on it) and with no ink (2% at most under 100). A shared window's noise,
      // un-stretched, is +-10 on the paper and up to +-40 on the bar's edge row (VP8 at q30); the text itself stays near 0.
      const h = new Map(); for (let x = 0; x < span; x++) { const v = Math.round(L(x, y0) / 8); h.set(v, (h.get(v) || 0) + 1); }
      let mode = 0, mc = 0; for (const [v, c] of h) if (c > mc) { mc = c; mode = v; }
      let m = 0, dark = 0; for (let x = 0; x < span; x++) { const l = L(x, y0); if (Math.abs(l - mode * 8) <= 40) m++; if (l < 100) dark++; }
      if (mode * 8 < 180 || m < 0.8 * span || dark > 0.02 * span) continue;
      for (let base = y0 + above; base <= y0 + above + 4 && base + 3 < gH; base++) {
        const top = base - above, col = (x) => { for (let y = top; y < top + band; y++) if (ink(x, y)) return true; return false; };
        let text = '', x = 0, last = null, bad = false, started = false, wide = false;
        const spaces = [];   // the word spaces' widths (not after a "1")
        while (x < far) {
          if (!col(x)) { x++; if (started && last && x - last.end > 12) break; continue; }   // a wide gap ends the title (the buttons follow)
          const a = x; while (x < far && col(x)) x++;
          const rows = []; for (let y = top; y < top + band; y++) { let s = ''; for (let c = a; c < x; c++) s += ink(c, y) ? '#' : '.'; rows.push(s); }
          const ch = split(rows, 0); if (!ch) { bad = true; break; }
          // a gap a glyph could hide in. A hidden 1 px "I" after a word space adds its own 1 px and a letter gap (1-2 px) to
          // the space ("Ant Tunnel III" read as "II": review of bundle-332). rec2c's bar has word spaces of 4 and 5 px and
          // letters 1-2 px apart, at 1x, x1.406, x1.874 and Mac 2x and through VP8/VP9 alike; so a hidden "I" leaves 6 px or
          // more. The spaces are checked below, once the line is read, and only where a glyph hidden there would make
          // another catalog name. After a "1" up to 5 px is a letter's and 6-9 a space's.
          const gap = last ? a - last.end : 0, one = !!last && last.ch.endsWith('1');
          if (last && gap >= (one ? 6 : 3)) { text += ' '; if (!one) spaces.push({ gap, at: text.length }); else if (gap > 9) wide = true; }
          else if (one && gap >= 4) wide = true;
          text += ch; last = { end: x, ch }; started = true;
        }
        if (bad || !text) continue;
        const mm = text.match(/^(.+?) : (.+)$/); if (!mm) continue;
        const want = norm(mm[2]), hit = M._names.find((n) => norm(n.name) === want);
        // A word space in the map's name where a hidden glyph would make another catalog name ("Ant Tunnel II" + "I" after
        // the space): wider than 5 px, or 2 px wider than every other word space on the bar. Only there: the spaces of
        // "Free Market <4>" can hide no glyph that makes a name, so their width never stops it being read (review of
        // bundle-334: a fixed 5 px anywhere had no margin for them; a limit relative to the other spaces alone missed a
        // hidden "I" after a 4 px space when the bar's other spaces are 5 px: 193 wrong in 864).
        const at = M._short.get(want), from = text.length - mm[2].length;
        if (at) spaces.forEach((s, i) => {
          if (s.at < from || !at.has(s.at - from)) return;
          const others = spaces.filter((_, j) => j !== i).map((o) => o.gap);
          if (s.gap > 5 || (others.length && s.gap >= Math.max(...others) + 2)) wide = true;
        });
        // A name that is another catalog name less one glyph ("East Rocky Mountain VI" / "VII", "Free Market <1>" / "<11>")
        // comes out when a light patch hides that glyph (review of bundle-331: 26 wrong in 120 such reads). It counts only
        // when no gap in it could hide a glyph and the bar right of it is its own grey for 2 glyph widths (10 game px).
        if (hit && M._short.has(want)) {
          if (wide) continue;
          // each row against its own grey left of the text (the bar's rows differ a little: its lower edge is darker)
          const x1 = Math.min(gW, last.end + 10);
          // Each pixel within 24 of it (a share's noise is +-10 a pixel). A patch within that of the bar's grey over exactly
          // the LAST glyph is not caught (it looks just like the shorter name; review of bundle-332: 9 levels lighter passed,
          // and its mean over these 130 px moves under 1 level for a 1-2 px glyph, so a mean test does not catch it either).
          let off = 0, all = 0;
          for (let y = top; y < top + band; y++) {
            const v = []; for (let xx = 0; xx < span; xx++) { const l = L(xx, y); if (l >= 100) v.push(l); }
            if (!v.length) continue;
            v.sort((p, q) => p - q); const ref = v[v.length >> 1];
            for (let xx = last.end; xx < x1; xx++) { all++; if (Math.abs(L(xx, y) - ref) > 24) off++; }
          }
          if (x1 - last.end < 10 || off > 0.03 * all) continue;
        }
        if (hit) return { map: hit.name, room: (hit.name.match(/<(\d{1,2})>$/) || [])[1] || null, street: mm[1], why: 'read', bar: true };
      }
    }
    return null;
  }

  // 1c. The bar in a smoothly stretched picture (Grant, 2026-10-18: a 2560x1440 game is x1.874 its 1366x768 UI, and a
  // tester's window share came as a 2616x1478 frame with its border and title bar; the bar was not read). The game
  // stretches with bilinear filtering, so each screen px is a known blend of 2 x 2 game px, and least squares undoes it
  // exactly, one axis at a time. This is reader.js's solver (unstretchRow and unstretchTag use it for the shop's rows
  // and seller tags), copied: reader.js runs in the worker, this file on the page.
  // One axis: m screen px at s screen px per game px, game px 0 at screen (p + 0.5) * s - 0.5. Its LDL factors.
  function stretchAxis(s, p, m) {
    const u = (x) => (x + 0.5) / s - 0.5 - p;
    const g0 = Math.ceil(u(0) - 1e-6), n = Math.floor(u(m - 1) + 1e-6) - g0 + 1;
    if (n < 2) return null;
    const X = [], I = [], Fr = [], dg = new Float64Array(n), of = new Float64Array(n);
    for (let x = 0; x < m; x++) {
      const t = u(x) - g0; if (t < -1e-6 || t > n - 1 + 1e-6) continue;
      let i = Math.floor(t + 1e-6), f = Math.max(0, t - i); if (i >= n - 1) { i = n - 1; f = 0; }
      X.push(x); I.push(i); Fr.push(f);
      dg[i] += (1 - f) * (1 - f); if (f > 0) { dg[i + 1] += f * f; of[i] += (1 - f) * f; }
    }
    const c = new Float64Array(n), dd = new Float64Array(n);
    dd[0] = dg[0];
    for (let i = 1; i < n; i++) { c[i - 1] = of[i - 1] / dd[i - 1]; dd[i] = dg[i] - of[i - 1] * c[i - 1]; if (!(dd[i] > 1e-6)) return null; }
    return { n, X, I, F: Fr, c, dd };
  }
  // Solves one line: get(x) reads screen px x, put(i, v) writes game px i.
  function stretchSolve(A, get, put, b) {
    const n = A.n; b.fill(0, 0, n);
    for (let j = 0; j < A.X.length; j++) { const v = get(A.X[j]), i = A.I[j], f = A.F[j]; b[i] += (1 - f) * v; if (f > 0) b[i + 1] += f * v; }
    for (let i = 1; i < n; i++) b[i] -= A.c[i - 1] * b[i - 1];
    b[n - 1] /= A.dd[n - 1];
    for (let i = n - 2; i >= 0; i--) b[i] = b[i] / A.dd[i] - A.c[i] * b[i + 1];
    for (let i = 0; i < n; i++) put(i, b[i]);
  }
  // A plane (Float32Array, w x h screen px) back on game px with phases px, py: {v, w, h}.
  function unstretchPlane(src, w, h, s, px, py) {
    const ax = stretchAxis(s, px, w), ay = stretchAxis(s, py, h);
    if (!ax || !ay) return null;
    const nx = ax.n, ny = ay.n, T = new Float32Array(h * nx), V = new Float32Array(ny * nx), b = new Float64Array(Math.max(nx, ny));
    for (let y = 0; y < h; y++) stretchSolve(ax, (x) => src[y * w + x], (i, v) => { T[y * nx + i] = v; }, b);
    for (let x = 0; x < nx; x++) stretchSolve(ay, (y) => T[y * nx + x], (i, v) => { V[i * nx + x] = v; }, b);
    return { v: V, w: nx, h: ny };
  }
  // The grid phases (px, py, in game px) of a stretched plane S (sw x h screen px) whose unstretched pixels sit closest
  // to the palette (miss): 8 x 8 coarse, then each phase alone in finer steps. {e (mean miss a pixel), px, py} or null.
  function fitPhase(S, sw, h, k, miss) {
    let best = null;
    const tryP = (px, py) => { const P = unstretchPlane(S, sw, h, k, px, py); if (!P) return; const e = miss(P) / (P.w * P.h); if (!best || e < best.e) best = { e, px, py }; };
    for (let a = 0; a < 8; a++) for (let b = 0; b < 8; b++) tryP(a / 8, b / 8);
    if (!best) return null;
    for (const st of [1 / 32, 1 / 64, 1 / 128]) {
      for (const j of [-2, -1, 1, 2]) { const c = best; tryP((c.px + j * st + 1) % 1, c.py); }
      for (const j of [-2, -1, 1, 2]) { const c = best; tryP(c.px, (c.py + j * st + 1) % 1); }
    }
    return best;
  }
  // The reported k can be a few percent off (the frame's width / 1366 counts a window share's border: x1.915 for the
  // 2616x1478 frame, x1.874 real). So k is searched within 5% of it, once per reported k (the first bar that fits), and
  // the factor found is kept. A search that finds no fit (a cursor on the bar, a sharp stretch) is not repeated for the
  // next 10 reads (it costs up to half a second on the page's thread).
  const barFix = new Map();   // reported k (3 decimals) -> the factor that fit
  const barWait = new Map();  // reported k -> reads left before the next search
  const FIT_MAX = 8;          // the most a bar's fit may miss, luma a pixel (see below)
  // The bar on game pixels: {v, w, h, k} (luma, the bar's interior from its left, a few rows over the text to a few under
  // it), or null when no bar is seen or its fit is not a bilinear stretch. Luma is BT.709's, as in reader.js (a shared
  // window arrives as I420; the bar's greys are the same in both).
  function unstretchBar(rgba, W, H, k0) {
    const w = Math.min(W, Math.round(440 * k0)), h = Math.min(H, Math.round(100 * k0)), L = new Float32Array(w * h);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const i = (y * W + x) * 4; L[y * w + x] = 0.2126 * rgba[i] + 0.7152 * rgba[i + 1] + 0.0722 * rgba[i + 2]; }
    // Paper rows: 120+ game px of one light grey (180+) in a run. The bar is a group of them over the text and another
    // under it, their runs starting at the same column (the bar's left), 6-13 game px apart, with ink (luma under 60)
    // between. (A text row can have such a run too, after its text: it starts further right.)
    // A shared window's pixels are noisy (I420 and a video codec: +-4 luma and more around the text, review of bundle-330),
    // so a paper row is one grey within TOL (its value: the mean of the most common 8-level bin and its neighbours), and its
    // run may skip a pixel or two that the noise threw out (its ends are where TOL holds again).
    const TOL = 10, rows = [];
    for (let y = 0; y < h; y++) {
      const hist = new Map(); for (let x = 0; x < w; x++) { const q = L[y * w + x] >> 3; hist.set(q, (hist.get(q) || 0) + 1); }
      let q0 = 0, c = 0; for (const [q, n] of hist) if (n > c) { c = n; q0 = q; }
      let v = 0, nv = 0; for (let x = 0; x < w; x++) { const l = L[y * w + x]; if (Math.abs((l >> 3) - q0) <= 1) { v += l; nv++; } }
      v = nv ? v / nv : 0;
      let run = null;
      if (v >= 180 && nv >= 120 * k0) {
        let a = -1, off = 0;
        for (let x = 0; x <= w; x++) {
          const on = x < w && Math.abs(L[y * w + x] - v) <= TOL;
          if (on) { if (a < 0) a = x; off = 0; continue; }
          if (a >= 0 && x < w && ++off <= 2) continue;
          if (a >= 0) { const b = x - off + (x < w ? 1 : 0); if (!run || b - a > run.b - run.a) run = { a, b }; a = -1; off = 0; }
        }
        if (run && run.b - run.a < 120 * k0) run = null;
      }
      rows.push(run && Object.assign(run, { v }));
    }
    const groups = [];
    for (let y = 0; y < h; y++) {
      const r = rows[y], G = groups[groups.length - 1];
      if (!r) continue;
      if (G && G.y1 === y - 1 && Math.abs(G.last - r.v) <= 8 && Math.abs(G.a0 - r.a) <= 4) { G.y1 = y; G.a = Math.max(G.a, r.a); G.b = Math.min(G.b, r.b); G.sum += r.v; G.v = G.sum / (y - G.y0 + 1); G.last = r.v; }
      else groups.push({ y0: y, y1: y, v: r.v, sum: r.v, last: r.v, a0: r.a, a: r.a, b: r.b });
    }
    let bar = null;
    for (let i = 0; i + 1 < groups.length && !bar; i++) {
      const A = groups[i], B = groups.slice(i + 1).find((G) => Math.abs(G.a0 - A.a0) <= 4 && Math.abs(G.v - A.v) <= 12);
      if (!B) continue;
      const gap = B.y0 - A.y1 - 1, a = Math.max(A.a, B.a) + 1, b = Math.min(A.b, B.b) - 1;
      if (gap < 6 * k0 || gap > 13 * k0 || b - a < 100 * k0) continue;
      let ink = 0; for (let y = A.y1 + 1; y < B.y0; y++) for (let x = a; x < b; x++) if (L[y * w + x] < 60) ink++;
      if (ink >= 10) {
        const pp = []; for (let y = A.y0; y <= B.y1; y++) for (let x = a; x < b; x += 2) { const l = L[y * w + x]; if (l >= 150) pp.push(l); }
        pp.sort((p, q) => p - q); bar = { ya: A.y0, yb: B.y1, a, b, v: pp.length ? pp[pp.length >> 1] : (A.v + B.v) / 2 };
      }
    }
    if (!bar) return null;
    // The fit: the text part of the bar (to its buttons, at most 200 game px), bar grey and black only.
    const sh = bar.yb - bar.ya + 1, sw = Math.min(bar.b - bar.a, Math.round(200 * k0)), S = new Float32Array(sw * sh);
    for (let y = 0; y < sh; y++) for (let x = 0; x < sw; x++) S[y * sw + x] = L[(bar.ya + y) * w + bar.a + x];
    const pv = bar.v, miss = (P) => { let e = 0; for (let i = 0; i < P.v.length; i++) e += Math.min(40, Math.abs(P.v[i]), Math.abs(P.v[i] - pv)); return e; };
    const key = k0.toFixed(3);
    let k = k0 * (barFix.get(key) || 1), best = null;
    if (barFix.has(key)) { barSearches++; best = fitPhase(S, sw, sh, k, miss); }
    else if (barWait.get(key) > 0) { barWait.set(key, barWait.get(key) - 1); barSkips++; return null; }
    else {
      barSearches++;
      // coarse: 4 x 4 phases at each k within 5% (a wrong k leaves every phase far off the palette); then walked downhill
      // from the best one, the phases fitted at each k, in 0.1% and 0.025% steps while the fit improves (0.05% of k is a
      // tenth of a game px across the bar's 200). (A finer grid of 4 x 4 phases instead costs a third less and lands
      // 0.05% off: 1.8729 for 1.8741, fit 1.97 against 0.65.) About 0.3-0.5 s, once per reported k; 35 ms after.
      let c = null;
      for (let j = -12; j <= 12; j++) {
        const kk = k0 * (1 + j * 0.004);
        for (let a = 0; a < 4; a++) for (let b = 0; b < 4; b++) {
          const P = unstretchPlane(S, sw, sh, kk, a / 4, b / 4); if (!P) continue;
          const e = miss(P) / (P.w * P.h); if (!c || e < c.e) c = { e, kk };
        }
      }
      if (c) {
        k = c.kk; best = fitPhase(S, sw, sh, k, miss);
        for (const st of [0.001, -0.001, 0.00025, -0.00025]) for (let i = 0; i < 12 && best; i++) { const kk = k * (1 + st), b = fitPhase(S, sw, sh, kk, miss); if (!b || b.e >= best.e) break; best = b; k = kk; }
      }
      if (best && best.e <= FIT_MAX) barFix.set(key, k / k0); else barWait.set(key, 10);
    }
    // a bilinear stretch fits to under 1 luma a pixel, and to 2-5 through a share's noise (I420 +-4, VP8/VP9 at q10-q30:
    // rec2c's bar frames); a sharp (nearest-pixel) one fits to 16-20, and is not read here
    if (!best || best.e > FIT_MAX) return null;
    // the whole bar from the same corner (so the same phases): its text may run on past the fitted part, and a few rows
    // more go under it (the bar's lower rows are a shade off its grey, so the paper rows found under the text can be
    // only 1 or 2 game px, less than the font's 3 rows under the baseline)
    const fw = Math.min(w - bar.a, Math.round(300 * k0)), fh = Math.min(h - bar.ya, sh + Math.round(4 * k0)), Fl = new Float32Array(fw * fh);
    for (let y = 0; y < fh; y++) for (let x = 0; x < fw; x++) Fl[y * fw + x] = L[(bar.ya + y) * w + bar.a + x];
    const P = unstretchPlane(Fl, fw, fh, k, best.px, best.py);
    return P && Object.assign(P, { k, fit: best.e });
  }
  // A picture the BROWSER enlarged (a window share bigger than the screen: R-YGKB8, a 1080p screen sent 2560x1440;
  // R-8HMCG, 3840x2160): a second smooth stretch on top of the game's own, which the bar's single-stretch fit cannot undo.
  // It is undone first, exactly (the browser's stretch is bilinear and centred: phase 0), back to the screen's size.
  function unenlarge(rgba, W, H, b) {
    const planes = [];
    for (let c = 0; c < 3; c++) {
      const S = new Float32Array(W * H); for (let i = 0; i < W * H; i++) S[i] = rgba[i * 4 + c];
      const P = unstretchPlane(S, W, H, b, 0, 0); if (!P) return null; planes.push(P);
    }
    const w = planes[0].w, h = planes[0].h, out = new Uint8ClampedArray(w * h * 4);
    for (let i = 0; i < w * h; i++) { out[i * 4] = planes[0].v[i]; out[i * 4 + 1] = planes[1].v[i]; out[i * 4 + 2] = planes[2].v[i]; out[i * 4 + 3] = 255; }
    return { width: w, height: h, data: out };
  }
  function readGray(g, W, H, rgba, k0, enlarge) {
    const P = M._P;
    const hd = findHeader(g, W, H, P);
    // the condensed one-line bar: read when no header is found, and also when a header was found but gave no title (a
    // condensed bar in a big frame can match the header template at its smallest scale, 0.62-0.69 at UI scale 0.57-0.61:
    // rec2c's bar frames at x1.874, on a Retina Mac and enlarged by the browser)
    const bar = () => {
      const r = readBar(g, W, H, rgba, k0);
      if (r) return r;
      // the browser's enlargement undone, then the bar read at the screen's scale. Only when the game is still at least
      // its own size on the screen: Chrome's zoom changes devicePixelRatio, not screen.width, so a zoomed-out page reckons
      // a false enlargement (67%: 1.5 for a 1x game) (review of bundle-330). A failed try waits 10 reads (35-200 ms).
      // The waits do not multiply (review of bundle-331): a try that only counted down another wait sets none of its own.
      if (rgba && enlarge > 1.05 && enlarge <= 3 && k0 && k0 / enlarge >= 0.95) {
        if (unWait > 0) { unWait--; barSkips++; return null; }
        const s0 = barSkips, un = unenlarge(rgba, W, H, enlarge);
        if (un) { const t = toGray(un), r2 = readBar(t.g, t.W, t.H, un.data, k0 / enlarge); if (r2) return Object.assign(r2, { enlarged: +enlarge.toFixed(3) }); }
        if (barSkips === s0) unWait = 10;
      }
      return null;
    };
    // every wait counts down on a read that skips the bar, so they run side by side, not one after another
    const tick = () => { if (unWait > 0) unWait--; for (const [kk, v] of barWait) if (v > 0) barWait.set(kk, v - 1); };
    if (!hd) return bar() || { map: null, room: null, why: 'minimap title not found' };
    const T = titleLines(g, W, H, hd, P, rgba);
    if (!T.map) {
      // a header with no title is also a player who hides the map name: after a bar that was searched and failed, the next
      // 10 such reads skip it (a bar() that only counted down a wait searched nothing, and sets no wait of its own)
      let r = null;
      if (hdBarWait > 0) { hdBarWait--; tick(); } else { const s0 = barSkips; r = bar(); hdBarWait = r || barSkips !== s0 ? 0 : 10; }
      return r || { map: null, room: null, why: T.lines.length ? 'map line not found under the street line' : 'minimap shows no title (map name hidden)', scale: +hd.s.toFixed(3) };
    }
    const parts = lineParts(g, W, H, hd, T.xa, T.xb, T.map, P);
    const out = { map: null, room: null, score: null, scale: +hd.s.toFixed(3), header: +hd.v.toFixed(3) };
    if (!parts.nRuns) return Object.assign(out, { why: 'no letters on the map line' });
    // names the templates can spell compete; a name with a letter that has no template is laid over the line too, its
    // unknown letters scored as a good match (unknown_letter): if it could fit as well, no map is returned (a failed
    // check, never a guess: "Free Market <4>" must not come out as "<1>" when "4" has no template)
    const sc = scorer(parts, P, M._glyphs), scU = scorer(parts, P, M._glyphs, P.unknown_letter), wpx = parts.x1 - parts.x0;
    let best = null, second = null, bestU = null;
    const cS = { name: null, rows: null }, cU = { name: null, rows: null };
    for (const nm of M._names) {
      if (wpx < 0.7 * nm.wsum || wpx > 1.4 * nm.wsum) continue;
      const r = alignName(nm.spell ? sc : scU, parts, nm.name, P, nm.spell ? cS : cU); if (!r) continue;
      r.key = r.s - P.letter_base * nm.n; // a letter adds to a name's fit only when it matches better than letter_base
      if (!nm.spell) { if (!bestU || r.key > bestU.key) bestU = Object.assign(r, { name: nm.name }); continue; }
      if (!best || r.key > best.key) { second = best; best = Object.assign(r, { name: nm.name }); }
      else if (!second || r.key > second.key) second = Object.assign(r, { name: nm.name });
    }
    if (!best) return Object.assign(out, { why: 'letters fit no map name' });
    Object.assign(out, { score: +best.mean.toFixed(3), minLetter: +best.min.toFixed(3), runnerUp: second ? second.name : null, margin: second ? +(best.key - second.key).toFixed(3) : null });
    // A strong, unambiguous read is not thrown away for one blurred letter (Grant, 2026-10-18: no map at 1920x1080; every
    // read of "Kerning City Construction Site" in two 1080p recordings had mean 0.91 and a margin of 6.7 over the next
    // name, with one letter at 0.276): its weakest letter may go down to strong_min.
    // Grant's own KCC, live on 2026-10-20 (a 1366x768 window, 1368x800 with its border): mean 0.86 and a margin of 11.9
    // over the next name ("Henesys Free Market <4>"), every frame the same, with one letter at 0.194, under strong_min by
    // 0.006: "letters weak" on every read (and the high-volume sender's "letters weak (best guess Kerning City
    // Construction…)" in the report watch). When the next catalog name is at least strong_wide_margin behind, the weakest
    // letter may go down to strong_wide_min. The review of #313 (14,400 probe reads): every read with a letter at 0.1-0.2
    // and a margin of 5-6.5 was a wrong map, a name missing from the catalog ("Moke Town…" read as "Coke Town Sundry Goods
    // Shop", "Entrance tr…" as "Entrance to…"); none was gained right. So the margin is 10 (Grant's was 11.9), and a read
    // with no runner-up at all never gets the allowance: only part of the catalog is in the width window, so "nothing
    // near" there says little about a name the catalog lacks.
    const margin = second ? best.key - second.key : Infinity;
    const wide = !!second && margin >= P.strong_wide_margin;
    const strong = best.mean >= P.strong_mean && margin >= P.strong_margin && best.min >= (wide ? P.strong_wide_min : P.strong_min);
    if (best.mean < P.min_mean_score || (best.min < P.min_glyph_score && !strong)) return Object.assign(out, { why: 'letters weak (best guess ' + best.name + ')' });
    if (second && best.key - second.key < P.min_margin) {
      // only the room digit is unsure ("Free Market <3>" against "<1>", typical of compressed video): no map from this
      // read, but its best name goes to the watcher's vote (roomGuess), which needs 3 of the last 5 reads to agree
      const b = best.name.match(/^(.*) <(\d{1,2})>$/), c = second.name.match(/^(.*) <(\d{1,2})>$/);
      const guess = b && c && b[1] === c[1] && NAME_RE.test(best.name) ? { roomGuess: best.name } : {};
      return Object.assign(out, guess, { why: 'two map names fit (' + best.name + ', ' + second.name + ')' });
    }
    if (bestU && bestU.key > best.key - P.min_margin) return Object.assign(out, { why: 'a map name with letters not learned yet may fit (' + bestU.name + ')' });
    if (!NAME_RE.test(best.name)) return Object.assign(out, { why: 'not a map name' });
    const rm = best.name.match(/<(\d{1,2})>$/);
    return Object.assign(out, { map: best.name, room: rm ? rm[1] : null, why: 'read' });
  }

  const MesoMapReader = {
    load(maps) {
      M = Object.assign({}, maps); M._P = Object.assign({}, DEF, maps.params || {}); lastScale = null; lastOff = 0; tplCache.clear(); barFix.clear(); barWait.clear(); unWait = 0; hdBarWait = 0; barSkips = 0; barSearches = 0;
      M._header = maps.header ? decodeGray(maps.header) : null;
      if (!M._header) throw new Error('maps.json has no header template');
      M._glyphs = Object.entries(maps.glyphs || {}).map(([ch, t]) => Object.assign(prep(Float32Array.from(t.f)), { ch, w: t.w, wsd: t.wsd || 1 }));
      // names the templates can spell, each with its expected ink width (letters' mean widths, spaces ~ 10 px)
      const gw = new Map(M._glyphs.map(L => [L.ch, L.w]));
      const meanW = M._glyphs.length ? M._glyphs.reduce((a, L) => a + L.w, 0) / M._glyphs.length : 16;
      M._names = (maps.names || []).filter(n => NAME_RE.test(n))
        .map(name => ({ name, n: name.replace(/ /g, '').length, spell: [...name].every(c => c === ' ' || gw.has(c)),
          wsum: [...name].reduce((a, c) => a + (c === ' ' ? 10 : gw.get(c) || meanW), 0) }));
      // the bar's names that are another catalog name less one glyph (I and l compare as one, as the bar reads them)
      const bn = (t) => t.replace(/I/g, 'l'), all = new Set(M._names.map(n => bn(n.name)));
      // short name -> the places in it where the missing glyph would go (its index in the short name)
      M._short = new Map();
      for (const { name } of M._names) for (let i = 0; i < name.length; i++) {
        if (name[i] === ' ') continue;
        const t = bn(name.slice(0, i) + name.slice(i + 1)); if (!all.has(t)) continue;
        if (!M._short.has(t)) M._short.set(t, new Set()); M._short.get(t).add(i);
      }
      return true;
    },
    loaded() { return !!M; },
    // opts.k: the frame's game scale (screen px per game px; watcher() gives the frame's width / 1366), for the collapsed
    // bar in a stretched picture; opts.enlarge: how much the browser enlarged the shared picture past the screen (1: not)
    readMap(imageData, opts) {
      if (!M) return { map: null, room: null, why: 'maps.json not loaded' };
      const t0 = typeof performance !== 'undefined' ? performance.now() : Date.now();
      try {
        const { g, W, H } = toGray(imageData);
        const r = readGray(g, W, H, imageData.data, opts && opts.k > 0 ? opts.k : null, opts && opts.enlarge > 0 ? opts.enlarge : 1);
        r.ms = +(((typeof performance !== 'undefined' ? performance.now() : Date.now()) - t0).toFixed(1));
        return r;
      } catch (e) { return { map: null, room: null, why: 'map reader error: ' + (e && e.message) }; }
    },
    // for the template builder (console/lab/livereader/build_maps.mjs): the reader's own cuts of both title lines
    _parts(imageData) {
      const P = M._P, { g, W, H } = toGray(imageData), rgba = imageData.data, hd = findHeader(g, W, H, P);
      if (!hd) return { hd: null };
      const T = titleLines(g, W, H, hd, P, rgba), cut = (l) => l ? lineParts(g, W, H, hd, T.xa, T.xb, l, P) : null;
      return { hd, T, street: cut(T.street), map: cut(T.map) };
    },
    resetScale() { lastScale = null; lastOff = 0; },
    // for tests: reads left before the next un-enlarged bar try, and the next bar under a header with no title
    _waits: () => ({ un: unWait, hdBar: hdBarWait, bar: Math.max(0, ...barWait.values()), searches: barSearches }),
    // for replay tools: the collapsed bar of a stretched corner on game pixels ({v, w, h, k, fit} or null)
    _unstretchBar: (img, k) => unstretchBar(img.data, img.width, img.height, k),
    // for the builder: lay the label's letters over the line's blobs (letters with no template score `neutral`)
    _alignLabel(parts, label, neutral) {
      const P = M._P, sc = scorer(parts, P, M._glyphs, neutral);
      return alignName(sc, parts, label, P);
    },
    // The top-left corner that readMap expects, cut from a whole game frame (ImageData-like {width, height, data}).
    corner(img) {
      const W = img.width, H = img.height, w = Math.min(W, Math.round(Math.max(0.25 * W, 420))), h = Math.min(H, Math.round(Math.max(0.22 * H, 200)));
      const data = new Uint8ClampedArray(w * h * 4);
      for (let y = 0; y < h; y++) data.set(img.data.subarray(y * W * 4, y * W * 4 + w * 4), y * w * 4);
      return { width: w, height: h, data };
    },
    // Per session: frame(img, ts, gameSeen) reads the corner at most once every `everyMs` (default 1000) and returns
    // {map, room, why, read}. A map is shown after the same name was read `confirm` times in a row (default 3), or,
    // when only the room digit is unsure, once `confirm` of the last `window` reads (default 5) name the same room
    // (an unsure read votes for its best room; one unsure read never picks a room). It stays until another name is
    // confirmed, or the screen goes black (a map change loads through a black screen).
    // why: the last read's reason ("read", "minimap title not found", "letters weak (...)", ...).
    watcher(opts) {
      const every = (opts && opts.everyMs) || 1000, need = (opts && opts.confirm) || 3, win = (opts && opts.window) || 5;
      let at = -Infinity, shown = null, cand = null, n = 0, why = M ? 'not read yet' : 'maps.json not loaded', ms = null, last = null, votes = [], scale = null, scaleOf = null;
      const exact = new Map(); // corner bytes (hash) -> read: an identical corner is never read twice
      const roomOf = (name) => { const m = name.match(/<(\d{1,2})>$/); return m ? m[1] : null; };
      return {
        frame(img, ts, gameSeen, fo) {   // fo.enlarge: the browser's own enlargement of the picture (capture.js)
          if (gameSeen === false) { shown = null; cand = null; n = 0; last = null; votes = []; why = 'black screen (map change?)'; scale = null; scaleOf = null; }
          else if (M && ts - at >= every) {
            at = ts;
            // an unchanged corner (a small grey signature within 3 levels of the last read's) repeats the last answer
            // without reading again: the title rarely changes, and the read costs tens of ms on the page's thread
            const c = MesoMapReader.corner(img), sg = signature(c);
            let r; const hk = bytesKey(c.data);
            if (exact.has(hk)) r = Object.assign({}, exact.get(hk), { ms: 0 });
            // ... but only while it cannot confirm anything new: a repeat of a read that names a map other than the one shown
            // (or an unsure room's guess) is read afresh, so one wrong read is not counted 3 times (review of bundle-331)
            else if (last && sigDist(sg, last.sg) < 3 && (shown ? last.r.map === shown.map || (!last.r.map && !last.r.roomGuess) : !last.r.map && !last.r.roomGuess)) r = Object.assign({}, last.r, { ms: 0 });
            else {
              // the game scale as capture.js reckons it (the game's UI is 1366 x 768 game px), a few percent high in a
              // window share (its border and title bar); readBar searches near it
              r = MesoMapReader.readMap(c, { k: Math.min(img.width / 1366, img.height / 768), enlarge: fo && fo.enlarge > 0 ? fo.enlarge : 1 }); last = { sg, r };
              exact.set(hk, r); if (exact.size > 64) exact.delete(exact.keys().next().value);
            }
            // scale: this read's own (never an older read's), and whose: the minimap header's UI scale, or the condensed bar's
            // game px size (review of bundle-330)
            why = r.why; ms = r.ms; scale = r.scale ?? null; scaleOf = r.scale == null ? null : r.bar ? 'bar' : 'header';
            if (r.map) {
              if (cand && cand.map === r.map) n++; else { cand = { map: r.map, room: r.room }; n = 1; }
              if (n >= need) shown = cand;
            }
            // the vote over the last `win` reads: a sure read and an unsure room's best guess both count
            const v = r.map || r.roomGuess || null;
            if (v || /two map names fit/.test(r.why || '')) { votes.push(v); if (votes.length > win) votes.shift(); }
            if (v && !(shown && shown.map === v) && votes.filter(x => x === v).length >= need) shown = { map: v, room: roomOf(v) };
            // once a map is shown, an unsure room read is no news: its reason is not passed on ("read" stands for it)
            if (shown && /two map names fit/.test(why || '')) why = 'read';
          } else if (!M) why = 'maps.json not loaded';
          return { map: shown ? shown.map : null, room: shown ? shown.room : null, why, ms, scale, scaleOf };
        },
      };
    },
    DEFAULTS: DEF,
  };
  root.MesoMapReader = MesoMapReader;
  if (typeof module !== 'undefined' && module.exports) module.exports = MesoMapReader;
})(typeof self !== 'undefined' ? self : globalThis);

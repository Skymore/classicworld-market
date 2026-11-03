/* MesoWatch live reader, part A: read ONE shop row picture with the glyph atlas (no OCR model, no network).

   self.MesoRowReader = { load(atlas), readRow(imageData) }

   readRow returns {price, qty, nameText, sold, confidence, abstain, why, scale}:
   - price, qty: whole numbers, or null when not read. abstain = true whenever price or qty is null or the
     confidence is under the atlas's min_margin. The caller must not use a row that abstains.
   - confidence: the smallest margin (best digit score minus second-best) over the price digits.
   - sold: true when the offer text is greyed (its darkest pixels are lighter than canonical.sold_text_luma).
   - nameText: null until the atlas has letters. nameWhy: "read", "letters weak", "no name text", "name line not found"
     or "scale out of range" (see nameWhy below).
   readRow(imageData, {scale}) searches near the caller's scale first. The row's width (369 px at scale 1) bounds the
   scale search in any case. Rows read one after another in one shop take the scale lock: the last row's fine scale
   and line height are tried first (canonical.lock_scales around it), which skips most of the search.

   How it reads (the same steps as the laptop's digit matcher, console/ocr/digits):
   1. Find the word "mesos" at any scale s (normalised correlation), then "for" on the same line.
   2. Resample the offer line to canonical px (the row enlarged up/s), where one digit is 39 px wide.
   3. The distance between "for" and "mesos" gives the number of digits and commas; abstain if it does not fit.
   4. Compare each digit cell with the atlas digits; quantity cells are read right to left from "for".
   Plain JS, no DOM: works in a Web Worker and in node (tests). */
(function (root) {
  'use strict';
  let A = null;           // loaded atlas
  let lastScale = null;   // a player's scale rarely changes: try it first
  let lastFine = null;    // the last read row's fine scale, coarse "mesos" height and size (the scale lock)
  const coarseCache = new Map();

  function decodeGray(g) {
    const bin = typeof atob === 'function' ? atob(g.gray) : Buffer.from(g.gray, 'base64').toString('binary');
    const a = new Float32Array(g.w * g.h);
    for (let i = 0; i < a.length; i++) a[i] = bin.charCodeAt(i);
    return { w: g.w, h: g.h, d: a };
  }

  // Separable resample with a triangle filter (bilinear when enlarging, area-like when shrinking).
  function resample(src, sw, sh, dw, dh, sx0 = 0, sy0 = 0, sxw = sw, syh = sh) {
    function weights(sn, s0, sLen, dn) {
      const f = sLen / dn, sup = Math.max(1, f), out = [];
      for (let o = 0; o < dn; o++) {
        const c = s0 + (o + 0.5) * f - 0.5;
        const lo = Math.floor(c - sup), hi = Math.ceil(c + sup);
        const idx = [], w = []; let tot = 0;
        for (let i = lo; i <= hi; i++) {
          const t = 1 - Math.abs(i - c) / sup;
          if (t <= 0) continue;
          idx.push(Math.min(sn - 1, Math.max(0, i))); w.push(t); tot += t;
        }
        out.push({ idx, w: w.map(v => v / tot) });
      }
      return out;
    }
    const wx = weights(sw, sx0, sxw, dw), wy = weights(sh, sy0, syh, dh);
    const tmp = new Float32Array(sh * dw);
    for (let y = 0; y < sh; y++) {
      const r = y * sw;
      for (let x = 0; x < dw; x++) {
        const { idx, w } = wx[x]; let v = 0;
        for (let k = 0; k < idx.length; k++) v += src[r + idx[k]] * w[k];
        tmp[y * dw + x] = v;
      }
    }
    const out = new Float32Array(dh * dw);
    for (let y = 0; y < dh; y++) {
      const { idx, w } = wy[y];
      for (let x = 0; x < dw; x++) {
        let v = 0;
        for (let k = 0; k < idx.length; k++) v += tmp[idx[k] * dw + x] * w[k];
        out[y * dw + x] = v;
      }
    }
    return out;
  }

  function prepTemplate(t) {
    const n = t.w * t.h; let m = 0;
    for (let i = 0; i < n; i++) m += t.d[i];
    m /= n;
    const z = new Float32Array(n); let ss = 0;
    for (let i = 0; i < n; i++) { z[i] = t.d[i] - m; ss += z[i] * z[i]; }
    return { w: t.w, h: t.h, z, norm: Math.sqrt(ss) };
  }

  // Normalised correlation (TM_CCOEFF_NORMED) of template T over img at top-left positions x0..x1, y0..y1.
  // The window's sum and sum of squares come from integral images (built once per image, kept while the image lives),
  // so each position costs one pass of multiply-adds over the template (2026-10-16: about 2x faster, same scores).
  const integrals = new WeakMap();
  function integral(img, W, H) {
    let I = integrals.get(img);
    if (I && I.W === W) return I;
    const W1 = W + 1, s1 = new Float64Array(W1 * (H + 1)), s2 = new Float64Array(W1 * (H + 1));
    for (let y = 0; y < H; y++) {
      let r1 = 0, r2 = 0;
      for (let x = 0; x < W; x++) {
        const v = img[y * W + x]; r1 += v; r2 += v * v;
        s1[(y + 1) * W1 + x + 1] = s1[y * W1 + x + 1] + r1; s2[(y + 1) * W1 + x + 1] = s2[y * W1 + x + 1] + r2;
      }
    }
    I = { W, s1, s2 }; integrals.set(img, I); return I;
  }
  function bestMatch(img, W, H, T, x0 = 0, x1 = W - T.w, y0 = 0, y1 = H - T.h, step = 1) {
    x0 = Math.max(0, x0); y0 = Math.max(0, y0); x1 = Math.min(W - T.w, x1); y1 = Math.min(H - T.h, y1);
    let best = { v: -1, x: 0, y: 0 };
    if (x1 < x0 || y1 < y0 || T.norm === 0) return best;
    const n = T.w * T.h, I = integral(img, W, H), W1 = W + 1, tw = T.w, th = T.h, z = T.z;
    for (let y = y0; y <= y1; y += step) {
      for (let x = x0; x <= x1; x += step) {
        const a = y * W1 + x, b = a + tw, c = a + th * W1, d = c + tw;
        const s1 = I.s1[d] - I.s1[b] - I.s1[c] + I.s1[a], s2 = I.s2[d] - I.s2[b] - I.s2[c] + I.s2[a];
        const varI = s2 - s1 * s1 / n;
        if (varI <= 1e-6) continue;
        let s = 0, k = 0;
        for (let ty = 0; ty < th; ty++) {
          let r = (y + ty) * W + x;
          for (let tx = 0; tx < tw; tx++) s += img[r++] * z[k++];
        }
        const v = s / (Math.sqrt(varI) * T.norm);
        if (v > best.v) best = { v, x, y };
      }
    }
    return best;
  }

  // Search every 2nd position, then every position within 2 px of the best (4x fewer correlations).
  // The same with a coarser first pass (every k-th position, then every position within k px of the best).
  function bestMatchStep(img, W, H, T, x0, x1, y0, y1, k) {
    const b = bestMatch(img, W, H, T, x0, x1, y0, y1, k);
    if (b.v < 0) return b;
    return bestMatch(img, W, H, T, Math.max(x0, b.x - k), Math.min(x1, b.x + k), Math.max(y0, b.y - k), Math.min(y1, b.y + k));
  }
  function bestMatch2(img, W, H, T, x0 = 0, x1 = W - T.w, y0 = 0, y1 = H - T.h) {
    const b = bestMatch(img, W, H, T, x0, x1, y0, y1, 2);
    if (b.v < 0) return b;
    return bestMatch(img, W, H, T, Math.max(x0, b.x - 2), Math.min(x1, b.x + 2), Math.max(y0, b.y - 2), Math.min(y1, b.y + 2));
  }

  function coarseTemplate(s) {
    const key = s.toFixed(4);
    if (!coarseCache.has(key)) {
      const m = A._mesos, f = s / A.canonical.up;
      const w = Math.max(3, Math.round(m.w * f)), h = Math.max(3, Math.round(m.h * f));
      coarseCache.set(key, prepTemplate({ w, h, d: resample(m.d, m.w, m.h, w, h) }));
    }
    return coarseCache.get(key);
  }

  function scales() {
    const c = A.canonical, out = [];
    for (let s = c.scale_min; s <= c.scale_max + 1e-9; s *= 1.06) out.push(s);
    return out;
  }

  // Large scales are searched on the row shrunk 2x (4x fewer pixels); the hit only seeds the canonical search.
  function coarse(g, W, H, list) {
    let best = { v: -1 }, half = null;
    for (const s of list) {
      const useHalf = s >= 1.1;
      if (useHalf && !half) {
        const w2 = Math.max(1, Math.round(W / 2)), h2 = Math.max(1, Math.round(H / 2));
        half = { d: resample(g, W, H, w2, h2), w: w2, h: h2 };
      }
      const T = coarseTemplate(useHalf ? s / 2 : s);
      const img = useHalf ? half : { d: g, w: W, h: H };
      if (T.w > img.w || T.h > img.h) continue;
      const b = T.w * T.h >= 120 ? bestMatch2(img.d, img.w, img.h, T) : bestMatch(img.d, img.w, img.h, T);
      const f = useHalf ? W / img.w : 1;
      if (b.v > best.v) best = { v: b.v, x: b.x * f, y: b.y * f, s };
    }
    return best;
  }

  // The speed helper's scale hint (2026-10-16): the word "mesos" at 3 scales around the caller's scale (measured on
  // Grant's 1080p recordings: the reader's scale is 1.00-1.02 x the window's UI scale). null when none matches well.
  function hintedCoarse(g, W, H, s0) {
    const h = coarse(g, W, H, [s0 * 0.995, s0 * 1.01, s0 * 1.025]);
    return h.v >= 0.7 ? h : null;
  }

  // The offer line at canonical scale for scale s, with the coarse hit's expected position in it.
  function canonicalBand(g, W, H, hit, s) {
    const c = A.canonical, up = c.up, th = A._mesos.h;
    const ya = Math.max(0, hit.y - c.band_above * s / up), yb = Math.min(H, hit.y + (th + c.band_below) * s / up);
    const k = up / s, dw = Math.round(W * k), dh = Math.round((yb - ya) * k);
    if (dh < th || dw < A._mesos.w) return null;
    const d = resample(g, W, H, dw, dh, 0, ya, W, yb - ya);
    return { d, w: dw, h: dh, ex: hit.x * k, ey: (hit.y - ya) * k, ya };
  }

  function windowPatch(gc, x, y, jx, jy, w) {
    const c = A.canonical, H = gc.h, W = gc.w;
    const x0 = Math.round(x) - jx, y0 = Math.round(y) - jy, pw = w + 2 * jx, ph = c.cell_h + 2 * jy;
    const x1 = x0 + pw;
    if (x1 <= 0 || x0 >= W) return null;
    if (-x0 > Math.floor(w / 2) || x1 - W > Math.floor(w / 2)) return null;
    const d = new Float32Array(pw * ph);
    for (let yy = 0; yy < ph; yy++) {
      const sy = Math.min(H - 1, Math.max(0, y0 + yy));
      for (let xx = 0; xx < pw; xx++) {
        const sx = Math.min(W - 1, Math.max(0, x0 + xx));
        d[yy * pw + xx] = gc.d[sy * W + sx];
      }
    }
    return { d, w: pw, h: ph };
  }

  function innerStd(p, jx, jy) {
    let s1 = 0, s2 = 0, n = 0;
    for (let y = jy; y < p.h - jy; y++) for (let x = jx; x < p.w - jx; x++) { const v = p.d[y * p.w + x]; s1 += v; s2 += v * v; n++; }
    if (!n) return 0;
    const m = s1 / n;
    return Math.sqrt(Math.max(0, s2 / n - m * m));
  }

  function classify(p, kl) {
    const sc = [];
    for (let d = 0; d <= 9; d++) {
      const T = A._digits[kl][d];
      if (!T) continue;
      sc.push([bestMatch(p.d, p.w, p.h, T).v, String(d)]);
    }
    sc.sort((a, b) => b[0] - a[0]);
    return { d: sc[0][1], score: sc[0][0], second: sc[1][1], margin: sc[0][0] - sc[1][0] };
  }

  function pickLayout(F, M) {
    const c = A.canonical, G = M - F - c.gap0, cand = [];
    for (let n = 1; n <= 12; n++) {
      const ks = new Set([0, Math.floor((n - 1) / 3)]);
      for (const k of ks) cand.push([Math.abs(G - c.layout_adv * n - c.comma_w * k), n, k]);
    }
    cand.sort((a, b) => a[0] - b[0]);
    return { n: cand[0][1], k: cand[0][2], res: cand[0][0], res2: cand[1][0] };
  }

  function cellsBetween(F, M, n, k) {
    const c = A.canonical, start = F + c.for_to_digit, end = M - c.digit_to_mesos;
    const adv = (end - start - c.comma_w * k) / n, xs = [];
    let x = start;
    for (let i = 0; i < n; i++) {
      if (k && i && (n - i) % 3 === 0) x += c.comma_w;
      xs.push(x + (adv - c.digit_adv) / 2); x += adv;
    }
    return xs;
  }

  function percentile(arr, q) {
    const a = Array.from(arr).sort((x, y) => x - y);
    return a.length ? a[Math.min(a.length - 1, Math.floor(q * a.length))] : null;
  }


  // ---------------------------------------------------------------- item name (letters)
  // The name line sits above the offer line. Its band is resampled to nk/s px per row px, turned into an ink map
  // (1 = text) relative to the band's own background and darkest text (so greyed sold rows read too), cut into ink
  // blobs at empty columns, and each blob is matched to the letter templates. A blob wider than one letter may be
  // split into 2-4 letters when that fits better. A gap of `space` px or more is a space; a gap over 24 px ends the name.
  function nameBand(g, W, H, line, s) {
    const N = A.letters, y0 = Math.max(0, Math.round(line.y0 - N.band_top * s)), y1 = Math.min(H, Math.round(line.y0 - N.band_bottom * s));
    const x0 = Math.max(0, Math.round((N.band_left_of_qty != null && line.qx0 != null ? line.qx0 - N.band_left_of_qty * s : line.x0 - N.band_left * s))), x1 = Math.min(W, Math.round(line.x0 + (N.band_right ?? 1e6) * s));
    if (y1 - y0 < 4 || x1 - x0 < 8) return null;
    const sw = x1 - x0, sh = y1 - y0, sub = new Float32Array(sw * sh);
    for (let y = 0; y < sh; y++) for (let x = 0; x < sw; x++) sub[y * sw + x] = g[(y0 + y) * W + x0 + x];
    const k = N.nk / s, w = Math.round(sw * k), h = Math.round(sh * k);
    if (w < 8 || h < 8) return null;
    return { d: resample(sub, sw, sh, w, h), w, h, x0, y0, y1, yTop: N.name_top != null ? (line.y0 - N.name_top * s - y0) * k : null };
  }
  function inkMap(b) {
    const a = Array.from(b.d).sort((x, y) => x - y);
    let bg = a[Math.floor(a.length * 0.6)], dark = a[Math.floor(a.length * 0.01)];
    if (A.letters.ink_bg === 'mode') {
      // A tooltip or the cursor over the band's right part pulls the 60th percentile off the paper, and every letter
      // then reads too bold. The paper is the most common grey (4-level bins); the text's dark is the 1st percentile
      // of the band's left 60% (where every name starts).
      const hist = new Uint32Array(64); for (const v of b.d) hist[Math.min(63, v >> 2)]++;
      let mi = 0; for (let i = 1; i < 64; i++) if (hist[i] > hist[mi]) mi = i;
      bg = mi * 4 + 2;
      const L = [], xw = Math.round(b.w * 0.6); for (let y = 0; y < b.h; y++) for (let x = 0; x < xw; x++) L.push(b.d[y * b.w + x]);
      L.sort((x, y) => x - y); dark = L[Math.floor(L.length * 0.01)];
    }
    const span = bg - dark;
    if (span < A.letters.min_contrast) return null;
    const m = new Float32Array(b.d.length);
    for (let i = 0; i < m.length; i++) m[i] = Math.min(1, Math.max(0, (bg - b.d[i]) / span * 1.6 - 0.3));
    return m;
  }
  function inkBlobs(b, m, thr) {
    const T = thr ?? 0.5;
    const { w, h } = b, rp = new Float32Array(h);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) rp[y] += m[y * w + x] > T;
    // only rows near where the name's capitals start (from the offer line) can hold the name
    if (b.yTop != null) for (let y = 0; y < h; y++) if (y < b.yTop - 6 || y > b.yTop + A.letters.fh) rp[y] = 0;
    // a row of ink across most of the band is a border or a highlight edge, not text: blank it
    for (let y = 0; y < h; y++) if (rp[y] > 0.5 * w) { rp[y] = 0; for (let x = 0; x < w; x++) m[y * w + x] = 0; }
    let best = null, cur = null;
    for (let y = 0; y <= h; y++) {
      const on = y < h && rp[y] >= 1;
      if (on && !cur) cur = { a: y, n: 0 };
      if (on) cur.n += rp[y];
      if (!on && cur) { cur.b = y; if (!best || cur.n > best.n) best = cur; cur = null; }
    }
    if (!best) return null;
    const ya = best.a, cp = new Float32Array(w);
    for (let x = 0; x < w; x++) for (let y = ya; y < best.b; y++) cp[x] += m[y * w + x] > T;
    const raw = []; let st = -1;
    for (let x = 0; x <= w; x++) {
      const on = x < w && cp[x] >= 1;
      if (on && st < 0) st = x;
      if (!on && st >= 0) { let n = 0; for (let i = st; i < x; i++) n += cp[i]; if (n >= 3) raw.push([st, x]); st = -1; }
    }
    const cols = [];
    for (const c of raw) { if (cols.length && c[0] - cols[cols.length - 1][1] > 24) break; cols.push(c); }
    return { ya, cols };
  }
  function glyphFeat(b, m, ya, c0, c1) {
    const N = A.letters, w = c1 - c0, sub = new Float32Array(w * N.fh);
    for (let y = 0; y < N.fh; y++) { const yy = ya + y; if (yy >= b.h) break; for (let x = 0; x < w; x++) sub[y * w + x] = m[yy * b.w + c0 + x]; }
    return { f: resample(sub, w, N.fh, N.gw, N.gh), w };
  }
  function ncc1(a, t) { // t: prepared {z, norm}
    let ma = 0; for (let i = 0; i < a.length; i++) ma += a[i]; ma /= a.length;
    let s = 0, sa = 0; for (let i = 0; i < a.length; i++) { const x = a[i] - ma; s += x * t.z[i]; sa += x * x; }
    return sa && t.norm ? s / Math.sqrt(sa) / t.norm : 0;
  }
  function readName(g, W, H, line, s) {
    if (!A.letters) return { text: null, why: 'no letters in the atlas' };
    const b = nameBand(g, W, H, line, s);
    if (!b) return { text: null, why: 'name band outside the row' };
    return recognize(b);
  }
  // Letters in a band already at the letters' scale (dark text on a light ground).
  function recognize(b, minScore, letters, splitMinW) {
    const LS = letters || A._letters;
    const N = A.letters;
    const m = inkMap(b);
    if (!m) return { text: null, why: 'name band has no text contrast' };
    const B = inkBlobs(b, m, b.thr);
    if (!B || !B.cols.length) return { text: null, why: 'no name text' };
    const memo = new Map();
    function best(ya, c0, c1, strict) {
      const key = (ya * 4096 + c0) * 4096 + c1 + (strict ? 0.5 : 0);
      if (memo.has(key)) return memo.get(key);
      const { f, w } = glyphFeat(b, m, ya, c0, c1);
      let top = { ch: '?', s: -9 }, sec = -9;
      for (const L of LS) {
        if (strict && Math.abs(w - L.w) > Math.max(2, N.width_tol * L.wsd)) continue;
        const v = ncc1(f, L) - N.width_cost * Math.abs(w - L.w);
        if (v > top.s) { sec = top.s; top = { ch: L.ch, s: v }; } else if (v > sec) sec = v;
      }
      top.margin = top.s - sec; memo.set(key, top); return top;
    }
    function decode(ya) {
      let text = ''; const scores = [];
      B.cols.forEach((c, i) => {
        if (i && c[0] - B.cols[i - 1][1] >= N.space) text += ' ';
        const n = c[1] - c[0], dp = new Array(n + 1).fill(null); dp[0] = { s: 0, parts: [] };
        for (let e = 1; e <= n; e++) for (let st = Math.max(0, e - 22); st <= e - 3; st++) {
          if (!dp[st] || dp[st].parts.length >= 4) continue;
          const gl = best(ya, c[0] + st, c[0] + e, true), v = dp[st].s + (gl.s - 1) - (dp[st].parts.length ? N.split_cost : 0);
          if (!dp[e] || v > dp[e].s) dp[e] = { s: v, parts: dp[st].parts.concat([gl]) };
        }
        const one = best(ya, c[0], c[1], false);
        const pick = dp[n] && dp[n].parts.length > 1 && dp[n].s > one.s - 1 && n > (splitMinW || 0) ? dp[n].parts : [one];
        for (const gl of pick) { text += gl.ch; scores.push(gl.s); }
      });
      return { text, ya, mean: scores.reduce((a, v) => a + v, 0) / scores.length };
    }
    // The letters' top row comes from the tallest run of inked rows; on some rows (a highlight edge, an icon's
    // outline) it lands a few px off and every letter misreads. When the read is weak, try the top a few px up and down.
    // ya_pick: choose the top row by how well the first 3 blobs match as whole letters, among B.ya +- ya_pick and
    // the top the offer line predicts (b.yTop); a cheap check that catches a top a few px off on most rows
    let ya0 = B.ya;
    if (N.ya_pick) {
      const cand = new Set(); for (let d = -N.ya_pick; d <= N.ya_pick; d++) { cand.add(B.ya + d); if (b.yTop != null) cand.add(Math.round(b.yTop) + d); }
      let bs = -Infinity; const first = B.cols.slice(0, 3);
      for (const ya of cand) {
        if (ya < 0 || ya + N.fh > b.h + 4) continue;
        let t = 0; for (const c of first) t += best(ya, c[0], c[1], false).s;
        if (t > bs + 1e-9 || (Math.abs(t - bs) <= 1e-9 && ya === B.ya)) { bs = t; ya0 = ya; }
      }
    }
    let r = decode(ya0);
    const minS = minScore ?? N.min_mean_score, yS = N.ya_search || 0;
    for (let d = 1; d <= yS && r.mean < minS; d++) for (const ya of [ya0 - d, ya0 + d]) {
      if (ya < 0 || ya + N.fh > b.h + 4) continue;
      const t = decode(ya); if (t.mean > r.mean) r = t;
    }
    const text = r.text, mean = r.mean;
    const info = { band: [b.x0, b.y0, b.y1], blobs: B.cols.length, ya: r.ya, first: B.cols[0], guess: text };
    if (mean < (minScore ?? N.min_mean_score)) return { text: null, why: 'letters match too weakly', score: mean, info };
    return { text, score: mean, info };
  }


  // ---------------------------------------------------------------- seller (the name tag in the player store window)
  // The seller's name tag is a dark box with light text. Find the box (rows and columns that are mostly dark), turn it
  // light-on-dark into dark-on-light, then read it with the same letters as item names. The scale comes from the rows
  // read in this shop (lastScale), else from the area's width (the seller area is 236 px wide at scale 1).
  let PARTS = null; // set by _sellerParts (atlas builder only)
  function readSellerGray(g, W, H, s) {
    if (!A.letters) return { text: null, why: 'no letters in the atlas' };
    const S = A.letters.seller || {}, dark = S.dark_luma ?? 110, minRun = (S.min_run ?? 20) * s;
    const runOf = (y) => { let best = 0, cur = 0, a = 0, ba = 0; for (let x = 0; x < W; x++) { if (g[y * W + x] < dark) { if (!cur) a = x; cur++; if (cur > best) { best = cur; ba = a; } } else cur = 0; } return [best, ba]; };
    const rowsOk = []; for (let y = 0; y < H; y++) rowsOk.push(runOf(y)[0] >= minRun);
    let best = null, st = -1;
    for (let y = 0; y <= H; y++) { const on = y < H && rowsOk[y]; if (on && st < 0) st = y; if (!on && st >= 0) { const h = y - st; if (h >= 8 * s && h <= 30 * s && (!best || h > best.h)) best = { a: st, b: y, h }; st = -1; } }
    if (!best) return { text: null, why: 'no name tag found' };
    // tag columns: the longest dark run on the tag's top and bottom rows (no letters there)
    let cb = null;
    for (const y of [best.a, best.a + 1, best.b - 2, best.b - 1]) { const [n, a] = runOf(y); if (!cb || n > cb[1] - cb[0]) cb = [a, a + n]; }
    if (!cb || cb[1] - cb[0] < minRun) return { text: null, why: 'no name tag found' };
    const pad = Math.round(1 * s), x0 = cb[0] + pad, x1 = cb[1] - pad, y0 = best.a, y1 = best.b;
    const sw = x1 - x0, sh = y1 - y0;
    if (sw < 6 || sh < 6) return { text: null, why: 'name tag too small' };
    const sub = new Float32Array(sw * sh);
    for (let y = 0; y < sh; y++) for (let x = 0; x < sw; x++) sub[y * sw + x] = 255 - g[(y0 + y) * W + x0 + x];
    // centre the text band in a frame as tall as the item name band so the letters' vertical cut matches
    const k = A.letters.nk / s, w = Math.round(sw * k), h = Math.round(sh * k);
    const d = resample(sub, sw, sh, w, h);
    const H2 = Math.max(h, A.letters.fh + 8), off = Math.floor((H2 - h) / 2), d2 = new Float32Array(w * H2);
    let bgv = 0; { const a = Array.from(d).sort((p, q) => p - q); bgv = a[Math.floor(a.length * 0.6)]; }
    d2.fill(bgv); for (let y = 0; y < h; y++) d2.set(d.subarray(y * w, (y + 1) * w), (y + off) * w);
    const r = recognize({ d: d2, w, h: H2, x0, y0, y1, yTop: null, thr: S.ink_thr }, S.min_mean_score, A._sellerLetters && A._sellerLetters.length ? A._sellerLetters : null, S.split_min_w);
    if (PARTS) { PARTS.b = { d: d2, w, h: H2 }; }
    return Object.assign(r, { tag: [x0, y0, x1, y1] });
  }

  function toGray(img) {
    const { width: W, height: H, data } = img, g = new Float32Array(W * H);
    for (let i = 0, j = 0; i < g.length; i++, j += 4) g[i] = 0.299 * data[j] + 0.587 * data[j + 1] + 0.114 * data[j + 2];
    return { g, W, H };
  }

  // Rows cut a few px too high lose the bottom of the offer line's margin (seen at UI scales other than 1080p's).
  // Add canonical.pad_bottom x the row's height of plain row background below the picture, so the price line's search
  // band fits. The background is the 60th percentile of the bottom 3 rows (the paper, not the text).
  function padBottom(t) {
    const f = A.canonical.pad_bottom || 0, P = Math.round(f * t.H);
    if (P < 1) return t;
    const { g, W, H } = t, last = Array.from(g.subarray(Math.max(0, H - 3) * W)).sort((a, b) => a - b), bg = last[Math.floor(last.length * 0.6)];
    const out = new Float32Array(W * (H + P)); out.set(g); out.fill(bg, W * H);
    return { g: out, W, H: H + P };
  }
  // Why the item name is missing, in one of a few words for the live log: "read", "letters weak" (the letters did not
  // match well enough), "no name text" (the band above the price holds no text), "name line not found" (the price line
  // that places the name was not found), "scale out of range" (the row's scale did not match its size).
  function nameWhy(nm) { return nm.text != null ? 'read' : nm.why === 'letters match too weakly' ? 'letters weak' : nm.why === 'name band outside the row' ? 'name line not found' : 'no name text'; }
  function fail(why, extra) { return Object.assign({ price: null, qty: null, nameText: null, nameWhy: 'name line not found', sold: null, confidence: 0, abstain: true, why }, extra || {}); }

  // ---------------------------------------------------------------- exact reading (font.js)
  // At a whole-number UI scale the shop's text is a 1-bit pixel font on flat colors, so a clean row reads exactly,
  // glyph by glyph, with no scores (self.MesoShopFont, font.js). Measured on a 1366x768 recording at UI scale 1, in
  // this file's luma (0.299/0.587/0.114), within a row box of 262 x 38 game px: an unsold row is ink 0 on paper 215, a
  // sold row ink 187 on paper 244 (its last row and column stay 215); the underline between the lines is 255. A row with
  // any other color in its text box has the cursor or a tooltip over it: it is skipped in this frame and read in a
  // later one. readExact returns null when the row is not at a whole-number scale, its paper is neither, or a glyph is
  // missing from the font; readRow then reads it the old way.
  const EX = { ROW_W: 262, X0: 41, X1: 203, Y0: 2, PAPER: { unsold: 215, sold: 244 }, INK: { unsold: 0, sold: 187 }, INK_TOL: { unsold: 40, sold: 12 }, TOL: 6, LIGHT: 250 };   // sold ink stays clear of the unfaded 215
  let FONT_KEYS = null;
  function fontKeys() {
    if (FONT_KEYS) return FONT_KEYS;
    // the font: font.js (self.MesoShopFont, pull request 207) when loaded, else the copy in atlas.json ("exact")
    const E = A && A.exact;
    const F = root.MesoShopFont && root.MesoShopFont.FONT ? root.MesoShopFont : E && E.font ? { FONT: E.font, ABOVE: E.above, BELOW: E.below } : null;
    if (!F) return null;
    FONT_KEYS = { map: new Map(Object.entries(F.FONT).map(([ch, rows]) => [rows.join('/'), ch])), list: Object.entries(F.FONT), above: F.ABOVE, below: F.BELOW };
    return FONT_KEYS;
  }
  // The row in game pixels (the centre of each k x k block) as luma, or null when it is not k whole game pixels wide.
  function gamePixels(img) {
    const k = Math.round(img.width / EX.ROW_W);
    if (k < 1 || k > 4 || Math.abs(img.width - EX.ROW_W * k) > k) return null;
    const W = Math.floor(img.width / k), H = Math.floor(img.height / k), d = img.data, o = k >> 1, Y = new Uint8Array(W * H);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const i = ((y * k + o) * img.width + x * k + o) * 4;
      Y[y * W + x] = Math.round(0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2]);
    }
    return { Y, W, H, k };
  }
  // The text of one glyph run: a glyph, or 2-4 touching glyphs ("tt", "Ax", "XXZZ"), or null.
  function splitRun(rows, F, depth) {
    const key = rows.join('/'), hit = F.map.get(key);
    if (hit) return hit;
    if (depth >= 3) return null;   // up to 4 touching glyphs ("XXZZ")
    const w = rows[0].length;
    for (const [ch, g] of F.list) {
      const gw = g[0].length;
      if (gw >= w || !rows.every((r, y) => r.slice(0, gw) === g[y])) continue;
      const rest = splitRun(rows.map((r) => r.slice(gw)), F, depth + 1);
      if (rest) return ch + rest;
    }
    return null;
  }
  // One text line on baseline `base`: glyph runs split at blank columns. A gap of 3+ columns is a space, 6+ after a
  // "1" (whose glyph leaves extra room on its right). A run the font cannot spell is "?" (counted in `unknown`).
  function exactLine(ink, x0, x1, base, F) {
    const top = base - F.above, band = F.above + 1 + F.below;
    const col = (x) => { for (let y = top; y < top + band; y++) if (ink(x, y)) return true; return false; };
    let text = '', x = x0, last = null, n = 0, unknown = 0, start = null;
    const gaps = [];   // the blank columns of each space, in order
    while (x < x1) {
      if (!col(x)) { x++; continue; }
      const a = x; while (x < x1 && col(x)) x++;
      if (start == null) start = a;
      const rows = [];
      for (let y = top; y < top + band; y++) { let s = ''; for (let c = a; c < x; c++) s += ink(c, y) ? '#' : '.'; rows.push(s); }
      const ch = splitRun(rows, F, 0) || '?';
      if (ch === '?') unknown++;
      if (last != null && a - last.end >= (last.ch.endsWith('1') ? 6 : 3)) { text += ' '; gaps.push(a - last.end); }
      text += ch; last = { end: x, ch }; n++;
    }
    return n ? { text, unknown, n, end: last.end, start, gaps } : null;
  }
  // Capital I and lowercase l share a glyph. In item names it is I at the start of a word (no catalog word starts with
  // "l"), between two capitals ("STR"-like words), and in a word of only that glyph; else l ("El", "Gold").
  function fixIl(text) {
    return text.replace(/\S+/g, (w) => /^l+$/.test(w) ? w.replace(/l/g, 'I')
      : w.replace(/l/g, (m, i) => (i === 0 || (/[A-Z]/.test(w[i - 1] || '') && /[A-Z]/.test(w[i + 1] || '')) ? 'I' : m)));
  }
  // A quantity of 1,000 or more is shown with commas, as prices are ("1,000 for 45,000 mesos"): read as one number. A
  // quantity without them (1-4 digits) reads as before.
  const OFFER = /^(\d{1,4}|\d{1,3}(?:,\d{3})+) for (\d{1,3}(?:,\d{3})*) (?:m(?:e(?:s(?:o(?:s)?)?)?)?)?(?:\.\.\.)?$/;
  // The seller's name tag (player store): white text (255) on a dark tag (luma 43-54 at UI scale 1), 15 x 85 game px
  // inside its light border, somewhere in capture.js's seller area. The tag is the longest run of rows that are mostly
  // dark; its game px scale k from its height. Read with the font like a row; null unless every glyph reads. Player
  // names use I or l anywhere (one glyph), read as in item names (fixIl), so "Ikee"/"lkee" stays a guess.
  function readSellerExact(img) {
    const F = fontKeys(); if (!F) return null;
    const W = img.width, H = img.height, d = img.data;
    const L = (x, y) => { const i = (y * W + x) * 4; return 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2]; };
    const dark = (v) => v >= 35 && v <= 70;
    const rowDark = []; for (let y = 0; y < H; y++) { let n = 0; for (let x = 0; x < W; x++) if (dark(L(x, y))) n++; rowDark.push(n); }
    let run = null, cur = null;
    for (let y = 0; y < H; y++) {
      if (rowDark[y] >= 40) { if (!cur) cur = { a: y, b: y }; else cur.b = y; if (!run || cur.b - cur.a > run.b - run.a) run = { ...cur }; }
      else cur = null;
    }
    if (!run) return null;
    const h = run.b - run.a + 1, k = Math.round(h / 15);
    if (k < 1 || Math.abs(h - 15 * k) > k) return null;
    let cx = null, bx = null;
    for (let x = 0; x < W; x++) {
      let n = 0; for (let y = run.a; y <= run.b; y++) if (dark(L(x, y))) n++;
      if (n >= 3 * k) { if (!cx) cx = { a: x, b: x }; else cx.b = x; if (!bx || cx.b - cx.a > bx.b - bx.a) bx = { ...cx }; } else cx = null;   // a letter's stroke whitens most of a column
    }
    if (!bx || Math.abs((bx.b - bx.a + 1) - 85 * k) > 4 * k) return null;
    const gw = Math.floor((bx.b - bx.a + 1) / k), o = k >> 1;
    const ink = (x, y) => x >= 0 && x < gw && y >= 0 && y < 15 && L(bx.a + x * k + o, run.a + y * k + o) >= 200;
    let lo = null, hi = null;
    for (let y = 0; y < 15; y++) for (let x = 0; x < gw; x++) if (ink(x, y)) { if (lo == null) lo = y; hi = y; }
    if (lo == null || hi - lo < 5) return null;
    for (let base = Math.max(0, lo + 6); base <= hi; base++) {
      const t = exactLine(ink, 0, gw, base, F);
      if (t && !t.unknown && t.text.replace(/ /g, '').length >= 2) return fixIl(t.text.replace(/ /g, ''));
    }
    return null;
  }

  // A scroll's grade from its icon: one scroll drawn in three colors (Greater gold, Intermediate red-orange, Lesser
  // blue), kept when the row is sold (faded). The mean hue of the icon's colored pixels, measured on 21 scrolls of a
  // 1366x768 recording: Greater 40, Intermediate 19, Lesser 188-196 degrees. Else null (Chaos not seen yet). Used
  // only to tell apart the catalog names a cut scroll name fits ("Overall Armor DEX Scroll:..." fits four).
  const GRADES = [['Greater', 30, 50], ['Intermediate', 8, 28], ['Lesser', 170, 230]];
  function scrollGrade(img, k) {
    let sx = 0, sy = 0, n = 0, tot = 0;
    for (let y = 4 * k; y < 34 * k && y < img.height; y++) for (let x = 6 * k; x < 36 * k; x++) {
      const i = (y * img.width + x) * 4, r = img.data[i], g = img.data[i + 1], b = img.data[i + 2];
      const mx = Math.max(r, g, b), mn = Math.min(r, g, b); tot++;
      if (mx < 60 || mx - mn < 18) continue;   // the outline, and greys
      let h = mx === r ? ((g - b) / (mx - mn)) % 6 : mx === g ? (b - r) / (mx - mn) + 2 : (r - g) / (mx - mn) + 4;
      h *= Math.PI / 3; sx += Math.cos(h); sy += Math.sin(h); n++;
    }
    if (!n || n / tot < 0.15) return null;
    let deg = Math.atan2(sy, sx) * 180 / Math.PI; if (deg < 0) deg += 360;
    const g = GRADES.find(([, lo, hi]) => deg >= lo && deg <= hi);
    return g ? g[0] : null;
  }
  // ---------------------------------------------------------------- a smoothly stretched row, back on game pixels
  // In fullscreen 1920x1080 the game's 1366x768 picture is stretched x1.406 with bilinear filtering (a Chrome window
  // share recording, 2026-10-17): each screen pixel is a known blend of at most 2 x 2 game pixels. Least squares undoes
  // the blend exactly, one axis at a time (each axis is a tridiagonal system), and gives back the game's own pixels
  // (within 1-2 luma) for readExact. The grid's phase in the cut is the one whose pixels sit closest to the palette.
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
  const PALETTE = [0, 187, 215, 244, 246, 253, 255];
  // summed distance to the palette (each pixel at most 40) over columns x0f..x1f of the plane (the text box's by default)
  function paletteMiss(P, pal = PALETTE, x0f = 0.17, x1f = 0.76) {
    let e = 0;
    for (let y = 0; y < P.h; y++) for (let x = Math.round(P.w * x0f); x < Math.round(P.w * x1f); x++) {
      const v = P.v[y * P.w + x]; let d = 40; for (const q of pal) { const a = Math.abs(v - q); if (a < d) d = a; } e += d;
    }
    return e;
  }
  // The grid phases (px, py, in game px) of a stretched plane S (sw x h screen px, its first column X0 screen px into
  // the cut) whose unstretched pixels sit closest to the palette: 8 x 8 coarse, then each phase alone in finer steps
  // (a phase 1/32 game px off leaves ripples of +-8 at glyph edges). Returns {e (mean miss a pixel), px, py} or null.
  // seed {px, py, max}: the phase the last rows of this window had (unstretchRow's phase cache); tried first with the
  // fine steps alone, and taken when it fits within max. Else the whole search below.
  function fitPhase(S, sw, h, k, X0, miss, seed) {
    const sub = (px) => ((px - X0 / k) % 1 + 1) % 1;
    let best = null;
    const tryP = (px, py) => { const P = unstretchPlane(S, sw, h, k, sub(px), py); if (!P) return; const e = miss(P) / (P.w * P.h); if (!best || e < best.e) best = { e, px, py }; };
    if (seed) {
      tryP(seed.px, seed.py);
      for (const st of [1 / 64, 1 / 128]) {
        for (const j of [-2, -1, 1, 2]) { const c = best; if (c) tryP((c.px + j * st + 1) % 1, c.py); }
        for (const j of [-2, -1, 1, 2]) { const c = best; if (c) tryP(c.px, (c.py + j * st + 1) % 1); }
      }
      if (best && best.e <= seed.max) return best;
    }
    // At a whole k (a smooth 2x) every game px has the same two blends, and the miss has dips 1/8 px off the right
    // phase that hold the refinement below: 16 x 16 there (a 2x row at phase 0.8 fit 1.25 from 8 x 8, 0.08 from 16 x 16).
    const nc = Math.abs(k - Math.round(k)) < 0.05 ? 16 : 8;
    for (let a = 0; a < nc; a++) for (let b = 0; b < nc; b++) tryP(a / nc, b / nc);
    if (!best) return null;
    for (const st of [1 / 32, 1 / 64, 1 / 128]) {
      for (const j of [-2, -1, 1, 2]) { const c = best; tryP((c.px + j * st + 1) % 1, c.py); }
      for (const j of [-2, -1, 1, 2]) { const c = best; tryP(c.px, (c.py + j * st + 1) % 1); }
    }
    return best;
  }
  // The seller's name tag (readSellerExact) at a stretched scale: the tag band (rows mostly dark navy) and a little
  // round it is fitted to the tag's own palette (white text 255 on the dark gradient 43-54, its ring 124 and 176, its light border 222, the
  // window 214, measured on the 1080p recording), put back on game pixels and handed on as grey, so readSellerExact reads it at 1x. Null when no tag band
  // is found or the fit is not a bilinear stretch.
  const TAG_PALETTE = [0, 43, 46, 49, 52, 55, 124, 176, 214, 222, 255];   // and the tag's ring (124, 176) and black edges (0)
  function unstretchTag(img, k) {
    const w = img.width, h = img.height, d = img.data, n = w * h, L = new Float32Array(n);
    for (let i = 0; i < n; i++) L[i] = 0.2126 * d[i * 4] + 0.7152 * d[i * 4 + 1] + 0.0722 * d[i * 4 + 2];
    let a = -1, b = -1, run = null;
    for (let y = 0; y < h; y++) {
      let m = 0; for (let x = 0; x < w; x++) if (L[y * w + x] >= 30 && L[y * w + x] <= 80) m++;
      // a row with much white text has fewer dark pixels: up to 3 such rows inside the band are bridged
      if (m >= 0.2 * w) { if (a < 0 || y > b + 4) a = y; b = y; if (!run || b - a > run.b - run.a) run = { a, b }; }
    }
    if (!run || run.b - run.a + 1 < 15 * k - 3) return null;
    let x0 = w, x1 = -1;
    for (let x = 0; x < w; x++) { let m = 0; for (let y = run.a; y <= run.b; y++) if (L[y * w + x] >= 30 && L[y * w + x] <= 80) m++; if (m >= 0.4 * (run.b - run.a + 1)) { if (x < x0) x0 = x; x1 = x; } }
    if (x1 < x0) return null;
    const cx0 = Math.max(0, x0 - 6), cx1 = Math.min(w, x1 + 7), cy0 = Math.max(0, run.a - 6), cy1 = Math.min(h, run.b + 7), cw = cx1 - cx0, ch = cy1 - cy0;
    const S = new Float32Array(cw * ch);
    for (let y = 0; y < ch; y++) for (let x = 0; x < cw; x++) S[y * cw + x] = L[(cy0 + y) * w + cx0 + x];
    const best = fitPhase(S, cw, ch, k, 0, (P) => paletteMiss(P, TAG_PALETTE, 0, 1));
    if (!best || best.e > 4) return null;   // the gradient is matched by 5 steps, so a little more miss than a row's
    const P = unstretchPlane(S, cw, ch, k, best.px, best.py), out = new Uint8ClampedArray(P.w * P.h * 4);
    for (let i = 0; i < P.w * P.h; i++) { const v = Math.max(0, Math.min(255, Math.round(P.v[i]))); out[i * 4] = out[i * 4 + 1] = out[i * 4 + 2] = v; out[i * 4 + 3] = 255; }
    return { width: P.w, height: P.h, data: out, fit: Math.round(best.e * 100) / 100 };
  }
  // A row cut at k screen px per game px (not whole) -> a 262 x 38 row on game pixels (RGBA), placed so the text box
  // is at game px 41-202 (its frame at 40 and 203, as readExact expects), or null when the fit or the box is not clean.
  // Luma here is BT.709's: a shared window arrives as I420 (colour at half resolution), and only its Y plane survives
  // the round trip to RGB exactly at glyph edges; with BT.601 weights the fit leaves ripples of +-7 there. The palette
  // has the same values in both (paper 205,217,227: 215.2 and 214.6), so the text box is handed on as that grey.
  // The stretch capture.js reports can be a few percent off: it takes the game to fill the shared frame, and a window
  // share has a border and a title bar (a tester's 2560x1440 game came as a 2616x1478 frame: x1.92 reported, x1.874
  // real, and no row read). When the reported k does not fit, k is searched within 5% (coarse phases, then the best k
  // refined), and the factor found is kept per reported k, so the next rows cost no more than at the right k.
  const stretchFix = new Map();
  const OLD_START_MAX = 49, OLD_MESOS_MIN = 0.68;   // the old matcher's quantity start (game px) and "mesos" score it must keep (readRow)
  const enlargeMiss = new Map();   // the browser's enlargement and k (3 decimals) -> { fails, skip, wait } (readRow)
  const enlargeShift = new Map();   // the same key -> the 1 px place correction [dx, dy] that last read a row (readRow)
  const enlargeWon = new Map();   // k (3 decimals) -> { e: the enlargement that last read a row exactly, 0 for none; miss } (readRow)
  const WON_MISS = 12;   // rows in a row with no verdict that let the kept way go
  const stretchMiss = new Map();   // reported k -> { skip: rows left before the next search, wait: the wait it began with }
  function cropImage(img, pad) {
    pad = pad.map((v) => Math.max(0, v | 0));   // a negative margin (a box past the frame's edge) would wrap the cut
    const W = img.width, x0 = pad[0], y0 = pad[1], w = W - pad[0] - pad[2], h = img.height - pad[1] - pad[3];
    if (!(w > 0 && h > 0)) return null;
    const out = new Uint8ClampedArray(w * h * 4);
    for (let y = 0; y < h; y++) out.set(img.data.subarray(((y0 + y) * W + x0) * 4, ((y0 + y) * W + x0 + w) * 4), y * w * 4);
    return { width: w, height: h, data: out };
  }   // reported k (3 decimals) -> the factor that fit
  // pad: [left, top, right, bottom] screen px of margin around the row box (capture.js rowImage cuts a stretched row
  // with one, since the box itself can be a few game px off at a wrong k): the row is then looked for around that place.
  // frameAt: the cut's top left in the frame (capture.js rowImage). The rows of one window sit on one game pixel grid, so
  // the phase found for one row, kept in frame terms per reported k (phaseAt), seeds the next (review of #295: the
  // whole phase search on every row cost a smooth 2x row 200-480 ms; a seeded row costs a few tries).
  const phaseAt = new Map();   // reported k (3 decimals) -> { k, fx, fy, e }
  function unstretchRow(img, k0, pad, frameAt) {
    const w = img.width, h = img.height, d = img.data, n = w * h, L = new Float32Array(n);
    const pl = pad ? pad[0] : 0, pt = pad ? pad[1] : 0, iw = w - pl - (pad ? pad[2] : 0);
    for (let i = 0; i < n; i++) L[i] = 0.2126 * d[i * 4] + 0.7152 * d[i * 4 + 1] + 0.0722 * d[i * 4 + 2];
    // The phases are searched on the left of the text box only (screen columns X0..X1, where names and prices start):
    // a third of the row, so the search costs a third. Game px 0 of that part sits at phase px - X0 / k.
    // In a padded cut only the box's own lines (from Y0, sh tall) are fitted: the margin over the first row is the
    // window's header, not the palette. The phase found there is carried back to the whole cut (by Y0 / k) below.
    const Y0 = pt, sh = h - pt - (pad ? pad[3] : 0);
    const X0 = pl + Math.round(iw * 0.12), sw = Math.round(iw * 0.43), S = new Float32Array(sw * sh);
    for (let y = 0; y < sh; y++) for (let x = 0; x < sw; x++) S[y * sw + x] = L[(Y0 + y) * w + X0 + x];
    const miss = (P) => paletteMiss(P), key = k0.toFixed(3);
    let k = k0 * (stretchFix.get(key) || 1);
    const pc = frameAt && phaseAt.get(key), mod1 = (v) => ((v % 1) + 1) % 1;
    const seed = pc && pc.k === k ? { px: mod1(pc.fx - frameAt[0] / k), py: mod1(pc.fy - frameAt[1] / k - Y0 / k), max: Math.min(2, Math.max(0.6, 2 * pc.e)) } : null;
    let best = fitPhase(S, sw, sh, k, X0, miss, seed);
    // A search that found no fit is not run again for the next rows (nightly review of 2026-10-18: in a sharp,
    // nearest-pixel stretch no row ever fits, and every row paid the whole search, 100-300 ms each): it waits 4 rows,
    // then 8, 16 ... up to 64, as mapreader's barWait. The fit at the reported k above still runs on every row.
    const m = stretchMiss.get(key), wait = !stretchFix.has(key) && m && m.skip > 0;
    if (wait) m.skip--;
    if (!stretchFix.has(key) && !wait) {
      // Once per reported k (the first row that fits anywhere): a wrong k can still fit under the bar (e 1.9 at 2%
      // off, where a 1080p recording's rows fit 0.3-1.7), so k is searched whatever the fit, and a k other than the
      // reported one is taken only when it fits clearly better.
      // The coarse search: 4 x 4 phases at each k within 5% (a wrong k leaves every phase far off the palette).
      let c = null;
      for (let j = -12; j <= 12; j++) {
        const kk = k0 * (1 + j * 0.004);
        for (let a = 0; a < 4; a++) for (let b = 0; b < 4; b++) {
          const P = unstretchPlane(S, sw, sh, kk, (((a / 4 - X0 / kk) % 1) + 1) % 1, b / 4); if (!P) continue;
          const e = miss(P) / (P.w * P.h); if (!c || e < c.e) c = { e, kk };
        }
      }
      // Then refined on the whole text box (game px 41-202), where a k 0.1% off is a fifth of a game px off at its
      // ends, which the left part alone does not tell apart.
      if (c) {
        const X2 = pl + Math.round(iw * 0.16), sw2 = Math.round(iw * 0.6), S2 = new Float32Array(sw2 * sh);
        for (let y = 0; y < sh; y++) for (let x = 0; x < sw2; x++) S2[y * sw2 + x] = L[(Y0 + y) * w + X2 + x];
        // walked downhill from the coarse k (that can be a coarse step off) while the fit improves
        const at = (kk) => fitPhase(S2, sw2, sh, kk, X2, miss);
        let k2 = c.kk, b2 = at(k2);
        // (in 0.1% steps, then 0.025%: 0.05% of k is a game px across the row at x1.9)
        for (const st of [0.001, -0.001, 0.00025, -0.00025]) for (let i = 0; i < 12 && b2; i++) { const kk = k2 * (1 + st), b = at(kk); if (!b || b.e >= b2.e) break; b2 = b; k2 = kk; }
        // taken when it fits the whole box better than the reported k (3%: the left part alone passes a k 2% off)
        // (and not within 0.1% of it: at 1080p 1.4056 fits a little better than the 1.406 reported, and reads worse)
        const b0 = at(k), b = b2 && Math.abs(k2 / k - 1) > 0.001 && (!b0 || b2.e < b0.e * 0.97) && fitPhase(S, sw, sh, k2, X0, miss);
        if (b && (!best || b.e <= 2)) { best = b; k = k2; }
      }
      if (best && best.e <= 2) { stretchFix.set(key, k / k0); stretchMiss.delete(key); }
      else { const next = Math.min(64, m ? m.wait * 2 : 4); stretchMiss.set(key, { skip: next, wait: next }); }
    }
    if (!best) return null;
    if (Y0) best = Object.assign({}, best, { py: ((best.py + Y0 / k) % 1 + 1) % 1 });
    // a bilinear stretch fits to 0.1-0.5 luma a pixel (synthetic rows and the 1080p recording); a sharp (nearest-pixel)
    // stretch only to 5-6, and is left to the old reader and learn.js
    if (best.e > 2) return null;
    if (frameAt) phaseAt.set(key, { k, fx: mod1(best.px + frameAt[0] / k), fy: mod1(best.py + frameAt[1] / k), e: best.e });
    const P = unstretchPlane(L, w, h, k, best.px, best.py), Lv = (x, y) => x >= 0 && y >= 0 && x < P.w && y < P.h ? P.v[y * P.w + x] : -99;
    // Placed by the underline between the two lines: game px 45-199 of row 19, white (255) on either paper. (The text
    // box's own edge does not do: its frame, 246, is 2 from a sold row's paper, 244, within the fit's noise.)
    const light = (v) => v >= 249.5, white = (v) => v >= 251;   // the sold paper is 244, give or take the fit's noise
    let at = null;
    // within a few game px of the box, or 16 across and 12 down around it in a padded cut (the margin capture.js left)
    const cx = Math.round(pl / k), cy = Math.round(pt / k), rx = pad ? 16 : 6, ry = pad ? 12 : 4;
    for (let dy = cy - ry; dy <= cy + ry; dy++) for (let dx = cx - rx; dx <= cx + rx; dx++) {
      let on = 0;
      for (let x = 45; x <= 199; x++) if (light(Lv(dx + x, dy + 19))) on++;
      let sc = on / 155;
      if (white(Lv(dx + 44, dy + 19)) || white(Lv(dx + 200, dy + 19)) || white(Lv(dx + 120, dy + 18)) || white(Lv(dx + 120, dy + 20))) sc -= 0.5;
      if (!at || sc > at.sc) at = { sc, dx, dy };
    }
    if (!at || at.sc < 0.8) return null;
    const R = new Float32Array(n), G = new Float32Array(n), B = new Float32Array(n);
    for (let i = 0; i < n; i++) { R[i] = d[i * 4]; G[i] = d[i * 4 + 1]; B[i] = d[i * 4 + 2]; }
    const pr = unstretchPlane(R, w, h, k, best.px, best.py), pg = unstretchPlane(G, w, h, k, best.px, best.py), pb = unstretchPlane(B, w, h, k, best.px, best.py);
    const out = new Uint8ClampedArray(EX.ROW_W * 38 * 4);
    for (let y = 0; y < 38; y++) for (let x = 0; x < EX.ROW_W; x++) {
      const sx = x + at.dx, sy = y + at.dy, o = (y * EX.ROW_W + x) * 4;
      if (sx < 0 || sy < 0 || sx >= P.w || sy >= P.h) { out[o] = out[o + 1] = out[o + 2] = 246; out[o + 3] = 255; continue; }   // the frame
      const j = sy * P.w + sx;
      if (x >= 38) { out[o] = out[o + 1] = out[o + 2] = Math.round(P.v[j]); out[o + 3] = 255; continue; }   // the text box, as grey
      out[o] = Math.round(pr.v[j]); out[o + 1] = Math.round(pg.v[j]); out[o + 2] = Math.round(pb.v[j]); out[o + 3] = 255;   // the icon, in colour (scrollGrade)
    }
    return { width: EX.ROW_W, height: 38, data: out, fit: Math.round(best.e * 100) / 100, tol: 12 };
  }
  // A share the BROWSER enlarged past the screen (R-RKFFH: Firefox sent 2560x1440 frames from a 1920x1080 screen; also
  // R-YGKB8): a second smooth stretch (x1.333) on top of the game's own (x1.406), which unstretchRow's one-stretch fit
  // cannot undo, so every row went to the old matcher ("Earring LUK Scroll" read "EarrIng I r fK Scroll", never
  // matched). It is undone first, exactly, as mapreader.js unenlarge does: the browser's stretch is bilinear and centred
  // on the frame, so the cut's phase comes from its place in the frame (at, frame px). Colour too (the scroll's grade).
  function unenlargeRow(img, e, at) {
    const w = img.width, h = img.height, d = img.data, n = w * h, planes = [];
    const px = ((-at[0] / e) % 1 + 1) % 1, py = ((-at[1] / e) % 1 + 1) % 1;
    for (let c = 0; c < 3; c++) {
      const S = new Float32Array(n); for (let i = 0; i < n; i++) S[i] = d[i * 4 + c];
      const P = unstretchPlane(S, w, h, e, px, py); if (!P) return null; planes.push(P);
    }
    const W = planes[0].w, H = planes[0].h, out = new Uint8ClampedArray(W * H * 4);
    for (let i = 0; i < W * H; i++) { out[i * 4] = planes[0].v[i]; out[i * 4 + 1] = planes[1].v[i]; out[i * 4 + 2] = planes[2].v[i]; out[i * 4 + 3] = 255; }
    return { width: W, height: H, data: out };
  }
  // Whether a row box cut at a whole k (k screen px per game px) is blurred: 30%+ of its text box's off-palette pixels
  // are ramps, strictly between their left and right (or upper and lower) neighbours by 6+ each way (capture.js
  // smoothBox's test). At a sharp whole k every pixel has a twin beside it, so no ramps.
  function smoothRow(img, k) {
    const W = img.width, H = img.height, d = img.data;
    const L = (x, y) => { const i = (y * W + x) * 4; return 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2]; };
    const btw = (a, v, b) => (a <= v - 6 && b >= v + 6) || (a >= v + 6 && b <= v - 6);
    let off = 0, ramp = 0;
    for (let y = Math.max(1, Math.round(2 * k)); y < Math.min(H - 1, H - Math.round(2 * k)); y++) for (let x = Math.max(1, Math.round(41 * k)); x < Math.min(W - 1, Math.round(203 * k)); x++) {
      const v = L(x, y);
      if (Math.abs(v - 215) <= 6 || Math.abs(v - 244) <= 6 || v <= 40 || v >= 250 || Math.abs(v - 187) <= 12) continue;
      off++;
      if (btw(L(x - 1, y), v, L(x + 1, y)) || btw(L(x, y - 1), v, L(x, y + 1))) ramp++;
    }
    return off >= 40 * k && ramp >= 0.3 * off;
  }
  // Whether a row box cut at a whole k sits on a sharp k x k grid, however blurred (VP8, I420): in each axis, at one
  // phase, the steps between neighbours inside a block are under 45% of the steps across block edges. On recorded rows
  // drawn sharp at 2x it is 0.00-0.31 (clean, +-4 luma, VP8 q10 and q30), a smooth 2x 0.56-0.78. Such a row is not
  // un-stretched: no phase fits it, and the search cost 200 ms to 1.7 s a row (review of #295).
  function sharpGrid(img, k) {
    const W = img.width, H = img.height, d = img.data, L = new Float32Array(W * H);
    for (let i = 0; i < W * H; i++) L[i] = 0.299 * d[i * 4] + 0.587 * d[i * 4 + 1] + 0.114 * d[i * 4 + 2];
    const x0 = Math.round(41 * k), x1 = Math.min(W - 1, Math.round(203 * k)), y0 = Math.round(2 * k), y1 = Math.min(H - 1, H - Math.round(2 * k));
    const axis = (dx, dy) => {
      let best = Infinity;
      for (let p = 0; p < k; p++) {
        let si = 0, ni = 0, sc = 0, nc = 0;
        for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
          const st = Math.abs(L[(y + dy) * W + x + dx] - L[y * W + x]), c = dx ? x : y;
          if ((c - p + k) % k === k - 1) { sc += st; nc++; } else { si += st; ni++; }
        }
        if (ni && nc && sc > 0) best = Math.min(best, (si / ni) / (sc / nc));
      }
      return best;
    };
    return Math.max(axis(1, 0), axis(0, 1)) < 0.45;
  }
  function readExact(img) {
    const F = fontKeys(); if (!F) return null;
    const P = gamePixels(img); if (!P) return null;
    const { Y, W, H } = P, x1 = Math.min(EX.X1, W);
    const hist = new Map();
    for (let y = EX.Y0; y < H - 2; y++) for (let x = EX.X0; x < x1; x++) { const v = Y[y * W + x]; hist.set(v, (hist.get(v) || 0) + 1); }
    if (!hist.size) return null;
    const paper = [...hist.entries()].sort((a, b) => b[1] - a[1])[0][0];
    // an un-stretched row (unstretchRow) carries its own tolerance: the least squares fit adds a few luma of noise
    const TOL = img.tol || EX.TOL;
    const kind = Math.abs(paper - EX.PAPER.unsold) <= TOL ? 'unsold' : Math.abs(paper - EX.PAPER.sold) <= TOL ? 'sold' : null;
    if (!kind) return null;
    const inkV = EX.INK[kind], inkTol = EX.INK_TOL[kind], isInk = (v) => Math.abs(v - inkV) <= inkTol;
    // Clean: every pixel of the text box is paper, ink, the underline, or (sold) the unfaded last row/column.
    // Off-palette pixels of which 30%+ are ramps (a neighbour 15+ darker and one 15+ lighter) are a blurred (smoothly
    // stretched) row (at 2x smooth: 41% ramps), not a cursor or a tooltip (flat colour, ramps only at its edge): such a row is not at a whole-number scale and is not
    // read here (null: the grid reader and learn.js read it).
    // An un-stretched row (img.tol) also carries the share's noise (I420, +-4 luma, VP8; R-G2JBS, a Retina Mac): an odd
    // speck (a patch of 1 or 2 odd pixels, lone below), within 2 x TOL of the paper and nearer it than the ink, is noise,
    // not a cover: a cover is a patch. That takes a sold row's lone light specks (its paper is 244, 6 from the glove's
    // 250) and the 13-15 off specks on any paper; a white patch of 3+ pixels stays a cover (review of #295: exempting
    // every 250+ pixel on a sold row read a white patch over the "4" of 45,000 as 5,000), and a lone pixel of the
    // cursor's fill (40+ off an unsold paper) still counts (rec4: else the cover's edge moved right and the cursor's
    // outline read as a glyph, "Pan Lid ?"). A lone pixel nearer the ink still counts, so no glyph loses ink to this.
    const odd = new Uint8Array(W * H);   // 1: off the palette, 2: the glove
    for (let y = EX.Y0; y < H - 2; y++) for (let x = EX.X0; x < x1; x++) {
      const v = Y[y * W + x];
      // the cursor's white glove counts as cover where it is not the underline (row 19)
      const glove = v >= EX.LIGHT && (y < 18 || y > 20);
      // (some shops draw the underline grey, 244; an un-stretched row placed 1-2 px off shows the frame, 246, at the box's edge)
      if (img.tol && Math.abs(v - 246) <= 4 && (x <= EX.X0 + 1 || x >= x1 - 2 || y <= EX.Y0 + 1 || y >= H - 4)) continue;
      if (!glove && (Math.abs(v - paper) <= TOL || isInk(v) || v >= EX.LIGHT || (y >= 18 && y <= 20 && v >= 238) || (kind === 'sold' && Math.abs(v - EX.PAPER.unsold) <= TOL))) continue;
      odd[y * W + x] = glove ? 2 : 1;
    }
    // a speck: an odd pixel in a patch of at most 2 (8-connected; noise on sold paper often comes in pairs). No glyph
    // loses 2 pixels into another one that changes a price (no digit does; a lost "," breaks the offer's pattern) or
    // a catalog name (h/n, y/v, :/. checked against catalog.json: no such twin names).
    const lone = (x, y) => {
      const seen = [y * W + x];
      for (let s = 0; s < seen.length; s++) {
        const p = seen[s], px = p % W, py = (p - px) / W;
        for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
          const qx = px + dx, qy = py + dy, q = qy * W + qx;
          if ((dx || dy) && qx >= 0 && qx < W && qy >= 0 && qy < H && odd[q] && !seen.includes(q)) { seen.push(q); if (seen.length > 2) return false; }
        }
      }
      return true;
    };
    let off = 0, ramp = 0, cx = Infinity, cy0 = Infinity, cy1 = -Infinity;
    for (let y = EX.Y0; y < H - 2; y++) for (let x = EX.X0; x < x1; x++) {
      const o = odd[y * W + x], v = Y[y * W + x];
      if (!o) continue;
      if (o === 1) {   // every off pixel counts for the blur test below; a lone noisy one only stays out of the cover
        off++;
        const nb = [x > 0 ? Y[y * W + x - 1] : v, x + 1 < W ? Y[y * W + x + 1] : v, y > 0 ? Y[(y - 1) * W + x] : v, y + 1 < H ? Y[(y + 1) * W + x] : v];
        if (nb.some((u) => u <= v - 15) && nb.some((u) => u >= v + 15)) ramp++;
      }
      if (img.tol && Math.abs(v - paper) <= 2 * TOL && Math.abs(v - paper) < Math.abs(v - inkV) && lone(x, y)) continue;
      if (x < cx) cx = x; if (y < cy0) cy0 = y; if (y > cy1) cy1 = y;
    }
    if (off >= 40 && ramp >= 0.3 * off) return null;
    // A cover (cursor, tooltip) right of the text: each line it reaches is read up to 3 game px before it, and only
    // kept when nothing could hide under it (below); else the row is covered and is not read in this frame.
    const cut = cx < Infinity ? { x: cx - 3, y0: cy0 - 3, y1: cy1 + 3 } : null;
    const covered = { covered: true, kind };
    if (cut && cut.x < EX.X0 + 8) return covered;
    const ink = (x, y) => x >= EX.X0 && x < x1 && y >= 0 && y < H && isInk(Y[y * W + x]) && !(cut && x >= cut.x && y >= cut.y0 && y <= cut.y1);
    // The two lines: clusters of rows with ink; each one's baseline is the one whose glyphs all read.
    const count = []; for (let y = 0; y < H; y++) { let n = 0; for (let x = EX.X0; x < x1; x++) if (ink(x, y)) n++; count.push(n); }
    const clusters = []; let cur = null;
    for (let y = 0; y < H; y++) { if (count[y]) { if (!cur) cur = { a: y, b: y }; else cur.b = y; } else if (cur && y - cur.b > 1) { clusters.push(cur); cur = null; } }
    if (cur) clusters.push(cur);
    // Each line on the baseline where the most of it reads (a wrong baseline cuts every glyph, so few read).
    const lines = clusters.filter((c) => c.b - c.a >= 5).map((c) => {
      let best = null;
      for (let base = Math.max(F.above, c.a + 6); base <= c.b; base++) {
        const cutHere = cut && base - F.above <= cut.y1 && base + F.below >= cut.y0, lx = cutHere ? cut.x : x1;
        const t = exactLine(ink, EX.X0, lx, base, F);
        if (t) { t.cut = cutHere; t.x1 = lx; }
        if (t && (!best || t.unknown < best.unknown || (t.unknown === best.unknown && t.n > best.n))) best = t;
        if (best && !best.unknown) break;
      }
      return best;
    });
    if (lines.length !== 2 || !lines[1] || lines[1].unknown) return cut ? covered : null;
    // The offer is left-aligned in the text box (its first column 46-47 on recorded rows at 1x, x1.406 and x1.874; 45
    // on drawn ones) with one plain space each side of "for": 4 blank columns (6 after a quantity ending in "1"; 4-7 in
    // all). A cover that the un-stretch blurs into the paper can hide a leading digit and leave a shorter offer that still
    // looks valid (review of #295: "10 for 45,000" read 10 for 5,000, "38 for" read 8, "10,000" read 0): its start or one
    // of those spaces is then 4+ columns too wide, and it is not an offer (nothing is read).
    const L1 = lines[1], spaced = L1.start >= 44 && L1.start <= 48 && L1.gaps.length >= 2 && L1.gaps[1] <= 5;
    let m = spaced ? L1.text.match(OFFER) : null;
    // Every space of the line, not only the first two (nightly review of 2026-10-19, B1): a cover blurred into the paper
    // over the END of the price left "1 for 45 mesos" from "1 for 45,000 mesos", its space before "mesos" 20+ columns.
    const words = L1.text.split(' ');
    if (m && L1.gaps.some((g, i) => g > (words[i] && words[i].endsWith('1') ? 7 : 5))) m = null;
    // Read up to a cover: no run may touch it (a glyph half under it), the offer must end in the whole "mesos", and
    // the name must spell every glyph; a name that stops less than 10 px before the cover may go on under it, so it is
    // matched as a start ("Pan Lid..."), which snap.js takes only when one catalog name begins so.
    if (cut) {
      const [a, b] = lines;
      if (b.cut && (b.end >= b.x1 || !m || !/ mesos$/.test(b.text))) return covered;
      if (a && a.cut && (a.end >= a.x1 || a.unknown)) return covered;
    }
    // The name: "?" where the font lacks a glyph (snap.js snapExact fills it only when one catalog name fits).
    let name = lines[0] && lines[0].unknown <= 3 && lines[0].unknown < lines[0].n ? fixIl(lines[0].text) : null;
    if (name && lines[0].cut && lines[0].x1 - lines[0].end < 10 && !/\.\.\.$/.test(name)) name += '...';
    // A cut name (or a scroll's): the grade from the icon, which snap.js uses only when several names fit.
    const grade = name && (/\.\.\.$/.test(name) || /Scroll/.test(name)) && !/: (Greater|Intermediate|Lesser|Chaos)$/.test(name) ? scrollGrade(img, P.k) : null;
    return { kind, name, grade, offer: lines[1].text, qty: m ? Number(m[1].replace(/,/g, '')) : null, price: m ? Number(m[2].replace(/,/g, '')) : null, k: P.k };
  }

  function readGray(g, W, H, hintScale) {
    const c = A.canonical;
    // 1. "mesos": coarse scale search (the caller's scale first, then the last scale), then a fine search at canonical scale
    let hit = null;
    // The row picture's own width fixes the scale to within a few percent (capture.js cuts rows as a fixed share of the
    // window: 369 px wide at scale 1, measured on 9 recordings at 0.72-1.72). Searching only near it stops tiny
    // false "mesos" hits at scale 0.40 on large rows (2026-10-16: 113 of 205 rows of a 1.07 recording locked on 0.40).
    const rowS = W / (c.row_w || 369), tol = c.row_scale_tol || 1.15;
    const nearRow = s => !(rowS >= c.scale_min && rowS <= c.scale_max) || (s >= rowS / tol && s <= rowS * tol);
    // Fast path (the scale lock): rows of one shop share the scale and the offer line's height in the row. When this
    // row is as tall as the last one read, look for "mesos" only at the last fine scale and within 3 px of the last
    // line's height, and run the fine search at that one scale; any miss falls through to the full search.
    let locked = null;
    if (c.lock !== false && lastFine && Math.abs(H - lastFine.H) <= 1 && Math.abs(W - lastFine.W) <= 1 && nearRow(lastFine.s)) {
      const sL = lastFine.s, useHalf = sL >= 1.1, f = useHalf ? 2 : 1;
      const img = useHalf ? { d: resample(g, W, H, Math.max(1, Math.round(W / 2)), Math.max(1, Math.round(H / 2))), w: Math.max(1, Math.round(W / 2)), h: Math.max(1, Math.round(H / 2)) } : { d: g, w: W, h: H };
      const T = coarseTemplate(useHalf ? sL / 2 : sL), yc = Math.round(lastFine.hy / f);
      if (T.w <= img.w && T.h <= img.h) {
        const b = bestMatch2(img.d, img.w, img.h, T, 0, img.w - T.w, yc - 2, yc + 2);
        if (b.v >= 0.7) locked = { v: b.v, x: b.x * (W / img.w), y: b.y * (W / img.w), s: sL, locked: true };
      }
    }
    if (locked) {
      let bl = null;
      for (const f of (c.lock_scales || [1])) {
        const gc = canonicalBand(g, W, H, locked, locked.s * f);
        if (!gc) continue;
        const b = bestMatch2(gc.d, gc.w, gc.h, A._mesosT, Math.floor(gc.ex) - 14, Math.ceil(gc.ex) + 14, Math.floor(gc.ey) - 14, Math.ceil(gc.ey) + 14);
        if (!bl || b.v > bl.v) bl = { v: b.v, M: b.x, Y: b.y, s: locked.s * f, gc };
      }
      if (bl && bl.v >= c.min_anchor) return finish(g, W, H, bl, locked, nearRow);
    }
    if (hintScale && nearRow(hintScale)) hit = hintedCoarse(g, W, H, hintScale);
    if (!hit && lastScale && nearRow(lastScale)) {
      const near = [];
      for (let s = lastScale / 1.1; s <= lastScale * 1.1; s *= 1.02) near.push(s);
      const h = coarse(g, W, H, near);
      if (h.v >= 0.7) hit = h;
    }
    if (!hit) { const h = coarse(g, W, H, scales().filter(nearRow)); if (h.v >= 0.45) hit = h; }
    if (!hit) hit = coarse(g, W, H, scales()); // a row cut at an unusual width: the full sweep, as before
    if (!hit || hit.v < 0.45) return fail('no "mesos" word found', { nameWhy: 'name line not found' });
    let best = null;
    for (let s = hit.s * 0.97; s <= hit.s * 1.0301; s += hit.s * 0.01) {
      const gc = canonicalBand(g, W, H, hit, s);
      if (!gc) continue;
      const b = bestMatch2(gc.d, gc.w, gc.h, A._mesosT, Math.floor(gc.ex) - 14, Math.ceil(gc.ex) + 14, Math.floor(gc.ey) - 14, Math.ceil(gc.ey) + 14);
      if (!best || b.v > best.v) best = { v: b.v, M: b.x, Y: b.y, s, gc };
    }
    if (!best || best.v < c.min_anchor) return fail('"mesos" matched too weakly', { scale: hit.s, nameWhy: nearRow(hit.s) ? 'name line not found' : 'scale out of range' });
    return finish(g, W, H, best, hit, nearRow);
  }
  // Steps 2-6 from the found "mesos" (best: its match on the canonical band gc at scale s; hit: the coarse match).
  function finish(g, W, H, best, hit, nearRow) {
    const c = A.canonical;
    const { gc, M, Y, s } = best;
    // 2. "for" on the same line, left of "mesos"
    const y0 = Math.max(0, Y - c.for_band_pad), yb = Math.min(gc.h, y0 + c.cell_h + 10);
    // the offer text is left-aligned, so under the scale lock "for" sits within 4 quantity digits of the last row's
    let fx0 = 0, fx1 = M - 20 - A._forT.w;
    if (hit.locked && lastFine && lastFine.F != null) { fx0 = Math.max(0, Math.floor(lastFine.F - 4.5 * c.digit_adv)); fx1 = Math.min(fx1, Math.ceil(lastFine.F + 4.5 * c.digit_adv)); }
    let fb = bestMatchStep(gc.d, gc.w, gc.h, A._forT, fx0, fx1, y0, yb - A._forT.h, c.for_step || 2);
    if (fb.v < c.min_anchor && (fx0 > 0 || fx1 < M - 20 - A._forT.w)) fb = bestMatchStep(gc.d, gc.w, gc.h, A._forT, 0, M - 20 - A._forT.w, y0, yb - A._forT.h, c.for_step || 2);
    if (fb.v < c.min_anchor) return fail('"for" not found', { scale: s, nameWhy: 'name line not found' });
    const F = fb.x;
    // the item name is read even when the price is not (the anchors fix the name line)
    const named = (res, nq = 1) => {
      const ln = { qx0: (F - c.qty_start - c.digit_adv * Math.max(0, nq - 1)) * s / c.up, x0: F * s / c.up, y0: gc.ya + Y * s / c.up };
      const nm = readName(g, W, H, ln, s);
      return Object.assign(res, { nameText: nm.text, nameScore: nm.score ?? null, nameInfo: nm.info || null, nameWhy: nameWhy(nm) });
    };
    // 3. layout
    const L = pickLayout(F, M);
    if (L.res > c.max_residual || L.res2 - L.res < c.min_residual_gap) return named(fail('digit layout does not fit', { scale: s }));
    const kl = s > c.class_a_min_scale ? 'A' : 'B';
    // 4. price digits
    const digits = [], stds = [];
    for (const x of cellsBetween(F, M, L.n, L.k)) {
      const p = windowPatch(gc, x, Y, c.jitter_x, c.jitter_y, c.digit_adv);
      if (!p) return named(fail('price cut at the row edge', { scale: s }));
      digits.push(classify(p, kl)); stds.push(innerStd(p, c.jitter_x + 2, c.jitter_y));
    }
    const ps = digits.map(d => d.d).join('');
    if (ps.length > 1 && ps[0] === '0') return named(fail('price starts with 0', { scale: s }));
    const price = parseInt(ps, 10);
    const confidence = Math.min(...digits.map(d => d.margin));
    // 5. quantity, right to left from "for"
    const ref = percentile(stds, 0.5);
    let qty = null, qd = [];
    for (let j = 0; j < 5; j++) {
      const p = windowPatch(gc, F - c.qty_start - c.digit_adv * j, Y, 3, c.jitter_y, c.digit_adv);
      if (!p) { qty = 'done'; break; }
      if (innerStd(p, 6, c.jitter_y) < 0.4 * ref) { qty = 'done'; break; }
      const d = classify(p, kl);
      if (d.score < c.qty_min_score) { qty = null; qd = []; break; }
      qd.push(d);
    }
    if (qty === 'done' && qd.length) {
      qd.reverse();
      const q = parseInt(qd.map(d => d.d).join(''), 10);
      qty = q >= 1 && qd[0].d !== '0' ? q : null;
    } else qty = null;
    // 6. sold: the offer text's darkest pixels (5th percentile) are grey, not black
    const tx0 = Math.max(0, F), tx1 = Math.min(gc.w, M + A._mesosT.w), ty0 = Math.max(0, Y), ty1 = Math.min(gc.h, Y + c.cell_h);
    const vals = [];
    for (let y = ty0; y < ty1; y += 2) for (let x = tx0; x < tx1; x += 2) vals.push(gc.d[y * gc.w + x]);
    const p5 = percentile(vals, 0.05);
    // sold = greyed text (about 200 on a sold row, 16-70 on a normal one); in between (a blurred or tiny capture) is unsure
    const normalMax = c.normal_text_luma != null ? c.normal_text_luma : c.sold_text_luma;
    const sold = p5 == null ? null : p5 > c.sold_text_luma ? true : p5 < normalMax ? false : null;
    lastScale = s; lastFine = { s, hy: hit.y, W, H, F };
    const minMargin = c.min_margin != null ? c.min_margin : 0;
    const abstain = qty == null || confidence < minMargin;
    const qtyLeft = (F - c.qty_start - c.digit_adv * Math.max(0, qd.length - 1)) * s / c.up;
    const line = { qx0: qtyLeft, x0: F * s / c.up, x1: (M + A._mesosT.w) * s / c.up, y0: gc.ya + Y * s / c.up, y1: gc.ya + (Y + c.cell_h) * s / c.up };
    const nm = readName(g, W, H, line, s);
    const why = qty == null ? 'quantity not read' : confidence < minMargin ? 'a price digit is unsure' : nm.text == null ? nm.why : 'read';
    return { price: abstain ? null : price, qty: abstain ? null : qty, nameText: nm.text, nameScore: nm.score ?? null, nameInfo: nm.info || null, nameWhy: nameWhy(nm), sold, confidence, abstain, why,
             scale: s, raw: { price, qty, digits: ps, textP5: p5, mesos: best.v, for: fb.v,
             line } };
  }

  const MesoRowReader = {
    load(atlas) {
      A = atlas; lastScale = null; lastFine = null; FONT_KEYS = null; coarseCache.clear();
      A._mesos = decodeGray(atlas.words.mesos);
      A._mesosT = prepTemplate(A._mesos);
      A._forT = prepTemplate(decodeGray(atlas.words.for));
      A._letters = [];
      if (atlas.letters && atlas.letters.glyphs) {
        for (const [ch, g] of Object.entries(atlas.letters.glyphs)) {
          const dg = decodeGray(g);
          for (let i = 0; i < dg.d.length; i++) dg.d[i] = 255 - dg.d[i]; // atlas gray: 0 = ink; the ink map: 1 = ink
          const t = prepTemplate(dg);
          A._letters.push(Object.assign(t, { ch: g.ch || ch, w: g.mean_w, wsd: g.w_sd })); // "a@f": a second template of "a" (full-size captures)
        }
        A._sellerLetters = [];
        for (const [ch, g] of Object.entries((atlas.letters.seller && atlas.letters.seller.glyphs) || {})) {
          const dg = decodeGray(g);
          for (let i = 0; i < dg.d.length; i++) dg.d[i] = 255 - dg.d[i];
          A._sellerLetters.push(Object.assign(prepTemplate(dg), { ch, w: g.mean_w, wsd: g.w_sd }));
        }
      } else A.letters = null;
      A._digits = { A: [], B: [] };
      for (let d = 0; d <= 9; d++) for (const kl of ['A', 'B']) {
        const g = atlas.glyphs[String(d)] && atlas.glyphs[String(d)][kl];
        if (g) A._digits[kl][d] = prepTemplate(decodeGray(g));
      }
      return true;
    },
    // opts.scale: the row's expected scale when the caller knows it (the shop window's UI scale x frame width / 1920);
    // only 3 scales near it are searched first, and the full search still runs when they do not match.
    readRow(imageData, opts) {
      if (!A) return fail('atlas not loaded');
      try {
        // A row cut with a margin (opts.pad, capture.js rowImage): the exact reader looks for the row in all of it, the
        // old matcher and learn.js get the row box alone.
        const pad = opts && Array.isArray(opts.pad) && opts.pad.length === 4 ? opts.pad : null, padded = imageData;
        // A share enlarged past the game's own picture (opts.at: the cut's place in the frame): read at the game's own
        // scale once the enlargement is undone (unenlargeRow), when that reads exactly; else as before. Only when the
        // game is still at least its own size (k / enlarge >= 0.95): Chrome's zoom fakes an enlargement. Two factors can
        // come: opts.enlarge, the browser's (the frame wider than the screen, capture.js), and opts.enlargeGame, a 1080p
        // game (x1.406) drawn larger again (capture.js: the shop's game scale over 1.406, R-4276X, R-2JLLH: 1.87x shares
        // of a 2560x1440 screen, Windows display scaling or a Mac, where the frame is the screen's size and one row read).
        // Neither is sure: a 2560x1440 game is one x1.874 stretch (Grant's rec1440), and un-enlarged by 1.333 its clean
        // rows read "covered", final (R-9XAB8: 1 row read, the browser said x1.333). So the way that reads a row exactly
        // (a factor, or none) is kept per k (enlargeWon) and tried first from then on. A factor's "covered" or "cut"
        // verdict always waits for the plain read, kept factor or not, and stands only when that reads nothing either; a
        // plain read of it keeps the plain way instead (review of #333: a false x1.333 that once read a 2560x1440 game's
        // row exactly would be kept, and its false "covered" verdicts were final again).
        const okE = (v) => v > 1.05 && v <= 3 && opts.k > 0 && opts.k / v >= 0.95 && Array.isArray(opts.at);
        const eScreen = opts && okE(opts.enlarge) ? opts.enlarge : 0;
        const eGame = opts && okE(opts.enlargeGame) && !(eScreen && Math.abs(opts.enlargeGame / eScreen - 1) < 0.01) ? opts.enlargeGame : 0;
        const mkey = (eScreen || eGame) ? opts.k.toFixed(3) : '', won = mkey ? enlargeWon.get(mkey) : null;
        const isRead = (x) => !!(x && x.exact && x.price != null);
        const verdict = (x) => !!(x && x.exact && (x.price != null || x.covered || x.cut));
        const tagE = (x, e) => Object.assign(x, { enlarged: +e.toFixed(3) });
        let vE = null;   // a factor's "covered" or "cut" verdict (returned if the plain read reads nothing)
        if (won && won.e) {
          const r = tryEnlarged(won.e);
          if (isRead(r)) { won.miss = 0; return tagE(r, won.e); }
          if (verdict(r)) vE = tagE(r, won.e);
          else if (++won.miss >= WON_MISS) enlargeWon.delete(mkey);   // 12 rows with no verdict: the setup changed; all ways again
        } else if (!won && eScreen) {
          const r = tryEnlarged(eScreen);
          if (isRead(r)) { enlargeWon.set(mkey, { e: eScreen, miss: 0 }); return tagE(r, eScreen); }
          if (verdict(r)) vE = tagE(r, eScreen);
        }
        // A factor that gives no exact verdict (a read, a cover or a cut price) on 3 rows in a row is let go for the next
        // 4 rows, then 8, 16 ... 64 (enlargeMiss, as unstretchRow's k search): a wrong factor (a zoomed page, a frame not
        // the screen's) cost 0.5-2.5 s a row and read nothing (review of #295). The un-enlarged row is read exactly or
        // not at all (exactOnly): the old matcher's read of it was never used. Null when the factor waits.
        function tryEnlarged(e) {
          const ek = e.toFixed(3) + '|' + opts.k.toFixed(3), em = enlargeMiss.get(ek);
          if (em && em.skip > 0) { em.skip--; return null; }
          // The cut's place (opts.at) is rounded: 1 px off, a clean row's un-enlarged edges read as a cover (review of #326:
          // every clean row of a share at x2 read "covered", final, and the share read nothing). A cover or cut verdict is
          // taken only when the places 1 px to each side give it too; the place that read is tried first next time.
          const sh = enlargeShift.get(ek) || [0, 0];
          const at = (d) => opts.at && [opts.at[0] + d[0], opts.at[1] + d[1]];
          const readAt = (d) => { const u = unenlargeRow(padded, e, at(d)); return u && MesoRowReader.readRow(u, Object.assign({}, opts, { k: opts.k / e, scale: opts.scale > 0 ? opts.scale / e : opts.scale, pad: pad && pad.map((v) => Math.round(v / e)), enlarge: null, enlargeGame: null, at: null, unenlarged: true, exactOnly: true })); };
          // A cover counts only where the cut says the row is (the place itself, not a remembered correction), and only an
          // exact read 1 px to a side overrides it: a misplaced un-enlarge is blurred and gives no verdict, so "no verdict"
          // there says nothing (a real cover kept its verdict that way, review of #326's B2 case).
          const coverAt = (x) => !!(x && x.exact && x.price == null && (x.covered || x.cut));
          let r = readAt(sh);
          if (!isRead(r) && (sh[0] || sh[1])) { r = readAt([0, 0]); if (isRead(r)) enlargeShift.delete(ek); }
          if (coverAt(r)) {
            // ... or an exact read of both lines with no cover that is only not an offer at this scale (a sold 1x row at x2
            // starts at game px 43, review of #326): the row is clean there, so the cover was the misplacement's
            let clean = null;
            for (const d of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
              if (d[0] === sh[0] && d[1] === sh[1]) continue;
              const t = readAt(d);
              if (isRead(t)) { r = t; clean = null; enlargeShift.set(ek, d); break; }
              if (!clean && t && t.exact && !coverAt(t)) clean = t;
            }
            if (clean) r = clean;   // no verdict: the rows below read it
          } else if (!(r && r.exact)) {
            // A blurred read with no verdict (the cut 1 px off): an exact READ 1 px to a side is taken, never a cover there
            // (a misplaced side often shows a false one). A 1.406x game at x1.333 1 px off fell to the old matcher, which
            // reads no quantity "1", "8" or 10-14 there (#326 follow-up: 7 of 14 rows not read).
            for (const d of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
              if (d[0] === sh[0] && d[1] === sh[1]) continue;
              const t = readAt(d);
              if (isRead(t)) { r = t; enlargeShift.set(ek, d); break; }
            }
          }
          if (r && r.exact) enlargeMiss.delete(ek);
          else { const m = em || { fails: 0, wait: 2 }; if (++m.fails >= 3) { m.wait = Math.min(64, m.wait * 2); m.skip = m.wait; m.fails = 0; } enlargeMiss.set(ek, m); }
          // A read, or an exact "covered" or "price cut off" verdict, is final (once its way is known, above). The verdict
          // was thrown away before (nightly review of 2026-10-19, B2): the row fell to the old matcher, which guessed a
          // price with a confidence, and live.js sent it, against the rule below (a covered or cut row is not read in this
          // frame). A line that is only not an offer at this scale is no verdict (review of #326: a sold 1x row enlarged x2
          // starts at game px 43, outside readExact's 44-48 window, and every such row read nothing): the rows below read
          // it as before.
          return r;
        }
        if (pad) { imageData = cropImage(imageData, pad); if (!imageData) return fail('row too small'); }
        // A whole-number scale reads exactly (readExact); the old matcher reads the rest, and a name the font cannot
        // spell yet. The sold mark comes from the row's paper whenever that is known.
        // only near a whole-number game pixel size (capture.js's opts.k; it comes from the template match, about 1% off,
        // so within 0.03) and on a palette-clean row (readExact: a blurred row, such as 1.98x, is not read exactly)
        const kWhole = !(opts && opts.k > 0) || Math.abs(opts.k - Math.round(opts.k)) <= 0.03;
        // A smooth stretch (fullscreen 1920x1080: x1.406) is undone first, and then reads exactly too.
        let flat = !kWhole && opts.k > 1.1 && opts.k <= 4 ? unstretchRow(padded, opts.k, pad, opts.at) : null;
        let x = kWhole ? readExact(imageData) : flat ? readExact(flat) : null;
        // A whole k of 2 or more can be a SMOOTH stretch too: a Retina Mac draws a 1366x768 window at 2x with bilinear
        // filtering (R-DM76P, a 2732x1592 share: "Wand" read "Wancl" by the old matcher). readExact turns such a row
        // down (its glyph edges are ramps), or takes a sold one (pale ink, gentle ramps) for covered, so it is undone
        // like any other smooth stretch, as mapreader.js readBar does; a cover found on game pixels stays a cover.
        // (An un-enlarged row at 1x is put back on its grid the same way: the cut's margin was rounded to screen px.)
        // Only a row that is blurred (smoothRow) and not on a sharp grid (sharpGrid): a sharp 2x row under the cursor, or
        // one VP8 blurred, is let go at once (review of #295: the un-stretch tried on it cost 200 ms to 1.7 s for nothing).
        if ((!x || x.covered) && kWhole && opts && (opts.k >= 1.97 || (opts.unenlarged && opts.k >= 0.97)) && opts.k <= 4 && (opts.unenlarged || (smoothRow(imageData, opts.k) && !sharpGrid(imageData, Math.round(opts.k))))) {
          const f = unstretchRow(padded, opts.k, pad, opts.at), y = f && readExact(f);
          if (y && (!x || !y.covered)) { x = y; flat = f; }
        }
        // The plain read beside the factors (see eScreen above): a row read exactly keeps the plain way for this k; a row
        // it does not read is tried at the game's factor too, until a way is kept.
        if (mkey) {
          const plainRead = !!(x && x.price != null && x.qty != null);
          if (won && !won.e) { if (plainRead) won.miss = 0; else if (!(x && x.covered) && ++won.miss >= WON_MISS) enlargeWon.delete(mkey); }
          else if (plainRead) enlargeWon.set(mkey, { e: 0, miss: 0 });   // none kept yet, or the kept factor did not read this row
          else if (!won && eGame) {
            const r = tryEnlarged(eGame);
            if (isRead(r)) { enlargeWon.set(mkey, { e: eGame, miss: 0 }); return tagE(r, eGame); }
            if (verdict(r) && !vE) vE = tagE(r, eGame);
          }
          if (vE && !plainRead) return vE;
        }
        // A row with colours off the palette is covered (cursor or tooltip) in a lossless capture: not read in this frame
        // (pull request 207, Grant's live test of 2026-10-16 read well with it; compressed video replays lose such rows).
        if (x && x.covered) return fail('row covered (cursor or tooltip)', { exact: true, covered: true });
        // cut: the offer ends in "..." (the game's own cut); a line that is only not an offer here is no verdict on the row
        if (opts && opts.exactOnly && !(x && x.price != null && x.qty != null)) return fail(x && x.offer ? 'price cut off or not a price line' : 'no exact read', { exact: !!x, cut: !!(x && x.offer && /\.\.\.$/.test(x.offer)) });
        let old = null;
        const readOld = () => { if (!old) { const { g, W, H } = padBottom(toGray(imageData)); old = readGray(g, W, H, opts && opts.scale > 0 ? opts.scale : null); } return old; };
        if (x && x.price != null && x.qty != null) {
          // No old-matcher name here: it guesses (it read "DEX" as "DEY"); a name with "?" is matched exactly or not at all.
          return { price: x.price, qty: x.qty, nameText: x.name, nameWhy: x.name ? 'read' : 'letters weak', grade: x.grade, sold: x.kind === 'sold', confidence: 1, abstain: false, why: x.name ? 'read' : 'name not read', scale: flat ? opts.k : x.k, exact: true };
        }
        // An offer read exactly that is not "N for P mesos" (a price cut with "...", "884 for 499,999,999,999..."):
        // its digits may be cut too, so nothing is read, and the old matcher is not asked to guess.
        if (x && x.offer) return fail('price cut off or not a price line', { exact: true, sold: x.kind === 'sold' });
        const r = readOld();
        if (x) r.sold = x.kind === 'sold';
        // The old matcher reads leftward from "mesos" and "for", so it never sees a glyph missing at the line's start, and
        // a cover over "mesos" moves the price cells (review of #326, follow-up: "18 for 7,800" with its "1" under a
        // paper-coloured cover read 8x7800, its quantity starting at game px 51; "3 for 1,200" with "mesos" half covered
        // read 3x720, "mesos" matched at 0.61). On every local recording the 76 rows it reads start at 40.4-45.9 and
        // match "mesos" at 0.727 or more: a read past OLD_START_MAX or under OLD_MESOS_MIN is not taken (the name is kept).
        if (!r.abstain && r.raw) {
          const st = r.raw.line && opts && opts.k > 0 ? r.raw.line.qx0 / opts.k : null;
          const why = st != null && st > OLD_START_MAX ? 'quantity starts too far right (a glyph hidden)' : r.raw.mesos < OLD_MESOS_MIN ? '"mesos" matched weakly (covered)' : null;
          if (why) Object.assign(r, { price: null, qty: null, abstain: true, why });
        }
        // Not a whole-number scale: the name line's glyphs on the game pixel grid (learn.js), for the page's learned
        // table (live.js teaches it from rows whose name snapped, and reads names with it once it is sure).
        if (root.MesoLearn && !r.abstain && r.nameInfo && r.nameInfo.band) { try { r.glyphs = root.MesoLearn.cutName(imageData, { band: r.nameInfo.band, s: r.scale, k: opts && opts.k }); } catch { /* no glyphs */ } }
        return r;
      } catch (e) {
        return fail('reader error: ' + (e && e.message));
      }
    },
    resetScale() { lastScale = null; lastFine = null; },
    _sellerParts(imageData, s) { // for the atlas builder: the tag band the seller reader cuts, as ink blobs
      const { g, W, H } = toGray(imageData); PARTS = {};
      try { readSellerGray(g, W, H, s); } finally { var P = PARTS; PARTS = null; }
      if (!P || !P.b) return null;
      const m = inkMap(P.b); if (!m) return null; const B = inkBlobs(P.b, m, A.letters.seller && A.letters.seller.ink_thr); if (!B) return null;
      return { B, feat: (c0, c1) => glyphFeat(P.b, m, B.ya, c0, c1) };
    },
    // The seller's name from the shop window's seller area (capture.js sellerImage). opts.scale: the window's scale
    // (else the scale of the rows read last, else from the area's width). Returns {sellerText, sellerScore, why}.
    readSeller(imageData, opts) {
      if (!A) return { sellerText: null, sellerScore: null, why: 'atlas not loaded' };
      try {
        let exact = readSellerExact(imageData);   // the tag in the pixel font, exactly; else the old letters
        // A stretched window (fullscreen 1920x1080): the tag back on game pixels first. The seller area is 236 px of a
        // 1920 px window at UI scale 1, so the game's own scale is the area's width / 236 x 1920 / 1366.
        if (!exact) {
          const k = (imageData.width / 236) * 1920 / 1366;
          if (k > 1.1 && Math.abs(k - Math.round(k)) > 0.03) { const flat = unstretchTag(imageData, k); if (flat) exact = readSellerExact(flat); }
        }
        if (exact) return { sellerText: exact, sellerScore: 1, why: 'read', exact: true };
        const { g, W, H } = toGray(imageData);
        const s = (opts && opts.scale) || lastScale || W / 236;
        const r = readSellerGray(g, W, H, s);
        let glyphs = null; if (root.MesoLearn) { try { glyphs = root.MesoLearn.cutSeller(imageData); } catch { /* none */ } }   // learn.js, as for names
        return { glyphs, sellerText: r.text ? r.text.replace(/ /g, '') : null, sellerScore: r.score ?? null, why: r.text ? 'read' : r.why, info: r.info || null, tag: r.tag || null };
      } catch (e) { return { sellerText: null, sellerScore: null, why: 'reader error: ' + (e && e.message) }; }
    },
    _resample: (src, sw, sh, dw, dh) => resample(src, sw, sh, dw, dh),
    _unstretchRow: (img, k) => unstretchRow(img, k),
    _sharpGrid: (img, k) => sharpGrid(img, k),   // for tests: a whole-k row on a sharp grid
    _enlargeMiss: (e, k) => { const m = enlargeMiss.get(e.toFixed(3) + '|' + k.toFixed(3)); return m ? Object.assign({}, m) : null; },   // for tests: a factor's misses and wait
    _unstretchTag: (img, k) => unstretchTag(img, k),   // and a seller's tag   // for replay tools: a smoothly stretched row on game pixels
    // for the lab's name scoring (console/lab/livereader/names_fast.mjs): the item name alone, from a row's offer line
    _readName(imageData, line, s) { const { g, W, H } = toGray(imageData); return readName(g, W, H, line, s); },
    // for the atlas builder (console/lab/livereader/build_letters.mjs): the same cuts the reader uses
    _nameParts(imageData, line, s) {
      const { g, W, H } = toGray(imageData), b = nameBand(g, W, H, line, s); if (!b) return null;
      const m = inkMap(b); if (!m) return null; const B = inkBlobs(b, m); if (!B) return null;
      return { b, m, B, feat: (c0, c1) => glyphFeat(b, m, B.ya, c0, c1) };
    },
  };
  root.MesoRowReader = MesoRowReader;
  if (typeof module !== 'undefined' && module.exports) module.exports = MesoRowReader;
})(typeof self !== 'undefined' ? self : globalThis);

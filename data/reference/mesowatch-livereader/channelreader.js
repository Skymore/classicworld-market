/* MesoWatch live reader, part E: the CHANNEL NUMBER from the game's CHANGE CHANNEL menu (beta, FEATURES.liveReader).
   No OCR model, no network. Plain JS, no DOM: works in the page, in a Web Worker and in node (tests).

   self.MesoChannelReader = { findChannelMenu(imageData), readChannel(imageData, box?), watcher() }

   MapleStory Classic shows the channel only in the CHANGE CHANNEL menu. The menu (ported idea, not code, from the
   laptop's channel finder, console/lab/fmrooms/swaps.py):
   - a wide flat blue bar with the world's name ("WINDIA"); its width wb sets the scale of everything below it;
   - under the bar, a grid of grey channel buttons, 8 per row ("CH.1" .. "CH.18"; Classic GMS has 1 to about 20);
   - the button under the menu's cursor is BLUE. When the menu opens, the cursor is on the player's channel. When he
     picks another channel, the picked one is blue and his own channel turns DARK (with a small arrow);
   - a blue "CHANGE CHANNEL" and an orange "CANCEL" button at the bottom right.
   Geometry (measured on Grant's 1920x1080 recordings, 2026-10-16; the bar was 782 px wide), relative to the bar's
   left edge x0, top y0 and width wb: button column c starts at x0 + 0.1257 c wb and is 0.1215 wb wide; button row r
   starts at y0 + (0.0729 + 0.0396 r) wb and is 0.036 wb high; CANCEL spans x0 + 0.884..0.995 wb, y0 + 0.214..0.243 wb.

   findChannelMenu(imageData) -> {x0, y0, x1, y1, wb} (the blue bar) | null
   readChannel(imageData, box) -> {channel, picked, buttons, score, why}
     channel: the player's channel (the dark button, else the blue one), an integer 1..20, or null.
     picked:  the blue button when a dark one is also shown (the channel he is changing to), else null.
     A failed check gives channel null and the reason in why (no menu, cancel button missing, a row not full, no or
     two blue buttons, two dark buttons, more than 20 buttons). A failed check means no data, never a guess.
   watcher() -> {frame(imageData, ts, gameSeen) -> {channel, stale, alike}}: the per-frame helper capture.js calls.
     A cheap look on each frame (a long blue run on a 160-wide grid with grey buttons under it); the full search only then, and a search that
     found nothing is not repeated within a second; while the menu is open, the box found last is read again each frame
     (cheap: 20 buttons). (Once a second missed menus that were open for 2 frames at 3 frames a second.) A picked channel followed by a black frame (gameSeen === false) within 4 s is a channel change:
     the picked channel becomes the player's channel (swaps.py: a swap is the menu with a pick, then about one second
     of black screen). Only the pick on the LAST menu frame read counts, and only within 2.5 s of the black screen (on
     Grant's 5 recordings that pick was 0.7 to 1.6 s before the black and right 41 times of 41; earlier picks were
     changed 3 times before the swap). A black screen with no pick read is likely a channel change too when the menu was open in the
     4 s before it, or when it leads back to the SAME place (scene likeness >= 0.3): the channel becomes unknown (stale: true, channel null) until the menu is read again.
     A black screen that leads to another place (a map change) keeps the channel. */
(function (root) {
  'use strict';

  var G = {
    colPitch: 0.1257, btnW: 0.1215, row0: 0.0729, rowPitch: 0.0396, btnH: 0.036,
    cancel: [0.884, 0.214, 0.995, 0.243],
    barMinW: 0.15, barMaxW: 0.8,     // bar width as a share of the frame width
    barMinH: 0.03, barMaxH: 0.075,   // bar height as a share of the bar width (measured 0.054)
    maxChannel: 20,
  };
  // Scene likeness after a black screen that counts as the same place (see watcher). Grant's 5 trusted recordings
  // (2026-10-16, 3 frames a second): 41 channel changes 0.39 to 0.61 (other players move), 2 map changes 0.10 and 0.12.
  var SAME_PLACE = 0.3;

  function px(d, W, x, y) { var i = (y * W + x) * 4; return [d[i], d[i + 1], d[i + 2]]; }
  function isBar(r, g, b) { return b > 150 && r < 120 && g > 90 && g < 185 && b - r > 60; }

  // ---------------------------------------------------------------- the blue bar
  // Rows are sampled every s px; on each sampled row the long runs of bar blue are kept. Text and the world's icon
  // break the runs in the middle rows of the bar, but its top and bottom rows are clean: a bar is a set of rows (within
  // 0.075 wb of each other) whose runs start and end at the same x. Each candidate is checked by readChannel's grid.
  function barRuns(img, s, off) {
    var W = img.width, H = img.height, d = img.data, out = [];
    var minW = G.barMinW * W, maxW = G.barMaxW * W;
    for (var y = off || 0; y < H; y += s) {
      var start = -1, gap = 0, last = -1;
      for (var x = 0; x <= W; x += s) {
        var on = false;
        if (x < W) { var i = (y * W + x) * 4; on = isBar(d[i], d[i + 1], d[i + 2]); }
        if (on) { if (start < 0) start = x; last = x; gap = 0; }
        else if (start >= 0 && ++gap > 1) {   // one missed sample is noise; two end the run
          var w = last - start + s;
          if (w >= minW && w <= maxW) out.push({ y: y, a: start, b: last });
          start = -1; gap = 0;
        }
      }
    }
    return out;
  }

  // Refine the bar's edges at full resolution from a clean row (y) whose run is [a, b] (sampled).
  function refine(img, y, a, b, s) {
    var W = img.width, H = img.height, d = img.data, p;
    var x0 = a, x1 = b;
    while (x0 > 0 && (p = px(d, W, x0 - 1, y), isBar(p[0], p[1], p[2]))) x0--;
    while (x1 < W - 1 && (p = px(d, W, x1 + 1, y), isBar(p[0], p[1], p[2]))) x1++;
    var wb = x1 - x0 + 1;
    // top and bottom: in three columns, the blue continues up and down from y (text rows break single columns, so
    // the largest extent of the three is kept)
    var y0 = y, y1 = y;
    [0.03, 0.5, 0.97].forEach(function (f) {
      var x = Math.round(x0 + f * (wb - 1)), t = y, u = y;
      while (t > 0 && (p = px(d, W, x, t - 1), isBar(p[0], p[1], p[2]))) t--;
      while (u < H - 1 && (p = px(d, W, x, u + 1), isBar(p[0], p[1], p[2]))) u++;
      if (t < y0) y0 = t;
      if (u > y1) y1 = u;
    });
    return { x0: x0, y0: y0, x1: x1, y1: y1, wb: wb };
  }

  function candidates(img) {
    var s = Math.max(1, Math.floor(img.width / 640));
    // Every row offset: sampled rows that all fall on the bar's text rows miss it (a shared window's 31 px title bar
    // moved one menu by an odd number of rows, and every other row of its bar was broken by its text).
    var runs = [], out = [], used = {};
    for (var off = 0; off < s; off++) runs = runs.concat(barRuns(img, s, off));
    runs.sort(function (p, q) { return p.y - q.y || p.a - q.a; });
    for (var i = 0; i < runs.length; i++) {
      if (used[i]) continue;
      var r = runs[i], tol = Math.max(2 * s, 0.015 * (r.b - r.a)), group = [r];
      for (var j = i + 1; j < runs.length; j++) {
        var q = runs[j];
        if (q.y - r.y > G.barMaxH * (r.b - r.a) + s) break;
        if (Math.abs(q.a - r.a) <= tol && Math.abs(q.b - r.b) <= tol) { group.push(q); used[j] = 1; }
      }
      var box = refine(img, r.y, r.a, r.b, s), h = box.y1 - box.y0 + 1;
      if (h < G.barMinH * box.wb || h > G.barMaxH * box.wb) continue;
      if (box.x0 <= 1 || box.x1 >= img.width - 2) continue;                    // cut by the edge of the picture
      if (box.y0 + (G.cancel[3] + 0.01) * box.wb >= img.height) continue;      // the grid would be off the picture
      out.push(box);
    }
    return out;
  }

  // ---------------------------------------------------------------- one button
  // The inner part of a button (the text and the cursor hand cover part of it): the share of pixels of each kind.
  function classify(img, bx, by, bw, bh) {
    var W = img.width, d = img.data;
    var xa = Math.round(bx + 0.08 * bw), xb = Math.round(bx + 0.92 * bw), ya = Math.round(by + 0.2 * bh), yb = Math.round(by + 0.8 * bh);
    var step = Math.max(1, Math.floor((xb - xa) / 40)), n = 0, blue = 0, dark = 0, grey = 0, white = 0;
    for (var y = ya; y <= yb; y += Math.max(1, Math.floor(step / 2))) for (var x = xa; x <= xb; x += step) {
      var i = (y * W + x) * 4, r = d[i], g = d[i + 1], b = d[i + 2], mx = Math.max(r, g, b), mn = Math.min(r, g, b);
      n++;
      if (b > 160 && b - r > 80 && r < 150) blue++;
      else if (mx - mn < 30 && mx < 135) dark++;
      else if (mx - mn < 30 && mx >= 140 && mx <= 222) grey++;
      else if (mx - mn < 30 && mn > 222) white++;
    }
    if (!n) return { kind: '?', share: 0 };
    var sh = { blue: blue / n, dark: dark / n, grey: grey / n, white: white / n };
    // a button: mostly its face colour; text and a cursor hand are light and cover at most about 40%
    if (sh.blue >= 0.3 && sh.dark < 0.15) return { kind: 'blue', share: sh.blue };
    if (sh.dark >= 0.3 && sh.blue < 0.1) return { kind: 'dark', share: sh.dark };
    if (sh.grey >= 0.45 && sh.blue < 0.1 && sh.dark < 0.1) return { kind: 'grey', share: sh.grey };
    if (sh.white >= 0.75) return { kind: 'empty', share: sh.white };
    return { kind: '?', share: Math.max(sh.blue, sh.dark, sh.grey, sh.white) };
  }

  // The picture's height scale against its width (1 = square pixels), from where the orange CANCEL button sits under the
  // bar. Report R-DRBGA (Firefox, a 1928x1234 share drawn at 1928x1085 by capture.js gameView): a frame squashed or
  // stretched in height put the button rows, measured in bar widths, off the buttons, so no menu was ever read.
  // Looked for in three columns near the button's ends, clear of its white "CANCEL" letters (a smaller UI scale's letters
  // cut the run in the middle columns: rec2's 563 px menu was measured 7% short and missed), with gaps of a few pixels
  // bridged; 0.70 to 1.35 times its place on square pixels; 1 when not found.
  function isOrange(d, i) { return d[i] > 180 && d[i] - d[i + 2] > 90 && d[i + 1] > 70 && d[i + 1] < 200; }
  function vscale(img, box) {
    var W = img.width, H = img.height, d = img.data, wb = box.wb, c = G.cancel, mid = (c[1] + c[3]) / 2, ks = [], gapMax = Math.max(2, Math.round(0.012 * wb));
    [0.89, 0.975, 0.94].forEach(function (f) {
      var x = Math.round(box.x0 + f * wb), ya = Math.round(box.y0 + c[1] * 0.7 * wb), yb = Math.min(H - 1, Math.round(box.y0 + c[3] * 1.35 * wb)), t = -1, u = -1;
      if (x >= W) return;
      for (var y = ya; y <= yb; y++) {
        if (isOrange(d, (y * W + x) * 4)) { if (t < 0) t = y; u = y; }
        else if (t >= 0 && y - u > gapMax) break;
      }
      if (t >= 0 && u - t >= 0.01 * wb) ks.push(((t + u) / 2 - box.y0) / (mid * wb));
    });
    if (!ks.length) return 1;
    ks.sort(function (a, b) { return a - b; });
    var k = ks[ks.length >> 1];
    return k >= 0.7 && k <= 1.35 ? k : 1;
  }
  // The scales to try, in order: the button's shaded edge puts the measure a percent or two off, and on a small menu
  // (rec2's 563 px bar) the third row reads only within 1% of the true scale. Near 1 it is square pixels, the common
  // case (tried first); else the measure and steps of 1.5% around it.
  function kyTries(k) {
    if (Math.abs(k - 1) <= 0.05) return [1, k];
    return [k, k - 0.015, k + 0.015, k - 0.03, k + 0.03];
  }

  function cancelOk(img, box) {
    var W = img.width, d = img.data, wb = box.wb, c = G.cancel, ky = box.ky || 1;
    var xa = Math.round(box.x0 + c[0] * wb), xb = Math.round(box.x0 + c[2] * wb), ya = Math.round(box.y0 + c[1] * ky * wb), yb = Math.round(box.y0 + c[3] * ky * wb);
    if (xb >= img.width || yb >= img.height) return false;
    var n = 0, o = 0, step = Math.max(1, Math.floor((xb - xa) / 40));
    for (var y = ya; y <= yb; y += Math.max(1, Math.round(step * ky))) for (var x = xa; x <= xb; x += step) {
      var i = (y * W + x) * 4; n++;
      if (isOrange(d, i)) o++;
    }
    return n > 0 && o / n >= 0.3;
  }

  // ---------------------------------------------------------------- the grid
  function readChannel(img, box) {
    var none = function (why, extra) { var o = { channel: null, picked: null, buttons: null, score: 0, why: why }; if (extra) for (var k in extra) o[k] = extra[k]; return o; };
    if (!img || !img.data || !img.width) return none('no picture');
    if (!box) {
      var found = findChannelMenu(img);
      if (!found) return none('no channel menu');
      box = found;
    }
    var wb = box.wb;
    if (!(wb > 0)) return none('no channel menu');
    // the height scale: given with the box (a box found before), else measured from the CANCEL button and tried
    if (!box.ky) {
      var tries = kyTries(vscale(img, box)), res = null;
      for (var q = 0; q < tries.length; q++) { res = readChannel(img, Object.assign({}, box, { ky: tries[q] })); if (res.channel != null) return res; }
      return res;
    }
    var ky = box.ky;
    if (!cancelOk(img, box)) return none('no CANCEL button under the bar: not the channel menu');
    var bw = G.btnW * wb, bh = G.btnH * ky * wb, kinds = [], worst = 1;
    for (var r = 0; r < 3; r++) for (var c = 0; c < 8; c++) {
      var bx = box.x0 + G.colPitch * c * wb, by = box.y0 + (G.row0 + G.rowPitch * r) * ky * wb;
      if (bx + bw >= img.width || by + bh >= img.height) return none('the menu is cut by the edge of the picture');
      var k = classify(img, bx, by, bw, bh);
      kinds.push(k.kind);
      if (k.kind !== 'empty') worst = Math.min(worst, k.share);
    }
    // rows 1 and 2 are full; row 3 holds the last buttons, then empty places
    var buttons = 0;
    for (var i = 0; i < 24; i++) {
      if (kinds[i] === 'empty') break;
      if (kinds[i] === '?') return none('button ' + (i + 1) + ' could not be told', { kinds: kinds });
      buttons++;
    }
    if (buttons < 16) return none('only ' + buttons + ' buttons in a row: not the channel menu', { kinds: kinds });
    for (var j = buttons; j < 24; j++) if (kinds[j] !== 'empty') return none('a button after an empty place', { kinds: kinds });
    if (buttons > G.maxChannel) return none('more than ' + G.maxChannel + ' channels', { kinds: kinds });
    var blue = [], dark = [];
    for (var b = 0; b < buttons; b++) { if (kinds[b] === 'blue') blue.push(b + 1); else if (kinds[b] === 'dark') dark.push(b + 1); }
    if (blue.length !== 1) return none(blue.length ? 'two blue buttons' : 'no blue button', { kinds: kinds });
    if (dark.length > 1) return none('two dark buttons', { kinds: kinds });
    var channel = dark.length ? dark[0] : blue[0], picked = dark.length ? blue[0] : null;
    if (channel < 1 || channel > G.maxChannel) return none('channel out of range');
    return { channel: channel, picked: picked, buttons: buttons, score: Math.round(worst * 100) / 100, ky: Math.round(ky * 1000) / 1000, why: dark.length ? 'dark button (a pick is shown)' : 'blue button (menu just opened)' };
  }

  // the box comes back with its height scale (ky), so the watcher reads the open menu again without measuring it.
  // lastWhy: why the last search found no menu (no bar of its shape, or the first bar's reason at square pixels), for the
  // report (R-DCEDE: Chrome, a 1922x1081 share of normal shape, channel never seen, and nothing said why)
  var lastWhy = null;
  function findChannelMenu(img) {
    if (!img || !img.data || !img.width) return null;
    var c = candidates(img);
    lastWhy = c.length ? null : 'no bar of the menu\'s shape';
    for (var i = 0; i < c.length; i++) {
      var tries = kyTries(vscale(img, c[i]));
      for (var q = 0; q < tries.length; q++) {
        var b = Object.assign({}, c[i], { ky: tries[q] }), r = readChannel(img, b);
        if (r.channel != null) { lastWhy = null; return b; }
        if (lastWhy == null) lastWhy = r.why + ' (a ' + c[i].wb + ' px bar)';
      }
    }
    return null;
  }

  // ---------------------------------------------------------------- per-frame helper for capture.js
  // Under the menu's bar (0.06 to 0.13 of its width lower) the first row of grey buttons: a blue sky has none.
  function buttonsUnder(img, xa, xb, y) {
    var W = img.width, H = img.height, d = img.data, w = xb - xa, n = 0, grey = 0;
    for (var dy = 0.06; dy <= 0.13; dy += 0.01) {
      var yy = Math.round(y + dy * w);
      if (yy >= H) break;
      for (var x = xa; x <= xb; x += Math.max(1, Math.floor(w / 40))) {
        var i = (yy * W + x) * 4, r = d[i], g = d[i + 1], b = d[i + 2], mx = Math.max(r, g, b), mn = Math.min(r, g, b);
        n++; if (mx - mn < 30 && mx >= 140 && mx <= 222) grey++;
      }
    }
    return n > 0 && grey / n >= 0.25;
  }
  // Cheap first look (about 160 x 90 samples): a long run of bar blue on a row, with grey buttons under it.
  function maybeMenu(img) {
    var W = img.width, H = img.height, d = img.data, s = Math.max(1, Math.floor(W / 160)), need = Math.max(3, Math.floor(G.barMinW * W / s));
    for (var y = 0; y < H; y += s) {
      var run = 0, miss = 0;
      for (var x = 0; x < W; x += s) {
        var i = (y * W + x) * 4;
        if (isBar(d[i], d[i + 1], d[i + 2])) { run++; miss = 0; if (run >= need && buttonsUnder(img, x - (run - 1) * s, x, y)) return true; }
        else if (++miss > 1) { run = 0; miss = 0; }
      }
    }
    return false;
  }
  // A small grey picture of the scene (96 x 54; the bottom rows with the status bar are left out), and how alike two
  // are (1 = the same place): console/lab/fmrooms/swaps.py small() and alike().
  // The game area only, as capture.js frameCues: a shared window's white title bar (the top ~4% of the frame), the same
  // before and after any black screen, made two different maps look alike (a map change was taken for a channel change).
  function scene(img) {
    var W = img.width, H = img.height, d = img.data, out = new Float32Array(96 * 44), m = 0;
    var x0 = W * 0.01, gw = W * 0.98, y0 = H * 0.06, gh = H * 0.93;
    for (var y = 0; y < 44; y++) for (var x = 0; x < 96; x++) {
      var i = (((y0 + (y + 0.5) * gh / 54) | 0) * W + ((x0 + (x + 0.5) * gw / 96) | 0)) * 4, v = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
      out[y * 96 + x] = v; m += v;
    }
    m /= out.length;
    for (var k = 0; k < out.length; k++) out[k] -= m;
    return out;
  }
  function alike(a, b) {
    var s = 0, sa = 0, sb = 0;
    for (var i = 0; i < a.length; i++) { s += a[i] * b[i]; sa += a[i] * a[i]; sb += b[i] * b[i]; }
    return sa && sb ? s / Math.sqrt(sa * sb) : 0;
  }

  function watcher(o) {
    o = o || {};
    var every = o.searchMs || 1000, swapMs = o.swapMs || 4000, pickMs = o.pickMs || 2500, same = o.samePlace == null ? SAME_PLACE : o.samePlace;
    var hint = null, searchedAt = -Infinity, channel = null, stale = false, pending = null, last = null, black = null, lastAlike = null, menuAt = -Infinity, inBlack = false;
    // why: the reason the last menu-like frame was not read (null once a menu is read); a frame with no menu-like blue
    // run leaves it as it was, so it tells why the menu the player opened was missed
    var why = null, looks = 0;   // looks: frames whose cheap look found a menu-like blue run
    function take(r, ts) {
      if (!r || r.channel == null) { if (r && r.why && channel == null) why = r.why; return false; }   // a channel read: the menu closing is no fault (review of bundle-326)
      channel = r.channel; stale = false; menuAt = ts; why = null;
      pending = r.picked != null && r.picked !== r.channel ? { picked: r.picked, ts: ts } : null;
      return true;
    }
    function out() { return { channel: channel, stale: stale, alike: lastAlike, why: why, looks: looks }; }
    return {
      // -> {channel, stale, alike}. stale: the channel was known, then a black screen led back to the same place with
      // no pick read (the teardown's hint: a fade to black and back to the same map is likely a channel change), so the
      // old channel is dropped (channel null) until the menu is read again.
      frame: function (img, ts, gameSeen) {
        if (gameSeen === false) {   // a black frame: a pick shown just before it was a channel change
          if (!inBlack) {           // decided once, on the first black frame of the black screen
            inBlack = true;
            if (pending && ts - pending.ts <= pickMs) { channel = pending.picked; stale = false; }
            else if (channel != null && last) black = { before: last, menu: ts - menuAt <= swapMs };
          }
          pending = null; hint = null;
          return out();
        }
        inBlack = false;
        if (black) {   // the first frame after the black screen: the same place means another channel
          lastAlike = Math.round(alike(black.before, scene(img)) * 100) / 100;
          // the menu was open just before (its pick not seen: at 3 frames a second a pick shows for 0-1 frames), or the
          // same place again: likely another channel
          if (black.menu || lastAlike >= same) { channel = null; stale = true; }
          black = null;
        }
        last = scene(img);
        if (pending && ts - pending.ts > pickMs) pending = null;
        if (hint) {
          var r = readChannel(img, hint);
          if (!take(r, ts)) hint = null;
          return out();
        }
        // the full search only when a cheap look finds a long blue run; a search that found nothing (a blue sky)
        // is not repeated within a second
        if (!maybeMenu(img)) return out();
        looks++;
        if (ts - searchedAt < every) return out();
        var box = findChannelMenu(img);
        if (box) { hint = box; take(readChannel(img, box), ts); } else { searchedAt = ts; if (lastWhy && channel == null) why = lastWhy; }
        return out();
      },
      channel: function () { return channel; },
    };
  }

  var api = { _maybeMenu: maybeMenu, findChannelMenu: findChannelMenu, readChannel: readChannel, watcher: watcher, _geometry: G };
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.MesoChannelReader = api;
})(typeof self !== 'undefined' ? self : typeof window !== 'undefined' ? window : globalThis);

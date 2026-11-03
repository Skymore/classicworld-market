// Live reader glue (beta, FEATURES.liveReader; plan: agents/proposals/live-reader-plan.md, phase 1).
// window.MesoLive.start(stream, onRow, {onError, onFrame, catalog, catalogUrl}) reads the shared game window ON THE PLAYER'S PC and calls onRow once
// per shop row it reads. live.js itself sends nothing; MesoLive.tracker() below keeps the Record tab's live state (where
// the player is, the alerts, one card per shop visit, the log) and builds the rows the page sends to /v1/sightings. The parts load lazily from js/livereader/:
//   capture.js  window.MesoLiveCapture.start(stream, onShop) -> stop()      finds open shop windows in the frames
//   worker.js   a Web Worker that runs reader.js (self.MesoRowReader) with atlas.json   reads one row picture
//   snap.js     window.MesoSnap.load(catalog) with catalog.json, snap(nameText) -> {item_id, name, icon, score} | null
// A missing part gives a clear error (the returned promise rejects, or options.onError for a later fault); the page
// never crashes. A row the reader is not sure of comes out with abstain: true and no guessed values.
window.MesoLive = (() => {
  const BASE = (() => {  // this file's folder and its "?v=marketNNN", so the parts load from the same release
    const src = document.currentScript?.src || [...document.scripts].map((s) => s.src).find((s) => /livereader\/live\.js/.test(s)) || "js/livereader/live.js";
    const url = new URL(src, location.href);
    return { dir: url.href.replace(/[^/]*$/, ""), query: url.search };
  })();
  let session = 0, stopCapture = null, worker = null, onRowNow = null, onErrorNow = null, readerVersion = "", frameSize = null;
  let learn = null;   // window.MesoLearn (learn.js) once loaded
  // Reader speed for the live log: ms from a shop's rows reaching the reader to the last row read (the newest 10 shops).
  let shopMs = [], rowsRead = [];
  const avg = (a) => (a.length ? Math.round(a.reduce((x, y) => x + y, 0) / a.length) : null);
  const clock = () => (typeof performance !== "undefined" && performance.now ? performance.now() : Date.now());
  const loaded = {};

  function loadScript(name, global) {
    if (window[global]) return Promise.resolve(window[global]);
    loaded[name] ??= new Promise((resolve, reject) => {
      const s = document.createElement("script");
      s.src = BASE.dir + name + BASE.query;
      s.onload = () => (window[global] ? resolve(window[global]) : reject(new Error(`The live reader part ${name} loaded but did not set ${global}.`)));
      s.onerror = () => reject(new Error(`The live reader part ${name} is missing.`));
      document.head.append(s);
    }).catch((e) => { delete loaded[name]; throw e; });
    return loaded[name];
  }

  // The row reader runs in a Web Worker, so the page stays smooth. Each request has an id; the answer comes back with it.
  function startWorker() {
    return new Promise((resolve, reject) => {
      let w;
      try { w = new Worker(BASE.dir + "worker.js" + BASE.query); } catch (e) { return reject(new Error("The live reader could not start its worker: " + (e?.message || e))); }
      const waiting = new Map();
      let next = 1, ready = false;
      const fail = (message) => {
        const e = new Error(message);
        for (const [, p] of waiting) p.reject(e);
        waiting.clear();
        if (!ready) reject(e); else onErrorNow?.(e);
      };
      w.onerror = (ev) => { ev.preventDefault?.(); fail("The live reader's worker failed: " + (ev.message || "worker.js or reader.js is missing")); };
      w.onmessage = (ev) => {
        const m = ev.data || {};
        if (m.type === "ready") { ready = true; readerVersion = String(m.version || ""); return resolve({ read, readMany, readSeller, terminate: () => { w.terminate(); fail("stopped"); } }); }
        if (m.type === "error" && m.id == null) return fail("The live reader could not load: " + m.message);
        const p = waiting.get(m.id); if (!p) return;
        waiting.delete(m.id);
        // the transferred buffers come back: the row pictures are whole again
        if (p.images && Array.isArray(m.buffers)) p.images = p.images.map((im, i) => m.buffers[i] ? wrapPixels(m.buffers[i], im.width, im.height) : im);
        m.type === "error" ? p.reject(new Error(m.message)) : p.resolve(p.images ? { results: m.result, images: p.images } : m.result);
      };
      function read(imageData) {
        const id = next++;
        return new Promise((res, rej) => { waiting.set(id, { resolve: res, reject: rej }); w.postMessage({ type: "read", id, imageData }); });
      }
      // Several rows in one message. Each row's pixel buffer is transferred to the worker (no copy) and handed back
      // with the results, so the row pictures stay usable here (the rare evidence picture).
      function readMany(images) {
        const id = next++;
        const rows = images.map((im) => ({ width: im.width, height: im.height, buffer: im.data.buffer, scale: im.scaleHint || null, k: im.gameScale || null, pad: im.pad || null, enlarge: im.enlarge || null, enlargeGame: im.enlargeGame || null, at: im.at || null }));
        return new Promise((res, rej) => {
          waiting.set(id, { resolve: res, reject: rej, images });
          try { w.postMessage({ type: "rows", id, rows }, rows.map((r) => r.buffer)); }
          catch (e) { waiting.delete(id); rej(e); }
        });
      }
      // The seller's name tag (player store). scale: the window's scale (the seller area is 236 px wide at scale 1).
      function readSeller(imageData, scale) {
        const id = next++;
        return new Promise((res, rej) => { waiting.set(id, { resolve: res, reject: rej }); w.postMessage({ type: "seller", id, imageData, scale }); });
      }
      setTimeout(() => { if (!ready) { w.terminate(); fail("The live reader's worker did not get ready in 20 seconds."); } }, 20000);
    });
  }

  // Pixels back from the worker as ImageData (a plain {width, height, data} where ImageData is missing, as in tests).
  function wrapPixels(buffer, width, height) {
    const data = new Uint8ClampedArray(buffer);
    try { return new ImageData(data, width, height); } catch { return { width, height, data }; }
  }
  // Several workers read a shop's rows side by side (one worker read the rows one after another: about 300 ms a shop
  // on a 1080p recording). Up to 4, and never more than half the PC's cores.
  function poolSize() {
    const n = typeof navigator !== "undefined" && navigator.hardwareConcurrency ? navigator.hardwareConcurrency : 2;
    return Math.max(1, Math.min(4, Math.floor(n / 2)));
  }
  async function startPool(n) {
    const first = await startWorker();
    // the other workers start in the background; until one is ready its share goes to the ready ones
    const all = [first];
    for (let i = 1; i < n; i++) startWorker().then((w) => { if (all.stopped) w.terminate(); else all.push(w); }, () => {});
    let rr = 0;
    return {
      read: (im) => all[rr++ % all.length].read(im),
      readSeller: (im, sc) => all[rr++ % all.length].readSeller(im, sc),
      // the rows split into one batch per worker; resolves to one result per row (or a rejection per batch)
      readRows(images) {
        const k = Math.min(all.length, images.length), parts = [];
        for (let j = 0; j < k; j++) parts.push([]);
        images.forEach((im, i) => parts[i % k].push(i));
        const at = rr; rr += k;   // the next shop starts on the next worker
        return parts.map((idx, j) => {
          const w = all[(at + j) % all.length];
          return { idx, done: w.readMany ? w.readMany(idx.map((i) => images[i])) : Promise.all(idx.map((i) => w.read(images[i]))).then((results) => ({ results, images: idx.map((i) => images[i]) })) };
        });
      },
      size: () => all.length,
      terminate() { all.stopped = true; for (const w of all) w.terminate(); },
    };
  }

  // A seller's picture as a data URL: capture.js may hand a data URL, a canvas, an ImageBitmap or ImageData.
  function toDataUrl(pic) {
    if (!pic) return null;
    if (typeof pic === "string") return pic.startsWith("data:image/") ? pic : null;
    try {
      const c = document.createElement("canvas");
      c.width = pic.width; c.height = pic.height;
      const g = c.getContext("2d");
      if (pic instanceof ImageData) g.putImageData(pic, 0, 0); else g.drawImage(pic, 0, 0);
      return c.toDataURL("image/png");
    } catch { return null; }
  }
  const textOrNull = (v) => (typeof v === "string" && v.trim() ? v.trim() : typeof v === "number" ? String(v) : null);

  async function start(stream, onRow, options = {}) {
    stop();
    const me = ++session;
    onRowNow = onRow; onErrorNow = options.onError || null;
    if (!stream?.getVideoTracks?.().length) throw new Error("The live reader needs a shared window.");
    if (typeof Worker === "undefined") throw new Error("This browser cannot run the live reader (no Web Workers).");
    const [capture, reader, snap] = await Promise.all([
      loadScript("capture.js", "MesoLiveCapture"),
      startPool(poolSize()),
      // The name matcher is a help: without it rows still show, with the name as read and no icon.
      // snap.js's load() takes the catalog itself ({items: [[id, name, icon], ...]}), so this file fetches it.
      loadScript("snap.js", "MesoSnap").then(async (s) => {
        const catalog = options.catalog || await fetch(options.catalogUrl || BASE.dir + "catalog.json" + BASE.query)
          .then((r) => { if (!r.ok) throw new Error("catalog.json is missing (" + r.status + ")"); return r.json(); });
        if (!s.load(catalog)) throw new Error("the item catalog is empty");
        return s;
      })
        .catch((e) => { onErrorNow?.(new Error("Item names are not matched: " + e.message)); return null; }),
    ]);
    if (me !== session) { reader.terminate(); throw new Error("stopped"); }
    worker = reader;
    try { const st = stream.getVideoTracks()[0].getSettings?.() || {}; frameSize = st.width && st.height ? { w: st.width, h: st.height } : null; } catch { frameSize = null; }
    const onShop = (shop) => { if (me === session) readShop(shop, snap, reader, me).catch((e) => onErrorNow?.(e)); };
    // Nudges (Grant: "real time nudges/remindres to open mini-map and show channle"): every frame says whether a
    // minimap and a channel can be seen. Older capture.js files give only minimapImage and channelImage; then a null
    // picture means "not seen".
    const onFrame = (info) => {
      if (me !== session || !options.onFrame || !info) return;
      const has = (flag, pic) => (typeof info[flag] === "boolean" ? info[flag] : pic in info ? info[pic] != null : null);
      // channel (a number), map and room: read by capture.js when it can (field names read loosely); null when not.
      const channel = info.channel ?? info.channelNumber ?? null, map = info.map ?? info.mapName ?? info.mapText ?? null, room = info.room ?? null;
      // diag: capture.js's frame size, surface, UI scale and speed, with the reader's ms a shop and rows a second added.
      let diag = null;
      if (info.diag) {
        const t = clock(); while (rowsRead.length && t - rowsRead[0].t > 10000) rowsRead.shift();
        const n = rowsRead.reduce((x, r) => x + r.n, 0), span = rowsRead.length ? Math.max(1, (t - rowsRead[0].t) / 1000) : 0;
        diag = { ...info.diag, msShop: avg(shopMs), rowsPerSec: span ? Math.round(n / span * 10) / 10 : null };
      }
      try { options.onFrame({ ts: info.ts ?? null, gameSeen: info.gameSeen ?? null, shopOpen: info.shopOpen ?? null, hasMinimap: has("hasMinimap", "minimapImage"), hasChannel: has("hasChannel", "channelImage"), channel, channelStale: info.channelStale === true, channelWhy: info.channelWhy ?? null, channelLooks: info.channelLooks ?? null, map, room, mapWhy: info.mapWhy ?? null, mapScale: info.mapScale ?? null, mapScaleOf: info.mapScaleOf ?? null, mapEnlarge: info.mapEnlarge ?? null, diag }); } catch (e) { console.warn("[MesoLive] the frame handler failed", e); }
    };
    // learned glyphs (learn.js): names and seller tags read exactly at a UI scale that is not a whole number, once the
    // player's own rows taught the table; not waited for, the reader works without it
    loadScript("learn.js", "MesoLearn").then((L) => { learn = L; }).catch(() => null);
    loadScript("channelreader.js", "MesoChannelReader").catch(() => null);   // the channel from the CHANGE CHANNEL menu; capture.js uses it once loaded
    // the map name from the minimap title: mapreader.js and its templates (maps.json); capture.js uses it once loaded.
    // font.js too, on the page: the minimap collapsed to its one-line bar is read in the shop font (mapreader.js readBar)
    loadScript("font.js", "MesoShopFont").catch(() => null);
    loadScript("mapreader.js", "MesoMapReader")
      .then((R) => R.loaded() ? R : fetch(BASE.dir + "maps.json" + BASE.query).then((r) => { if (!r.ok) throw new Error("maps.json " + r.status); return r.json(); }).then((j) => { R.load(j); return R; }))
      .catch((e) => console.warn("[MesoLive] the map reader did not load", e));
    try { stopCapture = capture.start(stream, onShop, { onFrame, keepFrames: typeof options.keepFrames === "function" ? options.keepFrames : options.keepFrames === true }); }   // keepFrames: the report's frames (true, or a function asked on every frame)
    catch (e) { stop(); throw new Error("The live reader could not watch the window: " + (e?.message || e)); }
    if (stopCapture && typeof stopCapture.then === "function") stopCapture = await stopCapture;  // start() may be async
  }

  // One shop window, as capture.js found it: its rows' pictures and what it read around them. The field names are
  // read loosely, so small changes in capture.js do not break the list.
  async function readShop(shop, snap, reader, me) {
    if (!shop) return;
    const visitId = String(shop.visitId ?? shop.visit_id ?? shop.id ?? "visit-" + Date.now());
    let seller = textOrNull(shop.seller ?? shop.sellerText ?? shop.seller_name), sellerScore = null;
    // Read the seller's name tag with the letters (reader.js readSeller); null when unsure, then the card shows its picture.
    // It is read side by side with the rows (it used to hold them back).
    const sellerPic = shop.sellerImage && shop.sellerImage.data && shop.sellerImage.width ? shop.sellerImage : null;
    const sellerRead = !seller && sellerPic && reader.readSeller
      ? reader.readSeller(sellerPic, sellerPic.width / 236).then((s) => {
        // the tag's glyphs from the learned table first (all of them found), else the reader's own read
        const ls = s && !s.exact ? learnedSeller(s.glyphs) : null;
        if (ls) { seller = ls; sellerScore = 1; } else if (s && s.sellerText) { seller = s.sellerText; sellerScore = s.sellerScore ?? null; }
      }, () => {})
      : Promise.resolve();
    const base = () => ({
      visitId, seller, sellerScore, title: textOrNull(shop.title ?? shop.titleText),
      channel: textOrNull(shop.channel), map: textOrNull(shop.map ?? shop.mapName), room: textOrNull(shop.room),
      avatarDataUrl: toDataUrl(shop.avatarDataUrl ?? shop.avatar ?? shop.avatarImage ?? shop.sellerPicture),
      // The seller's name as a picture, for the card while no reader reads the name as text.
      sellerPicUrl: seller ? null : toDataUrl(shop.sellerImage),
      frame: shop.frameWidth && shop.frameHeight ? { w: shop.frameWidth, h: shop.frameHeight } : frameSize,
      // capture.js's list places of the rows on screen in this frame, top to bottom (the tracker orders the shop by them)
      view: Array.isArray(shop.view) ? shop.view.slice(0, 64) : null,
    });
    const rows = (Array.isArray(shop.rows) ? shop.rows : []).map((row, n) => ({ row, n, imageData: row instanceof ImageData ? row : row?.imageData ?? row?.image }))
      .filter((x) => x.imageData), t0 = clock();
    // capture.js's scale for each row goes with its picture to the worker (a search hint for reader.js)
    for (const x of rows) if (x.row?.scale > 0) { try { x.imageData.scaleHint = x.row.scale; } catch { /* frozen */ } }
    // and its game pixel size (screen px per game px), for learn.js's grid
    for (const x of rows) if (x.row?.gameScale > 0) { try { x.imageData.gameScale = x.row.gameScale; } catch { /* frozen */ } }
    // and the margin a stretched row was cut with (capture.js rowImage), so reader.js finds the row inside it
    for (const x of rows) if (Array.isArray(x.row?.pad)) { try { x.imageData.pad = x.row.pad; } catch { /* frozen */ } }
    // and the cut's place in the frame (reader.js keeps the game grid's phase in frame terms from row to row) with the
    // browser's enlargement of the shared frame, so reader.js can undo it (R-RKFFH), and capture.js's guess at a 1080p
    // game drawn larger again (enlargeGame, R-4276X)
    for (const x of rows) if (Array.isArray(x.row?.at)) { try { x.imageData.at = x.row.at; if (x.row.enlarge > 1) x.imageData.enlarge = x.row.enlarge; if (x.row.enlargeGame > 1) x.imageData.enlargeGame = x.row.enlargeGame; } catch { /* frozen */ } }
    const one = (x, r, imageData) => {
      const abstain = !!r.abstain;
      let hit = !abstain && snap && r.nameText ? safeSnap(snap, r.nameText, !!r.exact, r.grade) : null;
      // Learned glyphs (learn.js), at a scale that is not a whole number: the name read glyph by glyph from the table,
      // taken only when every glyph was found and the name snaps exactly. A sure matcher read teaches the table.
      if (r.glyphs && !r.exact && !abstain) {
        const lh = learnedName(r.glyphs, snap, r.grade);
        // taught only by the matcher's own sure snap, and not when the learned read names another item
        if (hit && learn && !x.row?.covered && r.price != null && r.qty != null && hit.score >= TEACH_SCORE && (!lh || lh.hit.item_id === hit.item_id)) { try { learn.teach(r.glyphs, hit.name); } catch { /* not learned */ } }
        if (lh) { r = { ...r, nameText: lh.text, nameScore: 1 }; hit = lh.hit; }
      }
      // why: the reader's reason when the row abstains; nameWhy: why no item was found for a row whose price was read.
      const why = abstain ? textOrNull(r.why) || "not read" : null;
      const nameWhy = abstain || hit ? null : r.nameText ? (snap ? (r.exact ? (/\?/.test(r.nameText) ? "a letter the font lacks" : /\.\.\.$/.test(r.nameText) ? "cut name fits several items" : "not in the catalog") : "no catalog match") : "catalog not loaded") : textOrNull(r.why) || "name not read";
      emit({
        ...base(), index: x.row?.index ?? x.n,
        price: abstain ? null : r.price ?? null, qty: abstain ? null : r.qty ?? null,
        sold: r.sold ?? x.row?.sold ?? null, nameText: abstain ? null : r.nameText ?? null,
        item_id: hit?.item_id ?? null, itemName: hit?.name ?? null, icon: hit?.icon ?? null,
        confidence: typeof r.confidence === "number" ? r.confidence : null, nameScore: typeof r.nameScore === "number" ? r.nameScore : null, abstain, why, nameWhy,
        // where the reader found the name line in the row picture ([x0, y0, y1], row pixels) and its unsure guess: for
        // the name crop of a row whose name did not snap (sent to the private names table, never priced)
        nameBand: Array.isArray(r.nameInfo?.band) ? r.nameInfo.band : null, nameGuess: textOrNull(r.nameInfo?.guess),
        // the row picture, kept by the page for the rare evidence picture and the name crop: without the margin a stretched
        // row was cut with (capture.js rowImage), so it is the row box the reader's nameBand is measured on
        ts: shop.ts ?? Date.now(), image: unpad(imageData, x.row?.pad),
      });
    };
    const batches = reader.readRows ? reader.readRows(rows.map((x) => x.imageData))
      : [{ idx: rows.map((_, i) => i), done: Promise.all(rows.map((x) => reader.read(x.imageData))).then((results) => ({ results, images: rows.map((x) => x.imageData) })) }];
    await Promise.all(batches.map(async (b) => {
      let got;
      try { got = await b.done; } catch (e) { if (me === session) onErrorNow?.(e); return; }
      await sellerRead;   // the first rows wait for the seller's name (it reads in about the time of one row)
      if (me !== session) return;
      b.idx.forEach((i, j) => { const r = got.results[j]; if (r) one(rows[i], r, got.images[j]); });
    }));
    if (me === session && rows.length) {
      shopMs.push(clock() - t0); if (shopMs.length > 10) shopMs.shift();
      rowsRead.push({ t: clock(), n: rows.length });
    }
  }
  // The matcher's snap score a row must reach to teach the learned table (with its price and quantity read).
  const TEACH_SCORE = 0.92;
  // A name read with the learned glyphs: {text, hit} when every glyph was found and the text snaps exactly, else null.
  function learnedName(glyphs, snap, grade) {
    if (!learn || !snap?.snapExact) return null;
    try {
      const t = learn.read(glyphs);
      if (!t || !t.full) return null;
      const hit = snap.snapExact(t.text, { grade });
      if (hit) { try { learn.noteExact?.(glyphs.k); } catch { /* count only */ } }
      return hit ? { text: t.text, hit } : null;
    } catch { return null; }
  }
  // A seller's name read with the learned glyphs (no catalog to check it, so every glyph must be found): text or null.
  function learnedSeller(glyphs) {
    if (!learn || !glyphs) return null;
    try { const t = learn.read(glyphs, { noSpaces: true }); return t && t.full && t.text.length >= 2 && t.text.length <= 13 ? t.text : null; } catch { return null; }
  }
  // An exact read (reader.js readExact) is matched exactly (snap.js snapExact), never fuzzily.
  function safeSnap(snap, text, exact, grade) { try { return (exact && snap.snapExact ? snap.snapExact(text, { grade }) : snap.snap(text)) || null; } catch { return null; } }
  function emit(row) { try { onRowNow?.(row); } catch (e) { console.warn("[MesoLive] the row handler failed", e); } }

  function stop() {
    session++; shopMs = []; rowsRead = [];
    try { typeof stopCapture === "function" ? stopCapture() : stopCapture?.stop?.(); } catch {}
    stopCapture = null;
    try { worker?.terminate(); } catch {}
    worker = null;
  }

  // Which nudge a frame asks for: at most one, the minimap first. "" when the frame has both (or says nothing).
  const nudgeFor = (f) => (f?.hasMinimap === false ? "minimap" : f?.hasChannel === false ? "channel" : "");

  // ---------- the Record tab's live state (Grant, 2026-10-16: "real time shops showing up under the record pael",
  // "alerts/messages when mini-map is not shown", "channel alert when we have not seen that", "a real time log") ----------
  // tracker({world, version, send, now, random, uuid, encodePng}) -> {frame, row, tick, flush, status, alerts, shops,
  // log, payload, rev}. Pure state: no DOM, so tests run it in node. `send(body)` posts one sightings body and resolves
  // to the answer or rejects with {status}; the tracker writes the outcome to the log.
  const ALERT = {
    minimap: "Open your minimap: we can't place shops without it",
    mapHidden: "Map not shown: open the minimap fully",
    channel: "Show your channel once: open the channel menu",
    channelUnsure: "Channel may have changed: open the channel menu once",
    signin: "Sign in to send your shops to MesoWatch: shops are read, but nothing is sent",
    scale: "For best reading, play windowed at 1366x768 (or set the game window to 2x)",
  };
  // L2.3: the game's pixels on screen per game pixel: the UI scale (1.0 for any 16:9 window) x frame width / 1366.
  // Near a whole number (within this much) the font reads exactly; else the learned table must first learn it.
  const WHOLE_TOL = 0.005, LEARNED_ENOUGH = 0.9;
  const QUIET_MS = 2000;      // a visit unchanged this long is sent
  // The visits due go together, at most one call this often (2026-10-17: one call per shop, ~45 a minute in a busy
  // session, while the Workers plan ran out of its 100,000 requests a day). A call holds at most what the upload Worker
  // takes (index.ts sightingsCall: 100 rows in all, 200 sightings, 256 KB; the bytes kept lower for the JSON around).
  const BATCH_MS = 5000, CALL_ROWS = 100, CALL_SIGHTINGS = 200, CALL_BYTES = 200 * 1024;
  const KEEPALIVE_BYTES = 48 * 1024;   // keepalive calls (the tab closes): Chrome takes at most 64 KB of them in flight, shared with upload.js logFlush
  const MERGE_MS = 5000;      // a visit started this soon after the last one may be the same shop (sameShop)
  const SELLER_MERGE_MS = 60000;   // ... and with the same seller, this soon (one shop per seller; a long list scrolled slowly)
  const SETTLE_MS = 1000, LOST_MS = 8000;   // "back" settles in 1 s; "lost" only after 8 s (a shop window or a tooltip over the
  // minimap for a few seconds made it flicker lost/back 5-6 times in 40 s on 2 of Grant's recordings)     // a minimap change counts (alert and log) once it held this long, so one odd frame does not flicker
  const LOG_MAX = 50, VISITS_MAX = 50, RETRY_MAX = 5;
  // A visit keeps at most this many rows; a 33rd different row starts a new visit ("Shop too long: split"). A real shop
  // is smaller (the game's limit is asked of Grant), so a longer list is two shops capture took for one.
  const VISIT_ROWS_MAX = 32;
  const EVIDENCE_EVERY = 50;  // about 1 sighting in 50 carries one row picture
  const EVIDENCE_MAX = 60 * 1024;
  // Two more pictures (ingest API v1 "Pictures"; Grant, 2026-10-17: "3a get it cranking"), private bucket only, never priced:
  // the seller's character picture (the one the card shows) with a visit's FIRST successful send, PNG, at most 30 KB;
  // the name line of a row whose name did not snap, PNG, at most 8 KB, at most 20 per session (10 in one send, so a
  // call stays well under the Worker's 256 KB).
  const SELLER_PIC_MAX = 30 * 1024, NAME_CROP_MAX = 8 * 1024, NAME_CROPS_PER_SESSION = 20, NAME_CROPS_PER_SEND = 10, SIGHTING_ROWS = 32;
  const b64Bytes = (b64) => Math.floor(b64.length * 3 / 4) - (b64.endsWith("==") ? 2 : b64.endsWith("=") ? 1 : 0);
  // A row picture cut with a margin (capture.js rowImage; pad: [left, top, right, bottom] px) back to the row box: the
  // same pixels as a cut of the box alone (Larry's review of pull request 241: the name crops came out 22 px left and
  // 17 px up at 1080p). A plain {width, height, data}; the picture itself when there is no margin.
  function unpad(img, pad) {
    if (!Array.isArray(pad) || pad.length !== 4 || !img?.data) return img;
    pad = pad.map((v) => Math.max(0, v | 0));   // a negative margin (an older capture.js, a box past the frame) cuts nothing
    if (!pad.some((v) => v > 0)) return img;
    const W = img.width | 0, w = W - pad[0] - pad[2], h = (img.height | 0) - pad[1] - pad[3];
    if (!(w > 0 && h > 0) || img.data.length < W * img.height * 4) return img;
    const out = new Uint8ClampedArray(w * h * 4);
    for (let y = 0; y < h; y++) out.set(img.data.subarray(((pad[1] + y) * W + pad[0]) * 4, ((pad[1] + y) * W + pad[0] + w) * 4), y * w * 4);
    return { width: w, height: h, data: out };
  }
  // The name line of a row picture ({width, height, data}): the reader's band when it gave one, else the top half of
  // the row (where the name line sits above the offer line). A plain {width, height, data}; null when it cannot be cut.
  function nameCrop(img, band) {
    const W = img?.width | 0, H = img?.height | 0;
    if (!W || !H || !img.data || img.data.length < W * H * 4) return null;
    let x0 = 0, y0 = 0, y1 = Math.floor(H / 2);
    if (Array.isArray(band) && band.length >= 3 && band.every((v) => Number.isFinite(v))) {
      x0 = Math.max(0, Math.min(W - 1, Math.round(band[0]))); y0 = Math.max(0, Math.min(H - 1, Math.round(band[1]))); y1 = Math.max(y0 + 1, Math.min(H, Math.round(band[2])));
    }
    const w = W - x0, h = y1 - y0;
    if (w < 4 || h < 4) return null;
    const out = new Uint8ClampedArray(w * h * 4);
    for (let y = 0; y < h; y++) out.set(img.data.subarray(((y0 + y) * W + x0) * 4, ((y0 + y) * W + W) * 4), y * w * 4);
    return { width: w, height: h, data: out };
  }
  const pad = (n) => String(n).padStart(2, "0");
  const hms = (t) => { const d = new Date(t); return pad(d.getHours()) + ":" + pad(d.getMinutes()) + ":" + pad(d.getSeconds()); };
  const chNum = (v) => { const n = Number(String(v ?? "").replace(/^\s*(ch\.?|channel)\s*/i, "")); return Number.isInteger(n) && n >= 1 && n <= 99 ? n : null; };
  const str = (v) => (v == null ? null : String(v).trim() || null);
  // The upload Worker's field rules (console/lab/upload/worker/src/index.ts): a whole number in [lo, hi], a number in
  // [0, 1], text of at most `max` characters with no control characters; null when not.
  const whole = (v, lo, hi) => (typeof v === "number" && Number.isInteger(v) && v >= lo && v <= hi ? v : null);
  const unit = (v) => (typeof v === "number" && Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : null);
  const text = (v, max) => (typeof v === "string" ? v.replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, max) || null : null);
  // "7", 7, "<7>" or "Room 7" is room 7 (0..99); anything else null
  const roomNum = (v) => { const m = String(v ?? "").match(/^\D*(\d{1,2})\D*$/); return m ? Number(m[1]) : null; };
  // The width and height in a PNG's header (IHDR), from its base64; null when it is not a PNG.
  function pngSize(b64) {
    const A = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/", head = String(b64).slice(0, 32), b = [];
    for (let i = 0; i + 3 < head.length; i += 4) {
      const n = [0, 1, 2, 3].map((k) => A.indexOf(head[i + k]));
      if (n.some((x) => x < 0)) return null;
      const x = (n[0] << 18) | (n[1] << 12) | (n[2] << 6) | n[3];
      b.push((x >> 16) & 255, (x >> 8) & 255, x & 255);
    }
    const mark = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
    if (b.length < 24 || !mark.every((m, i) => b[i] === m) || String.fromCharCode(b[12], b[13], b[14], b[15]) !== "IHDR") return null;
    const be = (i) => ((b[i] << 24) >>> 0) + (b[i + 1] << 16) + (b[i + 2] << 8) + b[i + 3], w = be(16), h = be(20);
    return w && h ? { w, h } : null;
  }
  const rowKey = (r) => [r.place ?? r.index ?? "", r.item_id || r.nameText || "", r.price ?? "", r.qty ?? "", r.sold ? 1 : 0].join("|");
  // What a row shows (item or read name, price, bundle, sold mark): the same in two places or two capture visits is one listing.
  const identOf = (r) => (r.abstain || !(r.item_id || r.nameText) ? null : [r.item_id || "n:" + r.nameText, r.price ?? "", r.qty ?? "", r.sold ? 1 : 0].join("|"));
  // Not signed in: a 401 (the Worker's "Sign in first"). A 403 with the Worker's own answer (e.worker) is a refusal,
  // never resent: it answers 403 to accounts /api/me calls signed in (a code session, a blocked account, another origin:
  // second review of 2026-10-18). A 403 with no Worker answer is Cloudflare in front of it (a WAF or bot check): kept
  // and sent again later, as a busy answer (review of bundle-327: it was dropped and the rows lost).
  const authErr = (e) => !!e && e.status === 401;
  const refusal403 = (e) => !!e && e.status === 403 && !!e.worker;
  function reasonOf(e) {
    if (!e) return "unknown";
    if (e.status === 404) return "not open yet";
    if (authErr(e)) return "not signed in";
    if (e.status === 403) return refusal403(e) ? "refused (403)" : "blocked on the way (403)";
    if (e.status === 429) return "too many";
    if (e.status) return (e.code || "http " + e.status);
    return "no answer";   // the network failed (offline, or the service is down)
  }

  // Short plain reasons for the log (the reader's own words, shortened).
  const SHORT = [
    [/letters match too weakly/, "letters weak"], [/no name text|name band has no text/, "no name text"], [/no letters in the atlas/, "no letters loaded"],
    [/"mesos" (word|matched)/, "price line not found"], [/"for" not found/, "price line not found"], [/digit layout/, "digits do not fit"],
    [/a price digit is unsure/, "a digit unsure"], [/quantity not read/, "quantity not read"], [/cut at the row edge|outside the row/, "row cut off"],
  ];
  const short = (why) => { const w = String(why || ""); for (const [re, s] of SHORT) if (re.test(w)) return s; return w || "not read"; };
  const SURFACE = (s) => ({ window: "window", monitor: "whole screen", browser: "browser tab" }[s] || s);
  const SPEED_EVERY_MS = 20000;
  const far = (a, b) => (b == null || a == null ? a !== b : Math.abs(a - b) > 0.25 * Math.max(1, Math.abs(b)));
  // The rows a shop could not use, by their most common reason: " · prices: 2 of 8 not read: quantity not read · names: 3 of 6 not found: letters weak".
  function misses(rows) {
    const top = (list) => { const c = new Map(); for (const w of list) c.set(w, (c.get(w) || 0) + 1); return [...c].sort((a, b) => b[1] - a[1])[0][0]; };
    const noPrice = rows.filter((r) => r.abstain), priced = rows.filter((r) => !r.abstain), noName = priced.filter((r) => !r.item_id);
    let out = "";
    if (noPrice.length) out += " · prices: " + noPrice.length + " of " + rows.length + " not read: " + top(noPrice.map((r) => short(r.why)));
    if (noName.length) out += " · names: " + noName.length + " of " + priced.length + " not found: " + top(noName.map((r) => short(r.nameWhy)));
    return out;
  }

  function tracker(o = {}) {
    const now = o.now || (() => Date.now()), random = o.random || Math.random;
    const uuid = o.uuid || (() => crypto.randomUUID());
    const world = () => str(typeof o.world === "function" ? o.world() : o.world);
    const version = () => String((typeof o.version === "function" ? o.version() : o.version) || readerVersion || "");
    // the page's release (e.g. "market341"), for the per-release health numbers (Larry, 2026-10-20): it rides in client.version
    // ("atlas-v1+market341"), the field the upload Worker keeps for every batch (live_batches.reader_version); [A-Za-z0-9._+-], 40 at most
    const release = () => String((typeof o.release === "function" ? o.release() : o.release) || "").replace(/[^\w.-]/g, "").slice(0, 40);
    const rev = { status: 0, shops: 0, log: 0 };
    const visits = new Map(), lines = [], aliases = new Map();   // aliases: a visit capture started again -> the one it continues
    let seen = 0;   // every shop of the session, also the ones no longer kept
    let signedOut = false;   // the upload Worker refused a send with 401 or 403
    let channel = null, map = null, room = null, channelUnsure = false;   // channelUnsure: maybe changed since it was read
    let minimap = null, minimapCand = null, minimapSince = 0;   // the settled state; a change waiting to settle
    let pending = 0;   // sends on the way
    // For the report (R-G2JBS, 2026-10-19: 5 shops read on a Mac and no batch ever reached the server, nothing refused):
    // rows read and with an item id this session, the last send's answer, the last reason a shop was not sent.
    const sends = { read: 0, known: 0, last: null, why: null, whyN: 0 };
    let cropsUsed = 0;   // name crops kept this session (at most NAME_CROPS_PER_SESSION)
    // Rows read with a price whose name matched no catalog item, since the last call: sent as client.unsnapped with the
    // next call and then counted from 0 (Larry, 2026-10-18, for Grand Launch: the upload Worker's hourly asset check reads
    // it from its day counters to spot new items arriving). Each row once, when it first joins its shop's list.
    let unsnapped = 0;
    // Rows the old matcher refused since the last call, by reason (#331's abstains, Larry's monitoring, 2026-10-20): its
    // limits sit about 3 game px and 0.07 from the reads seen, so a row box placed differently would drop every old-matcher
    // read. Sent as client.abstained = { start, mesos } with the next call, each row place once, then counted from 0.
    const ABSTAIN_WHY = { start: /^quantity starts too far right/, mesos: /^"mesos" matched weakly/ };
    let abstained = { start: 0, mesos: 0 };
    const abstainSeen = new Set();
    function noteAbstain(v, r) {
      if (!r.abstain || !r.why) return;
      const kind = Object.keys(ABSTAIN_WHY).find((k) => ABSTAIN_WHY[k].test(r.why)); if (!kind) return;
      const key = v.visitId + "|" + r.place + "|" + kind; if (abstainSeen.has(key)) return;
      if (abstainSeen.size >= 5000) abstainSeen.clear();   // a long session: the oldest places may count again
      abstainSeen.add(key); abstained[kind] = Math.min(UNSNAPPED_MAX, abstained[kind] + 1);
    }
    const UNSNAPPED_MAX = 10000;   // the Worker takes 0-10,000
    // ... and their read names, text only (Larry, 2026-10-20, for Grand Launch: 10.6% of the day's rows matched no item,
    // and the batches keep no row without one): sent as client.unsnapped_names, each name once a page session, at most
    // UNSNAPPED_NAME_LEN characters, UNSNAPPED_NAMES_PER_CALL a call and UNSNAPPED_NAMES_MAX a session. No pictures (rule 26).
    const UNSNAPPED_NAME_LEN = 60, UNSNAPPED_NAMES_PER_CALL = 20, UNSNAPPED_NAMES_MAX = 100;
    const unsnappedSeen = new Set(), unsnappedNames = [];
    function noteUnsnapped(r) {
      const name = String(r.nameText ?? r.nameGuess ?? "").replace(/\s+/g, " ").trim().slice(0, UNSNAPPED_NAME_LEN);
      if (!name || unsnappedSeen.has(name) || unsnappedSeen.size >= UNSNAPPED_NAMES_MAX) return;
      unsnappedSeen.add(name); unsnappedNames.push(name);
    }
    // Send outcomes are running lines, one per kind, updated in place and moved to the newest place when they change
    // ("Not sent: no answer ×12", "Sent: 14 shops, 96 rows ✓"): 30 failing shops filled the 50-line log before.
    // sentRows: rows sent per visit still kept; a visit dropped from the page adds its count to sentDone (a long session
    // kept one entry per shop ever sent, and summed them all on every send)
    const tallies = new Map(), sentRows = new Map(), sentDone = { shops: 0, rows: 0 };
    // An alias points a capture visit to the visit it continues; each visit knows its own (aliasKeys), so they go with it
    // when it is dropped and are moved without a scan of all of them (they were never dropped before).
    function alias(from, toId) {
      const was = aliases.get(from);
      if (was === toId) return;
      if (was != null) visits.get(was)?.aliasKeys?.delete(from);
      aliases.set(from, toId);
      const to = visits.get(toId); if (to) (to.aliasKeys ??= new Set()).add(from);
    }
    function moveAliases(v, toId) { if (v.aliasKeys) for (const k of [...v.aliasKeys]) alias(k, toId); }
    function dropVisit(old) {
      visits.delete(old.visitId);
      if (old.aliasKeys) for (const k of old.aliasKeys) if (aliases.get(k) === old.visitId) aliases.delete(k);
      old.dropped = true;
      if (sentRows.has(old.visitId)) { old.counted = true; old.countedRows = sentRows.get(old.visitId); sentDone.shops++; sentDone.rows += old.countedRows; sentRows.delete(old.visitId); }
    }
    // A send's rows, counted for the "Sent:" line (a visit dropped while its send was on the way counts in sentDone).
    function countSent(v, n) {
      if (!v.dropped) { sentRows.set(v.visitId, n); return; }
      if (!v.counted) { v.counted = true; sentDone.shops++; }
      sentDone.rows += n - (v.countedRows || 0); v.countedRows = n;
    }
    function tally(key, text) {
      let l = tallies.get(key);
      if (!l) { l = { t: 0, text: "", n: 0 }; tallies.set(key, l); }
      l.n++; l.t = now(); l.text = text(l.n);
      const at = lines.indexOf(l); if (at >= 0) lines.splice(at, 1);
      lines.push(l); if (lines.length > LOG_MAX) lines.splice(0, lines.length - LOG_MAX);
      rev.log++;
    }
    const failed = (why) => { sends.whyN = sends.why === why ? sends.whyN + 1 : 1; sends.why = why; tally("fail:" + why, (n) => "Not sent: " + why + (n > 1 ? " ×" + n : "")); };
    let dGame = null;   // the game pixel size the log last said
    let dFrame = null, dScale = null, dSpeed = null, dSpeedAt = -Infinity;   // the last diagnostics lines said
    let lastDiag = null;   // the newest frame's diagnostics (speed())
    let dMapWhy = null, dMapAt = -Infinity;   // the last "Map not read" line
    let dTwoFit = false;   // "two map names fit" was said since the last map change
    let mapHidden = false;   // the last map read said the minimap shows no title
    // Larry, 2026-10-18 ("the live map is lost in the reader"): the last reason the map was or was not read goes with every
    // sighting (map_why), and the map is counted in epochs: a black screen (a map change) starts a new one, so a map read
    // later in the same epoch is put on the shops read before it, which are then sent again.
    let lastMapWhy = null, lastMapScale = null, lastMapScaleOf = null, lastMapEnlarge = null, mapEpoch = 0, inBlack = false;
    const MAP_FILL_MS = 30_000;   // a map read gives its name to this epoch's shops read at most this long before it
    // map_why as the upload Worker keeps it (1-80 characters of A-Z a-z 0-9 space _ : . , ( ) ' / -): a room "<7>" becomes
    // "room 7" (Larry, 2026-10-18), anything else outside that set goes, so a reason that names a map is not stored as null
    const whyText = (w) => text(String(w || "").replace(/\s*<(\d{1,2})>/g, " room $1").replace(/[^A-Za-z0-9 _:.,()'\/-]/g, ""), 80);
    let uiScale = null, surface = null;   // the newest UI scale and shared surface (diagnostics), sent in each sighting's frame
    let frameW = null;   // the newest frame width (diagnostics), for the game's pixel size (L2.3)
    let nudgeOn = false, nudgeAt = -Infinity;
    let gameK = null;   // capture.js's game pixel size (screen px per game px), newest
    const saidLearn = new Set();   // the learned-glyph lines said, per scale and kind   // the scale nudge as last drawn, and when it was last looked at

    // The outbox (outbox.js, Larry's item D): a send that fails with 429, 5xx, no answer, 401 or 403 keeps the visit's
    // newest body there (IndexedDB, else memory) and is sent again later, so no read shop is lost while MesoWatch is busy.
    // o.outbox: a MesoOutbox-like factory (tests), false for none; else window.MesoOutbox, loaded on first use.
    let outbox = null, waitLine = null;
    const early = [];   // failed bodies kept before outbox.js loaded
    const WAIT_WHY = { busy: "MesoWatch is busy", offline: "no connection", auth: "sign in to send" };
    const sightRows = (body) => (body?.sightings?.[0]?.rows || []).filter((r) => r.item_id).length;
    function outboxChange(st) {
      if (!st.waiting) { if (waitLine) { const at = lines.indexOf(waitLine); if (at >= 0) lines.splice(at, 1); waitLine = null; rev.log++; } return; }
      const text = "Waiting to send: " + st.waiting + (st.waiting === 1 ? " shop" : " shops") + " (" + (WAIT_WHY[st.kind] || WAIT_WHY.busy) + ")";
      if (waitLine && lines.includes(waitLine)) { if (waitLine.text !== text) { waitLine.text = text; waitLine.t = now(); rev.log++; } return; }
      waitLine = say(text);
    }
    function outboxSent(e) {
      if (signedOut) { signedOut = false; rev.status++; }
      try { o.onSent?.(e.body); } catch { /* the page's counter */ }   // a shop sent later from the outbox counts in Sent too (review of bundle-328)
      const n = sightRows(e.body);
      if (!n) return;
      const v = [...visits.values()].find((x) => x.uuid === e.visit);
      if (v) countSent(v, Math.max(n, sentRows.get(v.visitId) || 0)); else { sentDone.shops++; sentDone.rows += n; }
      let m = sentDone.rows; for (const x of sentRows.values()) m += x;
      const shopsN = sentDone.shops + sentRows.size;
      tally("sent", () => "Sent: " + shopsN + (shopsN === 1 ? " shop, " : " shops, ") + m + (m === 1 ? " row" : " rows") + " ✓");
    }
    function outboxDrop(e, why) { tally("fail:" + why, (n) => "Not sent: " + why + ", " + n + (n === 1 ? " shop" : " shops")); }
    // sent_at (the upload Worker's clock-skew correction, contract live-sightings-sent-at): this PC's time as the call goes
    // out, at the top of the call, set again on every send (a retry, a keepalive call, an outbox resend); the server
    // moves the call's seen_at by its receive time minus sent_at. seen_at itself stays this PC's own time.
    // A Worker that does not know it yet ignores it.
    const stamp = (body) => ({ ...body, sent_at: new Date().toISOString() });
    function useOutbox(M) {
      if (outbox || !M?.create) return;
      try {
        outbox = M.create({ now, send: (b) => o.send(stamp(b)), signedIn: () => (typeof o.signedIn === "function" ? o.signedIn() : o.signedIn),
          indexedDB: o.indexedDB, owner: o.owner, onChange: outboxChange, onSent: outboxSent, onDrop: outboxDrop });   // owner: the account the shops were read under
      } catch { outbox = null; return; }
      for (const [b, k, ow] of early.splice(0)) outbox.put(b, k, ow);
    }
    if (o.send && o.outbox !== false) {
      const M = o.outbox || (typeof window !== "undefined" && window.MesoOutbox);
      if (M) useOutbox(M);
      else if (typeof window !== "undefined" && typeof document !== "undefined") loadScript("outbox.js", "MesoOutbox").then(useOutbox).catch(() => null);
    }
    // owner: the account the visit was READ under (review of bundle-328: stamped when kept, a send after a sign-out kept
    // A's shops with no owner, and they went under B)
    function keepFailed(body, e, owner) {
      // the same kinds as MesoOutbox.kindOf: another 4xx is a refusal of the body itself, so it is not kept
      const k = !e?.status ? "offline" : authErr(e) ? "auth" : (e.status === 403 && !refusal403(e)) || e.status === 429 || e.status >= 500 ? "busy" : null;
      if (!k) return;
      if (outbox) outbox.put(body, k, owner); else if (early.length < 500) early.push([body, k, owner]);
    }

    function say(text) {
      const line = { t: now(), text };
      lines.push(line); if (lines.length > LOG_MAX) lines.splice(0, lines.length - LOG_MAX);
      rev.log++; return line;
    }
    function frame(f) {
      if (!f) return;
      const t = now();
      const ch = chNum(f.channel);
      // a black screen back to the same place with no pick read: likely another channel, so the old one is not shown
      // A black screen back to the same place with no pick read may be another channel: the last channel is KEPT but
      // marked unsure ("CH 7?"), shops then carry no channel, and the menu read again makes it sure (Site features,
      // 2026-10-17: busy recordings lost "Channel 7" after a black screen for the rest of the run).
      if (ch == null && f.channelStale === true && channel != null && !channelUnsure) { channelUnsure = true; say("Channel may have changed: open the channel menu"); rev.status++; }
      if (ch != null && (ch !== channel || channelUnsure)) { channel = ch; channelUnsure = false; say("Channel " + ch + " seen"); rev.status++; }
      // the map from the minimap title (mapreader.js, confirmed over 3 reads); a new map brings its own room (or none)
      // a black screen is a map change (or a channel change): the old map is not this place's any more, so it is dropped
      // (it put the last map on the next map's shops); the map read next goes on this epoch's shops
      if (f.gameSeen === false) { if (!inBlack) { inBlack = true; mapEpoch++; if (map != null) { map = null; room = null; rev.status++; } } } else if (f.gameSeen === true) inBlack = false;
      const m = str(f.map);
      if (m && m !== map) {
        map = m; room = str(f.room); dTwoFit = false; say("Map: " + m); rev.status++;
        // the shops of this epoch read before the map was: they get it now (and are sent again: the map is in the send signature)
        // Only shops read in the last MAP_FILL_MS (review of 2026-10-18): a map change the black-screen cue missed must
        // not put this map on the last map's shops (rule 13: no map is better than a wrong one).
        for (const v of visits.values()) if (v.map == null && v.mapEpoch === mapEpoch && t - v.changed <= MAP_FILL_MS) { v.map = map; if (v.room == null && room) v.room = room; v.rowRev++; }
      }
      else if (!m) { const r = str(f.room); if (r && r !== room) { room = r; rev.status++; } }
      // why the map is not read, at most one line every 15 s and only when the reason changes ("letters weak", ...)
      const why = str(f.mapWhy);
      if (why) lastMapWhy = why;
      if ("mapScale" in f) { lastMapScale = typeof f.mapScale === "number" ? f.mapScale : null; lastMapScaleOf = lastMapScale == null ? null : f.mapScaleOf || null; }   // this frame's own
      if ("mapEnlarge" in f) lastMapEnlarge = typeof f.mapEnlarge === "number" ? f.mapEnlarge : null;   // the browser's enlargement as capture.js reckons it
      // the minimap is open but shows no title (its small form): the status line asks for the full minimap
      if (why) { const hidden = /shows no title/.test(why); if (hidden !== mapHidden) { mapHidden = hidden; rev.status++; } }
      // "two map names fit" (only the room digit is unsure) is said once per map change, and the watcher stops reporting it once the vote settles
      const twoFit = /^two map names fit/.test(why || "");
      if (twoFit && dTwoFit) { /* quiet */ }
      else if (why && why !== "read" && why !== dMapWhy && t - dMapAt >= 15000) { if (twoFit) dTwoFit = true; dMapWhy = why; dMapAt = t; say("Map not read: " + why); }
      if (typeof f.hasMinimap === "boolean") {
        if (f.hasMinimap === minimap) minimapCand = null;
        else if (minimapCand !== f.hasMinimap) { minimapCand = f.hasMinimap; minimapSince = t; }
        if (minimapCand != null && (t - minimapSince >= (minimapCand === false && minimap === true ? LOST_MS : SETTLE_MS) || minimap == null && minimapCand === true)) {
          const was = minimap; minimap = minimapCand; minimapCand = null; rev.status++;
          if (!minimap) say("Minimap lost"); else if (was === false) say("Minimap back");
        }
      }
      if (f.diag) { lastDiag = f.diag; diagnose(f.diag, t); }
      // the scale nudge (L2.3) goes when the learned table has learned enough: looked at once a second
      if (t - nudgeAt >= 1000) { nudgeAt = t; learnLog(); const sn = scaleNudge(); if (sn !== nudgeOn) { nudgeOn = sn; rev.status++; } }
      if (f.shopOpen === false) closed();
    }
    // Diagnostics (Grant, 2026-10-16: "It's slower than the other guy", "not getting item names or channel or map"):
    // the frame size and shared surface, the UI scale, and the speed, once at the start and again when they change.
    function diagnose(d, t) {
      const frameText = d.w && d.h ? "Frame " + d.w + "×" + d.h + (d.surface ? " · sharing a " + SURFACE(d.surface) : "") : null;
      if (frameText && frameText !== dFrame) { dFrame = frameText; say(frameText); }
      if (d.surface) surface = String(d.surface);
      if (typeof d.scale === "number" && d.scale > 0 && d.scale <= 8) uiScale = d.scale;
      if (typeof d.w === "number" && d.w > 0) { if (d.w !== frameW) rev.status++; frameW = d.w; }
      if (typeof d.gameScale === "number" && d.gameScale > 0 && d.gameScale <= 8) gameK = d.gameScale;
      if (typeof d.scale === "number") {
        const sc = Math.round(d.scale * 20) / 20;
        // the game pixel size too: a fullscreen stretch keeps the UI scale at 1.00 (16:9) but makes game pixels 1.41x
        const gs = typeof d.gameScale === "number" && d.gameScale > 0 ? Math.round(d.gameScale * 100) / 100 : null;
        if (sc !== dScale || gs !== dGame) { dScale = sc; dGame = gs; say("UI scale " + sc.toFixed(2) + (gs ? " · game pixels " + gs.toFixed(2) + "x" : "") + (d.shopW ? " (shop window " + d.shopW + " px wide)" : "")); }
      }
      if (typeof d.fps === "number" && typeof d.msFrame === "number") {
        const sp = { fps: d.fps, msFrame: d.msFrame, msShop: d.msShop ?? null };
        // Again when a number moved by a quarter or more, at most every 20 seconds, so the log stays readable.
        const moved = !dSpeed || far(sp.fps, dSpeed.fps) || far(sp.msFrame, dSpeed.msFrame) || (sp.msShop != null && far(sp.msShop, dSpeed.msShop));
        if (moved && t - dSpeedAt >= SPEED_EVERY_MS) {
          dSpeed = sp; dSpeedAt = t;
          say("Speed: " + sp.fps + " frames/s · " + sp.msFrame + " ms a frame" + (sp.msShop != null ? " · " + sp.msShop + " ms a shop" : "") +
            (typeof d.rowsPerSec === "number" && d.rowsPerSec > 0 ? " · " + d.rowsPerSec + " rows/s" : "") +
            (typeof d.sameShare === "number" && d.sameShare > 0 ? " · " + Math.round(d.sameShare * 100) + "% unchanged" : ""));
        }
      }
    }
    // capture.js starts a new visit when the seller's tag looks a little different from the frame before (it is placed
    // from the window's rough position), so one shop showed up as two or three visits a second apart, each sent
    // (QA 2026-10-16: Prawn 6 rows then 2, Yilaotou 5 then 3). A visit that starts within MERGE_MS of the last one
    // continues it when the seller is the same, or (a seller not read) its first row is a listing already there. Its
    // rows lose their place (index): its places are counted from its own first row, not the shop's.
    // Never by a listing when the shop before has its seller and this frame has none (review of bundle-323): a player who
    // left seller A's shop and opened B's within MERGE_MS, B's seller not read yet and B's first row the same as one of
    // A's, had B's rows joined into A's visit and sent under seller A (the board, Where to buy, everyone's prices). Such a
    // visit stays apart until its seller is read; the same seller then folds it in (row(), below).
    const sameListing = (x, y) => !x.abstain && !y.abstain && !!x.item_id && x.item_id === y.item_id && x.price === y.price && x.qty === y.qty && !!x.sold === !!y.sold;
    // A visit folded into the shop before it: its new rows, capture visits (segments), place reads and name crops go
    // along, so its rows keep their order; its id then points at that shop.
    function foldInto(v, prev, t) {
      for (const x of v.rows) if (!prev.rows.some((y) => sameListing(y, x))) {
        const moved = { ...x }; prev.rows.push(moved); prev.keys.add(rowKey(moved)); prev.rowRev++;
      }
      for (const [k, s] of v.segs) if (!prev.segs.has(k)) prev.segs.set(k, s);
      if (v.reads) for (const [k, x] of v.reads) if (!(prev.reads ??= new Map()).has(k)) prev.reads.set(k, x);
      if (v.crops) for (const [k, x] of v.crops) if (!(prev.crops ??= new Map()).has(k)) prev.crops.set(k, x);
      prev.lay = null;
      moveAliases(v, prev.visitId);
      alias(v.visitId, prev.visitId);
      visits.delete(v.visitId); seen -= 1;
      if (v.line) { const at = lines.indexOf(v.line); if (at >= 0) lines.splice(at, 1); }
      prev.ts = Math.max(prev.ts, v.ts); prev.changed = t; rev.shops++; rev.log++;
    }
    // The Prawn case (review of #296): a capture restart that missed the seller's tag for a frame starts a visit with no
    // seller, kept apart from the named shop before it (sameShop), and it was sent on its own: the player's shop split in
    // two. Such a visit (no seller, nothing sent) that shares a listing with a named shop of the last SELLER_MERGE_MS waits:
    // its seller read, it folds in (row()); the time up with every row already in that shop, it folds in quietly; else it
    // goes as its own shop.
    function foldWaitTarget(v) {
      if (v.seller || v.sentRev) return null;
      let best = null;
      for (const p of visits.values()) if (p !== v && p.seller && p.first <= v.first && v.first - p.ts <= SELLER_MERGE_MS &&
        v.rows.some((x) => p.rows.some((y) => sameListing(x, y))) && (!best || p.ts > best.ts)) best = p;
      return best;
    }
    function foldWait(v, t) {
      const p = foldWaitTarget(v); if (!p) return false;
      if (t - v.first <= SELLER_MERGE_MS) return true;   // still waiting for its seller
      if (v.rows.every((x) => x.abstain || !x.item_id || p.rows.some((y) => sameListing(x, y)))) { foldInto(v, p, t); return true; }   // nothing of its own: folded
      return false;   // rows of its own: its own shop
    }
    function sameShop(prev, r) {
      if (prev.seller && r.seller) return prev.seller === r.seller;
      if (prev.seller && !r.seller) return false;
      return !r.abstain && !!r.item_id && prev.rows.some((x) => !x.abstain && x.item_id === r.item_id && x.price === r.price && x.qty === r.qty && !!x.sold === !!r.sold);
    }
    // ORDER (Grant, 2026-10-16: "Any chance we can get the order in so it matches the stores listings?"). A row's
    // `index` is its place in capture's list for ONE capture visit (its segment, `seg`); `place` = "seg#index" names it
    // in the tracker. Each frame's `view` (capture's list places on screen, top to bottom) is aligned with the visit's
    // ordered list: a row already there fixes the frame's offset, a new row goes right after its upper neighbour (or
    // right before its lower one), and a frame with no known row goes at the bottom (or the top when the list scrolled
    // up). A joined capture visit (a merge) is aligned the same way, its rows matched by what they show (identOf).
    // pos = the row's place among the visit's rows, top first; the send's slot is pos.
    function noteSeg(v, r) {
      let s = v.segs.get(r.seg);
      if (!s) { s = { views: [], viewKeys: new Set(), idents: new Map(), indexes: new Set() }; v.segs.set(r.seg, s); }
      if (Number.isInteger(r.index)) {
        s.indexes.add(r.index);
        const id = identOf(r);
        if (id && !s.idents.has(r.index)) s.idents.set(r.index, id);
      }
      if (Array.isArray(r.view) && r.view.length && s.views.length < 400) {
        const view = r.view.filter((i) => Number.isInteger(i) && i >= 0), k = (r.ts ?? "") + "@" + view.join(",");
        if (view.length && !s.viewKeys.has(k)) { s.viewKeys.add(k); s.views.push(view); }
      }
      v.lay = null;
    }
    function layout(v) {
      if (v.lay) return v.lay;
      const list = [], canon = new Map(), byIdent = new Map();
      const reg = (tok, id) => { canon.set(tok, tok); if (id && !byIdent.has(id)) byIdent.set(id, tok); };
      for (const [segId, s] of v.segs) {
        const inViews = new Set(s.views.flat());
        const loose = [...s.indexes].filter((i) => !inViews.has(i)).sort((a, b) => a - b);   // rows with no view: by index
        const views = loose.length ? [...s.views, loose] : s.views;
        let dir = 1, lastTop = null;
        for (const view of views) {
          let prevAt = -1, top = null, lead = [];
          const done = new Set();
          for (const i of view) {
            if (done.has(i)) continue;
            done.add(i);
            const tok = segId + "#" + i, id = s.idents.get(i);
            let c = canon.get(tok);
            if (!c && id && byIdent.has(id)) { c = byIdent.get(id); canon.set(tok, c); }
            let at = c ? list.indexOf(c) : -1;
            if (at >= 0) {
              if (top == null) top = at;
              if (lead.length) { list.splice(at, 0, ...lead.map((x) => x[0])); for (const x of lead) reg(x[0], x[1]); at += lead.length; lead = []; }
              prevAt = at;
            } else if (prevAt >= 0) { list.splice(++prevAt, 0, tok); reg(tok, id); }
            else lead.push([tok, id]);
          }
          if (lead.length) { const toks = lead.map((x) => x[0]); if (dir < 0) list.unshift(...toks); else list.push(...toks); for (const x of lead) reg(x[0], x[1]); }
          if (top != null) { if (lastTop != null && top !== lastTop) dir = top < lastTop ? -1 : 1; lastTop = top; }
        }
      }
      const used = new Set(v.rows.map((r) => canon.get(r.place)));
      if (v.crops) for (const k of v.crops.keys()) used.add(canon.get(k));
      const rank = new Map();
      for (const tok of list) if (used.has(tok)) rank.set(tok, rank.size);
      return (v.lay = { canon, rank });
    }
    const posOf = (v, place) => { const L = layout(v), c = L.canon.get(place); return c == null ? null : L.rank.get(c) ?? null; };
    const byPos = (v) => (a, b) => (posOf(v, a.place) ?? 1e9) - (posOf(v, b.place) ?? 1e9);
    function newVisit(visitId, t, first) {
      const v = { visitId, uuid: uuid(), sendRev: 0, segs: new Map(), lay: null, retry: null, rows: [], keys: new Set(), ts: 0, first, opened: first, changed: t, sentRev: 0, rowRev: 0, image: null, line: null, mapEpoch };
      visits.set(visitId, v);
      seen += 1;
      return v;
    }
    let splits = 0;
    // A 33rd different row: the rows from now on go to a new visit (its own visit id and rev count).
    function split(v, r, t) {
      const nv = newVisit(v.visitId + "+" + ++splits, t, Math.max(t, v.first + 1));
      for (const k of ["seller", "title", "channel", "map", "room", "avatarDataUrl", "sellerPicUrl", "frame"]) nv[k] = v[k];
      nv.ts = v.ts;
      nv.opened = v.opened;   // the shop opened when its first part did (review of #264: a split after the tick is not a shop opened after it)
      moveAliases(v, nv.visitId);
      for (const k of v.segs.keys()) alias(k, nv.visitId);
      noteSeg(nv, r);
      if (v.reads?.has(r.place)) (nv.reads ??= new Map()).set(r.place, v.reads.get(r.place));
      say("Shop too long: split");
      rev.shops++;
      return nv;
    }
    function row(r) {
      if (!r?.visitId) return false;
      const t = now();
      { const seg = String(r.seg ?? r.visitId); r = { ...r, seg, place: seg + "#" + (r.index ?? "?") }; }
      if (!aliases.has(r.visitId) && !visits.has(r.visitId)) {
        let prev = null; for (const x of visits.values()) if (!prev || x.ts > prev.ts) prev = x;
        const win = prev && prev.seller && r.seller && prev.seller === r.seller ? SELLER_MERGE_MS : MERGE_MS;
        if (prev && (r.ts || t) - prev.ts <= win && sameShop(prev, r)) alias(r.visitId, prev.visitId);
      }
      if (aliases.has(r.visitId)) r = { ...r, visitId: aliases.get(r.visitId) };
      let v = visits.get(r.visitId);
      if (!v) {
        v = newVisit(r.visitId, t, r.ts || t);
        // A long session keeps the newest VISITS_MAX shops on the page; an older shop goes once it was sent (a page left
        // open for hours grew by about 900 elements a minute without this, the capture helper's 10-minute run).
        if (visits.size > VISITS_MAX) for (const old of [...visits.values()].sort((a, b) => a.first - b.first)) {
          if (visits.size <= VISITS_MAX) break;
          if (old !== v && old.rowRev <= old.sentRev) dropVisit(old);
        }
      }
      // the account the shop is read under, kept with the visit (the outbox sends it only under that account)
      if (!v.owner && o.owner) { try { const w = typeof o.owner === "function" ? o.owner() : o.owner; if (w) v.owner = String(w); } catch { /* not known */ } }
      const hadSeller = !!v.seller, before = v.seller;
      for (const k of ["seller", "title", "channel", "map", "room", "frame"]) if (r[k]) v[k] = r[k];   // a later frame may read what an earlier one missed
      // the seller's pictures only from a frame of the visit's seller (or its first seller read), and on a visit whose
      // seller was never read, from its own frames with none (review of bundle-323: another shop's frame put its
      // character on this visit; the recordings' unnamed shops keep their faces)
      if (r.seller ? !before || r.seller === before : !v.seller) for (const k of ["avatarDataUrl", "sellerPicUrl"]) if (r[k]) v[k] = r[k];
      // The seller is read beside the rows, so a restarted visit's first rows can come before its seller: when the
      // seller arrives and the visit just before (within SELLER_MERGE_MS, nothing sent yet) has the same one, it is folded in.
      if (!hadSeller && v.seller && !v.sentRev) {
        let prev = null;
        for (const x of visits.values()) if (x !== v && x.first <= v.first && (!prev || x.ts > prev.ts)) prev = x;   // the shop just before
        if (prev && prev.seller === v.seller && v.first - prev.ts <= SELLER_MERGE_MS) {
          foldInto(v, prev, t);
          v = prev; r = { ...r, visitId: prev.visitId };
        }
      }
      if (v.channel == null && channel != null && !channelUnsure) v.channel = String(channel);   // never an unsure channel
      if (v.map == null && map) v.map = map;
      if (v.room == null && room) v.room = room;
      v.ts = Math.max(v.ts, r.ts || t);
      noteSeg(v, r);
      noteAbstain(v, r);
      const key = rowKey(r);
      let added = false;
      // Every read of each place, before any row is dropped as a repeat: a place read two ways (another price, item,
      // quantity or sold mark) sends none of its readings (review of pull request 203).
      if (!r.abstain && r.index != null) {
        const sig = [r.item_id, r.price, r.qty, r.sold].join("|");
        (v.reads ??= new Map()).set(r.place, v.reads.has(r.place) && v.reads.get(r.place) !== sig ? false : sig);
      }
      if (!v.keys.has(key)) {
        // A row the reader could not read is not shown next to a read one of the same place, and a read row replaces it.
        const same = v.rows.findIndex((x) => x.index != null && x.place === r.place && x.abstain);
        if (r.abstain && v.rows.some((x) => x.index != null && x.place === r.place)) { /* nothing new */ }
        // The same item at the same price, quantity and sold mark in one shop is one listing (the terms table), so a row
        // that capture passed again at another place is not shown twice.
        else if (!r.abstain && r.item_id && v.rows.some((x) => !x.abstain && x.item_id === r.item_id && x.price === r.price && x.qty === r.qty && !!x.sold === !!r.sold)) { /* nothing new */ }
        else {
          if (!r.abstain && same >= 0) { v.keys.delete(rowKey(v.rows[same])); v.rows.splice(same, 1); }
          else if (v.rows.length >= VISIT_ROWS_MAX) v = split(v, r, t);
          const { image, ...shown } = r;
          v.rows.push(shown); v.keys.add(key); added = true;
          if (image && !r.abstain && r.item_id && !v.image) v.image = image;
        }
      }
      // The name line of a row whose name did not snap (also an unsure one): cut and encoded now (at most 20 a session),
      // so the row picture is not kept. Only the first of each place; dropped at send time if the place snaps later.
      if (!r.item_id && r.image && r.index != null && o.encodePng && cropsUsed < NAME_CROPS_PER_SESSION && !(v.crops ??= new Map()).has(r.place) && (r.nameBand || !r.abstain)) {
        try {
          const cut = nameCrop(r.image, r.nameBand), png = cut ? o.encodePng(cut) : null;
          if (png && b64Bytes(png) <= NAME_CROP_MAX) { v.crops.set(r.place, { png, name: r.nameText ?? r.nameGuess ?? null, sent: false }); cropsUsed++; v.lay = null; }
        } catch { /* no crop */ }
      }
      if (added) { v.changed = t; v.rowRev++; rev.shops++; if (!r.abstain && !r.item_id) { unsnapped = Math.min(UNSNAPPED_MAX, unsnapped + 1); noteUnsnapped(r); } if (!r.abstain) { sends.read++; if (r.item_id) sends.known++; } }
      const text = "Shop opened: " + (v.seller || "seller not read") + " · " + v.rows.length + (v.rows.length === 1 ? " row" : " rows") + misses(v.rows);
      if (!v.line) v.line = say(text); else if (v.line.text !== text) { v.line.text = text; rev.log++; }
      return added;
    }
    // Sent: read rows with an item id and a sure sold mark (true or false; null is "not sure", and an unsure row is no
    // data), from places that were never read two different ways.
    function sendable(v) {
      // Also left out: a row with no confidence number (not sure), or a price the upload Worker would refuse.
      return v.rows.filter((r) => r.item_id && !r.abstain && (r.sold === true || r.sold === false) && v.reads?.get(r.place) !== false &&
        unit(r.confidence) != null && Number.isInteger(r.price) && r.price >= 1 && r.price <= 2e10);
    }
    // The name crops still to send: places with no snapped row now, not sent yet; at most 10 a send and 32 rows in all.
    function cropsToSend(v, rows) {
      if (!v.crops?.size) return [];
      const snapped = new Set(v.rows.filter((r) => r.item_id && r.index != null).map((r) => r.place));
      return [...v.crops].filter(([i, c]) => !c.sent && !snapped.has(i)).slice(0, Math.max(0, Math.min(NAME_CROPS_PER_SEND, SIGHTING_ROWS - rows.length)));
    }
    // The seller's character picture (the card's), as PNG base64, until a send with it succeeded; null when none or too big.
    function sellerPic(v) {
      if (v.sellerPicSent || typeof v.avatarDataUrl !== "string" || !v.avatarDataUrl.startsWith("data:image/png;base64,")) return null;
      const b64 = v.avatarDataUrl.slice(22);
      return b64 && b64Bytes(b64) <= SELLER_PIC_MAX ? b64 : null;
    }
    // payload(visitId, evidence, id, rev): one sightings body. `id` is the SEND's id (the upload Worker drops an id it saw
    // in the last 24 hours as a duplicate), so each new send of a visit has a new one; without it a new one is made.
    // `visit` is the visit's own UUID, the same for all its sends, and `rev` counts its sends (1, 2, 3 ...): each send
    // carries ALL the visit's current rows, so downstream the newest rev of a visit replaces the older ones.
    // The player's own shop: the seller the player confirmed as theirs ("Is this your shop? Yes", o.ownSeller), the exact
    // name. There is no owner's-window check: capture.js reads the shop window as anyone sees it.
    const ownSeller = () => { try { return text(typeof o.ownSeller === "function" ? o.ownSeller() : o.ownSeller, 60); } catch { return null; } };
    const isOwn = (v) => { const me = ownSeller(); return !!me && text(v.seller, 60) === me; };
    function payload(visitId, withEvidence, id, rv) {
      const v = visits.get(visitId); if (!v) return null;
      const rows = sendable(v).sort(byPos(v)), pic = sellerPic(v), seller = text(v.seller, 60);
      const s = {
        id: id || uuid(), visit: v.uuid, rev: whole(rv, 1, 100000) ?? Math.max(1, v.sendRev), seen_at: new Date(v.ts || v.first).toISOString(), server: "GMS Classic",
        channel: chNum(v.channel), map: v.map || null, room: roomNum(v.room), minimap_xy: null,
        // why this sighting has no map (or "read"); a map read after the shop's time limit is not this shop's
        map_why: v.map ? "read" : lastMapWhy === "read" ? "map read after this shop" : whyText(lastMapWhy) || "not read yet",
        // owner_view: the player's own shop (review of 2026-10-19, FINDING 1): the upload Worker gives its rows no stock, so
        // items the owner takes out are not read as sales
        shop: { seller, ...(pic ? { seller_pic_png_base64: pic } : {}), owner_view: isOwn(v) },
        // price is the whole bundle's; the reader's qty is the bundle size (the number before the price); the number of
        // bundles (stock) is not read, so qty is null. conf: the reader's price confidence and the name's letter score (0..1).
        rows: rows.map((r) => ({ slot: whole(posOf(v, r.place), 0, 63), item_id: r.item_id, name_read: text(r.nameText, 60), price: r.price, qty: null,
          bundle: whole(r.qty, 1, 32767), sold: r.sold, conf: { price: unit(r.confidence), name: unit(r.nameScore) } }))
          // a row whose name did not snap goes only as its name crop: no item id, so it is never priced or stored as a row
          .concat(cropsToSend(v, rows).map(([k, c]) => ({ slot: whole(posOf(v, k), 0, 63), item_id: null, name_read: c.name, name_crop_png_base64: c.png }))),
        // the frame only with a known whole width and height (the Worker refuses the sighting otherwise)
        frame: whole(v.frame?.w, 1, 10000) != null && whole(v.frame?.h, 1, 10000) != null
          ? { w: v.frame.w, h: v.frame.h, ui_scale: uiScale, surface: text(surface, 20) } : null,
      };
      if (withEvidence) s.evidence = withEvidence;
      // rows: "v2" = bundle is the bundle size and qty the stock (the upload Worker reads older clients' qty as the bundle size)
      const ver = (version() + (release() ? "+" + release() : "")).replace(/[^A-Za-z0-9._+-]/g, "").slice(0, 40);
      return { client: { name: "mesowatch-record", version: ver, rows: "v2" }, sightings: [s] };
    }
    // A visit's send, made ready: { v, body, sig, id, rv, rows, crops }, or null when nothing of it is to be sent.
    function prepare(v) {
      v.sentRev = v.rowRev; v.due = false;
      // the slots are in the signature, so a shop whose order was put right is sent again (a new rev)
      // the map and the room too, so a shop is sent again once its map is read (Larry, 2026-10-18)
      const rows = sendable(v), crops = cropsToSend(v, rows), sig = rows.map((r) => rowKey(r) + "@" + posOf(v, r.place)).join(";") + "|" + crops.map(([k]) => k).join(",") + "|" + (v.map || "") + "|" + (v.room || "") + "|" + (isOwn(v) ? "own" : "");
      v.sentOwn = isOwn(v);
      // Sent again only when its sendable rows changed (a "not read" row or a row with no item id changes nothing), or
      // name crops wait. A visit with name crops only is sent with them alone (the Worker stores the crops, not the visit).
      if (!rows.length && !v.saidEmpty) { v.saidEmpty = true; failed("no rows with a known item"); }
      if (!rows.length && !crops.length) return null;
      if (sig === v.sentSig) return null;
      v.sentSig = sig;   // cleared again when the send fails, so the next quiet tick tries once more
      // A retry of the same failed send keeps its id (if the Worker did store it, the retry is a harmless duplicate);
      // any other send gets a new id, so a resend with new rows is not dropped as a duplicate.
      const again = !!(v.retry && v.retry.sig === sig);
      const id = again ? v.retry.id : uuid(), rv = again ? v.retry.rev : ++v.sendRev;   // a retry keeps its id and rev
      v.retry = null;
      let evidence = null;
      if (v.image && o.encodePng && random() < 1 / EVIDENCE_EVERY) {
        try {
          // { png, w, h }: w and h are the PNG header's own size, as the Worker checks (at most 1024 a side, 60 KB)
          const png = o.encodePng(v.image), size = png ? pngSize(png) : null;
          if (size && b64Bytes(png) <= EVIDENCE_MAX && size.w <= 1024 && size.h <= 1024) evidence = { png, w: size.w, h: size.h };
        } catch { evidence = null; }
      }
      const body = payload(v.visitId, evidence, id, rv);
      v.inflight = body;   // the body on its way (hide() keeps it in the outbox if the tab closes before the answer)
      return { v, body, sig, id, rv, rows, crops };
    }
    function sent(it) {
      const { v, body, rv, rows, crops } = it;
      if (v.inflight === body) v.inflight = null;
      sends.last = "ok";
      if (signedOut) { signedOut = false; rev.status++; }   // a send went through: the sign-in alert goes
      for (const [, c] of crops) c.sent = true;
      if (body.sightings[0].shop.seller_pic_png_base64) v.sellerPicSent = true;   // the seller picture goes with the first successful send only
      if (outbox) outbox.done(v.uuid, rv);   // this visit's kept body goes
      try { o.onSent?.(body); } catch { /* the page's counter */ }   // the page counts a visit only once it is taken
      if (!rows.length) return;
      countSent(v, rows.length);
      let n = sentDone.rows; for (const x of sentRows.values()) n += x;
      const shops = sentDone.shops + sentRows.size;
      tally("sent", () => "Sent: " + shops + (shops === 1 ? " shop, " : " shops, ") + n + (n === 1 ? " row" : " rows") + " ✓");
    }
    // quiet: the log line is said by the caller (over_limit counts the refused shops from the Worker's answer)
    function notSent(it, e, quiet) {
      const { v, body, sig, id, rv } = it;
      if (v.inflight === body) v.inflight = null;
      // the answer as it came: the status, or no answer with the browser's own words (an extension blocking the call
      // leaves only "Failed to fetch")
      sends.last = e?.status ? "http " + e.status : e?.timeout ? "no answer in 30 s" : "no answer" + (e?.message ? " (" + String(e.message).slice(0, 40) + ")" : "");
      // No answer or a fault of the server: tried again after the next quiet 2 seconds. A refusal (401, 404, 429)
      // is not tried again for these rows.
      // At most RETRY_MAX tries, 2, 4, 8 ... up to 60 seconds apart; also a closed shop's flush waits for it.
      if ((!e?.status || e.status >= 500) && v.sentSig === sig && (v.tries = (v.tries || 0) + 1) < RETRY_MAX) {
        v.sentSig = null; v.rowRev++; v.retryAt = now() + Math.min(60e3, 2000 * 2 ** (v.tries - 1)); v.retry = { sig, id, rev: rv };
      }
      if (authErr(e) && !signedOut) { signedOut = true; rev.status++; }   // L2.2: say it at the top (not for a 403 refusal)
      if (!quiet) failed(reasonOf(e));   // one running line per kind: "Not sent: no answer ×12"
      keepFailed(body, e, it.v.owner);   // 429, 5xx, no answer, not signed in: this visit's own body kept in the outbox and sent again later
    }
    // The visits' sends in as few calls as the Worker's limits allow (in their order); each visit's answer as before.
    // how.keepalive (hide): calls that outlive the page, each at most KEEPALIVE_BYTES.
    function post(items, how = {}) {
      const calls = [], maxBytes = how.keepalive ? KEEPALIVE_BYTES : CALL_BYTES;
      let call = null;
      for (const it of items) {
        const s = it.body.sightings[0], rows = s.rows.length, bytes = JSON.stringify(s).length;
        if (!call || call.rows + rows > CALL_ROWS || call.items.length >= CALL_SIGHTINGS || call.bytes + bytes > maxBytes) calls.push(call = { items: [], rows: 0, bytes: 0 });
        call.items.push(it); call.rows += rows; call.bytes += bytes;
      }
      // One call after another (second review of 2026-10-18: calls in parallel raced the Worker's live-seen file). A
      // closing tab's keepalive calls all go at once: the page is gone before an answer comes.
      if (how.keepalive) return calls.map(({ items: list }) => postCall(list, how));
      return calls.map(({ items: list }) => { queued++; return (callChain = callChain.then(() => postCall(list, how)).catch(() => null).finally(() => { queued--; })); });
    }
    let callChain = Promise.resolve(), queued = 0;   // the calls waiting their turn (the outbox does not pump meanwhile)
    // A call that gets no answer in CALL_TIMEOUT_MS is given up (review of bundle-328: one call that never answered held
    // every later call and the outbox behind it, the calls go one after another): the fetch is aborted, and the call
    // counts as no answer, so its shops are kept and sent again. Not for a closing tab's keepalive calls.
    const CALL_TIMEOUT_MS = o.callTimeoutMs || 30e3;   // (o.callTimeoutMs: tests)
    function timed(go) {
      const ac = typeof AbortController === "function" ? new AbortController() : null;
      let timer = null;
      const out = new Promise((resolve, reject) => {
        timer = setTimeout(() => { try { ac?.abort(); } catch { /* gone */ } reject(Object.assign(new Error("no answer in " + CALL_TIMEOUT_MS / 1000 + " s"), { timeout: true })); }, CALL_TIMEOUT_MS);
        Promise.resolve().then(() => go(ac ? ac.signal : undefined)).then(resolve, reject);
      });
      return out.finally(() => clearTimeout(timer));
    }
    function postCall(list, how) {
      // this period's unsnapped rows ride on the call (the first one, when a 413 splits it)
      const n = unsnapped; unsnapped = 0;
      const names = unsnappedNames.splice(0, UNSNAPPED_NAMES_PER_CALL);
      const ab = abstained; abstained = { start: 0, mesos: 0 };
      const client = { ...list[0].body.client, ...(n > 0 ? { unsnapped: n } : {}), ...(names.length ? { unsnapped_names: names } : {}), ...(ab.start || ab.mesos ? { abstained: { start: ab.start, mesos: ab.mesos } } : {}) };
      const body = { client, sightings: list.map((it) => it.body.sightings[0]) };
      pending++;
      return Promise.resolve().then(() => (how.keepalive ? o.send(stamp(body), { keepalive: true }) : timed((signal) => o.send(stamp(body), { signal }))))
        .then((answer) => {
          // Over the row budget the Worker takes a call in part (refused.over_limit) and does not say which: every
          // visit of it is kept and sent again, and the ones it took come back as duplicates (the same ids). Only the
          // refused ones are counted "Not sent" (review of pull request 219: the taken ones were counted too).
          const over = list.length > 1 ? Number(answer?.refused?.over_limit) || 0 : 0;
          if (over > 0) {
            const e = Object.assign(new Error("over the row limit"), { status: 429 });
            // Their name crops are not put in the next revs (nightly review of 2026-10-18: the taken visits' crops went
            // again, and each one counts against the player's crop allowance): the kept body, the same id, carries them
            // for the refused ones, and the taken ones come back as duplicates.
            list.forEach((it) => { for (const [, c] of it.crops || []) c.sent = true; notSent(it, e, true); });
            for (let i = Math.min(over, list.length); i > 0; i--) failed(reasonOf(e));
            return;
          }
          list.forEach(sent);
          if (outbox) outbox.kick();   // the other kept bodies are tried once now
        }, (e) => {
          // a call the Worker refused did not count them: they go with the next one (not after no answer: it may have)
          if (n > 0 && e?.status) unsnapped = Math.min(UNSNAPPED_MAX, unsnapped + n);
          if (names.length && e?.status) unsnappedNames.unshift(...names);
          if ((ab.start || ab.mesos) && e?.status) for (const k of ["start", "mesos"]) abstained[k] = Math.min(UNSNAPPED_MAX, abstained[k] + ab[k]);
          // A 413 refuses the call for its size, not each shop in it: the call is split in two and each half sent (review
          // of pull request 219: a refused batched call dropped every shop in it). Not a 400: the Worker answers 400 only
          // for a whole call, never for one shop, so halving it could turn one call into hundreds (Larry's review).
          if (list.length > 1 && e?.status === 413) {
            const h = Math.ceil(list.length / 2);
            // the halves one after the other (keepalive: together, the page is going)
            if (how.keepalive) return Promise.all([postCall(list.slice(0, h), how), postCall(list.slice(h), how)]);
            return postCall(list.slice(0, h), how).then(() => postCall(list.slice(h), how));
          }
          list.forEach((it) => notSent(it, e));
        })
        .finally(() => { pending--; });
    }
    // Sends each visit that changed and then stayed the same for 2 seconds, or whose shop closed, together: at most one
    // call every BATCH_MS (the first at once). With force (the reading stops) every changed visit goes now.
    let lastCall = -Infinity;
    function tick(force) {
      const t = now(), items = [];
      // a shop confirmed as the player's own after it was sent goes again with owner_view (the question comes after the
      // shop is read, so its first send is usually before the Yes)
      for (const v of visits.values()) if (v.sentRev && v.sentOwn != null && v.sentOwn !== isOwn(v) && v.rowRev <= v.sentRev) { v.rowRev++; v.due = true; }
      if (force || t - lastCall >= BATCH_MS) {
        for (const v of [...visits.values()]) if (v.rowRev > v.sentRev && (force || v.due || t - v.changed >= QUIET_MS) && !(v.retryAt > t) && !(!force && foldWait(v, t))) { const it = prepare(v); if (it) items.push(it); }
      }
      if (items.length) lastCall = t;
      const out = !items.length ? [] : o.send ? post(items) : items.map((it) => it.body);
      // the kept bodies go when no call of the tracker's own is out or waiting (they would race the same file)
      if (outbox && pending === 0 && queued === 0) { try { outbox.pump(); } catch { /* reading never stops for a send */ } }
      return out;
    }
    const flush = () => tick(true);
    // The tab closes (pagehide): shops still waiting for their quiet seconds or the next call would be lost (review of
    // pull request 219). Each changed visit goes now in keepalive calls (they outlive the page, at most KEEPALIVE_BYTES
    // in all), and every body, also one on its way, is put in the outbox, which sends it again when the page next starts
    // (a duplicate, the same id, when the call got there).
    function hide() {
      if (!o.send) return [];
      const items = [];
      for (const v of visits.values()) {
        if (v.rowRev > v.sentRev) { const it = prepare(v); if (it) { items.push(it); continue; } }
        if (v.inflight) keepFailed(v.inflight, {}, v.owner);
      }
      let room = KEEPALIVE_BYTES; const go = [];
      for (const it of items) {
        keepFailed(it.body, {}, it.v.owner);   // "offline": kept for the next page
        const b = JSON.stringify(it.body).length;
        if (b <= room) { room -= b; go.push(it); }
      }
      if (go.length) lastCall = now();
      return go.length ? post(go, { keepalive: true }) : [];
    }
    // The shop closed: its visit (and any other changed one) is due without the quiet 2 seconds, in the next call.
    function closed() { for (const v of visits.values()) if (v.rowRev > v.sentRev) v.due = true; tick(); }
    // The outbox's due resends; tick() runs every 500 ms on the page, so this is its clock.
    const resend = () => (outbox ? outbox.pump() : Promise.resolve());
    function status() {
      const place = map ? (room && !/<\s*\d+\s*>/.test(map) ? map + " <" + room + ">" : map) : room ? "Room <" + room + ">" : null, w = world();
      // After a channel change whose pick was not seen (the menu open just before a black screen) the old number is not
      // shown as the channel (Grant: "the status line kept showing the old channel number"): CH ?, and channelWas.
      // mapWhy: why the minimap title was last not read (mapreader.js; "read" once it is), for the report
      return { place, channel: channelUnsure ? null : channel, channelUnsure, channelWas: channelUnsure ? channel : null, world: w, minimap, mapWhy: lastMapWhy, mapScale: lastMapScale, mapScaleOf: lastMapScaleOf, mapEnlarge: lastMapEnlarge,
        text: "You're in: " + (place || "not seen yet") + " · CH " + (channel == null ? "not seen yet" : channelUnsure ? "? (was " + channel + ")" : channel) + " · " + (w || "not seen yet") };
    }
    // screen px per game px: capture.js's, else from the UI scale and the frame width
    function gameSize() { return gameK || (uiScale && frameW ? uiScale * frameW / 1366 : null); }
    // The learned glyphs in the log (learn.js status): when the table starts learning at this scale, and when the first
    // name is read exactly with the glyphs (learned or font.js).
    function learnLog() {
      const gk = gameSize(), L = o.learn || learn;
      if (!gk || !L || !L.status || Math.abs(gk - Math.round(gk)) <= WHOLE_TOL) return;
      let st = null; try { st = L.status(gk); } catch { st = null; }
      if (!st) return;
      const at = gk.toFixed(2) + "x";
      // said when it starts, and again at each further 8 letters (8, 16, 24, 32), so the log shows the table filling
      const step = Math.floor(st.letters / 8), key = "l" + at + ":" + step;
      if (st.taught > 0 && !saidLearn.has(key) && (!saidLearn.has("l" + at) || step > 0)) { saidLearn.add(key); saidLearn.add("l" + at); say("Learning letters at " + at + ": " + st.letters + " of " + st.total); }
      if (st.exact > 0 && !saidLearn.has("e" + at)) { saidLearn.add("e" + at); say("Reading names exactly at " + at); }
    }
    function scaleNudge() {
      const gk = gameSize();
      if (!gk || Math.abs(gk - Math.round(gk)) <= WHOLE_TOL) return false;
      const L = o.learn || learn;
      let share = 0; try { share = L && L.coverage ? L.coverage(gk).share : 0; } catch { share = 0; }
      return share < LEARNED_ENOUGH;
    }
    function alerts() {
      const out = [];
      if (minimap === false) out.push({ kind: "minimap", text: ALERT.minimap });
      else if (mapHidden && !map) out.push({ kind: "minimap", text: ALERT.mapHidden });
      if (channel == null) out.push({ kind: "channel", text: ALERT.channel });
      else if (channelUnsure) out.push({ kind: "channelUnsure", text: ALERT.channelUnsure });
      // L2.2 (Grant's first beta test sent nothing): signed out, known from the page (o.signedIn false) or from a refused send
      // L2.3: a game pixel that is not a whole number of screen pixels, and a learned table that cannot read the common
      // letters yet (learn.js coverage); it goes once the table can
      if (scaleNudge()) out.push({ kind: "scale", text: ALERT.scale });
      if (signedOut || o.signedIn === false || (typeof o.signedIn === "function" && o.signedIn() === false)) out.unshift({ kind: "signin", text: ALERT.signin });
      return out;
    }
    // opened: when the shop opened (its first row's time; a split part keeps its first part's), first: when this part did;
    // ts: its newest row's (Share my shop takes the first shop opened)
    const shops = () => [...visits.values()].sort((a, b) => b.first - a.first || b.ts - a.ts)
      .map((v) => ({ visitId: v.visitId, seller: v.seller || null, title: v.title || null, channel: v.channel || null, map: v.map || null, room: v.room || null, avatarDataUrl: v.avatarDataUrl || null, sellerPicUrl: v.sellerPicUrl || null, first: v.first, opened: v.opened, ts: v.ts, rows: [...v.rows].sort(byPos(v)) }));
    const log = () => lines.map((l) => ({ time: hms(l.t), text: l.text }));
    // speed(): the newest frame's diagnostics ({fps, msFrame, ...}), for the live frames-a-second figure on the Record tab.
    // _sizes(): what the tracker keeps, for the long-session test (tests/livereader-longrun.test.cjs)
    const _sizes = () => ({ visits: visits.size, aliases: aliases.size, sentRows: sentRows.size, lines: lines.length, tallies: tallies.size });
    // resolve(visitId): the visit a shop's id lives on now (a shop folded into the one before it), or null once dropped
    const resolve = (id) => (visits.has(id) ? id : aliases.has(id) && visits.has(aliases.get(id)) ? aliases.get(id) : null);
    // sends(): the report's counts (rows read and with an item id this session, rows sendable now, shops sent, calls on
    // the way, bodies kept) and the last send's answer and the last reason a shop was not sent
    const sendCounts = () => { let ok = 0; for (const v of visits.values()) ok += sendable(v).length;
      return { read: sends.read, known: sends.known, sendable: ok, sent: sentDone.shops + sentRows.size, pending: pending + queued, outbox: outbox ? outbox.size() : early.length, last: sends.last, why: sends.why, whyN: sends.whyN }; };
    return { frame, row, tick, flush, hide, status, alerts, shops, resolve, log, payload, rev, pending: () => pending + queued, resend, outbox: () => outbox, seen: () => seen, speed: () => lastDiag, sends: sendCounts, _sizes };
  }

  // One row picture as PNG base64 (no "data:" prefix), for the evidence picture.
  // A plain {width, height, data} (a name crop) is made an ImageData first.
  const pngBase64 = (pic) => {
    if (pic && !(typeof ImageData !== "undefined" && pic instanceof ImageData) && pic.data && pic.width && typeof ImageData !== "undefined") {
      try { pic = new ImageData(pic.data, pic.width, pic.height); } catch { return null; }
    }
    const url = toDataUrl(pic); return url ? url.slice(url.indexOf(",") + 1) : null;
  };

  return { start, stop, nudgeFor, tracker, pngBase64, version: () => readerVersion, ALERT, _nameCrop: nameCrop };
})();

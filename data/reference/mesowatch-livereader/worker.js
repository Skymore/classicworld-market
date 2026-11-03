// The live reader's Web Worker (beta, FEATURES.liveReader): runs reader.js (self.MesoRowReader) with atlas.json and
// font.js (self.MesoShopFont, the shop's pixel font for exact reading at a whole-number scale) and learn.js (self.MesoLearn:
// the name line's glyphs at any other scale, for the page's learned table).
// Messages in: {type: "rows", id, rows} (several rows, buffers transferred; see below), {type: "read", id, imageData} (one row), {type: "seller", id, imageData, scale} (the seller area). Out: {type: "ready", version (atlas.json's)}, {type: "result", id, result}, {type: "error", id?, message}.
// The worker's own "?v=marketNNN" is passed on, so reader.js and atlas.json come from the same release.
const Q = self.location.search;
let ready = null;
try {
  importScripts("font.js" + Q, "learn.js" + Q, "reader.js" + Q);
  if (!self.MesoRowReader) throw new Error("reader.js did not set MesoRowReader");
  ready = fetch("atlas.json" + Q)
    .then((r) => { if (!r.ok) throw new Error("atlas.json is missing (" + r.status + ")"); return r.json(); })
    .then((atlas) => { const version = String(atlas?.version || ""); return Promise.resolve(self.MesoRowReader.load(atlas)).then(() => version); })
    .then((version) => self.postMessage({ type: "ready", version }))
    .catch((e) => { self.postMessage({ type: "error", message: String(e && e.message || e) }); throw e; });
} catch (e) {
  self.postMessage({ type: "error", message: "reader.js could not load: " + String(e && e.message || e) });
}
self.onmessage = async (ev) => {
  const m = ev.data || {};
  // {type: "rows", id, rows: [{width, height, buffer}]}: several rows in one message, their pixel buffers transferred
  // (no copy); the answer {type: "result", id, result: [one result per row], buffers} hands the buffers back.
  if (m.type === "rows") {
    const buffers = (m.rows || []).map((r) => r.buffer);
    try {
      await ready;
      const result = m.rows.map((r) => {
        try { return self.MesoRowReader.readRow({ width: r.width, height: r.height, data: new Uint8ClampedArray(r.buffer) }, r.scale || r.k ? { scale: r.scale || undefined, k: r.k || undefined, pad: r.pad || undefined, enlarge: r.enlarge || undefined, enlargeGame: r.enlargeGame || undefined, at: r.at || undefined } : undefined); }
        catch (e) { return { abstain: true, why: "reader error: " + String(e && e.message || e) }; }
      });
      self.postMessage({ type: "result", id: m.id, result, buffers }, buffers);
    } catch (e) {
      self.postMessage({ type: "error", id: m.id, message: String(e && e.message || e) });
    }
    return;
  }
  if (m.type !== "read" && m.type !== "seller") return;
  try {
    await ready;
    const result = m.type === "seller" ? self.MesoRowReader.readSeller(m.imageData, { scale: m.scale }) : self.MesoRowReader.readRow(m.imageData);
    self.postMessage({ type: "result", id: m.id, result });
  } catch (e) {
    self.postMessage({ type: "error", id: m.id, message: String(e && e.message || e) });
  }
};

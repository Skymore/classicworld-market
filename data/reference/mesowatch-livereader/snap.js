/* MesoSnap: snaps a possibly misread item name to the catalog. Abstains (null) when unsure.
 * load(catalog): catalog = {items:[[id,name,icon],...]} or an array of {item_id|id,name,icon}.
 * snap(text) -> {item_id, name, icon, score, margin} | null.  score in 0..1 (1 = same after normalizing). */
(function (root) {
  "use strict";
  const MIN_SCORE = 0.82;   // below this the best match is not trusted
  const MIN_MARGIN = 0.1;  // best minus second best (different names) must reach this
  const N = 3;
  let entries = [];         // {id, name, icon, key}
  let grams = new Map();    // n-gram -> [entry index]
  let byKey = new Map();

  // Fold typical pixel-font confusions: l/I/|/1 -> l, O/0 -> o, rn -> m, vv -> w; drop spaces and punctuation.
  function fold(s) {
    s = String(s == null ? "" : s).replace(/\.{2,}|…/g, "").toLowerCase();
    s = s.replace(/rn/g, "m").replace(/vv/g, "w").replace(/[|1!i]/g, "l").replace(/0/g, "o").replace(/5/g, "s").replace(/8/g, "b");
    return s.replace(/[^a-z]/g, "");
  }
  function isTruncated(s) { return /(\.{2,}|…)\s*$/.test(String(s)); }
  function gramsOf(k) {
    const p = "^" + k + "$", out = new Set();
    if (p.length < N) { out.add(p); return out; }
    for (let i = 0; i + N <= p.length; i++) out.add(p.slice(i, i + N));
    return out;
  }
  function lev(a, b, cap) {
    if (a === b) return 0;
    const la = a.length, lb = b.length;
    if (Math.abs(la - lb) > cap) return cap + 1;
    let prev = new Array(lb + 1), cur = new Array(lb + 1);
    for (let j = 0; j <= lb; j++) prev[j] = j;
    for (let i = 1; i <= la; i++) {
      cur[0] = i; let rowMin = i;
      for (let j = 1; j <= lb; j++) {
        const c = a.charCodeAt(i - 1) === b.charCodeAt(j - 1) ? 0 : 1;
        cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + c);
        if (cur[j] < rowMin) rowMin = cur[j];
      }
      if (rowMin > cap) return cap + 1;
      const t = prev; prev = cur; cur = t;
    }
    return prev[lb];
  }
  function sim(a, b) {
    const m = Math.max(a.length, b.length);
    if (!m) return 0;
    const cap = Math.ceil(m * 0.4);
    return 1 - Math.min(lev(a, b, cap), cap + 1) / m;
  }

  function load(catalog) {
    const list = Array.isArray(catalog) ? catalog : (catalog && catalog.items) || [];
    entries = []; grams = new Map(); byKey = new Map();
    for (const r of list) {
      const e = Array.isArray(r) ? { id: r[0], name: r[1], icon: r[2] } : { id: r.item_id != null ? r.item_id : r.id, name: r.name, icon: r.icon };
      e.key = fold(e.name);
      if (!e.key) continue;
      const idx = entries.push(e) - 1;
      if (!byKey.has(e.key)) byKey.set(e.key, []);
      byKey.get(e.key).push(idx);
      for (const g of gramsOf(e.key)) { let a = grams.get(g); if (!a) grams.set(g, a = []); a.push(idx); }
    }
    return entries.length;
  }

  function result(e, score, margin) {
    return { item_id: e.id, name: e.name, icon: e.icon, score: Math.round(score * 1000) / 1000, margin: Math.round(margin * 1000) / 1000 };
  }

  function snap(nameText) {
    if (!entries.length) return null;
    const trunc = isTruncated(nameText);
    const q = fold(nameText);
    if (q.length < 3) return null;
    const qg = gramsOf(trunc ? q : q);
    // Candidate set: entries sharing n-grams, ranked by shared count.
    const hits = new Map();
    for (const g of qg) { const a = grams.get(g); if (a) for (const i of a) hits.set(i, (hits.get(i) || 0) + 1); }
    const cand = [...hits.entries()].sort((x, y) => y[1] - x[1]).slice(0, 60).map((x) => x[0]);
    const scored = [];
    for (const i of cand) {
      const k = entries[i].key;
      let s = sim(q, k);
      if (trunc && q.length >= 4 && k.length > q.length) {
        // The window cut the name: compare against the same-length start of the full name.
        const sp = sim(q, k.slice(0, q.length));
        const frac = q.length / k.length;
        if (sp > s) s = sp * (0.9 + 0.1 * Math.min(1, frac)); // a prefix match is weaker than a full one
      }
      scored.push([s, i]);
    }
    if (!scored.length) return null;
    scored.sort((a, b) => b[0] - a[0]);
    const best = scored[0], e = entries[best[1]];
    // Second best among entries with a different name key (same name twice is not an ambiguity).
    let second = 0;
    for (let n = 1; n < scored.length; n++) if (entries[scored[n][1]].key !== e.key) { second = scored[n][0]; break; }
    // Same folded name for two different ids: cannot tell which, so abstain.
    if ((byKey.get(e.key) || []).length > 1) return null;
    const margin = best[0] - second;
    if (best[0] < MIN_SCORE || margin < MIN_MARGIN) return null;
    return result(e, best[0], margin);
  }

  // An exactly read name (reader.js readExact): no fuzzy matching, which picks near-twins such as "Red Sailor Skirt"
  // for "Red Sailor Shirt". The name is the catalog name itself; a name cut with "..." is the start of exactly one
  // catalog name; a glyph the font lacks ("?", one to three letters) is filled when exactly one name fits. I and l
  // share a glyph, so either fits. A scroll cut before its grade ("Scroll:...") fits four names: opts.grade, read
  // from the icon (reader.js scrollGrade), keeps the one ending in it. Else null.
  function snapExact(nameText, opts) {
    if (!entries.length) return null;
    const t = String(nameText || "").trim(), cut = /\.\.\.$/.test(t), body = cut ? t.slice(0, -3) : t;
    if (body.replace(/\?/g, "").length < 3) return null;
    const src = body.replace(/[.*+^${}()|[\]\\]/g, "\\$&").replace(/\?/g, ".{1,3}").replace(/[lI]/g, "[lI]");
    const re = new RegExp("^" + src + (cut ? "" : "$"));
    let fits = entries.filter((e) => re.test(e.name));
    const grade = opts && opts.grade;
    if (fits.length > 1 && grade) fits = fits.filter((e) => e.name.endsWith(": " + grade));
    if (!fits.length || new Set(fits.map((e) => e.name)).size !== 1 || fits.length > 1) return null;   // none, or ambiguous
    return result(fits[0], 1, 1);
  }

  const api = { load, snap, snapExact, _fold: fold };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.MesoSnap = api;
})(typeof window !== "undefined" ? window : globalThis);

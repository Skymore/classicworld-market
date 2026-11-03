// The live reader's outbox (beta, FEATURES.liveReader). A read shop is never lost when its send fails.
// When a send to /v1/sightings fails with 429, 503, another 5xx or a network fault (also 401: not signed in; and a 403 from Cloudflare, not the Worker), the
// tracker (live.js) puts the visit's newest body here, one entry per visit (the newest rev replaces an older one). The
// outbox keeps it in IndexedDB (database "mesowatch-live", store "outbox"; in memory when IndexedDB is missing or
// throws), at most 500 visits and 5 MB (the oldest go first), and sends it again unchanged (same sighting id and rev:
// the upload Worker takes a seen id as a duplicate, which counts as done) 1, 2, 5, 10 and then every 15 minutes; also
// once when a send succeeds (kick) and once when the page starts, START_DELAY after it. A visit refused as not signed in goes when the page
// signs in, or on its backoff while the page says signed in. A visit seen more than 50 minutes ago is dropped (the Worker refuses seen_at older than 60 minutes).
//   MesoOutbox.create({ send, now, indexedDB, signedIn, owner, onChange, onSent, onDrop }) ->
//     { put(body, kind, owner), done(visit, rev), kick(), pump(), ready, size(), bytes(), kind(), entries() }
// kind: "busy" (429 or 5xx), "offline" (no answer), "auth" (401; a 403 with no Worker answer is "busy"); kindOf(error) gives it, or null when a
// failure is not one to keep (another 4xx: the Worker refused the body, so a resend would be refused too).
(function (root) {
  const MIN = 60e3;
  const DELAYS = [1 * MIN, 2 * MIN, 5 * MIN, 10 * MIN, 15 * MIN];
  // What an earlier page kept waits this long after the page starts (Larry, 2026-10-18): a reload in the middle of
  // reading sends the closing page's shops in keepalive calls (live.js hide), and the same shops sent again at once
  // could arrive together and be counted twice. Also a sign-in or a kick() does not send them sooner.
  const START_DELAY = 5000;
  const MAX_ITEMS = 500, MAX_BYTES = 5 * 1024 * 1024, MAX_AGE = 50 * MIN;
  const DB = "mesowatch-live", STORE = "outbox";

  // auth: a 401 (the Worker's "Sign in first"). A 403 with the Worker's own answer (e.worker: its JSON error) is a
  // refusal, not kept (second review of 2026-10-18: it answers 403 to code sessions, blocked accounts and another origin,
  // which /api/me calls signed in, and every kept shop was posted again back to back all session; its code-session
  // wording says "Sign in with Discord or Google" and is a refusal too). Any other 403 (Cloudflare in front of the
  // Worker: a WAF or bot check, no JSON) is "busy": kept and sent again later (review of bundle-327: it was dropped).
  function kindOf(e) {
    const s = e && e.status;
    if (!s) return "offline";
    if (s === 401) return "auth";
    if (s === 403) return e.worker ? null : "busy";
    if (s === 429 || s >= 500) return "busy";
    return null;
  }

  // A small IndexedDB mirror of the memory map. Any fault turns it off (memory only); it never throws.
  function mirror(idb) {
    let db = null, dead = !idb;
    const open = dead ? Promise.resolve(null) : new Promise((resolve) => {
      try {
        const req = idb.open(DB, 1);
        req.onupgradeneeded = () => { try { if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE, { keyPath: "visit" }); } catch { /* the open fails next */ } };
        req.onsuccess = () => { db = req.result; resolve(db); };
        req.onerror = () => { dead = true; resolve(null); };
        req.onblocked = () => { dead = true; resolve(null); };
      } catch { dead = true; resolve(null); }
    });
    function run(mode, fn) {
      return open.then((d) => new Promise((resolve) => {
        if (!d || dead) return resolve(null);
        try {
          const tx = d.transaction(STORE, mode), req = fn(tx.objectStore(STORE));
          tx.oncomplete = () => resolve(req ? req.result : null);
          tx.onerror = tx.onabort = () => { resolve(null); };
        } catch { dead = true; resolve(null); }
      }));
    }
    return {
      all: () => run("readonly", (s) => s.getAll()).then((x) => (Array.isArray(x) ? x : [])),
      put: (e) => run("readwrite", (s) => s.put(e)),
      del: (visit) => run("readwrite", (s) => s.delete(visit)),
      on: () => open.then((d) => !!d && !dead),
    };
  }

  function create(o = {}) {
    const now = o.now || (() => Date.now());
    let idb = null;
    try { idb = o.indexedDB !== undefined ? o.indexedDB : (typeof indexedDB !== "undefined" ? indexedDB : null); } catch { idb = null; }
    const store = mirror(idb);
    const items = new Map();   // visit uuid -> entry
    let total = 0, lastKind = null, pumping = null;
    const signedIn = () => { try { const s = typeof o.signedIn === "function" ? o.signedIn() : o.signedIn; return s === true; } catch { return false; } };
    // owner: the account the page is signed in as now ("discord:123"), or null when not known; kept with each entry
    const ownerNow = () => { try { const v = typeof o.owner === "function" ? o.owner() : o.owner; return v ? String(v) : null; } catch { return null; } };
    const call = (f, ...a) => { try { f && f(...a); } catch { /* a page hook never stops the outbox */ } };
    const changed = () => call(o.onChange, { waiting: items.size, kind: lastKind });

    function seenOf(body) { const t = Date.parse(body?.sightings?.[0]?.seen_at); return Number.isFinite(t) ? t : null; }
    function remove(visit) {
      const e = items.get(visit); if (!e) return null;
      items.delete(visit); total -= e.bytes; store.del(visit);
      return e;
    }
    function drop(e, why) { if (remove(e.visit)) call(o.onDrop, e, why); }
    function tooOld(e, t) { return (e.seenAt ?? e.queuedAt) < t - MAX_AGE; }
    function prune() {
      const t = now();
      for (const e of [...items.values()]) if (tooOld(e, t)) drop(e, "too old");
      if (items.size <= MAX_ITEMS && total <= MAX_BYTES) return;
      const old = [...items.values()].sort((a, b) => a.queuedAt - b.queuedAt);
      for (const e of old) { if (items.size <= MAX_ITEMS && total <= MAX_BYTES) break; drop(e, "outbox full"); }
    }
    function keep(e) {
      const was = items.get(e.visit);
      if (was) total -= was.bytes;
      items.set(e.visit, e); total += e.bytes;
      store.put(e);
    }

    // put(body, kind): keep a failed send. A newer rev of the same visit replaces the kept one (its waiting time
    // goes with it); an older rev is ignored. Returns true when kept.
    function put(body, kind, owner) {
      const s = body?.sightings?.[0];
      if (!s || !s.visit) return false;
      const visit = String(s.visit), rev = Number(s.rev) || 0, was = items.get(visit), t = now();
      if (was && was.rev > rev) return false;
      let bytes = 0; try { bytes = JSON.stringify(body).length; } catch { return false; }
      const e = { visit, rev, id: s.id, body, bytes, seenAt: seenOf(body), queuedAt: was ? was.queuedAt : t,
        tries: was ? was.tries : 0, nextAt: was ? was.nextAt : t + DELAYS[0], auth: kind === "auth" || (!!was?.auth && was.rev === rev),
        owner: was?.owner ?? owner ?? ownerNow() };   // owner: the account the visit was read under (live.js), else the one now
      if (tooOld(e, t)) { if (was) drop(was, "too old"); else call(o.onDrop, e, "too old"); changed(); return false; }
      lastKind = kind || lastKind;
      keep(e); prune(); changed();
      return items.has(visit);
    }
    // done(visit, rev): a send of this visit went through; a kept entry of that rev or older goes.
    function done(visit, rev) {
      const e = items.get(String(visit));
      if (e && e.rev <= (Number(rev) || 0)) { remove(e.visit); changed(); }
    }
    // A visit that waits for sign-in goes when the page goes from signed out to signed in (released), else only on its
    // own backoff (1, 2, 5 ... minutes) and only while the page says signed in: a 401 the page itself says signed in
    // to is not posted again every tick (second review of 2026-10-18: up to 500 posts a round, all session).
    // A kept visit goes only under the account it was read under (review of bundle-327: a page's spare tracker sent an
    // earlier page's shops under whoever was signed in now). An entry with no owner (kept before this, or read while the
    // account was not known) goes under any; one of another account waits, and is dropped when too old.
    let lastSigned = null;
    const ownerOk = (e) => { if (!e.owner) return true; const now0 = ownerNow(); return !!now0 && now0 === e.owner; };
    const due = (e, t) => (e.notBefore || 0) <= t && ownerOk(e) && (e.auth ? signedIn() && (e.released || e.nextAt <= t) : e.nextAt <= t);
    // pump(): sends the kept visits that are due, one at a time, oldest first; a busy, offline or auth answer stops the
    // round.
    function pump() {
      if (pumping) return pumping;
      if (!items.size || !o.send) return Promise.resolve();
      const s = signedIn();
      if (s && lastSigned === false) for (const x of items.values()) if (x.auth) x.released = true;   // signed in just now
      lastSigned = s;
      prune();
      const t0 = now(), list = [...items.values()].filter((e) => due(e, t0)).sort((a, b) => a.queuedAt - b.queuedAt);
      if (!list.length) { changed(); return Promise.resolve(); }
      pumping = (async () => {
        for (let i = 0; i < list.length; i++) {
          const e = list[i];
          if (items.get(e.visit) !== e) continue;   // replaced or gone meanwhile
          if (tooOld(e, now())) { drop(e, "too old"); continue; }
          try {
            await o.send(e.body);
            if (items.get(e.visit) === e) remove(e.visit);
            call(o.onSent, e);
            if (e.auth) for (const x of items.values()) x.auth = false;   // a send went through: signed in
          } catch (err) {
            const k = kindOf(err);
            if (items.get(e.visit) !== e) continue;
            if (!k) { drop(e, "refused"); continue; }
            lastKind = k;
            if (k === "auth") {   // the others would get the same answer: this round stops, and this one waits its backoff
              e.auth = true; e.released = false; e.tries++; e.nextAt = now() + DELAYS[Math.min(e.tries, DELAYS.length - 1)]; store.put(e);
              // and the others wait as long: not one of them each tick
              for (const x of items.values()) if (x !== e) { x.nextAt = Math.max(x.nextAt, e.nextAt); x.released = false; store.put(x); }
              break;
            }
            e.auth = false; e.tries++; e.nextAt = now() + DELAYS[Math.min(e.tries, DELAYS.length - 1)]; store.put(e);
            for (const x of list.slice(i + 1)) if (items.get(x.visit) === x && !x.auth) { x.nextAt = Math.max(x.nextAt, e.nextAt); store.put(x); }
            break;
          }
        }
      })().catch(() => null).finally(() => { pumping = null; changed(); });
      return pumping;
    }
    // kick(): a send went through; every kept visit is tried once now (also the ones that waited for sign-in).
    function kick() {
      const t = now();
      for (const e of items.values()) { e.nextAt = Math.max(Math.min(e.nextAt, t), e.notBefore || 0); e.auth = false; }
      return pump();
    }
    // The page starts: what an earlier page kept is loaded and tried once, START_DELAY later (the page's tick pumps it).
    const ready = store.all().then((list) => {
      const t = now();
      for (const x of list) {
        if (!x || !x.visit || !x.body) continue;
        const have = items.get(x.visit);
        if (have && have.rev >= x.rev) continue;
        keep({ ...x, nextAt: t + START_DELAY, notBefore: t + START_DELAY, auth: !!x.auth });
      }
      prune(); changed();
      return pump();
    }).catch(() => null);
    return { put, done, kick, pump, ready, size: () => items.size, bytes: () => total, kind: () => lastKind,
      entries: () => [...items.values()].map((e) => ({ visit: e.visit, rev: e.rev, id: e.id, tries: e.tries, nextAt: e.nextAt, auth: e.auth })),
      storage: () => store.on() };
  }

  const api = { create, kindOf, DELAYS, START_DELAY, MAX_ITEMS, MAX_BYTES, MAX_AGE };
  (typeof window !== "undefined" ? window : root).MesoOutbox = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof self !== "undefined" ? self : globalThis);

// Korean lookup shared by the site (i18n.js) and the collector window
// (frontend/desktop/i18n.ts). No imports: the desktop build bundles it alone.
// `ui` is server/crates/market-web/src/i18n/ko.json (Chinese interface text ->
// Korean); `names` the client's Korean game names by Chinese and English
// name (/api/v1/i18n/ko).
const korean = { ready: false, ui: {}, zh: {}, en: {}, patterns: null, cache: new Map() };

export function useKorean(ui, names = {}) {
  korean.ui = ui || {};
  korean.zh = names.zh || {};
  korean.en = names.en || {};
  korean.patterns = null;
  korean.cache.clear();
  korean.ready = true;
}
export const koreanReady = () => korean.ready;

const escapeRegExp = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// Templates ("单价 {0}") match the built Chinese text; the values are carried over.
function patterns() {
  if (korean.patterns) return korean.patterns;
  const list = [];
  for (const [zh, ko] of Object.entries(korean.ui)) {
    if (!/\{\d+\}/.test(zh)) continue;
    const parts = zh.split(/\{(\d+)\}/);
    let source = '^';
    const order = [];
    for (let i = 0; i < parts.length; i++) {
      if (i % 2) { source += '([\\s\\S]*?)'; order.push(parts[i]); } else source += escapeRegExp(parts[i]);
    }
    // Templates with more fixed text are tried first; all-placeholder ones never match.
    const weight = zh.replace(/\{\d+\}/g, '').trim().length;
    if (weight) list.push({ re: new RegExp(source + '$'), order, ko, weight });
  }
  list.sort((a, b) => b.weight - a.weight);
  return (korean.patterns = list);
}
const plain = value => korean.ui[value] ?? korean.zh[value] ?? value;

/** Korean for a two-language string; null when the dictionaries have none. */
export function koText(zh, en) {
  if (zh == null) return en != null ? korean.en[en] ?? null : null;
  const key = String(zh);
  let out;
  if (korean.cache.has(key)) out = korean.cache.get(key);
  else {
    out = korean.ui[key] ?? korean.zh[key] ?? null;
    if (out == null && /[一-鿿]/.test(key)) {
      for (const p of patterns()) {
        const m = p.re.exec(key);
        if (!m) continue;
        out = p.ko.replace(/\{(\d+)\}/g, (_, n) => plain(m[p.order.indexOf(n) + 1] ?? ''));
        break;
      }
    }
    if (korean.cache.size > 5000) korean.cache.clear();
    korean.cache.set(key, out);
  }
  return out ?? (en != null ? korean.en[en] ?? null : null);
}

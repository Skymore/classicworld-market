// Lists the Chinese interface strings that the Korean dictionary must cover:
//   node tools/i18n/ko-strings.mjs            -> prints missing strings as JSON
//   node tools/i18n/ko-strings.mjs --check    -> exit 1 when any is missing
//   node tools/i18n/ko-strings.mjs --stats
//   node tools/i18n/ko-strings.mjs --prune    -> drops dictionary keys no source uses
// Sources: every Chinese string or template literal in the React site and the
// collector window (a template's `${...}` becomes {0}, {1}...), the Chinese
// side of `lang.t("中文", "English")` pairs in the Rust pages, and the zh
// dictionaries of web/js/lib `addMessages`. The dictionary is
// server/crates/market-web/src/i18n/ko.json, keyed by the Chinese text.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const dictionaryPath = path.join(root, 'server/crates/market-web/src/i18n/ko.json');
const skipDir = new Set(['node_modules', 'react', 'chunks', 'tests']);
const hasHan = /[一-鿿]/;

function files(dir, pattern, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) { if (!skipDir.has(entry.name)) files(full, pattern, out); }
    else if (pattern.test(entry.name) && !/\.test\.|\.e2e\.|\.d\.ts$/.test(entry.name)) out.push(full);
  }
  return out;
}

const quoted = String.raw`"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'`;
const template = String.raw`\x60(?:[^\x60\\]|\\.)*\x60`;
const unescape = body => body.replace(/\\(u\{[0-9a-fA-F]+\}|u[0-9a-fA-F]{4}|x[0-9a-fA-F]{2}|n|t|r|\n|.)/g, (_, c) => {
  if (c[0] === 'u') return String.fromCodePoint(parseInt(c.replace(/[u{}]/g, ''), 16));
  if (c[0] === 'x' && c.length === 3) return String.fromCharCode(parseInt(c.slice(1), 16));
  return { n: '\n', t: '\t', r: '\r', '\n': '' }[c] ?? c;
});

/** A literal's text; a template's `${...}` (nested braces allowed) becomes {0}, {1}... */
function literalText(token) {
  if (token[0] !== '`') return unescape(token.slice(1, -1));
  const body = token.slice(1, -1);
  let out = '', n = 0;
  for (let i = 0; i < body.length; i++) {
    if (body[i] === '\\') { out += body.slice(i, i + 2); i++; continue; }
    if (body[i] === '$' && body[i + 1] === '{') {
      let depth = 0, j = i + 1;
      for (; j < body.length; j++) { if (body[j] === '{') depth++; else if (body[j] === '}' && --depth === 0) break; }
      out += `{${n++}}`; i = j; continue;
    }
    out += body[i];
  }
  return unescape(out);
}

/** Drops // and /* comments so commented Chinese is not collected. */
function stripComments(text) {
  return text.replace(new RegExp(`(${quoted}|${template})|\\/\\*[\\s\\S]*?\\*\\/|\\/\\/[^\\n]*`, 'g'), (m, lit) => lit ?? '');
}

export function collect() {
  const found = new Map();
  const add = (zh, where) => {
    zh = zh.trim() === zh ? zh : zh; // keep exact text: the runtime looks it up verbatim
    if (hasHan.test(zh) && !found.has(zh)) found.set(zh, where);
  };
  // Shared modules the React site renders text from (they call `say` / cwmKorean).
  const shared = ['equipment-summary.js', 'item-offer-filters.js', 'dex-filters.js', 'format.js', 'period.js']
    .map(name => path.join(root, 'web/js/lib', name));
  for (const dir of ['frontend/src', 'frontend/desktop', ...shared]) {
    const list = dir.endsWith('.js') ? [dir] : files(path.join(root, dir), /\.(tsx?|mjs|js)$/);
    for (const file of list) {
      const where = path.relative(root, file).replaceAll('\\', '/');
      const text = stripComments(fs.readFileSync(file, 'utf8'));
      for (const m of text.matchAll(new RegExp(`${quoted}|${template}`, 'g'))) add(literalText(m[0]), where);
    }
  }
  for (const file of files(path.join(root, 'web/js/lib'), /\.js$/)) {
    const where = path.relative(root, file).replaceAll('\\', '/');
    const text = fs.readFileSync(file, 'utf8');
    for (const block of text.matchAll(/\bzh:\s*\{([\s\S]*?)\n\s*\},\s*\n\s*en:/g)) {
      for (const m of block[1].matchAll(new RegExp(`(?:${quoted})\\s*:\\s*(${quoted})`, 'g'))) add(literalText(m[1]), where);
    }
  }
  const rustPair = new RegExp(String.raw`(?:\.t\(|\()\s*(` + quoted + String.raw`)\s*,\s*(?:` + quoted + String.raw`)\s*[,)]`, 'g');
  for (const file of files(path.join(root, 'server/crates/market-web/src'), /\.rs$/)) {
    const where = path.relative(root, file).replaceAll('\\', '/');
    const text = stripComments(fs.readFileSync(file, 'utf8'));
    for (const m of text.matchAll(rustPair)) add(literalText(m[1]), where);
  }
  return found;
}

const strings = collect();
const dictionary = fs.existsSync(dictionaryPath) ? JSON.parse(fs.readFileSync(dictionaryPath, 'utf8')) : {};
const missing = [...strings.keys()].filter(zh => !(zh in dictionary));
if (process.argv.includes('--stats')) {
  console.log(JSON.stringify({ strings: strings.size, translated: strings.size - missing.length, missing: missing.length }));
} else if (process.argv.includes('--prune')) {
  const kept = Object.fromEntries(Object.entries(dictionary).filter(([zh]) => strings.has(zh)));
  fs.writeFileSync(dictionaryPath, JSON.stringify(kept, null, 1) + '\n');
  console.log(`kept ${Object.keys(kept).length} of ${Object.keys(dictionary).length}`);
} else if (process.argv.includes('--check')) {
  if (missing.length) {
    console.error(`${missing.length} Chinese strings have no Korean translation in ${path.relative(root, dictionaryPath)}:`);
    for (const zh of missing.slice(0, 40)) console.error(`  ${JSON.stringify(zh)}  (${strings.get(zh)})`);
    process.exit(1);
  }
} else {
  const out = {};
  for (const zh of missing) out[zh] = strings.get(zh);
  console.log(JSON.stringify(out, null, 1));
}

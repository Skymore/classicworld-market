import { userStorage as localStorage } from './user-data.js';
import { koText, koreanReady, useKorean } from './ko-text.js';
// Shared modules without imports (equipment summaries, offer filter labels) read this.
const useTranslator = fn => { globalThis.cwmKorean = fn; };
// Key-based i18n (plan v1 §8.3). Each page registers its own keys with
// `addMessages` from its own module so parallel work never edits one dictionary.
// Languages: zh, en, ko. Korean is a dictionary keyed by the Chinese text
// (server/crates/market-web/src/i18n/ko.json, served at /api/v1/i18n/ko-ui)
// plus the client's Korean game names (/api/v1/i18n/ko); see `koText`.
export const LANGUAGES = ['zh', 'en', 'ko'];
const dicts = { zh: {}, en: {}, ko: {} };
const known = value => LANGUAGES.includes(value);

// The language follows the browser: `?lang=` for this view (shared links,
// the collector window), then an explicit choice from the language menu
// (`uiLang`; 跟随浏览器 removes it), then the browser's languages, then the
// visitor's country (`ipLanguage`, asked only when the browser names none).
const stored = () => {
  try { return localStorage.getItem('uiLang'); } catch { return null; }
};
/** The browser's language, or null when it states none. */
export function browserLanguage() {
  const list = (navigator.languages && navigator.languages.length ? navigator.languages : [navigator.language]).filter(Boolean);
  if (!list.length) return null;
  for (const tag of list) {
    const code = String(tag).toLowerCase();
    if (code.startsWith('zh')) return 'zh';
    if (code.startsWith('ko')) return 'ko';
    if (code.startsWith('en')) return 'en';
  }
  return 'en';
}
// `?lang=` holds for this tab (boot.js keeps it in sessionStorage).
const viewLang = () => {
  const asked = new URLSearchParams(location.search).get('lang');
  if (known(asked)) return asked;
  try { return sessionStorage.getItem('cwm.view.lang'); } catch { return null; }
};
const fromUrl = viewLang();
// boot.js resolved the same order (and the IP guess cookie) before the first paint.
const booted = document.documentElement.dataset.langResolved;
// boot.js already read the cached account preference, which the guest
// storage here cannot see before the account is confirmed.
export let lang = known(fromUrl) ? fromUrl
  : known(booted) ? booted
  : known(stored()) ? stored()
  : browserLanguage() || 'zh';
const htmlLang = l => (l === 'zh' ? 'zh-CN' : l);
document.documentElement.lang = htmlLang(lang);

/** When the browser states no language: the server's guess from the country of the IP. */
export async function ipLanguage() {
  if (browserLanguage() || known(fromUrl) || known(stored())) return null;
  try {
    const answer = await fetch('/api/v1/i18n/guess', { credentials: 'omit' }).then(r => r.json());
    return known(answer?.lang) ? answer.lang : null;
  } catch { return null; }
}

/** Re-reads the saved choice (account preferences arrive after the first paint). */
export function resolveLanguage() {
  const view = viewLang();
  return known(view) ? view : known(stored()) ? stored() : browserLanguage() || lang;
}

/** The language menu's choice: 'zh' | 'en' | 'ko', or 'system' (follow the browser). */
export function languageChoice() {
  const saved = stored();
  return known(saved) ? saved : 'system';
}

/** Switches language; `save` keeps it as the visitor's choice. */
export function setLang(next, { save = true } = {}) {
  lang = known(next) ? next : 'zh';
  if (save) {
    try { sessionStorage.removeItem('cwm.view.lang'); } catch { /* private mode */ }
    try { localStorage.setItem('uiLang', lang); } catch { /* private mode */ }
  }
  document.documentElement.lang = htmlLang(lang);
  document.documentElement.dataset.lang = lang;
  useTranslator(lang === 'ko' ? koText : null);
  const announce = () => document.dispatchEvent(new CustomEvent('langchange', { detail: lang }));
  if (lang === 'ko' && !koreanReady()) loadKorean().then(announce); else announce();
}

/** 跟随浏览器: drops the choice; the browser's language (or the IP guess) applies. */
export async function followBrowser() {
  try { sessionStorage.removeItem('cwm.view.lang'); } catch { /* private mode */ }
  try { localStorage.removeItem('uiLang'); } catch { /* private mode */ }
  const next = browserLanguage() || (await ipLanguage()) || lang;
  setLang(next, { save: false });
}

/** The next language after `current`: 中文 -> English -> 한국어. */
export const nextLanguage = (current = lang) => LANGUAGES[(LANGUAGES.indexOf(current) + 1) % LANGUAGES.length];

// ---------- Korean ----------
let koreanLoading = null;
/** Loads the Korean dictionaries once; resolves when words can be translated. */
export function loadKorean() {
  if (koreanReady()) return Promise.resolve();
  return (koreanLoading ??= Promise.all([
    fetch('/api/v1/i18n/ko-ui').then(r => (r.ok ? r.json() : {})).catch(() => ({})),
    fetch('/api/v1/i18n/ko').then(r => (r.ok ? r.json() : {})).catch(() => ({})),
  ]).then(([ui, names]) => useKorean(ui, names)));
}
export { koText, koreanReady, useKorean };
/** The text for the current language: Chinese, English, or Korean (falling back to English). */
export function pick(zh, en) {
  if (lang === 'zh') return zh;
  if (lang === 'en') return en;
  return koText(zh, en) ?? en ?? zh;
}
useTranslator(lang === 'ko' ? koText : null);
if (lang === 'ko') loadKorean().then(() => document.dispatchEvent(new CustomEvent('langchange', { detail: lang })));

export function addMessages(messages) {
  for (const l of Object.keys(dicts)) Object.assign(dicts[l], messages[l] || {});
}

// `t('time.minutes_ago', { n: 5 })` with `{n}` placeholders. Missing keys fall
// back to zh (Korean: the Korean of the zh text, then en), then to the key
// itself so a gap is visible, never a crash.
export function t(key, params) {
  let s = dicts[lang][key];
  if (s == null && lang === 'ko' && dicts.zh[key] != null) s = koText(dicts.zh[key], null) ?? dicts.en[key];
  s ??= dicts.zh[key] ?? key;
  if (params) for (const [k, v] of Object.entries(params)) s = s.replaceAll(`{${k}}`, String(v));
  return s;
}

// Item display name for the current language; falls back across languages.
export const itemName = (row) => (lang === 'en' ? row.name_en || row.name_zh
  : lang === 'ko' ? koText(row.name_zh, row.name_en) || row.name_en || row.name_zh
  : row.name_zh || row.name_en) || String(row.item_id);

addMessages({
  zh: {
    'time.just_now': '刚刚', 'time.minutes_ago': '{n}分钟前', 'time.hours_ago': '{n}小时前', 'time.days_ago': '{n}天前',
    'chg.flat': '持平', 'chg.up_label': '上涨 {pct}%', 'chg.down_label': '下跌 {pct}%',
    'loc.unknown': '位置未知', 'loc.room': '{n}洞',
    'evidence.drop': '卖出', 'evidence.sold_out': '卖光', 'evidence.found_sold': '卖光',
    'evidence.help.drop': '库存比上次少，卖掉了一部分', 'evidence.help.sold_out': '整组卖完了', 'evidence.help.found_sold': '整组卖完了',
    'nav.home': '首页', 'nav.main': '主导航', 'nav.prices': '价格', 'nav.prices_long': '价格表', 'nav.dex': '图鉴', 'nav.mobs': '图鉴', 'nav.maps': '地图',
    'nav.watch': '关注', 'nav.sales': '成交', 'nav.alerts': '低价提醒', 'nav.collect': '浏览器采集',
    'brand': '枫叶市集', 'search.placeholder': '搜索物品、怪物、地图', 'search.label': '搜索',
    'fresh.updated': '数据{ago}更新', 'fresh.just_now': '数据刚刚更新',
    'common.more': '更多', 'common.loading': '加载中…', 'common.empty': '还没有数据', 'common.error': '加载失败，稍后再试',
    'common.retry': '重试', 'common.close': '关闭', 'common.no_match': '冒险家，换个关键词试试。',
    'theme.toggle': '切换夜市主题', 'lang.toggle': 'English',
    'cat.装备': '装备', 'cat.消耗品': '消耗', 'cat.装饰': '装饰', 'cat.其他': '其他', 'cat.商城物品': '商城', 'cat.未知': '未知',
    'job.通用': '通用', 'job.新手': '新手', 'job.战士': '战士', 'job.魔法师': '法师', 'job.弓箭手': '弓箭手', 'job.飞侠': '飞侠', 'job.海盗': '海盗',
    'level.n': '{n} 级', 'level.none': '无等级限制',
    'sale.note': '发现已售 = 第一次看到时已经卖完，时间是发现时间，不是实际成交时间；看到卖光 / 看到卖出 = 两次访问之间库存变成 0 / 变少。',
  },
  en: {
    'time.just_now': 'just now', 'time.minutes_ago': '{n}m ago', 'time.hours_ago': '{n}h ago', 'time.days_ago': '{n}d ago',
    'chg.flat': 'flat', 'chg.up_label': 'up {pct}%', 'chg.down_label': 'down {pct}%',
    'loc.unknown': 'no location', 'loc.room': 'room {n}',
    'evidence.drop': 'sold', 'evidence.sold_out': 'sold out', 'evidence.found_sold': 'sold out',
    'evidence.help.drop': 'Stock dropped since the last visit; part of it sold', 'evidence.help.sold_out': 'The whole stack sold', 'evidence.help.found_sold': 'The whole stack sold',
    'nav.home': 'Home', 'nav.main': 'Main', 'nav.prices': 'Prices', 'nav.prices_long': 'Price table', 'nav.dex': 'Dex', 'nav.mobs': 'Catalogue', 'nav.maps': 'Maps',
    'nav.watch': 'Watch', 'nav.sales': 'Sales', 'nav.alerts': 'Deal alerts', 'nav.collect': 'Browser collector',
    'brand': 'Maple Market', 'search.placeholder': 'Search items, monsters, maps', 'search.label': 'Search',
    'fresh.updated': 'updated{ago}', 'fresh.just_now': 'just updated',
    'common.more': 'More', 'common.loading': 'Loading…', 'common.empty': 'Nothing here yet', 'common.error': 'Failed to load, try again later',
    'common.retry': 'Retry', 'common.close': 'Close', 'common.no_match': 'No match, adventurer. Try another word.',
    'theme.toggle': 'Toggle night market theme', 'lang.toggle': '한국어',
    'cat.装备': 'Equip', 'cat.消耗品': 'Use', 'cat.装饰': 'Setup', 'cat.其他': 'Etc', 'cat.商城物品': 'Cash', 'cat.未知': 'Unknown',
    'job.通用': 'All jobs', 'job.新手': 'Beginner', 'job.战士': 'Warrior', 'job.魔法师': 'Magician', 'job.弓箭手': 'Bowman', 'job.飞侠': 'Thief', 'job.海盗': 'Pirate',
    'level.n': 'Lv. {n}', 'level.none': 'No level req.',
    'sale.note': 'Found sold = already sold out when first seen; the time is when it was found, not when it sold. Seen sold out / seen sold = stock went to 0 / dropped between two visits.',
  },
});
// The switch names the next language: 中文 -> English -> 한국어 -> 中文.
addMessages({ ko: { 'lang.toggle': '中文' } });

/** The `Intl` locale of the page language; `en` picks the English variant. */
export const locale = (en = 'en-US') => (lang === 'en' ? en : lang === 'ko' ? 'ko-KR' : 'zh-CN');
/** `?lang=..` for links to server-rendered pages (none for Chinese, the default). */
export const langQuery = (sep = '?') => (lang === 'zh' ? '' : `${sep}lang=${lang}`);
/** The language of a name's secondary line: Chinese under English, English otherwise. */
export const secondaryLanguage = () => (lang === 'en' ? 'zh' : 'en');

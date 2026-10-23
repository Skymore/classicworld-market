// Key-based i18n (plan v1 §8.3). Each page registers its own keys with
// `addMessages` from its own module so parallel work never edits one dictionary.
const dicts = { zh: {}, en: {} };

const stored = () => {
  try { return localStorage.getItem('lang'); } catch { return null; }
};

// `?lang=en` (shared links, screenshot runs) wins over the saved choice and
// is saved, so client-side navigation keeps it.
const fromUrl = new URLSearchParams(location.search).get('lang');
const saved = fromUrl === 'en' || fromUrl === 'zh' ? fromUrl : stored();
export let lang = saved === 'en' || saved === 'zh'
  ? saved
  : ((navigator.language || 'zh').toLowerCase().startsWith('zh') ? 'zh' : 'en');
if (fromUrl === lang) {
  try { localStorage.setItem('lang', lang); } catch { /* private mode */ }
}
document.documentElement.lang = lang === 'zh' ? 'zh-CN' : 'en';

export function setLang(next) {
  lang = next === 'en' ? 'en' : 'zh';
  try { localStorage.setItem('lang', lang); } catch { /* private mode */ }
  document.documentElement.lang = lang === 'zh' ? 'zh-CN' : 'en';
  document.dispatchEvent(new CustomEvent('langchange', { detail: lang }));
}

export function addMessages(messages) {
  for (const l of Object.keys(dicts)) Object.assign(dicts[l], messages[l] || {});
}

// `t('time.minutes_ago', { n: 5 })` with `{n}` placeholders. Missing keys fall
// back to zh, then to the key itself so a gap is visible, never a crash.
export function t(key, params) {
  let s = dicts[lang][key] ?? dicts.zh[key] ?? key;
  if (params) for (const [k, v] of Object.entries(params)) s = s.replaceAll(`{${k}}`, String(v));
  return s;
}

// Item display name for the current language; falls back across languages.
export const itemName = (row) => (lang === 'en' ? row.name_en || row.name_zh : row.name_zh || row.name_en) || String(row.item_id);

addMessages({
  zh: {
    'time.just_now': '刚刚', 'time.minutes_ago': '{n}分钟前', 'time.hours_ago': '{n}小时前', 'time.days_ago': '{n}天前',
    'chg.flat': '持平', 'chg.up_label': '上涨 {pct}%', 'chg.down_label': '下跌 {pct}%',
    'loc.unknown': '位置未知', 'loc.room': '{n}洞',
    'evidence.drop': '看到卖出', 'evidence.sold_out': '看到卖光', 'evidence.found_sold': '发现已售',
    'nav.home': '首页', 'nav.main': '主导航', 'nav.prices': '价格', 'nav.prices_long': '价格表', 'nav.dex': '图鉴', 'nav.mobs': '图鉴', 'nav.maps': '地图',
    'nav.watch': '关注', 'nav.sales': '成交', 'nav.alerts': '捡漏', 'nav.collect': '采集',
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
    'evidence.drop': 'seen sold', 'evidence.sold_out': 'seen sold out', 'evidence.found_sold': 'found sold',
    'nav.home': 'Home', 'nav.main': 'Main', 'nav.prices': 'Prices', 'nav.prices_long': 'Price table', 'nav.dex': 'Dex', 'nav.mobs': 'Catalogue', 'nav.maps': 'Maps',
    'nav.watch': 'Watch', 'nav.sales': 'Sales', 'nav.alerts': 'Deals', 'nav.collect': 'Collect',
    'brand': 'Maple Market', 'search.placeholder': 'Search items, monsters, maps', 'search.label': 'Search',
    'fresh.updated': 'updated{ago}', 'fresh.just_now': 'just updated',
    'common.more': 'More', 'common.loading': 'Loading…', 'common.empty': 'Nothing here yet', 'common.error': 'Failed to load, try again later',
    'common.retry': 'Retry', 'common.close': 'Close', 'common.no_match': 'No match, adventurer. Try another word.',
    'theme.toggle': 'Toggle night market theme', 'lang.toggle': '中文',
    'cat.装备': 'Equip', 'cat.消耗品': 'Use', 'cat.装饰': 'Setup', 'cat.其他': 'Etc', 'cat.商城物品': 'Cash', 'cat.未知': 'Unknown',
    'job.通用': 'All jobs', 'job.新手': 'Beginner', 'job.战士': 'Warrior', 'job.魔法师': 'Magician', 'job.弓箭手': 'Bowman', 'job.飞侠': 'Thief', 'job.海盗': 'Pirate',
    'level.n': 'Lv. {n}', 'level.none': 'No level req.',
    'sale.note': 'Found sold = already sold out when first seen; the time is when it was found, not when it sold. Seen sold out / seen sold = stock went to 0 / dropped between two visits.',
  },
});

// 图鉴 search (/search) filter state. The server normalizes every request
// (server/crates/market-web/src/bestiary/http.rs); the page shows what it
// returns, and links are built from the current URL so quick clicks are not lost.

export const jobs = [
  ['warrior', '战士', 'Warrior'],
  ['magician', '法师', 'Magician'],
  ['bowman', '弓箭手', 'Bowman'],
  ['thief', '飞侠', 'Thief'],
];
// Orbis and El Nath are not open yet (see regions.rs).
export const regions = [
  ['maple', '彩虹岛', 'Maple Island'],
  ['victoria', '金银岛', 'Victoria Island'],
  ['market', '自由市场', 'Free Market'],
  ['special', '活动／特殊地图', 'Events / special maps'],
  ['other', '其他', 'Other'],
];
// The map list's region chips (regions.rs MAP_REGIONS): rest is every map
// off the two islands.
export const mapRegions = [
  ['maple', '彩虹岛', 'Maple Island'],
  ['victoria', '金银岛', 'Victoria Island'],
  ['rest', '其他', 'Other'],
];
export const mobLevelRanges = [[1, 10], [11, 20], [21, 30], [31, 40], [41, 50], [51, 60], [61, 70]];
export const sorts = {
  item: [['', '热门', 'Popular'], ['level', '等级从低到高', 'Level, low to high'], ['level_desc', '等级从高到低', 'Level, high to low'], ['name', '名字', 'Name']],
  mob: [['', '等级从低到高', 'Level, low to high'], ['level_desc', '等级从高到低', 'Level, high to low'], ['name', '名字', 'Name']],
  map: [],
};
const oldJobs = { 1: 'warrior', 2: 'magician', 4: 'bowman', 8: 'thief' };
// URL keys that only equipment has; any of them selects 装备.
const equipmentKeys = ['job', 'type', 'weapon', 'lmin', 'lmax'];

export const searchKind = (page) => String(page?.kind || '').toLowerCase();

// Old names (job=1, min_level) become the current ones, unknown jobs go, and
// equipment filters keep 装备 selected, as the server normalizes them.
function canonical(params) {
  for (const [old, key] of [['min_level', 'lmin'], ['max_level', 'lmax']]) {
    if (params.has(old) && !params.has(key)) params.set(key, params.get(old));
    params.delete(old);
  }
  if (oldJobs[params.get('job')]) params.set('job', oldJobs[params.get('job')]);
  if (params.has('job') && !jobs.some(([key]) => key === params.get('job'))) params.delete('job');
  const kind = params.get('kind') || (params.get('q') ? '' : 'item');
  if (kind === 'item' && (equipmentKeys.some((key) => params.get(key)) || params.get('shared') === '0')) {
    params.set('cat', 'equip');
  }
  if (params.get('cat') !== 'use') params.delete('use');
}

/** `/search?…` from the current query string with `patch` applied; a null,
 * empty or false value removes the key, true writes `1`. */
export function dexHref(search, patch = {}) {
  const params = new URLSearchParams(search);
  params.delete('page');
  canonical(params);
  for (const [key, value] of Object.entries(patch)) {
    if (value == null || value === '' || value === false) params.delete(key);
    else params.set(key, value === true ? '1' : String(value));
  }
  canonical(params);
  return '/search?' + params;
}

/** Keys a category change clears: 装备 keeps the equipment filters. */
export function categoryPatch(cat) {
  const patch = { cat, use: null };
  if (cat !== 'equip') for (const key of [...equipmentKeys, 'shared']) patch[key] = null;
  return patch;
}

const levelText = (lo, hi) => (hi == null ? `${lo ?? 0}+` : `${lo ?? 0}–${hi}`);
const label = (names, en) => (names ? (en ? names.en || names.zh : names.zh || names.en) : '');
const facetName = (list, key, en) => label((list || []).find((row) => String(row.key) === String(key))?.names, en) || String(key);

/** Removable tokens for the filters the server applied: `label` and `value`
 * as shown, and the URL patch that removes the token. */
export function dexTokens(page, en = false) {
  const kind = searchKind(page), tokens = [];
  const add = (key, name, value, patch) => tokens.push({ key, label: name, value, patch });
  const t = (zh, english) => (en ? english : zh);
  const level = (f) => {
    if (f.lmin != null || f.lmax != null) add('level', t('等级', 'Level'), levelText(f.lmin, f.lmax), { lmin: null, lmax: null });
  };
  const place = () => {
    // The map list's region and towns are chips of their own.
    const region = kind === 'map' ? null : [...regions, ...mapRegions].find(([key]) => key === page.region);
    if (region) add('region', t('地区', 'Region'), en ? region[2] : region[1], { region: null, area: null });
    const area = (page.areas || []).find((row) => row.key === page.area && row.region === page.region);
    if (area) add('area', t('区域', 'Area'), label(area.names, en), { area: null });
  };
  if (kind === 'item') {
    const f = page.filters || {}, facets = page.facets || {};
    const job = jobs.find(([key]) => key === f.job);
    if (job) add('job', t('职业', 'Job'), en ? job[2] : job[1], { job: null });
    if (f.shared === false) add('shared', '', t('不含通用装备', 'No all-class gear'), { shared: null });
    if (f.type) add('type', t('类型', 'Type'), facetName(facets.types, f.type, en), { type: null, weapon: null });
    if (f.weapon != null) add('weapon', t('武器', 'Weapon'), facetName(facets.weapons, f.weapon, en), { weapon: null });
    if (f.use) add('use', t('类型', 'Type'), facetName(facets.uses, f.use, en), { use: null });
    level(f);
  } else if (kind === 'mob') {
    const f = page.mob_filters || {};
    level(f);
    place();
    if (f.boss) add('boss', '', t('只看 Boss', 'Bosses only'), { boss: null });
  } else if (kind === 'map') {
    place();
  }
  return tokens;
}

/** One patch that removes every token. */
export function clearAllPatch(tokens) {
  return Object.assign({}, ...tokens.map((token) => token.patch));
}

/** Page numbers to offer: the first, the last and two either side of the
 * current page, with null where numbers are skipped. */
export function pageNumbers(current, last) {
  const out = [];
  for (let n = 1; n <= last; n++) {
    if (n === 1 || n === last || Math.abs(n - current) <= 2) out.push(n);
    else if (out[out.length - 1] !== null) out.push(null);
  }
  return out;
}

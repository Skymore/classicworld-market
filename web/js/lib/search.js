// Match every keyword, in any order, across names and the item ID.
// Keep the aliases aligned with market-web/src/search.rs; both use the
// shared search-cases.json regression cases.
const ALIASES = [
  ['移动速度', '移動速度', '移速', '移动', '移動'],
  ['跳跃力', '跳躍力', '跳跃', '跳躍', '跳力'],
  ['宠物', '寵物'],
  ['装备', '裝備'],
  ['卷轴', '卷軸'],
  ['命中率', '命中'],
  ['回避率', '回避', '闪避', '閃避'],
];
const escapeRegex = text => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const aliases = new Map(ALIASES.flatMap(group => group.map(word => [word, group])));
const aliasPattern = new RegExp([...aliases.keys()].sort((a, b) => b.length - a.length).map(escapeRegex).join('|'), 'g');

export function normalizeSearch(text) {
  return String(text ?? '').replace(/[！-～]/g, char => String.fromCharCode(char.charCodeAt(0) - 0xfee0)).toLowerCase();
}

export function searchPatterns(query) {
  return [...new Set(normalizeSearch(query).trim().split(/\s+/).filter(Boolean))].map(term => {
    let pattern = '', end = 0;
    for (const match of term.matchAll(aliasPattern)) {
      pattern += escapeRegex(term.slice(end, match.index));
      pattern += '(' + aliases.get(match[0]).map(escapeRegex).join('|') + ')';
      end = match.index + match[0].length;
    }
    return pattern + escapeRegex(term.slice(end));
  });
}

export function searchText(item) {
  return [item.name_zh, item.name_en, item.name, item.item_id]
    .map(value => normalizeSearch(value).replace(/\s+/g, '')).join('\x1f');
}

export function compileSearch(query) {
  const patterns = searchPatterns(query).map(pattern => new RegExp(pattern));
  return text => patterns.every(pattern => pattern.test(text));
}

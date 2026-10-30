// Lists organize watches; price, alert and purchase settings stay on each item.
export const LISTS_KEY = 'watch.lists';
export const MAX_LISTS = 20;
const validId = id => Number.isSafeInteger(id) && id >= 1000000 && id <= 5999999;
export function readWatchLists(raw) {
  try {
    const value = typeof raw === 'string' ? JSON.parse(raw) : raw;
    if (!Array.isArray(value)) return [];
    const keys = new Set(), members = new Set();
    return value.slice(0, MAX_LISTS).flatMap(list => {
      if (!list || !/^[a-zA-Z0-9-]{1,64}$/.test(list.id) || ['all','default'].includes(list.id) || keys.has(list.id)) return [];
      const name = typeof list.name === 'string' ? list.name.trim().replace(/[\x00-\x1f\x7f]/g, '').slice(0, 20) : '';
      if (!name) return [];
      keys.add(list.id);
      const items = (Array.isArray(list.items) ? list.items : []).filter(id => {
        if (!validId(id) || members.has(id) || members.size >= 100) return false;
        members.add(id); return true;
      });
      return [{id:list.id, name, items}];
    });
  } catch { return []; }
}
export const listForItem = (lists, id) => lists.find(list => list.items.includes(id))?.id || 'default';
export const listItems = (lists, ids, selected) => selected === 'all' ? ids : ids.filter(id => listForItem(lists,id) === selected);
export function moveToList(lists, id, target) {
  if (!validId(id) || (target !== 'default' && !lists.some(list => list.id === target))) return lists;
  return lists.map(list => ({...list, items:[...list.items.filter(item => item !== id), ...(list.id === target ? [id] : [])]}));
}

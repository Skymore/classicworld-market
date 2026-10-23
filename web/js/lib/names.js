import { itemName, lang } from './i18n.js';
import { esc } from './format.js';

// Names stay bilingual regardless of the interface language. Missing or
// identical translations occupy no extra line; attributes use itemName().
export function itemNames(row) {
  const normalized = { ...row, name_zh: row.name_zh || row.name };
  const primary = itemName(normalized);
  const secondary = lang === 'en' ? normalized.name_zh : normalized.name_en;
  return `<span class="name-stack"><span class="name-primary">${esc(primary)}</span>${secondary && String(secondary).trim() !== String(primary).trim() ? ` <small class="name-secondary">${esc(secondary)}</small>` : ''}</span>`;
}

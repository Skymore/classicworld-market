import { lang } from './i18n.js';

export function priceUnit(row) {
  const isSet = row.unit_basis === 'set';
  return isSet ? `<small class="unit">${lang === 'en' ? '/set' : '/组'}</small>` : '';
}

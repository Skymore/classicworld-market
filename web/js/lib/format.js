// Shared formatting. Ported from design/mockups-v2/mock.html so pages render
// numbers and times exactly like the approved mockups.
import { t, lang } from './i18n.js';

export const esc = (s) =>
  String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

const oneDecimal = (x) => (Math.round(x * 10) / 10).toFixed(1).replace(/\.0$/, '');

// Mesos in K / M for both languages (plan v2 decision 4).
export function meso(v) {
  if (v == null) return '—';
  const a = Math.abs(v);
  if (a >= 1e6) return oneDecimal(v / 1e6) + 'M';
  if (a >= 1e3) return oneDecimal(v / 1e3) + 'K';
  return Number.isInteger(v) ? String(v) : oneDecimal(v);
}

// Relative ages use the real wall clock; a dataset timestamp is never 'now'.
export function ago(t0, now = Date.now() / 1000) {
  const s = Math.max(0, now - t0);
  if (s < 60) return t('time.just_now');
  if (s < 3600) return t('time.minutes_ago', { n: Math.floor(s / 60) });
  if (s < 86400) return t('time.hours_ago', { n: Math.floor(s / 3600) });
  return t('time.days_ago', { n: Math.floor(s / 86400) });
}

export function fullTime(t0) {
  return t0 == null || !Number.isFinite(Number(t0)) ? '—' : new Date(t0 * 1000).toLocaleString(undefined, { timeZoneName: 'short' });
}

// 24h change: coloured arrow + number, no background (approved mockup).
export function chg(v) {
  if (v == null) return '<span class="chg flat">—</span>';
  if (Math.abs(v) < 0.5) return `<span class="chg flat">${t('chg.flat')}</span>`;
  const up = v > 0;
  // Three-digit moves drop the decimal so the 60 px column still fits.
  const pct = Math.abs(v) >= 100 ? Math.round(Math.abs(v)).toString() : Math.abs(v).toFixed(1);
  return `<span class="chg ${up ? 'up' : 'down'}" aria-label="${t(up ? 'chg.up_label' : 'chg.down_label', { pct })}">${up ? '▲' : '▼'} ${pct}%</span>`;
}

export function loc(ch, room, context = null) {
  if(ch == null && room != null) return `<span class="loc unk">${esc(t('loc.room', { n: Number(room) }))}</span>`;
  if(ch == null && context?.text) return `<span class="loc unk">${esc(context.text)}</span>`;
  if (ch == null) return `<span class="loc unk">${t('loc.unknown')}</span>`;
  if(room == null) {
    const name=context?.[lang==='en'?'map_name_en':'map_name_zh'] || context?.map_name_en || context?.map_name_zh;
    const label=name || (context?.map_id != null ? `${lang==='en'?'Map':'地图'} ${context.map_id}` : (lang==='en'?'Room not recorded':'洞号未记录'));
    return `<span class="loc" title="${esc(label)}"><b>${lang === 'en' ? `CH ${Number(ch)}` : `${Number(ch)}频道`}</b><span>${esc(label)}</span></span>`;
  }
  return `<span class="loc"><b>${esc(lang === 'en' ? `CH ${ch}` : `${ch}频道`)}</b><span>${t('loc.room', { n: room })}</span></span>`;
}

export const mobImg = (id, pose) => `https://maplestory.io/api/GMS/83/mob/${id}/render/${pose || 'stand'}`;

// Counts with thousands separators, the same in both languages ("1,001").
export const num = (n) => (n == null ? '—' : Number(n).toLocaleString('en-US'));
// Large counts as K / M ("12.3K"); below 10,000 they keep every digit.
export function compact(n) {
  if (n == null) return '—';
  const v = Number(n), a = Math.abs(v);
  // 999,960 rounds to 1000K, so switch to M at that point.
  if (a >= 999950) return oneDecimal(v / 1e6) + 'M';
  if (a >= 1e4) return oneDecimal(v / 1e3) + 'K';
  return num(v);
}

export const slot = (url, size = 28) =>
  `<span class="slot" style="--s:${size}px"><img src="${esc(url)}" alt="" width="${size}" height="${size}" loading="lazy"></span>`;

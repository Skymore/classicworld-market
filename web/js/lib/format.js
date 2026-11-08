// Shared formatting. Ported from design/mockups-v2/mock.html so pages render
// numbers and times exactly like the approved mockups.
import { t, lang } from './i18n.js';

export const esc = (s) =>
  String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

const oneDecimal = (x) => (Math.round(x * 10) / 10).toFixed(1).replace(/\.0$/, '');

// Large numbers: Chinese pages use 万 / 亿 unless the visitor chose K / M under
// 我的 → 偏好设置 (Korean: 만 / 억); English pages always use K / M. `setUnits` is called by the
// app with the saved choice ('wan' | 'km' | null for the language default).
let unitChoice = null;
export function setUnits(value) {
  const next = value === 'wan' || value === 'km' ? value : null;
  if (next === unitChoice) return;
  unitChoice = next;
  if (typeof document !== 'undefined') document.dispatchEvent(new CustomEvent('unitschange'));
}
// Korean counts in 만 / 억 like Chinese does in 万 / 亿.
export const usesWan = () => lang !== 'en' && unitChoice !== 'km';
export const unitChoiceNow = () => unitChoice;
// Up to 1,000 of a unit keeps one decimal (44.4万); more drops it (1235万).
const scaled = (x) => (Math.abs(x) >= 1000 ? String(Math.round(x)) : oneDecimal(x));
// The unit a large number takes, or null when it is shown in full.
function large(v, km) {
  const a = Math.abs(v);
  if (!usesWan()) {
    // 999,950 would round to 1000K, so it already takes M.
    if (a >= 999950) return scaled(v / 1e6) + 'M';
    return a >= km ? oneDecimal(v / 1e3) + 'K' : null;
  }
  // 99,995,000 would round to 10000万, so it already takes 亿.
  const [myriad, hundredMillion] = lang === 'ko' ? ['만', '억'] : ['万', '亿'];
  if (a >= 99995000) return scaled(v / 1e8) + hundredMillion;
  return a >= 1e4 ? scaled(v / 1e4) + myriad : null;
}

// Mesos: 1.5K / 44.4万 above a thousand (K / M) or ten thousand (万 / 亿).
export function meso(v) {
  if (v == null) return '—';
  return large(v, 1e3) ?? (Number.isInteger(v) ? String(v) : oneDecimal(v));
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
    return `<span class="loc" title="${esc(label)}"><b>${lang === 'en' ? `CH ${Number(ch)}` : lang === 'ko' ? `${Number(ch)}채널` : `${Number(ch)}频道`}</b><span>${esc(label)}</span></span>`;
  }
  return `<span class="loc"><b>${esc(lang === 'en' ? `CH ${ch}` : lang === 'ko' ? `${ch}채널` : `${ch}频道`)}</b><span>${t('loc.room', { n: room })}</span></span>`;
}

export const mobImg = (id, pose) => `https://maplestory.io/api/GMS/83/mob/${id}/render/${pose || 'stand'}`;

// Counts with thousands separators, the same in both languages ("1,001").
export const num = (n) => (n == null ? '—' : Number(n).toLocaleString('en-US'));
// Large counts ("1.8万" / "18.3K"); below 10,000 they keep every digit.
export function compact(n) {
  if (n == null) return '—';
  const v = Number(n);
  return large(v, 1e4) ?? num(v);
}

export const slot = (url, size = 28) =>
  `<span class="slot" style="--s:${size}px"><img src="${esc(url)}" alt="" width="${size}" height="${size}" loading="lazy"></span>`;

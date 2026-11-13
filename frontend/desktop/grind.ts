// Grind tracker data from grind_desktop.GrindService (window.pywebview.api.grind)
// and its overlay (window.pywebview.api.state). Shapes follow grind_tracker.summarize.
import { language, tr } from './i18n';

export interface LootRow {
  t: number; kind: string; item_id: number; name: string | null; quantity: number;
  priced?: boolean; unit: number; basis: string | null; value: number; stats?: { key: string; value: number }[] | null; notable: boolean;
}
export interface Consumable { item_id: number; name: string | null; used: number; cost?: number; acquired?: number; remaining: number | null; per_hour: number | null; minutes_left: number | null }
/** A valuable item that just fell for this character or its party (grind_tracker.ground_drop). */
export interface GroundDrop { t: number; object: number; item_id: number; name: string | null; value: number | null }
export interface Buff { source: number; name: string | null; seconds: number; total: number; item_id: number | null; pinned?: boolean; proc?: boolean; on?: number | null }
export interface CombatRow {
  dps_5m?: number | null; kills_5m?: number; exp_received_5m?: number | null; kill_exp_5m?: number | null; exp_contribution_5m?: number | null; exp_yield_5m?: number | null;
  character_id: number; name: string | null; self: boolean; away: boolean; partial: boolean;
  kill_exp?: number | null; exp_received?: number | null; exp_contribution?: number | null; exp_yield?: number | null;
  damage: number | null; dps: number | null; average_dps: number | null; kills: number; hits: number;
}
export interface Segment { map_id: number; level: number | null; job: number | null; started_at: number; active_seconds: number; exp: number; kills: number; mesos: number }
export interface RunSummary {
  id: string; status: 'active' | 'paused' | 'ended'; pause_reason: string | null; in_combat?: boolean; channel_change?: string[];
  vitals?: { hp: number; max_hp: number; mp: number | null; max_mp: number | null; danger: number } | null;
  character: { key: unknown; name: string | null; level: number | null; job: number | null };
  job_name: string | null; level: number | null; level_start: number | null; exp_now: number | null; exp_percent: number | null;
  map_id: number | null; map_name?: string | null; started_at: number; ended_at: number | null;
  active_seconds: number; idle_seconds: number;
  exp: number; exp_per_hour: number | null; exp_per_hour_5m: number | null; exp_per_hour_1m: number | null;
  percent_per_hour: number | null; eta_seconds: number | null;
  kills: number; kills_per_hour: number | null; kills_estimated: boolean; deaths: number; exp_lost: number; gaps: number;
  mesos: number; item_value: number; consume_cost: number; mesos_spent: number; net: number;
  net_per_hour: number | null; net_per_hour_1m?: number | null; rate_history?: { t: number; exp: number; net: number }[]; cash_per_hour: number | null; pending_prices: number;
  loot?: LootRow[]; recent?: LootRow[]; consumables: Consumable[]; drops: { item_id: number; name: string | null; quantity: number }[];
  mobs: { mob_id: number; kills: number; name: string; attack_samples?: number; attack_distribution?: { attacks: number; kills: number }[] }[]; segments: Segment[];
  buffs: Buff[]; hp_lost: number; hp_drops: number;
  timeline?: { start: number; bucket: number; last?: number; first?: number; step?: number; window?: number; exp: number[]; net: number[] };
  share_url?: string | null;
  attack_count: number; attacks: { skill: number; name: string; count: number; follow_up?: boolean }[]; casts: { skill: number; name: string; count: number }[];
  damage?: number | null; dps?: number | null; average_dps?: number | null;
  combat?: CombatRow[]; party_known?: boolean | null;
}
export interface Live {
  alive_at: number; stale: boolean; runs: RunSummary[]; finished: RunSummary[]; recording: boolean;
  calibration: { label: string; state: string }[];
  characters: { name: string | null; level: number | null; job: number | null; map_id: number | null; buffs: Buff[]; drops?: GroundDrop[] }[];
  protocol_warning?: boolean;
}
export interface OverlaySettings {
  enabled: boolean; layout: 'slim' | 'compact' | 'standard' | 'detailed' | 'rail' | 'big'; theme: 'dark' | 'market' | 'cute' | 'maple'; opacity: number; scale: number;
  hide_in_capture: boolean; stream?: boolean; x: number | null; y: number | null; fields: string[];
}
export interface GrindSettings {
  enabled: boolean; record_frames: boolean; upload: boolean; idle_seconds: number; end_after_seconds: number;
  start_events: number; start_window: number; price_basis: 'typical' | 'npc' | 'none'; notable_value: number;
  count_mesos_spent: boolean; min_upload_seconds: number; overlay: OverlaySettings;
  buff_warn_seconds: number; buff_sound: boolean; auto_buff: boolean; auto_potion: boolean; hotkeys: Record<HotkeyAction, string>;
}
export type HotkeyAction = 'overlay' | 'pause' | 'end';
export interface GrindState {
  live: Live | null; settings: GrindSettings; calibrating: boolean;
  calibration: { at: number; files: number; bytes: number; summary: { label: string; state: string }[] } | null;
  hotkey_errors?: Partial<Record<HotkeyAction, 'invalid' | 'taken'>>;
}

type Api = { grind?(name: string, value?: unknown): Promise<any>; state?(): Promise<any>; scale?(value: number): Promise<number>; fit?(height: number): Promise<unknown>; toggle?(name: string): Promise<boolean> };
const api = () => ((window as { pywebview?: { api?: Api } }).pywebview?.api ?? null) as Api | null;
export const grind = (name: string, value?: unknown) => {
  const bridge = api();
  if (!bridge?.grind) return Promise.reject(new Error('unavailable'));
  return bridge.grind(name, value);
};
export const overlayState = () => {
  const bridge = api();
  if (!bridge?.state) return Promise.reject(new Error('unavailable'));
  return bridge.state() as Promise<{ live: Live | null; settings: GrindSettings; language?: 'zh' | 'en' | 'ko' | 'system' }>;
};
/** The overlay's corner grip: the size the user dragged to. */
export const overlayScale = (value: number) => api()?.scale?.(value) ?? Promise.reject(new Error('unavailable'));
/** The card's height in CSS pixels; the overlay window takes it. */
export const overlayFit = (height: number) => api()?.fit?.(height) ?? Promise.reject(new Error('unavailable'));
/** The overlay's own switches; resolves to the new value. */
export const overlayToggle = (name: 'buff_sound') => api()?.toggle?.(name) ?? Promise.reject(new Error('unavailable'));

/** 1.2万 / 3.4亿 in Chinese and Korean, 12K / 3.4M / 1.2B in English. */
export function big(value: number | null | undefined) {
  if (value == null || !Number.isFinite(value)) return '—';
  const sign = value < 0 ? '-' : '', n = Math.abs(value);
  const one = (x: number) => (x >= 100 ? String(Math.round(x)) : (Math.round(x * 10) / 10).toFixed(1).replace(/\.0$/, ''));
  if (language() === 'en') {
    if (n >= 1e9) return sign + one(n / 1e9) + 'B';
    if (n >= 1e6) return sign + one(n / 1e6) + 'M';
    if (n >= 1e4) return sign + one(n / 1e3) + 'K';
    return sign + Math.round(n).toLocaleString('en-US');
  }
  if (n >= 1e8) return sign + one(n / 1e8) + tr('亿', '億');
  if (n >= 1e4) return sign + one(n / 1e4) + tr('万', '만');
  return sign + (language() === 'zh' ? String(Math.round(n)) : Math.round(n).toLocaleString('en-US'));
}

/** "1:02:03" or "12:03". */
export function clock(seconds: number | null | undefined) {
  if (seconds == null || !Number.isFinite(seconds)) return '—';
  const s = Math.max(0, Math.round(seconds)), h = Math.floor(s / 3600);
  return `${h ? `${h}:` : ''}${String(Math.floor(s / 60) % 60).padStart(h ? 2 : 1, '0')}:${String(s % 60).padStart(2, '0')}`;
}

/** "2小时41分" / "2h 41m" for ETAs. */
export function duration(seconds: number | null | undefined) {
  if (seconds == null || !Number.isFinite(seconds) || seconds < 0) return '—';
  const m = Math.round(seconds / 60), h = Math.floor(m / 60);
  if (h >= 100) return tr('很久', 'a long time');
  return h ? tr(`${h}小时${m % 60}分`, `${h}h ${m % 60}m`) : tr(`${m}分钟`, `${m}m`);
}

export const percent = (value: number | null | undefined, digits = 2) =>
  value == null || !Number.isFinite(value) ? '—' : `${value.toFixed(digits)}%`;

export const STAT_LABELS: Record<string, [string, string]> = {
  str: ['力量', 'STR'], dex: ['敏捷', 'DEX'], int: ['智力', 'INT'], luk: ['运气', 'LUK'], hp: ['HP', 'HP'], mp: ['MP', 'MP'],
  weapon_attack: ['攻击', 'ATT'], magic_attack: ['魔攻', 'M.ATT'], accuracy: ['命中', 'ACC'], avoid: ['回避', 'AVOID'],
  speed: ['速度', 'Speed'], jump: ['跳跃', 'Jump'], critical_rate: ['暴击率', 'Crit'], critical_damage: ['暴伤', 'Crit dmg'],
};
/** "攻+3 敏+2": a dropped piece's non-defence attributes. */
export function statLine(stats: { key: string; value: number }[] | null | undefined) {
  return (stats || []).filter(s => STAT_LABELS[s.key]).map(s => `${tr(...STAT_LABELS[s.key])}+${s.value}`).join(' ');
}

/** Why a channel change would help, from the client (grind_tracker.channel_change). */
const CHANNEL_REASONS: Record<string, [string, string]> = {
  capture: ['游戏数据中断，记录已暂停', 'game data lost, recording paused'],
  keys: ['读不到键位，自动加 Buff 和喝药已暂停', 'no key table, auto buff and potions are off'],
  identity: ['击杀暂按经验估算', 'kills estimated from EXP'],
  attacks: ['看不到攻击数据，DPS 和技能统计缺失', 'no attack data, DPS and skills missing'],
};
/** "请换一次频道：…" when a channel change would fix something, else null. */
export function channelPrompt(run: { channel_change?: string[] } | null | undefined) {
  const reasons = (run?.channel_change || []).map(code => CHANNEL_REASONS[code]).filter(Boolean);
  if (!reasons.length) return null;
  return tr('请换一次频道：', 'Change channel once: ') + reasons.map(r => tr(r[0], r[1])).join(tr('；', '; '));
}
export const PAUSE_LABELS: Record<string, [string, string]> = {
  map: ['离开地图', 'Left the map'], manual: ['手动暂停', 'Paused by you'], idle: ['空闲', 'Idle'], disconnect: ['连接中断', 'Disconnected'], end: ['已结束', 'Ended'],
};
export function statusLabel(run: RunSummary) {
  if (run.status === 'active') return tr('记录中', 'Recording');
  if (run.status === 'ended') return tr('已结束', 'Ended');
  return tr(...(PAUSE_LABELS[run.pause_reason || ''] || ['已暂停', 'Paused']));
}
export const mapLabel = (run: { map_name?: string | null; map_id: number | null }) =>
  run.map_name || (run.map_id != null ? tr(`地图 ${run.map_id}`, `Map ${run.map_id}`) : '—');

/** Buffs of the open run, else of the first character (buffs also run in town). */
export function currentBuffs(live: Live | null): Buff[] {
  const run = live?.runs?.[0];
  return (run?.buffs?.length ? run.buffs : live?.characters?.[0]?.buffs) || [];
}
/** Live buffs, plus pinned ones that ran out (shown greyed until recast). */
export const shownBuffs = (live: Live | null) =>
  currentBuffs(live).map(b => ({ ...b, left: buffLeft(b, live) })).filter(b => b.left > 0 || b.pinned);
/** Seconds left now: the state is written each second, so count down locally in between. */
export const buffLeft = (buff: Buff, live: Live | null) =>
  Math.max(0, buff.seconds - (live ? Date.now() / 1000 - live.alive_at : 0));

/** Points of a run's timeline as hourly rates. Rolling (step and window): each point is
 * the minute before it, every 10 s or so. Older runs: whole-minute buckets. */
export function timelineRates(line: { start: number; bucket: number; last?: number; first?: number; step?: number; window?: number; exp: number[]; net: number[] }) {
  if (line.window && line.step) {
    const first = line.first ?? line.start + line.window, window = line.window;
    return line.exp.map((exp, i) => ({ t: Math.min(first + i * line.step!, first + (line.exp.length - 1) * line.step!), exp: exp * 3600 / window, net: (line.net[i] || 0) * 3600 / window }));
  }
  return line.exp.map((exp, i) => {
    const span = i === line.exp.length - 1 && line.last ? line.last : line.bucket;
    return { t: line.start + (i + .5) * line.bucket, exp: exp * 3600 / span, net: (line.net[i] || 0) * 3600 / span };
  });
}

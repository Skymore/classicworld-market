// Grind tracker data from grind_desktop.GrindService (window.pywebview.api.grind)
// and its overlay (window.pywebview.api.state). Shapes follow grind_tracker.summarize.
import { language, tr } from './i18n';

export interface LootRow {
  t: number; kind: string; item_id: number; name: string | null; quantity: number;
  unit: number; basis: string | null; value: number; stats?: { key: string; value: number }[] | null; notable: boolean;
}
export interface Consumable { item_id: number; name: string | null; used: number; remaining: number | null; per_hour: number | null; minutes_left: number | null }
export interface Buff { source: number; name: string | null; seconds: number; total: number; item_id: number | null }
export interface CombatRow {
  character_id: number; name: string | null; self: boolean; away: boolean; partial: boolean;
  damage: number | null; dps: number | null; average_dps: number | null; kills: number; hits: number;
}
export interface Segment { map_id: number; level: number | null; job: number | null; started_at: number; active_seconds: number; exp: number; kills: number; mesos: number }
export interface RunSummary {
  id: string; status: 'active' | 'paused' | 'ended'; pause_reason: string | null;
  character: { key: unknown; name: string | null; level: number | null; job: number | null };
  job_name: string | null; level: number | null; level_start: number | null; exp_now: number | null; exp_percent: number | null;
  map_id: number | null; map_name?: string | null; started_at: number; ended_at: number | null;
  active_seconds: number; idle_seconds: number;
  exp: number; exp_per_hour: number | null; exp_per_hour_5m: number | null; exp_per_hour_1m: number | null;
  percent_per_hour: number | null; eta_seconds: number | null;
  kills: number; kills_per_hour: number | null; kills_estimated: boolean; deaths: number; exp_lost: number; gaps: number;
  mesos: number; item_value: number; consume_cost: number; mesos_spent: number; net: number;
  net_per_hour: number | null; cash_per_hour: number | null; pending_prices: number;
  recent?: LootRow[]; consumables: Consumable[]; drops: { item_id: number; name: string | null; quantity: number }[];
  mobs: { mob_id: number; kills: number; name: string }[]; segments: Segment[];
  buffs: Buff[]; hp_lost: number; hp_drops: number;
  attack_count: number; attacks: { skill: number; name: string; count: number }[]; casts: { skill: number; name: string; count: number }[];
  damage?: number | null; dps?: number | null; average_dps?: number | null;
  combat?: CombatRow[]; party_known?: boolean | null;
}
export interface Live {
  alive_at: number; stale: boolean; runs: RunSummary[]; finished: RunSummary[]; recording: boolean;
  calibration: { label: string; state: string }[];
  characters: { name: string | null; level: number | null; job: number | null; map_id: number | null; buffs: Buff[] }[];
  protocol_warning?: boolean;
}
export interface OverlaySettings {
  enabled: boolean; layout: 'compact' | 'standard' | 'detailed' | 'rail' | 'big'; theme: 'dark' | 'market' | 'cute' | 'maple'; opacity: number; scale: number;
  click_through: boolean; hide_in_capture: boolean; x: number | null; y: number | null; fields: string[];
}
export interface GrindSettings {
  enabled: boolean; record_frames: boolean; upload: boolean; idle_seconds: number; end_after_seconds: number;
  start_events: number; start_window: number; price_basis: 'typical' | 'npc' | 'none'; notable_value: number;
  count_mesos_spent: boolean; min_upload_seconds: number; overlay: OverlaySettings;
  buff_warn_seconds: number; buff_sound: boolean; hotkeys: Record<HotkeyAction, string>;
}
export type HotkeyAction = 'overlay' | 'pause' | 'end' | 'edit';
export interface GrindState {
  live: Live | null; settings: GrindSettings; editing: boolean; calibrating: boolean;
  calibration: { at: number; files: number; bytes: number; summary: { label: string; state: string }[] } | null;
  hotkey_errors?: Partial<Record<HotkeyAction, 'invalid' | 'taken'>>;
}

type Api = { grind?(name: string, value?: unknown): Promise<any>; state?(): Promise<any> };
const api = () => (window.pywebview?.api ?? null) as Api | null;
export const grind = (name: string, value?: unknown) => {
  const bridge = api();
  if (!bridge?.grind) return Promise.reject(new Error('unavailable'));
  return bridge.grind(name, value);
};
export const overlayState = () => {
  const bridge = api();
  if (!bridge?.state) return Promise.reject(new Error('unavailable'));
  return bridge.state() as Promise<{ live: Live | null; settings: GrindSettings; editing: boolean; language?: 'zh' | 'en' | 'ko' | 'system' }>;
};

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
  return sign + Math.round(n).toLocaleString('en-US');
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
/** Seconds left now: the state is written each second, so count down locally in between. */
export const buffLeft = (buff: Buff, live: Live | null) =>
  Math.max(0, buff.seconds - (live ? Date.now() / 1000 - live.alive_at : 0));

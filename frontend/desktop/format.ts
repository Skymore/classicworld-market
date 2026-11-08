// Short time and number texts for the collector window.
import { tr } from './i18n';
// @ts-expect-error The website's plain JS module has no declaration file.
import { reminderTokens as tokens } from '../../web/js/lib/watch-reminders.js';

/** Condition chips of one watch group, the same words as the website. */
export const reminderTokens: (value: unknown, en?: boolean) => { key: string; label: string }[] = tokens;

/** Milliseconds for epoch seconds, epoch milliseconds or an ISO string; null when unknown. */
export function toMs(at: string | number | null | undefined) {
  if (at == null || at === '') return null;
  const ms = typeof at === 'number' ? (at > 1e12 ? at : at * 1000) : Date.parse(at);
  return Number.isFinite(ms) ? ms : null;
}

/** "5 秒前", "3 分钟前", "2 小时前", "4 天前" (or English / Korean). */
export function ago(at: string | number | null | undefined, now = Date.now()) {
  const ms = toMs(at);
  if (ms == null) return '';
  const secs = Math.max(0, Math.floor((now - ms) / 1000));
  if (secs < 60) return tr(`${secs} 秒前`, `${secs}s ago`);
  if (secs < 3600) return tr(`${Math.floor(secs / 60)} 分钟前`, `${Math.floor(secs / 60)}m ago`);
  if (secs < 86400) return tr(`${Math.floor(secs / 3600)} 小时前`, `${Math.floor(secs / 3600)}h ago`);
  return tr(`${Math.floor(secs / 86400)} 天前`, `${Math.floor(secs / 86400)}d ago`);
}

/** "M/D" of a date. */
export function monthDay(at: string | number | null | undefined) {
  const ms = toMs(at);
  if (ms == null) return '';
  const date = new Date(ms);
  return `${date.getMonth() + 1}/${date.getDate()}`;
}

/** The item icon on DVG's CDN, as the server's `bestiary::catalog::icon_url`. */
export const itemIcon = (id: number) => `https://mxdgcw.dvg.cn/dbsource/icon/item/${id}.png`;

/** Whole mesos with thousands separators, or "—". */
export const full = (value: number | null | undefined) => value == null || !Number.isFinite(value) ? '—' : value.toLocaleString('en-US');

export const UPDATE_LABELS: Record<string, [string, string]> = {
  waiting_for_game_exit: ['新版本已就绪，退出游戏后更新', 'Update ready; installs after the game closes'],
  ready_to_update: ['新版本已就绪', 'Update ready'], restarting: ['正在更新', 'Updating'], retry_later: ['稍后重试更新', 'Update will retry later'],
};
export const updateLabel = (state: string) => tr(...(UPDATE_LABELS[state] || ['自动更新已开启', 'Automatic updates on']));

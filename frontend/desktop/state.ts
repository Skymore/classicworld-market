// The scanner state pushed by scanner_desktop.DesktopController, and the pywebview bridge.
import { tr, type LangChoice } from './i18n';
export type Theme = 'light' | 'dark' | 'system';
export interface Activity { at: number; text: string; kind: string }
export interface State {
  remote_debug?: { active: boolean; message: string; session: string; expires_at: number; command: string };
  diagnostics?: { message: string; report_id: string };
  version: string; phase: string; mode: string; message: string; room: number | null;
  channel: number | null; visited: number; uploaded: number; started_at: number | null; stopped_at: number | null;
  run_shops: number; run_items: number; run_started_at: number | null;
  capture: string; upload: string; last_shop_at: number | null; updates: string;
  selected: number | null; windows: { id: number; title: string; pid: number }[];
  theme: Theme; activities: Activity[]; maximized?: boolean;
  /** 'system' follows the Windows display language. */
  language?: LangChoice;
  desired?: boolean; last_progress_at?: number | null; retries?: number; next_retry_at?: number | null; pending_uploads?: number;
  /** Staged release tag such as "v0.6.57", and whether the player clicked Update. */
  update_version?: string | null; update_requested?: boolean;
  /** One short capture caveat from passive_status.json, e.g. "加速器连接不可用". */
  capture_warning?: string | null;
}
declare global {
  interface Window {
    pywebview?: { api: { ready(): Promise<State>; command(name: string, value?: unknown): Promise<State>; workspace(name: string, value?: unknown): Promise<any>;
      grind?(name: string, value?: unknown): Promise<any>; state?(): Promise<any> } };
  }
}
export const initial: State = {
  version: '', phase: 'idle', mode: 'scan', message: '正在连接客户端…', room: null, channel: null, visited: 0, uploaded: 0,
  started_at: null, stopped_at: null, run_shops: 0, run_items: 0, run_started_at: null, capture: 'connecting', upload: 'ready',
  last_shop_at: null, updates: 'checking', selected: null, windows: [], theme: 'system', activities: [],
};
const PHASE_TEXT: Record<string, [string, string]> = {
  idle: ['准备就绪', 'Ready'], scanning: ['扫描中', 'Scanning'], paused: ['已暂停', 'Paused'], stopping: ['正在停止', 'Stopping'],
  stopped: ['已停止', 'Stopped'], error: ['需要处理', 'Needs attention'], waiting_task: ['等待任务', 'Waiting for a task'],
  recovering_network: ['网络恢复中', 'Reconnecting'], waiting_game: ['等待游戏', 'Waiting for the game'],
  rebuilding: ['重建任务', 'Rebuilding the task'], needs_attention: ['需要人工处理', 'Needs your attention'],
};
const HEALTH_TEXT: Record<string, [string, string]> = {
  connecting: ['正在连接', 'Connecting'], connected: ['游戏已连接', 'Game connected'], capturing: ['正在采集', 'Collecting'],
  waiting: ['等待游戏连接', 'Waiting for the game'], handshake: ['请切一次频道', 'Change channel once'],
  no_game: ['等待打开游戏', 'Waiting for the game to open'], no_inbound: ['等待游戏数据', 'Waiting for game data'],
  offline: ['尚未连接', 'Not connected'], parse_error: ['连接需要刷新', 'Connection needs a refresh'],
};
/** The phase's label in the window's language, or undefined. */
export const phaseLabel = (phase: string) => (PHASE_TEXT[phase] ? tr(...PHASE_TEXT[phase]) : undefined);
export const ACTIVE_PHASES = ['scanning', 'paused', 'stopping', 'waiting_task', 'recovering_network', 'waiting_game', 'rebuilding'];
export const RECOVERY_PHASES = ['waiting_task', 'recovering_network', 'waiting_game', 'rebuilding', 'needs_attention'];
export const isLive = (state: State) => ['connected', 'capturing'].includes(state.capture);
export const healthLabel = (state: State) => tr(...(HEALTH_TEXT[state.capture] || HEALTH_TEXT.waiting));

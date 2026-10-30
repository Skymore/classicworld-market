// The scanner state pushed by scanner_desktop.DesktopController, and the pywebview bridge.
export type Theme = 'light' | 'dark' | 'system';
export interface Activity { at: number; text: string; kind: string }
export interface State {
  version: string; phase: string; mode: string; message: string; room: number | null;
  channel: number | null; visited: number; uploaded: number; started_at: number | null; stopped_at: number | null;
  run_shops: number; run_items: number; run_started_at: number | null;
  capture: string; upload: string; last_shop_at: number | null; updates: string;
  selected: number | null; windows: { id: number; title: string; pid: number }[];
  theme: Theme; activities: Activity[]; maximized?: boolean;
  desired?: boolean; last_progress_at?: number | null; retries?: number; next_retry_at?: number | null; pending_uploads?: number;
}
declare global {
  interface Window {
    pywebview?: { api: { ready(): Promise<State>; command(name: string, value?: unknown): Promise<State>; workspace(name: string, value?: unknown): Promise<any> } };
  }
}
export const initial: State = {
  version: '', phase: 'idle', mode: 'scan', message: '正在连接采集器…', room: null, channel: null, visited: 0, uploaded: 0,
  started_at: null, stopped_at: null, run_shops: 0, run_items: 0, run_started_at: null, capture: 'connecting', upload: 'ready',
  last_shop_at: null, updates: 'checking', selected: null, windows: [], theme: 'system', activities: [],
};
export const PHASES: Record<string, string> = {
  idle: '准备就绪', scanning: '扫描中', paused: '已暂停', stopping: '正在停止', stopped: '已停止', error: '需要处理',
  waiting_task: '等待任务', recovering_network: '网络恢复中', waiting_game: '等待游戏', rebuilding: '重建任务', needs_attention: '需要人工处理',
};
export const HEALTH: Record<string, string> = {
  connecting: '正在连接', connected: '游戏已连接', capturing: '正在采集', waiting: '等待游戏连接', handshake: '请切一次频道',
  no_game: '等待打开游戏', no_inbound: '等待游戏数据', offline: '尚未连接', parse_error: '连接需要刷新',
};
export const ACTIVE_PHASES = ['scanning', 'paused', 'stopping', 'waiting_task', 'recovering_network', 'waiting_game', 'rebuilding'];
export const RECOVERY_PHASES = ['waiting_task', 'recovering_network', 'waiting_game', 'rebuilding', 'needs_attention'];
export const isLive = (state: State) => ['connected', 'capturing'].includes(state.capture);
export const healthLabel = (state: State) => HEALTH[state.capture] || '等待游戏连接';

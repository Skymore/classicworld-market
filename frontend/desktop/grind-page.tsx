import { HistoryView } from './grind-history';
import { useCallback, useEffect, useState } from 'react';
import { AlertCircle, Crosshair, Pause, Play, Square } from 'lucide-react';
import { BuffStrip, LiveView } from './grind-live';
import { tr, type Lang } from './i18n';
import SitePage from './site-page';
import { SettingsView, type SettingsChanges } from './grind-settings';
import {
  channelPrompt, grind, statusLabel,
  type GrindSettings, type GrindState, type HotkeyAction, type Live, type RunSummary,
} from './grind';

/** The 积分 rule while 绩效模式 is on. */
export const pointsRule = (settings?: GrindSettings | null) => settings?.performance?.enabled ? settings.performance : undefined;

/** board and all are the site's pages (地图效率榜, 全部用户), as on the site's 刷图. */
type View = 'live' | 'history' | 'board' | 'all' | 'settings';
const POLL_MS = 1000;

export default function GrindPage({ hidden, theme, lang }: { hidden: boolean; theme: 'light' | 'dark'; lang: Lang }) {
  const [view, setView] = useState<View>('live');
  const [state, setState] = useState<GrindState | null>(null), [error, setError] = useState('');
  const [history, setHistory] = useState<RunSummary[] | null>(null);
  const load = useCallback(async () => {
    try { setState(await grind('state')); setError(''); }
    catch (e) { setError(String((e as Error)?.message || e)); }
  }, []);
  useEffect(() => {
    if (hidden) return;
    load();
    const id = setInterval(load, POLL_MS);
    window.addEventListener('pywebviewready', load);
    return () => { clearInterval(id); window.removeEventListener('pywebviewready', load); };
  }, [hidden, load]);
  const loadHistory = useCallback(() => { grind('history').then(setHistory).catch(() => setHistory([])); }, []);
  useEffect(() => {
    if (hidden || view !== 'history') return;
    loadHistory();
  }, [hidden, view, loadHistory]);
  const save = async (changes: SettingsChanges) => {
    try { const settings = await grind('settings', changes); setState(s => s && { ...s, settings }); }
    catch (e) { setError(String((e as Error)?.message || e)); }
  };
  const command = async (action: string) => {
    try { await grind('command', action); setTimeout(load, 1200); } catch (e) { setError(String((e as Error)?.message || e)); }
  };
  if (hidden) return null;
  const live = state?.live, run = live?.runs?.[0] ?? null, settings = state?.settings;
  return <div className="grind-page" data-grind-page>
    {error && <div role="alert" className="error-banner"><AlertCircle size={18} /><span>{error === 'unavailable' ? tr('刷图记录暂不可用', 'Grind tracker unavailable') : error}</span></div>}
    <section className="stall grind-head"><div className="stall-bar"><Crosshair size={18} /><h2>{tr('刷图', 'Grind')}</h2>
      <nav className="grind-tabs" aria-label={tr('刷图', 'Grind')}>
        {([['live', '实时', 'Live'], ['history', '历史', 'History'], ['board', '地图效率榜', 'Map leaderboard'], ['all', '全部用户', 'Everyone'],
          ['settings', '设置', 'Settings']] as [View, string, string][]).map(([key, zh, en]) =>
          <button key={key} aria-pressed={view === key} onClick={() => setView(key)}>{tr(zh, en)}</button>)}
      </nav>
      <span className={`connection ${live && !live.stale ? 'live' : ''}`}><i />{!live || live.stale ? tr('等待客户端', 'Waiting for the collector') : run ? statusLabel(run) : tr('等待打怪', 'Waiting for kills')}</span>
      {run && run.status !== 'ended' && <span className="grind-tools">
        <button className="text-link" onClick={() => command(run.status === 'active' ? 'pause' : 'resume')}>
          {run.status === 'active' ? <Pause size={14} /> : <Play size={14} />}{run.status === 'active' ? tr('暂停', 'Pause') : tr('继续', 'Resume')}</button>
        <button className="text-link" onClick={() => command('end')}><Square size={13} />{tr('结束本次', 'End run')}</button>
      </span>}
      {settings && <span className="grind-tools">
        <label className="check-chip"><input type="checkbox" checked={settings.overlay.enabled} onChange={e => save({ overlay: { enabled: e.target.checked } })} />{tr('悬浮窗', 'Overlay')}</label>
      </span>}
    </div></section>
    {channelPrompt(run) && <div role="alert" className="error-banner"><AlertCircle size={18} /><span>{channelPrompt(run)}</span></div>}
    {live?.protocol_warning && <div role="alert" className="error-banner"><AlertCircle size={18} />
      <span>{tr('游戏报文格式可能已变化，部分数字暂不可信；已自动开始录制，请把客户端更新到最新版。', 'The game messages may have changed; some numbers are unreliable. Recording started; update the collector.')}</span></div>}
    <div className="grind-body">
      {view === 'live' && !run && <BuffStrip live={live ?? null} warn={settings?.buff_warn_seconds ?? 3} />}
      {view === 'live' && <LiveView run={run} live={live ?? null} warn={settings?.buff_warn_seconds ?? 3} rule={pointsRule(settings)} />}
      {view === 'history' && <HistoryView runs={history as any} reload={loadHistory} rule={pointsRule(settings)} />}
      {(view === 'board' || view === 'all') && <SitePage key={view} page={view === 'board' ? 'grind_board' : 'grind_all'} theme={theme} lang={lang} />}
      {view === 'settings' && settings && state && <SettingsView state={state} settings={settings} save={save} refresh={load} />}
    </div>
  </div>;
}

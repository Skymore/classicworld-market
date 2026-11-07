import { AlertCircle, ArrowUpRight, Clock3, Monitor, MousePointer2, Package, Pause, Play, RefreshCw, ScanLine, Square } from 'lucide-react';
import { mesos, participantLabel } from '../src/lib/sweep-labels';
import { ago } from './format';
import { locale, tr } from './i18n';
import { ACTIVE_PHASES, RECOVERY_PHASES, healthLabel, isLive, phaseLabel, type State } from './state';
import type { WorkspaceStatus } from './workspace';

type Sweep = NonNullable<WorkspaceStatus['sweep']>;

function elapsed(start: number | null, now: number) {
  if (!start) return '—';
  const secs = Math.max(0, Math.floor(now / 1000 - start)), hours = Math.floor(secs / 3600);
  return `${hours ? `${hours}:` : ''}${String(Math.floor(secs / 60) % 60).padStart(2, '0')}:${String(secs % 60).padStart(2, '0')}`;
}

/** The running sweep in one line above the scan panel. */
function SweepStrip({ sweep, onOpen }: { sweep: Sweep; onOpen(): void }) {
  const run = sweep.run!;
  const parts = [
    run.spent != null ? tr(`已花 ${mesos(run.spent)} / ${mesos(run.budget)}`, `Spent ${mesos(run.spent)} / ${mesos(run.budget)}`)
      : tr(`剩余 ${mesos(run.remaining)}`, `${mesos(run.remaining)} left`),
    sweep.message || run.message,
    run.bought != null && tr(`本轮已买 ${run.bought.toLocaleString('en-US')} 件`, `${run.bought.toLocaleString('en-US')} bought this run`),
  ].filter(Boolean).join(' · ');
  return <div className="sweep-strip" data-sweep-status-line><i className="sq-dot" aria-hidden="true" />
    <b>{run.state === 'active' ? tr('扫货中', 'Sweeping') : participantLabel(run.state, tr)}</b><span>{parts}</span>
    <button className="text-link" onClick={onOpen}>{tr('查看', 'View')} <ArrowUpRight size={14} /></button></div>;
}

export interface ScanProps {
  state: State; connected: boolean; busy: boolean; error: string; now: number;
  selected: number | null; select(id: number): void;
  action(name: string, value?: unknown): void;
  sweep: Sweep | null; openSweep(): void;
}

export default function ScanPage({ state, connected, busy, error, now, selected, select, action, sweep, openSweep }: ScanProps) {
  const active = Boolean(state.desired) || ACTIVE_PHASES.includes(state.phase), live = isLive(state);
  const manual = tr('手动采集中', 'Collecting by hand');
  const phase = state.phase === 'scanning'
    ? [tr('扫描中', 'Scanning'), state.room ? tr(`${state.room} 洞`, `FM${state.room}`) : '', state.channel ? tr(`${state.channel} 频道`, `CH ${state.channel}`) : ''].filter(Boolean).join(' · ')
    : ['stopped', 'paused'].includes(state.phase) ? `${phaseLabel(state.phase)} · ${live ? manual : healthLabel(state)}`
    : state.mode === 'manual' && live ? manual : (phaseLabel(state.phase) || tr('准备中', 'Getting ready'));
  const windowTitle = state.windows.find(w => w.id === state.selected)?.title || 'MapleStory';
  const pending = state.pending_uploads ?? 0;
  const runningNote = [tr('自动扫描', 'Automatic scan'), tr(`待传 ${pending}`, `${pending} to upload`),
    state.last_progress_at ? tr(`最近进展 ${ago(state.last_progress_at, now)}`, `last progress ${ago(state.last_progress_at, now)}`) : ''].filter(Boolean).join(' · ');
  const paused = state.phase === 'paused';
  const refresh = tr('刷新游戏窗口', 'Refresh game windows');
  return <>
    {sweep?.run && <SweepStrip sweep={sweep} onOpen={openSweep} />}
    {error && <div role="alert" className="error-banner"><AlertCircle size={18} /><span>{error}</span></div>}
    <section className="stall scan-panel" aria-label={tr('采集', 'Collect')}><div className="stall-bar"><ScanLine size={18} /><h2>{tr('采集', 'Collect')}</h2>
      <span role="status" title={state.message} className={`phase phase-${state.phase}`}>{phase}</span>
      <span className={`connection ${live ? 'live' : ''}`}><i />{healthLabel(state)}</span>
      {state.capture_warning && <span className="capture-warning" data-capture-warning title={state.capture_warning}>{state.capture_warning}</span>}</div>
      {active ? <div className="scan-body scan-running" data-scan-running>
        <span className="scan-window"><Monitor size={17} />{windowTitle}</span><span className="scan-note">{runningNote}</span>
        <button className="ui-btn primary" disabled={busy || !['scanning', 'paused'].includes(state.phase)} onClick={() => action(paused ? 'resume' : 'pause')}>
          {paused ? <Play size={15} /> : <Pause size={15} />}{paused ? tr('继续', 'Resume') : tr('暂停', 'Pause')}</button>
        <button className="ui-btn" disabled={busy || state.phase === 'stopping'} onClick={() => action('stop')}><Square size={13} />{tr('停止', 'Stop')}</button>
      </div> : <div className="scan-body">
        <div className="mode-tabs" role="group" aria-label={tr('采集方式', 'How to collect')}>
          <button aria-pressed={state.mode === 'scan'} disabled={!connected || busy} onClick={() => action('mode', 'scan')}><ScanLine size={17} />{tr('自动扫描', 'Automatic scan')}</button>
          <button aria-pressed={state.mode === 'manual'} disabled={!connected || busy} onClick={() => action('mode', 'manual')}><MousePointer2 size={17} />{tr('手动逛摊', 'Browse shops by hand')}</button></div>
        {state.mode === 'scan' ? <>
          <label className="field-label" htmlFor="game-window">{tr('游戏窗口', 'Game window')}</label>
          <div className="window-picker"><Monitor size={19} />
            <select id="game-window" value={selected ?? ''} disabled={!connected} onChange={e => select(Number(e.target.value))}>
              {!state.windows.length && <option value="">{tr('打开 MapleStory 后刷新列表', 'Open MapleStory, then refresh the list')}</option>}
              {state.windows.map(w => <option key={w.id} value={w.id}>{w.title}{state.windows.length > 1 ? ` · ${w.pid}` : ''}</option>)}</select>
            <button className="icon-btn refresh" onClick={() => action('refresh')} title={refresh} aria-label={refresh} disabled={busy || !connected}><RefreshCw size={17} /></button></div>
          <div className="scan-actions"><button className="ui-btn primary" disabled={!connected || busy || !selected || state.capture === 'offline'} onClick={() => action('start', selected)}>
            <Play size={17} fill="currentColor" />{tr('开始扫描', 'Start scanning')}</button><span className="action-note">{tr('自动领取洞号 · 扫完接着扫', 'Rooms are assigned automatically · keeps going')}</span></div>
        </> : <div className="manual-mode"><MousePointer2 size={32} /><div><h3>{tr('按你的节奏逛摊', 'Browse at your own pace')}</h3>
          <p>{tr('切换一次频道，然后照常打开摊位。', 'Change channel once, then open shops as usual.')}<br />{tr('报价会自动采集并上传。', 'Prices are collected and uploaded automatically.')}</p></div>
          <span className="manual-badge">{tr('已开启', 'On')}</span></div>}
      </div>}
      {RECOVERY_PHASES.includes(state.phase) && <p className="recovery-status">{state.message}
        {state.next_retry_at ? tr(` · 重试 ${state.retries ?? 0} · ${Math.max(0, Math.ceil(state.next_retry_at - now / 1000))} 秒后`,
          ` · retry ${state.retries ?? 0} · in ${Math.max(0, Math.ceil(state.next_retry_at - now / 1000))}s`) : ''}</p>}
      <div className="metrics">
        <div><span><ScanLine size={15} />{tr('已扫店铺', 'Shops scanned')}</span><strong>{(state.run_shops ?? 0).toLocaleString()}<small>{tr('家', '')}</small></strong></div>
        <div><span><Package size={15} />{tr('已扫商品', 'Items scanned')}</span><strong>{(state.run_items ?? 0).toLocaleString()}<small>{tr('件', '')}</small></strong></div>
        <div><span><Clock3 size={15} />{tr('运行时长', 'Running for')}</span><strong className="time-value">{elapsed(state.run_started_at, now)}</strong></div>
      </div>
    </section>
    <section className="stall activity-panel" aria-label={tr('动态', 'Activity')}><div className="stall-bar"><h2>{tr('动态', 'Activity')}</h2>
      <span className="bar-meta">{active ? tr(`最近 ${state.activities.length} 条`, `latest ${state.activities.length}`) : tr(`待传 ${pending}`, `${pending} to upload`)}</span></div>
      <div className="activity-list">{state.activities.length ? state.activities.map((item, i) => <div className={`activity ${item.kind}`} key={`${item.at}-${i}`}>
        <i /><span title={item.text}>{item.text}</span><time>{new Date(item.at * 1000).toLocaleTimeString(locale(), { hour: '2-digit', minute: '2-digit' })}</time></div>)
        : <div className="activity-empty">{tr('开始扫描后，进度会显示在这里。', 'Progress shows here once scanning starts.')}</div>}</div></section>
  </>;
}

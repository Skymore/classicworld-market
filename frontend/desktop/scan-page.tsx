import { AlertCircle, ArrowUpRight, Clock3, Monitor, MousePointer2, Package, Pause, Play, RefreshCw, ScanLine, Square } from 'lucide-react';
import { mesos, participantLabel } from '../src/lib/sweep-labels';
import { ago } from './format';
import { ACTIVE_PHASES, PHASES, RECOVERY_PHASES, healthLabel, isLive, type State } from './state';
import type { WorkspaceStatus } from './workspace';

type Sweep = NonNullable<WorkspaceStatus['sweep']>;
const zh = (s: string) => s;

function elapsed(start: number | null, now: number) {
  if (!start) return '—';
  const secs = Math.max(0, Math.floor(now / 1000 - start)), hours = Math.floor(secs / 3600);
  return `${hours ? `${hours}:` : ''}${String(Math.floor(secs / 60) % 60).padStart(2, '0')}:${String(secs % 60).padStart(2, '0')}`;
}

/** The running sweep in one line above the scan panel. */
function SweepStrip({ sweep, onOpen }: { sweep: Sweep; onOpen(): void }) {
  const run = sweep.run!;
  const parts = [
    run.spent != null ? `已花 ${mesos(run.spent)} / ${mesos(run.budget)}` : `剩余 ${mesos(run.remaining)}`,
    sweep.message || run.message,
    run.bought != null && `本轮已买 ${run.bought.toLocaleString('en-US')} 件`,
  ].filter(Boolean).join(' · ');
  return <div className="sweep-strip" data-sweep-status-line><i className="sq-dot" aria-hidden="true" />
    <b>{run.state === 'active' ? '扫货中' : participantLabel(run.state, zh)}</b><span>{parts}</span>
    <button className="text-link" onClick={onOpen}>查看 <ArrowUpRight size={14} /></button></div>;
}

export interface ScanProps {
  state: State; connected: boolean; busy: boolean; error: string; now: number;
  selected: number | null; select(id: number): void;
  action(name: string, value?: unknown): void;
  sweep: Sweep | null; openSweep(): void;
}

export default function ScanPage({ state, connected, busy, error, now, selected, select, action, sweep, openSweep }: ScanProps) {
  const active = Boolean(state.desired) || ACTIVE_PHASES.includes(state.phase), live = isLive(state);
  const phase = state.phase === 'scanning'
    ? ['扫描中', state.room ? `${state.room} 洞` : '', state.channel ? `${state.channel} 频道` : ''].filter(Boolean).join(' · ')
    : ['stopped', 'paused'].includes(state.phase) ? `${PHASES[state.phase]} · ${live ? '手动采集中' : healthLabel(state)}`
    : state.mode === 'manual' && live ? '手动采集中' : (PHASES[state.phase] || '准备中');
  const windowTitle = state.windows.find(w => w.id === state.selected)?.title || 'MapleStory';
  const pending = state.pending_uploads ?? 0;
  const runningNote = ['自动扫描', `待传 ${pending}`, state.last_progress_at ? `最近进展 ${ago(state.last_progress_at, now)}` : ''].filter(Boolean).join(' · ');
  const paused = state.phase === 'paused';
  return <>
    {sweep?.run && <SweepStrip sweep={sweep} onOpen={openSweep} />}
    {error && <div role="alert" className="error-banner"><AlertCircle size={18} /><span>{error}</span></div>}
    <section className="stall scan-panel" aria-label="采集"><div className="stall-bar"><ScanLine size={18} /><h2>采集</h2>
      <span role="status" title={state.message} className={`phase phase-${state.phase}`}>{phase}</span>
      <span className={`connection ${live ? 'live' : ''}`}><i />{healthLabel(state)}</span></div>
      {active ? <div className="scan-body scan-running" data-scan-running>
        <span className="scan-window"><Monitor size={17} />{windowTitle}</span><span className="scan-note">{runningNote}</span>
        <button className="ui-btn primary" disabled={busy || !['scanning', 'paused'].includes(state.phase)} onClick={() => action(paused ? 'resume' : 'pause')}>
          {paused ? <Play size={15} /> : <Pause size={15} />}{paused ? '继续' : '暂停'}</button>
        <button className="ui-btn" disabled={busy || state.phase === 'stopping'} onClick={() => action('stop')}><Square size={13} />停止</button>
      </div> : <div className="scan-body">
        <div className="mode-tabs" role="group" aria-label="采集方式">
          <button aria-pressed={state.mode === 'scan'} disabled={!connected || busy} onClick={() => action('mode', 'scan')}><ScanLine size={17} />自动扫描</button>
          <button aria-pressed={state.mode === 'manual'} disabled={!connected || busy} onClick={() => action('mode', 'manual')}><MousePointer2 size={17} />手动逛摊</button></div>
        {state.mode === 'scan' ? <>
          <label className="field-label" htmlFor="game-window">游戏窗口</label>
          <div className="window-picker"><Monitor size={19} />
            <select id="game-window" value={selected ?? ''} disabled={!connected} onChange={e => select(Number(e.target.value))}>
              {!state.windows.length && <option value="">打开 MapleStory 后刷新列表</option>}
              {state.windows.map(w => <option key={w.id} value={w.id}>{w.title}{state.windows.length > 1 ? ` · ${w.pid}` : ''}</option>)}</select>
            <button className="icon-btn refresh" onClick={() => action('refresh')} title="刷新游戏窗口" aria-label="刷新游戏窗口" disabled={busy || !connected}><RefreshCw size={17} /></button></div>
          <div className="scan-actions"><button className="ui-btn primary" disabled={!connected || busy || !selected || state.capture === 'offline'} onClick={() => action('start', selected)}>
            <Play size={17} fill="currentColor" />开始扫描</button><span className="action-note">自动领取洞号 · 扫完接着扫</span></div>
        </> : <div className="manual-mode"><MousePointer2 size={32} /><div><h3>按你的节奏逛摊</h3><p>切换一次频道，然后照常打开摊位。<br />报价会自动采集并上传。</p></div><span className="manual-badge">已开启</span></div>}
      </div>}
      {RECOVERY_PHASES.includes(state.phase) && <p className="recovery-status">{state.message}
        {state.next_retry_at ? ` · 重试 ${state.retries ?? 0} · ${Math.max(0, Math.ceil(state.next_retry_at - now / 1000))} 秒后` : ''}</p>}
      <div className="metrics">
        <div><span><ScanLine size={15} />已扫店铺</span><strong>{(state.run_shops ?? 0).toLocaleString()}<small>家</small></strong></div>
        <div><span><Package size={15} />已扫商品</span><strong>{(state.run_items ?? 0).toLocaleString()}<small>件</small></strong></div>
        <div><span><Clock3 size={15} />运行时长</span><strong className="time-value">{elapsed(state.run_started_at, now)}</strong></div>
      </div>
    </section>
    <section className="stall activity-panel" aria-label="动态"><div className="stall-bar"><h2>动态</h2>
      <span className="bar-meta">{active ? `最近 ${state.activities.length} 条` : `待传 ${pending}`}</span></div>
      <div className="activity-list">{state.activities.length ? state.activities.map((item, i) => <div className={`activity ${item.kind}`} key={`${item.at}-${i}`}>
        <i /><span title={item.text}>{item.text}</span><time>{new Date(item.at * 1000).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}</time></div>)
        : <div className="activity-empty">开始扫描后，进度会显示在这里。</div>}</div></section>
  </>;
}

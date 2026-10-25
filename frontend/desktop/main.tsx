import { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Play, Pause, Square, Sun, Moon, Monitor, RefreshCw, UserRound, Minus, X, Radio, ArrowUpRight, Store, Clock3, Check, ScanLine, MousePointer2, ChevronRight, AlertCircle } from 'lucide-react';
import '../../web/css/base.css';
import './style.css';

type State = {
  version: string; phase: string; mode: string; message: string; room: number | null;
  channel: number | null; visited: number; uploaded: number; started_at: number | null; stopped_at: number | null;
  capture: string; upload: string; last_shop_at: number | null; updates: string;
  selected: number | null; windows: { id: number; title: string; pid: number }[];
  theme: 'light' | 'dark' | 'system'; activities: { at: number; text: string; kind: string }[];
};
declare global { interface Window { pywebview?: { api: { ready(): Promise<State>; command(name: string, value?: unknown): Promise<State> } } } }
const initial: State = { version: '', phase: 'idle', mode: 'scan', message: '正在连接采集器…', room: null, channel: null, visited: 0, uploaded: 0, started_at: null, stopped_at: null, capture: 'connecting', upload: 'ready', last_shop_at: null, updates: 'checking', selected: null, windows: [], theme: 'system', activities: [] };
const phases: Record<string, string> = { idle: '准备就绪', scanning: '扫描中', paused: '已暂停', stopping: '正在停止', stopped: '已停止', error: '需要处理' };
const health: Record<string, string> = { connecting: '正在连接', connected: '游戏已连接', capturing: '正在采集', waiting: '等待游戏连接', handshake: '请切一次频道', no_game: '等待打开游戏', no_inbound: '等待游戏数据', offline: '尚未连接', parse_error: '连接需要刷新' };
function Leaf() { const rows = ['.....r.....','....rrr....','.r..rrr..r.','.rr.rrr.rr.','.rrrrrrrrr.','rrrrrrrrrrr','.rrrrrrrrr.','..rrrrrrr..','.rr.rkr.rr.','.....k.....','....k......']; return <svg viewBox="0 0 11 11" width="31" height="31" aria-hidden="true" shapeRendering="crispEdges">{rows.flatMap((r, y) => [...r].map((c, x) => c !== '.' ? <rect key={`${x},${y}`} x={x} y={y} width="1" height="1" fill={c === 'r' ? 'var(--maple)' : 'var(--ink)'} /> : null))}</svg>; }
function elapsed(start: number | null, now: number) { if (!start) return '—'; const secs = Math.max(0, Math.floor(now / 1000 - start)); return `${Math.floor(secs / 3600) ? `${Math.floor(secs / 3600)}:` : ''}${String(Math.floor(secs / 60) % 60).padStart(2, '0')}:${String(secs % 60).padStart(2, '0')}`; }
function App() {
  const [state, setState] = useState<State>(initial), [connected, setConnected] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState(''), [now, setNow] = useState(Date.now());
  const [selected, setSelected] = useState<number | null>(null);
  useEffect(() => {
    let alive = true;
    const accept = (next: State) => { if (alive) { setState(next); setConnected(true); setSelected(v => next.windows.some(w => w.id === v) ? v : next.selected); } };
    const ready = () => { if (typeof window.pywebview?.api?.ready === 'function') window.pywebview.api.ready().then(accept).catch(e => setError(String(e.message || e))); };
    const update = (e: Event) => accept((e as CustomEvent<State>).detail);
    window.addEventListener('pywebviewready', ready); window.addEventListener('scanner-state', update);
    ready();
    return () => { alive = false; window.removeEventListener('pywebviewready', ready); window.removeEventListener('scanner-state', update); };
  }, []);
  useEffect(() => { const id = window.setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(id); }, []);
  useEffect(() => { const mq = matchMedia('(prefers-color-scheme: dark)'); const apply = () => { document.documentElement.dataset.theme = state.theme === 'system' ? (mq.matches ? 'dark' : 'light') : state.theme; }; apply(); mq.addEventListener('change', apply); return () => mq.removeEventListener('change', apply); }, [state.theme]);
  const action = async (name: string, value?: unknown) => { if (!window.pywebview?.api || busy) return; setBusy(true); setError(''); try { setState(await window.pywebview.api.command(name, value)); } catch (e) { setError(e instanceof Error ? e.message : String(e)); } finally { setBusy(false); } };
  const active = ['scanning','paused','stopping'].includes(state.phase), live = ['connected','capturing'].includes(state.capture);
  return <div className="desktop-app">
    <header className="app-header"><div className="app-brand pywebview-drag-region"><Leaf /><div><strong>枫叶市集</strong><span>扫描与采集</span></div></div><div className="header-tools">
      <div className="theme-switch" aria-label="主题">{([['system',Monitor,'跟随系统'],['light',Sun,'浅色主题'],['dark',Moon,'深色主题']] as const).map(([value, Icon, label]) => <button key={value} title={label} aria-label={label} aria-pressed={state.theme === value} onClick={() => action('theme',value)} disabled={!connected || busy}><Icon size={17}/></button>)}</div>
      <button className="icon-btn" title="账号与提醒" aria-label="账号与提醒" onClick={() => action('account')} disabled={!connected || busy}><UserRound size={19}/></button>
      <div className="window-controls" aria-label="窗口操作">
        <button title="最小化" aria-label="最小化" onClick={() => action('window','minimize')} disabled={!connected}><Minus size={17}/></button>
        <button className="window-close" title="关闭" aria-label="关闭" onClick={() => action('window','close')} disabled={!connected}><X size={19}/></button>
      </div>
    </div></header>
    <main className="desktop-main">
      <div className="page-heading"><div><div className="eyebrow">FREE MARKET</div><h1>让逛摊，更轻松。</h1><p>自动扫店，发现好价。每一份报价，都与大家共享。</p></div><button className="text-link" onClick={() => action('website')} disabled={!connected}>打开市集 <ArrowUpRight size={16}/></button></div>
      {error && <div role="alert" className="error-banner"><AlertCircle size={18}/><span>{error}</span></div>}
      <section className="stall scan-panel" aria-label="扫描控制"><div className="stall-bar"><ScanLine size={18}/><h2>开始采集</h2><span className={`connection ${live?'live':''}`}><i/>{health[state.capture] || '等待游戏连接'}</span></div>
        <div className="scan-body"><div className="mode-tabs" role="group" aria-label="采集方式"><button aria-pressed={state.mode==='scan'} disabled={!connected || active || busy} onClick={() => action('mode','scan')}><ScanLine size={17}/>自动扫描</button><button aria-pressed={state.mode==='manual'} disabled={!connected || active || busy} onClick={() => action('mode','manual')}><MousePointer2 size={17}/>手动逛摊</button></div>
          {state.mode === 'scan' ? <><label className="field-label" htmlFor="game-window">游戏窗口</label><div className="window-picker"><Monitor size={19}/><select id="game-window" value={selected ?? ''} disabled={active || !connected} onChange={e => setSelected(Number(e.target.value))}>{!state.windows.length && <option value="">打开 MapleStory 后刷新列表</option>}{state.windows.map(w => <option key={w.id} value={w.id}>{w.title}{state.windows.length>1?` · ${w.pid}`:''}</option>)}</select><button className="icon-btn refresh" onClick={() => action('refresh')} title="刷新游戏窗口" aria-label="刷新游戏窗口" disabled={active || busy || !connected}><RefreshCw size={17}/></button></div>
          <div className="scan-actions">{active ? <><button className="ui-btn primary" disabled={busy || state.phase==='stopping'} onClick={() => action(state.phase==='paused'?'resume':'pause')}>{state.phase==='paused'?<Play size={17}/>:<Pause size={17}/>} {state.phase==='paused'?'继续扫描':'暂停扫描'}</button><button className="ui-btn" disabled={busy || state.phase==='stopping'} onClick={() => action('stop')}><Square size={15}/>停止</button></> : <button className="ui-btn primary" disabled={!connected || busy || !selected || state.capture==='offline'} onClick={() => action('start',selected)}><Play size={17} fill="currentColor"/>开始扫描</button>}<span className="action-note">自动领取洞号 · 扫完接着扫</span></div></> : <div className="manual-mode"><MousePointer2 size={32}/><div><h3>按你的节奏逛摊</h3><p>切换一次频道，然后照常打开摊位。<br/>报价会自动采集并上传。</p></div><span className="manual-badge">已开启</span></div>}
        </div>
      </section>
      <section className="stall progress-panel" aria-label="实时进度"><div className="stall-bar"><h2>实时进度</h2><span className={`phase phase-${state.phase}`}>{phases[state.phase] || '准备中'}</span></div><div className="metrics">
        <div><span><Store size={15}/>当前洞号</span><strong>{state.room ?? '—'}{state.room && <small>洞</small>}</strong></div>
        <div><span><Radio size={15}/>当前频道</span><strong>{state.channel ? <><small>CH</small>{state.channel}</> : '—'}</strong></div>
        <div><span><ScanLine size={15}/>本洞已扫</span><strong>{state.visited.toLocaleString()}<small>家</small></strong></div>
        <div><span><Clock3 size={15}/>本次运行</span><strong className="time-value">{elapsed(state.started_at, state.stopped_at ? state.stopped_at * 1000 : now)}</strong></div>
      </div><div className="status-line" role="status"><span className={`status-symbol ${active?'working':''}`}>{active?<Radio size={16}/>:<Check size={16}/>}</span><span>{state.message}</span></div></section>
      <div className="bottom-grid"><section className="stall activity-panel" aria-label="最近动态"><div className="stall-bar"><h2>最近动态</h2><span className="bar-meta">实时更新</span></div><div className="activity-list">{state.activities.length ? state.activities.slice(0,4).map((item,i) => <div className={`activity ${item.kind}`} key={`${item.at}-${i}`}><i/><span>{item.text}</span><time>{new Date(item.at*1000).toLocaleTimeString('zh-CN',{hour:'2-digit',minute:'2-digit'})}</time></div>) : <div className="activity-empty">开始扫描后，进度会显示在这里。</div>}</div></section>
      <section className="stall upload-panel" aria-label="本次上传"><div className="upload-label"><ArrowUpRight size={17}/>本次上传</div><div className="upload-count">{state.uploaded.toLocaleString()}<small>条摊位记录</small></div><p className={state.upload==='retrying'?'warning-text':''}><i className={`dot ${state.upload==='retrying'?'warning':'live'}`}/>{state.upload==='retrying'?'暂存本机，恢复后自动上传':'新报价会自动同步到市集'}</p><button className="text-link" onClick={() => action('account')} disabled={!connected}>我的账号与提醒 <ChevronRight size={15}/></button></section></div>
    </main>
    <footer className="app-footer"><span><kbd>F9</kbd> 停止扫描 <b>·</b> 扫描时保持游戏在前台</span><span>{state.version?`v${state.version}`:'正在连接'} <b>·</b> {state.updates==='waiting_for_game_exit'?'新版本已就绪，退出游戏后更新':state.updates==='retry_later'?'稍后重试更新':'自动更新已开启'}</span></footer>
  </div>;
}
createRoot(document.getElementById('root')!).render(<App/>);

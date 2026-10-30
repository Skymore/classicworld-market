import { useCallback, useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Copy, Minus, Square, X } from 'lucide-react';
import '../../web/css/base.css';
import './style.css';
import WorkspaceTab, { useWorkspaceStatus, type Shell } from './workspace';
import ScanPage from './scan-page';
import SitePage, { type WatchSummary } from './site-page';
import { updateLabel } from './format';
import { healthLabel, initial, isLive, type State, type Theme } from './state';

type Tab = 'scan' | 'watch' | 'prices' | 'sweep' | 'account';
const TABS: [Tab, string][] = [['scan', '扫描采集'], ['watch', '关注'], ['prices', '价格表'], ['sweep', '扫货'], ['account', '账号']];
// One button cycles light → dark → system.
const THEMES: Record<Theme, { label: string; next: Theme }> = {
  light: { label: '浅色', next: 'dark' }, dark: { label: '深色', next: 'system' }, system: { label: '跟随系统', next: 'light' },
};
/** A half-filled circle: the theme button. */
function ThemeIcon() {
  return <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
    <circle cx="12" cy="12" r="9" /><path d="M12 3a9 9 0 0 1 0 18z" fill="currentColor" /></svg>;
}
/** Bottom-right grip: frameless windows have no native resize border on Windows. */
function ResizeGrip() {
  const drag = useRef<{ x: number; y: number; w: number; h: number; pending: boolean; next: [number, number] | null } | null>(null);
  const send = () => {
    const d = drag.current;
    if (!d || d.pending || !d.next) return;
    const size = d.next; d.next = null; d.pending = true;
    window.pywebview?.api.command('window', { resize: size }).catch(() => {}).finally(() => { if (drag.current === d) { d.pending = false; send(); } });
  };
  return <div className="resize-grip" aria-hidden="true"
    onPointerDown={e => { e.currentTarget.setPointerCapture(e.pointerId); drag.current = { x: e.screenX, y: e.screenY, w: window.innerWidth, h: window.innerHeight, pending: false, next: null }; }}
    onPointerMove={e => { const d = drag.current; if (!d) return; d.next = [Math.round(d.w + e.screenX - d.x), Math.round(d.h + e.screenY - d.y)]; send(); }}
    onPointerUp={() => { drag.current = null; }} onPointerCancel={() => { drag.current = null; }} />;
}
function Leaf() { return <img src={new URL('../../assets/app-icon.svg', import.meta.url).href} width="28" height="28" alt="" aria-hidden="true" />; }

function App() {
  const [tab, setTab] = useState<Tab>('scan');
  const [state, setState] = useState<State>(initial), [connected, setConnected] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState(''), [now, setNow] = useState(Date.now());
  const [selected, setSelected] = useState<number | null>(null), [resolved, setResolved] = useState<'light' | 'dark'>('light');
  const [watch, setWatch] = useState<WatchSummary | null>(null), [pricesOpened, setPricesOpened] = useState(false);
  const onSummary = useCallback((summary: WatchSummary) => setWatch(summary), []);
  useEffect(() => { if (tab === 'prices') setPricesOpened(true); }, [tab]);
  const workspace = useWorkspaceStatus(), sweep = workspace.status?.linked ? workspace.status.sweep : null;
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
  useEffect(() => {
    const mq = matchMedia('(prefers-color-scheme: dark)');
    const apply = () => { const theme = state.theme === 'system' ? (mq.matches ? 'dark' : 'light') : state.theme; document.documentElement.dataset.theme = theme; setResolved(theme); };
    apply(); mq.addEventListener('change', apply); return () => mq.removeEventListener('change', apply);
  }, [state.theme]);
  const action = async (name: string, value?: unknown) => {
    if (!window.pywebview?.api || busy) return;
    setBusy(true); setError('');
    try { setState(await window.pywebview.api.command(name, value)); } catch (e) { setError(e instanceof Error ? e.message : String(e)); } finally { setBusy(false); }
  };
  const theme = THEMES[state.theme] || THEMES.system;
  const shell: Shell = {
    version: state.version, updates: state.updates, uploaded: state.uploaded, gameLive: isLive(state), gameLabel: healthLabel(state), watch,
    openWatch: () => setTab('watch'), openWebsite: () => action('website'),
  };
  return <div className="desktop-app">
    <header className="app-header">
      <div className="app-brand pywebview-drag-region"><Leaf /><strong className="pywebview-drag-region">枫叶市集</strong></div>
      <nav className="app-tabs" aria-label="功能">{TABS.map(([key, label]) => {
        const hits = key === 'watch' ? watch?.hits ?? 0 : 0;
        return <button key={key} aria-pressed={tab === key} aria-label={hits ? `${label}，${hits} 件有符合条件的在售` : undefined} onClick={() => setTab(key)}>
          {label}{hits > 0 && <b className="tab-badge" data-watch-hits>{hits}</b>}</button>;
      })}</nav>
      <div className="app-drag pywebview-drag-region" onDoubleClick={() => action('window', 'maximize')} />
      <div className="header-tools">
        <button className="icon-btn" title={`主题：${theme.label}`} aria-label={`主题：${theme.label}`} onClick={() => action('theme', theme.next)} disabled={!connected || busy}><ThemeIcon /></button>
        <div className="window-controls" aria-label="窗口操作">
          <button title="最小化" aria-label="最小化" onClick={() => action('window', 'minimize')} disabled={!connected}><Minus size={17} /></button>
          <button title={state.maximized ? '还原' : '最大化'} aria-label={state.maximized ? '还原' : '最大化'} onClick={() => action('window', 'maximize')} disabled={!connected}>
            {state.maximized ? <Copy size={14} /> : <Square size={14} />}</button>
          <button className="window-close" title="关闭" aria-label="关闭" onClick={() => action('window', 'close')} disabled={!connected}><X size={19} /></button>
        </div>
      </div>
    </header>
    <main className={'desktop-main ' + (tab === 'scan' ? 'scan-main' : tab === 'watch' || tab === 'prices' ? 'workspace-main site-main' : 'workspace-main')}>
      {tab === 'scan' ? <ScanPage state={state} connected={connected} busy={busy} error={error} now={now} selected={selected} select={setSelected}
          action={action} sweep={sweep} openSweep={() => setTab('sweep')} />
        : tab === 'sweep' || tab === 'account' ? <WorkspaceTab tab={tab} workspace={workspace} shell={shell} /> : null}
      {/* Site pages stay mounted once opened: the watch page reports hits even while another tab is shown. */}
      {connected && <SitePage page="watch" theme={resolved} hidden={tab !== 'watch'} onSummary={onSummary} />}
      {connected && pricesOpened && <SitePage page="prices" theme={resolved} hidden={tab !== 'prices'} />}
    </main>
    {connected && !state.maximized && <ResizeGrip />}
    <footer className="app-footer"><span><kbd>F9</kbd> 停止扫描 <b>·</b> 扫描时保持游戏在前台</span>
      <span>{state.version ? `v${state.version}` : '正在连接'} <b>·</b> {updateLabel(state.updates)}</span></footer>
  </div>;
}
createRoot(document.getElementById('root')!).render(<App />);

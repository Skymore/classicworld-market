import { useCallback, useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Copy, Languages, Minus, Square, X } from 'lucide-react';
import * as Menu from '@radix-ui/react-dropdown-menu';
import '../../web/css/base.css';
import './style.css';
import WorkspaceTab, { useWorkspaceStatus, type Shell } from './workspace';
import ScanPage from './scan-page';
import BugReport from './bug-report';
import { RemoteDebugTools, RemoteDebugBanner } from './remote-debug';
import SitePage, { SITE_LABELS, type SitePageKey, type WatchSummary } from './site-page';
import { applyLanguage, language as currentLanguage, systemLanguage, tr, type Lang, type LangChoice } from './i18n';
import { updateLabel } from './format';
import { healthLabel, initial, isLive, type State, type Theme } from './state';

type ClientTab = 'scan' | 'sweep' | 'account';
type Tab = SitePageKey | ClientTab;
// The website's sections, in its navigation order, then what only the collector does.
const SITE_TABS: SitePageKey[] = ['home', 'dex', 'watch', 'selling', 'tools'];
const CLIENT_TABS: [ClientTab, string, string][] = [['scan', '扫描采集', 'Scan'], ['sweep', '扫货', 'Sweep'], ['account', '账号', 'Account']];
const isSite = (tab: Tab): tab is SitePageKey => (SITE_TABS as string[]).includes(tab);
// One button cycles light → dark → system.
const THEMES: Record<Theme, [string, string]> = { system: ['跟随系统', 'System'], light: ['浅色', 'Light'], dark: ['深色', 'Dark'] };
const LANGUAGE_CHOICES: LangChoice[] = ['system', 'zh', 'en', 'ko'];
// Each language in its own script, so a player who cannot read the window still finds theirs.
const LANGUAGE_NAMES: Record<Lang, string> = { zh: '中文', en: 'English', ko: '한국어' };
/** A header menu of choices (radio items); the trigger is the given button content. */
function ChoiceMenu<T extends string>({ label, value, options, onChoose, disabled, trigger, ...data }: {
  label: string; value: T; options: [T, string, string?][]; onChoose(value: T): void; disabled: boolean; trigger: React.ReactNode;
  [key: `data-${string}`]: string | boolean;
}) {
  return <Menu.Root>
    <Menu.Trigger asChild><button className="icon-btn menu-btn" title={label} aria-label={label} disabled={disabled} {...data}>{trigger}</button></Menu.Trigger>
    <Menu.Portal><Menu.Content className="choice-menu" align="end" sideOffset={4} aria-label={label}>
      <Menu.RadioGroup value={value} onValueChange={v => onChoose(v as T)}>
        {options.map(([key, text, note]) => <Menu.RadioItem key={key} value={key} className="choice-item" data-choice={key}>
          <span>{text}</span>{note && <small>{note}</small>}</Menu.RadioItem>)}
      </Menu.RadioGroup>
    </Menu.Content></Menu.Portal>
  </Menu.Root>;
}
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
/** A downloaded release installs only when the player clicks; the game stays open. */
function UpdateControl({ state, connected, busy, action }: { state: State; connected: boolean; busy: boolean; action(name: string): void }) {
  if (state.updates === 'restarting') return <>{tr('正在更新…', 'Updating…')}</>;
  if (state.update_requested) return <>{state.desired ? tr('扫完当前摊位后更新', 'Updates after this shop') : tr('正在准备更新…', 'Preparing the update…')}</>;
  if (state.updates !== 'ready_to_update') return <>{updateLabel(state.updates)}</>;
  const tag = state.update_version ? 'v' + state.update_version.replace(/^v/, '') : tr('新版本', 'the new version');
  return <button className="ui-btn primary footer-update" title={tr('采集器会短暂重启，游戏无需退出', 'The collector restarts briefly; the game stays open')} onClick={() => action('update')}
    disabled={!connected || busy || Boolean(state.remote_debug?.active)}>{tr(`更新到 ${tag}`, `Update to ${tag}`)}</button>;
}

function App() {
  const [tab, setTab] = useState<Tab>('scan');
  const [state, setState] = useState<State>(initial), [connected, setConnected] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState(''), [now, setNow] = useState(Date.now());
  const [selected, setSelected] = useState<number | null>(null), [resolved, setResolved] = useState<'light' | 'dark'>('light');
  const [watch, setWatch] = useState<WatchSummary | null>(null), [opened, setOpened] = useState<SitePageKey[]>([]);
  const [lang, setLang] = useState<Lang>(currentLanguage);
  const onSummary = useCallback((summary: WatchSummary) => setWatch(summary), []);
  // Site pages load when first opened and stay mounted (their filters and scroll survive tab switches).
  useEffect(() => { if (isSite(tab)) setOpened(old => old.includes(tab) ? old : [...old, tab]); }, [tab]);
  // The Windows display language, or the player's choice; Windows can change it while the window is open.
  useEffect(() => {
    const apply = () => setLang(applyLanguage(state.language));
    apply(); window.addEventListener('languagechange', apply);
    return () => window.removeEventListener('languagechange', apply);
  }, [state.language]);
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
  const themeChoice: Theme = THEMES[state.theme] ? state.theme : 'system';
  const choice = state.language && LANGUAGE_CHOICES.includes(state.language) ? state.language : 'system';
  const systemLang = systemLanguage();
  const tabButton = (key: Tab, label: string) => {
    const hits = key === 'watch' ? watch?.hits ?? 0 : 0;
    return <button key={key} aria-pressed={tab === key} aria-label={hits ? tr(`${label}，${hits} 件有符合条件的在售`, `${label}, ${hits} with matching offers`) : undefined} onClick={() => setTab(key)}>
      {label}{hits > 0 && <b className="tab-badge" data-watch-hits>{hits}</b>}</button>;
  };
  const shell: Shell = {
    version: state.version, updates: state.updates, uploaded: state.uploaded, gameLive: isLive(state), gameLabel: healthLabel(state), watch,
    openWatch: () => setTab('watch'), openWebsite: () => action('website'),
  };
  const sitePage = (page: SitePageKey) => <SitePage key={page} page={page} theme={resolved} lang={lang} hidden={tab !== page}
    onSummary={page === 'watch' ? onSummary : undefined} />;
  return <div className="desktop-app">
    <header className="app-header">
      <div className="app-brand pywebview-drag-region"><Leaf /><strong className="pywebview-drag-region">{tr('枫叶市集', 'Maple Market')}</strong></div>
      <nav className="app-tabs" aria-label={tr('功能', 'Sections')}>
        <span className="tab-group" role="group" aria-label={tr('网站', 'Website')} data-tab-group="site">{SITE_TABS.map(key => tabButton(key, tr(...SITE_LABELS[key])))}</span>
        <span className="tab-group client" role="group" aria-label={tr('客户端', 'Collector')} data-tab-group="client">{CLIENT_TABS.map(([key, zh, en]) => tabButton(key, tr(zh, en)))}</span>
      </nav>
      <div className="app-drag pywebview-drag-region" onDoubleClick={() => action('window', 'maximize')} />
      <div className="header-tools">
        <ChoiceMenu label={tr('语言', 'Language')} value={choice} disabled={!connected || busy} data-language-toggle
          onChoose={value => action('language', value)}
          options={[['zh', LANGUAGE_NAMES.zh], ['en', LANGUAGE_NAMES.en], ['ko', LANGUAGE_NAMES.ko], ['system', tr('跟随系统', 'System language'), LANGUAGE_NAMES[systemLang]]]}
          trigger={<><Languages size={17} /><span className="menu-label">{LANGUAGE_NAMES[lang]}</span><i className="menu-caret" aria-hidden="true" /></>} />
        <ChoiceMenu label={tr('主题', 'Theme')} value={themeChoice} disabled={!connected || busy} data-theme-toggle
          onChoose={value => action('theme', value)}
          options={(['system', 'light', 'dark'] as Theme[]).map(key => [key, tr(...THEMES[key])])}
          trigger={<ThemeIcon />} />
        <div className="window-controls" aria-label={tr('窗口操作', 'Window')}>
          <button title={tr('最小化', 'Minimize')} aria-label={tr('最小化', 'Minimize')} onClick={() => action('window', 'minimize')} disabled={!connected}><Minus size={17} /></button>
          <button title={state.maximized ? tr('还原', 'Restore') : tr('最大化', 'Maximize')} aria-label={state.maximized ? tr('还原', 'Restore') : tr('最大化', 'Maximize')} onClick={() => action('window', 'maximize')} disabled={!connected}>
            {state.maximized ? <Copy size={14} /> : <Square size={14} />}</button>
          <button className="window-close" title={tr('关闭', 'Close')} aria-label={tr('关闭', 'Close')} onClick={() => action('window', 'close')} disabled={!connected}><X size={19} /></button>
        </div>
      </div>
    </header>
    <RemoteDebugBanner state={state} update={setState} now={now} />
    <main className={'desktop-main ' + (tab === 'scan' ? 'scan-main' : isSite(tab) ? 'workspace-main site-main' : 'workspace-main')}>
      {tab === 'scan' ? <ScanPage state={state} connected={connected} busy={busy} error={error} now={now} selected={selected} select={setSelected}
          action={action} sweep={sweep} openSweep={() => setTab('sweep')} />
        : tab === 'sweep' || tab === 'account' ? <WorkspaceTab tab={tab} workspace={workspace} shell={shell} /> : null}
      {/* Site pages stay mounted once opened: the watch page reports hits even while another tab is shown. */}
      {connected && SITE_TABS.filter(page => page === 'watch' || opened.includes(page)).map(sitePage)}
    </main>
    {connected && !state.maximized && <ResizeGrip />}
    <footer className="app-footer"><span><kbd>F9</kbd> {tr('停止扫描', 'stops scanning')} <b>·</b> {tr('扫描时保持游戏在前台', 'keep the game in front while scanning')}</span>
      <BugReport state={state} connected={connected} update={setState} />
      <RemoteDebugTools state={state} connected={connected} update={setState} />
      <span>{state.version ? `v${state.version}` : tr('正在连接', 'Connecting')} <b>·</b> <UpdateControl state={state} connected={connected} busy={busy} action={action} /></span></footer>
  </div>;
}
createRoot(document.getElementById('root')!).render(<App />);

import { useEffect, useState } from 'react';
import type { Device, Holdings, RunDevice } from '../lib/sweep-labels';
import SweepPane from './sweep-pane';
import AccountPane from './account-pane';
import { tr } from './i18n';
import { hostCall, useHostShell, type HostShell } from './host';
import './client.css';

// The collector's sweep and account tabs. They are built and updated with the website, and
// run inside the collector window: every action is `workspace(action, value)` of
// desktop_workspace.py, reached through the window (host.ts).
export interface SweepSettings { allow_web_start: boolean; max_spend: number; max_order: number; reserve_mesos: number }
export interface RunItem { item_id: number; limit: number; units: number; bought?: number }
export interface DeviceRun {
  devices?: RunDevice[]; plan_stale?: boolean;
  id: string; status: string; budget: number; remaining: number; ends_at: string | number;
  started_by: string; state: string; message?: string | null; spent_here: number; plan_version: number;
  // Run-wide totals; null or [] from servers that do not send them yet.
  spent?: number | null; bought?: number | null; items?: RunItem[]; started_at?: string | number | null; checked?: number;
}
export interface SweepRule { item_id: number; name: string; limit: number; groups: any[] }
export interface RecentPurchase {
  name: string; item_id: number; status: string; quantity: number; units: number; price?: number | null; spent: number;
  reason?: string | null; room?: number | null; channel?: number | null; owner?: string | null; at?: string | number;
}
export interface WorkspaceStatus {
  linked: boolean;
  account: { id: string; nickname: string } | null;
  device: { id: string; name: string } | null;
  sweep: {
    holdings?: Holdings | null;
    settings: SweepSettings; executor: { ready: boolean; reason?: string };
    run: DeviceRun | null; recent: RecentPurchase[]; message?: string;
    rules?: { watches: SweepRule[] } | null;
  } | null;
}
/** What the sweep and account tabs need from the collector window. */
export interface Shell extends HostShell { openWatch(): void; openWebsite(): void }
export type Run = (action: string, value?: unknown) => Promise<any>;
const POLL_MS = 5000;

export const invoke = hostCall;
export const errorText = (e: unknown) => {
  const raw = String((e as Error)?.message || e);
  const codes: Record<string, [string, string]> = {
    login_required: ['请先登录', 'Sign in first'], sweep_running: ['已有一轮扫货在进行', 'A sweep is already running'],
    no_sweep_groups: ['没有可扫货的条件组', 'No sweep condition groups'], invalid_request: ['数值不正确', 'Invalid value'],
    sweep_stopped: ['本轮已结束', 'This run has ended'], unavailable: ['暂时连不上服务器', 'The server is unreachable right now'],
  };
  return codes[raw] ? tr(...codes[raw]) : raw;
};

/** Status shared by the sweep tab, the account tab and the scan page's status line. */
export function useWorkspaceStatus() {
  const [status, setStatus] = useState<WorkspaceStatus | null>(null), [error, setError] = useState('');
  useEffect(() => {
    let alive = true, running = false;
    async function poll() {
      if (running) return;
      running = true;
      try { const next = await invoke('status'); if (alive) { setStatus(next); setError(''); } }
      catch (e) { if (alive) setError(errorText(e)); }
      finally { running = false; }
    }
    poll();
    const timer = setInterval(poll, POLL_MS);
    return () => { alive = false; clearInterval(timer); };
  }, []);
  return { status, setStatus, error };
}
export type Workspace = ReturnType<typeof useWorkspaceStatus>;

/** This account's devices; reloads when `version` changes. Null while loading, [] when unavailable. */
export function useDevices(enabled: boolean, version: unknown) {
  const [devices, setDevices] = useState<Device[] | null>(null), [failed, setFailed] = useState(false);
  useEffect(() => {
    if (!enabled) return;
    let alive = true;
    invoke('devices').then((r: any) => { if (alive) { setDevices(Array.isArray(r?.devices) ? r.devices : []); setFailed(false); } })
      .catch(() => { if (alive) { setDevices([]); setFailed(true); } });
    return () => { alive = false; };
  }, [enabled, version]);
  return { devices, failed };
}

const EMPTY_SHELL: HostShell = { version: '', updates: '', uploaded: 0, gameLive: false, gameLabel: '', watch: null };

export default function WorkspaceTab({ tab }: { tab: 'sweep' | 'account' }) {
  const { status, setStatus, error: pollError } = useWorkspaceStatus();
  const host = useHostShell();
  const shell: Shell = {
    ...(host || EMPTY_SHELL),
    openWatch: () => void hostCall('shell:watch').catch(() => {}),
    openWebsite: () => void hostCall('shell:website').catch(() => {}),
  };
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [notice, setNotice] = useState('');
  const run: Run = async (action, value) => {
    if (busy) return null;
    setBusy(true); setError(''); setNotice('');
    try { const next = await invoke(action, value); if (next && 'linked' in next) setStatus(next); return next; }
    catch (e) { setError(errorText(e)); return null; }
    finally { setBusy(false); }
  };
  async function login() { if (await run('login')) setNotice(tr('请在浏览器中完成登录', 'Finish signing in in your browser')); }
  const linked = Boolean(status?.linked);
  const signedOut = tr('未登录', 'Signed out');
  const meta = !status ? tr('正在连接…', 'Connecting…') : tab === 'account' ? (linked ? tr('已登录', 'Signed in') : signedOut)
    : linked ? [status.account?.nickname, status.device?.name].filter(Boolean).join(' · ') : signedOut;
  return <section className="client-pane native-workspace stall" data-client-pane={tab}><div className="stall-bar"><h2>{tab === 'account' ? tr('账号', 'Account') : tr('扫货', 'Sweep')}</h2>
    <span className="bar-meta" data-workspace-meta>{meta}</span></div>
    <div className="workspace-scroll">
      {(error || pollError) && <p className="error-banner" role="alert">{error || pollError}</p>}
      {notice && <p role="status" className="workspace-notice">{notice}</p>}
      {!status ? <p className="workspace-note">{tr('正在连接采集器…', 'Connecting to the collector…')}</p>
        : tab === 'account' ? <AccountPane status={status} busy={busy} run={run} login={login} shell={shell} />
        : !linked ? <div className="native-account" data-account-pane="signed-out"><h2>{tr('登录后扫货', 'Sign in to sweep')}</h2><button className="ui-btn primary" disabled={busy} onClick={login}>{tr('登录', 'Sign in')}</button></div>
        : status.sweep ? <SweepPane sweep={status.sweep} deviceId={status.device?.id} busy={busy} run={run} shell={shell} />
        : <p className="workspace-note">{tr('扫货暂不可用', 'Sweeping is unavailable right now')}</p>}
    </div></section>;
}

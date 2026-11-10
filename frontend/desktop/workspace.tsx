import { useEffect, useState } from 'react';
import type { Device, Holdings, RunDevice } from '../src/lib/sweep-labels';
import { tr } from './i18n';

// window.pywebview.api.workspace(action, value), implemented by desktop_workspace.py.
// The sweep and account tabs themselves are pages built with the website (frontend/src/client);
// this window keeps only the status poll for the scan page's sweep line.
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
/** What the sweep and account tabs need from the scanner window. */
export interface Shell {
  version: string; updates: string; uploaded: number;
  gameLive: boolean; gameLabel: string;
  /** From the embedded watch page; null until it has loaded. */
  watch: { watches: number; synced: boolean } | null;
  openWatch(): void; openWebsite(): void;
}
export type Run = (action: string, value?: unknown) => Promise<any>;
const POLL_MS = 5000;

export const invoke = (action: string, value?: unknown) => window.pywebview!.api.workspace(action, value);
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
      if (running || typeof window.pywebview?.api?.workspace !== 'function') return;
      running = true;
      try { const next = await invoke('status'); if (alive) { setStatus(next); setError(''); } }
      catch (e) { if (alive) setError(errorText(e)); }
      finally { running = false; }
    }
    poll();
    const timer = setInterval(poll, POLL_MS);
    window.addEventListener('pywebviewready', poll);
    return () => { alive = false; clearInterval(timer); window.removeEventListener('pywebviewready', poll); };
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

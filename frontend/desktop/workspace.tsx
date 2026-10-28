import { useEffect, useState, type ReactNode } from 'react';
import { clockTime, mesos, participantLabel, purchaseLabel, purchasePlace } from '../src/lib/sweep-labels';

// window.pywebview.api.workspace(action, value), implemented by desktop_workspace.py.
export interface SweepSettings { allow_web_start: boolean; max_spend: number; max_order: number; reserve_mesos: number }
export interface DeviceRun {
  id: string; status: string; budget: number; remaining: number; ends_at: string | number;
  started_by: string; state: string; message?: string | null; spent_here: number; plan_version: number;
}
export interface RecentPurchase {
  name: string; item_id: number; status: string; quantity: number; units: number; spent: number;
  reason?: string | null; room?: number | null; channel?: number | null; owner?: string | null; at?: string | number;
}
export interface WorkspaceStatus {
  linked: boolean;
  account: { id: string; nickname: string } | null;
  device: { id: string; name: string } | null;
  sweep: {
    settings: SweepSettings; executor: { ready: boolean; reason?: string };
    run: DeviceRun | null; recent: RecentPurchase[]; message?: string;
  } | null;
}
const POLL_MS = 5000;
const MAX_MESOS = 1e12;
const DEFAULT_MINUTES = 120;
const zh = (s: string) => s;
const invoke = (action: string, value?: unknown) => window.pywebview!.api.workspace(action, value);
const errorText = (e: unknown) => {
  const raw = String((e as Error)?.message || e);
  const codes: Record<string, string> = {
    login_required: '请先登录', sweep_running: '已有一轮扫货在进行', no_sweep_groups: '没有可扫货的条件组',
    invalid_request: '数值不正确', sweep_stopped: '本轮已结束', unavailable: '暂时连不上服务器',
  };
  return codes[raw] || raw;
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

/** A non-negative whole number of mesos, or null. */
const amount = (text: string, min = 0) => {
  const n = Number(text);
  return text.trim() !== '' && Number.isSafeInteger(n) && n >= min && n <= MAX_MESOS ? n : null;
};
function NumberField({ label, value, onChange, hint, name, min = 0, max = MAX_MESOS }: {
  label: string; value: string; onChange(v: string): void; hint?: ReactNode; name: string; min?: number; max?: number;
}) {
  return <label><span>{label}{hint && <small>{hint}</small>}</span>
    <input name={name} type="number" inputMode="numeric" min={min} max={max} step={1} value={value} onChange={e => onChange(e.target.value)} /></label>;
}

export default function WorkspaceTab({ tab, workspace }: { tab: 'sweep' | 'account'; workspace: Workspace }) {
  const { status, setStatus, error: pollError } = workspace;
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [notice, setNotice] = useState('');
  async function run(action: string, value?: unknown) {
    if (busy) return null;
    setBusy(true); setError(''); setNotice('');
    try { const next = await invoke(action, value); if (next && 'linked' in next) setStatus(next); return next; }
    catch (e) { setError(errorText(e)); return null; }
    finally { setBusy(false); }
  }
  async function login() { if (await run('login')) setNotice('请在浏览器中完成登录'); }
  const linked = Boolean(status?.linked);
  const title = tab === 'account' ? '我的账号' : '扫货';
  return <section className="native-workspace stall"><div className="stall-bar"><h2>{title}</h2>
    <span className="bar-meta" data-workspace-meta>{!status ? '正在连接…' : linked ? [status.account?.nickname, status.device?.name].filter(Boolean).join(' · ') : '未登录'}</span></div>
    <div className="workspace-scroll">
      {(error || pollError) && <p className="error-banner" role="alert">{error || pollError}</p>}
      {notice && <p role="status" className="workspace-notice">{notice}</p>}
      {!status ? <p className="workspace-note">正在连接采集器…</p>
        : tab === 'account' ? <AccountPane status={status} busy={busy} login={login} logout={() => run('logout')} />
        : !linked ? <div className="native-account"><h2>登录后扫货</h2><button className="ui-btn primary" disabled={busy} onClick={login}>登录</button></div>
        : status.sweep ? <SweepPane sweep={status.sweep} deviceId={status.device?.id} busy={busy} run={run} />
        : <p className="workspace-note">扫货暂不可用</p>}
    </div></section>;
}

function AccountPane({ status, busy, login, logout }: { status: WorkspaceStatus; busy: boolean; login(): void; logout(): void }) {
  return status.linked
    ? <div className="native-account" data-account-pane="signed-in"><h2>{status.account?.nickname || '已登录'}</h2>
        {status.device?.name && <span>本机：{status.device.name}</span>}
        <button className="ui-btn" disabled={busy} onClick={logout}>退出登录</button></div>
    : <div className="native-account" data-account-pane="signed-out"><h2>登录枫叶市集</h2><p>关注和扫货在电脑与网页间同步</p>
        <button className="ui-btn primary" disabled={busy} onClick={login}>登录</button></div>;
}

function SweepPane({ sweep, deviceId, busy, run }: {
  sweep: NonNullable<WorkspaceStatus['sweep']>; deviceId?: string; busy: boolean; run(action: string, value?: unknown): Promise<any>;
}) {
  const saved = sweep.settings;
  const [draft, setDraft] = useState<Record<keyof SweepSettings, string | boolean> | null>(null);
  const shown = draft || { allow_web_start: saved.allow_web_start, max_spend: String(saved.max_spend), max_order: String(saved.max_order), reserve_mesos: String(saved.reserve_mesos) };
  const parsed = { allow_web_start: Boolean(shown.allow_web_start), max_spend: amount(String(shown.max_spend)), max_order: amount(String(shown.max_order)), reserve_mesos: amount(String(shown.reserve_mesos)) };
  const settingsValid = parsed.max_spend !== null && parsed.max_order !== null && parsed.reserve_mesos !== null;
  const edit = (key: keyof SweepSettings, value: string | boolean) => setDraft({ ...shown, [key]: value });
  const [budget, setBudget] = useState(''), [minutes, setMinutes] = useState(String(DEFAULT_MINUTES));
  const budgetValue = amount(budget, 1), minutesValue = Number(minutes);
  const minutesValid = Number.isInteger(minutesValue) && minutesValue >= 5 && minutesValue <= 720;
  const current = sweep.run, executor = sweep.executor;
  const blocked = !executor.ready ? (executor.reason || '不能扫货') : saved.max_spend === 0 ? '先设置本机每轮最多花' : '';
  return <div className="native-sweep" data-native-sweep>
    <p className={'native-executor' + (executor.ready ? ' ready' : '')} data-executor><i aria-hidden="true" />{executor.ready ? '可以扫货' : executor.reason || '不能扫货'}</p>
    {sweep.message && <p className="workspace-note" data-sweep-message>{sweep.message}</p>}
    <div className="native-block" data-sweep-run>
      {current ? <>
        <div className="native-block-head"><b>{current.status === 'running' ? '运行中' : '已结束'}</b>
          <span>{[current.state !== 'active' && participantLabel(current.state, zh), current.started_by === 'web' ? '网页发起' : current.started_by === deviceId ? '本机发起' : '其他设备发起'].filter(Boolean).join(' · ')}</span>
          <button className="ui-btn" data-native-stop disabled={busy} onClick={() => run('stop')}>停止</button></div>
        <div className="native-stats">
          <div><small>预算</small><b>{mesos(current.budget)}</b></div>
          <div><small>剩余</small><b>{mesos(current.remaining)}</b></div>
          <div><small>本机已花</small><b>{mesos(current.spent_here)}</b></div>
          <div><small>结束</small><b>{clockTime(current.ends_at)}</b></div>
        </div>
        {current.message && <p className="workspace-note" data-run-message>{current.message}</p>}
      </> : <>
        <div className="native-block-head"><b>本机开始</b>{blocked && <span>{blocked}</span>}</div>
        <div className="native-fields">
          <NumberField name="budget" label="预算" value={budget} onChange={setBudget} min={1} hint={budgetValue ? ` · ${mesos(budgetValue)}` : undefined} />
          <NumberField name="minutes" label="时长（分钟）" value={minutes} onChange={setMinutes} min={5} max={720} />
          <div className="native-field-action"><button className="ui-btn primary" data-native-start disabled={busy || Boolean(blocked) || !budgetValue || !minutesValid}
            onClick={() => run('start', { budget: budgetValue, minutes: minutesValue })}>本机开始</button></div>
        </div>
      </>}
    </div>
    <div className="native-block" data-sweep-settings>
      <div className="native-block-head"><b>本机设置</b></div>
      <button type="button" className={'toggle' + (shown.allow_web_start ? ' on' : '')} aria-pressed={Boolean(shown.allow_web_start)} data-allow-web onClick={() => edit('allow_web_start', !shown.allow_web_start)}><i />允许网页启动扫货</button>
      <div className="native-fields">
        <NumberField name="max_spend" label="本机每轮最多花" value={String(shown.max_spend)} onChange={v => edit('max_spend', v)} hint={parsed.max_spend ? ` · ${mesos(parsed.max_spend)}` : undefined} />
        <NumberField name="max_order" label="单笔上限" value={String(shown.max_order)} onChange={v => edit('max_order', v)} hint={parsed.max_order === 0 ? ' · 不限' : parsed.max_order ? ` · ${mesos(parsed.max_order)}` : undefined} />
        <NumberField name="reserve_mesos" label="保留金币" value={String(shown.reserve_mesos)} onChange={v => edit('reserve_mesos', v)} hint={parsed.reserve_mesos ? ` · ${mesos(parsed.reserve_mesos)}` : undefined} />
      </div>
      <div className="native-save-row"><button className="ui-btn" data-save-settings disabled={busy || !draft || !settingsValid}
        onClick={async () => { if (await run('settings', parsed)) setDraft(null); }}>保存</button></div>
    </div>
    <div className="native-block" data-sweep-recent>
      <div className="native-block-head"><b>最近购买</b><span>{sweep.recent.length || ''}</span></div>
      {sweep.recent.length ? sweep.recent.map((row, i) => <div className="native-history-row" key={`${row.at}-${row.item_id}-${i}`} data-recent-status={row.status}>
        <span>{row.name || row.item_id}{(row.units || row.quantity) > 0 && ` × ${row.units || row.quantity}`}<small>{[purchasePlace(row), clockTime(row.at)].filter(s => s && s !== '—').join(' · ')}</small></span>
        <span className="native-history-side"><b>{row.status === 'bought' ? mesos(row.spent) : '—'}</b><small className={'native-status ' + row.status}>{purchaseLabel(row, zh)}</small></span>
      </div>) : <p className="workspace-note">还没有购买</p>}
    </div>
  </div>;
}

import { useState } from 'react';
import { tr } from './i18n';
import type { State } from './state';
type Props = { state: State; connected: boolean; update: (state: State) => void };
export function RemoteDebugTools({ state, connected, update }: Props) {
  const [consent, setConsent] = useState(false), [error, setError] = useState(''), [busy, setBusy] = useState(false);
  const start = async () => {
    if (!consent || busy || !window.pywebview?.api) return;
    setBusy(true); setError('');
    try { update(await window.pywebview.api.command('debug_start', 'allow-admin-powershell-15-minutes')); setConsent(false); }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  };
  return <details className="diagnostic-tools"><summary>{tr('远程调试', 'Remote debugging')}</summary><div className="diagnostic-panel">
    <label><input type="checkbox" checked={consent} onChange={e => setConsent(e.target.checked)} disabled={busy || state.remote_debug?.active} />
      {tr('允许枫叶市集运维执行管理员 PowerShell 命令，持续 15 分钟', 'Let Maple Market support run administrator PowerShell commands for 15 minutes')}</label>
    <p>{tr('可读取和修改电脑上的文件与设置。授权后停止扫描，命令与结果记录保留 7 天；终止会话不会撤销已完成的修改。',
      'Support can read and change files and settings on this PC. Scanning stops; commands and results are kept for 7 days. Ending the session does not undo finished changes.')}</p>
    <button className="ui-btn" disabled={!connected || !consent || busy || state.remote_debug?.active} onClick={start}>{tr('确认授权', 'Allow')}</button>
    <span role="status">{error || (!state.remote_debug?.active && state.remote_debug?.message)}</span>
  </div></details>;
}
export function RemoteDebugBanner({ state, update, now }: Omit<Props, 'connected'> & { now: number }) {
  const [error, setError] = useState('');
  const s = state.remote_debug;
  if (!s?.active) return null;
  const stop = async () => {
    try { update(await window.pywebview!.api.command('debug_stop')); }
    catch { setError(tr('终止失败，请按 F9 或关闭客户端', 'Could not end it; press F9 or close the collector')); }
  };
  const minutes = Math.min(15, Math.max(0, Math.ceil((s.expires_at * 1000 - now) / 60000)));
  return <section className="remote-debug-banner" aria-label={tr('远程调试已授权', 'Remote debugging allowed')}>
    <div><strong>{tr('管理员远程调试中', 'Administrator remote debugging')}</strong> · {tr(`剩余 ${minutes} 分钟`, `${minutes} min left`)}
      <small>{error || s.message}{s.session && tr(` · 会话 ${s.session}`, ` · session ${s.session}`)}</small>
      {s.command && <pre>{s.command}</pre>}</div>
    <button className="ui-btn" onClick={stop}>{tr('立即终止', 'End now')}</button>
  </section>;
}

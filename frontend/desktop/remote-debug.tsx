import { useState } from 'react';
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
  return <details className="diagnostic-tools"><summary>远程调试</summary><div className="diagnostic-panel">
    <label><input type="checkbox" checked={consent} onChange={e => setConsent(e.target.checked)} disabled={busy || state.remote_debug?.active} />允许枫叶市集运维执行管理员 PowerShell 命令，持续 15 分钟</label>
    <p>可读取和修改电脑上的文件与设置。授权后停止扫描，命令与结果记录保留 7 天；终止会话不会撤销已完成的修改。</p>
    <button className="ui-btn" disabled={!connected || !consent || busy || state.remote_debug?.active} onClick={start}>确认授权</button>
    <span role="status">{error || (!state.remote_debug?.active && state.remote_debug?.message)}</span>
  </div></details>;
}
export function RemoteDebugBanner({ state, update, now }: Omit<Props, 'connected'> & { now: number }) {
  const [error, setError] = useState('');
  const s = state.remote_debug;
  if (!s?.active) return null;
  const stop = async () => {
    try { update(await window.pywebview!.api.command('debug_stop')); }
    catch { setError('终止失败，请按 F9 或关闭客户端'); }
  };
  return <section className="remote-debug-banner" aria-label="远程调试已授权">
    <div><strong>管理员远程调试中</strong> · 剩余 {Math.min(15, Math.max(0, Math.ceil((s.expires_at * 1000 - now) / 60000)))} 分钟
      <small>{error || s.message}{s.session && ` · 会话 ${s.session}`}</small>
      {s.command && <pre>{s.command}</pre>}</div>
    <button className="ui-btn" onClick={stop}>立即终止</button>
  </section>;
}

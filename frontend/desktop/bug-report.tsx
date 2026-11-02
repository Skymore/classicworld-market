import { useState } from 'react';
import type { State } from './state';

export default function BugReport({ state, connected, update }: { state: State; connected: boolean; update: (state: State) => void }) {
  const [screenshot, setScreenshot] = useState(''), [error, setError] = useState(''), [busy, setBusy] = useState(false);
  const choose = async (file?: File) => {
    setScreenshot(''); setError('');
    if (!file) return;
    if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type) || file.size > 20 * 1024 * 1024) {
      setError('请选择 20 MB 以内的 PNG、JPG 或 WebP 截图'); return;
    }
    setBusy(true);
    try {
      const url = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result));
        reader.onerror = () => reject(new Error('截图无法读取'));
        reader.readAsDataURL(file);
      });
      const image = new Image(); image.src = url; await image.decode();
      const scale = Math.min(1, 1600 / Math.max(image.width, image.height));
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.round(image.width * scale)); canvas.height = Math.max(1, Math.round(image.height * scale));
      const context = canvas.getContext('2d')!;
      context.fillStyle = '#fff'; context.fillRect(0, 0, canvas.width, canvas.height); context.drawImage(image, 0, 0, canvas.width, canvas.height);
      let data = canvas.toDataURL('image/jpeg', .85);
      if (data.length > 1300000) data = canvas.toDataURL('image/jpeg', .6);
      if (data.length > 1300000) throw new Error('截图过大，请裁剪后重试');
      setScreenshot(data);
    } catch (e) { setError(e instanceof Error ? e.message : '截图无法读取'); }
    finally { setBusy(false); }
  };
  const submit = async () => {
    if (!screenshot || busy || !window.pywebview?.api) return;
    setBusy(true); setError('');
    try { update(await window.pywebview.api.command('report_bug', screenshot.split(',')[1])); setScreenshot(''); }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  };
  return <details className="diagnostic-tools"><summary>报 Bug</summary><div className="diagnostic-panel">
    <label>选择问题截图<input aria-label="选择问题截图" type="file" accept="image/png,image/jpeg,image/webp" disabled={busy} onChange={e => { void choose(e.target.files?.[0]); e.target.value = ''; }} /></label>
    {screenshot && <img className="bug-preview" src={screenshot} alt="待上传的问题截图" />}
    <p>截图将与诊断日志一起提交，保留 7 天。</p>
    <button className="ui-btn" disabled={!connected || busy || !screenshot} onClick={submit}>{busy ? '处理中…' : '提交 Bug'}</button>
    <span role="status">{error || state.diagnostics?.message}</span>
    {state.diagnostics?.report_id && <code>报告编号：{state.diagnostics.report_id}</code>}
  </div></details>;
}

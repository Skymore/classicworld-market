import { useState } from 'react';
import { tr } from './i18n';
import type { State } from './state';

export default function BugReport({ state, connected, update }: { state: State; connected: boolean; update: (state: State) => void }) {
  const [screenshot, setScreenshot] = useState(''), [error, setError] = useState(''), [busy, setBusy] = useState(false);
  const choose = async (file?: File) => {
    setScreenshot(''); setError('');
    if (!file) return;
    if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type) || file.size > 20 * 1024 * 1024) {
      setError(tr('请选择 20 MB 以内的 PNG、JPG 或 WebP 截图', 'Choose a PNG, JPG or WebP screenshot up to 20 MB')); return;
    }
    setBusy(true);
    try {
      const url = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result));
        reader.onerror = () => reject(new Error(tr('截图无法读取', 'The screenshot cannot be read')));
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
      if (data.length > 1300000) throw new Error(tr('截图过大，请裁剪后重试', 'The screenshot is too large; crop it and retry'));
      setScreenshot(data);
    } catch (e) { setError(e instanceof Error ? e.message : tr('截图无法读取', 'The screenshot cannot be read')); }
    finally { setBusy(false); }
  };
  const submit = async () => {
    if (!screenshot || busy || !window.pywebview?.api) return;
    setBusy(true); setError('');
    try { update(await window.pywebview.api.command('report_bug', screenshot.split(',')[1])); setScreenshot(''); }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  };
  const label = tr('选择问题截图', 'Choose a screenshot of the problem');
  return <details className="diagnostic-tools"><summary>{tr('报 Bug', 'Report a bug')}</summary><div className="diagnostic-panel">
    <label>{label}<input aria-label={label} type="file" accept="image/png,image/jpeg,image/webp" disabled={busy} onChange={e => { void choose(e.target.files?.[0]); e.target.value = ''; }} /></label>
    {screenshot && <img className="bug-preview" src={screenshot} alt={tr('待上传的问题截图', 'Screenshot to upload')} />}
    <p>{tr('截图将与诊断日志一起提交，保留 7 天。', 'The screenshot is sent with the diagnostic logs and kept for 7 days.')}</p>
    <button className="ui-btn" disabled={!connected || busy || !screenshot} onClick={submit}>{busy ? tr('处理中…', 'Working…') : tr('提交 Bug', 'Send report')}</button>
    <span role="status">{error || state.diagnostics?.message}</span>
    {state.diagnostics?.report_id && <code>{tr('报告编号：', 'Report ID: ')}{state.diagnostics.report_id}</code>}
  </div></details>;
}

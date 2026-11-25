// The client's grind history: filters, totals, rows with a spark line, one run
// in full, and sharing (link plus a card image).
import { useEffect, useRef, useState } from 'react';
import { ArrowLeft, Copy, Download, Link2, Share2 } from 'lucide-react';
import { RunDetail, type GrindRun } from '../src/components/grind-run';
import { GrindHistory } from '../src/components/grind-history';
import { copyCard, drawCard, saveCard } from '../src/lib/grind-card';
import { language, tr } from './i18n';
import { grind, type RunSummary } from './grind';

type Run = RunSummary & GrindRun & { share_url?: string | null };
const english = () => language() === 'en';

export function HistoryView({ runs, reload }: { runs: Run[] | null; reload(): void }) {
  const [open, setOpen] = useState<string | null>(null);
  if (runs == null) return <p className="note">{tr('读取中…', 'Loading…')}</p>;
  const current = open ? runs.find(r => r.id === open) : null;
  if (!runs.length) return <p className="grind-empty">{tr('还没有记录。进图打几只怪就会自动开始。', 'No runs yet. Kill a few monsters in a map to start.')}</p>;
  // The list stays mounted under an open run, so coming back lands on the same period.
  return <>
    {current && <RunPage run={current} back={() => { setOpen(null); reload(); }} />}
    <section className="stall grind-history-panel" style={current ? { display: 'none' } : undefined}>
      <GrindHistory runs={runs} t={tr} english={english()} idOf={run => run.id} shared={run => !!run.share_url}
        row={(run, className, children) => <button className={className} onClick={() => setOpen(run.id)}>{children}</button>} />
    </section>
  </>;
}

function RunPage({ run, back }: { run: Run; back(): void }) {
  const [sharing, setSharing] = useState(false);
  return <div className="grind-run-page">
    <button className="text-link grind-back" onClick={back}><ArrowLeft size={15} />{tr('历史', 'History')}</button>
    <RunDetail run={run} t={tr} english={english()} actions={
      <button className="ui-btn primary" onClick={() => setSharing(true)}><Share2 size={15} />{tr('分享', 'Share')}</button>} />
    {sharing && <ShareDialog run={run} close={() => setSharing(false)} />}
  </div>;
}

function ShareDialog({ run, close }: { run: Run; close(): void }) {
  const [showName, setShowName] = useState(true), [showProfit, setShowProfit] = useState(true);
  const [url, setUrl] = useState<string | null>(null), [error, setError] = useState(''), [note, setNote] = useState('');
  const canvas = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    let alive = true;
    setUrl(null); setError('');
    grind('share', { id: run.id, show_name: showName, show_profit: showProfit })
      .then(result => { if (alive) setUrl(result.url); })
      .catch(e => { if (alive) setError(String((e as Error)?.message || e)); });
    return () => { alive = false; };
  }, [run.id, showName, showProfit]);
  useEffect(() => {
    if (canvas.current) drawCard(canvas.current, run, { url: url || 'mxd.ruit.me', t: tr, showName, showProfit, english: english() });
  }, [run, url, showName, showProfit]);
  const flash = (text: string) => { setNote(text); setTimeout(() => setNote(''), 2000); };
  return <div className="grind-share-backdrop" role="dialog" aria-modal="true" aria-label={tr('分享这次刷图', 'Share this run')} onClick={close}>
    <div className="grind-share" onClick={e => e.stopPropagation()}>
      <canvas ref={canvas} className="grind-share-card" />
      <div className="grind-share-side">
        <h3>{tr('分享这次刷图', 'Share this run')}</h3>
        <label className="grind-check"><input type="checkbox" checked={showName} onChange={e => setShowName(e.target.checked)} />{tr('显示角色名', 'Show character name')}</label>
        <label className="grind-check"><input type="checkbox" checked={showProfit} onChange={e => setShowProfit(e.target.checked)} />{tr('显示收益', 'Show profit')}</label>
        <input className="grind-share-url" readOnly value={url || (error ? tr('暂时连不上网站', 'The site is unreachable') : tr('正在生成链接…', 'Creating link…'))} onFocus={e => e.target.select()} />
        <button className="ui-btn primary" disabled={!canvas.current} onClick={async () => {
          if (canvas.current && await copyCard(canvas.current)) flash(tr('图片已复制', 'Image copied'));
          else flash(tr('无法复制，请保存图片', "Can't copy; save instead"));
        }}><Copy size={15} />{tr('复制图片', 'Copy image')}</button>
        <button className="ui-btn" disabled={!url} onClick={async () => { await navigator.clipboard.writeText(url!); flash(tr('链接已复制', 'Link copied')); }}>
          <Link2 size={15} />{tr('复制链接', 'Copy link')}</button>
        <button className="ui-btn" onClick={() => canvas.current && saveCard(canvas.current, `grind-${run.id?.slice(0, 8)}.png`)}>
          <Download size={15} />{tr('保存图片', 'Save image')}</button>
        <small className="grind-share-note" role="status">{note}</small>
        <button className="text-link grind-share-close" onClick={close}>{tr('关闭', 'Close')}</button>
      </div>
    </div>
  </div>;
}

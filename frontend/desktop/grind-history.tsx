// The client's grind history: filters, totals, rows with a spark line, one run
// in full, and sharing (link plus a card image).
import { useEffect, useMemo, useRef, useState } from 'react';
import { ArrowLeft, Copy, Download, Link2, Share2 } from 'lucide-react';
import { RunDetail, Spark, big, clock, signed, span, when, type GrindRun } from '../src/components/grind-run';
import { PeriodBoard } from '../src/components/grind-periods';
import { copyCard, drawCard, saveCard } from '../src/lib/grind-card';
import { language, tr } from './i18n';
import { grind, type RunSummary } from './grind';

type Run = RunSummary & GrindRun & { share_url?: string | null };
const english = () => language() === 'en';

export function HistoryView({ runs, reload }: { runs: Run[] | null; reload(): void }) {
  const [open, setOpen] = useState<string | null>(null);
  const [who, setWho] = useState(''), [map, setMap] = useState('');
  const names = useMemo(() => [...new Set((runs || []).map(r => r.character?.name).filter(Boolean) as string[])], [runs]);
  const maps = useMemo(() => [...new Set((runs || []).map(r => r.map_name).filter(Boolean) as string[])], [runs]);
  const filtered = useMemo(() => (runs || []).filter(r => (!who || r.character?.name === who) && (!map || r.map_name === map)), [runs, who, map]);
  if (runs == null) return <p className="note">{tr('读取中…', 'Loading…')}</p>;
  const current = open ? runs.find(r => r.id === open) : null;
  if (!runs.length) return <p className="grind-empty">{tr('还没有记录。进图打几只怪就会自动开始。', 'No runs yet. Kill a few monsters in a map to start.')}</p>;
  // The list stays mounted under an open run, so coming back lands on the same period.
  return <>
    {current && <RunPage run={current} back={() => { setOpen(null); reload(); }} />}
    <section className="stall grind-history-panel" style={current ? { display: 'none' } : undefined}>
      <PeriodBoard runs={filtered} t={tr} english={english()} idOf={run => run.id} filters={<>
        {names.length > 1 && <select value={who} onChange={e => setWho(e.target.value)} aria-label={tr('角色', 'Character')}>
          <option value="">{tr('全部角色', 'All characters')}</option>{names.map(n => <option key={n}>{n}</option>)}</select>}
        {maps.length > 1 && <select value={map} onChange={e => setMap(e.target.value)} aria-label={tr('地图', 'Map')}>
          <option value="">{tr('全部地图', 'All maps')}</option>{maps.map(n => <option key={n}>{n}</option>)}</select>}
      </>}>{(shown, picks) => <div className="grind-history-list" role="list">
        <div className="gp-line" aria-hidden="true">{picks && <span className="gp-pick" />}<div className="grind-history-row head">
          <span>{tr('时间', 'Time')}</span><span>{tr('地图 · 角色', 'Map · character')}</span><span>{tr('时长', 'Time')}</span>
          <span>{tr('经验/时', 'EXP/h')}</span><span>{tr('收益/时', 'Profit/h')}</span><span>{tr('击杀', 'Kills')}</span><span />
        </div></div>
        {shown.map(run => <div className="gp-line" key={run.id} role="listitem">
          {picks && <label className="gp-pick" title={tr('勾两场对比', 'Tick two to compare')}><input type="checkbox" checked={picks.has(run.id)}
            disabled={picks.full && !picks.has(run.id)} onChange={() => picks.toggle(run.id)} aria-label={tr('选这一场对比', 'Compare this run')} /></label>}
          <button className="grind-history-row" onClick={() => setOpen(run.id)}>
          <span>{when(run.started_at)}</span>
          <span className="who"><b>{run.map_name || '—'}</b>{run.segments?.length > 1 && <small> +{run.segments.length - 1}</small>}
            <small> {run.character?.name} · {run.job_name} {run.level ?? ''}</small>{run.share_url && <i className="shared">{tr('已分享', 'Shared')}</i>}</span>
          <span>{span(run.active_seconds, english())}</span><span>{big(run.exp_per_hour, english())}</span>
          <span className={run.net_per_hour ? "money" : undefined}>{signed(run.net_per_hour, english())}</span><span>{big(run.kills, english())}</span>
          <Spark run={run} />
        </button></div>)}
      </div>}</PeriodBoard>
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

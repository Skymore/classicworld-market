// The client's grind history: filters, totals, rows with a spark line, one run
// in full, and sharing (link plus a card image).
import { useEffect, useState } from 'react';
import { ArrowLeft, Share2 } from 'lucide-react';
import { RunDetail, type Comparison, type GrindRun } from '../src/components/grind-run';
import { GrindShare } from '../src/components/grind-share';
import { GrindHistory } from '../src/components/grind-history';
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
  const [sharing, setSharing] = useState(false), [comparison, setComparison] = useState<Comparison | null>(null);
  // The line comparing this run with others on its map comes from the site (only it has their runs).
  useEffect(() => {
    let alive = true;
    setComparison(null);
    grind('compare', run.id).then(found => { if (alive) setComparison(found || null); }).catch(() => {});
    return () => { alive = false; };
  }, [run.id]);
  return <div className="grind-run-page">
    <button className="text-link grind-back" onClick={back}><ArrowLeft size={15} />{tr('历史', 'History')}</button>
    <RunDetail run={run} t={tr} english={english()} comparison={comparison} actions={
      <button className="ui-btn primary" aria-expanded={sharing} onClick={() => setSharing(!sharing)}><Share2 size={15} />{tr('分享', 'Share')}</button>} />
    {sharing && <GrindShare run={run} t={tr} english={english()} button="ui-btn" file={`grind-${run.id?.slice(0, 8)}.png`}
      create={options => grind('share', { id: run.id, ...options })}
      openPage={link => void grind('open_share', link.code).catch(() => {})} />}
  </div>;
}

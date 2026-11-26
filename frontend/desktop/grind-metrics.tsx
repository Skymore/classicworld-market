import { timelineRates } from './grind';
import { MesosIcon } from './mesos-icon';
import { useEffect, useState } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { Coins, Sparkles, Trophy } from 'lucide-react';
import { points as pointsTotal, pointsHistory, pointsPerHour, pointsSum, pointsText, type PointsRule } from '../src/components/grind-points';
import { Info } from 'lucide-react';
import { big, type RunSummary } from './grind';
import { tr } from './i18n';
import './grind-metrics.css';
import { smoothPath, smoothRates } from '../src/components/smooth-path';

/** Hourly rates over the whole run (timeline buckets); older summaries only had the last 20 minutes. */
export function rateHistory(run: RunSummary): { t: number; exp: number; net: number }[] {
  const line = run.timeline;
  if (!line || line.exp.length < 2) return run.rate_history || [];
  return timelineRates(line);
}

/** One rate as a label, a large live number and the session average; the mark says which way the live rate leans. */
const signed = (value: number | null | undefined) => value == null ? '—' : (value > 0 ? '+' : '') + big(value);

type Kind = 'exp' | 'net' | 'points';

/** A block's numbers: name, run total, average and last-minute rate per hour, and the trend. */
function series(run: RunSummary, kind: Kind, rule?: PointsRule) {
  const scored = kind === 'points' && rule ? rule : null;
  const history = scored ? smoothRates(pointsHistory(run, scored).map(p => ({ t: p.t, v: p.value })), ['v'])
    : smoothRates(rateHistory(run), ['exp', 'net']).map(p => ({ t: p.t, v: kind === 'exp' ? p.exp : p.net }));
  return {
    scored, history,
    fmt: scored ? (v: number | null | undefined) => pointsText(v, big) : (v: number | null | undefined) => big(v ?? null),
    name: kind === 'exp' ? tr('经验', 'EXP') : scored ? tr('积分', 'Points') : tr('金币净收益', 'Net mesos'),
    short: kind === 'exp' ? tr('经验', 'EXP') : scored ? tr('积分', 'Points') : tr('净收益', 'Net'),
    total: kind === 'exp' ? run.exp : scored ? pointsTotal(run, scored) : run.net,
    average: kind === 'exp' ? run.exp_per_hour : scored ? pointsPerHour(run, scored) : run.net_per_hour,
    // 积分's last minute is the chart's last point while the run goes on.
    minute: kind === 'exp' ? run.exp_per_hour_1m : scored ? (run.status === 'active' ? history.at(-1)?.v ?? null : null) : run.net_per_hour_1m,
  };
}

/** A folded block: one line with the average (highlighted), the last minute and the total. */
function FoldedLine({ name, title, average, minute, total, fmt }: { name: string; title: React.ReactNode; average: number | null | undefined; minute: number | null | undefined; total: number; fmt(v: number | null | undefined): string }) {
  return <section className="rate-metrics folded" aria-label={name}>{title}
    <span><small>{tr('平均', 'Avg')}</small><b>{fmt(average)}</b></span>
    <span><small>{tr('实时', 'Live')}</small><b>{fmt(minute)}</b></span>
    <span><small>{tr('累计', 'Total')}</small><b>{fmt(total)}</b></span></section>;
}

function FoldTitle({ kind, folded, fold, label, icon, className }: { kind: Kind; folded: boolean; fold(): void; label: string; icon?: boolean; className: string }) {
  const mark = kind === 'exp' ? <Sparkles size={13} /> : kind === 'points' ? <Trophy size={13} /> : <MesosIcon size={13} />;
  // data-press: on the overlay the game window in front keeps clicks from the page; the client
  // reads them from the system mouse and presses the button by this id (overlay.tsx).
  return <button type="button" className={className} aria-expanded={!folded} onClick={fold} data-press={`fold-${kind}`}
    onMouseDown={e => e.stopPropagation() /* not the overlay's drag-to-move */}>
    {folded ? <ChevronRight size={13} className="rate-fold" /> : <ChevronDown size={13} className="rate-fold" />}{icon && mark}{label}</button>;
}

/** ⓘ on the 积分 block: pressed (hover never reaches the overlay), it opens how this run's points add up. */
function PointsInfo({ open, toggle }: { open: boolean; toggle(): void }) {
  return <button type="button" className="ov-info" aria-expanded={open} aria-label={tr('积分怎么算', 'How points are counted')}
    data-press="points-info" onMouseDown={e => e.stopPropagation()} onClick={toggle}><Info size={13} /></button>;
}
const PointsSum = ({ run, rule }: { run: RunSummary; rule: PointsRule }) =>
  <div className="ov-info-text">{pointsSum(run, rule, big, tr).split('\n').map((line, i) => <div key={i}>{line}</div>)}</div>;

export function RateStat({ run, kind, side, rule }: { run: RunSummary; kind: Kind; side?: React.ReactNode; rule?: PointsRule }) {
  const [folded, fold] = useFolded(kind);
  const [info, setInfo] = useState(false);
  const { name, short, total, average, minute, history, fmt } = series(run, kind, rule);
  if (folded) return <FoldedLine name={name} average={average} minute={minute} total={total} fmt={fmt}
    title={<FoldTitle kind={kind} folded fold={fold} label={short} icon className="rate-title" />} />;
  const values = history.map(p => p.v);
  const low = Math.min(...values, average ?? Infinity), span = Math.max(1, Math.max(...values, average ?? -Infinity) - low);
  const y = (value: number) => 22 - (value - low) / span * 20;
  const points = values.map((v, i) => `${i / Math.max(1, values.length - 1) * 100},${y(v)}`).join(' ');
  // As 枫记 lays it out: the label; the run's average (big, steady) with an arrow for the
  // last minute against it, the run's total on the right; below, two columns: `side` on the
  // left (time to the next level, or mesos picked up), the last minute ("实时") over the trend
  // line on the right.
  const trend = minute != null && average ? (minute >= average ? 'up' : 'down') : null;
  return <div className="ov-stat" aria-label={name}>
    <div className="ov-stat-top"><FoldTitle kind={kind} folded={false} fold={fold} label={`${short}/${tr('时', 'h')}`} className="ov-stat-label" />
      {rule && kind === 'points' && <PointsInfo open={info} toggle={() => setInfo(!info)} />}</div>
    {rule && kind === 'points' && info && <PointsSum run={run} rule={rule} />}
    <div className="ov-stat-mid"><span className="ov-avg"><b className="gold">{fmt(average ?? minute)}</b>
      {trend && <i className={'rate-trend ' + trend}>{trend === 'up' ? '▲' : '▼'}</i>}</span>
      <span className="ov-total">{short} <b>{kind === 'points' ? fmt(total) : signed(total)}</b></span></div>
    {/* Always two columns, so every card's chart has the same size and place (积分 has no side figure). */}
    <div className="ov-trend-row split">
    <div className="ov-side">{side}</div>
    <div className="ov-trend-box">
    {minute != null && <span className="ov-live dim">{tr('实时', 'live')} <b>{fmt(minute)}</b>/h</span>}
    {values.length > 1 && <svg className="ov-trend" viewBox="0 0 100 24" preserveAspectRatio="none" aria-hidden="true">
      <path d={`${smoothPath(points)} L100,24 L0,24 Z`} fill="currentColor" opacity=".1" />
      {average != null && <line x1="0" x2="100" y1={y(average)} y2={y(average)} stroke="currentColor" opacity=".4" strokeDasharray="3 3" vectorEffect="non-scaling-stroke" />}
      <path d={smoothPath(points)} fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" vectorEffect="non-scaling-stroke" /></svg>}
    </div></div>
  </div>;
}

/** Each block can be folded to one line; remembered per block and shared by the page and the overlay. */
const FOLD_KEY = (kind: string) => `grind.metric.${kind}.folded`;
function useFolded(kind: string): [boolean, () => void] {
  const read = () => { try { return localStorage.getItem(FOLD_KEY(kind)) === '1'; } catch { return false; } };
  const [folded, setFolded] = useState(read);
  useEffect(() => {
    const sync = (e: StorageEvent) => { if (e.key === FOLD_KEY(kind)) setFolded(read()); };
    window.addEventListener('storage', sync);
    return () => window.removeEventListener('storage', sync);
  }, [kind]);
  return [folded, () => {
    const next = !folded;
    setFolded(next);
    try { localStorage.setItem(FOLD_KEY(kind), next ? '1' : '0'); } catch { /* storage unavailable */ }
  }];
}

/** 经验, 净收益 or 积分 (绩效模式, weighted by `rule`) as a block with the run's trend. */
export function RateMetrics({ run, kind, rule }: { run: RunSummary; kind: Kind; rule?: PointsRule }) {
  const [selected, setSelected] = useState<number | null>(null);
  const [folded, fold] = useFolded(kind);
  const [info, setInfo] = useState(false);
  const { name, short, total, average, minute, history, fmt } = series(run, kind, rule);
  const values = history.map(p => p.v);
  const minimum = Math.min(...(values.length ? values : [minute ?? 0])), maximum = Math.max(...(values.length ? values : [minute ?? 0]));
  const padding = Math.max(1, (maximum - minimum) * .12, Math.abs(maximum) * .01);
  const low = minimum - padding, high = maximum + padding, range = high - low;
  const y = (value: number) => 68 - (value - low) / range * 60;
  const start = history[0]?.t || 0, span = Math.max(1, (history.at(-1)?.t || 0) - start);
  const x = (t: number) => 2 + (t - start) / span * 296;
  const points = history.map(p => `${x(p.t)},${y(p.v)}`).join(' ');
  const active = selected == null ? null : history[Math.min(selected, history.length - 1)];
  const peak = history.length > 1 ? history.reduce((best, p) => p.v > best.v ? p : best, history[0]) : null;
  const hhmm = (t: number) => new Date(t * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
  const left = (t: number) => `${x(t) / 3}%`, top = (v: number) => `${y(v) / .76}%`;
  const yTicks = [high - padding, (high + low) / 2, low + padding];
  const title = <FoldTitle kind={kind} folded={folded} fold={fold} label={short} icon className="rate-title" />;
  if (folded) return <FoldedLine name={name} title={title} average={average} minute={minute} total={total} fmt={fmt} />;
  return <section className="rate-metrics" aria-label={name}>
    {rule && kind === 'points' ? <><div className="rate-title-row">{title}<PointsInfo open={info} toggle={() => setInfo(!info)} /></div>
      {info && <PointsSum run={run} rule={rule} />}</> : title}
    <div className="rate-values">
      <div><small>{tr('平均/时', 'Average/h')}</small><b>{fmt(average)}</b></div>
      <div><small>{tr('实时/时', 'Live/h')}</small><b>{fmt(minute ?? null)}</b></div>
      <div><small>{tr('累计', 'Total')}</small><b>{fmt(total)}</b></div>
    </div>
    <div className="rate-plot" onPointerLeave={() => setSelected(null)}>
    {history.length > 1 && <div className="rate-axis-y" aria-hidden="true">{yTicks.map((v, i) => <span key={i} style={{ top: top(v) }}>{fmt(v)}</span>)}</div>}
    {active && <output className="rate-tooltip">{new Date(active.t * 1000).toLocaleTimeString()} · {fmt(active.v)}/h</output>}
    <div className="rate-canvas">
    {peak && peak.v > 0 && <span className={'rate-peak' + (x(peak.t) < 60 ? ' start' : x(peak.t) > 240 ? ' end' : '')} style={{ left: left(peak.t), top: top(peak.v) }} title={`${tr('最高', 'Peak')} ${hhmm(peak.t)}`}><i />{tr('最高', 'Peak')} {fmt(peak.v)}</span>}
    <svg className="rate-chart" viewBox="0 0 300 76" tabIndex={0} onBlur={() => setSelected(null)}
      onKeyDown={e => { if (['ArrowLeft', 'ArrowRight'].includes(e.key)) { e.preventDefault(); setSelected(Math.max(0, Math.min(history.length - 1, (selected ?? history.length - 1) + (e.key === 'ArrowLeft' ? -1 : 1)))); } }}
      onPointerMove={e => { const box = e.currentTarget.getBoundingClientRect(); const t = start + Math.max(0, Math.min(1, (e.clientX - box.left) / box.width)) * span; if (history.length) setSelected(history.reduce((best, p, i) => Math.abs(p.t - t) < Math.abs(history[best].t - t) ? i : best, 0)); }} preserveAspectRatio="none" role="img" aria-label={tr(`${name}整场每小时趋势`, `${name} hourly rate over the whole run`)}>
      {low <= 0 && high >= 0 && <line x1="2" x2="298" y1={y(0)} y2={y(0)} stroke="currentColor" opacity=".2" />}
      {average != null && average >= low && average <= high && <line x1="2" x2="298" y1={y(average)} y2={y(average)} stroke="currentColor" opacity=".45" strokeDasharray="4 3"><title>{tr('本次平均', 'Session average')} {fmt(average)}/h</title></line>}
      {history.length > 1 && <path d={smoothPath(points)} fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" vectorEffect="non-scaling-stroke" />}
      {active && <g className="rate-cursor"><line x1={x(active.t)} x2={x(active.t)} y1="4" y2="72" stroke="currentColor" opacity=".4" /><circle cx={x(active.t)} cy={y(active.v)} r="3" fill="currentColor" /></g>}
      {yTicks.map((v, i) => <line key={i} x1="2" x2="298" y1={y(v)} y2={y(v)} stroke="currentColor" opacity=".08" vectorEffect="non-scaling-stroke" />)}
    </svg></div>
    {history.length > 1 && <div className="rate-axis-x" aria-hidden="true"><span>{hhmm(start)}</span><span>{hhmm(start + span / 2)}</span><span>{hhmm(start + span)}</span></div>}
    </div>
  </section>;
}

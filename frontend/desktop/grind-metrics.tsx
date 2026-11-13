import { timelineRates } from './grind';
import { MesosIcon } from './mesos-icon';
import { useState } from 'react';
import { Coins, Sparkles } from 'lucide-react';
import { big, type RunSummary } from './grind';
import { tr } from './i18n';
import './grind-metrics.css';

/** Hourly rates over the whole run (timeline buckets); older summaries only had the last 20 minutes. */
export function rateHistory(run: RunSummary): { t: number; exp: number; net: number }[] {
  const line = run.timeline;
  if (!line || line.exp.length < 2) return run.rate_history || [];
  return timelineRates(line);
}

/** One rate as a label, a large live number and the session average; the mark says which way the live rate leans. */
export function RateStat({ run, kind }: { run: RunSummary; kind: 'exp' | 'net' }) {
  const average = kind === 'exp' ? run.exp_per_hour : run.net_per_hour;
  const minute = kind === 'exp' ? run.exp_per_hour_1m : run.net_per_hour_1m;
  const values = rateHistory(run).map(p => p[kind]);
  const low = Math.min(...values, average ?? Infinity), span = Math.max(1, Math.max(...values, average ?? -Infinity) - low);
  const y = (value: number) => 22 - (value - low) / span * 20;
  const points = values.map((v, i) => `${i / Math.max(1, values.length - 1) * 100},${y(v)}`).join(' ');
  return <div className="ov-stat" aria-label={kind === 'exp' ? tr('经验', 'EXP') : tr('金币净收益', 'Net mesos')}>
    <small>{kind === 'exp' ? tr('经验/时', 'EXP/h') : tr('收益/时', 'Profit/h')}</small>
    <b className="gold">{big(minute ?? average)}</b>
    <span className="dim">{tr('平均', 'avg')} {big(average)}
      {minute != null && average ? <i className={'rate-trend ' + (minute >= average ? 'up' : 'down')}>{minute >= average ? '▲' : '▼'}</i> : null}</span>
    {values.length > 1 && <svg className="ov-trend" viewBox="0 0 100 24" preserveAspectRatio="none" aria-hidden="true">
      <polygon points={`0,24 ${points} 100,24`} fill="currentColor" opacity=".1" />
      {average != null && <line x1="0" x2="100" y1={y(average)} y2={y(average)} stroke="currentColor" opacity=".4" strokeDasharray="3 3" vectorEffect="non-scaling-stroke" />}
      <polyline points={points} fill="none" stroke="currentColor" strokeWidth="1.5" vectorEffect="non-scaling-stroke" /></svg>}
  </div>;
}

export function RateMetrics({ run, kind }: { run: RunSummary; kind: 'exp' | 'net' }) {
  const [selected, setSelected] = useState<number | null>(null);
  const name = kind === 'exp' ? tr('经验', 'EXP') : tr('金币净收益', 'Net mesos');
  const total = kind === 'exp' ? run.exp : run.net;
  const average = kind === 'exp' ? run.exp_per_hour : run.net_per_hour;
  const minute = kind === 'exp' ? run.exp_per_hour_1m : run.net_per_hour_1m;
  const history = rateHistory(run);
  const values = history.map(p => p[kind]);
  const minimum = Math.min(...(values.length ? values : [minute ?? 0])), maximum = Math.max(...(values.length ? values : [minute ?? 0]));
  const padding = Math.max(1, (maximum - minimum) * .12, Math.abs(maximum) * .01);
  const low = minimum - padding, high = maximum + padding, range = high - low;
  const y = (value: number) => 68 - (value - low) / range * 60;
  const start = history[0]?.t || 0, span = Math.max(1, (history.at(-1)?.t || 0) - start);
  const x = (t: number) => 2 + (t - start) / span * 296;
  const points = history.map(p => `${x(p.t)},${y(p[kind])}`).join(' ');
  const active = selected == null ? null : history[Math.min(selected, history.length - 1)];
  const peak = history.length > 1 ? history.reduce((best, p) => p[kind] > best[kind] ? p : best, history[0]) : null;
  const hhmm = (t: number) => new Date(t * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
  const left = (t: number) => `${x(t) / 3}%`, top = (v: number) => `${y(v) / .76}%`;
  const yTicks = [high - padding, (high + low) / 2, low + padding];
  return <section className="rate-metrics" aria-label={name}>
    <b className="rate-title">{kind === 'exp' ? <Sparkles size={13} /> : <MesosIcon size={13} />}{kind === 'exp' ? name : tr('净收益', 'Net')}</b>
    <div className="rate-values">
      <div><small>{tr('平均/时', 'Average/h')}</small><b>{big(average)}</b></div>
      <div><small>{tr('实时/时', 'Live/h')}</small><b>{big(minute ?? null)}</b></div>
      <div><small>{tr('累计', 'Total')}</small><b>{big(total)}</b></div>
    </div>
    <div className="rate-plot" onPointerLeave={() => setSelected(null)}>
    {history.length > 1 && <div className="rate-axis-y" aria-hidden="true">{yTicks.map((v, i) => <span key={i} style={{ top: top(v) }}>{big(v)}</span>)}</div>}
    {active && <output className="rate-tooltip">{new Date(active.t * 1000).toLocaleTimeString()} · {big(active[kind])}/h</output>}
    <div className="rate-canvas">
    {peak && peak[kind] > 0 && <span className={'rate-peak' + (x(peak.t) < 60 ? ' start' : x(peak.t) > 240 ? ' end' : '')} style={{ left: left(peak.t), top: top(peak[kind]) }} title={`${tr('最高', 'Peak')} ${hhmm(peak.t)}`}><i />{tr('最高', 'Peak')} {big(peak[kind])}</span>}
    <svg className="rate-chart" viewBox="0 0 300 76" tabIndex={0} onBlur={() => setSelected(null)}
      onKeyDown={e => { if (['ArrowLeft', 'ArrowRight'].includes(e.key)) { e.preventDefault(); setSelected(Math.max(0, Math.min(history.length - 1, (selected ?? history.length - 1) + (e.key === 'ArrowLeft' ? -1 : 1)))); } }}
      onPointerMove={e => { const box = e.currentTarget.getBoundingClientRect(); const t = start + Math.max(0, Math.min(1, (e.clientX - box.left) / box.width)) * span; if (history.length) setSelected(history.reduce((best, p, i) => Math.abs(p.t - t) < Math.abs(history[best].t - t) ? i : best, 0)); }} preserveAspectRatio="none" role="img" aria-label={tr(`${name}整场每小时趋势`, `${name} hourly rate over the whole run`)}>
      {low <= 0 && high >= 0 && <line x1="2" x2="298" y1={y(0)} y2={y(0)} stroke="currentColor" opacity=".2" />}
      {average != null && average >= low && average <= high && <line x1="2" x2="298" y1={y(average)} y2={y(average)} stroke="currentColor" opacity=".45" strokeDasharray="4 3"><title>{tr('本次平均', 'Session average')} {big(average)}/h</title></line>}
      {history.length > 1 && <polyline points={points} fill="none" stroke="currentColor" strokeWidth="1.6" vectorEffect="non-scaling-stroke" />}
      {active && <g className="rate-cursor"><line x1={x(active.t)} x2={x(active.t)} y1="4" y2="72" stroke="currentColor" opacity=".4" /><circle cx={x(active.t)} cy={y(active[kind])} r="3" fill="currentColor" /></g>}
      {yTicks.map((v, i) => <line key={i} x1="2" x2="298" y1={y(v)} y2={y(v)} stroke="currentColor" opacity=".08" vectorEffect="non-scaling-stroke" />)}
    </svg></div>
    {history.length > 1 && <div className="rate-axis-x" aria-hidden="true"><span>{hhmm(start)}</span><span>{hhmm(start + span / 2)}</span><span>{hhmm(start + span)}</span></div>}
    </div>
  </section>;
}

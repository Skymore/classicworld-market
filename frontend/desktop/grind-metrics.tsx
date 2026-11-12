import { MesosIcon } from './mesos-icon';
import { useState } from 'react';
import { Coins, Sparkles } from 'lucide-react';
import { big, type RunSummary } from './grind';
import { tr } from './i18n';
import './grind-metrics.css';

export function RateMetrics({ run, kind }: { run: RunSummary; kind: 'exp' | 'net' }) {
  const [selected, setSelected] = useState<number | null>(null);
  const name = kind === 'exp' ? tr('经验', 'EXP') : tr('金币净收益', 'Net mesos');
  const total = kind === 'exp' ? run.exp : run.net;
  const average = kind === 'exp' ? run.exp_per_hour : run.net_per_hour;
  const minute = kind === 'exp' ? run.exp_per_hour_1m : run.net_per_hour_1m;
  const history = run.rate_history || [];
  const values = history.map(p => p[kind]);
  const minimum = Math.min(...(values.length ? values : [minute ?? 0])), maximum = Math.max(...(values.length ? values : [minute ?? 0]));
  const padding = Math.max(1, (maximum - minimum) * .12, Math.abs(maximum) * .01);
  const low = minimum - padding, high = maximum + padding, range = high - low;
  const y = (value: number) => 68 - (value - low) / range * 60;
  const start = history[0]?.t || 0, span = Math.max(1, (history.at(-1)?.t || 0) - start);
  const x = (t: number) => 2 + (t - start) / span * 296;
  const points = history.map(p => `${x(p.t)},${y(p[kind])}`).join(' ');
  const active = selected == null ? null : history[Math.min(selected, history.length - 1)];
  return <section className="rate-metrics" aria-label={name}>
    <b className="rate-title">{kind === 'exp' ? <Sparkles size={13} /> : <MesosIcon size={13} />}{kind === 'exp' ? name : tr('净收益', 'Net')}</b>
    <div className="rate-values">
      <div><small>{tr('平均/时', 'Average/h')}</small><b>{big(average)}</b></div>
      <div><small>{tr('实时/时', 'Live/h')}</small><b>{big(minute ?? null)}</b></div>
      <div><small>{tr('累计', 'Total')}</small><b>{big(total)}</b></div>
    </div>
    <div className="rate-plot" onPointerLeave={() => setSelected(null)}>
    {active && <output className="rate-tooltip">{new Date(active.t * 1000).toLocaleTimeString()} · {big(active[kind])}/h</output>}
    <svg className="rate-chart" viewBox="0 0 300 76" tabIndex={0} onBlur={() => setSelected(null)}
      onKeyDown={e => { if (['ArrowLeft', 'ArrowRight'].includes(e.key)) { e.preventDefault(); setSelected(Math.max(0, Math.min(history.length - 1, (selected ?? history.length - 1) + (e.key === 'ArrowLeft' ? -1 : 1)))); } }}
      onPointerMove={e => { const box = e.currentTarget.getBoundingClientRect(); const t = start + Math.max(0, Math.min(1, (e.clientX - box.left) / box.width)) * span; if (history.length) setSelected(history.reduce((best, p, i) => Math.abs(p.t - t) < Math.abs(history[best].t - t) ? i : best, 0)); }} preserveAspectRatio="none" role="img" aria-label={tr(`${name}近1分钟折算每小时趋势`, `${name} rolling 1-minute hourly rate`)}>
      {low <= 0 && high >= 0 && <line x1="2" x2="298" y1={y(0)} y2={y(0)} stroke="currentColor" opacity=".2" />}
      {average != null && average >= low && average <= high && <line x1="2" x2="298" y1={y(average)} y2={y(average)} stroke="currentColor" opacity=".45" strokeDasharray="4 3"><title>{tr('本次平均', 'Session average')} {big(average)}/h</title></line>}
      {history.length > 1 && <polyline points={points} fill="none" stroke="currentColor" strokeWidth="1.6" vectorEffect="non-scaling-stroke" />}
      {active && <g className="rate-cursor"><line x1={x(active.t)} x2={x(active.t)} y1="4" y2="72" stroke="currentColor" opacity=".4" /><circle cx={x(active.t)} cy={y(active[kind])} r="3" fill="currentColor" /></g>}
    </svg></div>
  </section>;
}

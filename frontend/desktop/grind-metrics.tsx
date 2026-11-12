import { big, type RunSummary } from './grind';
import { tr } from './i18n';
import './grind-metrics.css';

export function RateMetrics({ run, kind }: { run: RunSummary; kind: 'exp' | 'net' }) {
  const name = kind === 'exp' ? tr('经验', 'EXP') : tr('金币净收益', 'Net mesos');
  const total = kind === 'exp' ? run.exp : run.net;
  const average = kind === 'exp' ? run.exp_per_hour : run.net_per_hour;
  const minute = kind === 'exp' ? run.exp_per_hour_1m : run.net_per_hour_1m;
  const history = run.rate_history || [];
  const values = history.map(p => p[kind]);
  const low = Math.min(0, ...values), high = Math.max(1, ...values), range = high - low;
  const y = (value: number) => 34 - (value - low) / range * 30;
  const start = history[0]?.t || 0, span = Math.max(1, (history.at(-1)?.t || 0) - start);
  const points = history.map(p => `${2 + (p.t - start) / span * 296},${y(p[kind])}`).join(' ');
  return <section className="rate-metrics" aria-label={name}>
    <b className="rate-title">{name}</b>
    <div className="rate-values">
      <div><small>{tr('本次累计', 'Total')}</small><b>{big(total)}</b></div>
      <div><small>{tr('平均/时', 'Average/h')}</small><b>{big(average)}</b></div>
      <div><small>{tr('近1分/时', 'Last 1m/h')}</small><b>{big(minute ?? null)}</b></div>
    </div>
    <svg className="rate-chart" viewBox="0 0 300 38" preserveAspectRatio="none" role="img" aria-label={tr(`${name}近1分钟折算每小时趋势`, `${name} rolling 1-minute hourly rate`)}>
      <title>{tr('最近5分钟 · 每点为此前1分钟折算每小时', 'Last 5 minutes · each point scales the preceding minute to an hourly rate')}</title>
      <line x1="2" x2="298" y1={y(0)} y2={y(0)} stroke="currentColor" opacity=".2" />
      {history.length > 1 && <polyline points={points} fill="none" stroke="currentColor" strokeWidth="1.6" vectorEffect="non-scaling-stroke" />}
    </svg>
    {!history.length && <small className="rate-wait">{tr('等待30秒数据', 'Waiting for 30s of data')}</small>}
  </section>;
}

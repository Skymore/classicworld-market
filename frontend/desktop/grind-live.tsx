// The live grind view: the client's 刷图 · 实时 page and the website's live
// pages render this same component (the site wraps it in .grind-live-view and
// imports grind-live.css, generated from style.css by scripts/live-css.py).
import { useEffect, useState } from 'react';
import { MesosIcon } from './mesos-icon';
import { PartyMetrics } from './party-metrics';
import { mobIcon, skillIcon } from './skill-icons';
import { RateMetrics } from './grind-metrics';
import { itemIcon } from './format';
import { tr } from './i18n';
import { big, clock, duration, mapLabel, percent, shownBuffs, statLine, type Live, type RunSummary } from './grind';

function Tile({ label, value, note, strong }: { label: string; value: string; note?: string; strong?: boolean }) {
  return <div className={'grind-tile' + (strong ? ' strong' : '')}><small>{label}</small><b>{value}</b>{note && <span>{note}</span>}</div>;
}

export function LiveView({ run, live, warn }: { run: RunSummary | null; live: Live | null; warn: number }) {
  if (!run) return <div className="grind-empty">
    <p>{tr('进图打几只怪就会自动开始记录。', 'Kill a few monsters in a map and recording starts by itself.')}</p>
    {live?.finished?.[0] && <p className="note">{tr('上一次：', 'Last run: ')}{mapLabel(live.finished[0])} · {clock(live.finished[0].active_seconds)} · {big(live.finished[0].exp_per_hour)} EXP/h</p>}
  </div>;
  const name = run.character.name || tr('角色', 'Character');
  return <>
    <div className="grind-who">
      <b>{name}</b><span>{run.job_name || '—'} · Lv.{run.level ?? '—'}</span><span>{mapLabel(run)}</span>
      {run.gaps > 0 && <span className="warn">{tr(`${run.gaps} 处背包缺口`, `${run.gaps} inventory gaps`)}</span>}
      {run.pending_prices > 0 && <span className="note">{tr(`${run.pending_prices} 件等待价格`, `${run.pending_prices} awaiting prices`)}</span>}
    </div>
    <div className="grind-tiles">
      <Tile label={tr('有效时长', 'Active')} value={clock(run.active_seconds)} note={tr(`空闲 ${clock(run.idle_seconds)}`, `idle ${clock(run.idle_seconds)}`)} />
      <Tile label={tr('等级进度', 'Level')} value={percent(run.exp_percent)}
        note={tr(`${percent(run.percent_per_hour)}/时 · 升级 ${duration(run.eta_seconds)}`, `${percent(run.percent_per_hour)}/h · up in ${duration(run.eta_seconds)}`)} />
      <Tile label={run.kills_estimated ? tr('击杀（按经验）', 'Kills (by EXP)') : tr('击杀', 'Kills')} value={big(run.kills)}
        note={tr(`${big(run.kills_per_hour)}/时`, `${big(run.kills_per_hour)}/h`) + (run.deaths ? tr(` · 死亡 ${run.deaths}`, ` · ${run.deaths} deaths`) : '')} />
      <Tile strong label={tr('DPS · 近1分', 'DPS · last 1m')} value={big(run.dps)}
        note={tr(`平均 ${big(run.average_dps)}`, `avg ${big(run.average_dps)}`)} />
    </div>
    <BuffStrip live={live} warn={warn} />
    <div className="grind-rate-panels"><RateMetrics run={run} kind="exp" /><RateMetrics run={run} kind="net" /></div>
    <div className="grind-grid grind-accounts">
      <section className="well">
        <div className="well-h"><h3>{tr('本次战利品', 'Loot this run')}</h3><b className="amount money">+{big(run.mesos + run.item_value)} <MesosIcon size={12} /></b></div>
        {run.mesos > 0 && <div className="grind-row grind-account-row grind-mesos"><MesosIcon size={24} /><span className="t"><b>{tr('金币', 'Mesos')}</b></span><span /><span className="amount">+{big(run.mesos)} <MesosIcon size={12} /></span></div>}
        {byValue(run.loot || run.recent || []).map((row, i) => <div className={'grind-row grind-account-row' + (row.notable ? ' notable' : '')} key={i}>
          <img src={itemIcon(row.item_id)} alt="" width={24} height={24} loading="lazy" />
          <span className="t"><b>{row.name}</b>{row.stats?.length ? <small className="stats"> {statLine(row.stats)}</small> : null}</span>
          <span className="quantity">×{row.quantity}</span><span className="amount" title={row.basis || ''}>{row.priced === false || !row.basis || row.basis === '无价格' ? <small>{tr('待估价', 'Unpriced')}</small> : <>+{big(row.value)} <MesosIcon size={12} aria-label={tr('金币', 'mesos')} /></>}</span>
        </div>)}
        {!run.mesos && !(run.loot || run.recent)?.length && <p className="note">{tr('还没有拾取。', 'Nothing picked up yet.')}</p>}
      </section>
      <section className="well">
        <div className="well-h"><h3>{tr('消耗品', 'Consumables')}</h3><b className="amount money">−{big(run.consume_cost)} <MesosIcon size={12} /></b></div>
        {run.consumables.filter(row => row.used > 0).sort((a, b) => (b.cost ?? 0) - (a.cost ?? 0) || b.used - a.used).map(row => <div className="grind-row grind-account-row" key={row.item_id}>
          <img src={itemIcon(row.item_id)} alt="" width={24} height={24} loading="lazy" />
          <span className="t"><b>{row.name}</b></span>
          <span className="quantity">×{row.used}</span><span className="amount">−{big(row.cost ?? null)} <MesosIcon size={12} aria-label={tr('金币', 'mesos')} /></span>
        </div>)}
        {!run.consumables.some(row => row.used > 0) && <p className="note">{tr('还没有使用消耗品。', 'No consumables used yet.')}</p>}
      </section>
      <section className="well grind-kills">
        <div className="well-h"><h3>{tr('击杀', 'Kills')}</h3>
          {run.hp_drops > 0 && <small>{tr(`HP 下降 ${run.hp_drops} 次 · 共 ${big(run.hp_lost)}`, `HP lost ${run.hp_drops}× · ${big(run.hp_lost)}`)}</small>}</div>
        {run.mobs.map(m => <div key={m.mob_id}><div className="grind-row"><img src={mobIcon(m.mob_id)} width={24} height={24} alt="" /><span className="t"><b>{m.name}</b></span><span className="v">×{m.kills}</span></div>{!!m.attack_samples && <details className="grind-attack-distribution"><summary title={tr('可见范围内独立击杀；一次技能的多段伤害计为一次攻击', 'Observed solo kills; multi-hit skills count as one attack')}>{tr('平均', 'Average')} {(m.attack_distribution!.reduce((sum, r) => sum + r.attacks * r.kills, 0) / m.attack_samples).toFixed(1)} {tr('下', 'attacks')} · {m.attack_samples} {tr('样本', 'samples')}</summary><div>{m.attack_distribution?.map(r => <span key={r.attacks}>{r.attacks} {tr('下', 'hits')} <b>{percent(r.kills / m.attack_samples! * 100, 1)}</b></span>)}</div></details>}</div>)}
        {!run.mobs.length && <p className="note">{run.kills_estimated ? tr('等待怪物数据。', 'Waiting for monster data.') : tr('还没有击杀。', 'No kills yet.')}</p>}
      </section>
    </div>
    <PartyMetrics run={run} />
    {(run.attack_count > 0 || run.casts?.length > 0) && <section className="well">
          <div className="well-h"><h3>{tr('攻击与技能', 'Attacks and skills')}</h3>
            <small>{tr(`攻击 ${run.attack_count} 次`, `${run.attack_count} attacks`)}{run.kills > 0 && run.attack_count > 0 ? tr(` · 每只 ${(run.attack_count / run.kills).toFixed(1)} 次`, ` · ${(run.attack_count / run.kills).toFixed(1)} per kill`) : ''}</small></div>
          {(run.attacks || []).map(a => <div className="grind-row" key={'a' + a.skill}><span className="t"><b>{a.skill ? a.name : tr('普通攻击', 'Plain attack')}</b></span>{a.follow_up && <small className="grind-follow" title={tr('命中后自动追加，不计入攻击次数', 'Triggered after a hit; not counted as an attack')}>{tr('追加', 'follow-up')}</small>}<span className="v">{a.count}</span></div>)}
          {(run.casts || []).map(a => <div className="grind-row" key={'c' + a.skill}><span className="t"><b>{a.name}</b><small> {tr('施放', 'cast')}</small></span><span className="v">{a.count}</span></div>)}
    </section>}

  </>;
}

/** Active buffs with their countdown. */
export function BuffStrip({ live, warn }: { live: Live | null; warn: number }) {
  const [, tick] = useState(0);
  useEffect(() => { const id = setInterval(() => tick(n => n + 1), 250); return () => clearInterval(id); }, []);
  const buffs = shownBuffs(live);
  if (!buffs.length) return null;
  return <section className="well grind-buffs" aria-label="Buff">
    <div className="grind-buff-list">{buffs.map(b => <div key={b.source} className={'grind-buff' + (b.left <= 0 ? ' off' : b.left <= warn && !b.proc ? ' warn' : '')}>
      <span className="t"><img src={b.item_id ? itemIcon(b.item_id) : skillIcon(b.source)} width={20} height={20} alt="" /> {b.name}</span><span className="bar"><i style={{ width: `${Math.min(100, b.left / b.total * 100)}%` }} /></span>
      <b>{b.left > 0 ? clock(b.left) : tr('过期', 'Out')}</b></div>)}</div></section>;
}

/** Biggest amounts first; the data keeps loot newest first for the overlay. */
function byValue<T extends { value?: number | null }>(rows: T[]): T[] {
  return [...rows].sort((a, b) => (b.value ?? 0) - (a.value ?? 0));
}

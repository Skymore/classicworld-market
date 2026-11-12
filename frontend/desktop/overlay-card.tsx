import { MesosIcon } from './mesos-icon';
import { PartyMetrics } from './party-metrics';
import { mobIcon, skillIcon } from './skill-icons';
import { RateMetrics, RateStat } from './grind-metrics';
// What the grind overlay shows, for a layout, a theme and a set of fields.
import { useEffect, useRef, useState } from 'react';
import { Clock3, Crosshair, Hourglass, Swords, TrendingUp } from 'lucide-react';
import { itemIcon } from './format';
import './overlay.css';
import { tr } from './i18n';
import { big, clock, duration, mapLabel, percent, shownBuffs, statLine, type GrindSettings, type Live, type LootRow } from './grind';

const I = 13;
const ico = { width: '1.1em', height: '1.1em' }; // icons scale with the overlay's font size

/** A short two-tone beep (no audio files in the bundle). */
function beep() {
  try {
    const audio = new AudioContext(), gain = audio.createGain();
    gain.gain.value = 0.08; gain.connect(audio.destination);
    [880, 660].forEach((hz, i) => {
      const tone = audio.createOscillator(); tone.frequency.value = hz; tone.connect(gain);
      tone.start(audio.currentTime + i * 0.14); tone.stop(audio.currentTime + i * 0.14 + 0.12);
    });
    setTimeout(() => audio.close(), 600);
  } catch { /* no audio device */ }
}

/** Buff countdowns; beeps once when one crosses the warning time. */
function Buffs({ live, settings, icons = false, tiles = false }: { live: Live | null; settings: GrindSettings; icons?: boolean; tiles?: boolean }) {
  const [, tick] = useState(0);
  const warned = useRef(new Set<string>());
  useEffect(() => { const id = setInterval(() => tick(n => n + 1), 250); return () => clearInterval(id); }, []);
  const warn = settings.buff_warn_seconds ?? 10;
  const buffs = shownBuffs(live);
  const state = (b: { left: number }) => b.left <= 0 ? 'off' : b.left <= warn ? 'warn' : '';
  const left = (b: { left: number }) => b.left > 0 ? clock(b.left) : tr('过期', 'Out');
  for (const b of buffs) {
    const key = `${b.source}:${Math.round(b.total)}:${Math.round(Date.now() / 1000 - (b.total - b.left))}`;
    if (b.left > 0 && b.left <= warn && !warned.current.has(key)) {
      warned.current.add(key);
      if (settings.buff_sound && warn > 0) beep();
    }
  }
  if (!buffs.length) return null;
  if (tiles) {
    // Two rows of five in a fixed order, so a buff keeps its place while others come and go.
    const ordered = [...buffs].sort((a, b) => a.source - b.source), more = ordered.length - 10;
    return <div className="ov-buffs tiles">{ordered.slice(0, more > 0 ? 9 : 10).map(b => <span key={b.source} className={state(b)} title={b.name || ''}>
      <img src={b.item_id ? itemIcon(b.item_id) : skillIcon(b.source)} alt="" /><b>{left(b)}</b><i style={{ width: `${Math.min(100, b.left / b.total * 100)}%` }} /></span>)}
      {more > 0 && <span className="more"><b>+{more + 1}</b></span>}</div>;
  }
  return <div className={'ov-buffs' + (icons ? ' icons' : '')}>{buffs.slice(0, 6).map(b => <span key={b.source} className={state(b)} title={b.name || ''}>
    <i style={{ width: `${Math.min(100, b.left / b.total * 100)}%` }} />
    <em>{b.item_id ? <img src={itemIcon(b.item_id)} alt="" /> : <img src={skillIcon(b.source)} alt="" />}{!icons && b.name}</em><b>{left(b)}</b></span>)}</div>;
}

/** The overlay's card: the overlay window shows one, the settings page shows one per preset. */
export function OverlayCard({ live, settings, toast = null, scale, cardRef, grip }: {
  live: Live | null; settings: GrindSettings; toast?: LootRow | null; scale: number;
  cardRef?: React.Ref<HTMLDivElement>; grip?: React.ReactNode;
}) {
  const o = settings.overlay, run = live?.runs?.[0] ?? null, show = (key: string) => o.fields.includes(key);
  const style = { '--alpha': String(o.opacity), fontSize: `${12 * scale}px` } as React.CSSProperties;
  const dot = <i className={'ov-dot ' + (run?.status === 'active' ? 'on' : run ? 'pause' : 'off')} />;
  const box = (content: React.ReactNode) => <div className={`ov ov-${o.layout} ov-t-${o.theme || 'dark'}`} style={style} ref={cardRef}>
    {!run || !['standard', 'detailed', 'slim'].includes(o.layout) ? <div className="ov-site">mxd.ruit.me</div> : null}{content}{grip}</div>;
  if (!run) return box(<><div className="ov-line">{dot}<span>{live && !live.stale ? tr('打几只怪开始记录', 'Kill a few to start') : tr('等待客户端', 'Waiting for collector')}</span></div>
    {show('buffs') && <Buffs live={live} settings={settings} />}</>);
  const rate = run.exp_per_hour, usedPotions = run.consumables.filter(c => c.used > 0), potion = usedPotions[0];
  const level = <><TrendingUp size={I} style={ico} /><span className="ov-bar"><i style={{ width: `${Math.min(100, run.exp_percent ?? 0)}%` }} /></span>
    <span>{percent(run.exp_percent, 1)}</span><span className="dim"><Hourglass size={I} style={ico} />{duration(run.eta_seconds)}</span></>;
  const loot = (count: number) => (run.loot || run.recent || []).slice(0, count).map((row, i) =>
    <div className={'ov-loot ov-account-row' + (row.notable ? ' notable' : '')} key={i}><span><img src={itemIcon(row.item_id)} alt="" />{row.name}
      {row.stats?.length ? <small> {statLine(row.stats)}</small> : null}</span><b className="quantity">×{row.quantity}</b><b className="amount">{row.priced === false ? '—' : `+${big(row.value)}`} <MesosIcon size={11} aria-label={tr('金币', 'mesos')} /></b></div>);
  const potionChip = potion && <span className="ov-used"><img src={itemIcon(potion.item_id)} alt="" />{tr('用', 'Used ')}<b>{potion.used}</b></span>;
  const party = show('party') && <PartyMetrics run={run} compact />;
  if (o.layout === 'slim') return box(<>
    <div className="ov-head">{dot}<b className="ov-job">{run.job_name ? `${run.job_name} · ` : ''}Lv.{run.level ?? '—'}</b><span>{mapLabel(run)}</span>
      {show('time') && <em><Clock3 size={I} style={ico} />{clock(run.active_seconds)}</em>}</div>
    {(show('exp_rate') || show('profit')) && <div className="ov-stats">
      {show('exp_rate') && <RateStat run={run} kind="exp" />}{show('profit') && <RateStat run={run} kind="net" />}</div>}
    {show('level') && <div className="ov-level"><b>{percent(run.exp_percent, 1)}</b>
      <span className="ov-bar"><i style={{ width: `${Math.min(100, run.exp_percent ?? 0)}%` }} /></span><span className="dim">{duration(run.eta_seconds)}</span></div>}
    {(show('dps') || show('kills')) && <div className="ov-stats minor">
      {show('dps') && <div className="ov-stat"><small>DPS</small><b>{big(run.dps)}</b></div>}
      {show('kills') && <div className="ov-stat"><small>{tr('击杀/时', 'Kills/h')}</small><b>{big(run.kills_per_hour)}</b></div>}</div>}
    {show('buffs') && <Buffs live={live} settings={settings} tiles />}
    {show('potions') && usedPotions.length > 0 && <div className="ov-tally"><small>{tr('消耗', 'Used')}</small>
      <span className="ov-icons">{usedPotions.slice(0, 3).map(c => <span key={c.item_id} title={c.name || ''}><img src={itemIcon(c.item_id)} alt="" />{c.used}</span>)}</span>
      <b>−{big(run.consume_cost)}</b></div>}
    {show('recent') && <div className="ov-tally"><small>{tr('战利品', 'Loot')}</small>
      <span className="ov-icons">{(run.loot || run.recent || []).slice(0, 3).map((row, i) => <span key={i} className={row.notable ? 'gold' : ''} title={row.name || ''}><img src={itemIcon(row.item_id)} alt="" />{row.quantity}</span>)}</span>
      <b className="gold">+{big(run.mesos + run.item_value)}</b></div>}
    {party}{toast && <div className="ov-toast"><img src={itemIcon(toast.item_id)} alt="" />{toast.name} <b>{big(toast.value)}</b></div>}
    <div className="ov-site foot">mxd.ruit.me</div></>);
  if (o.layout === 'compact') return box(<><div className="ov-line">{dot}
    {show('time') && <span><Clock3 size={I} style={ico} /><b>{clock(run.active_seconds)}</b></span>}
    {show('level') && <span><TrendingUp size={I} style={ico} />{percent(run.exp_percent, 1)}</span>}
    {show('kills') && <span><Swords size={I} style={ico} />{big(run.kills_per_hour)}</span>}
    {show('dps') && <span title="DPS · 1m"><CrosshairIcon /><b>{big(run.dps)}</b><small>DPS</small></span>}
    {show('potions') && potionChip}
    {show('buffs') && <Buffs live={live} settings={settings} icons />}
    {toast && <span className="ov-toast-inline"><img src={itemIcon(toast.item_id)} alt="" />{big(toast.value)}</span>}</div><div className="ov-compact-metrics">{show('exp_rate') && <RateMetrics run={run} kind="exp" />}{show('profit') && <RateMetrics run={run} kind="net" />}</div>{party}</>);
  if (o.layout === 'big') return box(<>
    {show('exp_rate') && <RateMetrics run={run} kind="exp" />}
    {show('profit') && <RateMetrics run={run} kind="net" />}
    {show('dps') && <div className="ov-row"><CrosshairIcon /><b>{big(run.dps)}</b><span className="dim">DPS · 1m</span></div>}
    {show('level') && <div className="ov-row">{level}</div>}
    {show('buffs') && <Buffs live={live} settings={settings} icons />}
    {party}{toast && <div className="ov-toast"><img src={itemIcon(toast.item_id)} alt="" />{toast.name} <b>{big(toast.value)}</b></div>}</>);
  if (o.layout === 'rail') return box(<>
    <div className="ov-cell">{dot}<b>{clock(run.active_seconds)}</b></div>
    {show('exp_rate') && <RateMetrics run={run} kind="exp" />}
    {show('level') && <div className="ov-cell"><TrendingUp size={I} style={ico} /><b>{percent(run.exp_percent, 1)}</b></div>}
    {show('level') && <div className="ov-cell dim"><Hourglass size={I} style={ico} />{duration(run.eta_seconds)}</div>}
    {show('profit') && <RateMetrics run={run} kind="net" />}
    {show('kills') && <div className="ov-cell"><Swords size={I} style={ico} />{big(run.kills)}</div>}
    {show('dps') && <div className="ov-cell"><CrosshairIcon /><b>{big(run.dps)}</b><small>DPS</small></div>}
    {show('potions') && potion && <div className="ov-cell"><img src={itemIcon(potion.item_id)} alt="" />{tr('用', 'Used ')}{potion.used}</div>}
    {show('buffs') && <Buffs live={live} settings={settings} icons />}
    {party}{toast && <div className="ov-toast"><img src={itemIcon(toast.item_id)} alt="" /><b>{big(toast.value)}</b></div>}</>);
  const detailed = o.layout === 'detailed';
  return box(<>
    <div className="ov-head"><div className="ov-site">mxd.ruit.me</div>{dot}<b className="ov-job">{run.job_name || '—'} · Lv.{run.level ?? '—'}</b><span>{mapLabel(run)}</span>
      {show('time') && <em><Clock3 size={I} style={ico} />{clock(run.active_seconds)}</em>}</div>
    {show('exp_rate') && <RateMetrics run={run} kind="exp" />}
    {show('level') && <div className="ov-row">{level}</div>}
    {show('dps') && <div className="ov-row"><CrosshairIcon /><b className="big">{big(run.dps)}</b><span className="dim">DPS · 1m</span></div>}
    {show('profit') && <RateMetrics run={run} kind="net" />}
    <div className="ov-accounts">
    {show('potions') && potion && <section className="ov-account"><div className="ov-account-heading"><b className="ov-account-title">{tr('消耗', 'Used')}</b><b className="amount">−{big(run.consume_cost)} <MesosIcon size={12} /></b></div>
      {usedPotions.map(c => <div className="ov-loot ov-account-row" key={c.item_id}>
        <span><img src={itemIcon(c.item_id)} alt="" />{c.name}</span><b className="quantity">×{c.used}</b><b className="amount">−{big(c.cost ?? null)} <MesosIcon size={11} aria-label={tr('金币', 'mesos')} /></b></div>)}</section>}
    {show('recent') && <section className="ov-account"><div className="ov-account-heading"><b className="ov-account-title">{tr('战利品', 'Loot')}</b><b className="amount">+{big(run.mesos + run.item_value)} <MesosIcon size={12} /></b></div>{run.mesos > 0 && <div className="ov-loot ov-account-row ov-mesos"><span><MesosIcon size={15} />{tr('金币', 'Mesos')}</span><b className="quantity"></b><b className="amount">+{big(run.mesos)} <MesosIcon size={11} /></b></div>}{loot(detailed ? 6 : 2)}</section>}
    </div>
    {(show('kills') || detailed) && <div className="ov-row"><Swords size={I} style={ico} /><b>{big(run.kills)}</b>
      <span className="dim">{`${big(run.kills_per_hour)}/h`}</span></div>}
    {show('kills') && <div className="ov-mobs">{run.mobs.slice(0, detailed ? 3 : 2).map(m => <div className="ov-loot" key={m.mob_id}><span><img src={mobIcon(m.mob_id)} alt="" />{m.name}</span><b>×{m.kills}</b></div>)}</div>}
    {show('buffs') && <Buffs live={live} settings={settings} />}
    {party}
    {toast && <div className="ov-toast"><img src={itemIcon(toast.item_id)} alt="" />{toast.name} <b>{big(toast.value)}</b></div>}
  </>);
}
function CrosshairIcon() { return <Crosshair size={I} style={ico} />; }

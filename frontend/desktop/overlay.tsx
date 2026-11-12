// The always-on-top grind overlay (grind_desktop.GrindService). Read-only:
// it polls window.pywebview.api.state() and never takes focus.
import { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Clock3, Coins, Crosshair, FlaskConical, Hourglass, Sparkles, Swords, TrendingUp, Zap } from 'lucide-react';
import { itemIcon } from './format';
import './overlay.css';
import { applyLanguage, tr } from './i18n';
import { big, buffLeft, clock, currentBuffs, duration, mapLabel, overlayState, percent, statLine, type GrindSettings, type Live, type LootRow } from './grind';

applyLanguage('system');
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
function Buffs({ live, settings, icons = false }: { live: Live | null; settings: GrindSettings; icons?: boolean }) {
  const [, tick] = useState(0);
  const warned = useRef(new Set<string>());
  useEffect(() => { const id = setInterval(() => tick(n => n + 1), 250); return () => clearInterval(id); }, []);
  const warn = settings.buff_warn_seconds ?? 10;
  const buffs = currentBuffs(live).map(b => ({ ...b, left: buffLeft(b, live) })).filter(b => b.left > 0);
  for (const b of buffs) {
    const key = `${b.source}:${Math.round(b.total)}:${Math.round(Date.now() / 1000 - (b.total - b.left))}`;
    if (b.left <= warn && !warned.current.has(key)) {
      warned.current.add(key);
      if (settings.buff_sound && warn > 0) beep();
    }
  }
  if (!buffs.length) return null;
  return <div className={'ov-buffs' + (icons ? ' icons' : '')}>{buffs.slice(0, 6).map(b => <span key={b.source} className={b.left <= warn ? 'warn' : ''} title={b.name || ''}>
    <i style={{ width: `${Math.min(100, b.left / b.total * 100)}%` }} />
    <em>{b.item_id ? <img src={itemIcon(b.item_id)} alt="" /> : <Zap size={I} style={ico} />}{!icons && b.name}</em><b>{clock(b.left)}</b></span>)}</div>;
}

function Overlay() {
  const [live, setLive] = useState<Live | null>(null), [settings, setSettings] = useState<GrindSettings | null>(null);
  const [editing, setEditing] = useState(false), [toast, setToast] = useState<LootRow | null>(null);
  const seen = useRef(0);
  useEffect(() => {
    let alive = true;
    const poll = () => overlayState().then(s => {
      if (!alive) return;
      setLive(s.live); setSettings(s.settings); setEditing(s.editing); applyLanguage(s.language || 'system');
      const notable = s.live?.runs?.[0]?.recent?.find(r => r.notable);
      if (notable && notable.t > seen.current) {
        if (seen.current) setToast(notable);
        seen.current = notable.t;
      }
    }).catch(() => null);
    poll();
    const id = setInterval(poll, 1000);
    window.addEventListener('pywebviewready', poll);
    return () => { alive = false; clearInterval(id); window.removeEventListener('pywebviewready', poll); };
  }, []);
  useEffect(() => { if (!toast) return; const id = setTimeout(() => setToast(null), 6000); return () => clearTimeout(id); }, [toast]);
  if (!settings) return null;
  const o = settings.overlay, run = live?.runs?.[0] ?? null, show = (key: string) => o.fields.includes(key);
  const style = { '--alpha': String(o.opacity), fontSize: `${12 * (o.scale || 1)}px` } as React.CSSProperties;
  const dot = <i className={'ov-dot ' + (run?.status === 'active' ? 'on' : run ? 'pause' : 'off')} />;
  const box = (content: React.ReactNode) => <div className={`ov ov-${o.layout} ov-t-${o.theme || 'dark'}` + (editing ? ' editing' : '')} style={style}>
    {content}{editing && <div className="ov-edit">{tr('拖到合适位置，回采集器点“完成”', 'Drag into place, then press Done in the collector')}</div>}</div>;
  if (!run) return box(<><div className="ov-line">{dot}<span>{live && !live.stale ? tr('打几只怪开始记录', 'Kill a few to start') : tr('等待采集器', 'Waiting for collector')}</span></div>
    {show('buffs') && <Buffs live={live} settings={settings} />}</>);
  const rate = run.exp_per_hour_5m ?? run.exp_per_hour, usedPotions = run.consumables.filter(c => c.used > 0), potion = usedPotions[0];
  const level = <><TrendingUp size={I} style={ico} /><span className="ov-bar"><i style={{ width: `${Math.min(100, run.exp_percent ?? 0)}%` }} /></span>
    <span>{percent(run.exp_percent, 1)}</span><span className="dim"><Hourglass size={I} style={ico} />{duration(run.eta_seconds)}</span></>;
  const loot = (count: number) => (run.loot || run.recent || []).slice(0, count).map((row, i) =>
    <div className={'ov-loot' + (row.notable ? ' notable' : '')} key={i}><span><img src={itemIcon(row.item_id)} alt="" />{row.name}
      {row.stats?.length ? <small> {statLine(row.stats)}</small> : null}</span><b>{tr('获得', 'Gained')} ×{row.quantity}</b></div>);
  const potionChip = potion && <span className="ov-used"><img src={itemIcon(potion.item_id)} alt="" />{tr('用', 'Used ')}<b>{potion.used}</b></span>;
  const party = show('party') && !!run.combat?.length && <div className="ov-team" aria-label={tr('队伍战斗统计', 'Party combat')}>
    <div className="ov-team-row dim"><span>{tr('同图队伍', 'Party')}</span><span>DPS</span><span>{tr('击杀', 'Kills')}</span></div>
    {run.combat.slice(0, 6).map(row => <div className={'ov-team-row' + (row.self ? ' own' : '')} key={row.character_id}>
      <span>{row.name || '—'}</span><b>{big(row.dps)}</b><span>{big(row.kills)}</span>
    </div>)}</div>;
  if (o.layout === 'compact') return box(<><div className="ov-line">{dot}
    {show('time') && <span><Clock3 size={I} style={ico} /><b>{clock(run.active_seconds)}</b></span>}
    {show('exp_rate') && <span><Sparkles size={I} style={ico} /><b>{big(rate)}</b></span>}
    {show('level') && <span><TrendingUp size={I} style={ico} />{percent(run.exp_percent, 1)}</span>}
    {show('profit') && <span className="gold"><Coins size={I} style={ico} /><b>{big(run.net_per_hour)}</b><small>{tr('/时', '/h')}</small></span>}
    {show('kills') && <span><Swords size={I} style={ico} />{big(run.kills_per_hour)}</span>}
    {show('dps') && <span title="DPS · 30s"><CrosshairIcon /><b>{big(run.dps)}</b><small>DPS</small></span>}
    {show('potions') && potionChip}
    {show('buffs') && <Buffs live={live} settings={settings} icons />}
    {toast && <span className="ov-toast-inline"><img src={itemIcon(toast.item_id)} alt="" />{big(toast.value)}</span>}</div>{party}</>);
  if (o.layout === 'big') return box(<>
    <div className="ov-nums"><span><Sparkles size={I} style={ico} /><b>{big(rate)}</b></span>
      <span className="gold"><Coins size={I} style={ico} /><b>{big(run.net_per_hour)}</b><small>{tr('/时', '/h')}</small></span></div>
    {show('dps') && <div className="ov-row"><CrosshairIcon /><b>{big(run.dps)}</b><span className="dim">DPS · 30s</span></div>}
    {show('level') && <div className="ov-row">{level}</div>}
    {show('buffs') && <Buffs live={live} settings={settings} icons />}
    {party}{toast && <div className="ov-toast"><img src={itemIcon(toast.item_id)} alt="" />{toast.name} <b>{big(toast.value)}</b></div>}</>);
  if (o.layout === 'rail') return box(<>
    <div className="ov-cell">{dot}<b>{clock(run.active_seconds)}</b></div>
    {show('exp_rate') && <div className="ov-cell"><Sparkles size={I} style={ico} /><b className="big">{big(rate)}</b></div>}
    {show('level') && <div className="ov-cell"><TrendingUp size={I} style={ico} /><b>{percent(run.exp_percent, 1)}</b></div>}
    {show('level') && <div className="ov-cell dim"><Hourglass size={I} style={ico} />{duration(run.eta_seconds)}</div>}
    {show('profit') && <div className="ov-cell gold"><Coins size={I} style={ico} /><b>{big(run.net_per_hour)}</b><small>{tr('/时', '/h')}</small></div>}
    {show('kills') && <div className="ov-cell"><Swords size={I} style={ico} />{big(run.kills)}</div>}
    {show('dps') && <div className="ov-cell"><CrosshairIcon /><b>{big(run.dps)}</b><small>DPS</small></div>}
    {show('potions') && potion && <div className="ov-cell"><img src={itemIcon(potion.item_id)} alt="" />{tr('用', 'Used ')}{potion.used}</div>}
    {show('buffs') && <Buffs live={live} settings={settings} icons />}
    {party}{toast && <div className="ov-toast"><img src={itemIcon(toast.item_id)} alt="" /><b>{big(toast.value)}</b></div>}</>);
  const detailed = o.layout === 'detailed';
  return box(<>
    <div className="ov-head">{dot}<b className="ov-lv">Lv.{run.level ?? '—'}</b><span>{mapLabel(run)}</span>
      {show('time') && <em><Clock3 size={I} style={ico} />{clock(run.active_seconds)}</em>}</div>
    {show('exp_rate') && <div className="ov-row"><Sparkles size={I} style={ico} /><b className="big">{big(rate)}</b>
      <span className="dim">{detailed && <>1m {big(run.exp_per_hour_1m)} · </>}⌀ {big(run.exp_per_hour)}</span></div>}
    {show('level') && <div className="ov-row">{level}</div>}
    {show('dps') && <div className="ov-row"><CrosshairIcon /><b className="big">{big(run.dps)}</b><span className="dim">DPS · 30s</span></div>}
    {show('profit') && <div className="ov-row"><Coins size={I} style={ico} /><span>{tr('净收益/时', 'Net/h')}</span><b className="gold big">{big(run.net_per_hour)}</b>
      </div>}
    {show('profit') && <div className="ov-row ov-money dim"><span>{tr('本次净收益', 'Net total')} {big(run.net)}</span><span>{tr('金币', 'Mesos')} +{big(run.mesos)}</span></div>}
    {(show('kills') || detailed) && <div className="ov-row"><Swords size={I} style={ico} /><b>{big(run.kills)}</b>
      <span className="dim">{detailed ? run.mobs.slice(0, 3).map(m => `${m.name} ${m.kills}`).join(' · ') : `${big(run.kills_per_hour)}/h`}</span></div>}
    {show('potions') && potion && <div className="ov-potions">
      {(detailed ? usedPotions.slice(0, 4) : [potion]).map(c => <div className="ov-row" key={c.item_id}>
        <img src={itemIcon(c.item_id)} alt="" /><span>{c.name}</span><b>{tr('使用', 'Used')} ×{c.used}</b></div>)}</div>}
    {show('buffs') && <Buffs live={live} settings={settings} />}
    {show('recent') && loot(detailed ? 6 : 2)}
    {party}
    {toast && <div className="ov-toast"><img src={itemIcon(toast.item_id)} alt="" />{toast.name} <b>{big(toast.value)}</b></div>}
  </>);
}
function CrosshairIcon() { return <Crosshair size={I} style={ico} />; }
createRoot(document.getElementById('root')!).render(<Overlay />);

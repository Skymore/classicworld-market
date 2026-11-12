// The always-on-top grind overlay (grind_desktop.GrindService). Read-only:
// it polls window.pywebview.api.state() and never takes focus.
import { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import './overlay.css';
import { applyLanguage, tr } from './i18n';
import { big, buffLeft, clock, currentBuffs, duration, mapLabel, overlayState, percent, statLine, statusLabel, type GrindSettings, type Live, type LootRow } from './grind';

applyLanguage('system');

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
function Buffs({ live, settings }: { live: Live | null; settings: GrindSettings }) {
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
  return <div className="ov-buffs">{buffs.slice(0, 6).map(b => <span key={b.source} className={b.left <= warn ? 'warn' : ''} title={b.name || ''}>
    <i style={{ width: `${Math.min(100, b.left / b.total * 100)}%` }} /><em>{b.name}</em><b>{clock(b.left)}</b></span>)}</div>;
}

function Overlay() {
  const [live, setLive] = useState<Live | null>(null), [settings, setSettings] = useState<GrindSettings | null>(null);
  const [editing, setEditing] = useState(false), [toast, setToast] = useState<LootRow | null>(null);
  const seen = useRef(0);
  useEffect(() => {
    let alive = true;
    const poll = () => overlayState().then(s => {
      if (!alive) return;
      setLive(s.live); setSettings(s.settings); setEditing(s.editing);
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
  const box = (content: React.ReactNode) => <div className={`ov ov-${o.layout}` + (editing ? ' editing' : '')} style={style}>
    {content}{editing && <div className="ov-edit">{tr('拖到合适位置，回采集器点“完成”', 'Drag into place, then press Done in the collector')}</div>}</div>;
  if (!run) return box(<><div className="ov-line">{dot}<span>{live && !live.stale ? tr('打几只怪开始记录', 'Kill a few to start') : tr('等待采集器', 'Waiting for collector')}</span></div>
    {show('buffs') && <Buffs live={live} settings={settings} />}</>);
  const rate = run.exp_per_hour_5m ?? run.exp_per_hour;
  if (o.layout === 'compact') return box(<div className="ov-line">{dot}
    {show('time') && <b>{clock(run.active_seconds)}</b>}
    {show('exp_rate') && <span>{big(rate)}<small>/h</small></span>}
    {show('level') && <span>{percent(run.exp_percent, 1)}</span>}
    {show('profit') && <span className="gold">{big(run.net_per_hour)}<small>/h</small></span>}
    {toast && <span className="ov-toast-inline">{toast.name} {big(toast.value)}</span>}</div>);
  const potion = run.consumables[0];
  return box(<>
    <div className="ov-head">{dot}<b>{statusLabel(run)}</b><span>{mapLabel(run)}</span>
      {show('time') && <em>{clock(run.active_seconds)}</em>}</div>
    {show('exp_rate') && <div className="ov-row"><small>{tr('经验/时', 'EXP/h')}</small><b className="big">{big(rate)}</b>
      <span>{tr('均', 'avg')} {big(run.exp_per_hour)}</span></div>}
    {show('level') && <div className="ov-row"><small>Lv.{run.level ?? '—'}</small>
      <span className="ov-bar"><i style={{ width: `${Math.min(100, run.exp_percent ?? 0)}%` }} /></span>
      <span>{percent(run.exp_percent)}</span><span>{tr('升级', 'up')} {duration(run.eta_seconds)}</span></div>}
    {show('profit') && <div className="ov-row"><small>{tr('收益/时', 'Profit/h')}</small><b className="gold">{big(run.net_per_hour)}</b>
      <span>{tr('金', 'm')} {big(run.mesos)} · {tr('物', 'i')} {big(run.item_value)} · {tr('药', 'p')} −{big(run.consume_cost)}</span></div>}
    {show('kills') && <div className="ov-row"><small>{tr('击杀', 'Kills')}</small><b>{big(run.kills)}</b><span>{big(run.kills_per_hour)}/h</span></div>}
    {show('buffs') && <Buffs live={live} settings={settings} />}
    {show('recent') && (run.recent || []).slice(0, o.layout === 'detailed' ? 6 : 2).map((row, i) =>
      <div className={'ov-loot' + (row.notable ? ' notable' : '')} key={i}><span>▸ {row.name}{row.quantity > 1 ? ` ×${row.quantity}` : ''}
        {row.stats?.length ? <small> {statLine(row.stats)}</small> : null}</span><b>{big(row.value)}</b></div>)}
    {show('potions') && potion && <div className="ov-row potion"><small>{potion.name}</small>
      <b className={potion.minutes_left != null && potion.minutes_left < 15 ? 'warn' : ''}>{potion.remaining ?? '—'}</b>
      <span>{potion.minutes_left != null ? tr(`约 ${Math.round(potion.minutes_left)} 分钟`, `~${Math.round(potion.minutes_left)} min`) : ''}</span></div>}
    {toast && <div className="ov-toast">{tr('高价值', 'Big drop')} · {toast.name} <b>{big(toast.value)}</b></div>}
  </>);
}
createRoot(document.getElementById('root')!).render(<Overlay />);

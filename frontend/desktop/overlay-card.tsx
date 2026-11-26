import { MesosIcon } from './mesos-icon';
import { PartyMetrics } from './party-metrics';
import { mobIcon, skillIcon } from './skill-icons';
import { RateMetrics, RateStat } from './grind-metrics';
import { basicValue } from '../src/components/grind-points';
// What the grind overlay shows, for a layout, a theme and a set of fields.
import { useEffect, useRef, useState } from 'react';
import { Clock3, Crosshair, Hourglass, Pause, Play, Square, Swords, TrendingUp } from 'lucide-react';
import { itemIcon } from './format';
import './overlay.css';
import { language, tr } from './i18n';
import { type ClientUpdate, big, channelPrompt, clock, duration, mapLabel, percent, shownBuffs, statLine, statusLabel, type GrindSettings, type GroundDrop, type Live, type LootRow, type Pet } from './grind';

const I = 13;
const ico = { width: '1.1em', height: '1.1em' }; // icons scale with the overlay's font size

/** Plays one clip; false when it is missing or cannot play. */
function play(src: string) {
  return new Promise<boolean>(done => {
    const clip = new Audio(src);
    // A clip that never reports its end must not hold up every later announcement.
    const timer = setTimeout(() => done(true), 6000);
    clip.onended = () => { clearTimeout(timer); done(true); };
    clip.onerror = () => { clearTimeout(timer); done(false); };
    clip.play().catch(() => { clearTimeout(timer); done(false); });
  });
}

/** Windows speech, for a buff the bundled voice pack does not have; a beep without a voice. */
function speak(text: string | null | undefined) {
  const speech = window.speechSynthesis;
  if (!text || !speech) return beep();
  const lang = /[一-鿿]/.test(text) ? 'zh-CN' : /[가-힯]/.test(text) ? 'ko-KR'
    : { zh: 'zh-CN', en: 'en-US', ko: 'ko-KR' }[language()];
  const voices = speech.getVoices(), utterance = new SpeechSynthesisUtterance(text);
  utterance.lang = lang; utterance.rate = 1.15;
  const voice = voices.find(v => v.lang === lang) || voices.find(v => v.lang.startsWith(lang.slice(0, 2)));
  if (voices.length && !voice) return beep();
  if (voice) utterance.voice = voice;
  speech.speak(utterance);
}

let speaking = Promise.resolve();
/** Says a buff's name from the bundled voice pack (voice/<lang>/<source>.mp3, built by
 * tools/make_voice_pack.py), one after another; Korean falls back to English clips. */
function say(source: number, text: string | null | undefined, clip: string = String(source)) {
  speaking = speaking.then(async () => {
    const lang = language();
    if (await play(`voice/${lang}/${clip}.mp3`)) return;
    if (lang === 'ko' && await play(`voice/en/${clip}.mp3`)) return;
    speak(text);
  });
}

const chiming = new Set<number>();
/** A rising three-note chime for a Final Attack that just triggered, then its name. It can
 * can turn on again right after it ended: one still playing is not stacked. */
function chime(source: number, text: string | null | undefined) {
  if (chiming.has(source)) return;
  chiming.add(source);
  try {
    const audio = new AudioContext(), gain = audio.createGain();
    gain.gain.value = 0.07; gain.connect(audio.destination);
    [660, 880, 1175].forEach((hz, i) => {
      const tone = audio.createOscillator(); tone.type = 'triangle'; tone.frequency.value = hz; tone.connect(gain);
      tone.start(audio.currentTime + i * 0.09); tone.stop(audio.currentTime + i * 0.09 + 0.08);
    });
    setTimeout(() => audio.close(), 600);
  } catch { /* no audio device */ }
  setTimeout(async () => {
    const lang = language();
    if (!await play(`voice/${lang}/${source}.mp3`) && !(lang === 'ko' && await play(`voice/en/${source}.mp3`))) speak(text);
    chiming.delete(source);
  }, 300);
}

/** A valuable drop to pick up: a two-note chime, "有好东西掉了" (voice pack: drop_alert), then
 * the item's name in the same voice (voice/<lang>/item/<id>.mp3). An item outside the pack is
 * read by Windows speech, by the name nameOf() gives once the clip ends (a first drop's name
 * arrives with the price list). No price. */
export function announceDrop(itemId: number, nameOf: () => string | null | undefined) {
  try {
    const audio = new AudioContext(), gain = audio.createGain();
    gain.gain.value = 0.08; gain.connect(audio.destination);
    [988, 1319].forEach((hz, i) => {
      const tone = audio.createOscillator(); tone.type = 'sine'; tone.frequency.value = hz; tone.connect(gain);
      tone.start(audio.currentTime + i * 0.12); tone.stop(audio.currentTime + i * 0.12 + 0.11);
    });
    setTimeout(() => audio.close(), 600);
  } catch { /* no audio device */ }
  const named = () => { const name = nameOf(); return name && !name.startsWith('#') ? name : null; };
  setTimeout(() => {
    speaking = speaking.then(async () => {
      const lang = language();
      const played = await play(`voice/${lang}/drop_alert.mp3`) || (lang === 'ko' && await play('voice/en/drop_alert.mp3'));
      if (played) {
        if (!await play(`voice/${lang}/item/${itemId}.mp3`)) speak(named());
      } else {
        const item = named(), phrase = tr('有好东西掉了', 'Valuable drop');
        speak(item ? `${phrase}，${item}` : phrase);
      }
    });
  }, 300);
}

let lowHpAt = 0;
/** "血量低" from the voice pack (voice/<lang>/hp_low.mp3), at most every 8 s. */
function sayLowHp() {
  if (Date.now() - lowHpAt < 8000) return;
  lowHpAt = Date.now();
  say(0, tr('血量低', 'Low HP'), 'hp_low');
}

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

/** Buff countdowns; says a buff's name once when it crosses the warning time. A Final
 * Attack (triggered by hits) chimes when it turns on instead and stays quiet when it ends. */
const ITEM_LATE = 1;   // grind_autobuff.ITEM_LATE: an item buff is used this long after the server ends it
const AGAIN = 10;      // a warning is said once more this long after, if nothing was cast

function Buffs({ live, settings, icons = false, tiles = false, voice = false, section = false }: {
  live: Live | null; settings: GrindSettings; icons?: boolean; tiles?: boolean;
  voice?: boolean;     // only the overlay window speaks (not the settings page's preview of it)
  section?: boolean;   // wrapped in its own card, shown only while there are buffs (the component stays mounted)
}) {
  const [, tick] = useState(0);
  // source -> the cast's end time, when it was last said, how many times (at most twice)
  const warned = useRef(new Map<number, { ends: number; at: number; times: number; name: string | null }>());
  // Item buffs seen on (or ending: nominally over, not yet ended by the server): last seen then.
  const items = useRef(new Map<number, { ends: number; name: string | null; at?: number }>());
  const procs = useRef<Map<number, number> | null>(null);   // Final Attack source -> turn-on time announced
  useEffect(() => { const id = setInterval(() => tick(n => n + 1), 250); return () => clearInterval(id); }, []);
  const warn = settings.buff_warn_seconds ?? 3;
  const buffs = shownBuffs(live);
  // An item buff (龙血, 药水…) cannot be used again while it is on (the game asks to confirm),
  // so it is not flagged before it ends: said ITEM_LATE seconds after, like auto buff uses it.
  const state = (b: { left: number; proc?: boolean; item_id?: number | null; ending?: boolean }) => b.ending ? 'ending' : b.left <= 0 ? 'off' : b.left <= warn && !b.proc && !b.item_id ? 'warn' : '';
  const left = (b: { left: number; ending?: boolean }) => b.ending ? tr('将结束', 'Ending') : b.left > 0 ? clock(b.left) : tr('过期', 'Out');
  // Spoken only while fighting (an attack or kill in the last 10 s), like auto buff.
  const fighting = voice && settings.buff_sound && !!live?.runs?.[0]?.in_combat;
  // A Final Attack is announced each time it turns on (the server's `on` time, which
  // also catches a cancel and a new one between two state writes), not on every refresh.
  const first = procs.current === null, announced = procs.current ??= new Map();
  for (const b of buffs) {
    if (!b.proc || b.left <= 0 || !b.on || announced.get(b.source) === b.on) continue;
    announced.set(b.source, b.on);
    if (!first && fighting) chime(b.source, b.name);
  }
  // Each warning is said twice: again AGAIN seconds later if the buff was not cast (or
  // used) again by then. Final Attacks are never warned.
  const now = Date.now() / 1000;
  const on = (source: number) => buffs.find(b => b.source === source && (b.left > 0 || b.ending));
  // An item buff ends when it leaves the list: the server's cancel (or ITEM_WAIT after its nominal end).
  for (const b of buffs) if (b.item_id && (b.left > 0 || b.ending)) items.current.set(b.source, { ends: now, name: b.name });
  for (const [source, item] of items.current) {
    if (on(source)) continue;   // still on, or used again
    if (now - item.ends > ITEM_LATE + AGAIN + 30) { items.current.delete(source); continue; }
    if (!fighting) continue;
    if (item.at === undefined && now - item.ends >= ITEM_LATE) { item.at = now; say(source, item.name); }
    else if (item.at !== undefined && now - item.at >= AGAIN) { items.current.delete(source); say(source, item.name); }
  }
  for (const b of buffs) {
    if (b.proc || b.item_id || !fighting || warn <= 0) continue;
    // The end time drifts by a second between state writes; one warning per cast.
    const ends = now + b.left, said = warned.current.get(b.source);
    if (b.left > 0 && b.left <= warn && (said === undefined || Math.abs(said.ends - ends) > 5)) {
      warned.current.set(b.source, { ends, at: now, times: 1, name: b.name });
      say(b.source, b.name);
    }
  }
  for (const [source, said] of warned.current) {
    const current = on(source);
    if (current && Math.abs(now + current.left - said.ends) > 5) { warned.current.delete(source); continue; }   // cast again
    if (said.times >= 2 || now - said.at > AGAIN + 30) continue;
    if (fighting && now - said.at >= AGAIN) { said.times = 2; say(source, said.name); }
  }
  // Pets: "宠物饿了，请喂食" when one that is out falls under 20 fullness, and "宠物没出来，
  // 请召唤" when none of the player's pets is out; each said twice, the second time AGAIN
  // seconds later if nothing changed. Spoken with the buff warnings (same switch, fighting).
  const pets: Pet[] = live?.runs?.[0]?.pets ?? live?.characters?.[0]?.pets ?? [];
  const petSaid = useRef(new Map<string, { at: number; times: number }>());
  const remind = (key: string, active: boolean, text: string, clip: string) => {
    const said = petSaid.current.get(key);
    if (!active) { petSaid.current.delete(key); return; }
    if (!fighting) return;
    if (!said) { petSaid.current.set(key, { at: now, times: 1 }); say(0, text, clip); }
    else if (said.times < 2 && now - said.at >= AGAIN) { said.times = 2; say(0, text, clip); }
  };
  const fed = new Set(pets.filter(p => p.hungry).map(p => p.serial));
  for (const key of [...petSaid.current.keys()]) if (key !== 'away' && !fed.has(key)) petSaid.current.delete(key);
  for (const p of pets) if (p.hungry) remind(p.serial, true, tr('宠物饿了，请喂食', 'Pet is hungry, feed it'), 'pet_hungry');
  remind('away', pets.length > 0 && !pets.some(p => p.out), tr('宠物没出来，请召唤', 'No pet out, summon one'), 'pet_away');
  const petState = (p: Pet) => !p.out ? 'off' : p.hungry ? 'warn' : '';
  const petLeft = (p: Pet) => p.out ? String(p.fullness ?? '—') : tr('背包', 'Bag');
  if (!buffs.length && !pets.length) return null;
  if (tiles) {
    // Two rows of five in a fixed order, so a buff keeps its place while others come and go.
    const ordered = [...buffs].sort((a, b) => a.source - b.source), more = ordered.length - 10;
    const grid = <div className="ov-buffs tiles">{ordered.slice(0, more > 0 ? 9 : 10).map(b => <span key={b.source} className={state(b)} title={b.name || ''}>
      <img src={b.item_id ? itemIcon(b.item_id) : skillIcon(b.source)} alt="" /><b>{left(b)}</b><i style={{ width: `${Math.min(100, b.left / b.total * 100)}%` }} /></span>)}
      {more > 0 && <span className="more"><b>+{more + 1}</b></span>}
      {pets.map(p => <span key={p.serial} className={'pet ' + petState(p)} title={`${p.name || ''} ${tr('饱食度', 'Fullness')} ${p.fullness ?? '—'}`}>
        <img src={itemIcon(p.item_id)} alt="" /><b>{petLeft(p)}</b><i style={{ width: `${Math.min(100, p.fullness ?? 0)}%` }} /></span>)}</div>;
    return section ? <section className="ov-sec ov-sec-buffs">{grid}</section> : grid;
  }
  return <div className={'ov-buffs' + (icons ? ' icons' : '')}>{buffs.slice(0, 6).map(b => <span key={b.source} className={state(b)} title={b.name || ''}>
    <i style={{ width: `${Math.min(100, b.left / b.total * 100)}%` }} />
    <em>{b.item_id ? <img src={itemIcon(b.item_id)} alt="" /> : <img src={skillIcon(b.source)} alt="" />}{!icons && b.name}</em><b>{left(b)}</b></span>)}
    {pets.map(p => <span key={p.serial} className={'pet ' + petState(p)} title={p.name || ''}>
      <i style={{ width: `${Math.min(100, p.fullness ?? 0)}%` }} />
      <em><img src={itemIcon(p.item_id)} alt="" />{!icons && (p.name || tr('宠物', 'Pet'))}</em><b>{petLeft(p)}</b></span>)}</div>;
}

/** The overlay's card: the overlay window shows one, the settings page shows one per preset. */
export function OverlayCard({ live, settings, toast = null, drop = null, scale, cardRef, grip, command, update = null, onUpdate }: {
  live: Live | null; settings: GrindSettings; toast?: LootRow | null; drop?: GroundDrop | null; scale: number;
  cardRef?: React.Ref<HTMLDivElement>; grip?: React.ReactNode;   // the overlay window's corner grip and switches
  command?(action: 'toggle' | 'end'): void;                      // the overlay window's pause and end buttons
  update?: ClientUpdate | null; onUpdate?(): void;               // a client update, offered beside the site name
}) {
  const o = settings.overlay, run = live?.runs?.[0] ?? null, show = (key: string) => o.fields.includes(key);
  const rule = settings.performance?.enabled ? settings.performance : undefined;   // 绩效模式: 积分 under the net
  // Low HP: said once each time HP falls under the danger line (Tracker.vitals); its own switch.
  const vitals = run?.vitals, low = !!vitals && vitals.hp > 0 && vitals.hp < vitals.danger;
  const wasLow = useRef(false);
  useEffect(() => {
    if (low && !wasLow.current && settings.hp_warn !== false && grip) sayLowHp();
    wasLow.current = low;
  }, [low, settings.hp_warn, grip]);
  const style = { '--alpha': String(o.opacity), fontSize: `${12 * scale}px` } as React.CSSProperties;
  const dot = <i className={'ov-dot ' + (run?.status === 'active' ? 'on' : run ? 'pause' : 'off')} />;
  const prompt = channelPrompt(run);
  const box = (content: React.ReactNode) => <div className={`ov ov-${o.layout} ov-t-${o.theme || 'dark'}`} style={style} ref={cardRef}>
    {!run || !['standard', 'detailed', 'slim'].includes(o.layout) ? <div className="ov-site">mxd.ruit.me</div> : null}
    {prompt && <div className="ov-prompt warn" role="alert">⚠ {prompt}</div>}
    {drop && <div className="ov-drop gold" role="status"><img src={itemIcon(drop.item_id)} alt="" />
      {drop.by === 'me' ? tr('你打出：', 'You dropped: ') : drop.by === 'party' ? tr(`队友${drop.by_name ? ` ${drop.by_name} ` : ''}打出：`, `${drop.by_name || 'Party'} dropped: `) : tr('掉落：', 'Dropped: ')}
      {drop.name || `#${drop.item_id}`}{drop.value ? <b> {tr('约', '~')}{big(drop.value)}</b> : null}</div>}
    {content}{run && run.status !== 'ended' && <Controls paused={run.status !== 'active'} command={command} />}{grip}</div>;
  if (!run) return box(<><div className="ov-line">{dot}<span>{live && !live.stale ? tr('打几只怪开始记录', 'Kill a few to start') : tr('等待客户端', 'Waiting for collector')}</span></div>
    {show('buffs') && <Buffs live={live} settings={settings} voice={!!grip} />}</>);
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
      {show('time') && <em><Clock3 size={I} style={ico} />{clock(run.active_seconds)}</em>}<Recording run={run} /></div>
    {(show('exp_rate') || show('level') || show('dps') || show('kills')) && <section className="ov-sec">
    {show('exp_rate') && <RateStat run={run} kind="exp" side={show('level') && <><small>{tr('距升级', 'Next level')}</small><b>{duration(run.eta_seconds)}</b></>} />}
    {show('level') && <div className="ov-level"><b>{percent(run.exp_percent, 1)}</b>
      <span className="ov-bar"><i style={{ width: `${Math.min(100, run.exp_percent ?? 0)}%` }} /></span>
      {!show('exp_rate') && <span className="dim">{tr('升级', 'up in')} {duration(run.eta_seconds)}</span>}</div>}
    {(show('dps') || show('kills')) && <div className="ov-stats minor">
      {show('dps') && <div className="ov-stat"><small>DPS</small><b>{big(run.dps)}</b></div>}
      {show('kills') && <div className="ov-stat"><small>{tr('击杀/时', 'Kills/h')}</small><b>{big(run.kills_per_hour)}</b></div>}</div>}</section>}
    {(show('profit') || show('potions') || show('recent') || groundRows(live).length > 0) && <section className="ov-sec">
    {show('profit') && <RateStat run={run} kind="net" side={<b className="ov-mesos" title={tr('拾取的金币', 'Mesos picked up')}><MesosIcon size={14} />+{big(run.mesos)}</b>} />}
    {show('profit') && rule && <RateStat run={run} kind="points" rule={rule}
      side={<><small>{tr('基础掉落', 'Basic drops')}</small><b>+{big(basicValue(run))}</b></>} />}
    {show('recent') && <div className="ov-tally loot"><i className="ov-sign plus" title={tr('战利品', 'Loot')}>+</i>
      <span className="ov-icons">{(run.loot || run.recent || []).slice(0, 3).map((row, i) => <span key={i} className={row.notable ? 'gold' : ''} title={row.name || ''}><img src={itemIcon(row.item_id)} alt="" />{row.quantity}</span>)}</span>
      <b className="plus">+{big(run.item_value)}</b></div>}
    {show('potions') && usedPotions.length > 0 && <div className="ov-tally used"><i className="ov-sign minus" title={tr('消耗', 'Used')}>−</i>
      <span className="ov-icons">{usedPotions.slice(0, 3).map(c => <span key={c.item_id} title={c.name || ''}><img src={itemIcon(c.item_id)} alt="" />{c.used}</span>)}</span>
      <b className="minus">−{big(run.consume_cost)}</b></div>}
    <Ground live={live} /></section>}
    {show('buffs') && <Buffs live={live} settings={settings} tiles section voice={!!grip} />}
    {party}{toast && <div className="ov-toast"><img src={itemIcon(toast.item_id)} alt="" />{toast.name} <b>{big(toast.value)}</b></div>}
    <div className="ov-foot"><UpdateButton update={update} onUpdate={onUpdate} /><span className="ov-site">mxd.ruit.me</span></div></>);
  if (o.layout === 'compact') return box(<><div className="ov-line">{dot}
    {show('time') && <span><Clock3 size={I} style={ico} /><b>{clock(run.active_seconds)}</b></span>}
    {show('level') && <span><TrendingUp size={I} style={ico} />{percent(run.exp_percent, 1)}</span>}
    {show('kills') && <span><Swords size={I} style={ico} />{big(run.kills_per_hour)}</span>}
    {show('dps') && <span title="DPS · 1m"><CrosshairIcon /><b>{big(run.dps)}</b><small>DPS</small></span>}
    {show('potions') && potionChip}
    {show('buffs') && <Buffs live={live} settings={settings} icons voice={!!grip} />}
    {toast && <span className="ov-toast-inline"><img src={itemIcon(toast.item_id)} alt="" />{big(toast.value)}</span>}</div><div className="ov-compact-metrics">{show('exp_rate') && <RateMetrics run={run} kind="exp" />}{show('profit') && <RateMetrics run={run} kind="net" />}{show('profit') && rule && <RateMetrics run={run} kind="points" rule={rule} />}</div>{party}</>);
  if (o.layout === 'big') return box(<>
    {show('exp_rate') && <RateMetrics run={run} kind="exp" />}
    {show('profit') && <RateMetrics run={run} kind="net" />}{show('profit') && rule && <RateMetrics run={run} kind="points" rule={rule} />}
    {show('dps') && <div className="ov-row"><CrosshairIcon /><b>{big(run.dps)}</b><span className="dim">DPS · 1m</span></div>}
    {show('level') && <div className="ov-row">{level}</div>}
    <Ground live={live} />
    {show('buffs') && <Buffs live={live} settings={settings} icons voice={!!grip} />}
    {party}{toast && <div className="ov-toast"><img src={itemIcon(toast.item_id)} alt="" />{toast.name} <b>{big(toast.value)}</b></div>}</>);
  if (o.layout === 'rail') return box(<>
    <div className="ov-cell">{dot}<b>{clock(run.active_seconds)}</b></div>
    {show('exp_rate') && <RateMetrics run={run} kind="exp" />}
    {show('level') && <div className="ov-cell"><TrendingUp size={I} style={ico} /><b>{percent(run.exp_percent, 1)}</b></div>}
    {show('level') && <div className="ov-cell dim"><Hourglass size={I} style={ico} />{duration(run.eta_seconds)}</div>}
    {show('profit') && <RateMetrics run={run} kind="net" />}{show('profit') && rule && <RateMetrics run={run} kind="points" rule={rule} />}
    {show('kills') && <div className="ov-cell"><Swords size={I} style={ico} />{big(run.kills)}</div>}
    {show('dps') && <div className="ov-cell"><CrosshairIcon /><b>{big(run.dps)}</b><small>DPS</small></div>}
    {show('potions') && potion && <div className="ov-cell"><img src={itemIcon(potion.item_id)} alt="" />{tr('用', 'Used ')}{potion.used}</div>}
    {show('buffs') && <Buffs live={live} settings={settings} icons voice={!!grip} />}
    {party}{toast && <div className="ov-toast"><img src={itemIcon(toast.item_id)} alt="" /><b>{big(toast.value)}</b></div>}</>);
  const detailed = o.layout === 'detailed';
  return box(<>
    <div className="ov-head"><div className="ov-site">mxd.ruit.me</div>{dot}<b className="ov-job">{run.job_name || '—'} · Lv.{run.level ?? '—'}</b><span>{mapLabel(run)}</span>
      {show('time') && <em><Clock3 size={I} style={ico} />{clock(run.active_seconds)}</em>}<Recording run={run} /></div>
    {show('exp_rate') && <RateMetrics run={run} kind="exp" />}
    {show('level') && <div className="ov-row">{level}</div>}
    {show('dps') && <div className="ov-row"><CrosshairIcon /><b className="big">{big(run.dps)}</b><span className="dim">DPS · 1m</span></div>}
    {show('profit') && <RateMetrics run={run} kind="net" />}{show('profit') && rule && <RateMetrics run={run} kind="points" rule={rule} />}
    <div className="ov-accounts">
    {show('potions') && potion && <section className="ov-account"><div className="ov-account-heading"><b className="ov-account-title">{tr('消耗', 'Used')}</b><b className="amount gold">−{big(run.consume_cost)} <MesosIcon size={12} /></b></div>
      {usedPotions.map(c => <div className="ov-loot ov-account-row" key={c.item_id}>
        <span><img src={itemIcon(c.item_id)} alt="" />{c.name}</span><b className="quantity">×{c.used}</b><b className="amount">−{big(c.cost ?? null)} <MesosIcon size={11} aria-label={tr('金币', 'mesos')} /></b></div>)}</section>}
    {show('recent') && <section className="ov-account"><div className="ov-account-heading"><b className="ov-account-title">{tr('战利品', 'Loot')}</b><b className="amount gold">+{big(run.mesos + run.item_value)} <MesosIcon size={12} /></b></div>{run.mesos > 0 && <div className="ov-loot ov-account-row ov-mesos"><span><MesosIcon size={15} />{tr('金币', 'Mesos')}</span><b className="quantity"></b><b className="amount">+{big(run.mesos)} <MesosIcon size={11} /></b></div>}{loot(detailed ? 6 : 2)}</section>}
    </div>
    {(show('kills') || detailed) && <div className="ov-row"><Swords size={I} style={ico} /><b>{big(run.kills)}</b>
      <span className="dim">{`${big(run.kills_per_hour)}/h`}</span></div>}
    {show('kills') && <div className="ov-mobs">{run.mobs.slice(0, detailed ? 3 : 2).map(m => <div className="ov-loot" key={m.mob_id}><span><img src={mobIcon(m.mob_id)} alt="" />{m.name}</span><b>×{m.kills}</b></div>)}</div>}
    <Ground live={live} />
    {show('buffs') && <Buffs live={live} settings={settings} voice={!!grip} />}
    {party}
    {toast && <div className="ov-toast"><img src={itemIcon(toast.item_id)} alt="" />{toast.name} <b>{big(toast.value)}</b></div>}
  </>);
}
/** Valuable drops of this character or its party (newest first): still on the ground and for
 * how long (they vanish at about 120 s), who picked each up, or that nobody did. */
function groundRows(live: Live | null) {
  return (live?.characters || []).flatMap(c => c.drops || []).filter(d => d.how !== 'gone').sort((a, b) => b.t - a.t).slice(0, 4);
}
function Ground({ live }: { live: Live | null }) {
  const now = live?.alive_at || Date.now() / 1000;
  const rows = groundRows(live);
  if (!rows.length) return null;
  const status = (d: GroundDrop) => {
    if (!d.how) {
      const age = Math.max(0, Math.round(now - d.t));
      return <b className={age >= 90 ? 'warn' : 'dim'}>{tr(`地上 ${age}秒`, `on ground ${age}s`)}</b>;
    }
    if (d.how === 'expired') return <b className="warn">{tr('没人捡，消失了', 'expired')}</b>;
    const who = d.taker === 'me' ? tr('你', 'You') : d.taker_name || tr('别人', 'Someone');
    return <b className={d.taker === 'other' ? 'warn' : 'ok'}>✓ {d.how === 'pet' ? tr(`${who}的宠物捡了`, `${who}'s pet`) : tr(`${who}捡了`, `${who}`)}</b>;
  };
  return <div className="ov-ground" aria-label={tr('掉落', 'Drops')}>{rows.map(d =>
    <div className={'ov-ground-row' + (d.how ? ' done' : '')} key={`${d.object}@${d.t}`}>
      <span><img src={itemIcon(d.item_id)} alt="" />{d.name && !d.name.startsWith('#') ? d.name : `#${d.item_id}`}
        <small>{d.by === 'me' ? tr('你打的', 'yours') : d.by === 'party' ? d.by_name || tr('队友', 'party') : ''}</small></span>{status(d)}</div>)}</div>;
}
/** "更新到 vX" when the collector has a release ready (same as its window's footer). */
function UpdateButton({ update, onUpdate }: { update: ClientUpdate | null; onUpdate?(): void }) {
  if (!update || !onUpdate) return <span />;
  if (update.state === 'requested' || update.state === 'restarting') return <span className="ov-updating">{tr('正在更新…', 'Updating…')}</span>;
  if (update.state !== 'ready_to_update') return <span />;
  const tag = update.version ? 'v' + update.version.replace(/^v/, '') : tr('新版本', 'new version');
  return <button type="button" data-press="update" className="ov-update" title={tr('客户端会短暂重启，游戏无需退出', 'The collector restarts briefly; the game stays open')}
    onMouseDown={e => e.stopPropagation()} onClick={onUpdate}>{tr(`更新到 ${tag}`, `Update to ${tag}`)}</button>;
}

/** "● 记录中" or why it is paused. */
function Recording({ run }: { run: { status: string } & Parameters<typeof statusLabel>[0] }) {
  return <b className={'ov-rec ' + (run.status === 'active' ? 'on' : 'pause')}>{statusLabel(run)}</b>;
}

/** Bottom of the card: pause / resume, and end (a second click within 3 s confirms). */
function Controls({ paused, command }: { paused: boolean; command?(action: 'toggle' | 'end'): void }) {
  const [armed, setArmed] = useState(false);
  useEffect(() => { if (!armed) return; const id = setTimeout(() => setArmed(false), 3000); return () => clearTimeout(id); }, [armed]);
  const keep = (e: React.MouseEvent) => e.stopPropagation(); // not the window's drag-to-move
  return <div className="ov-controls">
    <button type="button" data-press="pause" onMouseDown={keep} onClick={() => command?.('toggle')}>
      {paused ? <Play size={I} style={ico} /> : <Pause size={I} style={ico} />}{paused ? tr('继续', 'Resume') : tr('暂停', 'Pause')}</button>
    <button type="button" data-press="end" className={'end' + (armed ? ' armed' : '')} onMouseDown={keep}
      onClick={() => { if (armed) { setArmed(false); command?.('end'); } else setArmed(true); }}>
      <Square size={I} style={ico} />{armed ? tr('再点一次结束', 'Click again to end') : tr('结束', 'End')}</button>
  </div>;
}
function CrosshairIcon() { return <Crosshair size={I} style={ico} />; }

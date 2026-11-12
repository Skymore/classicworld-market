import { RateMetrics } from './grind-metrics';
import { useCallback, useEffect, useState } from 'react';
import { AlertCircle, Crosshair, Move, Pause, Play, RefreshCw, Square } from 'lucide-react';
import { itemIcon, monthDay } from './format';
import { tr } from './i18n';
import {
  big, buffLeft, clock, currentBuffs, duration, grind, mapLabel, percent, statLine, statusLabel,
  type GrindSettings, type GrindState, type HotkeyAction, type Live, type RunSummary,
} from './grind';

type View = 'live' | 'history' | 'settings';
const POLL_MS = 1000;

export default function GrindPage({ hidden }: { hidden: boolean }) {
  const [view, setView] = useState<View>('live');
  const [state, setState] = useState<GrindState | null>(null), [error, setError] = useState('');
  const [history, setHistory] = useState<RunSummary[] | null>(null);
  const load = useCallback(async () => {
    try { setState(await grind('state')); setError(''); }
    catch (e) { setError(String((e as Error)?.message || e)); }
  }, []);
  useEffect(() => {
    if (hidden) return;
    load();
    const id = setInterval(load, POLL_MS);
    window.addEventListener('pywebviewready', load);
    return () => { clearInterval(id); window.removeEventListener('pywebviewready', load); };
  }, [hidden, load]);
  useEffect(() => {
    if (hidden || view !== 'history') return;
    grind('history').then(setHistory).catch(() => setHistory([]));
  }, [hidden, view]);
  type Changes = Partial<Omit<GrindSettings, 'overlay' | 'hotkeys'>> & { overlay?: Partial<GrindSettings['overlay']>; hotkeys?: Partial<GrindSettings['hotkeys']> };
  const save = async (changes: Changes) => {
    try { const settings = await grind('settings', changes); setState(s => s && { ...s, settings }); }
    catch (e) { setError(String((e as Error)?.message || e)); }
  };
  const edit = async (on: boolean) => { await grind('overlay_edit', on).catch(() => null); load(); };
  const command = async (action: string) => {
    try { await grind('command', action); setTimeout(load, 1200); } catch (e) { setError(String((e as Error)?.message || e)); }
  };
  if (hidden) return null;
  const live = state?.live, run = live?.runs?.[0] ?? null, settings = state?.settings;
  return <div className="grind-page" data-grind-page>
    {error && <div role="alert" className="error-banner"><AlertCircle size={18} /><span>{error === 'unavailable' ? tr('刷图记录暂不可用', 'Grind tracker unavailable') : error}</span></div>}
    <section className="stall grind-head"><div className="stall-bar"><Crosshair size={18} /><h2>{tr('刷图', 'Grind')}</h2>
      <nav className="grind-tabs" aria-label={tr('刷图', 'Grind')}>
        {([['live', '实时', 'Live'], ['history', '历史', 'History'], ['settings', '设置', 'Settings']] as [View, string, string][]).map(([key, zh, en]) =>
          <button key={key} aria-pressed={view === key} onClick={() => setView(key)}>{tr(zh, en)}</button>)}
      </nav>
      <span className={`connection ${live && !live.stale ? 'live' : ''}`}><i />{!live || live.stale ? tr('等待采集器', 'Waiting for the collector') : run ? statusLabel(run) : tr('等待打怪', 'Waiting for kills')}</span>
      {run && run.status !== 'ended' && <span className="grind-tools">
        <button className="text-link" onClick={() => command(run.status === 'active' ? 'pause' : 'resume')}>
          {run.status === 'active' ? <Pause size={14} /> : <Play size={14} />}{run.status === 'active' ? tr('暂停', 'Pause') : tr('继续', 'Resume')}</button>
        <button className="text-link" onClick={() => command('end')}><Square size={13} />{tr('结束本次', 'End run')}</button>
      </span>}
      {settings && <span className="grind-tools">
        <label className="check-chip"><input type="checkbox" checked={settings.overlay.enabled} onChange={e => save({ overlay: { enabled: e.target.checked } })} />{tr('悬浮窗', 'Overlay')}</label>
        {settings.overlay.enabled && <button className="text-link" aria-pressed={state?.editing} onClick={() => edit(!state?.editing)}>
          <Move size={14} />{state?.editing ? tr('完成', 'Done') : tr('调整位置', 'Move')}</button>}
      </span>}
    </div></section>
    {live?.protocol_warning && <div role="alert" className="error-banner"><AlertCircle size={18} />
      <span>{tr('游戏报文格式可能已变化，部分数字暂不可信；已自动开始录制，请把采集器更新到最新版。', 'The game messages may have changed; some numbers are unreliable. Recording started; update the collector.')}</span></div>}
    <div className="grind-body">
      {view === 'live' && <BuffStrip live={live ?? null} warn={settings?.buff_warn_seconds ?? 10} />}
      {view === 'live' && <LiveView run={run} live={live ?? null} />}
      {view === 'history' && <HistoryView runs={history} />}
      {view === 'settings' && settings && state && <SettingsView state={state} settings={settings} save={save} refresh={load} />}
    </div>
  </div>;
}

function Tile({ label, value, note, strong }: { label: string; value: string; note?: string; strong?: boolean }) {
  return <div className={'grind-tile' + (strong ? ' strong' : '')}><small>{label}</small><b>{value}</b>{note && <span>{note}</span>}</div>;
}

function LiveView({ run, live }: { run: RunSummary | null; live: GrindState['live'] }) {
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
    <div className="grind-rate-panels"><RateMetrics run={run} kind="exp" /><RateMetrics run={run} kind="net" /></div>
    <div className="grind-ledger">
      <span>{tr('金币', 'Mesos')} <b>+{big(run.mesos)}</b></span>
      <span>{tr('物品', 'Items')} <b>+{big(run.item_value)}</b></span>
      <span>{tr('消耗', 'Used')} <b>−{big(run.consume_cost)}</b></span>
      {run.mesos_spent > 0 && <span>{tr('花费', 'Spent')} <b>−{big(run.mesos_spent)}</b></span>}
      <span className="net">{tr('净收益', 'Net')} <b>{big(run.net)}</b></span>
      <span>{tr('经验', 'EXP')} <b>{big(run.exp)}</b></span>
    </div>
    {!!run.combat?.length && <section className="well grind-combat" aria-label={tr('队伍战斗统计', 'Party combat')}>
      <div className="well-h"><h3>{tr('战斗统计', 'Combat')}</h3><small>{tr('同图可见范围', 'Visible in this map')}</small></div>
      <table><thead><tr><th>{tr('角色', 'Player')}</th><th>DPS · 1m</th><th>{tr('总伤害', 'Damage')}</th><th>{tr('击杀', 'Kills')}</th></tr></thead>
        <tbody>{run.combat.map(row => <tr key={row.character_id} data-self={row.self || undefined}>
          <td>{row.name || '—'}{row.self && <small>{tr('你', 'You')}</small>}{row.away && <small>{tr('离开', 'Away')}</small>}
            {row.partial && <small className="warn">{tr('数据不完整', 'Partial data')}</small>}</td>
          <td>{big(row.dps)}</td><td>{big(row.damage)}{row.partial && row.damage != null ? '+' : ''}</td><td>{big(row.kills)}</td>
        </tr>)}</tbody></table>
      {run.party_known === false && <p className="note">{tr('等待队伍数据，换一次频道后同步。', 'Waiting for party data. Change channel to sync.')}</p>}
    </section>}
    <div className="grind-grid">
      <section className="well">
        <div className="well-h"><h3>{tr('本次战利品', 'Loot this run')}</h3></div>
        {(run.loot || run.recent || []).map((row, i) => <div className={'grind-row grind-account-row' + (row.notable ? ' notable' : '')} key={i}>
          <img src={itemIcon(row.item_id)} alt="" width={24} height={24} loading="lazy" />
          <span className="t"><b>{row.name}</b>{row.stats?.length ? <small className="stats"> {statLine(row.stats)}</small> : null}</span>
          <span className="quantity">×{row.quantity}</span><span className="amount" title={row.basis || ''}>{row.priced === false || !row.basis || row.basis === '无价格' ? tr('待估价', 'Unpriced') : `+${big(row.value)} ${tr('金币', 'mesos')}`}</span>
        </div>)}
        {!(run.loot || run.recent)?.length && <p className="note">{tr('还没有拾取。', 'Nothing picked up yet.')}</p>}
      </section>
      <section className="well">
        <div className="well-h"><h3>{tr('消耗品', 'Consumables')}</h3></div>
        {run.consumables.filter(row => row.used > 0).map(row => <div className="grind-row grind-account-row" key={row.item_id}>
          <img src={itemIcon(row.item_id)} alt="" width={24} height={24} loading="lazy" />
          <span className="t"><b>{row.name}</b></span>
          <span className="quantity">×{row.used}</span><span className="amount">−{big(row.cost ?? null)} {tr('金币', 'mesos')}</span>
        </div>)}
        {!run.consumables.some(row => row.used > 0) && <p className="note">{tr('还没有使用消耗品。', 'No consumables used yet.')}</p>}
        <div className="well-h sub"><h3>{tr('击杀', 'Kills')}</h3>
          {run.hp_drops > 0 && <small>{tr(`HP 下降 ${run.hp_drops} 次 · 共 ${big(run.hp_lost)}`, `HP lost ${run.hp_drops}× · ${big(run.hp_lost)}`)}</small>}</div>
        {run.mobs.map(m => <div className="grind-row" key={m.mob_id}><span className="t"><b>{m.name}</b></span><span className="v">{m.kills}</span></div>)}
        {!run.mobs.length && <p className="note">{run.kills_estimated ? tr('换一次频道后按怪物分类统计。', 'Change channel once to split kills by monster.') : tr('还没有击杀。', 'No kills yet.')}</p>}
        {(run.attack_count > 0 || run.casts?.length > 0) && <>
          <div className="well-h sub"><h3>{tr('攻击与技能', 'Attacks and skills')}</h3>
            <small>{tr(`攻击 ${run.attack_count} 次`, `${run.attack_count} attacks`)}{run.kills > 0 && run.attack_count > 0 ? tr(` · 每只 ${(run.attack_count / run.kills).toFixed(1)} 次`, ` · ${(run.attack_count / run.kills).toFixed(1)} per kill`) : ''}</small></div>
          {(run.attacks || []).map(a => <div className="grind-row" key={'a' + a.skill}><span className="t"><b>{a.skill ? a.name : tr('普通攻击', 'Plain attack')}</b></span><span className="v">{a.count}</span></div>)}
          {(run.casts || []).map(a => <div className="grind-row" key={'c' + a.skill}><span className="t"><b>{a.name}</b><small> {tr('施放', 'cast')}</small></span><span className="v">{a.count}</span></div>)}
        </>}
        <div className="well-h sub"><h3>{tr('掉落汇总', 'Drops')}</h3></div>
        <div className="grind-drops">{run.drops.slice(0, 24).map(d => <span key={d.item_id} title={d.name || ''}>
          <img src={itemIcon(d.item_id)} alt={d.name || ''} width={22} height={22} loading="lazy" /><b>{d.quantity}</b></span>)}</div>
      </section>
    </div>
  </>;
}

function HistoryView({ runs }: { runs: RunSummary[] | null }) {
  if (runs == null) return <p className="note">{tr('读取中…', 'Loading…')}</p>;
  if (!runs.length) return <p className="grind-empty">{tr('还没有记录。', 'No runs yet.')}</p>;
  return <table className="grind-history">
    <thead><tr>
      <th>{tr('日期', 'Date')}</th><th>{tr('角色', 'Character')}</th><th>{tr('地图', 'Map')}</th><th>{tr('时长', 'Time')}</th>
      <th>EXP/h</th><th>{tr('收益/时', 'Profit/h')}</th><th>{tr('击杀', 'Kills')}</th><th>{tr('等级', 'Level')}</th>
    </tr></thead>
    <tbody>{runs.map(run => <tr key={run.id}>
      <td>{monthDay(run.started_at)} {new Date(run.started_at * 1000).toTimeString().slice(0, 5)}</td>
      <td>{run.character.name || '—'} <small>{run.job_name}</small></td>
      <td>{mapLabel(run)}{run.segments.length > 1 && <small> +{run.segments.length - 1}</small>}</td>
      <td>{clock(run.active_seconds)}</td><td>{big(run.exp_per_hour)}</td><td>{big(run.net_per_hour)}</td>
      <td>{big(run.kills)}</td><td>{run.level_start ?? '—'}{run.level != null && run.level !== run.level_start ? ` → ${run.level}` : ''}</td>
    </tr>)}</tbody>
  </table>;
}

function NumberField({ label, value, min, max, step = 1, onChange }: { label: string; value: number; min: number; max: number; step?: number; onChange(v: number): void }) {
  const [text, setText] = useState(String(value));
  useEffect(() => setText(String(value)), [value]);
  return <label className="grind-field"><span>{label}</span>
    <input type="number" value={text} min={min} max={max} step={step} onChange={e => setText(e.target.value)}
      onBlur={() => { const v = Number(text); if (Number.isFinite(v) && v >= min && v <= max) onChange(v); else setText(String(value)); }} /></label>;
}

function Check({ label, checked, onChange }: { label: string; checked: boolean; onChange(v: boolean): void }) {
  return <label className="grind-check"><input type="checkbox" checked={checked} onChange={e => onChange(e.target.checked)} />{label}</label>;
}

const HOTKEYS: [HotkeyAction, string, string][] = [
  ['pause', '暂停 / 继续', 'Pause / resume'], ['end', '结束本次', 'End run'],
  ['overlay', '显示 / 隐藏悬浮窗', 'Show / hide overlay'], ['edit', '调整悬浮窗位置', 'Move overlay'],
];

/** Press a combination to set it; Backspace clears. */
function HotkeyField({ label, value, error, onChange }: { label: string; value: string; error?: string; onChange(v: string): void }) {
  const [listening, setListening] = useState(false);
  const keyName = (e: React.KeyboardEvent) => {
    if (/^F([1-9]|1[0-2])$/.test(e.key)) return e.key;
    if (/^Key[A-Z]$/.test(e.code)) return e.code.slice(3);
    if (/^Digit[0-9]$/.test(e.code)) return e.code.slice(5);
    return null;
  };
  return <label className="grind-field"><span>{label}{error && <small className="warn"> {error === 'taken' ? tr('已被占用', 'in use') : tr('不支持', 'unsupported')}</small>}</span>
    <input className="hotkey-input" readOnly value={listening ? tr('按下组合键…', 'Press keys…') : value || tr('未设置', 'None')}
      onFocus={() => setListening(true)} onBlur={() => setListening(false)}
      onKeyDown={e => {
        e.preventDefault();
        if (e.key === 'Backspace' || e.key === 'Delete') { onChange(''); (e.target as HTMLInputElement).blur(); return; }
        const key = keyName(e);
        if (!key) return;
        const combo = [e.ctrlKey && 'Ctrl', e.altKey && 'Alt', e.shiftKey && 'Shift', key].filter(Boolean).join('+');
        if (!/^F/.test(key) && !e.ctrlKey && !e.altKey) return; // bare letters would fire while typing in game
        onChange(combo); (e.target as HTMLInputElement).blur();
      }} /></label>;
}

/** Active buffs with their countdown. */
function BuffStrip({ live, warn }: { live: Live | null; warn: number }) {
  const [, tick] = useState(0);
  useEffect(() => { const id = setInterval(() => tick(n => n + 1), 250); return () => clearInterval(id); }, []);
  const buffs = currentBuffs(live).map(b => ({ ...b, left: buffLeft(b, live) })).filter(b => b.left > 0);
  if (!buffs.length) return null;
  return <section className="well grind-buffs"><div className="well-h"><h3>Buff</h3></div>
    <div className="grind-buff-list">{buffs.map(b => <div key={b.source} className={'grind-buff' + (b.left <= warn ? ' warn' : '')}>
      <span className="t">{b.name}</span><span className="bar"><i style={{ width: `${Math.min(100, b.left / b.total * 100)}%` }} /></span>
      <b>{clock(b.left)}</b></div>)}</div></section>;
}

const FIELDS: [string, string, string][] = [
  ['time', '时长', 'Time'], ['exp_rate', '经验/时', 'EXP/h'], ['level', '等级进度', 'Level'], ['profit', '收益', 'Profit'],
  ['buffs', 'Buff 倒计时', 'Buffs'],
  ['kills', '击杀', 'Kills'], ['dps', 'DPS', 'DPS'], ['party', '队伍战斗', 'Party combat'],
  ['recent', '本次战利品', 'Loot'], ['potions', '药品使用', 'Potions used'],
];

function SettingsView({ state, settings, save, refresh }: {
  state: GrindState; settings: GrindSettings; refresh(): void;
  save(changes: Partial<Omit<GrindSettings, 'overlay' | 'hotkeys'>> & { overlay?: Partial<GrindSettings['overlay']>; hotkeys?: Partial<GrindSettings['hotkeys']> }): void;
}) {
  const o = settings.overlay;
  const calibration = state.calibration?.summary ?? state.live?.calibration ?? [];
  return <div className="grind-settings">
    <section className="well"><div className="well-h"><h3>{tr('自动记录', 'Automatic recording')}</h3></div>
      <Check label={tr('开启刷图记录', 'Record grinding')} checked={settings.enabled} onChange={v => save({ enabled: v })} />
      <NumberField label={tr('空闲多少秒暂停', 'Pause after idle (s)')} value={settings.idle_seconds} min={20} max={900} onChange={v => save({ idle_seconds: v })} />
      <NumberField label={tr('暂停多少秒结束', 'End after paused (s)')} value={settings.end_after_seconds} min={60} max={7200} onChange={v => save({ end_after_seconds: v })} />
      <NumberField label={tr('连续几次经验开始', 'EXP gains to start')} value={settings.start_events} min={2} max={20} onChange={v => save({ start_events: v })} />
    </section>
    <section className="well"><div className="well-h"><h3>{tr('估价', 'Valuation')}</h3></div>
      <div className="grind-radio" role="radiogroup" aria-label={tr('物品估价', 'Item value')}>
        {([['typical', '成交中位', 'Median sale'], ['npc', 'NPC 回收价', 'NPC buy-back'], ['none', '不计物品', 'Ignore items']] as const).map(([key, zh, en]) =>
          <label key={key}><input type="radio" name="price-basis" checked={settings.price_basis === key} onChange={() => save({ price_basis: key })} />{tr(zh, en)}</label>)}
      </div>
      <NumberField label={tr('高价值提醒（金币）', 'Highlight loot worth')} value={settings.notable_value} min={0} max={10_000_000_000} step={10000} onChange={v => save({ notable_value: v })} />
      <Check label={tr('刷图时花掉的金币计入支出', 'Count mesos spent while grinding')} checked={settings.count_mesos_spent} onChange={v => save({ count_mesos_spent: v })} />
      <Check label={tr('匿名上传地图效率', 'Share map results anonymously')} checked={settings.upload} onChange={v => save({ upload: v })} />
    </section>
    <section className="well"><div className="well-h"><h3>{tr('悬浮窗', 'Overlay')}</h3></div>
      <Check label={tr('显示悬浮窗', 'Show overlay')} checked={o.enabled} onChange={v => save({ overlay: { enabled: v } })} />
      <div className="grind-radio" role="radiogroup" aria-label={tr('样式', 'Layout')}>
        {([['compact', '一行', 'Bar'], ['standard', '标准', 'Card'], ['detailed', '详细', 'Detailed'], ['rail', '竖条', 'Rail'], ['big', '大数字', 'Big']] as const).map(([key, zh, en]) =>
          <label key={key}><input type="radio" name="overlay-layout" checked={o.layout === key} onChange={() => save({ overlay: { layout: key } })} />{tr(zh, en)}</label>)}
      </div>
      <div className="grind-radio" role="radiogroup" aria-label={tr('主题', 'Theme')}>
        {([['dark', '暗色', 'Dark'], ['market', '市集', 'Market'], ['cute', '可爱', 'Cute'], ['maple', '冒险', 'Adventure']] as const).map(([key, zh, en]) =>
          <label key={key}><input type="radio" name="overlay-theme" checked={(o.theme || 'dark') === key} onChange={() => save({ overlay: { theme: key } })} />{tr(zh, en)}</label>)}
      </div>
      <label className="grind-field"><span>{tr('不透明度', 'Opacity')}</span>
        <input type="range" min={0.3} max={1} step={0.05} value={o.opacity} onChange={e => save({ overlay: { opacity: Number(e.target.value) } })} /></label>
      <label className="grind-field"><span>{tr('大小', 'Size')}</span>
        <input type="range" min={0.7} max={1.6} step={0.1} value={o.scale} onChange={e => save({ overlay: { scale: Number(e.target.value) } })} /></label>
      <Check label={tr('鼠标穿透', 'Click-through')} checked={o.click_through} onChange={v => save({ overlay: { click_through: v } })} />
      <Check label={tr('录屏和直播时隐藏', 'Hide from recordings')} checked={o.hide_in_capture} onChange={v => save({ overlay: { hide_in_capture: v } })} />
      <div className="grind-fields">{FIELDS.map(([key, zh, en]) => <Check key={key} label={tr(zh, en)} checked={o.fields.includes(key)}
        onChange={v => save({ overlay: { fields: v ? [...o.fields, key] : o.fields.filter(f => f !== key) } })} />)}</div>
    </section>
    <section className="well"><div className="well-h"><h3>{tr('Buff 与热键', 'Buffs and hotkeys')}</h3></div>
      <NumberField label={tr('Buff 剩余几秒提醒', 'Warn when a buff has (s) left')} value={settings.buff_warn_seconds} min={0} max={120} onChange={v => save({ buff_warn_seconds: v })} />
      <Check label={tr('Buff 快结束时提示音', 'Sound before a buff ends')} checked={settings.buff_sound} onChange={v => save({ buff_sound: v })} />
      {HOTKEYS.map(([key, zh, en]) => <HotkeyField key={key} label={tr(zh, en)} value={settings.hotkeys?.[key] || ''}
        error={state.hotkey_errors?.[key]} onChange={v => save({ hotkeys: { [key]: v } })} />)}
    </section>
    <section className="well"><div className="well-h"><h3>{tr('协议标定', 'Calibration')}</h3>
      <button className="text-link" disabled={state.calibrating} onClick={() => grind('calibrate').then(refresh)}><RefreshCw size={14} />{state.calibrating ? tr('标定中…', 'Calibrating…') : tr('立即标定', 'Calibrate now')}</button></div>
      {calibration.map(row => <div className="grind-cal" key={row.label}><span>{row.label}</span><b className={row.state === '已确认' ? 'ok' : ''}>{row.state}</b></div>)}
      <Check label={tr('标定完成前录制报文（仅本机）', 'Record frames until calibrated (this PC only)')} checked={settings.record_frames} onChange={v => save({ record_frames: v })} />
      {state.live && <p className="note">{state.live.recording ? tr('正在录制', 'Recording frames') : tr('未录制', 'Not recording')}</p>}
    </section>
  </div>;
}

import { useCallback, useEffect, useState } from 'react';
import { AlertCircle, Crosshair, Move, RefreshCw } from 'lucide-react';
import { itemIcon, monthDay } from './format';
import { tr } from './i18n';
import {
  big, clock, duration, grind, mapLabel, percent, statLine, statusLabel,
  type GrindSettings, type GrindState, type RunSummary,
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
  const save = async (changes: Partial<GrindSettings> | { overlay: Partial<GrindSettings['overlay']> }) => {
    try { const settings = await grind('settings', changes); setState(s => s && { ...s, settings }); }
    catch (e) { setError(String((e as Error)?.message || e)); }
  };
  const edit = async (on: boolean) => { await grind('overlay_edit', on).catch(() => null); load(); };
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
      {settings && <span className="grind-tools">
        <label className="check-chip"><input type="checkbox" checked={settings.overlay.enabled} onChange={e => save({ overlay: { enabled: e.target.checked } })} />{tr('悬浮窗', 'Overlay')}</label>
        {settings.overlay.enabled && <button className="text-link" aria-pressed={state?.editing} onClick={() => edit(!state?.editing)}>
          <Move size={14} />{state?.editing ? tr('完成', 'Done') : tr('调整位置', 'Move')}</button>}
      </span>}
    </div></section>
    <div className="grind-body">
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
      <Tile strong label={tr('经验 / 小时', 'EXP / hour')} value={big(run.exp_per_hour_5m ?? run.exp_per_hour)}
        note={tr(`平均 ${big(run.exp_per_hour)} · 1分 ${big(run.exp_per_hour_1m)}`, `avg ${big(run.exp_per_hour)} · 1m ${big(run.exp_per_hour_1m)}`)} />
      <Tile label={tr('等级进度', 'Level')} value={percent(run.exp_percent)}
        note={tr(`${percent(run.percent_per_hour)}/时 · 升级 ${duration(run.eta_seconds)}`, `${percent(run.percent_per_hour)}/h · up in ${duration(run.eta_seconds)}`)} />
      <Tile strong label={tr('收益 / 小时', 'Profit / hour')} value={big(run.net_per_hour)}
        note={tr(`本次 ${big(run.net)}`, `total ${big(run.net)}`)} />
      <Tile label={run.kills_estimated ? tr('击杀（按经验）', 'Kills (by EXP)') : tr('击杀', 'Kills')} value={big(run.kills)}
        note={tr(`${big(run.kills_per_hour)}/时`, `${big(run.kills_per_hour)}/h`) + (run.deaths ? tr(` · 死亡 ${run.deaths}`, ` · ${run.deaths} deaths`) : '')} />
    </div>
    <div className="grind-ledger">
      <span>{tr('金币', 'Mesos')} <b>+{big(run.mesos)}</b></span>
      <span>{tr('物品', 'Items')} <b>+{big(run.item_value)}</b></span>
      <span>{tr('消耗', 'Used')} <b>−{big(run.consume_cost)}</b></span>
      {run.mesos_spent > 0 && <span>{tr('花费', 'Spent')} <b>−{big(run.mesos_spent)}</b></span>}
      <span className="net">{tr('净收益', 'Net')} <b>{big(run.net)}</b></span>
      <span>{tr('经验', 'EXP')} <b>{big(run.exp)}</b></span>
    </div>
    <div className="grind-grid">
      <section className="well">
        <div className="well-h"><h3>{tr('最近拾取', 'Recent loot')}</h3></div>
        {(run.recent || []).map((row, i) => <div className={'grind-row' + (row.notable ? ' notable' : '')} key={i}>
          <img src={itemIcon(row.item_id)} alt="" width={24} height={24} loading="lazy" />
          <span className="t"><b>{row.name}</b>{row.quantity > 1 && <small> ×{row.quantity}</small>}{row.stats?.length ? <small className="stats"> {statLine(row.stats)}</small> : null}</span>
          <span className="v" title={row.basis || ''}>{big(row.value)}</span>
        </div>)}
        {!run.recent?.length && <p className="note">{tr('还没有拾取。', 'Nothing picked up yet.')}</p>}
      </section>
      <section className="well">
        <div className="well-h"><h3>{tr('消耗品', 'Consumables')}</h3></div>
        {run.consumables.map(row => <div className="grind-row" key={row.item_id}>
          <img src={itemIcon(row.item_id)} alt="" width={24} height={24} loading="lazy" />
          <span className="t"><b>{row.name}</b><small> {tr(`用了 ${row.used}`, `${row.used} used`)}{row.per_hour ? tr(` · ${Math.round(row.per_hour)}/时`, ` · ${Math.round(row.per_hour)}/h`) : ''}</small></span>
          <span className={'v' + (row.minutes_left != null && row.minutes_left < 15 ? ' warn' : '')}>
            {row.remaining ?? '—'}{row.minutes_left != null ? tr(` · ${Math.round(row.minutes_left)}分`, ` · ${Math.round(row.minutes_left)}m`) : ''}</span>
        </div>)}
        {!run.consumables.length && <p className="note">{tr('还没有用消耗品。', 'No consumables used yet.')}</p>}
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

const FIELDS: [string, string, string][] = [
  ['time', '时长', 'Time'], ['exp_rate', '经验/时', 'EXP/h'], ['level', '等级进度', 'Level'], ['profit', '收益', 'Profit'],
  ['kills', '击杀', 'Kills'], ['recent', '最近拾取', 'Loot'], ['potions', '药水剩余', 'Potions'],
];

function SettingsView({ state, settings, save, refresh }: {
  state: GrindState; settings: GrindSettings; refresh(): void;
  save(changes: Partial<GrindSettings> | { overlay: Partial<GrindSettings['overlay']> }): void;
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
        {([['compact', '一行', 'Bar'], ['standard', '标准', 'Card'], ['detailed', '详细', 'Detailed']] as const).map(([key, zh, en]) =>
          <label key={key}><input type="radio" name="overlay-layout" checked={o.layout === key} onChange={() => save({ overlay: { layout: key } })} />{tr(zh, en)}</label>)}
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
    <section className="well"><div className="well-h"><h3>{tr('协议标定', 'Calibration')}</h3>
      <button className="text-link" disabled={state.calibrating} onClick={() => grind('calibrate').then(refresh)}><RefreshCw size={14} />{state.calibrating ? tr('标定中…', 'Calibrating…') : tr('立即标定', 'Calibrate now')}</button></div>
      {calibration.map(row => <div className="grind-cal" key={row.label}><span>{row.label}</span><b className={row.state === '已确认' ? 'ok' : ''}>{row.state}</b></div>)}
      <Check label={tr('标定完成前录制报文（仅本机）', 'Record frames until calibrated (this PC only)')} checked={settings.record_frames} onChange={v => save({ record_frames: v })} />
      {state.live && <p className="note">{state.live.recording ? tr('正在录制', 'Recording frames') : tr('未录制', 'Not recording')}</p>}
    </section>
  </div>;
}

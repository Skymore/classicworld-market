import { HistoryView } from './grind-history';
import { useCallback, useEffect, useState } from 'react';
import { AlertCircle, Crosshair, Pause, Play, RefreshCw, SlidersHorizontal, Square } from 'lucide-react';
import { OverlayCard } from './overlay-card';
import { BuffStrip, LiveView } from './grind-live';
import { sampleLive } from './overlay-sample';
import { tr } from './i18n';
import {
  grind, statusLabel,
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
  const loadHistory = useCallback(() => { grind('history').then(setHistory).catch(() => setHistory([])); }, []);
  useEffect(() => {
    if (hidden || view !== 'history') return;
    loadHistory();
  }, [hidden, view, loadHistory]);
  type Changes = Partial<Omit<GrindSettings, 'overlay' | 'hotkeys'>> & { overlay?: Partial<GrindSettings['overlay']>; hotkeys?: Partial<GrindSettings['hotkeys']> };
  const save = async (changes: Changes) => {
    try { const settings = await grind('settings', changes); setState(s => s && { ...s, settings }); }
    catch (e) { setError(String((e as Error)?.message || e)); }
  };
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
      <span className={`connection ${live && !live.stale ? 'live' : ''}`}><i />{!live || live.stale ? tr('等待客户端', 'Waiting for the collector') : run ? statusLabel(run) : tr('等待打怪', 'Waiting for kills')}</span>
      {run && run.status !== 'ended' && <span className="grind-tools">
        <button className="text-link" onClick={() => command(run.status === 'active' ? 'pause' : 'resume')}>
          {run.status === 'active' ? <Pause size={14} /> : <Play size={14} />}{run.status === 'active' ? tr('暂停', 'Pause') : tr('继续', 'Resume')}</button>
        <button className="text-link" onClick={() => command('end')}><Square size={13} />{tr('结束本次', 'End run')}</button>
      </span>}
      {settings && <span className="grind-tools">
        <label className="check-chip"><input type="checkbox" checked={settings.overlay.enabled} onChange={e => save({ overlay: { enabled: e.target.checked } })} />{tr('悬浮窗', 'Overlay')}</label>
      </span>}
    </div></section>
    {live?.protocol_warning && <div role="alert" className="error-banner"><AlertCircle size={18} />
      <span>{tr('游戏报文格式可能已变化，部分数字暂不可信；已自动开始录制，请把客户端更新到最新版。', 'The game messages may have changed; some numbers are unreliable. Recording started; update the collector.')}</span></div>}
    <div className="grind-body">
      {view === 'live' && !run && <BuffStrip live={live ?? null} warn={settings?.buff_warn_seconds ?? 10} />}
      {view === 'live' && <LiveView run={run} live={live ?? null} warn={settings?.buff_warn_seconds ?? 10} />}
      {view === 'history' && <HistoryView runs={history as any} reload={loadHistory} />}
      {view === 'settings' && settings && state && <SettingsView state={state} settings={settings} save={save} refresh={load} />}
    </div>
  </div>;
}

function NumberField({ label, unit, value, min, max, step = 1, onChange }: { label: string; unit?: string; value: number; min: number; max: number; step?: number; onChange(v: number): void }) {
  const [text, setText] = useState(String(value));
  useEffect(() => setText(String(value)), [value]);
  return <label className="grind-field"><span>{label}</span>
    <span className="grind-number"><input type="number" value={text} min={min} max={max} step={step} onChange={e => setText(e.target.value)}
      onBlur={() => { const v = Number(text); if (Number.isFinite(v) && v >= min && v <= max) onChange(v); else setText(String(value)); }} />{unit && <small>{unit}</small>}</span></label>;
}

/** One choice out of a few, as joined buttons. */
function Choice<T extends string>({ label, value, options, onChange }: { label: string; value: T; options: readonly (readonly [T, string, string])[]; onChange(v: T): void }) {
  return <div className="grind-field"><span>{label}</span>
    <div className="grind-seg" role="radiogroup" aria-label={label}>{options.map(([key, zh, en]) =>
      <button key={key} type="button" role="radio" aria-checked={value === key} onClick={() => onChange(key)}>{tr(zh, en)}</button>)}</div></div>;
}

function Slider({ label, value, min, max, step, text, onChange }: { label: string; value: number; min: number; max: number; step: number; text: string; onChange(v: number): void }) {
  return <label className="grind-field"><span>{label}</span>
    <span className="grind-slider"><input type="range" min={min} max={max} step={step} value={value} onChange={e => onChange(Number(e.target.value))} /><b>{text}</b></span></label>;
}

function Check({ label, checked, onChange }: { label: string; checked: boolean; onChange(v: boolean): void }) {
  return <label className="grind-check"><input type="checkbox" checked={checked} onChange={e => onChange(e.target.checked)} />{label}</label>;
}

const HOTKEYS: [HotkeyAction, string, string][] = [
  ['pause', '暂停 / 继续', 'Pause / resume'], ['end', '结束本次', 'End run'],
  ['overlay', '显示 / 隐藏悬浮窗', 'Show / hide overlay'],
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

const FIELDS: [string, string, string][] = [
  ['time', '时长', 'Time'], ['exp_rate', '经验/时', 'EXP/h'], ['level', '等级进度', 'Level'], ['profit', '收益', 'Profit'],
  ['buffs', 'Buff 倒计时', 'Buffs'],
  ['kills', '击杀', 'Kills'], ['dps', 'DPS', 'DPS'], ['party', '队伍战斗', 'Party combat'],
  ['recent', '本次战利品', 'Loot'], ['potions', '药品使用', 'Potions used'],
];
/** What to show for a way of playing; "Custom" starts from the one in use. */
const PRESETS: { key: string; zh: string; en: string; layout: GrindSettings['overlay']['layout']; fields: string[] }[] = [
  { key: 'lean', zh: '精简', en: 'Lean', layout: 'slim', fields: ['time', 'exp_rate', 'level', 'buffs'] },
  { key: 'usual', zh: '常用', en: 'Everyday', layout: 'slim', fields: ['time', 'exp_rate', 'profit', 'level', 'buffs', 'potions', 'recent'] },
  { key: 'full', zh: '完整', en: 'Complete', layout: 'slim', fields: ['time', 'exp_rate', 'profit', 'level', 'dps', 'kills', 'buffs', 'potions', 'recent'] },
];

/** The overlay window's width for each shape at 100% (grind_desktop.OVERLAY_SIZES). */
const WIDTH: Record<GrindSettings['overlay']['layout'], number> = { slim: 260, compact: 840, standard: 330, detailed: 360, rail: 140, big: 290 };

/** The overlay as it will look, drawn small. */
function OverlayPreview({ settings, layout, fields, live, scale, wide = false }: {
  settings: GrindSettings; layout: GrindSettings['overlay']['layout']; fields: string[]; live: Live | null; scale: number; wide?: boolean;
}) {
  const shown = { ...settings, buff_sound: false, overlay: { ...settings.overlay, layout, fields, opacity: 1 } };
  return <span className={'grind-preview' + (wide ? ' wide' : '')} aria-hidden="true">
    <span style={{ width: WIDTH[layout] * scale }}><OverlayCard live={live} settings={shown} scale={scale} /></span></span>;
}

function Pick({ label, checked, onPick, wide = false, children }: { label: string; checked: boolean; onPick(): void; wide?: boolean; children: React.ReactNode }) {
  return <div className={'grind-preset' + (wide ? ' wide' : '')} role="radio" tabIndex={0} aria-checked={checked} aria-label={label} onClick={onPick}
    onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onPick(); } }}>{wide ? <b>{label}{children}</b> : <>{children}<b>{label}</b></>}</div>;
}

function SettingsView({ state, settings, save, refresh }: {
  state: GrindState; settings: GrindSettings; refresh(): void;
  save(changes: Partial<Omit<GrindSettings, 'overlay' | 'hotkeys'>> & { overlay?: Partial<GrindSettings['overlay']>; hotkeys?: Partial<GrindSettings['hotkeys']> }): void;
}) {
  const o = settings.overlay;
  const calibration = state.calibration?.summary ?? state.live?.calibration ?? [];
  const preset = PRESETS.find(p => p.layout === o.layout && p.fields.length === o.fields.length && p.fields.every(f => o.fields.includes(f)));
  // "Custom" opens the shape and field choices on top of whichever preset is in use.
  const [custom, setCustom] = useState(!preset);
  const tailoring = custom || !preset;
  // Previews show the run being recorded, or a sample hour when there is none.
  const [sample, setSample] = useState(sampleLive);
  useEffect(() => { const id = setInterval(() => setSample(sampleLive()), 60_000); return () => clearInterval(id); }, []);
  const shownLive = state.live?.runs?.length ? state.live : sample;
  return <div className="grind-settings">
    <section className="well"><div className="well-h"><h3>{tr('悬浮窗', 'Overlay')}</h3></div>
      <Check label={tr('显示悬浮窗', 'Show overlay')} checked={o.enabled} onChange={v => save({ overlay: { enabled: v } })} />
      <div className="grind-presets" role="radiogroup" aria-label={tr('预设', 'Preset')}>
        {PRESETS.map(p => <Pick key={p.key} label={tr(p.zh, p.en)} checked={!tailoring && preset === p}
          onPick={() => { setCustom(false); save({ overlay: { layout: p.layout, fields: p.fields } }); }}>
          <OverlayPreview settings={settings} layout={p.layout} fields={p.fields} live={shownLive} scale={Math.min(.8, 236 / WIDTH[p.layout])} /></Pick>)}
        <Pick wide label={tr('自定义', 'Custom')} checked={tailoring} onPick={() => setCustom(true)}><SlidersHorizontal size={15} /></Pick>
      </div>
      {tailoring && <>
        <OverlayPreview wide settings={settings} layout={o.layout} fields={o.fields} live={shownLive} scale={Math.min(.8, 760 / WIDTH[o.layout])} />
        <Choice label={tr('形状', 'Shape')} value={o.layout} onChange={v => save({ overlay: { layout: v } })}
          options={[['slim', '紧凑', 'Slim'], ['compact', '一行', 'Bar'], ['standard', '标准', 'Card'], ['detailed', '详细', 'Detailed'], ['rail', '竖条', 'Rail'], ['big', '大数字', 'Big']] as const} />
        <div className="grind-fields">{FIELDS.map(([key, zh, en]) => <Check key={key} label={tr(zh, en)} checked={o.fields.includes(key)}
          onChange={v => save({ overlay: { fields: v ? [...o.fields, key] : o.fields.filter(f => f !== key) } })} />)}</div>
        <div className="grind-sub" />
      </>}
      <Choice label={tr('主题', 'Theme')} value={o.theme || 'dark'} onChange={v => save({ overlay: { theme: v } })}
        options={[['dark', '暗色', 'Dark'], ['market', '市集', 'Market'], ['cute', '可爱', 'Cute'], ['maple', '冒险', 'Adventure']] as const} />
      <Slider label={tr('不透明度', 'Opacity')} min={0.3} max={1} step={0.05} value={o.opacity} text={`${Math.round(o.opacity * 100)}%`} onChange={v => save({ overlay: { opacity: v } })} />
      <Check label={tr('直播模式（直播伴侣、OBS 可选中悬浮窗，任务栏会显示它）', 'Streaming (stream apps can pick the overlay; it shows on the taskbar)')} checked={!!o.stream}
        onChange={v => save({ overlay: v ? { stream: true, hide_in_capture: false } : { stream: false } })} />
      {!o.stream && <Check label={tr('录屏和直播时隐藏', 'Hide from recordings')} checked={o.hide_in_capture} onChange={v => save({ overlay: { hide_in_capture: v } })} />}
    </section>
    <section className="well"><div className="well-h"><h3>{tr('Buff 与热键', 'Buffs and hotkeys')}</h3></div>
      <NumberField label={tr('Buff 快结束时提醒', 'Warn before a buff ends')} unit={tr('秒', 's')} value={settings.buff_warn_seconds} min={0} max={120} onChange={v => save({ buff_warn_seconds: v })} />
      <Check label={tr('提醒时读出技能名', 'Say the skill name with the warning')} checked={settings.buff_sound} onChange={v => save({ buff_sound: v })} />
      <Check label={tr('自动加 Buff（按游戏键位设置按键，药水只用固定的）', 'Auto buff (presses the key set in the game; potions only when pinned)')} checked={settings.auto_buff} onChange={v => save({ auto_buff: v })} />
      {HOTKEYS.map(([key, zh, en]) => <HotkeyField key={key} label={tr(zh, en)} value={settings.hotkeys?.[key] || ''}
        error={state.hotkey_errors?.[key]} onChange={v => save({ hotkeys: { [key]: v } })} />)}
    </section>
    <section className="well"><div className="well-h"><h3>{tr('估价', 'Valuation')}</h3></div>
      <Choice label={tr('掉落物按', 'Value loot at')} value={settings.price_basis} onChange={v => save({ price_basis: v })}
        options={[['typical', '成交中位', 'Median sale'], ['npc', 'NPC 回收价', 'NPC buy-back'], ['none', '不计', 'Ignore']] as const} />
      <NumberField label={tr('高价掉落提醒', 'Highlight loot worth')} unit={tr('金币', 'mesos')} value={settings.notable_value} min={0} max={10_000_000_000} step={10000} onChange={v => save({ notable_value: v })} />
      <Check label={tr('刷图时花掉的金币计入支出', 'Count mesos spent while grinding')} checked={settings.count_mesos_spent} onChange={v => save({ count_mesos_spent: v })} />
    </section>
    <section className="well"><div className="well-h"><h3>{tr('自动记录', 'Automatic recording')}</h3></div>
      <Check label={tr('开启刷图记录', 'Record grinding')} checked={settings.enabled} onChange={v => save({ enabled: v })} />
      <NumberField label={tr('连续获得经验后开始', 'Start after EXP gains')} unit={tr('次', 'times')} value={settings.start_events} min={2} max={20} onChange={v => save({ start_events: v })} />
      <NumberField label={tr('没有经验后暂停', 'Pause when idle for')} unit={tr('秒', 's')} value={settings.idle_seconds} min={20} max={900} onChange={v => save({ idle_seconds: v })} />
      <NumberField label={tr('暂停后结束本次', 'End when paused for')} unit={tr('秒', 's')} value={settings.end_after_seconds} min={60} max={7200} onChange={v => save({ end_after_seconds: v })} />
    </section>
    <section className="well"><div className="well-h"><h3>{tr('协议标定', 'Calibration')}</h3>
      <button className="text-link" disabled={state.calibrating} onClick={() => grind('calibrate').then(refresh)}><RefreshCw size={14} />{state.calibrating ? tr('标定中…', 'Calibrating…') : tr('立即标定', 'Calibrate now')}</button></div>
      {calibration.map(row => <div className="grind-cal" key={row.label}><span>{row.label}</span><b className={row.state === '已确认' ? 'ok' : ''}>{row.state}</b></div>)}
      <Check label={tr('保留7天报文并自动重放', 'Keep 7 days of frames and replay updates')} checked={settings.record_frames} onChange={v => save({ record_frames: v })} />
      {state.live && <p className="note">{state.live.recording ? tr('正在录制', 'Recording frames') : tr('未录制', 'Not recording')}</p>}
    </section>
  </div>;
}

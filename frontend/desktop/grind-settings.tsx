// 刷图 settings: the collector's 设置 tab and, with `site`, the site's (the account's shared
// choices, grind_settings_sync.py); this PC's own (overlay position and capture, hotkeys,
// recording) only in the collector.
import { useEffect, useState } from 'react';
import { Info, RefreshCw, SlidersHorizontal } from 'lucide-react';
import { POINTS_HELP } from '../src/components/grind-points';
import { OverlayCard } from './overlay-card';
import { sampleLive } from './overlay-sample';
import { tr } from './i18n';
import { grind, type GrindSettings, type GrindState, type HotkeyAction, type Live } from './grind';
import './grind-settings.css';

export type SettingsChanges = Partial<Omit<GrindSettings, 'overlay' | 'hotkeys' | 'performance'>> & { overlay?: Partial<GrindSettings['overlay']>; hotkeys?: Partial<GrindSettings['hotkeys']>; performance?: Partial<NonNullable<GrindSettings['performance']>> };

function NumberField({ label, unit, value, min, max, step = 1, onChange }: { label: string; unit?: string; value: number; min: number; max: number; step?: number; onChange(v: number): void }) {
  const [text, setText] = useState(String(value));
  useEffect(() => setText(String(value)), [value]);
  return <label className="grind-field"><span>{label}</span>
    <span className="grind-number"><input type="number" value={text} min={min} max={max} step={step} onChange={e => setText(e.target.value)}
      onBlur={() => { const v = Number(text); if (Number.isFinite(v) && v >= min && v <= max) onChange(v); else setText(String(value)); }} />{unit && <small>{unit}</small>}</span></label>;
}

/** One choice out of a few, as joined buttons. */
/** Overlay sizes to pick from (the corner grip was removed: dragging it was unreliable). */
const SIZES = [0.8, 0.9, 1, 1.1, 1.25, 1.5];

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
const WIDTH: Record<GrindSettings['overlay']['layout'], number> = { slim: 296, compact: 840, standard: 330, detailed: 360, rail: 140, big: 290 };

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

const RULE = { enabled: false, exp_per_10k: 1, income_per_10k: 1, cost_per_10k: 1, per_hour: 0, other_per_10k: 0 };

/** 绩效模式: 积分 = 每万经验的积分 + 每万收益（拾取金币 + 基础掉落价值）的积分 − 每万消耗扣的分; ⓘ says how. */
function PerformanceSettings({ settings, save }: { settings: GrindSettings; save(changes: { performance: Partial<NonNullable<GrindSettings['performance']>> }): void }) {
  const rule = { ...RULE, ...settings.performance };
  const [help, setHelp] = useState(false);
  return <section className="well"><div className="well-h"><h3 className="grind-info-h">{tr('绩效模式', 'Performance mode')}
    <button type="button" className="info-dot" aria-expanded={help} aria-label={tr('积分怎么算', 'How points are counted')} onClick={() => setHelp(!help)}><Info size={15} /></button></h3></div>
    {help && <p className="note grind-help">{tr(...POINTS_HELP)}</p>}
    <Check label={tr('开启绩效模式（净收益下方显示积分）', 'Turn on (points shown under the net)')} checked={rule.enabled} onChange={v => save({ performance: { enabled: v } })} />
    {rule.enabled && <>
      <NumberField label={tr('每万经验积分', 'Points per 10K EXP')} unit={tr('分', 'pts')} value={rule.exp_per_10k} min={0} max={100000} step={0.1} onChange={v => save({ performance: { exp_per_10k: v } })} />
      <NumberField label={tr('每万收益积分', 'Points per 10K income')} unit={tr('分', 'pts')} value={rule.income_per_10k} min={0} max={100000} step={0.1} onChange={v => save({ performance: { income_per_10k: v } })} />
      <NumberField label={tr('每万消耗扣分', 'Points off per 10K used')} unit={tr('分', 'pts')} value={rule.cost_per_10k} min={0} max={100000} step={0.1} onChange={v => save({ performance: { cost_per_10k: v } })} />
      <NumberField label={tr('每万非基础掉落积分', 'Points per 10K other drops')} unit={tr('分', 'pts')} value={rule.other_per_10k} min={0} max={100000} step={0.1} onChange={v => save({ performance: { other_per_10k: v } })} />
      <NumberField label={tr('每小时积分', 'Points per hour')} unit={tr('分', 'pts')} value={rule.per_hour} min={0} max={100000} step={0.1} onChange={v => save({ performance: { per_hour: v } })} />
    </>}
  </section>;
}

export function SettingsView({ state, settings, save, refresh, site = false }: {
  /** null on the site, which has no client to read. */
  state: GrindState | null; settings: GrindSettings; refresh?(): void;
  /** The site: the account's shared choices only (grind_settings_sync.SHARED). */
  site?: boolean;
  save(changes: SettingsChanges): void;
}) {
  const o = settings.overlay;
  const calibration = state?.calibration?.summary ?? state?.live?.calibration ?? [];
  const preset = PRESETS.find(p => p.layout === o.layout && p.fields.length === o.fields.length && p.fields.every(f => o.fields.includes(f)));
  // "Custom" opens the shape and field choices on top of whichever preset is in use.
  const [custom, setCustom] = useState(!preset);
  const tailoring = custom || !preset;
  // Previews show the run being recorded, or a sample hour when there is none.
  const [sample, setSample] = useState(sampleLive);
  useEffect(() => { const id = setInterval(() => setSample(sampleLive()), 60_000); return () => clearInterval(id); }, []);
  const shownLive = state?.live?.runs?.length ? state.live : sample;
  return <div className="grind-settings">
    <section className="well"><div className="well-h"><h3>{tr('悬浮窗', 'Overlay')}</h3></div>
      {!site && <Check label={tr('显示悬浮窗', 'Show overlay')} checked={o.enabled} onChange={v => save({ overlay: { enabled: v } })} />}
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
      <Choice label={tr('大小', 'Size')} value={String(SIZES.reduce((best, v) => Math.abs(v - (o.scale || 1)) < Math.abs(best - (o.scale || 1)) ? v : best, 1)) as `${number}`}
        onChange={v => save({ overlay: { scale: Number(v) } })} options={SIZES.map(v => [String(v) as `${number}`, `${Math.round(v * 100)}%`, `${Math.round(v * 100)}%`] as const)} />
      {!site && <>
        <Check label={tr('直播模式（直播伴侣、OBS 可选中悬浮窗，任务栏会显示它）', 'Streaming (stream apps can pick the overlay; it shows on the taskbar)')} checked={!!o.stream}
          onChange={v => save({ overlay: v ? { stream: true, hide_in_capture: false } : { stream: false } })} />
        {!o.stream && <Check label={tr('录屏和直播时隐藏', 'Hide from recordings')} checked={o.hide_in_capture} onChange={v => save({ overlay: { hide_in_capture: v } })} />}
        <Check label={tr('鼠标穿透（点击直接到游戏，悬浮窗按钮不可用，暂停和结束用快捷键）', 'Click-through (clicks go to the game; use the hotkeys to pause or end)')} checked={!!o.mouse_through} onChange={v => save({ overlay: { mouse_through: v } })} />
      </>}
    </section>
    <section className="well"><div className="well-h"><h3>{site ? tr('Buff 提醒', 'Buff warnings') : tr('Buff 与热键', 'Buffs and hotkeys')}</h3></div>
      <NumberField label={tr('Buff 快结束时提醒', 'Warn before a buff ends')} unit={tr('秒', 's')} value={settings.buff_warn_seconds} min={0} max={120} onChange={v => save({ buff_warn_seconds: v })} />
      <Check label={tr('语音提醒：快结束的 Buff 读技能名', 'Spoken warnings: buff names before they end')} checked={settings.buff_sound} onChange={v => save({ buff_sound: v })} />
      <Check label={tr('低血量预警', 'Low HP warning')} checked={settings.hp_warn !== false} onChange={v => save({ hp_warn: v })} />
      {!site && HOTKEYS.map(([key, zh, en]) => <HotkeyField key={key} label={tr(zh, en)} value={settings.hotkeys?.[key] || ''}
        error={state?.hotkey_errors?.[key]} onChange={v => save({ hotkeys: { [key]: v } })} />)}
    </section>
    <section className="well"><div className="well-h"><h3>{tr('估价', 'Valuation')}</h3></div>
      <Choice label={tr('掉落物按', 'Value loot at')} value={settings.price_basis} onChange={v => save({ price_basis: v })}
        options={[['typical', '成交中位', 'Median sale'], ['npc', 'NPC 回收价', 'NPC buy-back'], ['none', '不计', 'Ignore']] as const} />
      <NumberField label={tr('高价掉落提醒', 'Highlight loot worth')} unit={tr('金币', 'mesos')} value={settings.notable_value} min={0} max={10_000_000_000} step={10000} onChange={v => save({ notable_value: v })} />
      <Check label={tr('刷图时花掉的金币计入支出', 'Count mesos spent while grinding')} checked={settings.count_mesos_spent} onChange={v => save({ count_mesos_spent: v })} />
    </section>
    <PerformanceSettings settings={settings} save={save} />
    <section className="well"><div className="well-h"><h3>{tr('自动记录', 'Automatic recording')}</h3></div>
      {!site && <Check label={tr('开启刷图记录', 'Record grinding')} checked={settings.enabled} onChange={v => save({ enabled: v })} />}
      <NumberField label={tr('连续获得经验后开始', 'Start after EXP gains')} unit={tr('次', 'times')} value={settings.start_events} min={2} max={20} onChange={v => save({ start_events: v })} />
      <NumberField label={tr('没有经验后暂停', 'Pause when idle for')} unit={tr('秒', 's')} value={settings.idle_seconds} min={20} max={900} onChange={v => save({ idle_seconds: v })} />
      <NumberField label={tr('暂停后结束本次', 'End when paused for')} unit={tr('秒', 's')} value={settings.end_after_seconds} min={60} max={7200} onChange={v => save({ end_after_seconds: v })} />
      <NumberField label={tr('换图后单独成记录至少', 'New record per map after')} unit={tr('秒', 's')} value={settings.min_record_seconds ?? 60} min={0} max={3600} onChange={v => save({ min_record_seconds: v })} />
    </section>
    {state && !site && <section className="well"><div className="well-h"><h3>{tr('协议标定', 'Calibration')}</h3>
      <button className="text-link" disabled={state.calibrating} onClick={() => grind('calibrate').then(refresh)}><RefreshCw size={14} />{state.calibrating ? tr('标定中…', 'Calibrating…') : tr('立即标定', 'Calibrate now')}</button></div>
      {calibration.map(row => <div className="grind-cal" key={row.label}><span>{row.label}</span><b className={row.state === '已确认' ? 'ok' : ''}>{row.state}</b></div>)}
      {state.live && <p className="note">{state.live.recording ? tr('正在录制', 'Recording frames') : tr('未录制', 'Not recording')}</p>}
    </section>}
  </div>;
}

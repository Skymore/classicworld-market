import { useState } from 'react';
import { type Holdings, clockTime, dayClock, duration, mesos, participantLabel, purchaseAmount, purchaseLabel, purchasePlace } from '../src/lib/sweep-labels';
import { full, itemIcon, reminderTokens, toMs } from './format';
import { useDevices } from './workspace';
import { deviceBlocker } from '../src/lib/sweep-labels';
import type { DeviceRun, RecentPurchase, Run, RunItem, Shell, SweepRule, WorkspaceStatus } from './workspace';

type Sweep = NonNullable<WorkspaceStatus['sweep']>;
const MAX_MESOS = 1e12;
const BUDGETS = [100000, 1000000, 3000000, 10000000] as const;
const DURATIONS = [[60, '1 小时'], [360, '6 小时'], [1440, '24 小时'], [4320, '3 天'], [10080, '7 天']] as const;
const MINUTES_KEY = 'desktop.sweepMinutes';
const zh = (s: string) => s;

/** A whole number of mesos from `min` to 10^12, or null. */
const amount = (text: string, min = 0) => {
  const n = Number(text);
  return text.trim() !== '' && Number.isSafeInteger(n) && n >= min && n <= MAX_MESOS ? n : null;
};
function savedMinutes() {
  try { const n = Number(localStorage.getItem(MINUTES_KEY)); if (DURATIONS.some(([m]) => m === n)) return n; } catch { /* storage unavailable */ }
  return 10080;
}
/** "高物攻 · ≤ 9,000 · 物攻 ≥ 59": the group name, its price cap and the website's condition chips. */
export function ruleText(group: any) {
  // An unpriced group (no quotes at a live edit) carries its stale manual cap; it is not bought.
  const price = group?.unpriced ? '暂无报价' : group?.cap != null && `≤ ${Number(group.cap).toLocaleString('en-US')}`;
  return [group?.name, price, ...reminderTokens(group?.reminder).map(t => t.label)]
    .filter(Boolean).join(' · ');
}
const itemNames = (rules: SweepRule[]) => rules.length > 4
  ? `${rules.slice(0, 4).map(r => r.name).join('、')} 等 ${rules.length} 件` : rules.map(r => r.name).join('、');
/** 22px item icon; hidden when the CDN has none (GMS-only ids). */
function ItemIcon({ id }: { id: number }) {
  return <img className="item-icon" src={itemIcon(id)} alt="" loading="lazy" onError={e => { e.currentTarget.style.visibility = 'hidden'; }} />;
}
/** Units of one item in this character's bags; "—" when that bag was not read. */
function bag(holdings: Holdings | null | undefined, itemId: number) {
  if (!holdings?.categories?.includes(Math.floor(itemId / 1000000))) return '—';
  return (holdings.items.find(i => i.item_id === itemId)?.quantity || 0).toLocaleString('en-US');
}

export default function SweepPane({ sweep, deviceId, busy, run, shell }: { sweep: Sweep; deviceId?: string; busy: boolean; run: Run; shell: Shell }) {
  const { executor, run: current } = sweep, rules = sweep.rules?.watches ?? null;
  const { devices } = useDevices(true, Math.floor(Date.now() / 5000));
  const [excluded, setExcluded] = useState<string[]>([]);
  const chosen = (devices || []).filter(d => !deviceBlocker(d, zh) && !excluded.includes(d.id)).map(d => d.id);
  // The status cells already show why purchases are unavailable; the start block names only the other blockers.
  const blocked = rules && !rules.length ? '没有可扫货的条件' : '';
  return <div className="native-sweep" data-native-sweep>
    <div className="sweep-status">
      <span className={executor.ready ? '' : 'bad'} data-executor><i className={'sq-dot' + (executor.ready ? '' : ' warn')} />{executor.ready ? '购买功能就绪' : executor.reason || '购买功能不可用'}</span>
      <span data-game><i className={'sq-dot' + (shell.gameLive ? '' : ' off')} />{shell.gameLabel}</span>
      <span data-native-balance>金币 <b>{full(sweep.holdings?.mesos)}</b></span>

    </div>
    {!current && sweep.message && <p className="workspace-note" data-sweep-message>{sweep.message}</p>}
    {current ? <RunConsole current={current} message={sweep.message || current.message || ''} deviceId={deviceId} busy={busy} run={run} />
      : <LocalStart rules={rules} blocked={blocked} ready={executor.ready || !chosen.includes(deviceId || '')} busy={busy} run={run} chosen={chosen} />}
    {current?.plan_stale && <p className="workspace-note">条件待更新 · 停止后重新开始生效</p>}
    {rules && <RulesTable rules={rules} running={Boolean(current)} items={current?.items ?? []} holdings={sweep.holdings} openWatch={shell.openWatch} />}
    <div className="native-block"><div className="native-block-head"><b>参与设备</b></div>
      {(devices || []).map(d => <div className="native-block" key={d.id}>
        <label className="check"><input type="checkbox" checked={current ? Boolean(current.devices?.some(p => p.id === d.id)) : chosen.includes(d.id)} disabled={Boolean(current) || Boolean(deviceBlocker(d, zh))} onChange={e => setExcluded(old => e.target.checked ? old.filter(id => id !== d.id) : [...old, d.id])} />{d.name}</label>
        <span> · {deviceBlocker(d, zh) || '在线'} · 金币 {full(d.state?.sweep?.holdings?.mesos)}</span>
        {current?.devices?.filter(p => p.id === d.id).map(p => <div key={p.id}>{participantLabel(p.state, zh)} · {p.message} · 已查 {full(p.checked)} 店次 · 已花 {full(p.spent)}</div>)}
        <details><summary>背包详情</summary>{(d.state?.sweep?.holdings?.items || []).map(item => <div key={item.item_id}><ItemIcon id={item.item_id} />{rules?.find(r => r.item_id === item.item_id)?.name || item.item_id} · {full(item.quantity)}</div>)}</details>
      </div>)}
    </div>
    <RecentList rows={sweep.recent} />

  </div>;
}

function LocalStart({ rules, blocked, ready, busy, run, chosen }: { rules: SweepRule[] | null; blocked: string; ready: boolean; busy: boolean; run: Run; chosen: string[] }) {
  const [budget, setBudget] = useState(''), [minutes, setMinutes] = useState(savedMinutes);
  const value = amount(budget, 1);
  const choose = (m: number) => { setMinutes(m); try { localStorage.setItem(MINUTES_KEY, String(m)); } catch { /* storage unavailable */ } };
  const summary = [rules?.length ? itemNames(rules) : '', value ? `预算 ${mesos(value)}` : '', `${dayClock(Date.now() + minutes * 60000, zh)} 结束`].filter(Boolean).join(' · ');
  return <div className="native-block" data-sweep-run>
    <div className="native-block-head"><b>开始扫货</b>{blocked && <span data-blocker>{blocked}</span>}</div>
    <div className="sweep-form"><span className="sweep-label">预算</span>
      <input name="budget" aria-label="预算" type="number" inputMode="numeric" min={1} max={MAX_MESOS} step={1} value={budget} onChange={e => setBudget(e.target.value)} />
      <small className="sweep-hint">{value ? mesos(value) : ''}</small>
      <div className="quick">{BUDGETS.map((v) => <button type="button" key={v} aria-pressed={value === v} onClick={() => setBudget(String(v))}>{mesos(v)}</button>)}</div></div>
    <div className="sweep-form"><span className="sweep-label">时长</span>
      <div className="seg" role="group" aria-label="时长">{DURATIONS.map(([m, label]) => <button type="button" key={m} aria-pressed={minutes === m} onClick={() => choose(m)}>{label}</button>)}</div></div>
        <div className="start-row"><span className="sweep-sub" data-start-summary>{summary}</span>
      <button className="ui-btn primary" data-native-start disabled={busy || !ready || Boolean(blocked) || !value || !chosen.length} onClick={() => run('start', { budget: value, minutes, devices: chosen })}>开始扫货</button></div>
  </div>;
}

function RunConsole({ current, message, deviceId, busy, run }: { current: DeviceRun; message: string; deviceId?: string; busy: boolean; run: Run }) {
  const now = Date.now(), started = toMs(current.started_at);
  const origin = current.started_by === 'web' ? '网页发起' : current.started_by === deviceId ? '本机发起' : '其他设备发起';
  const sub = [current.state !== 'active' && participantLabel(current.state, zh), origin,
    started != null && `已运行 ${duration(now - started, zh)}`, `${dayClock(current.ends_at, zh)} 结束`].filter(Boolean).join(' · ');
  // Older servers send no run-wide spend; then the bar shows what is used (spent, held and unknown).
  const spent = current.spent ?? null, used = spent ?? Math.max(0, current.budget - current.remaining);
  const percent = current.budget > 0 ? Math.min(100, used / current.budget * 100) : 0;
  const here = [message, current.checked != null && `已查 ${full(current.checked)} 店次`, `本机已花 ${full(current.spent_here)}`].filter(Boolean);
  return <div className="native-block run-console" data-sweep-run>
    <div className="run-row"><i className="sq-dot" /><b>运行中</b><span className="sweep-sub">{sub}</span>
      <button className="ui-btn run-stop" data-native-stop disabled={busy} onClick={() => run('stop')}>停止</button></div>
    <div className="meter" role="progressbar" aria-label="预算" aria-valuemin={0} aria-valuemax={current.budget} aria-valuenow={used}><div style={{ width: `${percent}%` }} /></div>
    <div className="run-between"><span>{spent != null ? '已花' : '已用'} <b>{full(used)}</b> / {full(current.budget)}</span><span>剩余 <b>{full(current.remaining)}</b></span></div>
    <div className="run-device" data-run-message><b>本机</b> · {here.join(' · ')}</div>
  </div>;
}

function RulesTable({ rules, running, items, holdings, openWatch }: {
  rules: SweepRule[]; running: boolean; items: RunItem[]; holdings?: Holdings | null; openWatch(): void;
}) {
  const progress = new Map(items.map(i => [i.item_id, i]));
  return <div className="native-block" data-sweep-rules>
    <div className="native-block-head"><b>{running ? '本轮条件' : '扫货条件'}</b>
      <span>{running ? '启动时保存' : <>{rules.length} 件 · 在「<button type="button" className="inline-link" onClick={openWatch}>关注</button>」里修改</>}</span></div>
    {rules.length ? <div className={'rules-table' + (running ? ' running' : '')} role="table" aria-label={running ? '本轮条件' : '扫货条件'}>
      <div className="rules-tr rules-th" role="row"><span>物品</span><span>条件</span>
        {running ? <><span className="r">已买</span><span className="r">上限</span></> : <><span className="r">本轮最多买</span><span className="r">背包</span></>}</div>
      {rules.map(rule => {
        const bought = progress.get(rule.item_id)?.bought, filled = running && rule.limit > 0 && bought != null && bought >= rule.limit;
        return <div className={'rules-tr' + (filled ? ' full' : '')} role="row" key={rule.item_id} data-rule={rule.item_id}>
          <span><ItemIcon id={rule.item_id} /><b>{rule.name}</b></span>
          <span className="cond">{rule.groups.map((g, i) => <span key={g?.id || i}>{i > 0 && '或 '}{ruleText(g)}</span>)}</span>
          {running ? <><span className="r">{filled && <span className="tag">已满</span>}{bought != null ? full(bought) : '—'}</span><span className="r">{rule.limit ? full(rule.limit) : '不限'}</span></>
            : <><span className="r">{rule.limit ? full(rule.limit) : '不限'}</span><span className="r">{bag(holdings, rule.item_id)}</span></>}
        </div>;
      })}
    </div> : <p className="workspace-note">没有可扫货的条件</p>}
  </div>;
}

/** "100 件 @41 · 3 洞 12 频道 · 店名", or "未买 · 已售完 · 3 洞 12 频道". */
function purchaseDetail(row: RecentPurchase) {
  // Records saved before prices were kept have price null.
  const status = row.status === 'bought' ? purchaseAmount({ ...row, price: row.price ?? undefined }, zh) : purchaseLabel(row, zh);
  return [status, purchasePlace(row)].filter(Boolean).join(' · ');
}
const PURCHASE_TONE: Record<string, string> = { bought: '', not_bought: 'miss', skipped: 'miss', held: 'miss' };

function RecentList({ rows }: { rows: RecentPurchase[] }) {
  return <div className="native-block" data-sweep-recent>
    <div className="native-block-head"><b>最近购买</b><span>{rows.length || ''}</span></div>
    {rows.length ? <div className="buys">{rows.map((row, i) => <div className={'buy ' + (PURCHASE_TONE[row.status] ?? 'unknown')} key={`${row.at}-${row.item_id}-${i}`} data-recent-status={row.status}>
      <span className="t">{clockTime(row.at)}</span>
      <span className="d"><ItemIcon id={row.item_id} /><span><b>{row.name || row.item_id}</b><small>{purchaseDetail(row)}</small></span></span>
      <span className="r"><b>{row.status === 'bought' ? full(row.spent) : '—'}</b></span></div>)}</div>
      : <p className="workspace-note">还没有购买</p>}
  </div>;
}

import { useState } from 'react';
import { type Holdings, clockTime, dayClock, duration, mesos, participantLabel, purchaseAmount, purchaseLabel, purchasePlace } from '../src/lib/sweep-labels';
import { full, itemIcon, reminderTokens, toMs } from './format';
import { language, tr } from './i18n';
import { useDevices } from './workspace';
import { deviceBlocker } from '../src/lib/sweep-labels';
import type { DeviceRun, RecentPurchase, Run, RunItem, Shell, SweepRule, WorkspaceStatus } from './workspace';

type Sweep = NonNullable<WorkspaceStatus['sweep']>;
const MAX_MESOS = 1e12;
const BUDGETS = [100000, 1000000, 3000000, 10000000] as const;
const DURATIONS = [[60, '1 小时', '1 hour'], [360, '6 小时', '6 hours'], [1440, '24 小时', '24 hours'], [4320, '3 天', '3 days'], [10080, '7 天', '7 days']] as const;
const MINUTES_KEY = 'desktop.sweepMinutes';

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
  const price = group?.unpriced ? tr('暂无报价', 'No offers yet') : group?.cap != null && `≤ ${Number(group.cap).toLocaleString('en-US')}`;
  return [group?.name, price, ...reminderTokens(group?.reminder, language() === 'en').map(t => t.label)]
    .filter(Boolean).join(' · ');
}
const itemNames = (rules: SweepRule[]) => rules.length > 4
  ? tr(`${rules.slice(0, 4).map(r => r.name).join('、')} 等 ${rules.length} 件`, `${rules.slice(0, 4).map(r => r.name).join(', ')} and ${rules.length - 4} more`)
  : rules.map(r => r.name).join(tr('、', ', '));
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
  const chosen = (devices || []).filter(d => !deviceBlocker(d, tr) && !excluded.includes(d.id)).map(d => d.id);
  // The status cells already show why purchases are unavailable; the start block names only the other blockers.
  const blocked = rules && !rules.length ? tr('没有可扫货的条件', 'No sweep conditions') : '';
  return <div className="native-sweep" data-native-sweep>
    <div className="sweep-status">
      <span className={executor.ready ? '' : 'bad'} data-executor><i className={'sq-dot' + (executor.ready ? '' : ' warn')} />
        {executor.ready ? tr('购买功能就绪', 'Buying is ready') : executor.reason || tr('购买功能不可用', 'Buying is unavailable')}</span>
      <span data-game><i className={'sq-dot' + (shell.gameLive ? '' : ' off')} />{shell.gameLabel}</span>
      <span data-native-balance>{tr('金币', 'Mesos')} <b>{full(sweep.holdings?.mesos)}</b></span>

    </div>
    {!current && sweep.message && <p className="workspace-note" data-sweep-message>{sweep.message}</p>}
    {current ? <RunConsole current={current} message={sweep.message || current.message || ''} deviceId={deviceId} busy={busy} run={run} />
      : <LocalStart rules={rules} blocked={blocked} ready={executor.ready || !chosen.includes(deviceId || '')} busy={busy} run={run} chosen={chosen} />}
    {current?.plan_stale && <p className="workspace-note">{tr('条件待更新 · 停止后重新开始生效', 'Conditions changed · they apply after you stop and start again')}</p>}
    {rules && <RulesTable rules={rules} running={Boolean(current)} items={current?.items ?? []} holdings={sweep.holdings} openWatch={shell.openWatch} />}
    <div className="native-block"><div className="native-block-head"><b>{tr('参与设备', 'Devices')}</b></div>
      {(devices || []).map(d => <div className="native-block" key={d.id}>
        <label className="check"><input type="checkbox" checked={current ? Boolean(current.devices?.some(p => p.id === d.id)) : chosen.includes(d.id)} disabled={Boolean(current) || Boolean(deviceBlocker(d, tr))} onChange={e => setExcluded(old => e.target.checked ? old.filter(id => id !== d.id) : [...old, d.id])} />{d.name}</label>
        <span> · {deviceBlocker(d, tr) || tr('在线', 'Online')} · {tr('金币', 'Mesos')} {full(d.state?.sweep?.holdings?.mesos)}</span>
        {current?.devices?.filter(p => p.id === d.id).map(p => <div key={p.id}>{participantLabel(p.state, tr)} · {p.message} · {tr(`已查 ${full(p.checked)} 店次`, `${full(p.checked)} shop visits`)} · {tr(`已花 ${full(p.spent)}`, `spent ${full(p.spent)}`)}</div>)}
        <details><summary>{tr('背包详情', 'Inventory')}</summary>{(d.state?.sweep?.holdings?.items || []).map(item => <div key={item.item_id}><ItemIcon id={item.item_id} />{rules?.find(r => r.item_id === item.item_id)?.name || item.item_id} · {full(item.quantity)}</div>)}</details>
      </div>)}
    </div>
    <RecentList rows={sweep.recent} />

  </div>;
}

function LocalStart({ rules, blocked, ready, busy, run, chosen }: { rules: SweepRule[] | null; blocked: string; ready: boolean; busy: boolean; run: Run; chosen: string[] }) {
  const [budget, setBudget] = useState(''), [minutes, setMinutes] = useState(savedMinutes);
  const value = amount(budget, 1);
  const choose = (m: number) => { setMinutes(m); try { localStorage.setItem(MINUTES_KEY, String(m)); } catch { /* storage unavailable */ } };
  const ends = dayClock(Date.now() + minutes * 60000, tr);
  const summary = [rules?.length ? itemNames(rules) : '', value ? tr(`预算 ${mesos(value)}`, `budget ${mesos(value)}`) : '', tr(`${ends} 结束`, `ends ${ends}`)].filter(Boolean).join(' · ');
  return <div className="native-block" data-sweep-run>
    <div className="native-block-head"><b>{tr('开始扫货', 'Start a sweep')}</b>{blocked && <span data-blocker>{blocked}</span>}</div>
    <div className="sweep-form"><span className="sweep-label">{tr('预算', 'Budget')}</span>
      <input name="budget" aria-label={tr('预算', 'Budget')} type="number" inputMode="numeric" min={1} max={MAX_MESOS} step={1} value={budget} onChange={e => setBudget(e.target.value)} />
      <small className="sweep-hint">{value ? mesos(value) : ''}</small>
      <div className="quick">{BUDGETS.map((v) => <button type="button" key={v} aria-pressed={value === v} onClick={() => setBudget(String(v))}>{mesos(v)}</button>)}</div></div>
    <div className="sweep-form"><span className="sweep-label">{tr('时长', 'Duration')}</span>
      <div className="seg" role="group" aria-label={tr('时长', 'Duration')}>{DURATIONS.map(([m, zh, en]) => <button type="button" key={m} aria-pressed={minutes === m} onClick={() => choose(m)}>{tr(zh, en)}</button>)}</div></div>
        <div className="start-row"><span className="sweep-sub" data-start-summary>{summary}</span>
      <button className="ui-btn primary" data-native-start disabled={busy || !ready || Boolean(blocked) || !value || !chosen.length} onClick={() => run('start', { budget: value, minutes, devices: chosen })}>{tr('开始扫货', 'Start a sweep')}</button></div>
  </div>;
}

function RunConsole({ current, message, deviceId, busy, run }: { current: DeviceRun; message: string; deviceId?: string; busy: boolean; run: Run }) {
  const now = Date.now(), started = toMs(current.started_at);
  const origin = current.started_by === 'web' ? tr('网页发起', 'Started on the website') : current.started_by === deviceId ? tr('本机发起', 'Started on this PC') : tr('其他设备发起', 'Started on another device');
  const ends = dayClock(current.ends_at, tr);
  const sub = [current.state !== 'active' && participantLabel(current.state, tr), origin,
    started != null && tr(`已运行 ${duration(now - started, tr)}`, `running for ${duration(now - started, tr)}`), tr(`${ends} 结束`, `ends ${ends}`)].filter(Boolean).join(' · ');
  // Older servers send no run-wide spend; then the bar shows what is used (spent, held and unknown).
  const spent = current.spent ?? null, used = spent ?? Math.max(0, current.budget - current.remaining);
  const percent = current.budget > 0 ? Math.min(100, used / current.budget * 100) : 0;
  const here = [message, current.checked != null && tr(`已查 ${full(current.checked)} 店次`, `${full(current.checked)} shop visits`), tr(`本机已花 ${full(current.spent_here)}`, `this PC spent ${full(current.spent_here)}`)].filter(Boolean);
  return <div className="native-block run-console" data-sweep-run>
    <div className="run-row"><i className="sq-dot" /><b>{tr('运行中', 'Running')}</b><span className="sweep-sub">{sub}</span>
      <button className="ui-btn run-stop" data-native-stop disabled={busy} onClick={() => run('stop')}>{tr('停止', 'Stop')}</button></div>
    <div className="meter" role="progressbar" aria-label={tr('预算', 'Budget')} aria-valuemin={0} aria-valuemax={current.budget} aria-valuenow={used}><div style={{ width: `${percent}%` }} /></div>
    <div className="run-between"><span>{spent != null ? tr('已花', 'Spent') : tr('已用', 'Used')} <b>{full(used)}</b> / {full(current.budget)}</span><span>{tr('剩余', 'Left')} <b>{full(current.remaining)}</b></span></div>
    <div className="run-device" data-run-message><b>{tr('本机', 'This PC')}</b> · {here.join(' · ')}</div>
  </div>;
}

function RulesTable({ rules, running, items, holdings, openWatch }: {
  rules: SweepRule[]; running: boolean; items: RunItem[]; holdings?: Holdings | null; openWatch(): void;
}) {
  const progress = new Map(items.map(i => [i.item_id, i]));
  const title = running ? tr('本轮条件', 'Conditions of this run') : tr('扫货条件', 'Sweep conditions');
  const unlimited = tr('不限', 'No limit');
  return <div className="native-block" data-sweep-rules>
    <div className="native-block-head"><b>{title}</b>
      <span>{running ? tr('启动时保存', 'Saved at start') : <>{tr(`${rules.length} 件 · 在「`, `${rules.length} items · change them in `)}
        <button type="button" className="inline-link" onClick={openWatch}>{tr('关注', 'Watch')}</button>{tr('」里修改', '')}</>}</span></div>
    {rules.length ? <div className={'rules-table' + (running ? ' running' : '')} role="table" aria-label={title}>
      <div className="rules-tr rules-th" role="row"><span>{tr('物品', 'Item')}</span><span>{tr('条件', 'Conditions')}</span>
        {running ? <><span className="r">{tr('已买', 'Bought')}</span><span className="r">{tr('上限', 'Limit')}</span></>
          : <><span className="r">{tr('本轮最多买', 'Most to buy')}</span><span className="r">{tr('背包', 'In bag')}</span></>}</div>
      {rules.map(rule => {
        const bought = progress.get(rule.item_id)?.bought, filled = running && rule.limit > 0 && bought != null && bought >= rule.limit;
        return <div className={'rules-tr' + (filled ? ' full' : '')} role="row" key={rule.item_id} data-rule={rule.item_id}>
          <span><ItemIcon id={rule.item_id} /><b>{rule.name}</b></span>
          <span className="cond">{rule.groups.map((g, i) => <span key={g?.id || i}>{i > 0 && tr('或 ', 'or ')}{ruleText(g)}</span>)}</span>
          {running ? <><span className="r">{filled && <span className="tag">{tr('已满', 'Full')}</span>}{bought != null ? full(bought) : '—'}</span><span className="r">{rule.limit ? full(rule.limit) : unlimited}</span></>
            : <><span className="r">{rule.limit ? full(rule.limit) : unlimited}</span><span className="r">{bag(holdings, rule.item_id)}</span></>}
        </div>;
      })}
    </div> : <p className="workspace-note">{tr('没有可扫货的条件', 'No sweep conditions')}</p>}
  </div>;
}

/** "100 件 @41 · 3 洞 12 频道 · 店名", or "未买 · 已售完 · 3 洞 12 频道". */
function purchaseDetail(row: RecentPurchase) {
  // Records saved before prices were kept have price null.
  const status = row.status === 'bought' ? purchaseAmount({ ...row, price: row.price ?? undefined }, tr) : purchaseLabel(row, tr);
  return [status, purchasePlace(row)].filter(Boolean).join(' · ');
}
const PURCHASE_TONE: Record<string, string> = { bought: '', not_bought: 'miss', skipped: 'miss', held: 'miss' };

function RecentList({ rows }: { rows: RecentPurchase[] }) {
  return <div className="native-block" data-sweep-recent>
    <div className="native-block-head"><b>{tr('最近购买', 'Recent purchases')}</b><span>{rows.length || ''}</span></div>
    {rows.length ? <div className="buys">{rows.map((row, i) => <div className={'buy ' + (PURCHASE_TONE[row.status] ?? 'unknown')} key={`${row.at}-${row.item_id}-${i}`} data-recent-status={row.status}>
      <span className="t">{clockTime(row.at, language() === 'en')}</span>
      <span className="d"><ItemIcon id={row.item_id} /><span><b>{row.name || row.item_id}</b><small>{purchaseDetail(row)}</small></span></span>
      <span className="r"><b>{row.status === 'bought' ? full(row.spent) : '—'}</b></span></div>)}</div>
      : <p className="workspace-note">{tr('还没有购买', 'Nothing bought yet')}</p>}
  </div>;
}

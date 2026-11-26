// 积分明细 (绩效模式): every part of a run's points, one row each: experience, mesos picked up,
// each basic drop (its value) and each consumable used (its cost, taken off). Shown on the
// client's live page and in a run's detail when 绩效模式 is on.
import { EntityRow } from "./entity-ref";
import { basicDrop, points, pointsText, type PointsRule } from "./grind-points";
import "./grind-run.css";

type Words = (zh: string, en: string) => string;
interface DetailRun {
  exp: number;
  active_seconds: number;
  basic_value?: number;
  mesos?: number;
  item_value?: number;
  consume_cost?: number;
  loot?: { item_id: number; name: string | null; quantity: number; value: number }[];
  consumables?: { item_id: number; name: string | null; used: number; cost?: number }[];
}

export function PointsDetail({ run, rule, t, big }: { run: DetailRun; rule: PointsRule; t: Words; big(v: number | null | undefined): string }) {
  const off = rule.cost_per_10k ?? 0;
  const pts = (amount: number, rate: number) => amount * rate / 10_000;
  // A single potion is worth a few hundredths of a point: two decimals below 1.
  const show = (value: number) => (value > 0 ? "+" : value < 0 ? "−" : "")
    + (Math.abs(value) < 1 ? String(Math.round(Math.abs(value) * 100) / 100) : pointsText(Math.abs(value), big));
  // Stackables combine per item already; several equipment rows never count here.
  const drops = (run.loot || []).filter(row => basicDrop(row.item_id) && row.value).sort((a, b) => b.value - a.value);
  const used = (run.consumables || []).filter(row => row.used > 0 && row.cost).sort((a, b) => (b.cost || 0) - (a.cost || 0));
  const otherRate = rule.other_per_10k ?? 0, hourly = rule.per_hour ?? 0, hours = (run.active_seconds || 0) / 3600;
  const others = otherRate ? (run.loot || []).filter(row => !basicDrop(row.item_id) && row.value).sort((a, b) => b.value - a.value) : [];
  return <section className="gr-well gr-points" aria-label={t("积分明细", "Points breakdown")}>
    <h3>{t("积分明细", "Points breakdown")}<b className="money">{pointsText(points(run, rule), big)}</b></h3>
    <div className="drow"><span className="eicon"><span className="exp-dot" aria-hidden="true">EXP</span></span>
      <span className="t"><b>{t("经验", "EXP")}</b><small> {big(run.exp)} × {t(`每万 ${rule.exp_per_10k}`, `${rule.exp_per_10k} per 10K`)}</small></span>
      <span className="r money">{show(pts(run.exp || 0, rule.exp_per_10k))}</span></div>
    <div className="drow"><span className="eicon"><span className="coin" aria-hidden="true" /></span>
      <span className="t"><b>{t("金币", "Mesos")}</b><small> {big(run.mesos || 0)} × {t(`每万 ${rule.income_per_10k}`, `${rule.income_per_10k} per 10K`)}</small></span>
      <span className="r money">{show(pts(run.mesos || 0, rule.income_per_10k))}</span></div>
    {hourly > 0 && <div className="drow"><span className="eicon"><span className="exp-dot" aria-hidden="true">⏱</span></span>
      <span className="t"><b>{t("时长", "Time")}</b><small> {pointsText(hours, big)} {t("小时", "h")} × {t(`每小时 ${hourly}`, `${hourly} per hour`)}</small></span>
      <span className="r money">{show(hours * hourly)}</span></div>}
    {drops.map(row => <EntityRow key={`d${row.item_id}`} kind="item" id={row.item_id} name={row.name}
      note={t(`×${big(row.quantity)} · 价值 ${big(row.value)}`, `×${big(row.quantity)} · worth ${big(row.value)}`)}
      value={show(pts(row.value, rule.income_per_10k))} />)}
    {others.map(row => <EntityRow key={`o${row.item_id}`} kind="item" id={row.item_id} name={row.name}
      note={t(`非基础 ×${big(row.quantity)} · 价值 ${big(row.value)}`, `other ×${big(row.quantity)} · worth ${big(row.value)}`)}
      value={show(pts(row.value, otherRate))} />)}
    {used.map(row => <EntityRow key={`u${row.item_id}`} kind="item" id={row.item_id} name={row.name}
      note={t(`用 ${big(row.used)} · 花费 ${big(row.cost)}`, `used ${big(row.used)} · cost ${big(row.cost)}`)}
      value={show(-pts(row.cost || 0, off))} />)}
    {!drops.length && !used.length && <p className="gr-more">{t("还没有基础掉落和消耗。", "No basic drops or consumables yet.")}</p>}
  </section>;
}

// 积分 (绩效模式): points per 10,000 experience, plus points per 10,000 收益 (mesos picked up
// and basic drops' value), less points per 10,000 spent on consumables used, plus (optional,
// 0 by default) points per hour of active time and per 10,000 of other drops' value. The net
// stays over every drop. Basic drops: potions, foods and other recovery or buff consumables
// (200–202xxxx), monsters' own etc drops (4000xxx) and ores (4004xxx, 401–402xxxx); other
// drops are the rest (equipment, scrolls...). Same rule as grind_tracker.basic_drop.
// Everything comes from the run's summary, so a changed rule shows at once on every run.
import { timelineRates } from "../../desktop/grind";

export interface PointsRule {
  enabled?: boolean; exp_per_10k: number; income_per_10k: number; cost_per_10k?: number;
  per_hour?: number; other_per_10k?: number;
}

interface PointsRun {
  exp: number;
  mesos?: number;
  item_value?: number;
  basic_value?: number;
  consume_cost?: number;
  active_seconds: number;
  status?: string;
  loot?: { item_id: number; value: number }[];
  timeline?: { start: number; bucket: number; last?: number; first?: number; step?: number; window?: number;
    exp: number[]; net: number[]; times?: number[]; mesos?: number[]; basic?: number[]; cost?: number[]; other?: number[] };
}

export const basicDrop = (item: number) => {
  const kind = Math.floor(item / 10000), group = Math.floor(item / 1000);
  return (kind >= 200 && kind <= 202) || group === 4000 || group === 4004 || (kind >= 401 && kind <= 402);
};

/** The basic drops' value (summaries before 积分 existed: from the loot rows). */
export const basicValue = (run: PointsRun) =>
  run.basic_value ?? (run.loot || []).filter(row => basicDrop(row.item_id)).reduce((sum, row) => sum + (row.value || 0), 0);

/** The other drops' value: everything picked up that is not a basic drop. */
export const otherValue = (run: PointsRun) => Math.max(0, (run.item_value ?? 0) - basicValue(run));

interface Parts { exp: number; income: number; cost: number; other: number; hours: number }
const score = (p: Parts, rule: PointsRule) =>
  (p.exp * rule.exp_per_10k + p.income * rule.income_per_10k - p.cost * (rule.cost_per_10k ?? 0)
    + p.other * (rule.other_per_10k ?? 0)) / 10_000 + p.hours * (rule.per_hour ?? 0);

/** 收益 counted in 积分: mesos picked up and basic drops' value (the net counts every drop). */
export const income = (run: PointsRun) => (run.mesos || 0) + basicValue(run);

const parts = (run: PointsRun): Parts => ({ exp: run.exp || 0, income: income(run), cost: run.consume_cost || 0,
  other: otherValue(run), hours: (run.active_seconds || 0) / 3600 });

export const points = (run: PointsRun, rule: PointsRule) => score(parts(run), rule);

/** How a run's 积分 adds up, for the ⓘ (one line per part; the optional ones while they count). */
export function pointsSum(run: PointsRun, rule: PointsRule, big: (v: number | null | undefined) => string, t: (zh: string, en: string) => string) {
  const part = (amount: number, rate: number) => pointsText(amount * rate / 10_000, big);
  const p = parts(run), off = rule.cost_per_10k ?? 0, other = rule.other_per_10k ?? 0, hourly = rule.per_hour ?? 0;
  return [
    t(`经验 ${big(p.exp)} × 每万 ${rule.exp_per_10k} = ${part(p.exp, rule.exp_per_10k)}`, `EXP ${big(p.exp)} × ${rule.exp_per_10k} per 10K = ${part(p.exp, rule.exp_per_10k)}`),
    t(`收益 ${big(p.income)}（金币 ${big(run.mesos || 0)} + 基础掉落 ${big(basicValue(run))}）× 每万 ${rule.income_per_10k} = ${part(p.income, rule.income_per_10k)}`,
      `Income ${big(p.income)} (mesos ${big(run.mesos || 0)} + basic drops ${big(basicValue(run))}) × ${rule.income_per_10k} per 10K = ${part(p.income, rule.income_per_10k)}`),
    t(`消耗 ${big(p.cost)} × 每万 ${off} = −${part(p.cost, off)}`, `Used ${big(p.cost)} × ${off} per 10K = −${part(p.cost, off)}`),
    ...(other ? [t(`非基础掉落 ${big(p.other)} × 每万 ${other} = ${part(p.other, other)}`, `Other drops ${big(p.other)} × ${other} per 10K = ${part(p.other, other)}`)] : []),
    ...(hourly ? [t(`时长 ${pointsText(p.hours, big)} 小时 × 每小时 ${hourly} = ${pointsText(p.hours * hourly, big)}`,
      `Time ${pointsText(p.hours, big)} h × ${hourly} per hour = ${pointsText(p.hours * hourly, big)}`)] : []),
    t(`积分 ${pointsText(points(run, rule), big)}`, `Points ${pointsText(points(run, rule), big)}`),
  ].join("\n");
}

/** What 积分 is, for the settings' ⓘ. */
export const POINTS_HELP: [string, string] = [
  "积分 = 经验 ÷ 1万 × 每万经验积分 + 收益 ÷ 1万 × 每万收益积分 − 消耗 ÷ 1万 × 每万消耗扣分 + 非基础掉落 ÷ 1万 × 每万非基础掉落积分 + 有效时长（小时）× 每小时积分。\n收益 = 拾取的金币 + 基础掉落的价值。基础掉落：药水、食物等消耗品（含攻击神水、速度药水）、怪物的普通掉落和矿石；其余（装备、卷轴、飞镖、技能书等）是非基础掉落。\n消耗 = 用掉的药水等消耗品按估价算的花费。改了单价，实时和全部历史立刻按新单价显示。净收益不受影响，仍按全部掉落和消耗计算。",
  "Points = EXP ÷ 10K × points per 10K EXP + income ÷ 10K × points per 10K income − used ÷ 10K × points per 10K used + other drops ÷ 10K × points per 10K other drops + active hours × points per hour.\nIncome = mesos picked up + basic drops' value. Basic drops: potions, food and other consumables, monsters' common drops and ores; the rest (equipment, scrolls, stars, books...) are other drops.\nUsed = consumables used, at their valuation. A changed rate shows at once on the live run and every past run. The net is unchanged and still counts every drop and cost.",
];

/** Points read small (a few per hour at low levels): one decimal below 100. */
export const pointsText = (value: number | null | undefined, big: (v: number | null | undefined) => string) =>
  value == null || !Number.isFinite(value) ? "—" : Math.abs(value) < 100 ? String(Math.round(value * 10) / 10) : big(value);

export const pointsPerHour = (run: PointsRun, rule: PointsRule) =>
  run.active_seconds > 0 ? points(run, rule) * 3600 / run.active_seconds : null;

/** Hourly 积分 per chart point; empty for runs recorded before the timeline kept what it needs
 * (other drops' series only matters while they count). */
export function pointsHistory(run: PointsRun, rule: PointsRule): { t: number; clock?: number; value: number }[] {
  const line = run.timeline;
  if (!line?.mesos || !line.basic || !line.cost || line.exp.length < 2 || (!line.other && rule.other_per_10k)) return [];
  const rate = (series: number[]) => timelineRates({ ...line, net: series });
  const mesos = rate(line.mesos), basic = rate(line.basic), cost = rate(line.cost), other = line.other ? rate(line.other) : null;
  // Each point is already per hour: an hour of time there is one hour.
  return mesos.map((p, i) => ({ t: p.t, clock: p.clock,
    value: score({ exp: p.exp, income: p.net + basic[i].net, cost: cost[i].net, other: other ? other[i].net : 0, hours: 1 }, rule) }));
}

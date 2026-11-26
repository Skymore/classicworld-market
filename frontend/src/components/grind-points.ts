// 积分 (绩效模式): points per 10,000 experience, plus points per 10,000 收益 (mesos picked up
// and basic drops' value), less points per 10,000 spent on consumables used. The net stays over every drop; 积分 counts only basic drops: potions,
// foods and other recovery or buff consumables (200–202xxxx), monsters' own etc drops
// (4000xxx) and ores (4004xxx, 401–402xxxx), never scrolls, equipment or anything else.
// Same rule as grind_tracker.basic_drop.
import { timelineRates } from "../../desktop/grind";

export interface PointsRule { enabled?: boolean; exp_per_10k: number; income_per_10k: number; cost_per_10k?: number }

interface PointsRun {
  exp: number;
  mesos?: number;
  basic_value?: number;
  consume_cost?: number;
  active_seconds: number;
  status?: string;
  loot?: { item_id: number; value: number }[];
  timeline?: { start: number; bucket: number; last?: number; first?: number; step?: number; window?: number;
    exp: number[]; net: number[]; times?: number[]; mesos?: number[]; basic?: number[]; cost?: number[] };
}

export const basicDrop = (item: number) => {
  const kind = Math.floor(item / 10000), group = Math.floor(item / 1000);
  return (kind >= 200 && kind <= 202) || group === 4000 || group === 4004 || (kind >= 401 && kind <= 402);
};

/** The basic drops' value (summaries before 积分 existed: from the loot rows). */
export const basicValue = (run: PointsRun) =>
  run.basic_value ?? (run.loot || []).filter(row => basicDrop(row.item_id)).reduce((sum, row) => sum + (row.value || 0), 0);

const score = (exp: number, income: number, cost: number, rule: PointsRule) =>
  (exp * rule.exp_per_10k + income * rule.income_per_10k - cost * (rule.cost_per_10k ?? 0)) / 10_000;

/** 收益 counted in 积分: mesos picked up and basic drops' value (the net counts every drop). */
export const income = (run: PointsRun) => (run.mesos || 0) + basicValue(run);

export const points = (run: PointsRun, rule: PointsRule) => score(run.exp || 0, income(run), run.consume_cost || 0, rule);

/** How a run's 积分 adds up, for the ⓘ (one line per part). */
export function pointsSum(run: PointsRun, rule: PointsRule, big: (v: number | null | undefined) => string, t: (zh: string, en: string) => string) {
  const part = (amount: number, rate: number) => pointsText(amount * rate / 10_000, big);
  const exp = run.exp || 0, got = income(run), used = run.consume_cost || 0, off = rule.cost_per_10k ?? 0;
  return [
    t(`经验 ${big(exp)} × 每万 ${rule.exp_per_10k} = ${part(exp, rule.exp_per_10k)}`, `EXP ${big(exp)} × ${rule.exp_per_10k} per 10K = ${part(exp, rule.exp_per_10k)}`),
    t(`收益 ${big(got)}（金币 ${big(run.mesos || 0)} + 基础掉落 ${big(basicValue(run))}）× 每万 ${rule.income_per_10k} = ${part(got, rule.income_per_10k)}`,
      `Income ${big(got)} (mesos ${big(run.mesos || 0)} + basic drops ${big(basicValue(run))}) × ${rule.income_per_10k} per 10K = ${part(got, rule.income_per_10k)}`),
    t(`消耗 ${big(used)} × 每万 ${off} = −${part(used, off)}`, `Used ${big(used)} × ${off} per 10K = −${part(used, off)}`),
    t(`积分 ${pointsText(points(run, rule), big)}`, `Points ${pointsText(points(run, rule), big)}`),
  ].join("\n");
}

/** What 积分 is, for the settings' ⓘ. */
export const POINTS_HELP: [string, string] = [
  "积分 = 经验 ÷ 1万 × 每万经验积分 + 收益 ÷ 1万 × 每万收益积分 − 消耗 ÷ 1万 × 每万消耗扣分。\n收益 = 拾取的金币 + 基础掉落的价值。基础掉落：药水、食物等消耗品（含攻击神水、速度药水）、怪物的普通掉落和矿石；卷轴、装备、飞镖、技能书、任务物品不算。\n消耗 = 用掉的药水等消耗品按估价算的花费。净收益不受影响，仍按全部掉落和消耗计算。",
  "Points = EXP ÷ 10K × points per 10K EXP + income ÷ 10K × points per 10K income − used ÷ 10K × points per 10K used.\nIncome = mesos picked up + basic drops' value. Basic drops: potions, food and other consumables, monsters' common drops and ores; never scrolls, equipment, stars, books or quest items.\nUsed = consumables used, at their valuation. The net is unchanged and still counts every drop and cost.",
];

/** Points read small (a few per hour at low levels): one decimal below 100. */
export const pointsText = (value: number | null | undefined, big: (v: number | null | undefined) => string) =>
  value == null || !Number.isFinite(value) ? "—" : Math.abs(value) < 100 ? String(Math.round(value * 10) / 10) : big(value);

export const pointsPerHour = (run: PointsRun, rule: PointsRule) =>
  run.active_seconds > 0 ? points(run, rule) * 3600 / run.active_seconds : null;

/** Hourly 积分 per chart point; empty for runs recorded before the timeline kept mesos and basic drops. */
export function pointsHistory(run: PointsRun, rule: PointsRule): { t: number; clock?: number; value: number }[] {
  const line = run.timeline;
  if (!line?.mesos || !line.basic || !line.cost || line.exp.length < 2) return [];
  const mesos = timelineRates({ ...line, net: line.mesos }), basic = timelineRates({ ...line, net: line.basic }), cost = timelineRates({ ...line, net: line.cost });
  return mesos.map((p, i) => ({ t: p.t, clock: p.clock, value: score(p.exp, p.net + basic[i].net, cost[i].net, rule) }));
}

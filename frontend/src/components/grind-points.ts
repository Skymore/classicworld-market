// 积分 (绩效模式): a run's worth as experience × exp + mesos picked up × mesos + basic drops'
// value × drops. The net stays over every drop; 积分 counts only basic drops: potions,
// foods and other recovery or buff consumables (200–202xxxx), monsters' own etc drops
// (4000xxx) and ores (4004xxx, 401–402xxxx), never scrolls, equipment or anything else.
// Same rule as grind_tracker.basic_drop.
import { timelineRates } from "../../desktop/grind";

export interface PointsRule { enabled?: boolean; exp: number; mesos: number; drops: number }

interface PointsRun {
  exp: number;
  mesos?: number;
  basic_value?: number;
  active_seconds: number;
  status?: string;
  loot?: { item_id: number; value: number }[];
  timeline?: { start: number; bucket: number; last?: number; first?: number; step?: number; window?: number;
    exp: number[]; net: number[]; times?: number[]; mesos?: number[]; basic?: number[] };
}

export const basicDrop = (item: number) => {
  const kind = Math.floor(item / 10000), group = Math.floor(item / 1000);
  return (kind >= 200 && kind <= 202) || group === 4000 || group === 4004 || (kind >= 401 && kind <= 402);
};

/** The basic drops' value (summaries before 积分 existed: from the loot rows). */
export const basicValue = (run: PointsRun) =>
  run.basic_value ?? (run.loot || []).filter(row => basicDrop(row.item_id)).reduce((sum, row) => sum + (row.value || 0), 0);

export const points = (run: PointsRun, rule: PointsRule) =>
  (run.exp || 0) * rule.exp + (run.mesos || 0) * rule.mesos + basicValue(run) * rule.drops;

export const pointsPerHour = (run: PointsRun, rule: PointsRule) =>
  run.active_seconds > 0 ? points(run, rule) * 3600 / run.active_seconds : null;

/** Hourly 积分 per chart point; empty for runs recorded before the timeline kept mesos and basic drops. */
export function pointsHistory(run: PointsRun, rule: PointsRule): { t: number; clock?: number; value: number }[] {
  const line = run.timeline;
  if (!line?.mesos || !line.basic || line.exp.length < 2) return [];
  const mesos = timelineRates({ ...line, net: line.mesos }), basic = timelineRates({ ...line, net: line.basic });
  return mesos.map((p, i) => ({ t: p.t, clock: p.clock, value: p.exp * rule.exp + p.net * rule.mesos + basic[i].net * rule.drops }));
}

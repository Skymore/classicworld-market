// An hour of grinding for the overlay previews in settings, used while nothing is being recorded.
import type { Live, RunSummary } from './grind';
import { tr } from './i18n';

export function sampleLive(): Live {
  const now = Date.now() / 1000;
  const loot = ([[4000019, tr('蜗牛壳', 'Snail Shell'), 380, 46000], [4000000, tr('蓝蜗牛壳', 'Blue Snail Shell'), 333, 52000], [4000016, tr('红蜗牛壳', 'Red Snail Shell'), 286, 54000]] as const)
    .map(([item_id, name, quantity, value]) => ({ t: now, kind: 'loot', item_id, name, quantity, priced: true, unit: Math.round(value / quantity), basis: 'typical', value, notable: false }));
  const run: RunSummary = {
    id: 'sample', status: 'active', pause_reason: null,
    character: { key: null, name: tr('枫叶小弓', 'MapleArcher'), level: 68, job: 310 },
    job_name: tr('猎人', 'Hunter'), level: 68, level_start: 68, exp_now: null, exp_percent: 43.2,
    map_id: null, map_name: tr('蚂蚁洞Ⅱ', 'Ant Tunnel II'), started_at: now - 3725, ended_at: null, active_seconds: 3725, idle_seconds: 0,
    exp: 1250000, exp_per_hour: 1208000, exp_per_hour_5m: 1300000, exp_per_hour_1m: 1420000, percent_per_hour: 18.4, eta_seconds: 11100,
    kills: 1524, kills_per_hour: 1473, kills_estimated: false, deaths: 0, exp_lost: 0, gaps: 0,
    mesos: 215000, item_value: 152000, consume_cost: 65000, mesos_spent: 0, net: 302000, net_per_hour: 229000, net_per_hour_1m: 182000,
    rate_history: Array.from({ length: 30 }, (_, i) => ({ t: now - (30 - i) * 40, exp: 1150000 + Math.round(Math.sin(i / 3) * 260000), net: 200000 + Math.round(Math.cos(i / 4) * 70000) })),
    cash_per_hour: null, pending_prices: 0, loot, recent: [],
    consumables: [{ item_id: 2000002, name: tr('白色药水', 'White Potion'), used: 156, cost: 36000, remaining: 244, per_hour: 150, minutes_left: 97 },
      { item_id: 2000003, name: tr('蓝色药水', 'Blue Potion'), used: 128, cost: 29000, remaining: 172, per_hour: 123, minutes_left: 84 }],
    drops: [], mobs: [{ mob_id: 1005, kills: 1012, name: tr('僵尸蘑菇', 'Zombie Mushroom') }, { mob_id: 1004, kills: 512, name: tr('刺蘑菇', 'Horny Mushroom') }], segments: [],
    buffs: [{ source: 3001000, name: tr('集中术', 'Focus'), seconds: 222, total: 300, item_id: null },
      { source: 1101004, name: tr('快速武器', 'Booster'), seconds: 96, total: 200, item_id: null },
      { source: 4101001, name: tr('轻功', 'Haste'), seconds: 185, total: 300, item_id: null }],
    hp_lost: 0, hp_drops: 0, attack_count: 0, attacks: [], casts: [], damage: 15680000, dps: 4210, average_dps: 3950, party_known: true,
    combat: [0, 1, 2].map(i => ({ character_id: i + 1, name: [tr('枫叶小弓', 'MapleArcher'), tr('冰雷小法', 'IceMage'), tr('圣光祭司', 'Cleric')][i], self: !i, away: false, partial: false,
      damage: 15680000 - i * 4000000, dps: 4210 - i * 900, average_dps: 3950 - i * 800, kills: 1524 - i * 400, hits: 5000,
      dps_5m: 4210 - i * 900, kills_5m: 124 - i * 20, exp_received_5m: i ? null : 108000, kill_exp_5m: 22000 - i * 3000, exp_contribution_5m: 40 - i * 8, exp_yield_5m: i ? null : 120 })),
  };
  return { alive_at: now, stale: false, runs: [run], finished: [], recording: false, calibration: [], characters: [] };
}

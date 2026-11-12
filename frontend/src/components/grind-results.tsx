// Measured grinding on a map page: uploads from the collector's grind tracker
// (`/api/v1/grind/map/{id}`, server `grind::map_summary`). Hidden until a
// level band has a full segment.
import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { usePreferences, useWords } from "../providers";
import { mesos } from "../lib/sweep-labels";
import "./grind-results.css";

const JOBS: Record<number, [string, string]> = {
  0: ["新手", "Beginner"], 100: ["战士", "Warrior"], 110: ["剑客", "Fighter"], 111: ["勇士", "Crusader"], 112: ["英雄", "Hero"],
  120: ["准骑士", "Page"], 121: ["骑士", "White Knight"], 122: ["圣骑士", "Paladin"], 130: ["枪战士", "Spearman"],
  131: ["龙骑士", "Dragon Knight"], 132: ["黑骑士", "Dark Knight"], 200: ["魔法师", "Magician"], 210: ["火毒法师", "F/P Wizard"],
  211: ["火毒巫师", "F/P Mage"], 212: ["火毒魔导师", "F/P Arch Mage"], 220: ["冰雷法师", "I/L Wizard"], 221: ["冰雷巫师", "I/L Mage"],
  222: ["冰雷魔导师", "I/L Arch Mage"], 230: ["牧师", "Cleric"], 231: ["祭司", "Priest"], 232: ["主教", "Bishop"],
  300: ["弓箭手", "Archer"], 310: ["猎人", "Hunter"], 311: ["射手", "Ranger"], 312: ["神射手", "Bowmaster"],
  320: ["弩弓手", "Crossbowman"], 321: ["游侠", "Sniper"], 322: ["箭神", "Marksman"], 400: ["飞侠", "Rogue"],
  410: ["刺客", "Assassin"], 411: ["无影人", "Hermit"], 412: ["隐士", "Night Lord"], 420: ["侠客", "Bandit"],
  421: ["独行客", "Chief Bandit"], 422: ["侠盗", "Shadower"],
};

interface Group {
  level_from: number; level_to: number; job: number | null; sessions: number; hours: number;
  exp_per_hour: [number, number, number]; net_per_hour: [number, number, number];
  mesos_per_hour: number; kills_per_hour: number;
}
interface Result {
  groups: Group[]; kills: number;
  drops: { item_id: number; name: string | null; name_en: string | null; quantity: number; per_1000_kills: number | null }[];
}

export default function GrindResults({ mapId }: { mapId: number }) {
  const words = useWords();
  const { language } = usePreferences();
  const [band, setBand] = useState<number | null>(null);
  const query = useQuery<Result>({
    queryKey: ["grind-map", mapId],
    queryFn: async ({ signal }) => {
      const response = await fetch(`/api/v1/grind/map/${mapId}`, { signal, credentials: "same-origin" });
      if (!response.ok) throw new Error(String(response.status));
      return response.json();
    },
    staleTime: 300_000,
    retry: false,
  });
  const groups = query.data?.groups ?? [];
  const bands = useMemo(() => [...new Set(groups.map((g) => g.level_from))], [groups]);
  if (!groups.length) return null;
  const shown = band == null ? groups : groups.filter((g) => g.level_from === band);
  const job = (id: number | null) => (id == null ? "—" : JOBS[id] ? words(...JOBS[id]) : words(`职业 ${id}`, `Job ${id}`));
  const number = (value: number) => (Math.round(value)).toLocaleString(language === "en" ? "en-US" : "zh-CN");
  return (
    <section className="well grind-results" data-grind-results>
      <div className="well-h">
        <h3>{words("刷图实测", "Measured grinding")}</h3>
        <small>{words("近 90 天 · 客户端自动上传", "Last 90 days · collector uploads")}</small>
        {bands.length > 1 && (
          <select className="grind-band" value={band ?? ""} aria-label={words("等级", "Level")}
            onChange={(e) => setBand(e.target.value ? Number(e.target.value) : null)}>
            <option value="">{words("全部等级", "All levels")}</option>
            {bands.map((b) => <option key={b} value={b}>Lv.{b}–{b + 4}</option>)}
          </select>
        )}
      </div>
      <div className="grind-table-wrap">
        <table className="grind-table">
          <thead>
            <tr>
              <th>{words("等级", "Level")}</th><th>{words("职业", "Job")}</th><th>{words("场次", "Runs")}</th>
              <th>{words("经验/时", "EXP/h")}</th><th>{words("收益/时", "Profit/h")}</th><th>{words("击杀/时", "Kills/h")}</th>
            </tr>
          </thead>
          <tbody>
            {shown.map((g, i) => (
              <tr key={i}>
                <td>{g.level_from}–{g.level_to}</td>
                <td>{job(g.job)}</td>
                <td>{g.sessions}<small> · {g.hours.toFixed(1)}h</small></td>
                <td><b>{number(g.exp_per_hour[1])}</b><small> {number(g.exp_per_hour[0])}–{number(g.exp_per_hour[2])}</small></td>
                <td><b>{mesos(g.net_per_hour[1])}</b><small> {words("金币", "mesos")} {mesos(g.mesos_per_hour)}</small></td>
                <td>{number(g.kills_per_hour)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {query.data!.drops.length > 0 && (
        <div className="grind-drops-list">
          <div className="sub-h">{words("实测掉落", "Measured drops")}<small>{words(`共 ${number(query.data!.kills)} 只`, `${number(query.data!.kills)} kills`)}</small></div>
          {query.data!.drops.slice(0, 16).map((d) => (
            <a key={d.item_id} className="drow" href={`/item/${d.item_id}`}>
              <img src={`https://mxdgcw.dvg.cn/dbsource/icon/item/${d.item_id}.png`} alt="" width={24} height={24} loading="lazy" />
              <span className="t"><b>{words(d.name || d.name_en || `#${d.item_id}`, d.name_en || d.name || `#${d.item_id}`)}</b></span>
              <span className="r">{d.per_1000_kills != null ? words(`每千只 ${d.per_1000_kills.toFixed(1)}`, `${d.per_1000_kills.toFixed(1)} / 1k`) : number(d.quantity)}</span>
            </a>
          ))}
        </div>
      )}
    </section>
  );
}

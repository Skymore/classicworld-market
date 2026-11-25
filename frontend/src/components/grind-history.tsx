// The grind history list, one component for the client's 刷图 · 历史 (this computer's runs)
// and the site's 我的记录 (the account's synced runs): the same filters, columns and period board.
import { useMemo, useState, type ReactNode } from "react";
import { PeriodBoard } from "./grind-periods";
import { Spark, big, signed, span, when, type GrindRun } from "./grind-run";
import "./grind-history.css";

type Words = (zh: string, en: string) => string;
export type HistoryRun = GrindRun & { segments?: unknown[]; segment_count?: number };

const LENGTHS = [5, 10, 20];   // minutes: hide runs shorter than this
const LENGTH_KEY = "grind.history.length";

function rememberedLength() {
  try { const value = Number(localStorage.getItem(LENGTH_KEY)); return LENGTHS.includes(value) ? value : 0; } catch { return 0; }
}

export function GrindHistory<R extends HistoryRun>({ runs, t, english, idOf, shared, row }: {
  runs: R[]; t: Words; english: boolean;
  idOf(run: R): string;
  shared(run: R): boolean;
  /** The clickable row: a link on the site, a button in the client. */
  row(run: R, className: string, children: ReactNode): ReactNode;
}) {
  const [who, setWho] = useState(""), [map, setMap] = useState("");
  const [least, setLeastState] = useState(rememberedLength);
  const setLeast = (value: number) => {
    setLeastState(value);
    try { localStorage.setItem(LENGTH_KEY, String(value)); } catch { /* storage unavailable */ }
  };
  const names = useMemo(() => [...new Set(runs.map(r => r.character?.name).filter(Boolean) as string[])], [runs]);
  const maps = useMemo(() => [...new Set(runs.map(r => r.map_name).filter(Boolean) as string[])], [runs]);
  const filtered = useMemo(() => runs.filter(r => (!who || r.character?.name === who) && (!map || r.map_name === map)
    && (r.active_seconds || 0) >= least * 60), [runs, who, map, least]);
  return <PeriodBoard runs={filtered} t={t} english={english} remember="grind.period" idOf={idOf} filters={<>
    {names.length > 1 && <select value={who} onChange={e => setWho(e.target.value)} aria-label={t("角色", "Character")}>
      <option value="">{t("全部角色", "All characters")}</option>{names.map(n => <option key={n}>{n}</option>)}</select>}
    {maps.length > 1 && <select value={map} onChange={e => setMap(e.target.value)} aria-label={t("地图", "Map")}>
      <option value="">{t("全部地图", "All maps")}</option>{maps.map(n => <option key={n}>{n}</option>)}</select>}
    <select value={least} onChange={e => setLeast(Number(e.target.value))} aria-label={t("时长", "Length")}>
      <option value={0}>{t("全部时长", "Any length")}</option>
      {LENGTHS.map(m => <option key={m} value={m}>{t(`${m} 分钟以上`, `${m} min or more`)}</option>)}</select>
  </>}>{(shown, picks) => <div className="gh-list" role="list">
    <div className="gp-line" aria-hidden="true">{picks && <span className="gp-pick" />}<div className="gh-row head">
      <span>{t("时间", "Time")}</span><span>{t("地图 · 角色", "Map · character")}</span><span>{t("时长", "Length")}</span>
      <span>{t("经验/时", "EXP/h")}</span><span>{t("收益/时", "Profit/h")}</span><span>{t("击杀", "Kills")}</span><span />
    </div></div>
    {shown.map(run => {
      const id = idOf(run), more = (run.segments?.length ?? run.segment_count ?? 0) - 1;
      return <div className="gp-line" key={id} role="listitem">
        {picks && <label className="gp-pick" title={t("勾两场对比", "Tick two to compare")}><input type="checkbox" checked={picks.has(id)}
          disabled={picks.full && !picks.has(id)} onChange={() => picks.toggle(id)} aria-label={t("选这一场对比", "Compare this run")} /></label>}
        {row(run, "gh-row", <>
          <span className="when">{when(run.started_at)}<em className="len"> · {span(run.active_seconds, english)}</em></span>
          <span className="who"><b>{run.map_name || "—"}</b>{more > 0 && <small> +{more}</small>}
            <small> {[run.character?.name, `${run.job_name || ""} ${run.level ?? ""}`.trim()].filter(Boolean).join(" · ")}</small>
            {shared(run) && <i className="shared">{t("已分享", "Shared")}</i>}</span>
          <span>{span(run.active_seconds, english)}</span>
          <span>{big(run.exp_per_hour, english)}{run.exp_per_hour != null && <small>/{t("时", "h")}</small>}</span>
          <span className={run.net_per_hour ? "money" : undefined}>{signed(run.net_per_hour, english)}{run.net_per_hour != null && <small>/{t("时", "h")}</small>}</span>
          <span>{big(run.kills, english)}</span>
          <Spark run={run} />
        </>)}
      </div>;
    })}
  </div>}</PeriodBoard>;
}

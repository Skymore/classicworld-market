// Two runs side by side: what each made, how fast, and their EXP/h over the
// run's own clock on one chart. Opened from the history list (two ticked).
import { useEffect, type ReactNode } from "react";
import { big, span, signed, timelinePoints, when, type GrindRun, type Words } from "./grind-run";

type Row = { label: string; a: number | null | undefined; b: number | null | undefined; show(v: number | null | undefined): ReactNode; lower?: boolean };

export function RunCompare({ a, b, t, english, close }: { a: GrindRun; b: GrindRun; t: Words; english: boolean; close(): void }) {
  useEffect(() => {
    const key = (e: KeyboardEvent) => { if (e.key === "Escape") close(); };
    addEventListener("keydown", key);
    return () => removeEventListener("keydown", key);
  }, [close]);
  const perHour = (run: GrindRun, amount: number | null | undefined) => amount != null && run.active_seconds > 0 ? amount * 3600 / run.active_seconds : null;
  const rows: Row[] = [
    { label: t("有效时长", "Active time"), a: a.active_seconds, b: b.active_seconds, show: v => span(v, english) },
    { label: t("经验", "EXP"), a: a.exp, b: b.exp, show: v => big(v, english) },
    { label: t("经验/时", "EXP/h"), a: a.exp_per_hour, b: b.exp_per_hour, show: v => big(v, english) },
    { label: t("净收益", "Net"), a: a.net, b: b.net, show: v => signed(v, english) },
    { label: t("收益/时", "Profit/h"), a: a.net_per_hour, b: b.net_per_hour, show: v => signed(v, english) },
    { label: t("金币/时", "Mesos/h"), a: perHour(a, a.mesos), b: perHour(b, b.mesos), show: v => big(v, english) },
    { label: t("战利品/时", "Loot/h"), a: perHour(a, a.item_value), b: perHour(b, b.item_value), show: v => big(v, english) },
    { label: t("消耗/时", "Used/h"), a: perHour(a, a.consume_cost), b: perHour(b, b.consume_cost), show: v => big(v, english), lower: true },
    { label: t("击杀/时", "Kills/h"), a: a.kills_per_hour, b: b.kills_per_hour, show: v => big(v, english) },
    { label: "DPS", a: a.average_dps, b: b.average_dps, show: v => big(v, english) },
    { label: t("死亡", "Deaths"), a: a.deaths ?? 0, b: b.deaths ?? 0, show: v => String(v ?? 0), lower: true },
  ];
  const diff = (row: Row) => {
    if (row.a == null || row.b == null || row.a === row.b) return <span className="gc-same">—</span>;
    const better = row.lower ? row.b < row.a : row.b > row.a;
    const ratio = row.a ? Math.round((row.b - row.a) / Math.abs(row.a) * 100) : null;
    return <span className={better ? "gc-up" : "gc-down"}>{row.b > row.a ? "▲" : "▼"}{ratio != null ? `${Math.abs(ratio)}%` : ""}</span>;
  };
  const title = (run: GrindRun) => <>
    <b>{run.map_name || "—"}</b>
    <small>{when(run.started_at)} · {span(run.active_seconds, english)} · {run.character?.name || ""} {run.job_name || ""} {run.level ?? ""}</small>
  </>;
  return <div className="gc-backdrop" role="dialog" aria-modal="true" aria-label={t("两场对比", "Compare two runs")} onClick={close}>
    <div className="gc" onClick={e => e.stopPropagation()}>
      <div className="gc-head"><h3>{t("两场对比", "Compare two runs")}</h3><button type="button" className="gc-close" aria-label={t("关闭", "Close")} onClick={close}>×</button></div>
      <div className="gc-who">
        <div className="gc-a"><i />{title(a)}</div>
        <div className="gc-b"><i />{title(b)}</div>
      </div>
      <CompareChart a={a} b={b} t={t} english={english} />
      <div className="gc-table" role="table">
        <div className="gc-row head" role="row"><span /><span className="gc-a">A</span><span className="gc-b">B</span><span>{t("B 比 A", "B vs A")}</span></div>
        {rows.map(row => <div className="gc-row" role="row" key={row.label}>
          <span>{row.label}</span><span>{row.show(row.a)}</span><span>{row.show(row.b)}</span>{diff(row)}
        </div>)}
      </div>
      <p className="gc-note">{t("曲线按各自开场后的时间对齐，每点是前一分钟的速度。", "Lines up by time since each run started; each point is the minute before it.")}</p>
    </div>
  </div>;
}

/** EXP/h of both runs against minutes since each started. */
function CompareChart({ a, b, t, english }: { a: GrindRun; b: GrindRun; t: Words; english: boolean }) {
  const lines = [a, b].map(run => timelinePoints(run).map(p => ({ x: (p.t - run.started_at) / 60, y: p.exp })));
  const all = lines.flat();
  if (all.length < 2) return <p className="gc-note">{t("这两场没有走势数据。", "No rate history for these runs.")}</p>;
  const width = 640, height = 170, pad = 6;
  const maxX = Math.max(1, ...all.map(p => p.x)), maxY = Math.max(1, ...all.map(p => p.y));
  const x = (v: number) => pad + v / maxX * (width - pad * 2), y = (v: number) => height - pad - v / maxY * (height - pad * 2 - 14);
  const path = (points: { x: number; y: number }[]) => points.map(p => `${x(p.x).toFixed(1)},${y(p.y).toFixed(1)}`).join(" ");
  return <figure className="gc-chart">
    <svg viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" role="img" aria-label={t("经验/时对比", "EXP/h compared")}>
      {[0.5, 1].map(f => <line key={f} x1={pad} x2={width - pad} y1={y(maxY * f)} y2={y(maxY * f)} className="gc-grid" />)}
      {lines.map((points, i) => points.length > 1 && <polyline key={i} points={path(points)} className={i ? "gc-line-b" : "gc-line-a"} vectorEffect="non-scaling-stroke" />)}
    </svg>
    <figcaption><span>{t("经验/时", "EXP/h")} · {t("最高", "max")} {big(maxY, english)}</span><span>{t(`开场后 ${Math.round(maxX)} 分钟`, `${Math.round(maxX)} min in`)}</span></figcaption>
  </figure>;
}

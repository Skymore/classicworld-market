// One grind run in full: used by the client's history detail and the
// website's run and share pages. Text comes from the host's `t(zh, en)`.
import { useEffect, useRef, useState, type ReactNode } from "react";
import "./grind-run.css";

export type Words = (zh: string, en: string) => string;
export interface GrindRun {
  id?: string;
  started_at: number;
  ended_at?: number | null;
  active_seconds: number;
  idle_seconds?: number;
  character?: { name?: string | null; level?: number | null; job?: number | null };
  job_name?: string | null;
  level?: number | null;
  level_start?: number | null;
  map_id?: number | null;
  map_name?: string | null;
  exp: number;
  exp_per_hour?: number | null;
  kills: number;
  kills_per_hour?: number | null;
  kills_estimated?: boolean;
  mesos?: number;
  item_value?: number;
  consume_cost?: number;
  mesos_spent?: number;
  net?: number;
  net_per_hour?: number | null;
  average_dps?: number | null;
  attack_count?: number;
  damage?: number | null;
  hp_lost?: number;
  hp_drops?: number;
  deaths?: number;
  loot?: { item_id: number; name: string | null; quantity: number; value: number }[];
  drops?: { item_id: number; name: string | null; quantity: number; value?: number }[];
  consumables?: { item_id: number; name: string | null; used: number; cost?: number }[];
  mobs?: { mob_id: number; name: string; kills: number; attack_distribution?: { attacks: number; kills: number }[] }[];
  attacks?: { skill: number; name: string; count: number; follow_up?: boolean }[];
  casts?: { skill: number; name: string; count: number }[];
  segments?: { map_id: number; map_name?: string | null; active_seconds: number; started_at: number }[];
  timeline?: { start: number; bucket: number; exp: number[]; net: number[] };
}
export interface Comparison { level_from: number; level_to: number; job: number | null; runs: number; exp_better_than: number; exp_per_hour_median: number | null }

const icon = (id: number) => `https://mxdgcw.dvg.cn/dbsource/icon/item/${id}.png`;

/** 1.2万 / 3.4亿 (zh, ko) or 12K / 3.4M (en). */
export function big(value: number | null | undefined, english = false) {
  if (value == null || !Number.isFinite(value)) return "—";
  const sign = value < 0 ? "-" : "", n = Math.abs(value);
  const one = (x: number) => (x >= 100 ? String(Math.round(x)) : (Math.round(x * 10) / 10).toFixed(1).replace(/\.0$/, ""));
  if (english) {
    if (n >= 1e9) return sign + one(n / 1e9) + "B";
    if (n >= 1e6) return sign + one(n / 1e6) + "M";
    if (n >= 1e4) return sign + one(n / 1e3) + "K";
    return sign + Math.round(n).toLocaleString("en-US");
  }
  if (n >= 1e8) return sign + one(n / 1e8) + "亿";
  if (n >= 1e4) return sign + one(n / 1e4) + "万";
  return sign + Math.round(n).toLocaleString("en-US");
}
export const signed = (value: number | null | undefined, english = false) =>
  value == null ? "—" : (value > 0 ? "+" : "") + big(value, english);
export function clock(seconds: number | null | undefined) {
  if (seconds == null || !Number.isFinite(seconds)) return "—";
  const s = Math.max(0, Math.round(seconds)), h = Math.floor(s / 3600);
  return `${h ? `${h}:` : ""}${String(Math.floor(s / 60) % 60).padStart(h ? 2 : 1, "0")}:${String(s % 60).padStart(2, "0")}`;
}
export function when(at: number) {
  const d = new Date(at * 1000);
  return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

export interface ChartPoint { t: number; exp: number; net: number }

/** Hourly EXP and net per point for the whole run (timeline buckets). */
export function timelinePoints(run: Pick<GrindRun, "timeline">): ChartPoint[] {
  const line = run.timeline;
  if (!line || line.exp.length < 2) return [];
  return line.exp.map((exp, i) => ({ t: line.start + (i + 0.5) * line.bucket, exp: (exp * 3600) / line.bucket,
    net: ((line.net[i] || 0) * 3600) / line.bucket }));
}

const hhmm = (t: number) => { const d = new Date(t * 1000); return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`; };
function ticks(low: number, high: number, count = 3) {
  return Array.from({ length: count + 1 }, (_, i) => low + ((high - low) * i) / count);
}

/** EXP/h (left axis) and net/h (right axis) with time axis, hover read-out and peak marks. */
export function RateChart({ points, t, english, title, showNet = true, average }: {
  points: ChartPoint[]; t: Words; english: boolean; title?: string; showNet?: boolean; average?: { exp?: number | null; net?: number | null };
}) {
  const [hover, setHover] = useState<number | null>(null);
  const box = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(600);
  useEffect(() => {
    const node = box.current;
    if (!node) return;
    const measure = () => setWidth(Math.max(280, Math.round(node.clientWidth)));
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, [points.length >= 2]);
  if (points.length < 2) return null;
  const W = width, H = width < 480 ? 150 : 190, L = 52, R = showNet ? 56 : 14, T = 14, B = 24;
  const start = points[0].t, end = points[points.length - 1].t, span = Math.max(1, end - start);
  const x = (time: number) => L + ((time - start) / span) * (W - L - R);
  const expHigh = Math.max(...points.map((p) => p.exp), 1) * 1.1;
  const netValues = points.map((p) => p.net);
  const netLow = Math.min(0, ...netValues), netHigh = Math.max(1, ...netValues);
  const netPad = (netHigh - netLow) * 0.1 || 1;
  const yExp = (v: number) => H - B - (v / expHigh) * (H - T - B);
  const yNet = (v: number) => H - B - ((v - (netLow - netPad)) / (netHigh + netPad - (netLow - netPad))) * (H - T - B);
  const path = (y: (v: number) => number, key: "exp" | "net") => points.map((p) => `${x(p.t).toFixed(1)},${y(p[key]).toFixed(1)}`).join(" ");
  const peak = (key: "exp" | "net") => points.reduce((best, p, i) => (p[key] > points[best][key] ? i : best), 0);
  const expPeak = peak("exp"), netPeak = peak("net");
  const expAt = { x: x(points[expPeak].t), y: yExp(points[expPeak].exp) };
  const netAt = { x: x(points[netPeak].t), y: yNet(points[netPeak].net) };
  // Labels sit above their dot; when both peaks are close the lower one moves its label below.
  const clash = Math.abs(expAt.x - netAt.x) < 90 && Math.abs(expAt.y - netAt.y) < 24;
  const expBelow = clash && expAt.y >= netAt.y, netBelow = clash && !expBelow;
  const anchor = (px: number) => (px < L + 40 ? "start" : px > W - R - 40 ? "end" : "middle");
  const active = hover == null ? null : points[hover];
  const timeTicks = ticks(start, end, 4);
  const b = (v: number) => big(v, english);
  const move = (event: React.PointerEvent<SVGSVGElement>) => {
    const box = event.currentTarget.getBoundingClientRect();
    const at = start + ((((event.clientX - box.left) / box.width) * W - L) / (W - L - R)) * span;
    setHover(points.reduce((best, p, i) => (Math.abs(p.t - at) < Math.abs(points[best].t - at) ? i : best), 0));
  };
  const key = (event: React.KeyboardEvent) => {
    if (!["ArrowLeft", "ArrowRight"].includes(event.key)) return;
    event.preventDefault();
    setHover((current) => Math.max(0, Math.min(points.length - 1, (current ?? points.length - 1) + (event.key === "ArrowLeft" ? -1 : 1))));
  };
  return (
    <div className="gr-chart">
      <div className="gr-legend">
        <span className="exp">{t("经验/时", "EXP/h")}</span>
        {showNet && <span className="net">{t("净收益/时", "Net/h")}</span>}
        {title && <small>{title}</small>}
      </div>
      <div className="gr-plot" ref={box}>
        {active && (
          <output className="gr-tip" style={{ left: Math.max(64, Math.min(W - 64, x(active.t))) }}>
            <b>{hhmm(active.t)}</b>
            <span className="exp">{t("经验", "EXP")} {b(active.exp)}/{t("时", "h")}</span>
            {showNet && <span className="net">{t("收益", "Net")} {b(active.net)}/{t("时", "h")}</span>}
          </output>
        )}
        <svg viewBox={`0 0 ${W} ${H}`} width={W} height={H} tabIndex={0} role="img" onPointerMove={move} onPointerLeave={() => setHover(null)}
          onBlur={() => setHover(null)} onKeyDown={key}
          aria-label={t("经验和收益每小时走势，可用左右方向键查看", "Hourly EXP and net; use the arrow keys to read points")}>
          {ticks(0, expHigh).map((v, i) => (
            <g key={"e" + i} className="axis">
              <line x1={L} x2={W - R} y1={yExp(v)} y2={yExp(v)} className="grid" />
              <text x={L - 6} y={yExp(v) + 4} textAnchor="end" className="exp">{b(v)}</text>
            </g>
          ))}
          {showNet && ticks(netLow - netPad, netHigh + netPad).map((v, i) => (
            <text key={"n" + i} x={W - R + 6} y={yNet(v) + 4} className="axis net">{b(v)}</text>
          ))}
          {showNet && netLow < 0 && <line x1={L} x2={W - R} y1={yNet(0)} y2={yNet(0)} className="zero" />}
          {timeTicks.map((time, i) => (
            <text key={"t" + i} x={x(time)} y={H - 6} textAnchor={i === 0 ? "start" : i === timeTicks.length - 1 ? "end" : "middle"} className="axis">{hhmm(time)}</text>
          ))}
          <line x1={L} x2={W - R} y1={H - B} y2={H - B} className="base" />
          {average?.exp != null && <line x1={L} x2={W - R} y1={yExp(average.exp)} y2={yExp(average.exp)} className="avg exp" />}
          <polyline points={path(yExp, "exp")} className="exp" />
          {showNet && <polyline points={path(yNet, "net")} className="net" />}
          <g className="peak exp">
            <circle cx={expAt.x} cy={expAt.y} r="4" />
            <text x={expAt.x} y={expBelow ? expAt.y + 17 : expAt.y - 8} textAnchor={anchor(expAt.x)}>{t("最高", "Peak")} {b(points[expPeak].exp)}</text>
          </g>
          {showNet && points[netPeak].net > 0 && (
            <g className="peak net">
              <circle cx={netAt.x} cy={netAt.y} r="4" />
              <text x={netAt.x} y={netBelow ? netAt.y + 17 : netAt.y - 8} textAnchor={anchor(netAt.x)}>{t("最高", "Peak")} {b(points[netPeak].net)}</text>
            </g>
          )}
          {active && (
            <g className="cursor">
              <line x1={x(active.t)} x2={x(active.t)} y1={T} y2={H - B} />
              <circle cx={x(active.t)} cy={yExp(active.exp)} r="3.5" className="exp" />
              {showNet && <circle cx={x(active.t)} cy={yNet(active.net)} r="3.5" className="net" />}
            </g>
          )}
        </svg>
      </div>
    </div>
  );
}

/** The whole run of one record. */
export function RunChart({ run, t, english }: { run: GrindRun; t: Words; english: boolean }) {
  const points = timelinePoints(run);
  if (points.length < 2) return null;
  return <RateChart points={points} t={t} english={english}
    title={t(`整场 · 每点 ${clock(run.timeline!.bucket)}`, `Whole run · ${clock(run.timeline!.bucket)} per point`)}
    average={{ exp: run.exp_per_hour }} />;
}

function Rows<T>({ rows, limit, render }: { rows: T[]; limit: number; render(row: T, i: number): ReactNode }) {
  return <>{rows.slice(0, limit).map(render)}</>;
}

export function RunDetail({ run, t, english = false, comparison, actions, profit = true }: {
  run: GrindRun; t: Words; english?: boolean; comparison?: Comparison | null; actions?: ReactNode; profit?: boolean;
}) {
  const b = (v: number | null | undefined) => big(v, english);
  const s = (v: number | null | undefined) => signed(v, english);
  const name = run.character?.name || (run.job_name ? t(`一位${run.job_name}`, `A ${run.job_name}`) : t("冒险家", "Adventurer"));
  const levels = run.level_start && run.level && run.level_start !== run.level ? `${run.level_start}→${run.level}` : String(run.level ?? run.character?.level ?? "—");
  // Biggest amounts first in both lists (the data keeps loot newest first for the overlay).
  const loot = [...(run.loot?.length ? run.loot : run.drops || [])].sort((a, b) => ((b as { value?: number }).value ?? 0) - ((a as { value?: number }).value ?? 0));
  const used = [...(run.consumables || [])].sort((a, b) => (b.cost ?? 0) - (a.cost ?? 0) || b.used - a.used);
  const lootTotal = (run.mesos || 0) + (run.item_value || 0);
  const costTotal = (run.consume_cost || 0) + (run.mesos_spent || 0);
  const segments = run.segments || [];
  const segmentTotal = segments.reduce((sum, seg) => sum + seg.active_seconds, 0) || 1;
  const perKill = (mob: NonNullable<GrindRun["mobs"]>[number]) => {
    const rows = mob.attack_distribution || [];
    const n = rows.reduce((sum, r) => sum + r.kills, 0);
    return n ? rows.reduce((sum, r) => sum + r.attacks * r.kills, 0) / n : null;
  };
  return (
    <article className="gr-run" data-grind-run>
      <header className="gr-head">
        <div>
          <h2>{run.map_name || (run.map_id ? t(`地图 ${run.map_id}`, `Map ${run.map_id}`) : t("刷图", "Grind"))}</h2>
          <p>{name} · {run.job_name || "—"} · Lv.{levels} · {when(run.started_at)}{run.ended_at ? `–${when(run.ended_at).slice(-5)}` : ""}</p>
        </div>
        {actions && <div className="gr-actions">{actions}</div>}
      </header>
      <div className="gr-kpis">
        <div><small>{t("有效时长", "Active")}</small><b>{clock(run.active_seconds)}</b>{run.idle_seconds ? <span>{t("空闲", "Idle")} {clock(run.idle_seconds)}</span> : null}</div>
        <div><small>{t("经验", "EXP")}</small><b>{b(run.exp)}</b><span>{b(run.exp_per_hour)}/{t("时", "h")}</span></div>
        {profit && <div className="money"><small>{t("净收益", "Net")}</small><b>{s(run.net)}</b><span>{b(run.net_per_hour)}/{t("时", "h")}</span></div>}
        <div><small>{run.kills_estimated ? t("击杀（按经验）", "Kills (by EXP)") : t("击杀", "Kills")}</small><b>{b(run.kills)}</b><span>{b(run.kills_per_hour)}/{t("时", "h")}</span></div>
        {run.average_dps != null && <div><small>DPS</small><b>{b(run.average_dps)}</b><span>{run.attack_count ? t(`攻击 ${b(run.attack_count)} 次`, `${b(run.attack_count)} attacks`) : ""}</span></div>}
      </div>
      {comparison && (
        <p className="gr-compare">
          {t(`同图 ${comparison.level_from}–${comparison.level_to} 级${comparison.job != null ? "同职业" : ""}的 ${comparison.runs} 次记录里，这场经验效率高于 ${Math.round(comparison.exp_better_than * 100)}%`,
            `Among ${comparison.runs} runs on this map at level ${comparison.level_from}–${comparison.level_to}, this run beat ${Math.round(comparison.exp_better_than * 100)}% on EXP/h`)}
          {comparison.exp_per_hour_median != null && <span> · {t("中位", "median")} {b(comparison.exp_per_hour_median)}/{t("时", "h")}</span>}
        </p>
      )}
      <RunChart run={run} t={t} english={english} />
      {segments.length > 1 && (
        <div className="gr-segments" aria-label={t("分段", "Segments")}>
          {segments.map((seg, i) => (
            <span key={i} style={{ flex: seg.active_seconds / segmentTotal }} title={`${seg.map_name || seg.map_id} · ${clock(seg.active_seconds)}`}>
              {seg.active_seconds / segmentTotal > 0.12 ? seg.map_name || seg.map_id : ""}
            </span>
          ))}
        </div>
      )}
      <div className="gr-columns">
        <section className="gr-well">
          <h3>{t("战利品", "Loot")}{profit && <b className="money">{s(lootTotal)}</b>}</h3>
          {profit && (run.mesos || 0) > 0 && <div className="gr-row"><span className="coin" aria-hidden="true" /><span className="t">{t("金币", "Mesos")}</span><span className="v money">{s(run.mesos)}</span></div>}
          <Rows rows={loot} limit={12} render={(row, i) => (
            <div className="gr-row" key={i}><img src={icon(row.item_id)} alt="" loading="lazy" />
              <span className="t">{row.name || `#${row.item_id}`}</span><small>×{b(row.quantity)}</small>
              {profit && "value" in row && row.value != null && <span className="v">{s(row.value)}</span>}</div>
          )} />
          {loot.length > 12 && <p className="gr-more">{t(`还有 ${loot.length - 12} 种`, `${loot.length - 12} more`)}</p>}
          {!loot.length && <p className="gr-more">{t("没有拾取。", "Nothing picked up.")}</p>}
        </section>
        {profit && (
          <section className="gr-well">
            <h3>{t("消耗", "Used")}<b className="money">{s(-costTotal)}</b></h3>
            <Rows rows={used} limit={12} render={(row, i) => (
              <div className="gr-row" key={i}><img src={icon(row.item_id)} alt="" loading="lazy" />
                <span className="t">{row.name || `#${row.item_id}`}</span><small>×{b(row.used)}</small>
                {row.cost != null && <span className="v">{s(-row.cost)}</span>}</div>
            )} />
            {(run.mesos_spent || 0) > 0 && <div className="gr-row"><span className="coin" aria-hidden="true" /><span className="t">{t("技能花费金币", "Mesos spent")}</span><span className="v">{s(-(run.mesos_spent || 0))}</span></div>}
            {!run.consumables?.length && !run.mesos_spent && <p className="gr-more">{t("没有消耗。", "Nothing used.")}</p>}
          </section>
        )}
        <section className="gr-well">
          <h3>{t("击杀", "Kills")}<b>{b(run.kills)}</b></h3>
          <Rows rows={run.mobs || []} limit={8} render={(mob, i) => {
            const n = perKill(mob);
            return <div className="gr-row" key={i}><span className="t">{mob.name}</span>
              {n != null && <small>{t(`平均 ${n.toFixed(1)} 下`, `${n.toFixed(1)} hits`)}</small>}<span className="v">{b(mob.kills)}</span></div>;
          }} />
          {(run.attacks?.length || run.casts?.length) ? <h3 className="sub">{t("技能", "Skills")}<b>{b(run.attack_count)}</b></h3> : null}
          <Rows rows={run.attacks || []} limit={6} render={(row, i) => (
            <div className="gr-row" key={"a" + i}><span className="t">{row.skill ? row.name : t("普通攻击", "Basic attack")}</span>{row.follow_up && <small title={t("命中后自动追加，不计入攻击次数", "Triggered after a hit; not counted as an attack")}>{t("追加", "follow-up")}</small>}<span className="v">{b(row.count)}</span></div>
          )} />
          <Rows rows={run.casts || []} limit={6} render={(row, i) => (
            <div className="gr-row" key={"c" + i}><span className="t">{row.name}</span><small>{t("施放", "cast")}</small><span className="v">{b(row.count)}</span></div>
          )} />
          {(run.hp_drops || run.deaths) ? (
            <p className="gr-more">{t(`受伤 ${b(run.hp_drops)} 次 · ${b(run.hp_lost)} HP`, `Hit ${b(run.hp_drops)}× · ${b(run.hp_lost)} HP`)}{run.deaths ? t(` · 死亡 ${run.deaths}`, ` · ${run.deaths} deaths`) : ""}</p>
          ) : null}
        </section>
      </div>
    </article>
  );
}

/** Bold mini line of a run's EXP for list rows. */
export function Spark({ run }: { run: Pick<GrindRun, "timeline"> }) {
  const values = run.timeline?.exp || [];
  if (values.length < 2) return <svg className="gr-spark" viewBox="0 0 60 16" aria-hidden="true" />;
  const max = Math.max(...values, 1);
  const points = values.map((v, i) => `${(i / (values.length - 1)) * 60},${15 - (v / max) * 13}`).join(" ");
  return <svg className="gr-spark" viewBox="0 0 60 16" aria-hidden="true"><polyline points={points} /></svg>;
}

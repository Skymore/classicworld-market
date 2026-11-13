// Grind history by day, week or month: totals, the active days, how the maps
// compare, then that period's runs. Shared by the client and the website.
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { big, clock, signed, type GrindRun, type Words } from "./grind-run";
import "./grind-periods.css";

type Mode = "day" | "week" | "month";
type MapSort = "exp" | "time" | "net";
/** Runs shorter than this are usually a map passed through; hidden on request. */
const SHORT = 5 * 60;
type Run = Pick<GrindRun, "started_at" | "active_seconds" | "exp" | "net" | "kills" | "map_name">;

const day = (at: Date) => new Date(at.getFullYear(), at.getMonth(), at.getDate());
/** Weeks start on Monday. */
function startOf(mode: Mode, at: Date) {
  const start = day(at);
  if (mode === "week") start.setDate(start.getDate() - (start.getDay() + 6) % 7);
  if (mode === "month") start.setDate(1);
  return start;
}
const shift = (mode: Mode, start: Date, by: number) => mode === "month"
  ? new Date(start.getFullYear(), start.getMonth() + by, 1)
  : new Date(start.getFullYear(), start.getMonth(), start.getDate() + by * (mode === "week" ? 7 : 1));

function label(mode: Mode, start: Date, end: Date, english: boolean) {
  const last = new Date(end.getTime() - 1);
  if (english) {
    const short = (d: Date) => d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
    if (mode === "day") return start.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });
    return mode === "week" ? `${short(start)} – ${short(last)}` : start.toLocaleDateString("en-US", { month: "long", year: "numeric" });
  }
  const short = (d: Date) => `${d.getMonth() + 1}月${d.getDate()}日`;
  if (mode === "day") return `${short(start)} 周${"日一二三四五六"[start.getDay()]}`;
  return mode === "week" ? `${short(start)} – ${short(last)}` : `${start.getFullYear()}年${start.getMonth() + 1}月`;
}

const total = (runs: Run[], key: "active_seconds" | "exp" | "net" | "kills") => runs.reduce((sum, run) => sum + (Number(run[key]) || 0), 0);
const hourly = (amount: number, seconds: number) => seconds > 0 ? amount * 3600 / seconds : null;

/** The period last looked at in this tab, kept across opening a run and coming back. */
function remembered(key?: string): { mode: Mode; at: number } | null {
  try {
    const saved = key ? JSON.parse(sessionStorage.getItem(key) || "null") : null;
    return saved && ["day", "week", "month"].includes(saved.mode) && Number.isFinite(saved.at) ? saved : null;
  } catch { return null; }
}

export function PeriodBoard<T extends Run>({ runs, t, english, filters, remember, children }: {
  runs: T[]; t: Words; english: boolean; filters?: ReactNode; remember?: string; children(shown: T[]): ReactNode;
}) {
  const latest = useMemo(() => runs.reduce((at, run) => Math.max(at, run.started_at), 0), [runs]);
  const [mode, setMode] = useState<Mode>(() => remembered(remember)?.mode ?? "week");
  // Opens on the period of the latest run, so the first screen is never empty.
  const [anchor, setAnchor] = useState(() => new Date(remembered(remember)?.at ?? (latest ? latest * 1000 : Date.now())));
  useEffect(() => {
    if (remember) try { sessionStorage.setItem(remember, JSON.stringify({ mode, at: anchor.getTime() })); } catch { /* storage unavailable */ }
  }, [remember, mode, anchor]);
  const [hideShort, setHideShort] = useState(false), [onlyMap, setOnlyMap] = useState<string | null>(null);
  const [mapSort, setMapSort] = useState<MapSort>("exp"), [copied, setCopied] = useState(false);
  const start = startOf(mode, anchor), end = shift(mode, start, 1);
  const within = (run: Run, from: Date, to: Date) => run.started_at * 1000 >= from.getTime() && run.started_at * 1000 < to.getTime();
  const kept = useMemo(() => hideShort ? runs.filter(run => (run.active_seconds || 0) >= SHORT) : runs, [runs, hideShort]);
  const period = useMemo(() => kept.filter(run => within(run, start, end)), [kept, start.getTime(), end.getTime()]);
  const shown = useMemo(() => onlyMap ? period.filter(run => (run.map_name || "—") === onlyMap) : period, [period, onlyMap]);
  const seconds = total(shown, "active_seconds");
  // The period before, cut at the same point while this one is still running ("same time last week").
  const running = end.getTime() > Date.now();
  const before = useMemo(() => {
    const from = shift(mode, start, -1), to = running ? new Date(from.getTime() + (Date.now() - start.getTime())) : start;
    return kept.filter(run => within(run, from, to) && (!onlyMap || (run.map_name || "—") === onlyMap));
  }, [kept, mode, start.getTime(), running, onlyMap]);
  const beforeSeconds = total(before, "active_seconds");
  const change = (now: number | null, then: number | null) => {
    if (now == null || then == null || !before.length || then === 0) return null;
    const ratio = (now - then) / Math.abs(then);
    return <i className={"gp-delta " + (ratio >= 0 ? "up" : "down")} title={t(running ? "较上期同期" : "较上一期", running ? "vs the same point last period" : "vs the previous period")}>
      {ratio >= 0 ? "▲" : "▼"}{Math.abs(ratio * 100) >= 999 ? "999+" : Math.round(Math.abs(ratio * 100))}%</i>;
  };

  const days = useMemo(() => {
    if (mode === "day") return [];
    const list: { at: Date; seconds: number; exp: number }[] = [];
    for (let at = start; at < end; at = shift("day", at, 1)) {
      const those = shown.filter(run => within(run, at, shift("day", at, 1)));
      list.push({ at, seconds: total(those, "active_seconds"), exp: total(those, "exp") });
    }
    return list;
  }, [shown, mode, start.getTime()]);
  const longest = Math.max(1, ...days.map(d => d.seconds));
  const today = day(new Date()).getTime();

  const maps = useMemo(() => {
    const groups = new Map<string, Run[]>();
    for (const run of period) { const name = run.map_name || "—"; groups.set(name, [...(groups.get(name) || []), run]); }
    return [...groups].map(([name, list]) => {
      const time = total(list, "active_seconds");
      return { name, count: list.length, time, exp: hourly(total(list, "exp"), time), net: hourly(total(list, "net"), time) };
    }).sort((a, b) => (b[mapSort] ?? 0) - (a[mapSort] ?? 0));
  }, [period, mapSort]);
  const periodSeconds = total(period, "active_seconds");
  const report = () => {
    const hour = t("时", "h");
    const lines = [
      `${t("练级战报", "Grind report")} · ${label(mode, start, end, english)}${onlyMap ? ` · ${onlyMap}` : ""}`,
      `${t("刷图", "Runs")} ${shown.length} · ${clock(seconds)}`,
      `${t("经验", "EXP")} ${big(total(shown, "exp"), english)} · ${big(hourly(total(shown, "exp"), seconds), english)}/${hour}`,
      `${t("净收益", "Net")} ${signed(total(shown, "net"), english)} · ${signed(hourly(total(shown, "net"), seconds), english)}/${hour}`,
      `${t("击杀", "Kills")} ${big(total(shown, "kills"), english)}`,
      ...(onlyMap ? [] : maps.slice(0, 3).map(map => `${map.name}: ${clock(map.time)} · ${big(map.exp, english)} EXP/${hour} · ${signed(map.net, english)}/${hour}`)),
      "mxd.ruit.me",
    ];
    navigator.clipboard?.writeText(lines.join("\n")).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1800); }, () => null);
  };

  return <div className="gp">
    <div className="gp-bar">
      <div className="gp-seg" role="group" aria-label={t("统计周期", "Period")}>
        {([["day", "日", "Day"], ["week", "周", "Week"], ["month", "月", "Month"]] as const).map(([key, zh, en]) =>
          <button key={key} type="button" aria-pressed={mode === key} onClick={() => setMode(key)}>{t(zh, en)}</button>)}
      </div>
      <div className="gp-nav">
        <button type="button" aria-label={t("上一个", "Previous")} onClick={() => setAnchor(shift(mode, start, -1))}>‹</button>
        <b>{label(mode, start, end, english)}</b>
        <button type="button" aria-label={t("下一个", "Next")} disabled={end.getTime() > Date.now()} onClick={() => setAnchor(shift(mode, start, 1))}>›</button>
      </div>
      <div className="gp-extra">{filters}
        <label className="gp-check"><input type="checkbox" checked={hideShort} onChange={e => setHideShort(e.target.checked)} />{t("隐藏 5 分钟以下", "Hide under 5 min")}</label>
        {shown.length > 0 && <button type="button" className="gp-copy" onClick={report}>{copied ? t("已复制", "Copied") : t("复制战报", "Copy report")}</button>}
      </div>
    </div>
    {onlyMap && <div className="gp-chip"><span>{t("只看", "Only")} <b>{onlyMap}</b></span><button type="button" className="text-link" onClick={() => setOnlyMap(null)}>{t("全部地图", "All maps")}</button></div>}
    {shown.length === 0
      ? <div className="gp-empty"><span>{t("这段时间没有记录。", "No runs in this period.")}</span>
          {latest > 0 && <button type="button" className="text-link" onClick={() => setAnchor(new Date(latest * 1000))}>{t("去最近一次记录", "Go to the latest run")}</button>}</div>
      : <>
        <div className="gp-totals">
          <div><small>{t("刷图", "Runs")}</small><b>{shown.length}<span> · {clock(seconds)}</span>{change(seconds, beforeSeconds)}</b></div>
          <div><small>{t("经验", "EXP")}</small><b>{big(total(shown, "exp"), english)}{change(total(shown, "exp"), total(before, "exp"))}</b></div>
          <div><small>{t("经验/时", "EXP/h")}</small><b>{big(hourly(total(shown, "exp"), seconds), english)}{change(hourly(total(shown, "exp"), seconds), hourly(total(before, "exp"), beforeSeconds))}</b></div>
          <div><small>{t("净收益", "Net")}</small><b><span className="money">{signed(total(shown, "net"), english)}</span>{change(total(shown, "net"), total(before, "net"))}</b></div>
          <div><small>{t("击杀", "Kills")}</small><b>{big(total(shown, "kills"), english)}{change(total(shown, "kills"), total(before, "kills"))}</b></div>
        </div>
        {days.length > 0 && <div className={"gp-bars " + mode} role="group" aria-label={t("每天刷图时长", "Time per day")}>
          {days.map(d => <button key={d.at.getTime()} type="button" disabled={!d.seconds}
            className={(d.seconds ? "on" : "") + (d.at.getTime() === today ? " today" : "")}
            title={d.seconds ? `${label("day", d.at, shift("day", d.at, 1), english)} · ${clock(d.seconds)} · ${big(d.exp, english)} EXP` : label("day", d.at, shift("day", d.at, 1), english)}
            onClick={() => { setMode("day"); setAnchor(d.at); }}>
            <i style={{ height: `${d.seconds / longest * 100}%` }} />
            <small>{mode === "week" ? (english ? ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"] : ["一", "二", "三", "四", "五", "六", "日"])[(d.at.getDay() + 6) % 7]
              : d.at.getDate() === 1 || d.at.getDate() % 5 === 0 ? d.at.getDate() : ""}</small>
          </button>)}
        </div>}
        {maps.length > 1 && <div className="gp-maps">
          <div className="gp-map head"><span>{t("地图 · 点一下只看这张图", "Map · click to show only it")}</span><span className="opt">{t("次数", "Runs")}</span>
            {([["time", "时长", "Time", ""], ["exp", "经验/时", "EXP/h", ""], ["net", "收益/时", "Profit/h", "opt"]] as const).map(([key, zh, en, cls]) =>
              <button type="button" key={key} className={"gp-sort " + cls} aria-pressed={mapSort === key} onClick={() => setMapSort(key)}>{t(zh, en)}{mapSort === key ? " ↓" : ""}</button>)}</div>
          {maps.slice(0, 8).map(map => <button type="button" className="gp-map" key={map.name} aria-pressed={onlyMap === map.name}
            onClick={() => setOnlyMap(onlyMap === map.name ? null : map.name)}>
            <i style={{ width: `${map.time / Math.max(1, periodSeconds) * 100}%` }} />
            <span><b>{map.name}</b> <small>{Math.round(map.time / Math.max(1, periodSeconds) * 100)}%</small></span><span className="opt">{map.count}</span><span>{clock(map.time)}</span>
            <span>{big(map.exp, english)}</span><span className={"opt" + (map.net ? " money" : "")}>{signed(map.net, english)}</span>
          </button>)}
        </div>}
        {children(shown)}
      </>}
  </div>;
}

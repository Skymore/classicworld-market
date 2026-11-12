// 刷图 on the website: your synced runs, one run in full, the map leaderboard,
// and public share pages (/g/<code>), each with a prominent client download.
import { useEffect, useMemo, useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { usePreferences, useWords } from "../providers";
import { useAccount } from "../lib/query";
import { ErrorState, Loading, usePageReady } from "../components/shared";
import { SiteLink } from "../components/shell";
import { RunDetail, Spark, big, clock, signed, when, type Comparison, type GrindRun } from "../components/grind-run";
import { copyCard, drawCard, saveCard } from "../lib/grind-card";
import "./grind.css";

const DOWNLOAD = "/web/download.html";

async function getJson<T>(url: string): Promise<T> {
  const response = await fetch(url, { credentials: "same-origin" });
  if (!response.ok) throw Object.assign(new Error(String(response.status)), { status: response.status });
  return response.json();
}

/** The big call to action: everything here comes from the client. */
export function DownloadBanner({ compact = false }: { compact?: boolean }) {
  const words = useWords();
  return (
    <aside className={"grind-download" + (compact ? " compact" : "")} data-grind-download>
      <div>
        <b>{words("自动记录每一次刷图", "Every grind, recorded automatically")}</b>
        <span>{words("经验、掉落、收益、DPS 和 Buff 倒计时，游戏里还有悬浮窗。免费。", "EXP, loot, profit, DPS and buff timers, with an in-game overlay. Free.")}</span>
      </div>
      <SiteLink className="btn grind-download-btn" href={DOWNLOAD}>{words("下载客户端", "Download the client")}</SiteLink>
    </aside>
  );
}

/** Pinned to the bottom on phones. */
function DownloadBar() {
  const words = useWords();
  return (
    <div className="grind-download-bar">
      <span>{words("用客户端记录你的刷图", "Record your own runs")}</span>
      <SiteLink className="btn grind-download-btn" href={DOWNLOAD}>{words("免费下载", "Free download")}</SiteLink>
    </div>
  );
}

export default function GrindPage() {
  usePageReady();
  const route = useLocation();
  const share = route.pathname.match(/^\/g\/([A-Za-z0-9]{7})/);
  const run = route.pathname.match(/^\/grind\/run\/(\d+)/);
  return (
    <div className="grind-site" data-grind-site>
      {share ? <SharePage code={share[1]} /> : run ? <MyRun row={run[1]} /> : <Hub />}
      <DownloadBar />
    </div>
  );
}

function Hub() {
  const words = useWords();
  const route = useLocation(), navigate = useNavigate();
  const board = new URLSearchParams(route.search).get("tab") === "board";
  return (
    <>
      <DownloadBanner />
      <section className="stall">
        <div className="stall-bar grind-site-bar">
          <h1>{words("刷图", "Grind")}</h1>
          <nav>
            <button aria-pressed={!board} onClick={() => navigate("/grind")}>{words("我的记录", "My runs")}</button>
            <button aria-pressed={board} onClick={() => navigate("/grind?tab=board")}>{words("地图效率榜", "Map leaderboard")}</button>
          </nav>
        </div>
        {board ? <Leaderboard /> : <MyRuns />}
      </section>
    </>
  );
}

type ListRun = GrindRun & { row: number; share_code: string | null };

function MyRuns() {
  const words = useWords(), { language } = usePreferences(), en = language === "en";
  const account = useAccount();
  const signedIn = account.data?.signed_in;
  const query = useQuery<{ runs: ListRun[] }>({ queryKey: ["grind-runs"], queryFn: () => getJson("/api/v1/grind/runs"), enabled: !!signedIn, staleTime: 30_000 });
  const runs = query.data?.runs || [];
  const week = useMemo(() => runs.filter((r) => r.started_at >= Date.now() / 1000 - 7 * 86400), [runs]);
  const sum = (key: "exp" | "net" | "kills" | "active_seconds") => week.reduce((total, r) => total + (Number(r[key]) || 0), 0);
  if (account.isLoading) return <Loading />;
  if (!signedIn)
    return (
      <div className="grind-empty">
        <p>{words("登录后可以在这里看到客户端同步的全部刷图记录。", "Sign in to see every run your client synced.")}</p>
        <SiteLink className="btn primary" href="/account">{words("登录", "Sign in")}</SiteLink>
      </div>
    );
  if (query.isLoading) return <Loading />;
  if (query.isError) return <ErrorState retry={() => void query.refetch()} />;
  if (!runs.length)
    return (
      <div className="grind-empty">
        <p>{words("还没有同步的记录。在客户端「账号」里登录这个账号，刷完的每一场都会出现在这里。", "No runs yet. Sign in to this account in the client's Account tab and every finished run appears here.")}</p>
        <SiteLink className="btn primary" href={DOWNLOAD}>{words("下载客户端", "Download the client")}</SiteLink>
      </div>
    );
  return (
    <>
      <div className="grind-totals">
        <span>{words("近 7 天", "Last 7 days")} <b>{words(`${week.length} 次 · ${clock(sum("active_seconds"))}`, `${week.length} runs · ${clock(sum("active_seconds"))}`)}</b></span>
        <span>{words("经验", "EXP")} <b>{big(sum("exp"), en)}</b></span>
        <span>{words("净收益", "Net")} <b className="money">{signed(sum("net"), en)}</b></span>
        <span>{words("击杀", "Kills")} <b>{big(sum("kills"), en)}</b></span>
      </div>
      <div className="grind-list">
        {runs.map((run) => (
          <SiteLink key={run.row} className="grind-list-row" href={`/grind/run/${run.row}`}>
            <span className="when">{when(run.started_at)}</span>
            <span className="who"><b>{run.map_name || "—"}</b> <small>{run.character?.name} · {run.job_name} {run.level ?? ""}</small>
              {run.share_code && <i>{words("已分享", "Shared")}</i>}</span>
            <span>{clock(run.active_seconds)}</span>
            <span>{big(run.exp_per_hour, en)}<small>/{words("时", "h")}</small></span>
            <span className="money">{signed(run.net_per_hour, en)}<small>/{words("时", "h")}</small></span>
            <Spark run={run} />
          </SiteLink>
        ))}
      </div>
    </>
  );
}

function MyRun({ row }: { row: string }) {
  const words = useWords(), { language } = usePreferences();
  const query = useQuery<{ run: GrindRun; share_code: string | null; comparison: Comparison | null }>({
    queryKey: ["grind-run", row], queryFn: () => getJson(`/api/v1/grind/runs/${row}`), staleTime: 60_000, retry: false });
  if (query.isLoading) return <Loading />;
  if (query.isError)
    return <div className="grind-empty"><p>{words("找不到这条记录，或者它不属于当前登录的账号。", "This run doesn't exist or belongs to another account.")}</p>
      <SiteLink className="btn" href="/grind">{words("我的记录", "My runs")}</SiteLink></div>;
  const data = query.data!;
  return (
    <section className="grind-page-run">
      <SiteLink className="grind-back" href="/grind">‹ {words("我的记录", "My runs")}</SiteLink>
      <RunDetail run={data.run} t={words} english={language === "en"} comparison={data.comparison}
        actions={data.share_code ? <SiteLink className="btn primary" href={`/g/${data.share_code}`}>{words("查看分享页", "Open share page")}</SiteLink> : null} />
    </section>
  );
}

function SharePage({ code }: { code: string }) {
  const words = useWords(), { language } = usePreferences(), en = language === "en";
  const query = useQuery<{ run: GrindRun; show_name: boolean; show_profit: boolean; views: number; comparison: Comparison | null }>({
    queryKey: ["grind-share", code], queryFn: () => getJson(`/api/v1/grind/share/${code}`), staleTime: 300_000, retry: false });
  const canvas = useRef<HTMLCanvasElement>(null);
  const [note, setNote] = useState("");
  const url = `${location.origin}/g/${code}`;
  useEffect(() => {
    if (query.data && canvas.current)
      drawCard(canvas.current, query.data.run, { url, t: words, showName: query.data.show_name, showProfit: query.data.show_profit, english: en });
  }, [query.data, url, words, en]);
  if (query.isLoading) return <Loading />;
  if (query.isError)
    return <><div className="grind-empty"><p>{words("这个分享链接不存在。", "This share link doesn't exist.")}</p></div><DownloadBanner /></>;
  const { run, show_profit, comparison } = query.data!;
  const who = run.character?.name || (run.job_name ? words(`一位${run.job_name}`, `A ${run.job_name}`) : words("一位冒险家", "An adventurer"));
  const minutes = Math.round(run.active_seconds / 60);
  const length = minutes >= 60 ? words(`${Math.floor(minutes / 60)} 小时 ${minutes % 60} 分`, `${Math.floor(minutes / 60)}h ${minutes % 60}m`) : words(`${minutes} 分钟`, `${minutes} minutes`);
  return (
    <>
      <header className="grind-share-hero">
        <h1>{words(`${who}在${run.map_name || "冒险岛"}刷了 ${length}`, `${who} grinded ${run.map_name || "MapleStory"} for ${length}`)}</h1>
        <p>{words("由枫叶市集客户端自动记录", "Recorded automatically by the Maple Market client")}</p>
        <SiteLink className="btn grind-download-btn big" href={DOWNLOAD}>{words("我也要记录 · 下载客户端", "Record mine · Download the client")}</SiteLink>
      </header>
      <RunDetail run={run} t={words} english={en} comparison={comparison} profit={show_profit} actions={
        <>
          <button className="btn" onClick={async () => setNote(canvas.current && (await copyCard(canvas.current)) ? words("图片已复制", "Image copied") : words("请保存图片", "Save the image instead"))}>{words("复制图片", "Copy image")}</button>
          <button className="btn" onClick={() => canvas.current && saveCard(canvas.current, `grind-${code}.png`)}>{words("保存图片", "Save image")}</button>
          <button className="btn" onClick={async () => { await navigator.clipboard.writeText(url); setNote(words("链接已复制", "Link copied")); }}>{words("复制链接", "Copy link")}</button>
        </>
      } />
      {note && <p className="grind-note" role="status">{note}</p>}
      <canvas ref={canvas} className="grind-share-canvas" aria-label={words("分享卡片", "Share card")} />
      <DownloadBanner />
    </>
  );
}

interface BoardRow { level_from: number; level_to: number; map_id: number; name: string | null; name_en: string | null; runs: number; hours: number; exp_per_hour: number; net_per_hour: number; kills_per_hour: number }

function Leaderboard() {
  const words = useWords(), { language } = usePreferences(), en = language === "en";
  const [level, setLevel] = useState<string>("");
  const query = useQuery<{ rows: BoardRow[] }>({ queryKey: ["grind-board", level], queryFn: () => getJson(`/api/v1/grind/leaderboard${level ? `?level=${level}` : ""}`), staleTime: 300_000 });
  const bands = Array.from({ length: 40 }, (_, i) => i * 5 + 1);
  return (
    <>
      <div className="grind-totals">
        <label>{words("等级", "Level")} <select value={level} onChange={(e) => setLevel(e.target.value)}>
          <option value="">{words("全部", "All")}</option>
          {bands.map((b) => <option key={b} value={b}>{b}–{b + 4}</option>)}
        </select></label>
        <span className="note-inline">{words("近 30 天全站客户端数据，按经验效率排序", "Last 30 days from every client, by EXP/h")}</span>
      </div>
      {query.isLoading ? <Loading /> : query.isError ? <ErrorState retry={() => void query.refetch()} /> : !query.data!.rows.length ? (
        <div className="grind-empty"><p>{words("这个等级还没有记录。", "No runs at this level yet.")}</p></div>
      ) : (
        <div className="grind-board">
          <div className="grind-board-row head"><span>{words("等级", "Level")}</span><span>{words("地图", "Map")}</span><span>{words("场次", "Runs")}</span>
            <span>{words("经验/时", "EXP/h")}</span><span>{words("收益/时", "Profit/h")}</span><span>{words("击杀/时", "Kills/h")}</span></div>
          {query.data!.rows.map((row, i) => (
            <SiteLink key={i} className="grind-board-row" href={`/map/${row.map_id}`}>
              <span>{row.level_from}–{row.level_to}</span>
              <span><b>{(en ? row.name_en : row.name) || row.name || `#${row.map_id}`}</b></span>
              <span>{row.runs}<small> · {row.hours.toFixed(1)}h</small></span>
              <span><b>{big(row.exp_per_hour, en)}</b></span>
              <span className="money">{signed(row.net_per_hour, en)}</span>
              <span>{big(row.kills_per_hour, en)}</span>
            </SiteLink>
          ))}
        </div>
      )}
    </>
  );
}

// 刷图 on the website: your synced runs, one run in full, the map leaderboard,
// and public share pages (/g/<code>) with one client download banner at the end.
import { useEffect, useMemo, useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { usePreferences, useWords } from "../providers";
import { useAccount } from "../lib/query";
import { ErrorState, Loading, usePageReady } from "../components/shared";
import { SiteLink } from "../components/shell";
import { RunDetail, Spark, big, clock, signed, when, type Comparison, type GrindRun } from "../components/grind-run";
import { PeriodBoard } from "../components/grind-periods";
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

export default function GrindPage() {
  usePageReady();
  const route = useLocation();
  const share = route.pathname.match(/^\/g\/([A-Za-z0-9]{7})/);
  const run = route.pathname.match(/^\/grind\/run\/(\d+)/);
  return (
    <div className="grind-site" data-grind-site>
      {share ? <SharePage code={share[1]} /> : run ? <MyRun row={run[1]} /> : <Hub />}
    </div>
  );
}

function Hub() {
  const words = useWords();
  const route = useLocation(), navigate = useNavigate();
  const board = new URLSearchParams(route.search).get("tab") === "board";
  return (
    <>
      {board && <DownloadBanner compact />}
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
  if (account.isLoading) return <Loading />;
  if (!signedIn)
    return (
      <div className="grind-intro">
        <div className="grind-intro-text">
          <h2>{words("每一次刷图，自动记下来", "Every grind, recorded for you")}</h2>
          <p>{words("客户端统计经验、掉落、收益和 DPS。登录后在这里按日、周、月回看。", "The client tracks EXP, loot, profit and DPS. Sign in to look back by day, week and month.")}</p>
          <div className="grind-empty-actions">
            <SiteLink className="btn primary" href="/account">{words("登录", "Sign in")}</SiteLink>
            <SiteLink className="btn" href={DOWNLOAD}>{words("下载客户端", "Download the client")}</SiteLink>
          </div>
        </div>
        <div className="grind-intro-shot" aria-hidden="true">
          <img src="/web/img/client/grind.webp" width={880} height={660} alt="" decoding="async" />
          <img className="over" src="/web/img/client/overlay.webp" width={260} height={288} alt="" decoding="async" />
        </div>
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
    <PeriodBoard runs={runs} t={words} english={en} remember="grind.period">{(shown) => (
      <div className="grind-list">
        <div className="grind-list-row head"><span>{words("时间", "Time")}</span><span>{words("地图 · 角色", "Map · character")}</span><span>{words("时长", "Length")}</span>
          <span>{words("经验/时", "EXP/h")}</span><span>{words("收益/时", "Profit/h")}</span><span /></div>
        {shown.map((run) => (
          <SiteLink key={run.row} className="grind-list-row" href={`/grind/run/${run.row}`}>
            <span className="when">{when(run.started_at)}</span>
            <span className="who"><b>{run.map_name || "—"}</b> <small>{run.character?.name} · {run.job_name} {run.level ?? ""}</small>
              {run.share_code && <i>{words("已分享", "Shared")}</i>}</span>
            <span>{clock(run.active_seconds)}</span>
            <span>{big(run.exp_per_hour, en)}{run.exp_per_hour != null && <small>/{words("时", "h")}</small>}</span>
            <span className={run.net_per_hour ? "money" : undefined}>{signed(run.net_per_hour, en)}{run.net_per_hour != null && <small>/{words("时", "h")}</small>}</span>
            <Spark run={run} />
          </SiteLink>
        ))}
      </div>
    )}</PeriodBoard>
  );
}

function MyRun({ row }: { row: string }) {
  const words = useWords(), { language } = usePreferences();
  const [sharing, setSharing] = useState(false);
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
        actions={<button className="btn primary" aria-expanded={sharing} onClick={() => setSharing(!sharing)}>{words("分享", "Share")}</button>} />
      {sharing && <SharePanel row={row} run={data.run} />}
    </section>
  );
}

/** Make (or reuse) a share link for one of the signed-in account's runs, plus the card image. */
function SharePanel({ row, run }: { row: string; run: GrindRun }) {
  const words = useWords(), { language } = usePreferences(), en = language === "en";
  const account = useAccount(), client = useQueryClient();
  const [showName, setShowName] = useState(true), [showProfit, setShowProfit] = useState(true);
  const [link, setLink] = useState<{ url: string; code: string; key: string } | null>(null);
  const [note, setNote] = useState(""), [busy, setBusy] = useState(false);
  const canvas = useRef<HTMLCanvasElement>(null), panel = useRef<HTMLElement>(null);
  const key = `${showName}/${showProfit}`;
  useEffect(() => { panel.current?.scrollIntoView({ behavior: "smooth", block: "nearest" }); }, []);
  const url = link?.key === key ? link.url : null;
  useEffect(() => {
    if (canvas.current) drawCard(canvas.current, run, { url: url || `${location.host}/g/…`, t: words, showName, showProfit, english: en });
  }, [run, url, showName, showProfit, words, en]);
  const make = async () => {
    setBusy(true); setNote("");
    try {
      const response = await fetch(`/api/v1/grind/runs/${row}/share`, { method: "POST", credentials: "same-origin",
        headers: { "Content-Type": "application/json", ...(account.data?.csrf ? { "X-CSRF-Token": account.data.csrf } : {}) },
        body: JSON.stringify({ show_name: showName, show_profit: showProfit }) });
      if (!response.ok) throw Error(String(response.status));
      const data = await response.json() as { url: string; code: string };
      const made = { url: `${location.origin}/g/${data.code}`, code: data.code, key };
      setLink(made);
      void client.invalidateQueries({ queryKey: ["grind-runs"] });
      try { await navigator.clipboard.writeText(made.url); setNote(words("链接已复制", "Link copied")); } catch { /* shown below */ }
    } catch {
      setNote(words("生成失败，请刷新后重试", "Couldn't create the link. Reload and try again."));
    } finally { setBusy(false); }
  };
  return (
    <section ref={panel} className="grind-share-panel" aria-label={words("分享", "Share")}>
      <canvas ref={canvas} className="grind-share-canvas" aria-label={words("分享卡片预览", "Share card preview")} />
      <div className="grind-share-side">
        <label><input type="checkbox" checked={showName} onChange={(e) => setShowName(e.target.checked)} /> {words("显示角色名", "Show character name")}</label>
        <label><input type="checkbox" checked={showProfit} onChange={(e) => setShowProfit(e.target.checked)} /> {words("显示收益", "Show profit")}</label>
        {url ? <>
          <input className="grind-share-url" readOnly value={url} onFocus={(e) => e.currentTarget.select()} />
          <button className="btn primary" onClick={async () => { await navigator.clipboard.writeText(url); setNote(words("链接已复制", "Link copied")); }}>{words("复制链接", "Copy link")}</button>
          <SiteLink className="btn" href={`/g/${link!.code}`}>{words("打开分享页", "Open share page")}</SiteLink>
        </> : <button className="btn primary" disabled={busy} onClick={make}>{busy ? words("生成中…", "Creating…") : words("生成分享链接", "Create share link")}</button>}
        <button className="btn" onClick={async () => setNote(canvas.current && (await copyCard(canvas.current)) ? words("图片已复制", "Image copied") : words("请保存图片", "Save the image instead"))}>{words("复制图片", "Copy image")}</button>
        <button className="btn" onClick={() => canvas.current && saveCard(canvas.current, `grind-${row}.png`)}>{words("保存图片", "Save image")}</button>
        {note && <p className="grind-note" role="status">{note}</p>}
      </div>
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
    return <><div className="grind-empty"><p>{words("这个分享链接不存在。", "This share link doesn't exist.")}</p><SiteLink className="btn grind-download-btn" href={DOWNLOAD}>{words("下载客户端", "Download the client")}</SiteLink></div></>;
  const { run, show_profit, comparison } = query.data!;
  const who = run.character?.name || (run.job_name ? words(`一位${run.job_name}`, `A ${run.job_name}`) : words("一位冒险家", "An adventurer"));
  const minutes = Math.round(run.active_seconds / 60);
  const length = minutes >= 60 ? words(`${Math.floor(minutes / 60)} 小时 ${minutes % 60} 分`, `${Math.floor(minutes / 60)}h ${minutes % 60}m`) : words(`${minutes} 分钟`, `${minutes} minutes`);
  return (
    <>
      <header className="grind-share-hero">
        <h1>{words(`${who}在${run.map_name || "冒险岛"}刷了 ${length}`, `${who} grinded ${run.map_name || "MapleStory"} for ${length}`)}</h1>
        <p>{words("由枫叶市集客户端自动记录", "Recorded automatically by the Maple Market client")}</p>
      </header>
      <RunDetail run={run} t={words} english={en} comparison={comparison} profit={show_profit} actions={
        <>
          <button className="btn" onClick={async () => setNote(canvas.current && (await copyCard(canvas.current)) ? words("图片已复制", "Image copied") : words("请保存图片", "Save the image instead"))}>{words("复制图片", "Copy image")}</button>
          <button className="btn" onClick={() => canvas.current && saveCard(canvas.current, `grind-${code}.png`)}>{words("保存图片", "Save image")}</button>
          <button className="btn" onClick={async () => { await navigator.clipboard.writeText(url); setNote(words("链接已复制", "Link copied")); }}>{words("复制链接", "Copy link")}</button>
        </>
      } />
      {note && <p className="grind-note" role="status">{note}</p>}
      <canvas ref={canvas} className="grind-share-canvas" hidden aria-hidden="true" />
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
              <span>{row.runs}<small> · {words(`${row.hours.toFixed(1)} 小时`, `${row.hours.toFixed(1)}h`)}</small></span>
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

import { Bell, Crosshair, ScanLine, ShoppingCart, Tag } from "lucide-react";
import { usePreferences } from "../providers";
import { usePageReady } from "../components/shared";
import { useMarketQuery } from "../lib/query";
import { SiteLink } from "../components/shell";
import { pick } from "/web/js/lib/i18n.js";
// Shown when the release manifest cannot be read.
const fallback = { version: "v0.6.12", url: "https://download.ruit.me/collector/v0.6.12/ClassicWorldCollector-windows-x64-v0.6.12.zip", size: 0 };
const official = /^https:\/\/(?:download\.ruit\.me\/collector|mxd\.ruit\.me\/web\/releases)\/(v\d{1,6}\.\d{1,6}\.\d{1,6})\/ClassicWorldCollector-windows-x64-\1\.zip$/;
function useRelease() {
  const { data } = useMarketQuery<any>("/web/releases/stable.json", true, false);
  const asset = data?.windows_x64, match = typeof asset?.url === "string" && official.exec(asset.url);
  return match && match[1] === data.version ? { version: data.version as string, url: asset.url as string, size: Number(asset.size) || 0 } : fallback;
}
export default function Page() {
  usePageReady();
  const { language } = usePreferences();
  const en = language === "en";
  const release = useRelease(), base = release.url.slice(0, release.url.lastIndexOf("/") + 1);
  const size = release.size ? Math.round(release.size / 1048576) : 70;
  const steps = en ? [
    ["Download and unzip", "Extract the entire ZIP, run ClassicWorldCollector.exe and allow administrator permission."],
    ["Sign in", "Open Account in the client and sign in. Grind runs, watch lists and shop plans then stay in step with the website."],
    ["Play as usual", "Kill a few monsters and the grind record starts by itself. Browse shops, or enter the Free Market and press Start, and the quotes upload."],
  ] : [
    ["下载并解压", "完整解压 ZIP，运行 ClassicWorldCollector.exe，允许管理员权限。"],
    ["登录账号", "在客户端「账号」里登录，刷图记录、关注和摆摊就和网站同步。"],
    ["照常玩游戏", "进图打几只怪，刷图记录自动开始。逛摊，或进自由市场点「开始扫描」，报价自动上传。"],
  ];
  const features: [typeof Crosshair, string, string][] = [
    [Crosshair, pick("刷图记录", "Grind tracker"), pick("自动统计经验、掉落、收益和 DPS，游戏里有悬浮窗", "EXP, loot, profit and DPS recorded automatically, with an in-game overlay")],
    [Tag, pick("摆摊定价", "Shop pricing"), pick("按最近成交价给背包里的东西定价", "Prices what is in your bag from recent sales")],
    [Bell, pick("低价提醒", "Deal alerts"), pick("逛摊时遇到关注物品的低价货，马上提醒", "Tells you when a watched item shows up cheap")],
    [ShoppingCart, pick("扫货", "Sweep"), pick("关注的物品出现低价，按你设的上限自动买", "Buys watched items for you when they drop under your limit")],
    [ScanLine, pick("采集报价", "Price collection"), pick("逛摊或自动扫描时，把报价传到市集", "Sends the quotes you see to the market while you browse or scan")],
  ];
  return <>
    <section className="stall"><div className="stall-bar"><h1>{pick("下载客户端", "Download collector")}</h1></div><div className="download-body download-hero">
      <div className="download-pitch">
        <h2>{pick("刷图记录、摆摊定价、低价提醒，都在一个客户端", "Grind tracking, shop pricing and deal alerts in one client")}</h2>
        <div className="download-actions"><a className="btn primary" href={release.url}>{pick("下载 Windows 客户端", "Download for Windows")}</a><SiteLink href="/collect/">{pick("改用浏览器采集", "Browser collector")}</SiteLink></div>
        <p className="download-meta">{release.version} · Windows 10 / 11 64 位 · {pick(`约 ${size} MB`, `about ${size} MB`)}</p>
      </div>
      <div className="download-shot" aria-hidden="true">
        <img src="/web/img/client/grind.webp" width={880} height={660} alt="" decoding="async" />
        <img className="over" src="/web/img/client/overlay.webp" width={260} height={288} alt="" decoding="async" />
      </div>
    </div>
    <ul className="download-features">{features.map(([Icon, title, body]) => <li key={title}><Icon size={20} aria-hidden="true" /><b>{title}</b><span>{body}</span></li>)}</ul>
    </section>
    <section className="stall"><div className="stall-bar"><h2>{pick("三步开始使用", "Get started")}</h2></div><div className="download-body"><ol className="download-steps">{steps.map(([title, body]) => <li key={title}><b>{title}</b>{body}</li>)}</ol><p>{pick("自动扫描时保持游戏窗口可见，不要移动或缩放窗口。F9 可停止扫描，手动采集仍可继续使用。", "Keep the game window visible. F9 stops scanning; manual collection stays available.")}</p></div></section>
    <section className="stall"><div className="stall-bar"><h2>{pick("常见问题", "Common questions")}</h2></div><div className="download-body">
      <details><summary>{pick("多人一起扫，会重复吗？", "Will people scan the same room?")}</summary><p>{pick("每人一次领取一个洞，扫完再领下一个。暂停或断线后，任务会交给其他在线扫描器。", "Each scanner gets one room at a time and claims its next room after finishing. Paused or disconnected tasks become available to others.")}</p></details>
      <details><summary>{pick("频道按什么顺序扫？", "Which channel order?")}</summary><p>{pick("从 1频道往上扫，连续三个空频道后，从 40频道往下扫。倒序再遇到三个空频道，或与已扫范围相遇，就换洞。", "Start at CH1. Three empty channels switch scanning to CH40 descending. Three more empty channels or meeting the scanned range finishes the room.")}</p></details>
      <details><summary>{pick("以后还要手动下载更新吗？", "Automatic updates?")}</summary><p>{pick("新版本在后台下载。客户端底部出现「更新到 v…」时点一下，客户端会短暂重启，游戏无需退出；之后点「开始扫描」继续。配置和记录保留。旧版首次升级仍可能需要退出游戏，或手动安装新版。", "Updates download in the background. When the collector shows “Update to v…” at the bottom, click it: the collector restarts briefly and the game stays open. Then press Start to continue. Settings and records are kept. Older versions may wait for the game to close for this first upgrade.")}</p></details>
      <details><summary>{pick("以前装过旧扫描器或旧客户端？", "Used the old scanner or collector before?")}</summary><p>{pick("先关掉它们再运行新版，新版已经包含两者的功能。", "Close them before running this one. It replaces both.")}</p></details>
      <details><summary>{pick("提示被 Windows 阻止，或打不开？", "Blocked by Windows or won't start?")}</summary><p>{pick("右键下载的 ZIP → 属性 → 勾选「解除锁定」→ 确定，删除旧文件夹后重新解压。", "Right-click the downloaded ZIP, open Properties, tick Unblock and press OK. Then delete the old folder and extract again.")}</p></details>
      <details><summary>{pick("为什么没有新报价？", "No new prices?")}</summary><p>{pick("先切一次频道，再打开摊位，在客户端的「账号与提醒」里查看采集状态。暂时无法上传的报价会保存在本机，恢复连接后重试。", "Change channel once, then open a shop. Check status through Account & alerts in the collector. Failed uploads are kept locally and retried.")}</p></details>
      <p><a href={base + "guide.txt"}>{pick("完整使用说明", "Usage guide")}</a> · <a href={base + "release-notes.txt"}>{pick("版本记录", "Release notes")}</a> · <SiteLink href="/contributors">{pick("采集贡献榜", "Contributors")}</SiteLink></p>
    </div></section>
  </>;
}

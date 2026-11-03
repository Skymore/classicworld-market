import { usePreferences } from "../providers";
import { usePageReady } from "../components/shared";
import { useMarketQuery } from "../lib/query";
import { SiteLink } from "../components/shell";
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
    ["Choose how to collect", "For manual collection, change channel once and browse shops. For automatic scanning, enter Free Market, select the game window and click Start."],
    ["See prices and alerts", "Quotes upload automatically. Click Account & alerts in the collector to set your nickname, link Google and view your alerts."],
  ] : [
    ["下载并解压", "完整解压 ZIP，运行 ClassicWorldCollector.exe，允许管理员权限。"],
    ["选择采集方式", "手动逛摊：切一次频道后照常开店。自动扫描：进入自由市场，选择游戏窗口，点击「开始扫描」。"],
    ["查看报价和提醒", "报价会自动上传。点采集器上的「账号与提醒」，可以设置昵称、绑定 Google 账号和查看关注提醒。"],
  ];
  return <>
    <section className="stall"><div className="stall-bar"><h1>{en ? "Download collector" : "下载采集器"}</h1></div><div className="download-body">
      <h2>{en ? "One app for manual collection and automatic scanning" : "手动逛摊、自动扫描，一个程序就够"}</h2>
      <p>{en ? "Capture, uploads, alerts and updates are built in. Signing in is optional." : "内置采集、上传、提醒和自动更新。不登录也能用。"}</p>
      <div className="download-actions"><a className="btn primary" href={release.url}>{en ? "Download for Windows" : "下载 Windows 采集器"}</a><SiteLink href="/collect/">{en ? "Browser collector" : "改用浏览器采集"}</SiteLink></div>
      <p className="download-meta">{release.version} · Windows 10 / 11 64 位 · {en ? `about ${size} MB` : `约 ${size} MB`}</p>
    </div></section>
    <section className="stall"><div className="stall-bar"><h2>{en ? "Get started" : "三步开始使用"}</h2></div><div className="download-body"><ol className="download-steps">{steps.map(([title, body]) => <li key={title}><b>{title}</b>{body}</li>)}</ol><p>{en ? "Keep the game window visible. F9 stops scanning; manual collection stays available." : "自动扫描时保持游戏窗口可见，不要移动或缩放窗口。F9 可停止扫描，手动采集仍可继续使用。"}</p></div></section>
    <section className="stall"><div className="stall-bar"><h2>{en ? "Common questions" : "常见问题"}</h2></div><div className="download-body">
      <details><summary>{en ? "Will people scan the same room?" : "多人一起扫，会重复吗？"}</summary><p>{en ? "Each scanner gets one room at a time and claims its next room after finishing. Paused or disconnected tasks become available to others." : "每人一次领取一个洞，扫完再领下一个。暂停或断线后，任务会交给其他在线扫描器。"}</p></details>
      <details><summary>{en ? "Which channel order?" : "频道按什么顺序扫？"}</summary><p>{en ? "Start at CH1. Three empty channels switch scanning to CH40 descending. Three more empty channels or meeting the scanned range finishes the room." : "从 1频道往上扫，连续三个空频道后，从 40频道往下扫。倒序再遇到三个空频道，或与已扫范围相遇，就换洞。"}</p></details>
      <details><summary>{en ? "Automatic updates?" : "以后还要手动下载更新吗？"}</summary><p>{en ? "Updates download in the background. When the collector shows “Update to v…” at the bottom, click it: the collector restarts briefly and the game stays open. Then press Start to continue. Settings and records are kept. Older versions may wait for the game to close for this first upgrade." : "新版本在后台下载。采集器底部出现「更新到 v…」时点一下，采集器会短暂重启，游戏无需退出；之后点「开始扫描」继续。配置和记录保留。旧版首次升级仍可能需要退出游戏，或手动安装新版。"}</p></details>
      <details><summary>{en ? "Used the old scanner or collector before?" : "以前装过旧扫描器或旧采集器？"}</summary><p>{en ? "Close them before running this one. It replaces both." : "先关掉它们再运行新版，新版已经包含两者的功能。"}</p></details>
      <details><summary>{en ? "Blocked by Windows or won't start?" : "提示被 Windows 阻止，或打不开？"}</summary><p>{en ? "Right-click the downloaded ZIP, open Properties, tick Unblock and press OK. Then delete the old folder and extract again." : "右键下载的 ZIP → 属性 → 勾选「解除锁定」→ 确定，删除旧文件夹后重新解压。"}</p></details>
      <details><summary>{en ? "No new prices?" : "为什么没有新报价？"}</summary><p>{en ? "Change channel once, then open a shop. Check status through Account & alerts in the collector. Failed uploads are kept locally and retried." : "先切一次频道，再打开摊位，在采集器的「账号与提醒」里查看采集状态。暂时无法上传的报价会保存在本机，恢复连接后重试。"}</p></details>
      <p><a href={base + "guide.txt"}>{en ? "Usage guide" : "完整使用说明"}</a> · <a href={base + "release-notes.txt"}>{en ? "Release notes" : "版本记录"}</a> · <SiteLink href="/contributors">{en ? "Contributors" : "采集贡献榜"}</SiteLink></p>
    </div></section>
  </>;
}

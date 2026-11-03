import { useWords } from "../providers";
import { Icon, usePageReady } from "../components/shared";
import { SiteLink } from "../components/shell";
import "./tools.css";

type Entry = [href: string, key: string, icon: string, zh: string, en: string, subZh: string, subEn: string];

const TOOLS: Entry[] = [
  ["/tools/enhancement", "enhancement", "star", "强化计算器", "Enhancement calculator", "计算成本与最佳强化策略", "Expected cost and the best upgrade strategy"],
];
const COLLECT: Entry[] = [
  ["/collect/", "collect", "search", "浏览器采集", "Browser collector", "在电脑上共享游戏窗口，逛摊时自动上传报价", "Share the game window on a computer; shops upload as you browse"],
  ["/web/download.html", "download", "tools", "下载采集器", "Download collector", "Windows 程序，手动逛摊和自动扫描都能用", "Windows app for manual browsing and automatic scans"],
  ["/alerts", "alerts", "tag", "低价提醒", "Deal alerts", "你采集时遇到的低价货", "Cheap offers found while you collect"],
  ["/contributors", "contributors", "leaf", "采集贡献榜", "Contributors", "谁帮市集采集了最多摊位", "Who collected the most shops"],
];
const SITE: Entry[] = [
  ["/traffic", "traffic", "chart", "网站流量", "Website traffic", "最近 30 天的访问和来源", "Visits and sources over the last 30 days"],
  ["/privacy", "privacy", "book", "账号隐私说明", "Account privacy", "账号和统计保存了什么", "What accounts and statistics store"],
];

function Entries({ entries }: { entries: Entry[] }) {
  const words = useWords();
  return (
    <div className="tool-list">
      {entries.map(([href, key, icon, zh, en, subZh, subEn]) => (
        <SiteLink className="tool-entry well" href={href} data-tool={key} key={key}>
          <Icon name={icon} />
          <span>
            <b>{words(zh, en)}</b>
            <small>{words(subZh, subEn)}</small>
          </span>
          <Icon name="chev" />
        </SiteLink>
      ))}
    </div>
  );
}

export default function Tools() {
  usePageReady();
  const words = useWords();
  return (
    <div className="lwrap tools-page">
      <section className="stall">
        <div className="stall-bar">
          <h1>{words("工具", "Tools")}</h1>
        </div>
        <Entries entries={TOOLS} />
        <h2 className="tool-group">{words("帮市集采集价格", "Help collect prices")}</h2>
        <Entries entries={COLLECT} />
        <h2 className="tool-group">{words("关于本站", "About this site")}</h2>
        <Entries entries={SITE} />
      </section>
    </div>
  );
}

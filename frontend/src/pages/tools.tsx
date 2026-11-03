import { useWords } from "../providers";
import { Icon, usePageReady } from "../components/shared";
import { SiteLink } from "../components/shell";
import "./tools.css";

type Entry = [href: string, key: string, icon: string, zh: string, en: string];

const TOOLS: Entry[] = [
  ["/tools/enhancement", "enhancement", "star", "强化计算器", "Enhancement calculator"],
];
const COLLECT: Entry[] = [
  ["/collect/", "collect", "search", "浏览器采集", "Browser collector"],
  ["/web/download.html", "download", "tools", "下载采集器", "Download collector"],
  ["/alerts", "alerts", "tag", "低价提醒", "Deal alerts"],
  ["/contributors", "contributors", "leaf", "采集贡献榜", "Contributors"],
];
const SITE: Entry[] = [
  ["/traffic", "traffic", "chart", "网站流量", "Website traffic"],
  ["/privacy", "privacy", "book", "账号隐私说明", "Account privacy"],
];

function Entries({ entries }: { entries: Entry[] }) {
  const words = useWords();
  return (
    <div className="tool-list">
      {entries.map(([href, key, icon, zh, en]) => (
        <SiteLink className="tool-entry well" href={href} data-tool={key} key={key}>
          <Icon name={icon} />
          <span>
            <b>{words(zh, en)}</b>
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

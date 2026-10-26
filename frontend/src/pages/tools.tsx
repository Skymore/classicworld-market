import { useWords } from "../providers";
import { Icon, usePageReady } from "../components/shared";
import { SiteLink } from "../components/shell";
import "./tools.css";

export default function Tools() {
  usePageReady();
  const words = useWords();
  return (
    <div className="lwrap tools-page">
      <section className="stall">
        <div className="stall-bar">
          <h1>{words("工具", "Tools")}</h1>
        </div>
        <div className="tool-list">
          <SiteLink
            className="tool-entry well"
            href="/tools/enhancement"
            data-tool="enhancement"
          >
            <Icon name="star" />
            <span>
              <b>{words("强化计算器", "Enhancement calculator")}</b>
              <small>
                {words(
                  "计算成本与最佳强化策略",
                  "Expected cost and the best upgrade strategy",
                )}
              </small>
            </span>
            <Icon name="chev" />
          </SiteLink>
          <SiteLink
            className="tool-entry well"
            href="/alerts"
            data-tool="collection"
          >
            <Icon name="coin" />
            <span>
              <b>{words("采集", "Collection")}</b>
              <small>
                {words(
                  "采集提醒、屏幕采集与采集器下载",
                  "Alerts, screen capture and collector downloads",
                )}
              </small>
            </span>
            <Icon name="chev" />
          </SiteLink>
        </div>
      </section>
    </div>
  );
}

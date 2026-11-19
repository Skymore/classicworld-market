import { Suspense, lazy } from "react";
import { mobImg } from "/web/js/lib/format.js";
import { useWords } from "../providers";
import { embedded } from "../lib/embed";
import { Search, Icon, Loading, usePageReady } from "../components/shared";
import { SiteLink, SectionLink } from "../components/shell";

// main.tsx starts this download at boot on the home page, so the hero never
// waits for the price table's code or its market payload.
export const loadPriceTable = () => import("./prices");
const PriceTable = lazy(loadPriceTable);

export default function Home() {
  usePageReady();
  const words = useWords();
  const table = (
    <Suspense
      fallback={
        <section className="stall price-pending">
          <Loading />
        </section>
      }
    >
      <PriceTable />
    </Suspense>
  );
  // The collector's 首页 tab shows this same page; its page bar already has the search box.
  return (
    <>
      <section className="stall hero">
        <div className="hero-lead">
          <h1>
            {words("今天想买点什么？", "What are you shopping for today?")}
          </h1>
          <p>
            <SiteLink href="/web/download.html">
              {words("下载客户端", "Download collector")} →
            </SiteLink>
          </p>
        </div>
        {!embedded && <Search />}
        <nav className="portals" aria-label={words("快捷入口", "Shortcuts")}>
          <SectionLink className="portal" section="watch" href="/watch">
            <span className="p-top">
              <Icon name="starSm" />
              {words("关注", "Watch")}
            </span>
          </SectionLink>
          <SectionLink className="portal" section="dex" href="/search?kind=item">
            <span className="p-top">
              <Icon name="mob" />
              {words("图鉴", "Catalogue")}
            </span>
          </SectionLink>
          <SiteLink className="portal" href="/market" data-market-portal="">
            <span className="p-top">
              <Icon name="map" />
              {words("云逛市场", "Cloud market")}
            </span>
          </SiteLink>
        </nav>
        <SiteLink className="topic-banner" href="/hollow" data-topic="hollow">
          <img
            src="/web/images/map-thumbs/10006000.webp"
            alt=""
            width={96}
            height={60}
          />
          <span>
            <b>
              <span className="topic-new">{words("新地图", "New area")}</span>{" "}
              {words("遗忘空洞", "Forgotten Hollow")}
            </b>
            <small>
              {words(
                "11-18 开放 · 怎么进去、任务线、怪物和地图",
                "Opened Nov 18 · entrance, quests, monsters, maps",
              )}
            </small>
          </span>
          <Icon name="chev" />
        </SiteLink>
        <img
          className="deco-snail"
          src={mobImg(
            100100,
            matchMedia("(prefers-reduced-motion:reduce)").matches
              ? "stand"
              : "move",
          )}
          alt=""
        />
      </section>
      {table}
      <p className="foot home-foot">
        <img src={mobImg(100100)} alt="" width={32} height={32} />
        <SiteLink href="/contributors">
          {words("采集贡献榜", "Contributors")}
        </SiteLink>{" "}
        ·{" "}
        <SiteLink href="/traffic" data-traffic-link>
          {words("网站流量", "Website traffic")}
        </SiteLink>
      </p>
    </>
  );
}

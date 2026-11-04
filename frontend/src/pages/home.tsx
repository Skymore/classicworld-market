import { Suspense, lazy } from "react";
import { mobImg } from "/web/js/lib/format.js";
import { useWords } from "../providers";
import { embedded } from "../lib/embed";
import { Search, Icon, Loading, usePageReady } from "../components/shared";
import { SiteLink } from "../components/shell";

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
  // The collector's 价格表 tab embeds this page: only the table belongs there.
  if (embedded) return table;
  return (
    <>
      <section className="stall hero">
        <div className="hero-lead">
          <h1>
            {words("今天想买点什么？", "What are you shopping for today?")}
          </h1>
          <p>
            <SiteLink href="/web/download.html">
              {words("下载采集器", "Download collector")} →
            </SiteLink>
          </p>
        </div>
        <Search />
        <nav className="portals" aria-label={words("快捷入口", "Shortcuts")}>
          <SiteLink className="portal" href="/watch">
            <span className="p-top">
              <Icon name="starSm" />
              {words("关注", "Watch")}
            </span>
          </SiteLink>
          <SiteLink className="portal" href="/search?kind=item">
            <span className="p-top">
              <Icon name="mob" />
              {words("图鉴", "Catalogue")}
            </span>
          </SiteLink>
        </nav>
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

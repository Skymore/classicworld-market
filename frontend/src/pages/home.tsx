import { mergeShopOffers } from "/web/js/lib/quote-groups.js?v=20261025-presence-1";
import { useState } from "react";
import {
  byChange,
  byBusy,
  changeWare,
  busyWare,
} from "/web/js/lib/rows.js?v=20261022-regressions-1";
import {
  periodProduct,
  inPeriod,
} from "/web/js/lib/period.js?v=20261022-regressions-1";
import { mobImg } from "/web/js/lib/format.js";
import { useWords } from "../providers";
import { useMarketQuery } from "../lib/query";
import { OfferRow } from "../components/list-rows";
import type { Product, Sale } from "../lib/types";
import {
  Search,
  Icon,
  Loading,
  ErrorState,
  Empty,
  PeriodControl,
  usePeriod,
  usePageReady,
  num,
} from "../components/shared";
import { SiteLink } from "../components/shell";
import {
  Tabs,
  TabsList,
  TabsTrigger,
  TabsContent,
} from "../components/ui/tabs";

export default function Home() {
  usePageReady();
  const words = useWords();
  const period = usePeriod();
  const [tab, setTab] = useState("recent");
  const market = useMarketQuery<{ product_count: number; changes: Product[]; busy: Product[] }>(
    `/api/v1/market/overview?hours=${period.hours}`,
    period.ready,
  );
  const sales = useMarketQuery<{ sales: Sale[]; generated_at: number }>(
    "/api/v1/sales/recent?limit=8",
  );
  const quotes = useMarketQuery<{ listings: any[]; grouped_listings?: any[] }>(
    `/api/v1/quotes/recent?limit=8&hours=${period.hours}`,
    period.ready && tab === "quotes",
  );
  const counts = useMarketQuery<{ mobs: number; maps: number }>(
    "/api/v1/dex/counts",
    true,
    false,
  );
  const wide = matchMedia("(min-width:641px)").matches;
  const tabs = {
    recent: words("最近成交", "Recent sales"),
    quotes: words("最新报价", "Latest offers"),
    changes: words("涨跌榜", "Movers"),
    busy: words("成交最多", "Most sold"),
  };
  function content(key: string) {
    if (key === "recent") {
      if (sales.isError)
        return <ErrorState retry={() => void sales.refetch()} />;
      if (!sales.data) return <Loading />;
      const rows = sales.data.sales
        .filter((row) => inPeriod(row.time, period.hours))
        .slice(0, 8);
      return rows.length ? (
        rows.map((row: any) => (
          <OfferRow
            key={row.id}
            row={row}
            sale
            href={`/item/${row.item_id}?hours=${period.hours}`}
          />
        ))
      ) : (
        <Empty text={words("还没有成交记录。", "No sales recorded yet.")} />
      );
    }
    if (key === "quotes") {
      if (quotes.isError)
        return <ErrorState retry={() => void quotes.refetch()} />;
      if (!quotes.data) return <Loading />;
      const rows = (quotes.data.grouped_listings ?? mergeShopOffers(quotes.data.listings || []))
        .filter(
          (row: any) =>
            row.observed > 0 &&
            inPeriod(row.observed, period.hours) &&
            (row.stock == null || row.stock > 0),
        )
        .slice(0, 8);
      return rows.length ? (
        rows.map((row: any) => (
          <OfferRow
            key={row.id}
            row={row}
            href={`/item/${row.item_id}?hours=${period.hours}`}
          />
        ))
      ) : (
        <Empty
          text={words(
            "所选时段暂无在售报价。",
            "No active offers in this period.",
          )}
        />
      );
    }
    if (market.isError)
      return <ErrorState retry={() => void market.refetch()} />;
    if (!market.data) return <Loading />;
    const rows = (
      key === "changes" ? byChange((market.data.changes || []).map(periodProduct)) : byBusy((market.data.busy || []).map(periodProduct))
    ).slice(0, 8);
    return rows.length ? (
      <div
        className="contents"
        dangerouslySetInnerHTML={{
          __html: rows
            .map((row: unknown) =>
              key === "changes" ? changeWare(row, wide) : busyWare(row, wide),
            )
            .join(""),
        }}
      />
    ) : (
      <Empty />
    );
  }
  return (
    <>
      <section className="stall hero">
        <div className="hero-lead">
          <h1>
            {words("今天想买点什么？", "What are you shopping for today?")}
          </h1>
          <p>
            {words(
              "查成交价、看哪个洞有货、找哪只怪会掉。",
              "Check sale prices, find which room has stock, see which monster drops it.",
            )}{" "}
            <a href="/web/download.html">
              {words("下载采集器", "Download collector")} ↗
            </a>
          </p>
        </div>
        <Search />
        <nav className="portals" aria-label={words("快捷入口", "Shortcuts")}>
          <SiteLink className="portal" href="/prices">
            <span className="p-top">
              <Icon name="tagSm" />
              {words("价格表", "Prices")}
            </span>
            <small data-count="prices">
              {market.data
                ? words(
                    `${num(market.data.product_count)} 件物品`,
                    `${num(market.data.product_count)} items`,
                  )
                : "—"}
            </small>
          </SiteLink>
          <SiteLink className="portal" href="/search?kind=item">
            <span className="p-top">
              <Icon name="mob" />
              {words("图鉴", "Catalogue")}
            </span>
            <small
              data-count="mobs"
              title={words("物品、怪物和地图", "Items, monsters & maps")}
            >
              {words("物品·怪物·地图", "Items · Mobs · Maps")}
            </small>
          </SiteLink>
          <SiteLink className="portal" href="/search?kind=map">
            <span className="p-top">
              <Icon name="map" />
              {words("地图", "Maps")}
            </span>
            <small data-count="maps">
              {counts.data
                ? words(
                    `${num(counts.data.maps)} 张地图`,
                    `${num(counts.data.maps)} maps`,
                  )
                : words("传送和路线", "Portals & routes")}
            </small>
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
      <section className="stall tabs-well home-market">
        <div className="stall-bar">
          <h2>{words("市场概览", "Market overview")}</h2>
          <PeriodControl {...period} />
        </div>
        <Tabs value={tab} onValueChange={setTab}>
          <TabsList aria-label={words("市场概览", "Market overview")}>
            {Object.entries(tabs).map(([key, label]) => (
              <TabsTrigger key={key} value={key} data-tab={key}>
                {label}
              </TabsTrigger>
            ))}
          </TabsList>
          {Object.keys(tabs).map((key) => (
            <TabsContent
              key={key}
              value={key}
              className="react-home-tab"
              data-pane={key}
            >
              {content(key)}
              <SiteLink
                className="more"
                href={`/prices?${key === "recent" ? "tab=sales" : key === "quotes" ? "sort=recent" : key === "changes" ? "tab=changes" : "sort=sales"}&hours=${period.hours}`}
              >
                {words(
                  key === "recent"
                    ? "全部成交记录"
                    : key === "quotes"
                      ? "查看全部报价"
                      : key === "changes"
                        ? "完整涨跌榜"
                        : "按成交量看价格表",
                  "View all",
                )}{" "}
                →
              </SiteLink>
            </TabsContent>
          ))}
        </Tabs>
      </section>
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

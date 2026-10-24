import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { t } from "/web/js/lib/i18n.js";
import { meso, fullTime } from "/web/js/lib/format.js";
import {
  OFFER_HOURS,
  OFFER_PERCENTILES,
  normalizeOfferFilters,
  filterOffers,
  offerFilterTokens,
  clearOfferFilter,
} from "/web/js/lib/item-offer-filters.js?v=20261023-advanced-offers-1";
import { useUserValue } from "../lib/live";
import {
  hasBonus,
  makeLadder,
  offerGroups,
  timestamp,
} from "../lib/item-market";
import { useWords, usePreferences } from "../providers";
import {
  Icon,
  Slot,
  Price,
  Change,
  RelativeTime,
  PeriodControl,
  usePeriod,
  Search as QuickSearch,
} from "../components/shared";
import { Location } from "../components/list-rows";
import { Well, MobPicture, Secondary, useNames } from "./catalogue";
import Crafting from "../components/crafting";
import ItemTrend from "../components/item-trend";
function CollapsibleWell({
  title,
  note,
  className,
  children,
}: {
  title: string;
  note?: ReactNode;
  className: string;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(true);
  return (
    <details
      className={"well collapsible-well " + className}
      open={open}
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary className="well-h">
        <h3>{title}</h3>
        {note && <small>{note}</small>}
        <span className="well-toggle">
          <Icon name="chev" />
        </span>
      </summary>
      {children}
    </details>
  );
}
function Variant({ variant, page }: { variant: any; page: any }) {
  const words = useWords(),
    base = page.market.base_stats || [];
  const labels: Record<string, string> = {
    weapon_attack: "Weapon ATT",
    magic_attack: "Magic ATT",
    weapon_defense: "Weapon DEF",
    magic_defense: "Magic DEF",
    accuracy: "Accuracy",
    avoid: "Avoidability",
    str: "STR",
    dex: "DEX",
    int: "INT",
    luk: "LUK",
    pad: "Weapon ATT",
    mad: "Magic ATT",
    pdd: "Weapon DEF",
    mdd: "Magic DEF",
    acc: "Accuracy",
    eva: "Avoid",
    speed: "Speed",
    jump: "Jump",
    hp: "HP",
    mp: "MP",
  };
  return (
    <>
      <div className="tip-h">
        <b>
          {words(page.item.name_zh || page.item.name_en, page.item.name_en)}
        </b>
        {variant.enhancements > 0 && (
          <span className="tip-up">+{variant.enhancements}</span>
        )}
      </div>
      <ul>
        {variant.stats.map((stat: any) => {
          const reference = base.find(
              ([key]: [string, number]) => key === stat.key,
            )?.[1],
            up = stat.value > (reference ?? 0);
          return (
            <li className={up ? "up" : ""} key={stat.key}>
              <span>
                {words(stat.label || stat.key, labels[stat.key] || stat.key)}
              </span>
              <b>+{stat.value}</b>
              {reference != null && stat.value > reference && (
                <i>(+{stat.value - reference})</i>
              )}
            </li>
          );
        })}
        {!variant.stats.length && (
          <li>{words("没有解析到属性", "no stats decoded")}</li>
        )}
      </ul>
      {variant.remaining_upgrades != null && (
        <div className="tip-s">
          {words("可升级次数：", "Upgrades available: ")}
          {variant.remaining_upgrades}
        </div>
      )}
      <div className="tip-s">
        {words(page.item.name_en, page.item.name_zh || "")}
      </div>
    </>
  );
}
function Ladder({ page }: { page: any }) {
  const words = useWords();
  const ladder = useMemo(() => makeLadder(page.market), [page.market]);
  const initial = ladder.index(page.stats?.typical_low);
  const [selected, setSelected] = useState(
    initial >= 0
      ? initial
      : ladder.tiers.reduce(
          (pick, tier, i) =>
            tier.listings > (ladder.tiers[pick]?.listings || 0) ? i : pick,
          0,
        ),
  );
  if (!ladder.tiers.length)
    return (
      <p className="note">
        {words(
          "还没有挂单和成交，画不出价格梯。",
          "No listings or sales yet, so no price ladder.",
        )}
      </p>
    );
  const index = Math.min(selected, ladder.tiers.length - 1),
    tier = ladder.tiers[index],
    stock = ladder.tiers
      .slice(0, index + 1)
      .reduce((sum, tier) => sum + tier.listings, 0),
    points = page.market.sale_points || [],
    above = points.filter(
      (point: any) => Math.floor(point.price) > (tier.hi ?? Infinity),
    ).length,
    pct = points.length ? Math.round((above * 100) / points.length) : 0,
    maxStock = Math.max(...ladder.tiers.map((tier) => tier.listings)),
    maxCount = Math.max(...ladder.grid.flat());
  const dates: { date: string }[] = page.market.days || [];
  const label = (tier: any) =>
    tier.hi == null
      ? `${tier.lo >= 10000 ? meso(tier.lo) : tier.lo}+`
      : tier.lo === 0
        ? `< ${tier.hi + 1}`
        : tier.lo === tier.hi
          ? String(tier.hi)
          : tier.lo >= 10000 &&
              tier.lo % 1000 === 0 &&
              (tier.hi + 1) % 1000 === 0
            ? `${meso(tier.lo)}–${meso(tier.hi + 1)}`
            : `${tier.lo}–${tier.hi}`;
  return (
    <>
      <p className="ladder-read" data-read={index}>
        {tier.hi == null ? (
          <>
            {words("不限价：观察到 ", "Any price: ")}
            <b>{stock}</b>
            {words(" 条挂单", " observed listings")}
          </>
        ) : (
          <>
            {words("出价 ≤ ", "Bid ≤ ")}
            <b>{tier.hi.toLocaleString()}</b>
            {words("：观察到 ", ": ")}
            <b>{stock}</b>
            {words(" 条挂单；", " observed listings; ")}
            {!points.length ? (
              words("近 7 天没有成交记录", "no sales in the last 7 days")
            ) : (
              <>
                {words("近 7 天 ", "")}
                <b>{pct}%</b>
                {words(" 的成交比这个价贵", " of 7-day sales paid more")}
                <span
                  className={
                    "v " + (pct >= 65 ? "" : pct >= 35 ? "mid" : "high")
                  }
                >
                  {pct >= 65
                    ? words("好价，能买", "good price, buy")
                    : pct >= 35
                      ? words("正常价", "normal price")
                      : words("偏贵，可以等", "pricey, can wait")}
                </span>
              </>
            )}
          </>
        )}
      </p>
      <div className="ladder">
        <div className="rung-h">
          <span className="l">{words("挂单", "Listed")}</span>
          <span className="c">{words("价格", "price")}</span>
          <span className="r">
            {dates.map(({ date }, i) => (
              <time
                key={date}
                dateTime={date}
                title={date}
                data-ladder-date={date}
                className={i === dates.length - 1 ? "rung-latest" : undefined}
              >
                <small>
                  {Number(date.slice(5, 7))}
                  {words("月", "/")}
                </small>
                <b>{Number(date.slice(8, 10))}</b>
              </time>
            ))}
          </span>
        </div>
        {ladder.tiers
          .map((tier, i) => ({ tier, i }))
          .reverse()
          .map(({ tier, i }) => (
            <button
              className={
                "rung " +
                (i === index ? "sel " : "") +
                (ladder.index(page.stats?.typical) === i ? "med" : "")
              }
              type="button"
              data-tier={i}
              aria-pressed={i === index}
              key={i}
              onClick={() => setSelected(i)}
            >
              <span className="rung-l">
                {tier.listings}
                <i
                  className={
                    "f" +
                    Math.round((tier.listings / Math.max(1, maxStock)) * 20)
                  }
                />
              </span>
              <span className="rung-p">{label(tier)}</span>
              <span className="rung-r">
                {ladder.grid[i].map((count: number, j: number) => (
                  <span key={j}>
                    {count > 0 && (
                      <i
                        className={
                          "d" +
                          Math.round(
                            5 + 11 * Math.sqrt(count / Math.max(1, maxCount)),
                          )
                        }
                        title={words(`${count} 笔`, `${count} sales`)}
                      />
                    )}
                  </span>
                ))}
              </span>
            </button>
          ))}
      </div>
      <div className="ladder-foot">
        <span>
          <i />
          {words(
            "方块越大，当天这个价位成交越多",
            "bigger square = more sales at that price that day",
          )}
          {page.market.days[0] &&
            words(
              `（${page.market.days[0].date.slice(5).replace("-", "/")} 起 7 天）`,
              ` (7 days from ${page.market.days[0].date.slice(5).replace("-", "/")})`,
            )}
        </span>
        {page.stats?.typical != null && (
          <span>
            <i className="tri" />
            {words("成交中位所在档", "tier of the typical sale")}
          </span>
        )}
        <span>{words("点一档看能不能买", "tap a tier to check a bid")}</span>
      </div>
    </>
  );
}
function Verdict({ page }: { page: any }) {
  const words = useWords(),
    market = page.stats?.typical,
    npc = page.npc_offers.length
      ? Math.min(...page.npc_offers.map((offer: any) => offer.price))
      : null,
    kills =
      page.droppers[0]?.rate_pct > 0
        ? Math.max(1, Math.round(100 / page.droppers[0].rate_pct))
        : null;
  let title = "",
    reason = "";
  if (page.unit === "set") {
    title = words("按组参考", "Per-set reference");
    reason =
      market != null
        ? words(
            `市场 ${meso(market)}/组；不与 NPC 单个报价直接比较`,
            `market ${meso(market)} per set; NPC each-price is not directly comparable`,
          )
        : words("暂无每组成交价", "No per-set sale price yet");
  } else if (
    market != null &&
    !page.market.listings.some(
      (row: any) => Date.now() / 1000 - timestamp(row.seen_at) < 48 * 3600,
    )
  ) {
    title = words("历史价格参考", "Historical price only");
    reason = words("暂无近期报价", "No recent offers");
  } else if (npc != null && (market == null || npc < market)) {
    title = words("去 NPC 买", "Buy from an NPC");
    reason =
      market != null
        ? words(
            `NPC ${meso(npc)}/个，比市场 ${meso(market)}/个 便宜`,
            `NPC ${meso(npc)} each, market ${meso(market)}`,
          )
        : words(
            `NPC ${meso(npc)}/个，市场还没有成交价`,
            `NPC ${meso(npc)} each, no market sales yet`,
          );
  } else if (kills != null && (kills <= 3 || market == null)) {
    title = words("可以自己打", "Farm it");
    reason =
      market != null
        ? words(
            `平均 ${kills} 只怪就出 1 个；市场 ${meso(market)}/个`,
            `about 1 in ${kills} kills; market ${meso(market)} each`,
          )
        : words(
            `市场还没有成交价；平均 ${kills} 只怪出 1 个`,
            `no market sales yet; about 1 in ${kills} kills`,
          );
  } else if (market != null && kills != null) {
    title = words("建议直接买", "Just buy it");
    reason = words(
      `市场 ${meso(market)}/个；自己打平均 ${kills} 只怪才出 1 个`,
      `market ${meso(market)} each; farming takes about ${kills} kills per drop`,
    );
  } else if (market != null) {
    title = words("只能在市场买", "Market only");
    reason = words(`市场 ${meso(market)}/个`, `market ${meso(market)} each`);
  } else {
    title = words("暂时没有来源", "No known source");
    reason = words(
      "市场和图鉴里都还没有这件物品的来源",
      "Neither the market nor the dex has a source yet",
    );
  }
  return (
    <div className="verdict">
      <b>{words("打还是买", "Farm or buy")}</b>
      <strong>{title}</strong>
      <small>{reason}</small>
    </div>
  );
}
export default function Item({ page }: { page: any }) {
  const words = useWords(),
    name = useNames(),
    { language } = usePreferences(),
    route = useLocation(),
    navigate = useNavigate(),
    period = usePeriod();
  const item = page.item,
    market = page.market,
    stats = page.stats,
    equipment = Math.floor(item.id / 1000000) === 1;
  const [watch, saveWatch] = useUserValue("watchlist", "[]"),
    [sort, saveSort] = useUserValue("market.offerSort", "price"),
    [raw, saveFilters] = useUserValue("market.offerFilters", "{}");
  const [tab, setTab] = useState("ladder"),
    [more, setMore] = useState<Set<string>>(new Set()),
    [channels, setChannels] = useState<Record<string, boolean>>({}),
    [bonus, setBonus] = useState(false),
    [offersOpen, setOffersOpen] = useState<Set<string>>(new Set()),
    [filterOpen, setFilterOpen] = useState(false),
    [draft, setDraft] = useState<any>({}),
    [, tick] = useState(0);
  const dialog = useRef<HTMLDialogElement>(null),
    opener = useRef<HTMLButtonElement>(null);
  const filters = useMemo(() => {
    try {
      return normalizeOfferFilters({
        ...JSON.parse(raw),
        ...(!equipment ? { equipment: "all" } : {}),
      });
    } catch {
      return normalizeOfferFilters();
    }
  }, [raw, equipment]);
  const tokens = offerFilterTokens(filters, language === "en");
  const rows = useMemo(
    () =>
      market.listings.map((row: any, i: number) => ({
        ...row,
        key: JSON.stringify([
          row.shop,
          row.channel,
          row.room,
          row.variant?.id,
          row.unit_price,
          row.seen_at,
        ]),
        price: row.unit_price,
        observed: timestamp(row.seen_at),
        isEquipment: equipment,
        hasStats: !!row.variant,
        bonus: hasBonus(row.variant, market.base_stats || []),
        index: i,
      })),
    [market, equipment],
  );
  const filtered = filterOffers(rows, sort, filters),
    preview = filterOffers(rows, sort, draft);
  const groups = offerGroups(filtered.rows, false);
  const flat = [...filtered.rows].sort(
    (a, b) =>
      b.observed - a.observed ||
      a.unit_price - b.unit_price ||
      a.key.localeCompare(b.key),
  );
  const ids = useMemo<any[]>(() => {
    try {
      const value = JSON.parse(watch);
      return Array.isArray(value) ? value : [];
    } catch {
      return [];
    }
  }, [watch]);
  const watched = ids.some((id) => id === item.id || id?.item_id === item.id);
  useEffect(() => {
    const at = timestamp(market.as_of);
    if (at)
      document.dispatchEvent(
        new CustomEvent("market-freshness", { detail: at }),
      );
  }, [market]);
  useEffect(() => {
    const timer = setInterval(() => tick((old) => old + 1), 30000);
    return () => clearInterval(timer);
  }, []);
  useEffect(() => {
    if (
      period.ready &&
      new URLSearchParams(route.search).get("hours") !== period.hours
    ) {
      const params = new URLSearchParams(route.search);
      params.set("hours", period.hours);
      navigate(route.pathname + "?" + params, { replace: true });
    }
  }, [period.ready, period.hours, route.pathname]);
  useEffect(() => {
    if (filterOpen) {
      setDraft({ ...filters });
      dialog.current?.showModal();
      opener.current?.setAttribute("aria-expanded", "true");
    } else if (dialog.current?.open) dialog.current.close();
  }, [filterOpen]);
  const show = (key: string) => setMore((old) => new Set([...old, key]));
  const range = (
    <>
      {stats ? (
        <>
          {stats.typical_low != null && stats.typical_high != null && (
            <>
              {words("常见 ", "usual ")}
              <b>
                <Price value={stats.typical_low} />–
                <Price value={stats.typical_high} />
              </b>{" "}
              ·{" "}
            </>
          )}
          {period.hours === "all" ? words("全部 ", "All time ") : "72h "}
          <b>{stats.sales_24h}</b>
          {words(" 笔 · 在售 ", " sales · listed ")}
          <b>{stats.listings_count}</b>
          {words(" 条挂单", " listings")}
        </>
      ) : (
        words("市场数据暂无", "No market data yet")
      )}
    </>
  );
  function quote(row: any, recent = false) {
    const stale = Date.now() / 1000 - row.observed > 48 * 3600,
      content = (
        <>
          <span className="lshop">
            {equipment && (
              <span className="offer-chevron" aria-hidden="true">
                ›
              </span>
            )}
            <span>{row.shop}</span>
          </span>
          <span className="lroom">
            {recent
              ? (row.channel == null
                  ? words("频道未知", "Channel ?")
                  : "CH " + row.channel) + " · "
              : ""}
            {row.room != null
              ? words(`${row.room}洞`, `room ${row.room}`)
              : words("洞未知", "room ?")}
          </span>
          <span className="lp">
            <Price value={row.unit_price} />
          </span>
          <span
            className="lq"
            title={words("库存数量，未知时显示 —", "Stock; — means unknown")}
          >
            {row.stock != null ? "×" + row.stock : "—"}
          </span>
          <span className="la">
            <RelativeTime at={row.observed} />
          </span>
        </>
      );
    return equipment ? (
      <details
        key={row.key}
        className={"listing-offer " + (stale ? "stale" : "")}
        data-quote={row.key}
        data-offer={row.key}
        data-observed={row.observed}
        data-unit-price={row.unit_price}
        data-bonus={row.bonus ? "1" : "0"}
        open={offersOpen.has(row.key)}
        onToggle={(event) => {
          const opened = event.currentTarget.open;
          setOffersOpen((old) => {
            if (old.has(row.key) === opened) return old;
            const next = new Set(old);
            opened ? next.add(row.key) : next.delete(row.key);
            return next;
          });
        }}
      >
        <summary className="lrow">{content}</summary>
        <div className="offer-body">
          {row.variant ? (
            <div className="tip">
              <Variant variant={row.variant} page={page} />
            </div>
          ) : (
            <p className="note">{words("暂无属性", "Stats unavailable")}</p>
          )}
          <p className="fnote">
            {words("最近观察：", "Last observed: ")}
            <time data-local-time={row.observed}>{fullTime(row.observed)}</time>
            {stale && " · " + words("已过期", "Outdated")}
          </p>
        </div>
      </details>
    ) : (
      <div
        key={row.key}
        className={"lrow " + (stale ? "stale" : "")}
        data-quote={row.key}
        data-observed={row.observed}
        data-unit-price={row.unit_price}
      >
        {content}
      </div>
    );
  }
  const saleList = (withShop: boolean) => (
    <>
      {market.sales.length ? (
        <>
          <div className={"sales-list " + (withShop ? "salegrid" : "")}>
            {market.sales.map((row: any, i: number) => {
              const isBonus = hasBonus(row.variant, market.base_stats || []);
              return (
                <div
                  className={"sale " + (i >= 10 ? "extra" : "")}
                  data-bonus={isBonus ? "1" : "0"}
                  hidden={bonus && !isBonus}
                  key={i}
                >
                  <span className={"evi " + row.kind}>
                    {t("evidence." + row.kind)}
                  </span>
                  <span>
                    <span className="sp">
                      <Price value={row.unit_price} />
                    </span>
                    <span className="sq">
                      {row.quantity != null
                        ? "×" + row.quantity
                        : words("数量未知", "qty unknown")}
                    </span>
                  </span>
                  <Location
                    value={{
                      channel: row.channel,
                      room: row.room,
                      text: row.observed_location,
                    }}
                  />
                  {withShop && <span className="ss">{row.shop}</span>}
                  <span className="sa">
                    <RelativeTime at={timestamp(row.detected_at)} />
                  </span>
                </div>
              );
            })}
          </div>
          {market.sales.length > 10 && (
            <button
              className="more"
              data-more="sales"
              onClick={() => show("sales")}
            >
              {words(
                `显示全部 ${market.sales.length} 条 `,
                `Show all ${market.sales.length} `,
              )}
              <Icon name="chev" />
            </button>
          )}
        </>
      ) : (
        <p className="note">
          {words(
            "还没有看到这件物品的成交。",
            "No sales of this item seen yet.",
          )}
        </p>
      )}
    </>
  );
  const variants = [
    ...new Map(
      rows
        .filter((row: any) => row.variant)
        .map((row: any) => [row.variant.id, row.variant]),
    ).values(),
  ] as any[];
  const field = (
    key: string,
    title: string,
    options?: [string, string][],
    min = 0,
  ) => (
    <label className="offer-field">
      <span>{title}</span>
      {options ? (
        <select
          data-offer-hours={key === "hours" ? "" : undefined}
          data-offer-percentile={key === "percentile" ? "" : undefined}
          name={key}
          value={draft[key] ?? "all"}
          onChange={(event) =>
            setDraft((old: any) => ({ ...old, [key]: event.target.value }))
          }
        >
          {options.map(([value, label]) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </select>
      ) : (
        <input
          type="number"
          name={key}
          min={min}
          step={key === "minStock" ? "1" : "any"}
          inputMode="decimal"
          value={draft[key] ?? ""}
          placeholder={words("不限", "Any")}
          onChange={(event) =>
            setDraft((old: any) => ({ ...old, [key]: event.target.value }))
          }
        />
      )}
    </label>
  );
  return (
    <>
      <div className="mobile-item-search">
        <QuickSearch />
      </div>
      <nav
        className="crumb on-desktop"
        aria-label={words("位置", "Breadcrumb")}
      >
        <a href="/prices">{words("价格表", "Price table")}</a>
        <Icon name="chev" />
        <span>
          {words(
            item.category,
            (
              {
                装备: "EQUIP",
                消耗品: "USE",
                装饰: "SETUP",
                其他: "ETC",
                商城物品: "CASH",
              } as Record<string, string>
            )[item.category] || item.category,
          )}
        </span>
        <Icon name="chev" />
        <span>{words(item.name_zh || item.name_en, item.name_en)}</span>
      </nav>
      <section
        className={"stall item-stall " + (bonus ? "bonus-only" : "")}
        data-item={item.id}
        data-as-of={timestamp(market.as_of)}
      >
        <div className="stall-bar">
          <h2>
            {words("物品详情", "Item")}
            <span className="on-desktop">
              {" "}
              · {words(item.name_zh || item.name_en, item.name_en)}
            </span>
          </h2>
          <span
            className="bar-meta on-desktop"
            data-fresh
            data-as-of={timestamp(market.as_of)}
            hidden={!market.as_of}
          >
            <RelativeTime at={timestamp(market.as_of)} />
          </span>
          <PeriodControl
            item
            hours={period.hours}
            choose={async (value) => {
              await period.choose(value);
              const params = new URLSearchParams(location.search);
              navigate(location.pathname + "?" + params, { replace: true });
            }}
          />
          <button
            type="button"
            className="bar-btn wide star-btn"
            data-star={item.id}
            aria-label={words("关注这件物品", "Watch this item")}
            aria-pressed={watched}
            onClick={() => {
              if (!watched && ids.length >= 100) return;
              saveWatch(
                JSON.stringify(
                  watched
                    ? ids.filter(
                        (id) => id !== item.id && id?.item_id !== item.id,
                      )
                    : [...ids, item.id],
                ),
              );
              document.dispatchEvent(new CustomEvent("watchchange"));
            }}
          >
            <span className="when-off">
              <Icon name="starO" />
              {words("关注", "Watch")}
            </span>
            <span className="when-on">
              <Icon name="starSm" />
              {words("已关注", "Watching")}
            </span>
          </button>
        </div>
        <div data-market="head">
          <div className="ihead">
            <Slot empty url={item.icon_url} size={44} />
            <div>
              <h1>{words(item.name_zh || item.name_en, item.name_en)}</h1>
              {item.name_zh &&
                item.name_en &&
                item.name_zh !== item.name_en && (
                  <div className="en">{words(item.name_en, item.name_zh)}</div>
                )}
              <div className="tags">
                <span className="tagx">
                  {words(
                    item.category,
                    (
                      {
                        装备: "EQUIP",
                        消耗品: "USE",
                        装饰: "SETUP",
                        其他: "ETC",
                        商城物品: "CASH",
                      } as Record<string, string>
                    )[item.category] || item.category,
                  )}
                </span>
                {item.subcategory && language === "zh" && (
                  <span className="tagx">{item.subcategory}</span>
                )}
                <span className="tagx">
                  {item.req_level > 0
                    ? words(`${item.req_level} 级`, `Lv. ${item.req_level}`)
                    : words("无等级限制", "No level limit")}
                </span>
                {item.is_cash && (
                  <span className="tagx">{words("商城", "Cash")}</span>
                )}
              </div>
            </div>
            <div className="iprice-d">
              <div>
                <span className="big">
                  <Price value={stats?.typical} />
                </span>
              </div>
              <div className="row">
                {stats?.typical != null
                  ? words("成交中位", "typical sale")
                  : words("还没有成交价", "no sales yet")}
                {page.unit === "set" && words(" · 每组", " · per set")}
                <Change value={stats?.change_24h} />
                {stats?.typical != null && stats.sales_24h < 5 && (
                  <span className="few">{words("样本少", "few sales")}</span>
                )}
              </div>
              <div className="row">
                {range}
                {stats && (
                  <>
                    {" "}
                    / {stats.shops_count}
                    {words(" 摊", " shops")}
                  </>
                )}
              </div>
            </div>
          </div>
          <div className="iprice">
            <span className="big">
              <Price value={stats?.typical} />
            </span>
            <span className="unit">
              {stats?.typical != null
                ? words("金币 · 成交中位", "mesos · typical sale")
                : words("还没有成交价", "no sales yet")}
              {page.unit === "set" && words(" · 每组", " · per set")}
            </span>
            <Change value={stats?.change_24h} />
            {stats?.typical != null && stats.sales_24h < 5 && (
              <span className="few">{words("样本少", "few sales")}</span>
            )}
            <span className="range">{range}</span>
          </div>
        </div>
        <div className="ibox">
          <div className="src-box">
            <CollapsibleWell
              className={"src-well " + (more.has("mobs") ? "all" : "")}
              title={words("来源", "Sources")}
              note={words("怎么拿到", "how to get it")}
            >
              <div className="sub-h">
                {words("怪物掉落", "Monster drops")}
                <small>
                  {page.droppers.length
                    ? words(
                        `${page.droppers.length} 种怪物`,
                        `${page.droppers.length} monsters`,
                      )
                    : words(
                        "图鉴里没有怪物掉落记录",
                        "no monster drops in the dex",
                      )}
                </small>
              </div>
              {page.droppers.map((drop: any, i: number) => (
                <a
                  className={
                    "mob " + (i >= 4 ? "xp " : "") + (i >= 6 ? "xd" : "")
                  }
                  href={"/mob/" + drop.mob.id}
                  key={drop.mob.id}
                >
                  <MobPicture mob={drop.mob} />
                  <span className="mob-t">
                    <b>{name(drop.mob.names)}</b>
                    {drop.mob.level != null && (
                      <span className="lv">Lv.{drop.mob.level}</span>
                    )}
                    <Secondary names={drop.mob.names} />
                    <div className="maps">
                      {drop.maps
                        .slice(0, 3)
                        .map((map: any) => name(map.names))
                        .join(" · ")}
                      {drop.maps.length > 3 &&
                        words(
                          ` 等 ${drop.maps.length} 张地图`,
                          ` and ${drop.maps.length - 3} more`,
                        )}
                      {!drop.maps.length &&
                        words("没有出现地图记录", "no maps recorded")}
                    </div>
                  </span>
                  <span className="rate">
                    {Number(drop.rate_pct).toLocaleString(undefined, {
                      maximumFractionDigits: 4,
                    })}
                    %
                  </span>
                </a>
              ))}
              {page.droppers.length > 4 && (
                <button
                  className="more on-phone"
                  data-more="mobs"
                  onClick={() => show("mobs")}
                >
                  {words(
                    `查看全部 ${page.droppers.length} 种怪物 `,
                    `All ${page.droppers.length} monsters `,
                  )}
                  <Icon name="chev" />
                </button>
              )}
              {page.droppers.length > 6 && (
                <button
                  className="more on-desktop"
                  data-more="mobs"
                  onClick={() => show("mobs")}
                >
                  {words(
                    `查看全部 ${page.droppers.length} 种怪物 `,
                    `All ${page.droppers.length} monsters `,
                  )}
                  <Icon name="chev" />
                </button>
              )}
              <div className="sub-h ruled">
                {words("NPC 商店", "NPC shops")}
              </div>
              <div className="npc">
                {page.npc_offers.map((offer: any, i: number) => (
                  <span key={i}>
                    {name(offer.npc.names) || "NPC #" + offer.npc.id}
                    {words(" 出售 ", " sells for ")}
                    <b>
                      <Price value={offer.price} />
                    </b>
                    {words(" / 个", " each")}
                    <Secondary names={offer.npc.names} />
                  </span>
                ))}
                {!page.npc_offers.length && (
                  <span className="no">
                    {words("没有 NPC 出售记录", "No NPC sells it")}
                  </span>
                )}
                {page.npc_sell != null && (
                  <span className="sell">
                    {words("卖给 NPC 只得 ", "NPCs pay ")}
                    <Price value={page.npc_sell} />
                    {words(" / 个", " each")}
                  </span>
                )}
              </div>
              <Crafting key={page.item.id} itemId={page.item.id} />
              <Verdict page={page} />
            </CollapsibleWell>
          </div>
          <div data-market="where">
            <CollapsibleWell
              className={
                "where-well " +
                (sort === "recent" ? "recent-order " : "") +
                (more.has("where") ? "all" : "")
              }
              title={words("在哪买", "Where to buy")}
              note={words(
                `${filtered.rows.length} 条挂单 · ${new Set(filtered.rows.map((row: any) => JSON.stringify([row.shop, row.channel, row.room]))).size} 摊`,
                `${filtered.rows.length} listings · ${new Set(filtered.rows.map((row: any) => JSON.stringify([row.shop, row.channel, row.room]))).size} shops`,
              )}
            >
              {!!rows.length && (
                <div className="offer-actions where-tools">
                  <label className="sortb right">
                    <span className="sr">
                      {words("报价排序", "Offer order")}
                    </span>
                    <select
                      data-offer-sort
                      value={sort}
                      title={words(
                        "时间按最近采集到报价的时间计算",
                        "Time is when an offer was last observed",
                      )}
                      onChange={(event) => saveSort(event.target.value)}
                    >
                      <option value="price">
                        {words("最低价优先", "Lowest price first")}
                      </option>
                      <option value="recent">
                        {words("最新报价优先", "Latest offers first")}
                      </option>
                    </select>
                  </label>
                  <button
                    className={
                      "offer-filter-trigger " + (tokens.length ? "on" : "")
                    }
                    ref={opener}
                    data-offer-filter-open
                    aria-haspopup="dialog"
                    aria-controls="offer-filter-dialog"
                    aria-expanded={filterOpen}
                    onClick={() => setFilterOpen(true)}
                  >
                    <Icon name="funnel" />
                    <span>{words("筛选", "Filters")}</span>
                    {tokens.length > 0 && <b>{tokens.length}</b>}
                  </button>
                </div>
              )}
              {tokens.length > 0 && (
                <div className="offer-filter-summary">
                  {tokens.map((token: any) => (
                    <button
                      type="button"
                      key={token.key}
                      data-offer-clear={token.key}
                      aria-label={words("移除：", "Remove: ") + token.label}
                      onClick={() =>
                        saveFilters(
                          JSON.stringify(clearOfferFilter(filters, token.key)),
                        )
                      }
                    >
                      {token.label} <span aria-hidden="true">×</span>
                    </button>
                  ))}
                  <button
                    className="offer-clear-all"
                    data-offer-clear="all"
                    onClick={() =>
                      saveFilters(JSON.stringify(normalizeOfferFilters()))
                    }
                  >
                    {words("清空筛选", "Clear all")}
                  </button>
                  {filtered.cap != null && (
                    <small data-offer-filter-note>
                      {words(
                        `单价 ≤ ${filtered.cap.toLocaleString("zh-CN")} · 含同价挂单`,
                        `Unit price ≤ ${filtered.cap.toLocaleString("en-US")} · includes ties`,
                      )}
                    </small>
                  )}
                </div>
              )}
              {!rows.length ? (
                <p className="note">
                  {words(
                    "最近 72 小时没有看到在售挂单。",
                    "No listings seen in the last 72 hours.",
                  )}
                </p>
              ) : !filtered.rows.length ? (
                <p className="note offer-empty" data-offer-empty role="status">
                  {words(
                    "没有符合条件的报价，请放宽筛选范围。",
                    "No offers match. Try a wider filter.",
                  )}
                </p>
              ) : sort === "recent" ? (
                <div className="recent-offers">
                  {flat.map((row) => quote(row, true))}
                </div>
              ) : (
                <>
                  <div className="legend">
                    <span>
                      <i />
                      {words(
                        "有货（数字为该洞最低价）",
                        "in stock (lowest price in the room)",
                      )}
                    </span>
                    <span>
                      <i className="best" />
                      {words("本频道最低", "cheapest in channel")}
                    </span>
                    <span>
                      <i className="stale" />
                      {words("2 天没更新", "not seen for 2 days")}
                    </span>
                  </div>
                  {groups.map((group, i) => {
                    const opened = channels[group.key] ?? i === 0;
                    return (
                      <div
                        className={
                          "cgroup " +
                          (opened ? "open " : "") +
                          (i >= 6 ? "xp " : "") +
                          (i >= 8 ? "xd" : "")
                        }
                        key={group.key}
                        data-ch-key={group.key}
                      >
                        <button
                          className="cg-head"
                          data-ch
                          aria-expanded={opened}
                          onClick={() =>
                            setChannels((old) => ({
                              ...old,
                              [group.key]: !opened,
                            }))
                          }
                        >
                          <span
                            className={
                              "chno " + (group.channel == null ? "unk" : "")
                            }
                          >
                            {group.channel == null
                              ? words("位置未知", "unknown")
                              : "CH " + group.channel}
                          </span>
                          <span className="cg-meta">
                            {words(
                              `${group.shops} 摊 · ${group.rows.length} 条挂单`,
                              `${group.shops} shops · ${group.rows.length} listings`,
                            )}
                          </span>
                          <span className="cg-min">
                            {words("最低 ", "from ")}
                            <b>
                              <Price value={group.price} />
                            </b>
                          </span>
                          <span className="caret">
                            <Icon name="caret" />
                          </span>
                        </button>
                        <div className="cg-body">
                          {group.channel != null && (
                            <div
                              className="holes"
                              aria-label={words(
                                "22 个洞的在售情况",
                                "Listings in the 22 rooms",
                              )}
                            >
                              {Array.from(
                                { length: 22 },
                                (_, index) => index + 1,
                              ).map((room) => {
                                const here = group.rows.filter(
                                    (row: any) => row.room === room,
                                  ),
                                  fresh = here.filter(
                                    (row: any) =>
                                      Date.now() / 1000 - row.observed <=
                                      48 * 3600,
                                  ),
                                  price = Math.min(
                                    ...(fresh.length ? fresh : here).map(
                                      (row: any) => row.unit_price,
                                    ),
                                  ),
                                  stale = here.length > 0 && !fresh.length;
                                return (
                                  <span
                                    className={
                                      "hole " +
                                      (here.length ? "lit " : "") +
                                      (stale ? "stale " : "") +
                                      (!stale && price === group.price
                                        ? "best"
                                        : "")
                                    }
                                    key={room}
                                    title={
                                      here.length
                                        ? words(
                                            `${room} 洞 最低 ${meso(price)}`,
                                            `room ${room}, from ${meso(price)}`,
                                          )
                                        : undefined
                                    }
                                  >
                                    <i>{room}</i>
                                    {here.length > 0 && (
                                      <b>
                                        <Price value={price} />
                                      </b>
                                    )}
                                  </span>
                                );
                              })}
                            </div>
                          )}
                          <div className="cg-list">
                            {group.rows.map((row) => quote(row))}
                          </div>
                        </div>
                      </div>
                    );
                  })}
                  {groups.length > 6 && (
                    <button
                      className="more on-phone"
                      data-more="where"
                      onClick={() => show("where")}
                    >
                      {words(
                        `显示其余 ${groups.length - 6} 个频道 `,
                        `Show ${groups.length - 6} more channels `,
                      )}
                      <Icon name="chev" />
                    </button>
                  )}
                  {groups.length > 8 && (
                    <button
                      className="more on-desktop"
                      data-more="where"
                      onClick={() => show("where")}
                    >
                      {words(
                        `显示其余 ${groups.length - 8} 个频道 `,
                        `Show ${groups.length - 8} more channels `,
                      )}
                      <Icon name="chev" />
                    </button>
                  )}
                </>
              )}
            </CollapsibleWell>
          </div>
          {equipment && (
            <div data-market="equip">
              <Well
                className={"equip-well " + (more.has("equip") ? "all" : "")}
                title={words("装备属性", "Equipment stats")}
                note={
                  <>
                    {words(
                      `${variants.length} 种在售`,
                      `${variants.length} on sale`,
                    )}
                    {!!variants.length && (
                      <button
                        className={"toggle right " + (bonus ? "on" : "")}
                        data-bonus-only
                        aria-pressed={bonus}
                        onClick={() => setBonus(!bonus)}
                      >
                        <i />
                        {words("只看有加成属性", "bonus stats only")}
                      </button>
                    )}
                  </>
                }
              >
                {variants.length ? (
                  <>
                    <div className="tips">
                      {variants.map((variant: any, i: number) => {
                        const offers = rows.filter(
                            (row: any) => row.variant?.id === variant.id,
                          ),
                          cheapest = offers.reduce(
                            (pick: any, row: any) =>
                              row.unit_price < pick.unit_price ? row : pick,
                            offers[0],
                          );
                        return (
                          <div
                            className={"tip " + (i >= 3 ? "extra" : "")}
                            key={variant.id}
                            data-bonus={
                              hasBonus(variant, market.base_stats) ? "1" : "0"
                            }
                          >
                            <Variant variant={variant} page={page} />
                            <div className="tip-f">
                              {words("最低 ", "from ")}
                              <b>
                                <Price value={cheapest.unit_price} />
                              </b>{" "}
                              ·{" "}
                              {words(
                                `${offers.length} 件`,
                                `${offers.length} listed`,
                              )}{" "}
                              · <Location value={cheapest} />
                            </div>
                          </div>
                        );
                      })}
                    </div>
                    {variants.length > 3 && (
                      <button
                        className="more"
                        data-more="equip"
                        onClick={() => show("equip")}
                      >
                        {words(
                          `显示全部 ${variants.length} 件 `,
                          `Show all ${variants.length} `,
                        )}
                        <Icon name="chev" />
                      </button>
                    )}
                  </>
                ) : (
                  <p className="note">
                    {words(
                      "最近 72 小时没有看到带属性的在售装备。",
                      "No listed instance with decoded stats in the last 72 hours.",
                    )}
                  </p>
                )}
              </Well>
            </div>
          )}
          <div data-market="tabs">
            <section
              className={"well tabs-well " + (more.has("sales") ? "all" : "")}
            >
              <div className="tabs" role="tablist">
                {[
                  ["ladder", "价格梯", "Ladder"],
                  ["trend", "走势", "Trend"],
                  ["sales", "最近成交", "Sales"],
                ].map(([key, zh, en]) => (
                  <button
                    type="button"
                    className={
                      "tab " +
                      (tab === key ? "on " : "") +
                      (key === "sales" ? "on-phone" : "")
                    }
                    role="tab"
                    aria-selected={tab === key}
                    data-tab={key}
                    key={key}
                    onClick={() => setTab(key)}
                  >
                    {words(zh, en)}
                    {key === "sales" && " " + market.sales.length}
                  </button>
                ))}
              </div>
              <div
                className="pane"
                data-pane="ladder"
                hidden={tab !== "ladder"}
              >
                <Ladder page={page} />
              </div>
              <div className="pane" data-pane="trend" hidden={tab !== "trend"}>
                <ItemTrend days={market.days} />
              </div>
              <div className="pane" data-pane="sales" hidden={tab !== "sales"}>
                {saleList(false)}
              </div>
            </section>
          </div>
          <div className="on-desktop" data-market="sales">
            <Well
              className={"sales-well " + (more.has("sales") ? "all" : "")}
              title={words("最近成交", "Recent sales")}
              note={words(
                `${market.sales.length} 条 · 新的在前`,
                `${market.sales.length} · newest first`,
              )}
            >
              {saleList(true)}
            </Well>
          </div>
        </div>
        <dialog
          id="offer-filter-dialog"
          className="offer-filter-dialog"
          ref={dialog}
          aria-labelledby="offer-filter-title"
          onClose={() => {
            setFilterOpen(false);
            opener.current?.focus({ preventScroll: true });
          }}
          onClick={(event) => {
            if (event.target === event.currentTarget) {
              const rect = event.currentTarget.getBoundingClientRect();
              if (
                event.clientX < rect.left ||
                event.clientX > rect.right ||
                event.clientY < rect.top ||
                event.clientY > rect.bottom
              )
                setFilterOpen(false);
            }
          }}
        >
          <form
            className="offer-filter-form"
            onSubmit={(event) => {
              event.preventDefault();
              saveFilters(JSON.stringify(normalizeOfferFilters(draft)));
              setFilterOpen(false);
            }}
          >
            <header className="offer-filter-head">
              <div>
                <h3 id="offer-filter-title">
                  {words("筛选报价", "Filter offers")}
                </h3>
                <p>
                  {words(
                    "组合条件，找到合适的报价",
                    "Combine conditions to find the right offer",
                  )}
                </p>
              </div>
              <button
                type="button"
                data-offer-close
                autoFocus
                aria-label={words("关闭筛选", "Close filters")}
                onClick={() => setFilterOpen(false)}
              >
                ×
              </button>
            </header>
            <div className="offer-filter-body">
              <fieldset>
                <legend>{words("时间与价格", "Time and price")}</legend>
                <div className="offer-field-grid">
                  {field(
                    "hours",
                    words("报价时间", "Last observed"),
                    OFFER_HOURS.map((value: string) => [
                      value,
                      value === "all"
                        ? words("全部时间", "Any time")
                        : value === "168"
                          ? words("最近 7 天", "Last 7 days")
                          : words(
                              `最近 ${value} 小时`,
                              `Last ${value} ${value === "1" ? "hour" : "hours"}`,
                            ),
                    ]),
                  )}
                  {field(
                    "percentile",
                    words("价格百分位", "Price percentile"),
                    OFFER_PERCENTILES.map((value: string) => [
                      value,
                      value === "all"
                        ? words("全部价格", "Any price")
                        : words(`最低 ${value}%`, `Lowest ${value}%`),
                    ]),
                  )}
                  {field(
                    "minPrice",
                    words("最低单价（金币）", "Min unit price (mesos)"),
                  )}
                  {field(
                    "maxPrice",
                    words("最高单价（金币）", "Max unit price (mesos)"),
                  )}
                </div>
                <p className="offer-field-hint">
                  {words(
                    "百分位按本物品全部挂单的单价计算，临界同价挂单一起保留。",
                    "Percentiles use all offers for this item; ties at the cutoff are included.",
                  )}
                </p>
              </fieldset>
              <fieldset>
                <legend>{words("库存与属性", "Stock and stats")}</legend>
                <div className="offer-field-grid">
                  {field("stock", words("库存信息", "Stock information"), [
                    ["all", words("全部库存", "Any stock")],
                    ["known", words("仅库存已知", "Known stock only")],
                    ["unknown", words("仅库存未知", "Unknown stock only")],
                  ])}
                  {field(
                    "minStock",
                    words("最低库存数量", "Minimum stock"),
                    undefined,
                    1,
                  )}
                  {equipment &&
                    field(
                      "equipment",
                      words("装备实际属性", "Captured equipment stats"),
                      [
                        ["all", words("全部属性", "Any stats")],
                        ["captured", words("已采集实际属性", "Stats captured")],
                        [
                          "missing",
                          words("未采集实际属性", "Stats not captured"),
                        ],
                        ["bonus", words("只看有加成属性", "Bonus stats only")],
                      ],
                    )}
                </div>
              </fieldset>
            </div>
            <footer className="offer-filter-foot">
              <p data-offer-preview role="status" aria-live="polite">
                {preview.cap == null
                  ? words(
                      "所有条件同时生效，排序方式不影响筛选。",
                      "All conditions apply together, regardless of sort order.",
                    )
                  : words(
                      `价格百分位上限：单价 ${preview.cap.toLocaleString("zh-CN")}，含同价挂单。`,
                      `Percentile cutoff: unit price ${preview.cap.toLocaleString("en-US")}, including ties.`,
                    )}
              </p>
              <div>
                <button
                  type="button"
                  className="btn"
                  data-offer-reset
                  onClick={() => setDraft(normalizeOfferFilters())}
                >
                  {words("重置条件", "Reset filters")}
                </button>
                <button type="submit" className="btn primary" data-offer-apply>
                  {words(
                    `显示 ${preview.rows.length} 条报价`,
                    `Show ${preview.rows.length} offers`,
                  )}
                </button>
              </div>
            </footer>
          </form>
        </dialog>
      </section>
    </>
  );
}

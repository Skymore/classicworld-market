import { mergeShopOffers } from "/web/js/lib/quote-groups.js?v=20261025-presence-1";
import { useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { t } from "/web/js/lib/i18n.js";
import { meso, fullTime } from "/web/js/lib/format.js";
import { equipmentSummary } from "/web/js/lib/equipment-summary.js?v=20261029-critical-1";
import {
  normalizeOfferFilters,
  filterOffers,
  offerFilterTokens,
  clearOfferFilter,
  EQUIPMENT_STATS,
} from "/web/js/lib/item-offer-filters.js?v=20261029-critical-1";
import { useUserValue } from "../lib/live";
import { useProvidePageContext } from "../lib/assistant";
import {
  hasBonus,
  groupEquipmentVariants,
  mainStat,
  makeLadder,
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
import { Location, OfferRow } from "../components/list-rows";
import { SiteLink } from "../components/shell";
import OfferFilterDialog from "../components/offer-filters";
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
// Short stat names, as in the offer rows (物攻 / 魔防 / 力 ...).
const STAT_SHORT: Record<string, [string, string]> = {
  critical_rate: ["暴击率", "Critical Rate"], critical_damage: ["暴击伤害", "Critical Damage"],
  weapon_attack: ["物攻", "ATK"], pad: ["物攻", "ATK"], magic_attack: ["魔攻", "M.ATK"], mad: ["魔攻", "M.ATK"],
  weapon_defense: ["物防", "DEF"], pdd: ["物防", "DEF"], magic_defense: ["魔防", "M.DEF"], mdd: ["魔防", "M.DEF"],
  str: ["力", "STR"], dex: ["敏", "DEX"], int: ["智", "INT"], luk: ["运", "LUK"], hp: ["HP", "HP"], mp: ["MP", "MP"],
  accuracy: ["命中", "ACC"], acc: ["命中", "ACC"], avoid: ["回避", "AVOID"], eva: ["回避", "AVOID"],
  speed: ["移速", "Speed"], jump: ["跳跃", "Jump"],
};
const DEFENCE = ["weapon_defense", "magic_defense", "pdd", "mdd"];
const STAT_ORDER = [
  "critical_rate", "critical_damage",
  "weapon_attack", "magic_attack", "str", "dex", "int", "luk", "hp", "mp",
  "accuracy", "avoid", "speed", "jump", "weapon_defense", "magic_defense",
];
// "62 (+7)": the value without a plus sign, and how far it is from the item's base value.
function StatValue({ stat, base }: { stat: any; base: number | undefined }) {
  if (!stat) return <span className="attr-none">—</span>;
  const range = stat.maxValue > stat.value;
  const diff = !range && base ? stat.value - base : 0;
  return (
    <>
      <span className={stat.value > (base ?? 0) ? "up" : ""}>
        {stat.value}
        {range && `–${stat.maxValue}`}
      </span>
      {diff !== 0 && <small>({diff > 0 ? "+" : "−"}{Math.abs(diff)})</small>}
    </>
  );
}
function Variant({ variant, page }: { variant: any; page: any }) {
  const words = useWords(),
    base = page.market.base_stats || [];
  const labels: Record<string, string> = {
    critical_rate: "Critical Rate",
    critical_damage: "Critical Damage",
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
        <Slot empty url={page.item.icon_url} size={28} />
        <b>
          {words(page.item.name_zh || page.item.name_en, page.item.name_en)}
        </b>
        {(variant.maxEnhancements ?? variant.enhancements) > 0 && (
          <span className="tip-up">
            +{variant.enhancements}
            {variant.maxEnhancements > variant.enhancements && `–${variant.maxEnhancements}`}
          </span>
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
              <b>
                +{stat.value}
                {stat.maxValue > stat.value && `–${stat.maxValue}`}
              </b>
              {reference != null &&
                stat.value > reference &&
                !(stat.maxValue > stat.value) && (
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
    </>
  );
}
function Ladder({ page, onPrice }: { page: any; onPrice?: (max: number) => void }) {
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
          "还没有挂单和成交，画不出价格分布。",
          "No listings or sales yet, so no price bands.",
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
  // Round bounds read 2.5K–5K (up to, not including, 5K); other bounds stay exact.
  const isRound = (value: number) => (value >= 1e6 ? value % 1e5 === 0 : value >= 1000 && value % 100 === 0);
  const round = (value: number) => (isRound(value) ? meso(value) : String(value));
  const label = (tier: any) =>
    tier.hi == null
      ? `${round(tier.lo)}+`
      : tier.lo === 0
        ? `< ${round(tier.hi + 1)}`
        : tier.lo === tier.hi
          ? String(tier.hi)
          : isRound(tier.lo) && isRound(tier.hi + 1)
            ? `${round(tier.lo)}–${round(tier.hi + 1)}`
            : `${tier.lo}–${tier.hi}`;
  return (
    <>
      <p className="ladder-read" data-read={index}>
        {tier.hi == null ? (
          <>
            {words("不限价：在售 ", "Any price: ")}
            <b>{stock}</b>
            {words(" 条", " listed")}
          </>
        ) : (
          <>
            {"≤ "}
            <b>{tier.hi.toLocaleString()}</b>
            {words("：在售 ", ": ")}
            <b>{stock}</b>
            {words(" 条 · ", " listed · ")}
            {!points.length ? (
              words("近 7 天没有成交", "no sales in 7 days")
            ) : (
              <>
                {words("近 7 天 ", "")}
                <b>{pct}%</b>
                {words(" 的成交更贵", " of 7-day sales paid more")}
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
            {onPrice && (
              <button type="button" className="ladder-apply" data-ladder-price={tier.hi} onClick={() => onPrice(tier.hi as number)}>
                {words("只看这些报价", "Show these offers")}
              </button>
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
          {words("每日成交", "daily sales")}
        </span>
        {page.stats?.typical != null && (
          <span>
            <i className="tri" />
            {words("成交中位", "typical sale")}
          </span>
        )}
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
            `市场 ${meso(market)}/组`,
            `market ${meso(market)} per set`,
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
    [watchSettings, saveWatchSettings] = useUserValue("watchlist_settings", "{}"),
    [sort, saveSort] = useUserValue("market.offerSort", "price"),
    [showExpired, saveShowExpired] = useUserValue(`item.showExpired.${item.id}`, "true"),
    [attributesOpen, saveAttributesOpen] = useUserValue("item.attributesOpen", "false"),
    [raw, saveFilters] = useUserValue(`item.offerFilters.${item.id}`, "{}");
  const [tab, setTab] = useState("ladder"),
    [more, setMore] = useState<Set<string>>(new Set()),
    [offersOpen, setOffersOpen] = useState<Set<string>>(new Set()),
    [filterOpen, setFilterOpen] = useState(false),
    [maxDraft, setMaxDraft] = useState(""),
    [, tick] = useState(0);
  const opener = useRef<HTMLButtonElement>(null);
  const itemHead = useRef<HTMLDivElement>(null);
  const [compactHead, setCompactHead] = useState(false);
  useEffect(() => {
    const head = itemHead.current;
    if (!head) return;
    const siteHeader = document.querySelector(".dhead");
    let observer: IntersectionObserver;
    const observe = () => {
      observer?.disconnect();
      const top = siteHeader?.getBoundingClientRect().height || 0;
      setCompactHead(head.getBoundingClientRect().bottom <= top);
      observer = new IntersectionObserver(
        ([entry]) => setCompactHead(entry.boundingClientRect.bottom <= top),
        { rootMargin: `-${top}px 0px 0px 0px` },
      );
      observer.observe(head);
    };
    const resize = new ResizeObserver(observe);
    resize.observe(head);
    if (siteHeader) resize.observe(siteHeader);
    observe();
    return () => {
      observer.disconnect();
      resize.disconnect();
    };
  }, [item.id, page.selected_variant?.id]);
  const filters = useMemo(() => {
    try {
      return normalizeOfferFilters({
        ...JSON.parse(raw),
        ...(!equipment ? { equipment: "all", stats: [] } : {}),
      });
    } catch {
      return normalizeOfferFilters();
    }
  }, [raw, equipment]);
  useEffect(() => setMaxDraft(filters.maxPrice == null ? "" : String(filters.maxPrice)), [filters.maxPrice]);
  const tokens = offerFilterTokens(filters, language === "en");
  const rows = useMemo(
    () =>
      mergeShopOffers(
        [...market.listings, ...(market.expired_listings || [])].map((row: any, i: number) => ({
          ...row,
          item_id: item.id,
          key: JSON.stringify([
            row.shop_key,
            row.slot ?? i,
            row.invalidated_at,
            row.shop,
            row.channel,
            row.room,
            row.variant?.id,
            row.unit_price,
            row.seen_at,
          ]),
          price: row.unit_price,
          unit_basis: page.unit === "set" ? "set" : row.unit_basis,
          observed: timestamp(row.seen_at),
          isEquipment: equipment,
          hasStats: !!row.variant,
          bonus: hasBonus(row.variant, market.base_stats || []),
          index: i,
        })),
      ),
    [market, equipment, item.id, page.unit],
  );
  const filtered = filterOffers(
    showExpired === "false" ? rows.filter((row: any) => !row.invalidated_at) : rows,
    sort,
    filters,
  );
  const saleKeys = new Map<string, number>();
  const sales = filterOffers(
    market.sales.map((row: any) => {
      const identity = JSON.stringify([
        row.detected_at,
        row.shop,
        row.unit_price,
        row.quantity,
        row.variant?.id,
        row.channel,
        row.room,
      ]);
      const occurrence = saleKeys.get(identity) || 0;
      saleKeys.set(identity, occurrence + 1);
      return {
        ...row,
        key: identity + ":" + occurrence,
        price: row.unit_price,
        observed: timestamp(row.detected_at),
        stock: NaN,
        isEquipment: equipment,
        hasStats: !!row.variant,
        bonus: hasBonus(row.variant, market.base_stats || []),
      };
    }),
    sort,
    { ...filters, stock: "all", minStock: null },
  ).rows;
  const selectedVariant = page.selected_variant;
  useEffect(() => {
    window.scrollTo(0, 0);
  }, [selectedVariant?.id]);
  const itemHref = (variant?: any) => {
    const params = new URLSearchParams(route.search);
    params.delete("variant");
    if (variant) params.set("variant", String(variant.id));
    return route.pathname + (params.size ? "?" + params : "");
  };
  // One list for both orders: cheapest first (newer first on ties), or newest first.
  const cheapest = [...filtered.rows].sort(
    (a, b) =>
      a.unit_price - b.unit_price ||
      b.observed - a.observed ||
      a.key.localeCompare(b.key),
  );
  const flat = [...filtered.rows].sort(
    (a, b) =>
      b.observed - a.observed ||
      a.unit_price - b.unit_price ||
      a.key.localeCompare(b.key),
  );
  // Slots of one shop visit with the same price and the same parsed stats look
  // identical in the list, so show them as one row with the combined stock.
  const sameGear = (sorted: any[]) => {
    if (!equipment) return sorted;
    const out: any[] = [],
      at = new Map<string, number>();
    for (const row of sorted) {
      const key =
        row.variant?.id == null || !row.shop_key || !row.visit_id
          ? null
          : JSON.stringify([row.shop_key, row.visit_id, row.unit_price, row.invalidated_at ?? null, row.variant.id]);
      const index = key == null ? undefined : at.get(key);
      if (index == null) {
        if (key != null) at.set(key, out.length);
        out.push(row);
        continue;
      }
      const first = out[index];
      out[index] = {
        ...first,
        merged_count: (first.merged_count || 1) + (row.merged_count || 1),
        stock:
          Number.isFinite(first.stock) && Number.isFinite(row.stock)
            ? first.stock + row.stock
            : null,
      };
    }
    return out;
  };
  const list = sameGear(sort === "recent" ? flat : cheapest),
    moreKey = sort === "recent" ? "recent" : "where",
    firstPage = matchMedia("(min-width:641px)").matches ? 50 : 20,
    firstAttributes = 6,
    active = filtered.rows.filter((row: any) => !row.invalidated_at),
    activeShops = new Set(active.map((row: any) => JSON.stringify([row.shop, row.channel, row.room]))).size;
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
      (new URLSearchParams(route.search).get("hours") || "72") !== period.hours
    ) {
      const params = new URLSearchParams(route.search);
      params.set("hours", period.hours);
      navigate(route.pathname + "?" + params, { replace: true });
    }
  }, [period.ready, period.hours, route.pathname]);
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
          {words(" 笔", " sales")}
          {stats.lowest_ask != null && (
            <>
              {words(" · 在售最低 ", " · lowest ask ")}
              <b>
                <Price value={stats.lowest_ask} />
              </b>
            </>
          )}
        </>
      ) : (
        words("市场数据暂无", "No market data yet")
      )}
    </>
  );
  function quote(row: any, recent = false) {
    const stale = Date.now() / 1000 - row.observed > 48 * 3600,
      content = (
        <OfferRow
          plain
          hideIdentity
          row={{
            ...row,
            id: row.key,
            item_id: item.id,
            location: { channel: row.channel, room: row.room },
            equipment: row.variant
              ? { ...row.variant, status: "candidate" }
              : undefined,
          }}
        />
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
        <summary className="variant-summary">
          {content}
          <span className="variant-chevron" aria-hidden="true">
            ›
          </span>
        </summary>
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
        className={"variant-offer " + (stale ? "stale" : "")}
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
      {sales.length ? (
        <>
          <div className={"sales-list " + (withShop ? "salegrid" : "")}>
            {sales.map((row: any, i: number) => {
              const key = row.key;
              const summary = equipment
                ? equipmentSummary(
                    {
                      item_id: item.id,
                      equipment: row.variant
                        ? { ...row.variant, status: "candidate" }
                        : null,
                    },
                    language === "en",
                  )
                : "";
              return (
                <div
                  className={
                    "sale " +
                    (equipment ? "sale-with-stats " : "") +
                    (i >= 10 ? "extra" : "")
                  }
                  data-sale-stats={equipment ? "" : undefined}
                  key={key}
                >
                  <span
                    className={"evi " + row.kind}
                    title={
                      row.merged_count > 1
                        ? words(
                            `同店 ${row.merged_count} 格合计`,
                            `${row.merged_count} slots in one shop`,
                          )
                        : undefined
                    }
                  >
                    {t("evidence." + row.kind)}
                  </span>
                  <span className="sale-price">
                    <span className="sp">
                      <Price value={row.unit_price} />
                    </span>
                    <span className="sq">
                      {row.quantity != null
                        ? "×" + row.quantity
                        : row.merged_count > 1
                          ? words(`${row.merged_count} 格`, `${row.merged_count} slots`)
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
                  {equipment ? (
                    <span className="sale-meta">
                      <span className="sale-time">
                        <RelativeTime at={timestamp(row.detected_at)} />
                      </span>
                      <span
                        className="sale-equipment"
                        title={summary || undefined}
                      >
                        {summary ||
                          (row.variant
                            ? words("暂无可显示属性", "No decoded stats")
                            : words("属性未采集", "Stats not captured"))}
                      </span>
                    </span>
                  ) : (
                    <span className="sa">
                      <RelativeTime at={timestamp(row.detected_at)} />
                    </span>
                  )}
                </div>
              );
            })}
          </div>
          {sales.length > 10 && (
            <button
              className="more"
              data-more="sales"
              onClick={() => show("sales")}
            >
              {words(
                `显示全部 ${sales.length} 条 `,
                `Show all ${sales.length} `,
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
  const main = mainStat(item.id, item.req_job_mask);
  // Stat sets: highest main stat first (cheapest on ties); without a main stat, cheapest first.
  const lowest = (offers: any[]) => Math.min(...offers.map((row: any) => row.unit_price));
  const mainOf = (variant: any) => variant.stats.find((stat: any) => stat.key === main)?.value ?? -1;
  const variants = groupEquipmentVariants(filtered.rows).sort(
    (a: any, b: any) =>
      (main ? mainOf(b.variant) - mainOf(a.variant) : 0) || lowest(a.offers) - lowest(b.offers),
  );
  // Attribute table: only stats that differ between sets get a column; shared ones go in the header.
  const baseStat = (key: string) =>
    (market.base_stats || []).find(([stat]: [string, number]) => stat === key)?.[1] as number | undefined;
  const statText = (variant: any, key: string) => {
    const stat = variant.stats.find((row: any) => row.key === key);
    return stat ? `${stat.value}${stat.maxValue > stat.value ? `–${stat.maxValue}` : ""}` : null;
  };
  const presentKeys = [...new Set<string>(variants.flatMap(({ variant }: any) => variant.stats.map((stat: any) => stat.key)))].sort(
    (a, b) => (a === main ? -1 : b === main ? 1 : 0) || STAT_ORDER.indexOf(a) - STAT_ORDER.indexOf(b),
  );
  const differs = (text: (variant: any) => unknown) => new Set(variants.map(({ variant }: any) => text(variant))).size > 1;
  const single = variants.length <= 1;
  const attrKeys = presentKeys.filter((key) => single || differs((variant) => statText(variant, key)));
  const attrSlots = variants.some(({ variant }: any) => variant.remaining_upgrades != null) &&
    (single || differs((variant) => variant.remaining_upgrades));
  const attrShared = single
    ? []
    : [
        ...presentKeys
          .filter((key) => !attrKeys.includes(key))
          .map((key) => `${words(...(STAT_SHORT[key] || [key, key]))} ${statText(variants[0].variant, key)}`),
        ...(!attrSlots && variants[0]?.variant.remaining_upgrades != null
          ? [words(`可升 ${variants[0].variant.remaining_upgrades}`, `${variants[0].variant.remaining_upgrades} slots`)]
          : []),
      ];
  // Stat columns stay compact on the left; the price column takes the spare width.
  const attrColumns = `repeat(${attrKeys.length + (attrSlots ? 1 : 0)}, minmax(52px, max-content)) minmax(64px, 1fr) minmax(44px, max-content)`;
  // Quick filters: thresholds of the main stat seen on sale, and the usual prices.
  const mainSeen = main
    ? rows
        .filter((row: any) => !row.invalidated_at)
        .map((row: any) => row.variant?.stats?.find((stat: any) => stat.key === main)?.value)
        .filter((value: any) => Number.isFinite(value) && value > 0)
    : [];
  // Thresholds above the item's base value (else the median), at most five spread evenly.
  const mainBase =
    (market.base_stats || []).find(([key]: [string, number]) => key === main)?.[1] ??
    [...mainSeen].sort((a, b) => a - b)[Math.floor(mainSeen.length / 2)] ??
    0;
  const mainAbove = [...new Set<number>(mainSeen)].filter((value) => value > mainBase).sort((a, b) => a - b);
  const mainValues = (
    mainAbove.length <= 5
      ? mainAbove
      : [0, 1, 2, 3, 4].map((step) => mainAbove[Math.round((step * (mainAbove.length - 1)) / 4)])
  ).map((value) => ({ value, count: mainSeen.filter((seen: number) => seen >= value).length }));
  const mainMin = filters.stats.find((row: any) => row.stat === main)?.min ?? null;
  const quickPrices = (
    [
      [stats?.typical_low, words("常见低价", "usual low")],
      [stats?.typical, words("成交中位", "typical")],
    ] as [number | null | undefined, string][]
  ).filter(
    ([value], index, all) => value != null && all.findIndex(([other]) => other === value) === index,
  ) as [number, string][];
  const selectedTags: string[] = selectedVariant
    ? [
        ...selectedVariant.stats
          .filter(
            (stat: any) => !["weapon_defense", "magic_defense", "pdd", "mdd"].includes(stat.key) && stat.value > 0,
          )
          .map(
            (stat: any) => {
              const base = (market.base_stats || []).find(([key]: [string, number]) => key === stat.key)?.[1];
              const diff = base ? stat.value - base : 0;
              return (
                words(...(STAT_SHORT[stat.key] || [stat.label || stat.key, stat.key])) +
                ` ${stat.value}` +
                (diff ? ` (${diff > 0 ? "+" : "−"}${Math.abs(diff)})` : "")
              );
            },
          ),
        ...(selectedVariant.remaining_upgrades != null
          ? [words("可升 ", "Slots ") + selectedVariant.remaining_upgrades]
          : []),
      ]
    : [];
  const itemName = words(item.name_zh || item.name_en, item.name_en || item.name_zh);
  useProvidePageContext({
    kind: "item",
    id: item.id,
    label: [itemName, ...selectedTags].join(" · ").slice(0, 120),
    icon: item.icon_url || undefined,
  });
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
        {selectedVariant ? (
          <>
            <SiteLink data-no-preview href={itemHref()}>
              {words(item.name_zh || item.name_en, item.name_en)}
            </SiteLink>
            <Icon name="chev" />
            <span>{words("属性详情", "Stat detail")}</span>
          </>
        ) : (
          <span>{words(item.name_zh || item.name_en, item.name_en)}</span>
        )}
      </nav>
      <section
        className="stall item-stall"
        data-item={item.id}
        data-as-of={timestamp(market.as_of)}
      >
        <div className="stall-bar">
          <h2>
            {selectedVariant
              ? words("属性详情", "Stat detail")
              : words("物品详情", "Item")}
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
              // A new watch starts with no price and no alert.
              if (!watched)
                try {
                  const settings = JSON.parse(watchSettings) || {};
                  if (!settings[item.id])
                    saveWatchSettings(
                      JSON.stringify({ ...settings, [item.id]: { cap: null, notify: false } }),
                    );
                } catch {}
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
        <div data-market="head" ref={itemHead}>
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
                {item.subcategory &&
                  language === "zh" &&
                  !item.subcategory.includes(item.category) &&
                  !item.category.includes(item.subcategory) && (
                    <span className="tagx">{item.subcategory}</span>
                  )}
                {item.req_level > 0 && (
                  <span className="tagx">{words(`${item.req_level} 级`, `Lv. ${item.req_level}`)}</span>
                )}
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
                {stats?.change_24h != null && <Change value={stats.change_24h} />}
                {stats?.typical != null && stats.sales_24h < 5 && (
                  <span className="few">{words("样本少", "few sales")}</span>
                )}
              </div>
              <div className="row">
                {range}
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
            {stats?.change_24h != null && <Change value={stats.change_24h} />}
            {stats?.typical != null && stats.sales_24h < 5 && (
              <span className="few">{words("样本少", "few sales")}</span>
            )}
            <span className="range">{range}</span>
          </div>
        </div>
        <div className="item-summary-sticky">
          {compactHead && (
            <div
              className="item-summary"
              role="region"
              aria-label={words("物品摘要", "Item summary")}
            >
              <Slot empty url={item.icon_url} size={28} />
              <b
                className="item-summary-name"
                title={words(item.name_zh || item.name_en, item.name_en)}
              >
                {words(item.name_zh || item.name_en, item.name_en)}
              </b>
              <span
                className="item-summary-price"
                title={
                  stats?.typical != null
                    ? words("金币 · 成交中位", "mesos · typical sale")
                    : words("还没有成交价", "no sales yet")
                }
              >
                <Price value={stats?.typical} />
                {page.unit === "set" && <small>{words("/组", "/set")}</small>}
              </span>
            </div>
          )}
        </div>
        <div className="ibox">
          <div data-market="where">
            <CollapsibleWell
              className={
                "where-well " +
                (sort === "recent" ? "recent-order " : "") +
                (more.has(sort === "recent" ? "recent" : "where") ? "all" : "")
              }
              title={words("在哪买", "Where to buy")}
              note={words(
                `${active.length} 条挂单 · ${activeShops} 摊`,
                `${active.length} listings · ${activeShops} shops`,
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
                  {equipment && (
                    <button
                      type="button"
                      className={"offer-filter-trigger attr-trigger " + (selectedVariant ? "on" : "")}
                      data-attributes-open
                      aria-expanded={attributesOpen === "true"}
                      aria-controls="item-attributes"
                      onClick={() => saveAttributesOpen(attributesOpen === "true" ? "false" : "true")}
                    >
                      <span>{words("属性", "Stats")}</span>
                      {!selectedVariant && <small>{variants.length}</small>}
                      <Icon name="caret" />
                    </button>
                  )}
                  <label className="show-expired-toggle">
                    <input
                      type="checkbox"
                      checked={showExpired !== "false"}
                      onChange={(event) => saveShowExpired(String(event.target.checked))}
                    />
                    {words("显示已失效", "Show expired")}
                  </label>
                </div>
              )}
              {!!rows.length && (
                <div className="quick-filters">
                  {main && mainValues.length > 0 && (
                    <div className="qf-group" data-main-stat={main}>
                      <span className="qf-label" id="qf-main">{words(...STAT_SHORT[main])}</span>
                      {/* One threshold at a time: picking another replaces it, picking it again clears it. */}
                      <span className="qf-options" role="radiogroup" aria-labelledby="qf-main">
                      {mainValues.map(({ value, count }) => (
                        <button
                          type="button"
                          key={value}
                          className={"chip " + (mainMin === value ? "on" : "")}
                          data-main-min={value}
                          role="radio"
                          aria-checked={mainMin === value}
                          onClick={() =>
                            saveFilters(
                              JSON.stringify(
                                normalizeOfferFilters({
                                  ...filters,
                                  stats: [
                                    ...filters.stats.filter((row: any) => row.stat !== main),
                                    ...(mainMin === value ? [] : [{ stat: main, min: value }]),
                                  ],
                                }),
                              ),
                            )
                          }
                        >
                          <span>
                            ≥{value} <small>{words(`${count} 件`, `${count}`)}</small>
                          </span>
                        </button>
                      ))}
                      </span>
                    </div>
                  )}
                  <div className="qf-group" data-quick-prices>
                    <span className="qf-label" id="qf-price">{words("价格", "Price")}</span>
                    {quickPrices.length > 0 && <span className="qf-options" role="radiogroup" aria-labelledby="qf-price">
                    {quickPrices.map(([value, label]) => (
                      <button
                        type="button"
                        key={value}
                        className={"chip " + (filters.maxPrice === value ? "on" : "")}
                        data-quick-price={value}
                        role="radio"
                        aria-checked={filters.maxPrice === value}
                        onClick={() =>
                          saveFilters(
                            JSON.stringify(
                              normalizeOfferFilters({ ...filters, maxPrice: filters.maxPrice === value ? null : value }),
                            ),
                          )
                        }
                      >
                        <span>
                          ≤<Price value={value} /> <small>{label}</small>
                        </span>
                      </button>
                    ))}
                    </span>}
                    <input
                      type="number"
                      min="0"
                      inputMode="numeric"
                      data-quick-max
                      aria-label={words("最高单价", "Max unit price")}
                      placeholder={words("最高价", "Max price")}
                      value={maxDraft}
                      onChange={(event) => setMaxDraft(event.target.value)}
                      onKeyDown={(event) => {
                        if (event.key === "Enter") event.currentTarget.blur();
                      }}
                      onBlur={() => {
                        const value = maxDraft.trim() === "" ? null : Number(maxDraft);
                        if (value !== filters.maxPrice && (value === null || (Number.isFinite(value) && value >= 0)))
                          saveFilters(JSON.stringify(normalizeOfferFilters({ ...filters, maxPrice: value })));
                      }}
                    />
                  </div>
                </div>
              )}
              {equipment && !!rows.length && attributesOpen === "true" && (
                <div className="attr-panel" id="item-attributes">
                  <div className="attr-head">
                    <span>
                      {selectedVariant
                        ? words("已选这组属性", "This stat set")
                        : words(`${variants.length} 种属性在售`, `${variants.length} stat sets on sale`)}
                      {attrShared.length > 0 && words(` · 都是 ${attrShared.join(" · ")}`, ` · all ${attrShared.join(" · ")}`)}
                    </span>
                    <button
                      type="button"
                      className={"toggle right " + (filters.equipment === "bonus" ? "on" : "")}
                      data-bonus-only
                      aria-pressed={filters.equipment === "bonus"}
                      onClick={() =>
                        saveFilters(
                          JSON.stringify(
                            normalizeOfferFilters({
                              ...filters,
                              equipment: filters.equipment === "bonus" ? "all" : "bonus",
                            }),
                          ),
                        )
                      }
                    >
                      <i aria-hidden="true" />
                      {words("只看有加成", "Bonus only")}
                    </button>
                  </div>
                  {variants.length > 0 && (
                    <div className="attr-table" style={{ "--attr-cols": attrColumns } as CSSProperties}>
                      <div className="attr-tr attr-th">
                        {attrKeys.map((key) => (
                          <span key={key}>{words(...(STAT_SHORT[key] || [key, key]))}</span>
                        ))}
                        {attrSlots && <span>{words("可升", "Slots")}</span>}
                        <span>{words("最低", "From")}</span>
                        <span>{words("件数", "Listed")}</span>
                      </div>
                      {variants.slice(0, more.has("equip") ? undefined : firstAttributes).map(({ key, variant, offers }) => (
                        <SiteLink
                          key={key}
                          href={itemHref(selectedVariant || variant)}
                          className="attr-tr"
                          data-equipment-group={key}
                          data-bonus={hasBonus(variant, market.base_stats || []) ? "1" : "0"}
                          aria-current={selectedVariant ? "true" : undefined}
                        >
                          {attrKeys.map((stat) => (
                            <span key={stat}>
                              <StatValue
                                stat={variant.stats.find((row: any) => row.key === stat)}
                                base={baseStat(stat)}
                              />
                            </span>
                          ))}
                          {attrSlots && <span>{variant.remaining_upgrades ?? "—"}</span>}
                          <span className="attr-price">
                            <Price value={lowest(offers)} />
                          </span>
                          <span className="attr-count">
                            {words(
                              `${offers.reduce((n: number, row: any) => n + (row.merged_count || 1), 0)} 件`,
                              `${offers.reduce((n: number, row: any) => n + (row.merged_count || 1), 0)}`,
                            )}
                          </span>
                        </SiteLink>
                      ))}
                    </div>
                  )}
                  {!more.has("equip") && variants.length > firstAttributes && (
                    <button className="more" data-more="equip" onClick={() => show("equip")}>
                      {words(`显示全部 ${variants.length} 种 `, `Show all ${variants.length} `)}
                      <Icon name="chev" />
                    </button>
                  )}
                  {!variants.length && (
                    <p className="note">
                      {words(
                        rows.some((row: any) => row.variant) ? "没有符合条件的装备。" : "最近 72 小时没有看到带属性的在售装备。",
                        rows.some((row: any) => row.variant)
                          ? "No equipment matches these filters."
                          : "No listed instance with decoded stats in the last 72 hours.",
                      )}
                    </p>
                  )}
                </div>
              )}
              {(tokens.length > 0 || selectedVariant) && (
                <div className="offer-filter-summary">
                  {selectedVariant && (
                    <SiteLink
                      data-no-preview
                      className="attr-chip"
                      href={itemHref()}
                      data-selected-attributes
                      data-all-attributes
                      aria-label={words("移除属性：", "Remove stat set: ") + selectedTags.join(" · ")}
                    >
                      {selectedTags.join(" · ") || words("已选属性", "Stat set")}{" "}
                      <span aria-hidden="true">×</span>
                    </SiteLink>
                  )}
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
                  {tokens.length > 0 && <button
                    className="offer-clear-all"
                    data-offer-clear="all"
                    onClick={() =>
                      saveFilters(JSON.stringify(normalizeOfferFilters()))
                    }
                  >
                    {words("清空筛选", "Clear all")}
                  </button>}
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
              ) : (
                <div className="recent-offers" data-offer-list>
                  {list
                    .slice(0, more.has(moreKey) ? undefined : firstPage)
                    .map((row) => quote(row, sort === "recent"))}
                  {list.length > firstPage && (
                    <button
                      className="more"
                      data-more={moreKey}
                      onClick={() => show(moreKey)}
                    >
                      {words(
                        `显示全部 ${list.length} 条报价 `,
                        `Show all ${list.length} offers `,
                      )}
                      <Icon name="chev" />
                    </button>
                  )}
                </div>
              )}
            </CollapsibleWell>
          </div>
          <div data-market="tabs">
            <section
              className={"well tabs-well " + (more.has("sales") ? "all" : "")}
            >
              <div className="tabs" role="tablist">
                {[
                  ["ladder", "价格分布", "Price bands"],
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
                    {key === "sales" && " " + sales.length}
                  </button>
                ))}
              </div>
              <div
                className="pane"
                data-pane="ladder"
                hidden={tab !== "ladder"}
              >
                <Ladder
                  page={page}
                  onPrice={(max) => {
                    saveFilters(JSON.stringify(normalizeOfferFilters({ ...filters, maxPrice: max })));
                    // Phones show the list above the tabs: bring it back into view.
                    if (matchMedia("(max-width:640px)").matches)
                      document.querySelector('[data-market="where"]')?.scrollIntoView({ block: "start" });
                  }}
                />
              </div>
              <div className="pane" data-pane="trend" hidden={tab !== "trend"}>
                <ItemTrend days={market.days} listingDays={market.listing_days} />
              </div>
              <div className="pane" data-pane="sales" hidden={tab !== "sales"}>
                {saleList(false)}
              </div>
            </section>
          </div>
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
          <div className="on-desktop" data-market="sales">
            <Well
              className={"sales-well " + (more.has("sales") ? "all" : "")}
              title={words("最近成交", "Recent sales")}
              note={words(
                `${sales.length} 条 · 新的在前`,
                `${sales.length} · newest first`,
              )}
            >
              {saleList(true)}
            </Well>
          </div>
        </div>
        <OfferFilterDialog
          open={filterOpen}
          onClose={() => {
            setFilterOpen(false);
            opener.current?.focus({ preventScroll: true });
          }}
          onApply={(value) => saveFilters(JSON.stringify(value))}
          filters={filters}
          rows={rows}
          equipment={equipment}
        />
      </section>
    </>
  );
}

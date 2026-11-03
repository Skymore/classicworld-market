import { Fragment, useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { compileSearch, searchText } from "/web/js/lib/search.js";
import { watchIds, toggleWatch } from "/web/js/lib/watch-ids.js";
import { periodProduct } from "/web/js/lib/period.js?v=20261022-regressions-1";
import {
  priceFilterTokens,
  clearPriceFilter,
  equipmentTypes,
  matchesEquipmentType,
} from "/web/js/lib/price-filters.js?v=20261023-equipment-filters-1";
import { spark } from "/web/js/lib/spark.js?v=20261022-regressions-1";
import { usePreferences, useWords } from "../providers";
import { useMarketQuery } from "../lib/query";
import { useUserValue } from "../lib/live";
import { craftableIds, estimateCraft } from "/web/js/lib/crafting.js";
import type { Market, Product, CraftCatalog, CraftPrice } from "../lib/types";
import {
  categories,
  jobs,
  levelRanges,
  sortFields,
  sortLabels,
  canReverseSort,
  readPriceState,
  priceUrl,
  compareProducts,
  defaultDirection,
  type PriceState,
  type Sort,
} from "../lib/price-state";
import {
  Icon,
  ItemNames,
  Slot,
  Price,
  RelativeTime,
  SampleBadge,
  WindowChange,
  thinChange,
  PeriodControl,
  usePeriod,
  Loading,
  ErrorState,
  Empty,
  num,
} from "../components/shared";
import { SiteLink } from "../components/shell";
import { OfferRow } from "../components/list-rows";
import Sales from "./sales";
import { Button } from "../components/ui/button";
import {
  Tabs,
  TabsList,
  TabsTrigger,
  TabsContent,
} from "../components/ui/tabs";
import {
  Dialog,
  DialogTrigger,
  DialogContent,
  DialogTitle,
  DialogDescription,
  DialogClose,
} from "../components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
} from "../components/ui/dropdown-menu";

// Equipment any job can wear: the catalogue leaves its job list empty.
const sharedEquipment = (row: Product) =>
  row.category === "装备" &&
  (!(row.jobs || []).length || (row.jobs || []).includes("通用"));
// Columns of the desktop table, for full-width heading rows.
const DESKTOP_COLUMNS = 8;
// Rows rendered at first and added each time the list end comes near.
const PAGE_ROWS = 20;

/** The price table under the home page hero; its state lives in the URL. */
export default function PriceTable() {
  const words = useWords();
  const { language } = usePreferences();
  const en = language === "en";
  const route = useLocation();
  const navigate = useNavigate();
  const period = usePeriod();
  const state = useMemo(() => readPriceState(route.search), [route.search]);
  const [queryDraft, setQueryDraft] = useState(state.q);
  const composing = useRef(false);
  useEffect(() => {
    if (!composing.current) setQueryDraft(state.q);
  }, [state.q]);
  const recordMode =
    state.tab === "all" && ["recent", "lastsale"].includes(state.sort);
  const recordKind = state.sort === "lastsale" ? "sales" : "quotes";
  const records = useMarketQuery<{ records: any[] }>(
    `/api/v1/market/records?kind=${recordKind}&hours=${period.hours}`,
    period.ready && recordMode,
  );
  const recordMap = useMemo(
    () =>
      new Map((records.data?.records || []).map((row) => [row.item_id, row])),
    [records.data],
  );
  const deferredQuery = useDeferredValue(state.q);
  const market = useMarketQuery<Market>(
    `/api/v1/market?view=list&hours=${period.hours}`,
    period.ready,
  );
  const drops = useMarketQuery<{ item_ids: number[] }>(
    "/api/v1/dex/dropped-items",
    true,
    false,
  );
  const [watched, setWatched] = useState<number[]>(watchIds);
  const crafting = useMarketQuery<CraftCatalog>(
    "/web/data/crafting.json",
    true,
    false,
  );
  const craftPrices = useMarketQuery<{ prices: CraftPrice[] }>(
    "/api/v1/crafting/prices",
    Boolean(crafting.data),
  );
  const craftable = useMemo<Set<number>>(
    () => (crafting.data ? craftableIds(crafting.data) : new Set()),
    [crafting.data],
  );
  const craftCosts = useMemo(() => {
    const costs = new Map<number, number | null>();
    if (!crafting.data || !craftPrices.data?.prices) return costs;
    const quotes = new Map(
      craftPrices.data.prices.map((row) => [row.item_id, row]),
    );
    for (const recipe of crafting.data.recipes.filter(
      (row) => row.level <= 8,
    )) {
      const value: number | null = estimateCraft(
        recipe,
        crafting.data,
        quotes,
      ).per_output;
      if (
        !costs.has(recipe.item_id) ||
        (value != null &&
          (costs.get(recipe.item_id) == null ||
            value < costs.get(recipe.item_id)!))
      )
        costs.set(recipe.item_id, value);
    }
    return costs;
  }, [crafting.data, craftPrices.data]);
  const [limit, setLimit] = useState(PAGE_ROWS);
  const sentinel = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const update = () => setWatched(watchIds());
    document.addEventListener("watchchange", update);
    window.addEventListener("storage", update);
    return () => {
      document.removeEventListener("watchchange", update);
      window.removeEventListener("storage", update);
    };
  }, []);
  useEffect(() => {
    const item = new URLSearchParams(route.search).get("item");
    if (/^\d{7}$/.test(item || ""))
      location.replace(
        `/item/${item}?hours=${period.hours}${en ? "&lang=en" : ""}`,
      );
  }, [route.search, period.hours, en]);
  function update(patch: Partial<PriceState>) {
    const next = { ...state, ...patch };
    navigate(route.pathname + priceUrl(next, location.search), {
      replace: true,
    });
  }
  const products = useMemo<Product[]>(
    () => market.data?.products.map(periodProduct) || [],
    [market.data],
  );
  const search = useMemo(
    () => new Map(products.map((row) => [row.item_id, searchText(row)])),
    [products],
  );
  const dropped = useMemo(
    () => (drops.data ? new Set(drops.data.item_ids) : null),
    [drops.data],
  );
  const base = useMemo(() => {
    const matches = compileSearch(deferredQuery);
    const job = jobs.find(([key]) => key === state.job)?.[1];
    const watch = new Set(watched);
    return products.filter((row) => {
      if (recordMode && !recordMap.has(row.item_id)) return false;
      if (state.craft && !craftable.has(row.item_id)) return false;
      if (
        (!state.cash && row.category === "商城物品") ||
        (!state.few && row.low_data) ||
        (state.sold && row.last_sale_at == null)
      )
        return false;
      if (
        (state.watch && !watch.has(row.item_id)) ||
        (state.drop && dropped && !dropped.has(row.item_id))
      )
        return false;
      // A job keeps its own equipment and equipment for every job (empty job list);
      // the shared ones are listed after the job's own under their own heading.
      if (
        job &&
        row.category === "装备" &&
        !sharedEquipment(row) &&
        !(row.jobs || []).includes(job)
      )
        return false;
      if (!matchesEquipmentType(row, state.type)) return false;
      if (
        ((state.lmin != null && state.lmin > 0) || state.lmax != null) &&
        !(
          row.level != null &&
          row.level >= (state.lmin || 0) &&
          (state.lmax == null || row.level <= state.lmax)
        )
      )
        return false;
      return matches(search.get(row.item_id));
    });
  }, [
    products,
    recordMode,
    recordMap,
    state.cash,
    state.few,
    state.sold,
    state.watch,
    state.craft,
    craftable,
    state.drop,
    state.job,
    state.type,
    state.lmin,
    state.lmax,
    deferredQuery,
    watched,
    dropped,
    search,
  ]);
  const rows = useMemo(() => {
    const category = categories.find(([key]) => key === state.cat)?.[1];
    let selected = category
      ? base.filter((row) => row.category === category)
      : base;
    if (state.tab === "changes")
      selected = selected
        .filter(
          (row) =>
            row.change_window != null && Math.abs(row.change_window) >= 0.5,
        )
        .sort(
          (a, b) =>
            // Changes measured on a few sales stay listed, after the reliable ones.
            Number(thinChange(a)) - Number(thinChange(b)) ||
            Math.abs(b.change_window || 0) - Math.abs(a.change_window || 0) ||
            (b.sales_window || 0) - (a.sales_window || 0),
        );
    else if (recordMode)
      selected = selected.slice().sort((a, b) => {
        const time = (id: number) => Number(recordMap.get(id)?.time || 0);
        return time(b.item_id) - time(a.item_id) || a.item_id - b.item_id;
      });
    else
      selected = selected
        .slice()
        .sort((a, b) => compareProducts(a, b, state.sort, state.dir, en));
    // With a job chosen, its own items come first and equipment for every job after.
    // Feeds of recent quotes or sales keep their time order.
    if (state.job !== "all" && !recordMode)
      selected = [
        ...selected.filter((row) => !sharedEquipment(row)),
        ...selected.filter(sharedEquipment),
      ];
    return selected;
  }, [
    base,
    state.cat,
    state.tab,
    state.sort,
    state.dir,
    state.job,
    en,
    recordMode,
    recordMap,
  ]);
  // Where the "for every job" heading goes, and how many rows it covers.
  const sharedFrom =
    state.job === "all" || recordMode ? -1 : rows.findIndex(sharedEquipment);
  const sharedCount = sharedFrom < 0 ? 0 : rows.length - sharedFrom;
  const [sharedPref, writeSharedPref] = useUserValue("prices.sharedOpen", "true");
  const sharedOpen = sharedPref !== "false";
  // Collapsed, the list stops before the shared rows and the heading closes it.
  const collapsed = sharedFrom >= 0 && !sharedOpen;
  const shown = collapsed ? Math.min(limit, sharedFrom) : limit;
  const hasMore = shown < (collapsed ? sharedFrom : rows.length);
  const sharedHead = (desktop: boolean) => {
    const label = (
      <button
        type="button"
        className="price-group-label"
        data-shared-toggle
        aria-expanded={sharedOpen}
        onClick={() => writeSharedPref(sharedOpen ? "false" : "true")}
      >
        <b>{words("全职业通用", "For every job")}</b>
        <small>{words(`${num(sharedCount)} 件`, `${num(sharedCount)} items`)}</small>
        <Icon name="caret" />
      </button>
    );
    return desktop ? (
      <tr className="price-group-head" data-shared-head key="shared-head">
        <td colSpan={DESKTOP_COLUMNS}>{label}</td>
      </tr>
    ) : (
      <div className="price-group-head" data-shared-head key="shared-head">
        {label}
      </div>
    );
  };
  useEffect(
    () => setLimit(PAGE_ROWS),
    [
      state.q,
      state.cat,
      state.job,
      state.type,
      state.sort,
      state.dir,
      state.tab,
      state.lmin,
      state.lmax,
      state.few,
      state.cash,
      state.sold,
      state.drop,
      state.watch,
      state.craft,
      period.hours,
    ],
  );
  useEffect(() => {
    const node = sentinel.current;
    if (!node || !("IntersectionObserver" in window)) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting))
          setLimit((value) => value + PAGE_ROWS);
      },
      { rootMargin: "200px" },
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, [limit, rows.length]);
  const tokens: { key: string; label: string }[] = priceFilterTokens(
    state,
    en,
    Boolean(dropped),
  );
  function clear(key: string) {
    update(clearPriceFilter(state, key));
  }
  function sort(key: Sort) {
    update({
      sort: key,
      dir:
        state.sort === key && canReverseSort(key)
          ? state.dir === "asc"
            ? "desc"
            : "asc"
          : defaultDirection(key),
    });
  }
  const sortLabel = words(sortLabels[state.sort][0], sortLabels[state.sort][1]);
  const itemHref = (row: Product) =>
    `/item/${row.item_id}?hours=${period.hours}`;
  const craftBadge = (row: Product) =>
    craftable.has(row.item_id) ? (
      <span
        className="craft-label"
        title={words(
          "按购买配方材料加手续费估算；详情可查看配方和原料加工方案。",
          "Estimated ingredient purchases plus crafting fee. Item details include recipes and a raw-material route.",
        )}
      >
        <span className="craft-tag">{words("可制作", "CRAFTABLE")}</span>
        {craftCosts.has(row.item_id) && (
          <small className="craft-cost">
            {craftCosts.get(row.item_id) == null ? (
              words("缺材料价格", "Missing material prices")
            ) : (
              <>
                {words("约 ", "~")}
                <Price value={craftCosts.get(row.item_id)} />
              </>
            )}
          </small>
        )}
      </span>
    ) : null;
  const unit = (row: Product) =>
    row.unit_basis === "set" ? (
      <small className="unit">{words("/组", "/set")}</small>
    ) : null;
  const watchButton = (row: Product) => (
    <button
      type="button"
      className={"star " + (watched.includes(row.item_id) ? "on" : "")}
      data-star={row.item_id}
      aria-pressed={watched.includes(row.item_id)}
      aria-label={words(
        `关注 ${row.name_zh || row.name_en}`,
        `Watch ${row.name_en || row.name_zh}`,
      )}
      onClick={() => toggleWatch(row.item_id)}
    >
      <Icon name={watched.includes(row.item_id) ? "starSm" : "starO"} />
    </button>
  );
  const direction = state.dir === "asc" ? "↑" : "↓";
  const showLowestAsk =
    state.tab === "all" && ["low", "recent"].includes(state.sort);
  const showLastSale = state.tab === "all" && state.sort === "lastsale";
  const mobilePriceLabel = showLowestAsk
    ? words("最低报价", "Lowest ask")
    : showLastSale
      ? words("最新成交价", "Last sale price")
      : words("成交价", "Typical sale");
  function heading(key: Sort | null, title: string, className = "") {
    return (
      <th
        className={className}
        aria-sort={
          key === state.sort
            ? state.dir === "asc"
              ? "ascending"
              : "descending"
            : undefined
        }
      >
        {key ? (
          <button
            type="button"
            className={"th-sort " + (key === state.sort ? "on" : "")}
            data-sort-key={key}
            onClick={() =>
              key === "change" ? update({ tab: "changes" }) : sort(key)
            }
          >
            {title}
            {key === state.sort && <span className="dir">{direction}</span>}
          </button>
        ) : (
          title
        )}
      </th>
    );
  }
  return (
    <section className="stall tabs-well react-prices">
      <Tabs value={state.tab} onValueChange={(tab) => update({ tab })}>
        <div className="react-price-sticky">
          <div className="stall-bar price-tabs-bar">
            <TabsList className="price-title-tabs" aria-label={words("价格表", "Prices")}>
              {[
                ["all", "全部", "All"],
                ["changes", "涨跌榜", "Movers"],
                ["sales", "成交", "Sales"],
              ].map(([key, zh, english]) => (
                <TabsTrigger value={key} key={key} data-tab={key}>
                  {words(zh, english)}
                </TabsTrigger>
              ))}
            </TabsList>
            {state.tab !== "sales" && <PeriodControl {...period} />}
          </div>
          {state.tab !== "sales" && (
            <>
              <div className="react-price-tools" data-price-tools>
                <label className="finder sm">
                  <Icon name="search" />
                  <input
                    type="search"
                    data-q
                    value={queryDraft}
                    onChange={(event) => {
                      const value = event.currentTarget.value;
                      // Keep the controlled value synchronous while the IME owns
                      // its draft; route navigation can otherwise restore old text.
                      setQueryDraft(value);
                      if (!composing.current) update({ q: value });
                    }}
                    onCompositionStart={() => {
                      composing.current = true;
                    }}
                    onCompositionEnd={(event) => {
                      composing.current = false;
                      const value = event.currentTarget.value;
                      setQueryDraft(value);
                      update({ q: value });
                    }}
                    autoComplete="off"
                    aria-label={words("搜索物品", "Search items")}
                    placeholder={words("搜索物品", "Search items")}
                  />
                </label>
                <div
                  className="cats"
                  data-cats
                  role="group"
                  aria-label={words("分类", "Categories")}
                >
                  {categories.map(([key, category, zh, english]) => (
                    <button
                      type="button"
                      key={key}
                      className={"cat " + (key === state.cat ? "on" : "")}
                      aria-pressed={key === state.cat}
                      data-cat={key}
                      onClick={() =>
                        update({
                          cat: key,
                          ...(!["all", "equip"].includes(key)
                            ? { type: "all" }
                            : {}),
                        })
                      }
                    >
                      {words(zh, english)}
                      <small>
                        {num(
                          base.filter(
                            (row) =>
                              (!category || row.category === category) &&
                              (state.tab !== "changes" ||
                                (row.change_window != null &&
                                  Math.abs(row.change_window) >= 0.5)),
                          ).length,
                        )}
                      </small>
                    </button>
                  ))}
                </div>
                <button
                  type="button"
                  className={"toggle " + (state.watch ? "on" : "")}
                  data-watch-only
                  aria-pressed={state.watch}
                  onClick={() => update({ watch: !state.watch })}
                >
                  <i />
                  {words("只看关注", "Watched only")}
                </button>
                <button
                  type="button"
                  className={"toggle " + (state.craft ? "on" : "")}
                  data-craft-only
                  aria-pressed={state.craft}
                  onClick={() => update({ craft: !state.craft })}
                >
                  <i />
                  {words("可制作", "Craftable")}
                </button>
                {state.tab !== "changes" && (
                  <span className="sortwrap">
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <button
                          type="button"
                          className="sortbtn"
                          data-sort-btn
                          aria-label={words("排序：", "Sort: ") + sortLabel}
                        >
                          <span data-sort-label>
                            {sortLabel}
                            {canReverseSort(state.sort) ? ` ${direction}` : ""}
                          </span>
                        </button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent>
                        <DropdownMenuRadioGroup value={state.sort}>
                          {sortFields.map((key) => (
                            <DropdownMenuRadioItem
                              value={key}
                              key={key}
                              data-sort={key}
                              onSelect={() => sort(key)}
                            >
                              {words(sortLabels[key][0], sortLabels[key][1])}
                              {key === state.sort &&
                                canReverseSort(key) &&
                                ` ${direction}`}
                            </DropdownMenuRadioItem>
                          ))}
                        </DropdownMenuRadioGroup>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </span>
                )}
                <Dialog>
                  <DialogTrigger asChild>
                    <button
                      type="button"
                      className={"sortbtn fbtn " + (tokens.length ? "on" : "")}
                      data-filter-btn
                      aria-label={words("筛选", "Filter")}
                    >
                      <Icon name="funnel" />
                      <span>{words("筛选", "Filter")}</span>
                      {tokens.length > 0 && (
                        <b className="fcount">{tokens.length}</b>
                      )}
                    </button>
                  </DialogTrigger>
                  <DialogContent className="price-filter-dialog">
                    <div className="stall-bar">
                      <DialogTitle>{words("筛选", "Filter")}</DialogTitle>
                    </div>
                    <DialogDescription className="ui-dialog-description">
                      {words(
                        "筛选条件会保存在网址中，刷新后继续使用。",
                        "Filters stay in the URL and survive a reload.",
                      )}
                    </DialogDescription>
                    <div className="fpanel">
                      <div className="fsec">
                        <h4>
                          {words("职业", "Job")}
                        </h4>
                        <div className="chips">
                          {jobs.map(([key, , zh, english]) => (
                            <button
                              type="button"
                              key={key}
                              className="chip"
                              data-job={key}
                              aria-pressed={state.job === key}
                              onClick={() => update({ job: key })}
                            >
                              {words(zh, english)}
                            </button>
                          ))}
                        </div>
                      </div>
                      <div className="fsec">
                        <h4>{words("装备类型", "Equipment type")}</h4>
                        <div
                          className="chips equipment-types"
                          role="group"
                          aria-label={words("装备类型", "Equipment type")}
                        >
                          {equipmentTypes.map(
                            ([key, zh, english]: string[]) => (
                              <button
                                type="button"
                                key={key}
                                className="chip"
                                data-equipment-type={key}
                                aria-pressed={state.type === key}
                                onClick={() =>
                                  update({
                                    type: key,
                                    ...(key !== "all" ? { cat: "equip" } : {}),
                                  })
                                }
                              >
                                {words(zh, english)}
                              </button>
                            ),
                          )}
                        </div>
                      </div>
                      <div className="fsec">
                        <h4>{words("需求等级", "Required level")}</h4>
                        <div className="lvrow">
                          <label>
                            {words("最低", "Min")}
                            <input
                              type="number"
                              min={0}
                              max={999}
                              data-lmin
                              value={state.lmin ?? ""}
                              onChange={(event) =>
                                update({
                                  lmin: event.target.value
                                    ? Math.min(
                                        999,
                                        Math.max(0, Number(event.target.value)),
                                      )
                                    : null,
                                })
                              }
                            />
                          </label>
                          <label>
                            {words("最高", "Max")}
                            <input
                              type="number"
                              min={0}
                              max={999}
                              data-lmax
                              value={state.lmax ?? ""}
                              onChange={(event) =>
                                update({
                                  lmax: event.target.value
                                    ? Math.min(
                                        999,
                                        Math.max(0, Number(event.target.value)),
                                      )
                                    : null,
                                })
                              }
                            />
                          </label>
                        </div>
                        <div className="chips level-presets">
                          {levelRanges.map(([lo, hi]) => (
                            <button
                              type="button"
                              key={lo}
                              className="chip"
                              data-lv={hi == null ? `${lo}+` : `${lo}-${hi}`}
                              aria-pressed={
                                state.lmin === lo && state.lmax === hi
                              }
                              onClick={() => update({ lmin: lo, lmax: hi })}
                            >
                              {hi == null ? `${lo}+` : `${lo}–${hi}`}
                            </button>
                          ))}
                        </div>
                        <p className="fnote">
                          {words(
                            "设置等级范围后，没有等级要求的物品不会显示。",
                            "Items without a required level are hidden when a level range is set.",
                          )}
                        </p>
                      </div>
                      <div className="fsec">
                        <h4>{words("显示", "Show")}</h4>
                        {[
                          ["few", "成交很少的物品", "Items with few sales"],
                          ["cash", "商城物品", "Cash items"],
                          ["sold", "只看有成交记录的物品", "With sales"],
                          ["drop", "只看怪物掉落的物品", "Monster drops"],
                          ["craft", "只看可制作的物品", "Craftable"],
                        ]
                          .filter(([key]) => key !== "drop" || dropped)
                          .map(([key, zh, english]) => (
                            <label className="filter-check" key={key}>
                              <input
                                type="checkbox"
                                data-sw={key}
                                checked={Boolean(
                                  state[key as keyof PriceState],
                                )}
                                onChange={(event) =>
                                  update({ [key]: event.target.checked })
                                }
                              />
                              {words(zh, english)}
                            </label>
                          ))}
                      </div>
                    </div>
                    <div className="ffoot">
                      <Button data-filter-reset onClick={() => clear("all")}>
                        {words("重置", "Reset")}
                      </Button>
                      <DialogClose asChild>
                        <Button variant="primary" data-apply>
                          {words(
                            `显示 ${num(rows.length)} 件`,
                            `Show ${num(rows.length)} items`,
                          )}
                        </Button>
                      </DialogClose>
                    </div>
                  </DialogContent>
                </Dialog>
              </div>
              {tokens.length > 0 && (
                <div className="active-price-filters" data-active-filters>
                  {tokens.map((token) => (
                    <button
                      key={token.key}
                      type="button"
                      data-remove-price-filter={token.key}
                      onClick={() => clear(token.key)}
                    >
                      {token.label} ×
                    </button>
                  ))}
                  <button
                    className="clear-price-filters"
                    type="button"
                    data-clear-price-filters="all"
                    onClick={() => clear("all")}
                  >
                    {words("清除筛选", "Clear filters")}
                  </button>
                </div>
              )}
            </>
          )}
          {state.tab !== "sales" && !recordMode && (
            <div className="pp-cols react-price-cols" aria-hidden="true">
              <span />
              <span>{words("物品", "Item")}</span>
              <span data-mobile-price-heading>{mobilePriceLabel}</span>
              <span>{words("区间涨跌", "Change")}</span>
            </div>
          )}
        </div>
        {["all", "changes"].map((tab) => (
          <TabsContent value={tab} key={tab} data-pane={tab}>
            {market.isError ||
            (recordMode && records.isError) ||
            (state.craft && crafting.isError) ? (
              <ErrorState
                retry={() => {
                  void market.refetch();
                  if (recordMode) void records.refetch();
                }}
              />
            ) : !market.data ||
              (recordMode && !records.data) ||
              (state.craft && !crafting.data) ? (
              <Loading />
            ) : rows.length === 0 ? (
              <>
                <Empty />
                <div className="filter-empty-action">
                  <Button
                    data-clear-price-filters="everything"
                    onClick={() => clear("everything")}
                  >
                    {words("清空搜索和筛选", "Clear search and filters")}
                  </Button>
                </div>
              </>
            ) : (
              <>
                {recordMode ? (
                  <div
                    className="price-record-list"
                    data-list={tab}
                    data-price-records={recordKind}
                  >
                    {rows.slice(0, limit).map((row) => (
                      <div className="price-record-entry" key={row.item_id}>
                        <OfferRow
                          row={recordMap.get(row.item_id)}
                          item={row}
                          sale={state.sort === "lastsale"}
                          href={itemHref(row)}
                        />
                        <span className="price-record-actions">
                          {watchButton(row)}
                        </span>
                      </div>
                    ))}
                  </div>
                ) : (
                  <>
                    <div className="react-price-mobile" data-list={tab}>
                      {rows.slice(0, shown).map((row, index) => (
                        <Fragment key={row.item_id}>
                        {index === sharedFrom && sharedHead(false)}
                        <SiteLink
                          className="prow"
                          href={itemHref(row)}
                          key={row.item_id}
                          data-item-row
                        >
                          <Slot url={row.icon_url} />
                          <span className="nm">
                            <ItemNames row={row} />
                            {craftBadge(row)}
                            {/* Phones have one price column: the other price (usually the lowest ask) goes here. */}
                            <small className="mobile-sort-value">
                              {[
                                showLowestAsk
                                  ? row.typical != null && (
                                      <span key="price">
                                        {words("成交价 ", "Sale ")}
                                        <Price value={row.typical} />
                                      </span>
                                    )
                                  : row.low != null && (
                                      <span key="price">
                                        {words("在售最低 ", "Lowest ")}
                                        <Price value={row.low} />
                                      </span>
                                    ),
                                state.tab === "all" && state.sort === "sales" && (
                                  <span key="sales">
                                    {words(
                                      `成交 ${num(row.sales_window ?? 0)} 笔`,
                                      `${num(row.sales_window ?? 0)} sales`,
                                    )}
                                  </span>
                                ),
                                state.sort === "recent" && row.last_seen && (
                                  <RelativeTime key="seen" at={row.last_seen} />
                                ),
                                showLastSale && row.last_sale_at != null && (
                                  <RelativeTime key="sold" at={row.last_sale_at} />
                                ),
                              ]
                                .filter(Boolean)
                                .flatMap((part, index) => (index ? [" · ", part] : [part]))}
                            </small>
                          </span>
                          <span className="pr quote-value">
                            <span className="quote-main">
                              <Price
                                value={
                                  showLowestAsk
                                    ? row.low
                                    : showLastSale
                                      ? row.last_sale_price
                                      : row.typical
                                }
                              />
                              {unit(row)}
                            </span>
                            {!showLowestAsk && !showLastSale && (
                              <SampleBadge row={row} />
                            )}
                          </span>
                          <WindowChange row={row} />
                        </SiteLink>
                        </Fragment>
                      ))}
                      {collapsed && !hasMore && sharedHead(false)}
                    </div>
                    <div className="react-price-desktop">
                      <table className="ptable">
                        <thead>
                          <tr>
                            <th className="l c-star">
                              <span className="sr">
                                {words("关注", "Watch")}
                              </span>
                            </th>
                            {heading("name", words("物品", "Item"), "l")}
                            {heading(
                              showLastSale ? null : "price",
                              showLastSale
                                ? words("最新成交价", "Last sale price")
                                : words("成交价", "Typical sale"),
                            )}
                            {heading("change", words("区间涨跌", "Change"))}
                            {heading("low", words("最低报价", "Lowest ask"))}
                            {heading("sales", words("成交笔数", "Sales"))}
                            {heading(
                              null,
                              words("7 日走势", "7-day trend"),
                              "c-spark",
                            )}
                            {heading(
                              state.sort === "recent"
                                ? "recent"
                                : showLastSale
                                  ? "lastsale"
                                  : null,
                              state.sort === "recent"
                                ? words("最近采集", "Last observed")
                                : words("最近成交", "Last sale"),
                              "c-last",
                            )}
                          </tr>
                        </thead>
                        <tbody data-list={tab}>
                          {rows.slice(0, shown).map((row, index) => (
                            <Fragment key={row.item_id}>
                            {index === sharedFrom && sharedHead(true)}
                            <tr
                              key={row.item_id}
                              data-open={row.item_id}
                              data-item-row
                              onClick={(event) => {
                                if (
                                  !(event.target as Element).closest("a,button")
                                )
                                  location.assign(
                                    itemHref(row) + (en ? "&lang=en" : ""),
                                  );
                              }}
                            >
                              <td className="star-c l">{watchButton(row)}</td>
                              <td className="l">
                                <SiteLink className="it" href={itemHref(row)}>
                                  <Slot url={row.icon_url} />
                                  <ItemNames row={row} />
                                  {craftBadge(row)}
                                </SiteLink>
                              </td>
                              <td>
                                <span className="pr quote-value">
                                  <span className="quote-main">
                                    <Price
                                      value={
                                        showLastSale
                                          ? row.last_sale_price
                                          : row.typical
                                      }
                                    />
                                    {unit(row)}
                                  </span>
                                  {!showLastSale && <SampleBadge row={row} />}
                                </span>
                                {!showLastSale &&
                                  row.typical_low != null &&
                                  row.typical_high != null && (
                                    <span className="rg">
                                      <Price value={row.typical_low} /> –{" "}
                                      <Price value={row.typical_high} />
                                    </span>
                                  )}
                              </td>
                              <td>
                                <WindowChange row={row} />
                              </td>
                              <td>
                                <Price value={row.low} />
                              </td>
                              <td>{row.sales_window ?? 0}</td>
                              <td className="c-spark">
                                <span
                                  className="contents"
                                  dangerouslySetInnerHTML={{
                                    __html: spark(row.trend),
                                  }}
                                />
                              </td>
                              <td className="c-last">
                                <RelativeTime
                                  at={
                                    state.sort === "recent"
                                      ? row.last_seen
                                      : row.last_sale_at
                                  }
                                />
                              </td>
                            </tr>
                            </Fragment>
                          ))}
                          {collapsed && !hasMore && sharedHead(true)}
                        </tbody>
                      </table>
                    </div>
                  </>
                )}
                {(recordMode ? limit < rows.length : hasMore) && (
                  <div ref={sentinel}>
                    <button
                      type="button"
                      className="react-price-more"
                      onClick={() => setLimit((value) => value + PAGE_ROWS)}
                    >
                      {words("加载更多", "Load more")}
                    </button>
                  </div>
                )}
              </>
            )}
          </TabsContent>
        ))}
        <TabsContent value="sales" data-pane="sales" className="sales-pane">
          <div data-sales-host>
            <Sales embedded />
          </div>
        </TabsContent>
      </Tabs>
    </section>
  );
}

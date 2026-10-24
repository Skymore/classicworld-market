import { useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
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
import type { Market, Product } from "../lib/types";
import {
  categories,
  jobs,
  levelRanges,
  sortLabels,
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
  Change,
  RelativeTime,
  SampleBadge,
  PeriodControl,
  usePeriod,
  usePageReady,
  Loading,
  ErrorState,
  Empty,
  num,
} from "../components/shared";
import { SiteLink } from "../components/shell";
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

export default function Prices() {
  usePageReady();
  const words = useWords();
  const { language } = usePreferences();
  const en = language === "en";
  const route = useLocation();
  const navigate = useNavigate();
  const period = usePeriod();
  const state = useMemo(() => readPriceState(route.search), [route.search]);
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
  const [limit, setLimit] = useState(100);
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
      if (
        job &&
        row.category === "装备" &&
        !(row.jobs || []).some((value) => value === job || value === "通用")
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
    state.cash,
    state.few,
    state.sold,
    state.watch,
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
            Math.abs(b.change_window || 0) - Math.abs(a.change_window || 0) ||
            (b.sales_window || 0) - (a.sales_window || 0),
        );
    else
      selected = selected
        .slice()
        .sort((a, b) => compareProducts(a, b, state.sort, state.dir, en));
    return selected;
  }, [base, state.cat, state.tab, state.sort, state.dir, en]);
  useEffect(
    () => setLimit(100),
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
      period.hours,
    ],
  );
  useEffect(() => {
    const node = sentinel.current;
    if (!node || !("IntersectionObserver" in window)) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting))
          setLimit((value) => value + 100);
      },
      { rootMargin: "400px" },
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
        state.sort === key
          ? state.dir === "asc"
            ? "desc"
            : "asc"
          : defaultDirection(key),
    });
  }
  const label = (sortKey: Sort) =>
    words(sortLabels[sortKey][0], sortLabels[sortKey][1]);
  const itemHref = (row: Product) =>
    `/item/${row.item_id}?hours=${period.hours}`;
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
            onClick={() => sort(key)}
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
          <div className="stall-bar">
            <h1>{words("价格表", "Prices")}</h1>
            {state.tab !== "sales" && (
              <>
                <span className="bar-meta" data-meta>
                  {market.data &&
                    `${num(rows.length)} / ${num(products.length)} ${words("件", "items")}`}
                </span>
                <PeriodControl {...period} />
              </>
            )}
          </div>
          <TabsList aria-label={words("价格表", "Prices")}>
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
          {state.tab !== "sales" && (
            <>
              <div className="react-price-tools" data-price-tools>
                <label className="finder sm">
                  <Icon name="search" />
                  <input
                    type="search"
                    data-q
                    value={state.q}
                    onChange={(event) => update({ q: event.target.value })}
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
                {state.tab !== "changes" && (
                  <span className="sortwrap">
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <button
                          type="button"
                          className="sortbtn"
                          data-sort-btn
                          aria-label={
                            words("排序：", "Sort: ") + label(state.sort)
                          }
                        >
                          <Icon name="sort" />
                          <span data-sort-label>
                            {label(state.sort)} {direction}
                          </span>
                        </button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent>
                        <DropdownMenuRadioGroup
                          value={state.sort}
                          onValueChange={(value) => sort(value as Sort)}
                        >
                          {(Object.keys(sortLabels) as Sort[]).map((key) => (
                            <DropdownMenuRadioItem
                              value={key}
                              key={key}
                              data-sort={key}
                            >
                              {label(key)} {state.sort === key ? direction : ""}
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
                          <small>{words("只影响装备", "Equipment only")}</small>
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
          {state.tab !== "sales" && (
            <div className="pp-cols react-price-cols" aria-hidden="true">
              <span />
              <span>{words("物品", "Item")}</span>
              <span>{words("成交价", "Typical sale")}</span>
              <span>{words("区间涨跌", "Change")}</span>
            </div>
          )}
        </div>
        {["all", "changes"].map((tab) => (
          <TabsContent value={tab} key={tab} data-pane={tab}>
            {market.isError ? (
              <ErrorState retry={() => void market.refetch()} />
            ) : !market.data ? (
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
                <div className="react-price-mobile" data-list={tab}>
                  {rows.slice(0, limit).map((row) => (
                    <SiteLink
                      className="prow"
                      href={itemHref(row)}
                      key={row.item_id}
                      data-item-row
                    >
                      <Slot url={row.icon_url} />
                      <span className="nm">
                        <ItemNames row={row} />
                        {state.sort === "recent" && row.last_seen && (
                          <small>
                            <RelativeTime at={row.last_seen} />
                          </small>
                        )}
                      </span>
                      <span className="pr quote-value">
                        <Price value={row.typical} />
                        {unit(row)}
                        <SampleBadge row={row} />
                      </span>
                      <Change value={row.change_window} />
                    </SiteLink>
                  ))}
                </div>
                <div className="react-price-desktop">
                  <table className="ptable">
                    <thead>
                      <tr>
                        <th className="l c-star">
                          <span className="sr">{words("关注", "Watch")}</span>
                        </th>
                        {heading("name", words("物品", "Item"), "l")}
                        {heading("price", words("成交价", "Typical sale"))}
                        {heading("change", words("区间涨跌", "Change"))}
                        {heading("low", words("最低报价", "Lowest ask"))}
                        {heading("sales", words("成交笔数", "Sales"))}
                        {heading(
                          null,
                          words("7 日走势", "7-day trend"),
                          "c-spark",
                        )}
                        {heading(
                          state.sort === "recent" ? "recent" : null,
                          state.sort === "recent"
                            ? words("最近采集", "Last observed")
                            : words("最近成交", "Last sale"),
                          "c-last",
                        )}
                      </tr>
                    </thead>
                    <tbody data-list={tab}>
                      {rows.slice(0, limit).map((row) => (
                        <tr
                          key={row.item_id}
                          data-open={row.item_id}
                          data-item-row
                          onClick={(event) => {
                            if (!(event.target as Element).closest("a,button"))
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
                            </SiteLink>
                          </td>
                          <td>
                            <span className="pr quote-value">
                              <Price value={row.typical} />
                              {unit(row)}
                              <SampleBadge row={row} />
                            </span>
                            {row.typical_low != null &&
                              row.typical_high != null && (
                                <span className="rg">
                                  <Price value={row.typical_low} /> –{" "}
                                  <Price value={row.typical_high} />
                                </span>
                              )}
                          </td>
                          <td>
                            <Change value={row.change_window} />
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
                      ))}
                    </tbody>
                  </table>
                </div>
                {limit < rows.length && (
                  <div ref={sentinel}>
                    <button
                      type="button"
                      className="react-price-more"
                      onClick={() => setLimit((value) => value + 100)}
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

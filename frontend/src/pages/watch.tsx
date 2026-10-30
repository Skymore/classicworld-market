import { useQueries } from "@tanstack/react-query";
import { useLocation } from "react-router-dom";
import { SiteLink } from "../components/shell";
import WatchGroups, { sweepable, trackOnly } from "../components/watch-groups";
import {
  activeOffers,
  matchingReminders,
  watchGroups,
} from "/web/js/lib/watch-reminders.js?v=20261027-watch-groups-1";
import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { api, getJson, qs } from "/web/js/lib/api.js?v=20261022-auto-watch-2";
import { t, itemName } from "/web/js/lib/i18n.js";
import Core, {
  MAX_WATCHES,
} from "/web/js/lib/watchlist-core.js?v=20261027-watch-groups-1";
import { getSyncState, subscribeSync, userStorage } from "/web/js/lib/user-data.js";
import { sortWatchQuotes } from "/web/js/lib/quote-order.js?v=20261023-watch-cap-1";
import { useUserValue } from "../lib/live";
import { useAccount, useMarketQuery } from "../lib/query";
import { useWords } from "../providers";
import {
  Empty,
  Icon,
  ItemNames,
  Price,
  Slot,
  usePageReady,
} from "../components/shared";
import OfferFilterDialog from "../components/offer-filters";
import {
  normalizeOfferFilters,
  filterOffers,
  offerFilterTokens,
  clearOfferFilter,
} from "/web/js/lib/item-offer-filters.js?v=20261029-critical-1";
import { OfferRow } from "../components/list-rows";
import { useWatchAlerts } from "../components/watch-alerts";
import { NotificationSettings } from "../components/notification-settings";
import SweepPanel, { isRecentRun, useSweep } from "../components/sweep-panel";
import { embedded } from "../lib/embed";
import "../lib/list-copy";
import "./watch.css";
// Cheapest offers shown per item before "show more".
const PER_ITEM = 5;
// The scanner client embeds this page in a loopback-only frame.
const inScanner = (() => {
  try {
    return (
      window.top !== window.self &&
      ["localhost", "127.0.0.1"].includes(location.hostname)
    );
  } catch {
    return false;
  }
})();
export default function Watch() {
  usePageReady();
  const words = useWords();
  const route = useLocation();
  const {
    ids,
    settings,
    writeList,
    writeSettings,
    saveIds,
    shared,
    grouped,
    reference,
    personal,
    captureState,
  } = useWatchAlerts();
  const [sort, writeSort] = useUserValue("watch.offerSort", "price"),
    [collapsed, writeCollapsed] = useUserValue("watch.listCollapsed", "false"),
    [rawFilters, writeFilters] = useUserValue("watch.offerFilters", "{}"),
    [groupPref, writeGroupPref] = useUserValue("watch.groupByItem", "true");
  const profile = useAccount().data;
  // Signed-in accounts get the Items | Sweep tabs. The collector's embedded page
  // (mode "collector") has no sweep API: its sweep tab only edits the rules.
  const sweepTab = Boolean(profile?.signed_in);
  const rulesOnly = profile?.mode === "collector";
  const sweep = useSweep(sweepTab && !rulesOnly);
  const [panelTab, writePanelTab] = useUserValue("watch.panelTab", "items");
  const tab = sweepTab && panelTab === "sweep" ? "sweep" : "items";
  const sweepWatches = useMemo(
    () =>
      ids
        .map((id) => ({
          item_id: id,
          limit: settings[id]?.buyLimit ?? 1,
          groups: watchGroups(settings[id]).filter((group: any) => group.buy && sweepable(group)),
        }))
        .filter((watch) => watch.groups.length),
    [ids, settings],
  );
  const run = sweep.data?.run;
  const sweeping = run?.status === "running";
  const [filtersOpen, setFiltersOpen] = useState(false);
  const filterButton = useRef<HTMLButtonElement>(null);
  const filters = useMemo(() => {
    try {
      return normalizeOfferFilters({
        ...JSON.parse(rawFilters),
        equipment: "all",
        stats: [],
      });
    } catch {
      return normalizeOfferFilters();
    }
  }, [rawFilters]);
  const tokens = offerFilterTokens(
    filters,
    document.documentElement.lang === "en",
  );
  const [query, setQuery] = useState(""),
    [search, setSearch] = useState(""),
    [focused, setFocused] = useState(false),
    [limit, setLimit] = useState(40),
    [all, setAll] = useState(false),
    [notice, setNotice] = useState(""),
    [added, setAdded] = useState<number | null>(null),
    [expanded, setExpanded] = useState<number[]>([]);
  const composing = useRef(false);
  const market = useMarketQuery<any>(
    "/api/v1/market/selected" + qs({ hours: "72", ids: [...ids].sort((a, b) => a - b).join(",") }),
    ids.length > 0,
  );
  const presets = useMarketQuery<any>(
    api.watchCatalog() + qs({ q: "" }),
    true,
    false,
  );
  const catalog = useMarketQuery<any>(
    api.watchCatalog() + qs({ q: search }),
    focused,
    false,
  );
  const resolved = useQueries({
    queries: ids.map((id) => ({
      queryKey: ["watch-item", id],
      staleTime: 60000,
      enabled:
        market.isFetched &&
        !(market.data?.products || []).some((item: any) => item.item_id === id),
      queryFn: async ({ signal }: { signal: AbortSignal }) =>
        (await getJson(api.watchCatalog() + qs({ q: id }), { signal })).data,
    })),
  });
  const items = new Map<number, any>(
    [
      ...(market.data?.products || []),
      ...(presets.data?.items || []),
      ...resolved.flatMap((result) => (result.data as any)?.items || []),
      ...(catalog.data?.items || []),
    ].map((row: any) => [row.item_id, row]),
  );
  // Prices-only groups (no condition, no alert) never count as matching offers.
  const conditions = useMemo(
    () =>
      Object.fromEntries(
        ids.map((id) => [
          id,
          {
            ...settings[id],
            groups: watchGroups(settings[id]).filter((g: any) => !trackOnly(g)),
          },
        ]),
      ),
    [ids, settings],
  );
  const tracking = (id: number) => !conditions[id]?.groups.length && watchGroups(settings[id]).length > 0;
  const baseMatches = useMemo<any[]>(
    () => matchingReminders(grouped, ids, conditions, reference),
    [grouped, ids, conditions, reference],
  );
  const summary = Object.fromEntries(
    ids.map((id) => {
      const prices = activeOffers(grouped)
        .filter((row: any) => row.item_id === id)
        .map((row: any) => row.unit_price);
      return [
        id,
        {
          lowest: prices.length ? Math.min(...prices) : null,
          under: baseMatches.filter((row: any) => row.item_id === id).length,
        },
      ];
    }),
  );
  const requestedId = Number(new URLSearchParams(route.search).get("item"));
  const focusId = ids.includes(requestedId) ? requestedId : null;
  useEffect(() => {
    if (focusId !== null)
      document
        .getElementById("watch-matches")
        ?.scrollIntoView({ block: "start" });
  }, [focusId, route.key]);
  function filterWatchRows(rows: any[], filters: any) {
    return {
      cap: null,
      rows: [...new Set(rows.map((row) => row.item_id))].flatMap(
        (id) =>
          filterOffers(
            rows.filter((row) => row.item_id === id),
            "price",
            filters,
          ).rows,
      ),
    };
  }
  const matches = sortWatchQuotes(
    focusId === null
      ? filterWatchRows(baseMatches, filters).rows
      : baseMatches.filter((row: any) => row.item_id === focusId),
    sort === "recent" ? "recent" : "price",
  );
  const hits = ids.filter((id) => summary[id]?.under > 0).length;
  useEffect(() => {
    try {
      userStorage.setItem("watch_hits", String(hits));
    } catch {}
    document.dispatchEvent(
      new CustomEvent("navigation-badge", {
        detail: { key: "watch", count: hits },
      }),
    );
  }, [hits]);
  // The collector window shows the hit badge and sync state of its embedded watch page.
  useEffect(() => {
    if (!embedded || window.parent === window) return;
    const post = (sync = getSyncState()) =>
      window.parent.postMessage(
        {
          type: "cwm-watch",
          hits,
          watches: ids.length,
          synced: sync.signed_in && !sync.pending && sync.status === "synced",
        },
        "*",
      );
    const off = subscribeSync(post);
    return () => {
      off();
    };
  }, [hits, ids.length]);
  useEffect(() => {
    if (composing.current) return;
    const timer = setTimeout(
      () => {
        setSearch(query.trim());
        setLimit(40);
      },
      query ? 200 : 0,
    );
    return () => clearTimeout(timer);
  }, [query]);
  useEffect(() => {
    if (
      !["localhost", "127.0.0.1"].includes(location.hostname) ||
      ["8766", "8765"].includes(location.port) ||
      !location.hash.startsWith("#watch=")
    )
      return;
    try {
      const imported = JSON.parse(decodeURIComponent(location.hash.slice(7)));
      const incoming = Core.readList({
        getItem: () => JSON.stringify(imported.ids),
      });
      const caps = Core.readSettings(
        { getItem: () => JSON.stringify(imported.settings) },
        incoming,
      );
      const next = [...new Set([...incoming, ...ids])].slice(0, 100);
      writeList(JSON.stringify(next));
      writeSettings(JSON.stringify({ ...settings, ...caps }));
    } catch {
      /* malformed handoffs are ignored */
    }
    history.replaceState(
      history.state,
      "",
      location.pathname + location.search,
    );
  }, []);
  function update(id: number, patch: any) {
    writeSettings(
      JSON.stringify({ ...settings, [id]: { ...settings[id], ...patch } }),
    );
  }
  function add(item: any) {
    if (ids.includes(item.item_id)) return;
    if (ids.length >= MAX_WATCHES) {
      setNotice(t("watch.full"));
      return;
    }
    saveIds(Core.add(ids, item.item_id));
    // Close the results and open the new card's conditions, so the price is set right away.
    setAdded(item.item_id);
    setQuery("");
    setFocused(false);
  }
  useEffect(() => {
    if (added !== null)
      document
        .querySelector(`[data-card="${added}"]`)
        ?.scrollIntoView({ block: "center" });
  }, [added, ids.length]);
  const alerting = ids.some((id) =>
    watchGroups(settings[id]).some((group: any) => group.notify),
  );
  const notifications = alerting && !embedded ? <NotificationSettings /> : null;
  // Grouping by item is its own switch; either sort order applies inside each group.
  const byItem =
    groupPref !== "true" && focusId === null
      ? null
      : (focusId === null ? ids : [focusId])
          .map((id) => ({
            id,
            rows: matches.filter((row: any) => row.item_id === id),
          }))
          .filter((group) => group.rows.length);
  const found = catalog.data?.items || [];
  function submit(event: FormEvent) {
    event.preventDefault();
    const exact = found.filter(
      (item: any) =>
        String(item.item_id) === query.trim() ||
        itemName(item) === query.trim(),
    );
    const pick =
      exact.length === 1 ? exact[0] : found.length === 1 ? found[0] : null;
    if (pick) add(pick);
  }
  return (
    <div
      className="lwrap watch-page"
      data-capture-state={captureState}
      data-capture-path={personal?.base ? "desktop" : "browser"}
    >
      <section className="stall lpage">
        <div className="stall-bar watch-heading">
          <h1>{t("watch.title")}</h1>
          <span className="bar-meta" data-meta>
            {ids.length ? t("watch.meta", { n: ids.length, m: hits }) : ""}
          </span>
          <button
            type="button"
            className="watch-collapse"
            data-watch-collapse
            aria-expanded={collapsed !== "true"}
            aria-controls="watch-list"
            aria-label={
              collapsed === "true"
                ? words("展开关注列表", "Expand watchlist")
                : words("收起关注列表", "Collapse watchlist")
            }
            onClick={() =>
              writeCollapsed(collapsed === "true" ? "false" : "true")
            }
          >
            <Icon name="caret" />
          </button>
        </div>
        {(!sweepTab || collapsed === "true") && notifications}
        {sweepTab && collapsed !== "true" && (
          <div className="watch-tabs" role="tablist" aria-label={words("关注分类", "Watch sections")}>
            <button
              type="button"
              role="tab"
              id="watch-tab-items"
              aria-selected={tab === "items"}
              aria-controls="watch-list"
              data-watch-tab="items"
              onClick={() => writePanelTab("items")}
            >
              {words("物品", "Items")} <small>{ids.length}</small>
            </button>
            <button
              type="button"
              role="tab"
              id="watch-tab-sweep"
              aria-selected={tab === "sweep"}
              aria-controls="watch-sweep"
              data-watch-tab="sweep"
              onClick={() => writePanelTab("sweep")}
            >
              {sweeping && <i className="sweep-dot" aria-hidden="true" />}
              {words("扫货", "Sweep")}{" "}
              <small>
                {sweeping
                  ? isRecentRun(run)
                    ? words("买命中的", "Buying matches")
                    : words("运行中", "Running")
                  : words(`${sweepWatches.length} 件`, String(sweepWatches.length))}
              </small>
            </button>
          </div>
        )}
        {sweepTab && collapsed !== "true" && tab === "sweep" && (
          <div id="watch-sweep" role="tabpanel" aria-labelledby="watch-tab-sweep">
            <SweepPanel
              profile={profile!}
              sweep={sweep}
              watches={sweepWatches}
              items={items}
              rows={grouped}
              reference={reference}
              rulesOnly={rulesOnly}
              onLimit={(id, limit) => update(id, { buyLimit: limit })}
              onEditRules={() => writePanelTab("items")}
            />
          </div>
        )}
        <div
          id="watch-list"
          hidden={collapsed === "true" || tab !== "items"}
          {...(sweepTab ? { role: "tabpanel", "aria-labelledby": "watch-tab-items" } : {})}
        >
          {sweepTab && collapsed !== "true" && notifications}
          <div className="wadd">
            <form
              className="finder"
              role="search"
              data-search-form
              onSubmit={submit}
            >
              <Icon name="search" />
              <input
                type="search"
                autoComplete="off"
                placeholder={t("watch.search")}
                aria-label={t("watch.search")}
                data-search
                value={query}
                onChange={(event) => {
                  setQuery(event.target.value);
                  setFocused(true);
                }}
                onFocus={() => {
                  setFocused(true);
                  setSearch(query.trim());
                }}
                onCompositionStart={() => {
                  composing.current = true;
                }}
                onCompositionEnd={(event) => {
                  composing.current = false;
                  setSearch(event.currentTarget.value.trim());
                }}
              />
            </form>
          </div>
          <div className="wresults" data-results hidden={!focused}>
            {catalog.isLoading ? (
              <p className="lend">{t("common.loading")}</p>
            ) : found.length ? (
              <>
                {found.slice(0, limit).map((item: any) => (
                  <button
                    type="button"
                    className="ware wres"
                    key={item.item_id}
                    data-add={item.item_id}
                    aria-disabled={ids.includes(item.item_id)}
                    onClick={() => add(item)}
                  >
                    <Slot url={item.icon_url} />
                    <span className="w-main">
                      <span className="ware-name">
                        <ItemNames row={item} />
                      </span>
                      <span className="w-sub">
                        {[item.level && `Lv.${item.level}`, item.item_id]
                          .filter(Boolean)
                          .join(" · ")}
                      </span>
                    </span>
                    <span
                      className={
                        "wres-act " + (ids.includes(item.item_id) ? "" : "go")
                      }
                    >
                      {t(
                        ids.includes(item.item_id)
                          ? "watch.added"
                          : "watch.add",
                      )}
                    </span>
                  </button>
                ))}
                {found.length > limit && (
                  <button
                    className="more"
                    data-search-more
                    onClick={() => setLimit((old) => old + 40)}
                  >
                    {words("显示更多商品", "Show more items")} ({limit} /{" "}
                    {found.length})
                  </button>
                )}
              </>
            ) : (
              <p className="lend">
                {t(
                  catalog.isError ? "watch.search_failed" : "watch.no_results",
                )}
              </p>
            )}
          </div>
          <p className="wstatus" data-status role="status">
            {notice || shared.error
              ? t(notice ? "watch.full" : "watch.failed")
              : ""}
          </p>
          <div className="wcards" data-cards>
            {ids.length ? (
              ids.map((id) => {
                const item = items.get(id) || {
                  item_id: id,
                  name_zh: String(id),
                };
                const current = settings[id] || { cap: null, notify: true };
                return (
                  <article className="well wcard open" data-card={id} key={id}>
                    <div className="wc-head">
                      <Slot url={item.icon_url} size={32} />
                      <a className="wc-name" href={"/item/" + id}>
                        <b>{itemName(item)}</b>
                        <small>
                          {[
                            document.documentElement.lang === "en"
                              ? item.name_zh
                              : item.name_en,
                            id,
                          ]
                            .filter(Boolean)
                            .join(" · ")}
                        </small>
                      </a>
                      <div className="wc-nums">
                        <span>
                          <small>{t("watch.lowest")}</small>
                          <b data-lowest>
                            <Price value={summary[id]?.lowest} />
                          </b>
                        </span>
                        <span>
                          <small>{t("watch.typical")}</small>
                          <b>
                            <Price value={item.typical} />
                          </b>
                        </span>
                        <span
                          className={summary[id]?.under ? "hit" : ""}
                          data-under-box
                        >
                          <small>{t("watch.under")}</small>
                          <span className="wc-count-link">
                            <b data-under>{tracking(id) ? "—" : summary[id]?.under || 0}</b>
                            {!tracking(id) && <SiteLink
                              className="wc-details"
                              href={`/watch?item=${id}#watch-matches`}
                              aria-label={words(
                                `查看${itemName(item)}符合条件的报价`,
                                `View matching offers for ${itemName(item)}`,
                              )}
                            >
                              ↗
                            </SiteLink>}
                          </span>
                        </span>
                      </div>
                      <button
                        className="bar-btn wc-x"
                        data-remove={id}
                        aria-label={t("watch.remove", { name: itemName(item) })}
                        onClick={() => saveIds(Core.remove(ids, id))}
                      >
                        <Icon name="close" />
                      </button>
                    </div>
                    <div className="wc-set" id={"wc-set-" + id}>
                      <WatchGroups
                        id={id}
                        sweep={inScanner || embedded || Boolean(profile?.signed_in)}
                        autoEdit={added === id}
                        name={itemName(item)}
                        setting={current}
                        rows={grouped}
                        reference={reference}
                        onChange={(patch) => update(id, patch)}
                      />
                    </div>
                  </article>
                );
              })
            ) : (
              <div className="watch-empty">
                <Empty text={t("watch.empty")} />
                <SiteLink className="btn" href="/prices">
                  {words("去价格表挑选", "Browse prices")}
                </SiteLink>
              </div>
            )}
          </div>
        </div>
      </section>
      <section
        className="stall lpage wmatches"
        data-matches-panel
        id="watch-matches"
        hidden={!ids.length}
      >
        <div className="stall-bar">
          <h2>{t("watch.matches")}</h2>
          <span className="bar-meta" data-mmeta>
            {matches.length || ""}
          </span>
        </div>
        {focusId !== null && (
          <div className="watch-focus">
            <span>{itemName(items.get(focusId) || { item_id: focusId })}</span>
            <SiteLink href="/watch#watch-matches">
              {words("全部关注", "All watched items")}
            </SiteLink>
          </div>
        )}
        <div className="watch-list-tools">
          <select
            data-watch-sort
            aria-label={t("watch.sort")}
            value={sort}
            onChange={(event) => writeSort(event.target.value)}
          >
            <option value="price">{t("watch.sort_price")}</option>
            <option value="recent">{t("watch.sort_recent")}</option>
          </select>
          <button
            hidden={focusId !== null}
            ref={filterButton}
            className={"offer-filter-trigger " + (tokens.length ? "on" : "")}
            data-watch-filter
            aria-haspopup="dialog"
            aria-expanded={filtersOpen}
            onClick={() => setFiltersOpen(true)}
          >
            <Icon name="funnel" />
            {words("筛选", "Filters")}
            {tokens.length > 0 && <b>{tokens.length}</b>}
          </button>
          {focusId === null && (
            <button
              type="button"
              className={"toggle right " + (groupPref === "true" ? "on" : "")}
              data-watch-group-by-item
              aria-pressed={groupPref === "true"}
              onClick={() => writeGroupPref(groupPref === "true" ? "false" : "true")}
            >
              <i aria-hidden="true" />
              {words("按物品分组", "Group by item")}
            </button>
          )}
        </div>
        {focusId === null && tokens.length > 0 && (
          <div className="offer-filter-summary">
            {tokens.map((token: any) => (
              <button
                key={token.key}
                data-watch-clear={token.key}
                onClick={() =>
                  writeFilters(
                    JSON.stringify(clearOfferFilter(filters, token.key)),
                  )
                }
              >
                {token.label} ×
              </button>
            ))}
            <button
              className="offer-clear-all"
              data-watch-clear="all"
              onClick={() => writeFilters("{}")}
            >
              {words("清空筛选", "Clear all")}
            </button>
          </div>
        )}
        <OfferFilterDialog
          open={filtersOpen}
          onClose={() => {
            setFiltersOpen(false);
            filterButton.current?.focus({ preventScroll: true });
          }}
          onApply={(value) => writeFilters(JSON.stringify(value))}
          filters={filters}
          rows={baseMatches}
          equipment={false}
          filterRows={filterWatchRows}
        />
        <div className="llist" data-matches>
          {byItem && byItem.length ? (
            byItem.map(({ id, rows }) => {
              const item = items.get(id) || { item_id: id };
              const open = focusId !== null || expanded.includes(id);
              return (
                <div
                  className="watch-match-group"
                  data-match-group={id}
                  key={id}
                >
                  <SiteLink className="wmg-head" href={"/item/" + id}>
                    <Slot url={item.icon_url} size={24} />
                    <b>{itemName(item)}</b>
                    <span className="wmg-count">
                      {rows.length}{" "}
                      {words("条", rows.length === 1 ? "offer" : "offers")}
                    </span>
                  </SiteLink>
                  {rows
                    .slice(0, open ? undefined : PER_ITEM)
                    .map((row: any) => (
                      <OfferRow
                        key={row.id}
                        row={row}
                        item={item}
                        hideIdentity
                      />
                    ))}
                  {!open && rows.length > PER_ITEM && (
                    <button
                      type="button"
                      className="more"
                      data-group-more={id}
                      onClick={() => setExpanded([...expanded, id])}
                    >
                      {words(
                        `再显示 ${rows.length - PER_ITEM} 条`,
                        `Show ${rows.length - PER_ITEM} more`,
                      )}
                      <Icon name="chev" />
                    </button>
                  )}
                </div>
              );
            })
          ) : !byItem && matches.length ? (
            matches
              .slice(0, all ? undefined : 50)
              .map((row: any) => (
                <OfferRow
                  key={row.id}
                  row={row}
                  item={items.get(row.item_id)}
                />
              ))
          ) : (
            <p className="lend">{t("watch.no_matches")}</p>
          )}
        </div>
        <div className="lfoot" data-mfoot>
          {!byItem && !all && matches.length > 50 && (
            <button className="more" data-show-all onClick={() => setAll(true)}>
              {t("watch.show_all", { n: matches.length })}
              <Icon name="chev" />
            </button>
          )}
        </div>
      </section>
    </div>
  );
}

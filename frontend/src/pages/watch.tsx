import { mergeShopOffers } from "/web/js/lib/quote-groups.js?v=20261026-reminders-2";
import { useQueries } from "@tanstack/react-query";
import { useLocation } from "react-router-dom";
import { SiteLink } from "../components/shell";
import WatchGroups from "../components/watch-groups";
import WatchSweep from "../components/watch-sweep";
import {
  activeOffers,
  normalizeReminder,
  matchingReminders,
  notificationEligibility,
  reminderSelection,
} from "/web/js/lib/watch-reminders.js?v=20261027-watch-groups-1";
import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { api, getJson, qs } from "/web/js/lib/api.js?v=20261022-auto-watch-2";
import { t, itemName } from "/web/js/lib/i18n.js";
import Core, {
  LIST_KEY,
  SETTINGS_KEY,
  MAX_WATCHES,
} from "/web/js/lib/watchlist-core.js?v=20261027-watch-groups-1";
import { userStorage } from "/web/js/lib/user-data.js";
import { sortWatchQuotes } from "/web/js/lib/quote-order.js?v=20261023-watch-cap-1";
import { useLiveData, useUserValue } from "../lib/live";
import { useMarketQuery } from "../lib/query";
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
} from "/web/js/lib/item-offer-filters.js?v=20261027-watch-groups-1";
import { OfferRow, Location } from "../components/list-rows";
import { announce, OfferReminder } from "../components/toasts";
import "../lib/list-copy";
const started = Date.now() / 1000,
  notifications = {
    shared: new Map(),
    personal: new Map(),
    delivered: new Map(),
  },
  addedAt: Record<number, number> = {};
export default function Watch() {
  usePageReady();
  const words = useWords();
  const route = useLocation();
  const [list, writeList] = useUserValue(LIST_KEY, "[]"),
    [setting, writeSettings] = useUserValue(SETTINGS_KEY, "{}"),
    [sort, writeSort] = useUserValue("watch.offerSort", "price"),
    [collapsed, writeCollapsed] = useUserValue("watch.listCollapsed", "false"),
    [rawFilters, writeFilters] = useUserValue("watch.offerFilters", "{}"),
    [token] = useUserValue("cwm.collector.token");
  const ids = useMemo<number[]>(
    () => Core.readList({ getItem: () => list }),
    [list],
  );
  const settings = useMemo<any>(
    () => Core.readSettings({ getItem: () => setting }, ids),
    [setting, list],
  );
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
    [permission, setPermission] = useState(() =>
      typeof Notification === "undefined"
        ? "unsupported"
        : Notification.permission,
    );
  const [personal, setPersonal] = useState<any>(null),
    [captureState, setCaptureState] = useState(""),
    [attempt, setAttempt] = useState(0);
  const composing = useRef(false);
  const personalRef = useRef(personal);
  personalRef.current = personal;
  const lastPersonalTry = useRef(0);
  const market = useMarketQuery<any>(api.list());
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
  const shared = useLiveData<any>(
    ids.length
      ? api.watchListings({ ids: [...ids].sort((a, b) => a - b).join(",") })
      : null,
  );
  const own = useLiveData<any>(
    personal && ids.length
      ? personal.base +
          "/api/v1/collector/watch-listings" +
          qs({ ids: ids.join(",") })
      : null,
    personal?.token ? { Authorization: `Bearer ${personal.token}` } : undefined,
  );
  const items = new Map<number, any>(
    [
      ...(market.data?.products || []),
      ...(presets.data?.items || []),
      ...resolved.flatMap((result) => (result.data as any)?.items || []),
      ...(catalog.data?.items || []),
    ].map((row: any) => [row.item_id, row]),
  );
  const grouped = useMemo<any[]>(
    () =>
      shared.data?.grouped_listings ??
      mergeShopOffers(shared.data?.listings || []),
    [shared.data],
  );
  const reference = useMemo(
    () => ({
      rows: grouped,
      percentiles: shared.data?.percentile_caps,
      baseStats: shared.data?.base_stats,
    }),
    [grouped, shared.data],
  );
  const baseMatches = useMemo<any[]>(
    () => matchingReminders(grouped, ids, settings, reference),
    [grouped, ids, settings, reference],
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
    let active = true;
    const abort = new AbortController();
    setPersonal(null);
    lastPersonalTry.current = Date.now();
    const gateway =
      ["localhost", "127.0.0.1"].includes(location.hostname) &&
      !["8766", "8765"].includes(location.port);
    const official = [
      "https://mxd.ruit.me",
      "http://127.0.0.1:8766",
      "http://localhost:8766",
    ].includes(location.origin);
    const targets = [
      ...(token || gateway ? [{ base: "", token }] : []),
      ...(official ? [{ base: "http://127.0.0.1:8780", token: null }] : []),
    ];
    (async () => {
      for (const target of targets) {
        if (!active) return;
        setCaptureState("connecting");
        try {
          const response = await fetch(
            target.base + "/api/v1/collector/status",
            {
              headers: target.token
                ? { Authorization: `Bearer ${target.token}` }
                : {},
              credentials: "same-origin",
              cache: "no-store",
              signal: AbortSignal.any([
                abort.signal,
                AbortSignal.timeout(15000),
              ]),
            },
          );
          if (!active) return;
          setCaptureState("http-" + response.status);
          if (response.ok) {
            const data = await response.json();
            if (target.token || data.local_collector === true) {
              setPersonal({ ...target, id: data.collector_id });
              setCaptureState("connected");
              return;
            }
          }
        } catch (error) {
          if (active) setCaptureState((error as Error).name);
        }
      }
    })();
    const reconnect = () => {
      if (!personalRef.current && Date.now() - lastPersonalTry.current >= 30000)
        setAttempt((old) => old + 1);
    };
    window.addEventListener("focus", reconnect);
    return () => {
      active = false;
      abort.abort();
      window.removeEventListener("focus", reconnect);
    };
  }, [token, attempt]);
  useEffect(() => {
    if (
      shared.data &&
      !personalRef.current &&
      Date.now() - lastPersonalTry.current >= 30000
    )
      setAttempt((old) => old + 1);
  }, [shared.data]);
  useEffect(() => {
    const signal =
      own.data && own.data.personal && own.data.collector_id === personal?.id
        ? own.data
        : null;
    const packets: [[any, string, string?], [any, string, string?]] = [
      [shared.data, "shared"],
      [signal, "personal", personal?.id],
    ];
    for (const [packet, source, identity] of packets) {
      if (!packet) continue;
      if (source === "personal" && !shared.data) continue;
      const eligible = notificationEligibility(
        packet,
        ids,
        settings,
        reference,
      );
      const candidates = (packet.listings || []).filter(
        (row: any) =>
          source !== "personal" ||
          normalizeReminder(settings[row.item_id]?.reminder).percentile ===
            "all" ||
          reminderSelection(
            grouped,
            row.item_id,
            settings[row.item_id],
            reference,
          ).ready,
      );
      const fresh = Core.combinedNotifications(
        candidates,
        Core.watches(ids, settings, addedAt).map((watch: any) => ({
          ...watch,
          max_price: null,
        })),
        notifications,
        started,
        Date.now() / 1000,
        source,
        identity,
        eligible,
      );
      const delivered = new Map<string, any>();
      for (const raw of fresh) {
        const row = eligible.get(raw.id);
        if (row) delivered.set(row.id, row);
      }
      for (const row of [...delivered.values()].slice(0, 5)) {
        const item = { ...items.get(row.item_id), ...row };
        const title = t("watch.toast_title"),
          line = t("watch.toast_line", {
            price: row.unit_price,
            stock: row.stock ?? words("未知", "unknown"),
          });
        announce(
          title,
          `/item/${row.item_id}`,
          <OfferReminder row={row} item={item} />,
          { body: `${itemName(item)} · ${line} · ${row.shop}`, tag: row.id },
        );
      }
    }
  }, [shared.data, own.data, list, setting, personal?.id]);
  function saveIds(next: number[]) {
    for (const id of next)
      if (!ids.includes(id)) addedAt[id] = Date.now() / 1000;
    writeList(JSON.stringify(next));
    writeSettings(
      JSON.stringify(
        Object.fromEntries(
          next.map((id) => [id, settings[id] || { cap: null, notify: true }]),
        ),
      ),
    );
  }
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
  }
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
    if (pick) {
      add(pick);
      setQuery("");
      setFocused(false);
    }
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
        <div id="watch-list" hidden={collapsed === "true"}>
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
            <button
              className="btn"
              data-allow
              hidden={permission !== "default"}
              onClick={() =>
                Notification.requestPermission().then(setPermission)
              }
            >
              {t("watch.allow_notify")}
            </button>
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
          <WatchSweep ids={ids} settings={settings} items={items} reference={reference} personal={personal}/>
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
                      <button
                        className="bar-btn wc-x"
                        data-remove={id}
                        aria-label={t("watch.remove", { name: itemName(item) })}
                        onClick={() => saveIds(Core.remove(ids, id))}
                      >
                        <Icon name="close" />
                      </button>
                    </div>
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
                          <b data-under>{summary[id]?.under || 0}</b>
                          <SiteLink
                            className="wc-details"
                            href={`/watch?item=${id}#watch-matches`}
                            aria-label={words(
                              `查看${itemName(item)}符合提醒的报价`,
                              `View matching offers for ${itemName(item)}`,
                            )}
                          >
                            ↗
                          </SiteLink>
                        </span>
                      </span>
                    </div>
                    <div className="wc-set" id={"wc-set-" + id}>
                      <WatchGroups
                        id={id}
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
              <Empty text={t("watch.empty")} />
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
        {shared.data?.truncated && (
          <p className="sale-note">
            {words("显示最近 200 条报价", "Showing the latest 200 offers")}
          </p>
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
          {matches.length ? (
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
          {!all && matches.length > 50 && (
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

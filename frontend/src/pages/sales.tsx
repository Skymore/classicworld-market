import { useEffect, useMemo, useRef, useState } from "react";
import { useInfiniteQuery } from "@tanstack/react-query";
import { useLocation, useNavigate } from "react-router-dom";
import { api, getJson } from "/web/js/lib/api.js?v=20261022-auto-watch-2";
import { t } from "/web/js/lib/i18n.js";
import {
  readPeriod,
  savePeriod,
} from "/web/js/lib/period.js?v=20261022-regressions-1";
import { readList } from "/web/js/lib/watchlist-core.js";
import { mergeShopSales } from "/web/js/lib/sale-groups.js?v=20261028-sales-1";
import { useUserValue } from "../lib/live";
import { Icon, Empty, Loading, usePageReady } from "../components/shared";
import { OfferRow, SaleKindsHelp } from "../components/list-rows";
import {
  Dialog,
  DialogTrigger,
  DialogContent,
  DialogTitle,
  DialogDescription,
  DialogClose,
} from "../components/ui/dialog";
import "../lib/list-copy";
const cats = [
  ["", "lists.cat.all"],
  ["装备", "lists.cat.equip"],
  ["消耗品", "lists.cat.use"],
  ["其他", "lists.cat.etc"],
  ["商城物品", "lists.cat.cash"],
];
export default function Sales({ embedded = false }: { embedded?: boolean }) {
  usePageReady();
  const route = useLocation(),
    navigate = useNavigate(),
    params = new URLSearchParams(route.search);
  const category = params.get("cat") || "",
    // found_sold and sold_out show as one kind (卖光); old links may name either.
    kind = params.get("kind") === "found_sold" ? "sold_out" : params.get("kind") || "",
    range = params.get("range") || readPeriod(),
    watchOnly = params.get("watch") === "1";
  const [raw] = useUserValue("watchlist", "[]");
  const watched = useMemo(
    () => new Set(readList({ getItem: () => raw })),
    [raw],
  );
  const [open, setOpen] = useState(false),
    [, tick] = useState(0),
    [extra, setExtra] = useState(0);
  const foot = useRef<HTMLDivElement>(null);
  const query = useInfiniteQuery<any>({
    queryKey: ["sales", category],
    meta: { market: true },
    initialPageParam: null,
    queryFn: async ({ pageParam, signal }) =>
      (
        await getJson(
          api.recentSales({
            limit: 50,
            category: category || null,
            before: pageParam,
          }),
          { signal },
        )
      ).data,
    getNextPageParam: (last) => last.next_before ?? undefined,
  });
  const rows = useMemo<any[]>(
    () =>
      [
        ...new Map(
          (query.data?.pages.flatMap((page) => page.sales || []) || []).map(
            (row: any) => [row.id, row],
          ),
        ).values(),
      ] as any[],
    [query.data],
  );
  const cutoff =
    range === "all" ? null : Date.now() / 1000 - Number(range) * 3600;
  const visible = (row: any) =>
    (!kind || (row.kind === "drop" ? "drop" : "sold_out") === kind) &&
    (!watchOnly || watched.has(row.item_id)) &&
    (!category || row.category === category) &&
    (cutoff === null || row.time >= cutoff);
  const shown = mergeShopSales(rows.filter(visible)),
    past =
      cutoff !== null && rows.length > 0 && rows[rows.length - 1].time < cutoff;
  const emptyPages =
    query.data?.pages
      .slice(-6)
      .filter((page) => !(page.sales || []).some(visible)).length || 0;
  useEffect(() => {
    const timer = setInterval(() => tick((old) => old + 1), 30000);
    return () => clearInterval(timer);
  }, []);
  useEffect(() => {
    if (!foot.current) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (
          entries.some((entry) => entry.isIntersecting) &&
          query.hasNextPage &&
          !query.isFetching &&
          !past &&
          emptyPages < 6
        )
          void query.fetchNextPage();
      },
      { rootMargin: "800px 0px" },
    );
    observer.observe(foot.current);
    return () => observer.disconnect();
  }, [
    query.data,
    query.isFetching,
    category,
    kind,
    range,
    raw,
    watchOnly,
    extra,
  ]);
  useEffect(() => {
    const at = rows.reduce((newest, row) => Math.max(newest, row.time || 0), 0);
    if (at)
      document.dispatchEvent(
        new CustomEvent("market-freshness", { detail: at }),
      );
  }, [rows]);
  function update(patch: Record<string, string>) {
    const next = new URLSearchParams(route.search);
    for (const [key, value] of Object.entries(patch)) {
      if (value) next.set(key, value);
      else next.delete(key);
    }
    if (patch.range === "all" || patch.range === "72") savePeriod(patch.range);
    navigate(route.pathname + "?" + next, { replace: true });
  }
  const count = Number(!!kind) + Number(range !== "72") + Number(watchOnly);
  const chip = (
    key: string,
    value: string,
    label: string,
    selected: boolean,
  ) => (
    <button
      className={"chip " + (selected ? "on" : "")}
      type="button"
      aria-pressed={selected}
      data-chip={key}
      data-value={value}
      key={value}
      onClick={() => update({ [key]: value })}
    >
      {label}
    </button>
  );
  return (
    <div className={"lwrap " + (embedded ? "sales-embedded" : "")}>
      <section className="stall lpage sales-page">
        <div className="lhead">
          {!embedded && (
            <div className="stall-bar">
              <h1>{t("sales.title")}</h1>
              <span className="bar-meta" data-meta>
                {t("sales.meta", { n: shown.length })}
              </span>
            </div>
          )}
          <div className="ltools">
            <div
              className="cats"
              role="tablist"
              aria-label={t("lists.categories")}
            >
              {cats.map(([cat, label]) => (
                <button
                  className={"cat " + (category === cat ? "on" : "")}
                  role="tab"
                  aria-selected={category === cat}
                  data-cat={cat}
                  key={cat}
                  onClick={() => update({ cat })}
                >
                  {t(label)}
                </button>
              ))}
            </div>
            <span className="sp" />
            <button
              className={"toggle lwide " + (watchOnly ? "on" : "")}
              aria-pressed={watchOnly}
              data-watch-only
              onClick={() => update({ watch: watchOnly ? "" : "1" })}
            >
              <i />
              {t("lists.watch_only")}
            </button>
            <Dialog open={open} onOpenChange={setOpen}>
              <DialogTrigger asChild>
                <button
                  className="sortbtn"
                  data-filter
                  aria-expanded={open}
                  aria-haspopup="dialog"
                  aria-label={t("lists.filter")}
                >
                  <Icon name="funnel" />
                  <span className="lwide">{t("lists.filter")}</span>
                  <b className="fcount" data-fcount hidden={!count}>
                    {count || ""}
                  </b>
                </button>
              </DialogTrigger>
              <DialogContent className="fpanel react-list-filter">
                <div className="fhead">
                  <DialogTitle>{t("lists.filter")}</DialogTitle>
                </div>
                <DialogDescription className="sr-only">
                  {t("sales.range_note")}
                </DialogDescription>
                <div className="fsec">
                  <h4>
                    {t("sales.kind")}
                    <SaleKindsHelp />
                  </h4>
                  <div className="chips">
                    {["", "sold_out", "drop"].map((value) =>
                      chip(
                        "kind",
                        value,
                        value ? t("evidence." + value) : t("sales.kind_all"),
                        kind === value,
                      ),
                    )}
                  </div>
                </div>
                <div className="fsec">
                  <h4>
                    {t("sales.range")}
                    <small>{t("sales.range_note")}</small>
                  </h4>
                  <div className="chips">
                    {["24", "72", "all"].map((value) =>
                      chip(
                        "range",
                        value,
                        t("sales.range_" + value),
                        range === value,
                      ),
                    )}
                  </div>
                </div>
                <div className="fsec">
                  <button
                    className={"toggle sw " + (watchOnly ? "on" : "")}
                    data-watch-only
                    aria-pressed={watchOnly}
                    onClick={() => update({ watch: watchOnly ? "" : "1" })}
                  >
                    <i />
                    {t("lists.watch_only")}
                  </button>
                </div>
                <div className="ffoot">
                  <button
                    className="btn"
                    data-reset
                    onClick={() => update({ kind: "", range: "72", watch: "" })}
                  >
                    {t("lists.reset")}
                  </button>
                  <DialogClose className="btn primary" data-filter-close>
                    {t("lists.show_n", { n: shown.length })}
                  </DialogClose>
                </div>
              </DialogContent>
            </Dialog>
            <div id="filter-root" />
          </div>
        </div>
        <div className="llist" data-list>
          {shown.length ? (
            shown.map((row: any) => <OfferRow key={row.id} row={row} sale />)
          ) : query.isPending ? (
            <Loading />
          ) : query.isError ? (
            <p className="lend" role="alert">
              {t("common.error")}
            </p>
          ) : (
            <Empty text={t("sales.empty")} />
          )}
        </div>
        <div className="lfoot" data-foot ref={foot}>
          {query.isFetchingNextPage ? (
            <Loading />
          ) : query.hasNextPage && !past ? (
            <button
              className="more"
              data-more
              onClick={() => {
                setExtra((old) => old + 1);
                void query.fetchNextPage();
              }}
            >
              {t("sales.more")}
              <Icon name="chev" />
            </button>
          ) : (
            rows.length > 0 && (
              <p className="lend">
                {t(past ? "sales.range_end" : "sales.end")}
              </p>
            )
          )}
        </div>
      </section>
    </div>
  );
}

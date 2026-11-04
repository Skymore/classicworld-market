import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { useLocation, useNavigate, useNavigationType } from "react-router-dom";
import { usePreferences, useWords } from "../providers";
import { num } from "../components/shared";
import { loadCatalog } from "../lib/catalog";
import { useMapHint, useNames } from "./catalogue";
import { ListWorld, levels } from "./worldmap";
import { Zoomable } from "./zoom";
import { dexHref } from "/web/js/lib/dex-filters.js";

// The map list: region chips over the world map (left) and picture cards
// (right) in one box. The cards scroll inside the box and more load as they
// scroll; on phones the page scrolls and the world map is a bar that opens.
// Same markup as map_browser in pages/dex.rs on the server.

const ISLANDS: [string, string][] = [
  ["maple", "MapleIsland"],
  ["victoria", "VictoriaIsland"],
];
const isIsland = (key: string) => key === "maple" || key === "victoria";
const islandOf = (regionId: string) => ISLANDS.find(([, id]) => id === regionId)?.[0];
/** The island shown without `island=`, as `default_island` in pages/dex.rs. */
const defaultIsland = (region: string) => (region === "maple" ? "maple" : "victoria");
/** The cards loaded and the scroll position, so coming back from a map
 * finds the list where it was. */
let kept: { search: string; next: number; rows: any[]; top: number } | null = null;

function MapTile({ map, onHover }: { map: any; onHover: (map: any | null) => void }) {
  const words = useWords(),
    name = useNames(),
    hint = useMapHint();
  const { language } = usePreferences();
  const own = name(map.names);
  const details: string[] = [];
  for (const part of [
    map.names?.[language === "en" ? "zh" : "en"],
    map.street && name(map.street),
    map.copies && name(map.copies),
    hint(map.hint),
  ])
    if (part && part !== own && !details.includes(part)) details.push(part);
  const lv = levels(map.level_min, map.level_max);
  return (
    <a
      className="mtile"
      href={"/map/" + map.id}
      data-map={map.id}
      data-spot={map.spot || undefined}
      // A tap opens the map; only a mouse or the keyboard points at its spot.
      onPointerEnter={(event) => event.pointerType === "mouse" && onHover(map)}
      onPointerLeave={(event) => event.pointerType === "mouse" && onHover(null)}
      onFocus={(event) => event.currentTarget.matches(":focus-visible") && onHover(map)}
      onBlur={() => onHover(null)}
    >
      {map.thumb ? (
        <img src={map.thumb} alt="" loading="lazy" decoding="async" width={480} height={300} />
      ) : (
        <span className="mt-none">{words("无图", "No picture")}</span>
      )}
      {map.town && <span className="mt-tag mt-town">{words("城镇", "Town")}</span>}
      {lv && (
        <span className="mt-tag mt-lv" title={words("怪物等级", "Monster levels")}>
          {lv}
        </span>
      )}
      <span className="mt-ov">
        <b>{own}</b>
        <small>{details.join(" · ")}</small>
      </span>
    </a>
  );
}

export function MapBrowser({ page, empty }: { page: any; empty: ReactNode }) {
  const words = useWords(),
    name = useNames();
  const navigate = useNavigate(),
    route = useLocation(),
    back = useNavigationType() === "POP";
  const box = useRef<HTMLDivElement>(null),
    right = useRef<HTMLDivElement>(null),
    end = useRef<HTMLButtonElement>(null);
  const keptHere = back && kept?.search === route.search ? kept : null;
  const [more, setMore] = useState<{ search: string; next: number; rows: any[] }>(
    () => keptHere || { search: route.search, next: 0, rows: [] },
  );
  const [loading, setLoading] = useState(false),
    [failed, setFailed] = useState(false),
    [hover, setHover] = useState<any | null>(null),
    [open, setOpen] = useState(false);
  const size = page.page_size || 24,
    total = page.maps.total ?? page.maps.rows.length,
    first = Math.floor((page.offset || 0) / size);
  // Rows loaded for another address are dropped.
  const extra = more.search === route.search ? more.rows : [];
  const seen = new Set(page.maps.rows.map((m: any) => m.id));
  const rows = [...page.maps.rows, ...extra.filter((m: any) => !seen.has(m.id))];
  const done = (page.offset || 0) + rows.length >= total;
  const region = page.region || "";
  const shown = (page.world || []).find(
    (r: any) => r.id === ISLANDS.find(([key]) => key === page.island)?.[1],
  );
  const spots = new Map<string, [any, string]>();
  for (const r of page.world || []) for (const s of r.spots) spots.set(s.key, [s, r.id]);
  const chosen = spots.get(page.spot)?.[0];

  const to = (patch: Record<string, any>) => dexHref(route.search, patch);
  // A new entry each, so the back button steps back through the choices.
  const go = (patch: Record<string, any>) => navigate(to(patch));
  const chipPatch = (key: string) => ({ region: key, area: null, spot: null, island: null });
  const islandPatch = (key: string) =>
    isIsland(region)
      ? { region: key, area: null, spot: null, island: null }
      : { spot: null, island: key === "victoria" ? null : key };
  const spotPatch = (spot: any) => {
    if (spot.key === page.spot)
      return { spot: null, island: page.island === defaultIsland(region) ? null : page.island };
    const island = islandOf(spots.get(spot.key)?.[1] || "");
    return { spot: spot.key, island: null, area: null, ...(region && island ? { region: island } : {}) };
  };
  const link = (patch: Record<string, any>) => ({
    href: to(patch),
    onClick: (event: any) => {
      event.preventDefault();
      go(patch);
    },
  });

  // The box fills the window below its top; on phones the map bar sticks
  // under the site header.
  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    const place = () => {
      el.style.setProperty("--box-top", Math.round(el.getBoundingClientRect().top + scrollY) + "px");
      el.style.setProperty("--stick", ((document.querySelector(".dhead") as HTMLElement)?.offsetHeight || 0) + "px");
    };
    place();
    addEventListener("resize", place);
    return () => removeEventListener("resize", place);
  }, [page]);
  // Back on a list left for a map: its cards and scroll position return.
  const restored = useRef(keptHere?.top || 0);
  // The list pane scrolls on its own except on phones, where the page does.
  const pane = useRef({ scrolls: true, top: 0 });
  useLayoutEffect(() => {
    const el = right.current;
    pane.current.scrolls = !!el && getComputedStyle(el).overflowY !== "visible";
    const top = restored.current;
    restored.current = 0;
    pane.current.top = top;
    if (pane.current.scrolls) el?.scrollTo({ top });
    else if (top) scrollTo({ top });
    setFailed(false);
  }, [route.search]);
  useEffect(() => () => {
    kept = {
      search: route.search,
      next: more.search === route.search ? more.next : 0,
      rows: extra,
      top: pane.current.scrolls ? pane.current.top : scrollY,
    };
  });

  async function loadMore(retry = false) {
    if (loading || done || (failed && !retry)) return;
    const search = route.search;
    const next = more.search === search && more.next ? more.next : first + 2;
    setLoading(true);
    setFailed(false);
    try {
      const data = await loadCatalog(dexHref(search, { page: String(next) }));
      setMore((old) => ({
        search,
        next: next + 1,
        rows: [...(old.search === search ? old.rows : []), ...(data?.page?.maps?.rows || [])],
      }));
    } catch {
      setFailed(true);
    } finally {
      setLoading(false);
    }
  }
  // More cards about 600 px before the end: of the box's list, or of the
  // page on phones where the list does not scroll on its own.
  useEffect(() => {
    const el = end.current,
      pane = right.current;
    if (!el || !pane || done || failed) return;
    const scrolls = getComputedStyle(pane).overflowY !== "visible";
    const watch = new IntersectionObserver(
      (entries) => {
        if (entries[0].isIntersecting) void loadMore();
      },
      { root: scrolls ? pane : null, rootMargin: "600px" },
    );
    watch.observe(el);
    return () => watch.disconnect();
  }, [rows.length, loading, done, failed, route.search]);

  const lit = hover?.spot && shown?.spots.some((s: any) => s.key === hover.spot) ? hover.spot : null;
  const hovered = !chosen && hover?.spot ? spots.get(hover.spot) : undefined;
  const chipOn = (key: string) =>
    key === "" ? !region : key === "rest" ? !!region && !isIsland(region) : region === key;
  return (
    <div className="mbox" data-map-browser ref={box}>
      <div className="mb-tools">
        <nav className="mb-regions" aria-label={words("地区", "Region")}>
          {(page.map_regions || []).map((facet: any) => (
            <a
              key={facet.key || "all"}
              className={"mb-chip" + (chipOn(facet.key) ? " on" : "")}
              aria-current={chipOn(facet.key) ? "true" : undefined}
              data-region={facet.key || "all"}
              {...link(chipPatch(facet.key))}
            >
              {name(facet.names)} <span className="mb-n">{num(facet.count)}</span>
            </a>
          ))}
        </nav>
        <a
          className={"mb-chip mb-town" + (page.town ? " on" : "")}
          aria-pressed={!!page.town}
          data-town=""
          {...link({ town: !page.town })}
        >
          {words("只看城镇", "Towns only")}
          {page.town && " ×"}
        </a>
        <a className="mb-route" href={chosen ? "/route?to=" + chosen.map.id : "/route"}>
          {words("怎么走", "Route")} →
        </a>
      </div>
      <div className="mb-split">
        <div className={"mb-left" + (open ? " mb-open" : "")}>
          <div className="mb-bar">
            {/* An island chip already picks the island. */}
            {!isIsland(region) && (
            <span className="mb-isl" role="group" aria-label={words("世界地图", "World map")}>
              {(page.world || []).map((r: any) => {
                const key = islandOf(r.id);
                return (
                  key && (
                    <a
                      key={r.id}
                      className={r === shown ? "on" : ""}
                      data-island={key}
                      {...link(islandPatch(key))}
                    >
                      {name(r.names)}
                    </a>
                  )
                );
              })}
            </span>
            )}
            <small className="mb-tip">{words("点地点只看那里的地图", "Pick a place to see its maps")}</small>
            <button type="button" className="mb-fold" aria-expanded={open} onClick={() => setOpen(!open)}>
              {open ? words("收起地图", "Hide map") : words("展开地图", "Show map")}
            </button>
          </div>
          <div className="mb-mapbox">
            {shown && (
              // On phones the spots are too close for a finger: a tap opens
              // the map full screen, where they are picked.
              <Zoomable title={name(shown.names)} width={shown.width} height={shown.height} focus={chosen || null}>
                {() => (
                  <ListWorld
                    region={shown}
                    on={page.spot || ""}
                    lit={lit}
                    href={(spot) => to(spotPatch(spot))}
                    pick={(spot) => go(spotPatch(spot))}
                  />
                )}
              </Zoomable>
            )}
          </div>
          <div className="mb-info">
            {chosen ? (
              <>
                <b>{name(chosen.map.names)}</b>
                <span>
                  {words(`${num(total)} 张`, `${num(total)} maps`)}
                  {levels(chosen.level_min, chosen.level_max) &&
                    " · " + levels(chosen.level_min, chosen.level_max)}
                </span>
                <a className="mb-clear" data-clear-spot="" {...link(spotPatch(chosen))}>
                  {words("看全部", "Show all")}
                </a>
              </>
            ) : (
              hovered && (
                <>
                  <span>{words("在", "On")}</span>
                  <b>{name(hovered[0].map.names)}</b>
                  <span>
                    {hovered[1] !== shown?.id &&
                      "（" + name((page.world || []).find((r: any) => r.id === hovered[1])?.names) + "）"}
                    {levels(hovered[0].level_min, hovered[0].level_max)}
                  </span>
                </>
              )
            )}
          </div>
        </div>
        <div
          className="mb-right"
          data-search-results
          aria-live="polite"
          id="search-map"
          ref={right}
          onScroll={(event) => (pane.current.top = event.currentTarget.scrollTop)}
        >
          <p className="mb-total" data-total>
            {words(`共 ${num(total)} 张`, `${num(total)} maps`)}
          </p>
          {rows.length ? (
            <div className="mb-tiles">
              {rows.map((map: any) => (
                <MapTile map={map} key={map.id} onHover={setHover} />
              ))}
            </div>
          ) : (
            empty
          )}
          {!done ? (
            <button
              type="button"
              ref={end}
              className="mb-more"
              data-more=""
              disabled={loading}
              onClick={() => void loadMore(true)}
            >
              {failed ? words("重新加载", "Try again") : words("加载更多", "Load more")}
            </button>
          ) : (
            rows.length > size && (
              <p className="mb-end">{words(`已显示全部 ${num(total)} 张`, `All ${num(total)} maps shown`)}</p>
            )
          )}
        </div>
      </div>
    </div>
  );
}

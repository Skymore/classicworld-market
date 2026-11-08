import { useEffect, useId, useLayoutEffect, useRef, useState, type MouseEvent } from "react";
import { useQuery } from "@tanstack/react-query";
import { useNavigate, useLocation } from "react-router-dom";
import { usePreferences, useWords } from "../providers";
import { loadCatalog } from "../lib/catalog";
import { Icon } from "./shared";
import {
  forgetSearch,
  rememberSearch,
  setSearchText,
  useRecentSearches,
  useSearchText,
} from "../lib/search-memory";
import { langQuery, secondaryLanguage } from "/web/js/lib/i18n.js";
export default function QuickSearch() {
  const words = useWords(),
    { language } = usePreferences(),
    navigate = useNavigate(),
    route = useLocation(),
    id = useId();
  // The text stays while moving between pages; recent searches stay on this device.
  const input = useSearchText(),
    setInput = setSearchText,
    recent = useRecentSearches();
  const [query, setQuery] = useState(() => input.trim()),
    [open, setOpen] = useState(false);
  const composing = useRef(false),
    form = useRef<HTMLFormElement>(null),
    box = useRef<HTMLDivElement>(null),
    selectedRows = useRef<any[] | null>(null),
    visibleRows = useRef<any[]>([]),
    debounce = useRef<ReturnType<typeof setTimeout> | undefined>(undefined),
    focusTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  function fitBox() {
    const element = box.current;
    if (!element || element.hidden || selectedRows.current) return;
    const viewport = window.visualViewport;
    const bottom = viewport ? viewport.offsetTop + viewport.height : innerHeight;
    const available = Math.max(0, Math.floor(bottom - element.getBoundingClientRect().top - 12));
    element.style.maxHeight = `${Math.min(Math.floor(innerHeight * 0.65), 480, available)}px`;
  }
  function checkFocus() {
    clearTimeout(focusTimer.current);
    focusTimer.current = setTimeout(() => {
      if (selectedRows.current) return;
      if (!form.current?.contains(document.activeElement)) setOpen(false);
      else fitBox();
    }, 0);
  }
  function activate(event: MouseEvent<HTMLAnchorElement>) {
    if (event.defaultPrevented || event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    const url = new URL(event.currentTarget.href);
    rememberSearch(input);
    selectedRows.current = null;
    setOpen(false);
    navigate(url.pathname + url.search + url.hash);
  }
  const target =
    "/search?" +
    new URLSearchParams({
      q: input.trim(),
      ...(language !== "zh" ? { lang: language } : {}),
    });
  const result = useQuery<any>({
    queryKey: ["quick-search", query],
    enabled: open,
    queryFn: ({ signal }) =>
      loadCatalog("/search?" + new URLSearchParams({ q: query }), signal),
    staleTime: 15000,
  });
  useEffect(() => {
    if (!open || composing.current || selectedRows.current) return;
    debounce.current = setTimeout(() => setQuery(input.trim()), 200);
    return () => clearTimeout(debounce.current);
  }, [input, open]);
  useEffect(() => {
    selectedRows.current = null;
    setOpen(false);
    // The full results page shows what was searched.
    if (route.pathname !== "/search") return;
    const q = new URLSearchParams(route.search).get("q");
    if (q !== null) setInput(q);
  }, [route.pathname, route.search]);
  const showRecent = !input.trim() && recent.length > 0;
  const focusInput = () =>
    form.current?.querySelector<HTMLInputElement>("input[name=q]")?.focus();
  function pickRecent(term: string) {
    selectedRows.current = null;
    setInput(term);
    setQuery(term);
    setOpen(true);
    focusInput();
  }
  useEffect(() => {
    const outside = (event: PointerEvent) => {
      const target = event.target as Element;
      // A touch can blur the input without focusing its link. Freeze that
      // result, IME updates and viewport sizing until the click is delivered.
      selectedRows.current = event.button === 0 && box.current?.contains(target) && target.closest("a[href]")
        ? visibleRows.current : null;
      if (selectedRows.current) clearTimeout(debounce.current);
      if (!form.current?.contains(target)) setOpen(false);
    };
    const finish = () => {
      if (!selectedRows.current) return;
      selectedRows.current = null;
      checkFocus();
    };
    document.addEventListener("pointerdown", outside);
    document.addEventListener("pointercancel", finish);
    document.addEventListener("click", finish, true);
    return () => {
      clearTimeout(focusTimer.current);
      clearTimeout(debounce.current);
      document.removeEventListener("pointerdown", outside);
      document.removeEventListener("pointercancel", finish);
      document.removeEventListener("click", finish, true);
    };
  }, []);
  const latestRows = result.data?.page
    ? ["item", "mob", "map"].flatMap((kind) =>
        (
          result.data.page[
            kind === "item" ? "items" : kind === "mob" ? "mobs" : "maps"
          ].rows || []
        )
          .slice(0, 6)
          .map((row: any) => ({ ...row, kind })),
      )
    : [];
  const rows = selectedRows.current || latestRows;
  visibleRows.current = rows;
  useLayoutEffect(fitBox, [open, rows.length]);
  useEffect(() => {
    if (!open) return;
    const viewport = window.visualViewport;
    viewport?.addEventListener("resize", fitBox);
    viewport?.addEventListener("scroll", fitBox);
    window.addEventListener("resize", fitBox);
    return () => {
      viewport?.removeEventListener("resize", fitBox);
      viewport?.removeEventListener("scroll", fitBox);
      window.removeEventListener("resize", fitBox);
    };
  }, [open]);
  return (
    <div className="contents">
      <form
        className="finder has-quick-search"
        action="/search"
        method="get"
        role="search"
        ref={form}
        data-quick-search="1"
        onSubmit={(event) => {
          event.preventDefault();
          rememberSearch(input);
          selectedRows.current = null;
          setOpen(false);
          navigate(target);
        }}
        onBlur={checkFocus}
        onKeyDown={(event) => {
          if (event.nativeEvent.isComposing) return;
          selectedRows.current = null;
          if (event.key === "Escape") {
            event.preventDefault();
            setOpen(false);
          }
          if (event.key === "ArrowDown" && open) {
            event.preventDefault();
            form.current
              ?.querySelector<HTMLElement>(".quick-search a, .quick-recent-row")
              ?.focus();
          }
        }}
      >
        <Icon name="search" />
        <input
          name="q"
          type="search"
          placeholder={words(
            "搜索物品、怪物、地图",
            "Search items, monsters, maps",
          )}
          aria-label={words(
            "搜索物品、怪物、地图",
            "Search items, monsters, maps",
          )}
          autoComplete="off"
          spellCheck={false}
          aria-controls={id}
          aria-expanded={open}
          value={input}
          onChange={(event) => {
            setInput(event.target.value);
            if (!selectedRows.current) setOpen(true);
          }}
          onFocus={() => setOpen(true)}
          onCompositionStart={() => {
            composing.current = true;
            clearTimeout(debounce.current);
          }}
          onCompositionEnd={(event) => {
            composing.current = false;
            if (!selectedRows.current) setQuery(event.currentTarget.value.trim());
          }}
        />
        {language !== "zh" && <input type="hidden" name="lang" value={language} />}
        {input ? (
          <button
            type="button"
            className="finder-clear"
            aria-label={words("清空搜索", "Clear search")}
            onClick={() => {
              selectedRows.current = null;
              setInput("");
              setQuery("");
              setOpen(true);
              focusInput();
            }}
          >
            <Icon name="close" />
          </button>
        ) : (
          <kbd>/</kbd>
        )}
        <div
          className="quick-search"
          ref={box}
          id={id}
          hidden={!open}
          role="region"
          aria-label={words("搜索结果", "Search results")}
          aria-busy={result.isFetching}
        >
          {showRecent ? (
            <div className="quick-recent">
              <div className="quick-recent-head">
                <span>{words("最近搜索", "Recent searches")}</span>
                <button type="button" onClick={() => forgetSearch()}>
                  {words("清除", "Clear")}
                </button>
              </div>
              {recent.map((term) => (
                <div className="quick-recent-item" key={term}>
                  <button
                    type="button"
                    className="quick-recent-row"
                    onClick={() => pickRecent(term)}
                  >
                    <Icon name="search" />
                    <span>{term}</span>
                  </button>
                  <button
                    type="button"
                    className="quick-recent-remove"
                    aria-label={words("删除", "Remove") + " " + term}
                    onClick={() => {
                      forgetSearch(term);
                      focusInput();
                    }}
                  >
                    <Icon name="close" />
                  </button>
                </div>
              ))}
            </div>
          ) : result.isPending && !selectedRows.current ? (
            <p className="quick-note" role="status">
              {words("正在搜索…", "Searching…")}
            </p>
          ) : result.isError && !selectedRows.current ? (
            <p className="quick-note" role="status">
              {words(
                "搜索暂不可用，可重试或打开全部结果。",
                "Search unavailable. Try again or open all results.",
              )}
            </p>
          ) : rows.length ? (
            rows.map((row: any) => {
              const name =
                language === "ko"
                  ? words(row.names?.zh || row.names?.en, row.names?.en || row.names?.zh)
                  : row.names?.[language] || row.names?.zh || row.names?.en;
              const other = row.names?.[secondaryLanguage()];
              // Set where another open map has the same name (蘑菇村 10 / 20).
              const hint = row.kind === "map" ? row.hint?.[language === "ko" ? "en" : language] : "";
              const image =
                row.icon_url ||
                (row.kind === "mob" && row.image_id
                  ? `https://maplestory.io/api/GMS/83/mob/${row.image_id}/render/stand`
                  : null);
              return (
                <a
                  className="quick-row"
                  href={`/${row.kind}/${row.id}${langQuery()}`}
                  key={row.kind + row.id}
                  onClick={activate}
                >
                  {image ? (
                    <img
                      src={image}
                      alt=""
                      width={28}
                      height={28}
                      loading="lazy"
                    />
                  ) : (
                    <span className="quick-glyph">◇</span>
                  )}
                  <span className="quick-names">
                    <b>{name}</b>
                    {other && other !== name && <small>{other}</small>}
                    {hint && <small>{hint}</small>}
                  </span>
                  <small className="quick-kind">
                    {row.kind === "item"
                      ? words("物品", "Item")
                      : row.kind === "mob"
                        ? words("怪物", "Monster")
                        : words("地图", "Map")}
                  </small>
                </a>
              );
            })
          ) : (
            <p className="quick-note" role="status">
              {words("没有匹配结果", "No matching results")}
            </p>
          )}
          {!showRecent && <a
            className="quick-more"
            href={target}
            onClick={activate}
          >
            {words("查看全部结果", "Browse all results")} →
          </a>}
        </div>
      </form>
    </div>
  );
}

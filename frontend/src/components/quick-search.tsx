import { useEffect, useId, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useNavigate, useLocation } from "react-router-dom";
import { usePreferences, useWords } from "../providers";
import { loadCatalog } from "../lib/catalog";
import { Icon } from "./shared";
export default function QuickSearch() {
  const words = useWords(),
    { language } = usePreferences(),
    navigate = useNavigate(),
    route = useLocation(),
    id = useId();
  const [input, setInput] = useState(""),
    [query, setQuery] = useState(""),
    [open, setOpen] = useState(false);
  const composing = useRef(false),
    form = useRef<HTMLFormElement>(null);
  const target =
    "/search?" +
    new URLSearchParams({
      q: input.trim(),
      ...(language === "en" ? { lang: "en" } : {}),
    });
  const result = useQuery<any>({
    queryKey: ["quick-search", query],
    enabled: open,
    queryFn: ({ signal }) =>
      loadCatalog("/search?" + new URLSearchParams({ q: query }), signal),
    staleTime: 15000,
  });
  useEffect(() => {
    if (composing.current) return;
    const timer = setTimeout(() => setQuery(input.trim()), 200);
    return () => clearTimeout(timer);
  }, [input]);
  useEffect(() => {
    setOpen(false);
  }, [route.pathname]);
  useEffect(() => {
    const outside = (event: PointerEvent) => {
      if (!form.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", outside);
    return () => document.removeEventListener("pointerdown", outside);
  }, []);
  const rows = result.data?.page
    ? ["item", "mob", "map"].flatMap((kind) =>
        (
          result.data.page[
            kind === "item" ? "items" : kind === "mob" ? "mobs" : "maps"
          ].rows || []
        )
          .slice(0, 2)
          .map((row: any) => ({ ...row, kind })),
      )
    : [];
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
          setOpen(false);
          navigate(target);
        }}
        onBlur={(event) => {
          if (!event.currentTarget.contains(event.relatedTarget))
            setOpen(false);
        }}
        onKeyDown={(event) => {
          if (event.nativeEvent.isComposing) return;
          if (event.key === "Escape") {
            event.preventDefault();
            setOpen(false);
          }
          if (event.key === "ArrowDown" && open) {
            event.preventDefault();
            form.current
              ?.querySelector<HTMLAnchorElement>(".quick-search a")
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
            setOpen(true);
          }}
          onFocus={() => setOpen(true)}
          onCompositionStart={() => {
            composing.current = true;
          }}
          onCompositionEnd={(event) => {
            composing.current = false;
            setQuery(event.currentTarget.value.trim());
          }}
        />
        {language === "en" && <input type="hidden" name="lang" value="en" />}
        <kbd>/</kbd>
        <div
          className="quick-search"
          id={id}
          hidden={!open}
          role="region"
          aria-label={words("搜索结果", "Search results")}
          aria-busy={result.isFetching}
        >
          {result.isPending ? (
            <p className="quick-note" role="status">
              {words("正在搜索…", "Searching…")}
            </p>
          ) : result.isError ? (
            <p className="quick-note" role="status">
              {words(
                "搜索暂不可用，可重试或打开全部结果。",
                "Search unavailable. Try again or open all results.",
              )}
            </p>
          ) : rows.length ? (
            rows.map((row: any) => {
              const name =
                row.names?.[language] || row.names?.zh || row.names?.en;
              const other = row.names?.[language === "zh" ? "en" : "zh"];
              const image =
                row.icon_url ||
                (row.kind === "mob" && row.image_id
                  ? `https://maplestory.io/api/GMS/83/mob/${row.image_id}/render/stand`
                  : null);
              return (
                <a
                  className="quick-row"
                  href={`/${row.kind}/${row.id}${language === "en" ? "?lang=en" : ""}`}
                  key={row.kind + row.id}
                  onClick={() => setOpen(false)}
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
          <a
            className="quick-more"
            href={target}
            onClick={() => setOpen(false)}
          >
            {words("查看全部结果", "Browse all results")} →
          </a>
        </div>
      </form>
    </div>
  );
}

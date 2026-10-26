import { useEffect, useId, useMemo, useRef, useState } from "react";
import { useMarketQuery } from "../lib/query";
import { usePreferences, useWords } from "../providers";
import { Icon, Slot } from "../components/shared";
import "./tools.css";

interface Choice {
  item_id: number;
  name_zh?: string;
  name_en?: string;
  icon_url?: string;
}
export default function Picker({
  kind,
  value,
  choose,
}: {
  kind: "equipment" | "scroll";
  value: Choice;
  choose(value: Choice): void;
}) {
  const words = useWords(),
    { language } = usePreferences(),
    id = useId();
  const [draft, setDraft] = useState(""),
    [query, setQuery] = useState(""),
    [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null),
    composing = useRef(false);
  const name = (row: Choice) =>
    language === "en" ? row.name_en || row.name_zh : row.name_zh || row.name_en;
  useEffect(() => {
    if (composing.current) return;
    const timer = setTimeout(() => setQuery(draft.trim()), 200);
    return () => clearTimeout(timer);
  }, [draft]);
  useEffect(() => {
    const outside = (event: PointerEvent) => {
      if (!box.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", outside);
    return () => document.removeEventListener("pointerdown", outside);
  }, []);
  const result = useMarketQuery<{ items: Choice[] }>(
    "/api/v1/watchlist/catalog?" + new URLSearchParams({ q: query }),
    open && !!query,
    false,
  );
  const choices = (result.data?.items || []).filter((row) =>
    kind === "equipment"
      ? row.item_id >= 1000000 && row.item_id < 2000000
      : row.item_id >= 2040000 && row.item_id < 2050000,
  );
  return (
    <div
      className="enhance-picker"
      ref={box}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node))
          setOpen(false);
      }}
    >
      <label htmlFor={id}>
        {kind === "equipment"
          ? words("装备", "Equipment")
          : words("卷轴", "Scroll")}
      </label>
      <div className="enhance-selected">
        <Slot
          size={32}
          url={
            value.icon_url ||
            `https://mxdgcw.dvg.cn/dbsource/icon/item/${value.item_id}.png`
          }
        />
        <a href={"/item/" + value.item_id}>{name(value)}</a>
      </div>
      <div className="enhance-search">
        <Icon name="search" />
        <input
          id={id}
          type="search"
          value={draft}
          autoComplete="off"
          placeholder={words("搜索名称或物品 ID", "Search name or item ID")}
          aria-expanded={open && !!draft.trim()}
          aria-controls={id + "-results"}
          onFocus={() => setOpen(true)}
          onChange={(event) => {
            setDraft(event.target.value);
            setOpen(true);
          }}
          onCompositionStart={() => {
            composing.current = true;
          }}
          onCompositionEnd={(event) => {
            composing.current = false;
            setQuery(event.currentTarget.value.trim());
          }}
          onKeyDown={(event) => {
            if (event.key === "Escape") setOpen(false);
            if (event.key === "Enter") event.preventDefault();
          }}
        />
      </div>
      {open && !!draft.trim() && (
        <div className="enhance-choices well" id={id + "-results"}>
          {result.isFetching || query !== draft.trim() ? (
            <span role="status">{words("搜索中…", "Searching…")}</span>
          ) : result.isError ? (
            <button
              className="btn"
              type="button"
              onClick={() => void result.refetch()}
            >
              {words("重试", "Retry")}
            </button>
          ) : choices.length ? (
            choices.map((row) => (
              <button
                type="button"
                key={row.item_id}
                onClick={() => {
                  choose(row);
                  setDraft("");
                  setQuery("");
                  setOpen(false);
                }}
              >
                <Slot size={24} url={row.icon_url} />
                <span>
                  {name(row)}
                  <small>{row.item_id}</small>
                </span>
              </button>
            ))
          ) : (
            <span role="status">
              {words("没有匹配物品", "No matching items")}
            </span>
          )}
        </div>
      )}
    </div>
  );
}

import { useEffect, useId, useRef, useState } from "react";
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
    composing = useRef(false),
    selectedRows = useRef<Choice[] | null>(null),
    visibleRows = useRef<Choice[]>([]),
    debounce = useRef<ReturnType<typeof setTimeout> | undefined>(undefined),
    focusTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  function checkFocus() {
    clearTimeout(focusTimer.current);
    focusTimer.current = setTimeout(() => {
      if (
        !selectedRows.current &&
        !box.current?.contains(document.activeElement)
      )
        setOpen(false);
    }, 0);
  }
  const name = (row: Choice) =>
    words(row.name_zh || row.name_en || "", row.name_en || row.name_zh || "");
  useEffect(() => {
    if (!open || composing.current || selectedRows.current) return;
    debounce.current = setTimeout(() => setQuery(draft.trim()), 200);
    return () => clearTimeout(debounce.current);
  }, [draft, open]);
  useEffect(() => {
    const outside = (event: PointerEvent) => {
      const target = event.target as Element;
      // iOS can blur the input without focusing the tapped result. Keep the
      // visible rows mounted through blur/IME updates until its click arrives.
      selectedRows.current =
        event.button === 0 &&
        box.current?.contains(target) &&
        target.closest("[data-enhance-choice]")
          ? visibleRows.current
          : null;
      if (selectedRows.current) clearTimeout(debounce.current);
      if (!box.current?.contains(target)) setOpen(false);
    };
    const finish = () => {
      if (!selectedRows.current) return;
      selectedRows.current = null;
      checkFocus();
    };
    const cancel = () => {
      // A cancelled touch may be scrolling the results; never select or
      // remove them while that native scrolling gesture is in progress.
      clearTimeout(focusTimer.current);
      selectedRows.current = null;
    };
    document.addEventListener("pointerdown", outside);
    document.addEventListener("pointercancel", cancel);
    document.addEventListener("click", finish, true);
    return () => {
      clearTimeout(focusTimer.current);
      clearTimeout(debounce.current);
      document.removeEventListener("pointerdown", outside);
      document.removeEventListener("pointercancel", cancel);
      document.removeEventListener("click", finish, true);
    };
  }, []);
  const result = useMarketQuery<{ items: Choice[] }>(
    "/api/v1/watchlist/catalog?" + new URLSearchParams({ q: query }),
    open && !!query,
    false,
  );
  const choices =
    selectedRows.current ||
    (result.data?.items || []).filter((row) =>
      kind === "equipment"
        ? row.item_id >= 1000000 && row.item_id < 2000000
        : row.item_id >= 2040000 && row.item_id < 2050000,
    );
  visibleRows.current = choices;
  return (
    <div className="enhance-picker" ref={box} onBlur={checkFocus}>
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
            clearTimeout(debounce.current);
          }}
          onCompositionEnd={(event) => {
            composing.current = false;
            if (!selectedRows.current)
              setQuery(event.currentTarget.value.trim());
          }}
          onKeyDown={(event) => {
            if (event.nativeEvent.isComposing) return;
            selectedRows.current = null;
            if (event.key === "Escape") setOpen(false);
            if (event.key === "Enter") event.preventDefault();
          }}
        />
      </div>
      {open && !!draft.trim() && (
        <div className="enhance-choices well" id={id + "-results"}>
          {!selectedRows.current &&
          (result.isFetching || query !== draft.trim()) ? (
            <span role="status">{words("搜索中…", "Searching…")}</span>
          ) : result.isError && !selectedRows.current ? (
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
                data-enhance-choice={row.item_id}
                onClick={() => {
                  selectedRows.current = null;
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

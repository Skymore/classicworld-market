import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { useWords } from "../providers";
import { loadCatalog } from "../lib/catalog";
import { mobImageUrl, useMapHint, useNames } from "./catalogue";

// A route page field that suggests open maps or monsters as the user types:
// the quick search's list and search endpoint (components/quick-search.tsx),
// with the arrow keys moving through the suggestions and Enter or a tap
// choosing one. Without scripts the server's plain field still submits names.

export type Choice = { id: number; text: string };

const SHOWN = 8;

export function PlaceField({
  kind,
  name,
  label,
  placeholder,
  value,
  onChange,
  onChoose,
}: {
  kind: "map" | "mob";
  name: string;
  label: string;
  placeholder: string;
  value: string;
  onChange: (text: string) => void;
  onChoose: (choice: Choice) => void;
}) {
  const words = useWords(),
    names = useNames(),
    mapHint = useMapHint(),
    id = useId();
  const [open, setOpen] = useState(false),
    [query, setQuery] = useState(""),
    [active, setActive] = useState(-1);
  const wrap = useRef<HTMLDivElement>(null),
    list = useRef<HTMLDivElement>(null),
    composing = useRef(false),
    // A press on a suggestion: a tap can blur the input before its click.
    pressing = useRef(false),
    debounce = useRef<ReturnType<typeof setTimeout> | undefined>(undefined),
    blurTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const text = value.trim();
  const result = useQuery<any>({
    queryKey: ["route-suggest", kind, query],
    enabled: open && text !== "" && query !== "",
    queryFn: ({ signal }) => loadCatalog("/search?" + new URLSearchParams({ kind, q: query }), signal),
    placeholderData: keepPreviousData,
    staleTime: 60000,
  });
  useEffect(() => {
    if (!open || composing.current) return;
    debounce.current = setTimeout(() => setQuery(text), 200);
    return () => clearTimeout(debounce.current);
  }, [text, open]);
  const rows: any[] = query ? (result.data?.page?.[kind === "map" ? "maps" : "mobs"]?.rows || []).slice(0, SHOWN) : [];
  // Only suggestions open the list: a "searching" or "no match" note would
  // just cover the fields and button below it.
  const shown = open && text !== "" && rows.length > 0;
  useEffect(() => setActive(-1), [query, result.data]);
  useEffect(() => {
    if (active >= 0) document.getElementById(`${id}-${active}`)?.scrollIntoView({ block: "nearest" });
  }, [active, id]);

  // The bottom the list may reach: above the software keyboard and the dock.
  function limit() {
    const viewport = window.visualViewport;
    let bottom = viewport ? viewport.offsetTop + viewport.height : innerHeight;
    const dock = document.querySelector(".dock");
    if (dock) {
      const box = dock.getBoundingClientRect();
      if (box.height > 0 && box.top < bottom) bottom = box.top;
    }
    return bottom;
  }
  function fit() {
    const element = list.current;
    if (!element || element.hidden) return;
    const room = Math.floor(limit() - element.getBoundingClientRect().top - 8);
    element.style.maxHeight = `${Math.max(96, Math.min(Math.floor(innerHeight * 0.65), 480, room))}px`;
  }
  // On opening, scroll a field low on a phone screen up so a few suggestions fit.
  useLayoutEffect(() => {
    if (!shown || !wrap.current) return;
    const box = wrap.current.getBoundingClientRect();
    const room = limit() - box.bottom;
    const top = window.visualViewport?.offsetTop ?? 0;
    if (room < 220 && box.top - top > 8) window.scrollBy(0, Math.min(box.top - top - 8, 220 - room));
    fit();
  }, [shown]);
  useLayoutEffect(fit, [shown, rows.length]);
  useEffect(() => {
    if (!shown) return;
    const viewport = window.visualViewport;
    viewport?.addEventListener("resize", fit);
    viewport?.addEventListener("scroll", fit);
    window.addEventListener("resize", fit);
    const outside = (event: PointerEvent) => {
      if (!wrap.current?.contains(event.target as Node)) setOpen(false);
    };
    // After a press on the list ends (its click included), close if focus went elsewhere.
    const released = () =>
      setTimeout(() => {
        if (!pressing.current) return;
        pressing.current = false;
        if (!wrap.current?.contains(document.activeElement)) setOpen(false);
      }, 0);
    document.addEventListener("pointerdown", outside);
    document.addEventListener("pointerup", released, true);
    document.addEventListener("pointercancel", released, true);
    return () => {
      viewport?.removeEventListener("resize", fit);
      viewport?.removeEventListener("scroll", fit);
      window.removeEventListener("resize", fit);
      document.removeEventListener("pointerdown", outside);
      document.removeEventListener("pointerup", released, true);
      document.removeEventListener("pointercancel", released, true);
    };
  }, [shown]);
  useEffect(
    () => () => {
      clearTimeout(debounce.current);
      clearTimeout(blurTimer.current);
    },
    [],
  );

  function choose(row: any) {
    pressing.current = false;
    setOpen(false);
    setActive(-1);
    onChoose({ id: row.id, text: names(row.names) });
  }
  return (
    <div className="place-field has-quick-search" ref={wrap}>
      <label className="field">
        <span>{label}</span>
        <input
          type="text"
          name={name}
          value={value}
          placeholder={placeholder}
          autoComplete="off"
          spellCheck={false}
          role="combobox"
          aria-autocomplete="list"
          aria-expanded={shown}
          aria-controls={id}
          aria-activedescendant={shown && active >= 0 ? `${id}-${active}` : undefined}
          onChange={(event) => {
            onChange(event.target.value);
            setOpen(true);
          }}
          onBlur={() => {
            clearTimeout(blurTimer.current);
            blurTimer.current = setTimeout(() => {
              if (!pressing.current && !wrap.current?.contains(document.activeElement)) setOpen(false);
            }, 0);
          }}
          onCompositionStart={() => {
            composing.current = true;
            clearTimeout(debounce.current);
          }}
          onCompositionEnd={(event) => {
            composing.current = false;
            setQuery(event.currentTarget.value.trim());
          }}
          onKeyDown={(event) => {
            if (event.nativeEvent.isComposing) return;
            const key = event.key;
            if (key === "ArrowDown" || key === "ArrowUp") {
              event.preventDefault();
              if (!shown) {
                if (text) setOpen(true);
                return;
              }
              if (!rows.length) return;
              setActive((a) => (key === "ArrowDown" ? (a + 1) % rows.length : a <= 0 ? rows.length - 1 : a - 1));
            } else if (key === "Enter") {
              if (shown && rows[active]) {
                event.preventDefault();
                choose(rows[active]);
              } else setOpen(false);
            } else if (key === "Escape") {
              if (shown) {
                event.preventDefault();
                setOpen(false);
              }
            } else if (key === "Tab") setOpen(false);
          }}
        />
      </label>
      <div
        className="quick-search place-options"
        ref={list}
        hidden={!shown}
        aria-busy={result.isFetching}
        onPointerDown={() => {
          pressing.current = true;
        }}
        // Keeps focus (and the phone keyboard) on the input.
        onMouseDown={(event) => event.preventDefault()}
      >
        <ul id={id} role="listbox" aria-label={label}>
          {rows.map((row: any, i: number) => {
            const main = names(row.names);
            const other = words(row.names?.en, row.names?.zh);
            const image = kind === "mob" ? mobImageUrl(row) : null;
            const extra = kind === "mob" ? (row.level != null ? `Lv.${row.level}` : "") : names(row.street);
            const hint = kind === "map" ? mapHint(row.hint) : "";
            return (
              <li
                key={row.id}
                id={`${id}-${i}`}
                role="option"
                aria-selected={i === active}
                className="quick-row"
                onMouseEnter={() => setActive(i)}
                onClick={() => choose(row)}
              >
                {image ? (
                  <img src={image} alt="" width={28} height={28} loading="lazy" />
                ) : (
                  <span className="quick-glyph">◇</span>
                )}
                <span className="quick-names">
                  <b>{main}</b>
                  {other && other !== main && <small>{other}</small>}
                  {hint && <small>{hint}</small>}
                </span>
                {extra && <small className="quick-kind">{extra}</small>}
              </li>
            );
          })}
        </ul>
      </div>
    </div>
  );
}

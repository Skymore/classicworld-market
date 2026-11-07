import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useSearchParams } from "react-router-dom";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { useWords } from "../providers";
import { useMarketQuery } from "../lib/query";
import { Loading, usePageReady } from "../components/shared";
import { ShopCard, type ShopStop } from "../components/shop-view";
import "./market.css";

const CHANNELS = 40;
const ROOMS = 20;
const ROW = 36; // wheel row height (px), matches market.css

/** A scroll wheel (phone time-picker style): rows snap to the middle band;
 *  the row resting there is the value. Tapping a row picks it too. */
function Wheel({
  label,
  rows,
  value,
  onChange,
}: {
  label: string;
  rows: { value: number; text: ReactNode; dim?: boolean }[];
  value: number;
  onChange: (value: number) => void;
}) {
  const box = useRef<HTMLDivElement>(null);
  const settle = useRef<number>(0);
  const moving = useRef(false);
  const index = Math.max(0, rows.findIndex((r) => r.value === value));
  // Follow outside changes (swiping to the next room) unless a finger is on it.
  useLayoutEffect(() => {
    const element = box.current;
    if (!element || moving.current) return;
    if (Math.abs(element.scrollTop - index * ROW) > 2)
      element.scrollTo({ top: index * ROW, behavior: element.scrollTop ? "smooth" : "auto" });
  }, [index]);
  const scrolled = () => {
    const element = box.current;
    if (!element) return;
    moving.current = true;
    window.clearTimeout(settle.current);
    settle.current = window.setTimeout(() => {
      moving.current = false;
      const at = Math.min(rows.length - 1, Math.max(0, Math.round(element.scrollTop / ROW)));
      if (rows[at] && rows[at].value !== value) onChange(rows[at].value);
    }, 140);
  };
  return (
    <div className="mk-wheel">
      <span className="mk-wheel-label">{label}</span>
      <div className="mk-wheel-box">
        <div ref={box} className="mk-wheel-rows" role="listbox" aria-label={label} onScroll={scrolled}>
          {rows.map((r) => (
            <button
              key={r.value}
              type="button"
              role="option"
              aria-selected={r.value === value}
              className={(r.value === value ? "on" : "") + (r.dim ? " dim" : "")}
              onClick={() => onChange(r.value)}
            >
              {r.text}
            </button>
          ))}
        </div>
        <i className="mk-wheel-band" aria-hidden="true" />
      </div>
    </div>
  );
}

/** Cloud market: two wheels pick a channel and a Free Market room; below is
 *  one shop of that room at a time, as the item page's shop view shows it.
 *  Swipe sideways (or up/down once the shop is scrolled to its top/bottom)
 *  for the next shop; after the room's last shop comes the next room. */
export default function Market() {
  usePageReady();
  const words = useWords();
  const [params, setParams] = useSearchParams();
  const overview = useMarketQuery<{ rooms: [number, number, number][] }>("/api/v1/market/rooms", true, true, true);
  const counts = useMemo(() => {
    const map = new Map<string, number>();
    for (const [channel, room, stalls] of overview.data?.rooms || []) map.set(channel + ":" + room, stalls);
    return map;
  }, [overview.data]);
  // Without a choice in the URL, start in the busiest room.
  const busiest = useMemo(() => {
    let best: [number, number, number] | null = null;
    for (const entry of overview.data?.rooms || []) if (!best || entry[2] > best[2]) best = entry;
    return best;
  }, [overview.data]);
  const asked = (name: string, max: number) => {
    const value = Number(params.get(name));
    return Number.isInteger(value) && value >= 1 && value <= max ? value : null;
  };
  const channel = asked("ch", CHANNELS) ?? busiest?.[0] ?? 1;
  const room = asked("fm", ROOMS) ?? (channel === busiest?.[0] ? busiest[1] : 1);
  const index = Math.max(0, Number(params.get("i")) || 0);
  const go = (ch: number, fm: number, i: number | "last" = 0) =>
    setParams({ ch: String(ch), fm: String(fm), i: String(i) }, { replace: true });
  const view = useMarketQuery<any>(`/api/v1/market/room?channel=${channel}&room=${room}`, true, true, true);
  const shown = !!view.data && view.data.channel === channel && view.data.room === room;
  const stalls: any[] = useMemo(
    () => (shown ? [...(view.data.stalls || [])].sort((a: any, b: any) => a.y - b.y || a.x - b.x) : []),
    [view.data, shown],
  );
  // Coming back from the next room starts on this room's last shop.
  const at = params.get("i") === "last" ? Math.max(0, stalls.length - 1) : Math.min(index, Math.max(0, stalls.length - 1));
  useEffect(() => {
    if (shown && params.get("i") === "last") go(channel, room, at);
  }, [shown, stalls.length]);
  const stop: ShopStop | null = stalls[at]
    ? { key: stalls[at].shop_key, row: { shop: stalls[at].title, owner_name: stalls[at].owner_name, channel, room } }
    : null;
  const nextRoom = (d: number) => {
    let ch = channel,
      fm = room + d;
    if (fm < 1) [ch, fm] = [ch > 1 ? ch - 1 : CHANNELS, ROOMS];
    if (fm > ROOMS) [ch, fm] = [ch < CHANNELS ? ch + 1 : 1, 1];
    go(ch, fm, d < 0 ? "last" : 0);
  };
  const step = (d: number) => {
    if (!shown) return;
    const next = at + d;
    if (next >= 0 && next < stalls.length) go(channel, room, next);
    else nextRoom(d);
  };
  const pick = (stall: any) => {
    const found = stalls.findIndex((s) => s.shop_key === stall.shop_key);
    if (found >= 0) go(channel, room, found);
  };
  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if ((event.target as HTMLElement)?.closest?.("input,textarea,select,[role=listbox]")) return;
      if (event.key === "ArrowLeft") step(-1);
      if (event.key === "ArrowRight") step(1);
    };
    document.addEventListener("keydown", key);
    return () => document.removeEventListener("keydown", key);
  });
  // The shop fills the screen down to the bottom navigation: its card scrolls
  // inside, so a swipe at its top or bottom can mean "next shop".
  const panel = useRef<HTMLDivElement>(null);
  const [height, setHeight] = useState<number>();
  useLayoutEffect(() => {
    const fit = () => {
      const element = panel.current;
      if (!element) return;
      const dock = document.querySelector<HTMLElement>(".dock");
      // The dock is position:fixed (no offsetParent): ask its style whether it shows.
      const docked = dock && getComputedStyle(dock).display !== "none" && dock.getBoundingClientRect().height > 0;
      const bottom = docked ? dock.getBoundingClientRect().top : window.innerHeight;
      setHeight(Math.max(360, Math.round(bottom - (element.getBoundingClientRect().top + window.scrollY) - 8)));
    };
    fit();
    window.addEventListener("resize", fit);
    return () => window.removeEventListener("resize", fit);
  }, []);
  const touch = useRef<{ x: number; y: number; top: boolean; bottom: boolean; skip: boolean } | null>(null);
  return (
    <div className="lwrap market-page">
      <section className="stall mk">
        <h1 className="mk-title">{words("云逛市场", "Cloud market")}</h1>
        <div className="mk-wheels">
          <Wheel
            label={words("频道", "Channel")}
            value={channel}
            onChange={(ch) => go(ch, room)}
            rows={Array.from({ length: CHANNELS }, (_, i) => i + 1).map((ch) => ({
              value: ch,
              text: words(`${ch}频道`, `CH ${ch}`),
            }))}
          />
          <Wheel
            label={words("洞", "Room")}
            value={room}
            onChange={(fm) => go(channel, fm)}
            rows={Array.from({ length: ROOMS }, (_, i) => i + 1).map((fm) => {
              const n = counts.get(channel + ":" + fm) || 0;
              return {
                value: fm,
                dim: !n,
                text: (
                  <>
                    {words(`${fm}洞`, "FM" + fm)}
                    <small>{n ? words(` · ${n} 摊`, ` · ${n}`) : " · —"}</small>
                  </>
                ),
              };
            })}
          />
        </div>
        <div className="stall-bar sv-bar mk-bar">
          <button type="button" className="sv-step" onClick={() => step(-1)} aria-label={words("上一家", "Previous shop")}>
            <ChevronLeft aria-hidden="true" />
          </button>
          <span className="sv-count" aria-live="polite">
            {!shown
              ? words(`${channel}频道 · ${room}洞`, `CH ${channel} · FM${room}`)
              : stalls.length
                ? words(`${room}洞 第 ${at + 1} / ${stalls.length} 家`, `FM${room} · shop ${at + 1} of ${stalls.length}`)
                : words(`${room}洞 · 没有摊位`, `FM${room} · no stalls`)}
          </span>
          <button type="button" className="sv-step" onClick={() => step(1)} aria-label={words("下一家", "Next shop")}>
            <ChevronRight aria-hidden="true" />
          </button>
        </div>
        <div
          ref={panel}
          className="mk-shop"
          style={{ height }}
          onTouchStart={(event) => {
            const t = event.touches[0];
            const card = panel.current?.querySelector<HTMLElement>(".sv-card");
            touch.current = {
              x: t.clientX,
              y: t.clientY,
              top: !card || card.scrollTop <= 1,
              bottom: !card || card.scrollTop + card.clientHeight >= card.scrollHeight - 2,
              skip: !!(event.target as HTMLElement).closest(".sv-map.big"),
            };
          }}
          onTouchEnd={(event) => {
            const start = touch.current;
            touch.current = null;
            const t = event.changedTouches[0];
            if (!start || !t || start.skip) return;
            const dx = t.clientX - start.x,
              dy = t.clientY - start.y;
            if (Math.abs(dx) > 60 && Math.abs(dx) > Math.abs(dy) * 1.5) step(dx < 0 ? 1 : -1);
            else if (Math.abs(dy) > 80 && Math.abs(dy) > Math.abs(dx) * 1.5) {
              if (dy < 0 && start.bottom) step(1);
              if (dy > 0 && start.top) step(-1);
            }
          }}
        >
          {view.isError ? (
            <p className="mk-none">{words("读不到这一洞。", "Could not load this room.")}</p>
          ) : !shown ? (
            <Loading />
          ) : stop ? (
            <ShopCard stop={stop} itemId={0} stepping browse onPick={pick} />
          ) : (
            <p className="mk-none">
              {words("最近一天没有读到这一洞的摊位，左右滑动去下一洞。", "No stalls read here in the last day; swipe for the next room.")}
            </p>
          )}
        </div>
      </section>
    </div>
  );
}

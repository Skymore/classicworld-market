import { useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { useWords } from "../providers";
import { useMarketQuery } from "../lib/query";
import { Loading, usePageReady } from "../components/shared";
import ShopView, { StallMap, type ShopStop } from "../components/shop-view";
import "./market.css";

const CHANNELS = 40;
const ROOMS = 20;

/** Cloud market: pick a channel and a Free Market room and "teleport" there:
 *  the room as the game shows it, with every stall read in the last day.
 *  Tap a stall (or a name in the list) to open its shop; the shop view then
 *  steps through this room's stalls. */
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
  const channelTotal = (channel: number) => {
    let total = 0;
    for (let room = 1; room <= ROOMS; room++) total += counts.get(channel + ":" + room) || 0;
    return total;
  };
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
  const channel = asked("ch", CHANNELS) ?? busiest?.[0] ?? null;
  const room = asked("fm", ROOMS) ?? (channel === busiest?.[0] ? busiest?.[1] : null) ?? (channel ? 1 : null);
  const go = (ch: number, fm: number) => setParams({ ch: String(ch), fm: String(fm) }, { replace: true });
  const view = useMarketQuery<any>(
    channel && room ? `/api/v1/market/room?channel=${channel}&room=${room}` : "",
    !!(channel && room),
    true,
    true,
  );
  const stalls: any[] = useMemo(
    () => [...(view.data?.stalls || [])].sort((a, b) => a.y - b.y || a.x - b.x),
    [view.data],
  );
  const [open, setOpen] = useState<number | null>(null);
  const stops: ShopStop[] = stalls.map((s) => ({
    key: s.shop_key,
    row: { shop: s.title, owner_name: s.owner_name, channel, room },
  }));
  const pick = (stall: any) => setOpen(Math.max(0, stalls.findIndex((s) => s.shop_key === stall.shop_key)));
  const step = (d: number) => {
    if (!channel || !room) return;
    let ch = channel,
      fm = room + d;
    if (fm < 1) [ch, fm] = [ch > 1 ? ch - 1 : CHANNELS, ROOMS];
    if (fm > ROOMS) [ch, fm] = [ch < CHANNELS ? ch + 1 : 1, 1];
    go(ch, fm);
  };
  const shown = view.data && view.data.channel === channel && view.data.room === room;
  return (
    <div className="lwrap market-page">
      <section className="stall">
        <div className="stall-bar">
          <h1>{words("云逛市场", "Cloud market")}</h1>
        </div>
        <div className="mk-pick">
          <div className="mk-label">{words("频道", "Channel")}</div>
          <div className="mk-channels" role="group" aria-label={words("频道", "Channel")}>
            {Array.from({ length: CHANNELS }, (_, i) => i + 1).map((ch) => {
              const total = channelTotal(ch);
              return (
                <button
                  key={ch}
                  type="button"
                  className={"mk-ch" + (ch === channel ? " on" : "") + (total ? "" : " empty")}
                  aria-pressed={ch === channel}
                  title={words(`${ch}频道 · ${total} 个摊位`, `Channel ${ch} · ${total} stalls`)}
                  onClick={() => go(ch, room ?? 1)}
                >
                  {ch}
                </button>
              );
            })}
          </div>
          <div className="mk-label">{words("洞（点一下传送过去）", "Room (tap to teleport)")}</div>
          <div className="mk-rooms" role="group" aria-label={words("洞", "Room")}>
            {Array.from({ length: ROOMS }, (_, i) => i + 1).map((fm) => {
              const n = channel ? counts.get(channel + ":" + fm) || 0 : 0;
              return (
                <button
                  key={fm}
                  type="button"
                  className={"mk-room" + (fm === room ? " on" : "") + (n ? "" : " empty")}
                  aria-pressed={fm === room}
                  onClick={() => channel && go(channel, fm)}
                >
                  <b>{words(`${fm}洞`, "FM" + fm)}</b>
                  <small>{n ? words(`${n} 摊`, `${n}`) : "—"}</small>
                </button>
              );
            })}
          </div>
        </div>
        {!channel || !room ? (
          overview.isError ? (
            <p className="mk-none">{words("读不到市场概况。", "Could not load the market.")}</p>
          ) : (
            <Loading />
          )
        ) : (
          <div className="mk-here">
            <div className="mk-head">
              <button type="button" className="mk-step" onClick={() => step(-1)} aria-label={words("上一洞", "Previous room")}>
                <ChevronLeft aria-hidden="true" />
              </button>
              <h2>
                {words(`${channel}频道 · ${room}洞`, `Channel ${channel} · FM${room}`)}
                {shown && <small>{words(` · ${stalls.length} 个摊位`, ` · ${stalls.length} stalls`)}</small>}
              </h2>
              <button type="button" className="mk-step" onClick={() => step(1)} aria-label={words("下一洞", "Next room")}>
                <ChevronRight aria-hidden="true" />
              </button>
            </div>
            {view.isError ? (
              <p className="mk-none">{words("读不到这一洞。", "Could not load this room.")}</p>
            ) : !view.data ? (
              <Loading />
            ) : (
              <div className={shown ? "" : "mk-wait"}>
                <StallMap data={{ ...view.data, neighbors: view.data.stalls }} onPick={pick} open />
                {stalls.length ? (
                  <ul className="mk-stalls">
                    {stalls.map((s) => (
                      <li key={s.shop_key}>
                        <button type="button" onClick={() => pick(s)}>
                          <span>{s.title || words("未命名商店", "Untitled shop")}</span>
                          {s.owner_name && <small>{s.owner_name}</small>}
                        </button>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="mk-none">
                    {words("最近一天没有读到这一洞的摊位位置。", "No stall positions read in this room in the last day.")}
                  </p>
                )}
              </div>
            )}
          </div>
        )}
      </section>
      {open != null && stops[open] && (
        <ShopView stops={stops} at={open} browse onClose={() => setOpen(null)} />
      )}
    </div>
  );
}

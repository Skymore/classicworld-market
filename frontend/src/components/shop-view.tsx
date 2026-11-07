import { useEffect, useLayoutEffect, useRef, useState, type MutableRefObject } from "react";
import { useQuery } from "@tanstack/react-query";
import { ChevronLeft, ChevronRight, Maximize2, Minimize2, Store, UserRound, X } from "lucide-react";
import { readPeriod } from "/web/js/lib/period.js?v=20261022-regressions-1";
import { loadCatalog } from "../lib/catalog";
import { drawLook, nameTagOf, type Drawn, type Look, type NameTag, type TagPart } from "../lib/avatar";
import { useWords, usePreferences } from "../providers";
import { useMarketQuery } from "../lib/query";
import { Slot, Price, RelativeTime } from "./shared";
import { SiteLink } from "./shell";
import { EquipmentCard, pieceData } from "./equipment";
import { Desc, TipFlags, useTip } from "./item-tip";
import "./shop-view.css";

/** One shop the player can step to: its key and the row they came from. */
export type ShopStop = { key: string; row: any };

/** How each store permit looks in the game (UI RoomSession.img
 *  Balloon/backgrnd_PlayerShop/<permit>, which links 5140001-5140004 to
 *  ChatBalloon miniroom/PSSkin 1-4 and holds 5140005's own picture): the
 *  regular store is a sign over its owner's head, the others whole stalls
 *  standing on the owner's spot. Sizes are world pixels. */
const SKINS: Record<number, { skin: number; w: number; h: number; lift: number }> = {
  5140000: { skin: 0, w: 112, h: 63, lift: 88 },
  5140001: { skin: 1, w: 156, h: 159, lift: 0 },
  5140002: { skin: 2, w: 156, h: 159, lift: 0 },
  5140003: { skin: 3, w: 156, h: 159, lift: 0 },
  5140004: { skin: 4, w: 156, h: 159, lift: 0 },
  5140005: { skin: 5, w: 156, h: 159, lift: 0 },
};
const isEquipment = (row: any) => Math.floor(Number(row?.item_id) / 1000000) === 1;
/** A shop row's captured equipment, in either of the API's shapes. */
const pieceOf = (row: any) =>
  row?.equipment?.status === "candidate"
    ? row.equipment
    : row?.variant
      ? { ...row.variant, status: "candidate" }
      : null;

/** Where the shop title sits on each stall picture (world pixels, the
 *  picture's own box), as the game writes it. */
const SIGN: Record<number, { x: number; y: number; w: number; h: number }> = {
  0: { x: 5, y: 4, w: 100, h: 29 },
  1: { x: 28, y: 33, w: 99, h: 28 },
};

/** A stall's owner, drawn from their look like the game draws them. */
function Owner({ look }: { look: Look }) {
  const [drawn, setDrawn] = useState<Drawn | null>(null);
  useEffect(() => {
    let live = true;
    drawLook(look).then((d) => live && setDrawn(d));
    return () => {
      live = false;
    };
  }, [JSON.stringify(look)]);
  if (!drawn) return null;
  return (
    <img
      className="sv-owner-look"
      src={drawn.url}
      alt=""
      style={{ left: drawn.left, top: drawn.top, width: drawn.width, height: drawn.height }}
    />
  );
}

/** The owner's name under their feet: the game's plain tag, or the special
 *  tag of the name tag ring they wear. */
function OwnerName({ name, look }: { name: string; look?: Look }) {
  const [tag, setTag] = useState<NameTag | null>(null);
  useEffect(() => {
    let live = true;
    setTag(null);
    if (look) nameTagOf(look).then((t) => live && setTag(t));
    return () => {
      live = false;
    };
  }, [JSON.stringify(look?.equips)]);
  if (!tag) return <span className="sv-name">{name}</span>;
  const part = (p: TagPart, left: string | number, wide = false) => ({
    left,
    top: -p.o[1],
    width: wide ? "100%" : p.w,
    height: p.h,
    backgroundImage: `url(${p.p})`,
  });
  const argb = tag.clr >>> 0;
  const color = `rgb(${(argb >> 16) & 255},${(argb >> 8) & 255},${argb & 255})`;
  return (
    <span className="sv-name sv-tag" style={{ color }}>
      <i style={{ ...part(tag.c, -tag.c.o[0], true) }} />
      <i style={part(tag.w, -tag.w.o[0])} />
      <i style={part(tag.e, `calc(100% - ${tag.e.o[0]}px)`)} />
      <b>{name}</b>
    </span>
  );
}

/** The room as the game shows it: the scene with every stall read there,
 *  drawn with its permit's picture, the shop title on its sign, the owner
 *  standing at it and their name under their feet. Laid out in world pixels
 *  and scaled to the card; tapping the map opens it at full size. The shop on
 *  show sits in a spotlight; the others open on a tap. */
export function StallMap({
  data,
  onPick,
  open = false,
}: {
  data: any;
  onPick: (stall: any) => void;
  /** Start at full size (the room browser), not fitted to the card. */
  open?: boolean;
}) {
  const words = useWords();
  const scene = data.map?.scene;
  const box = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  const [big, setBig] = useState(open);
  useLayoutEffect(() => {
    const element = box.current;
    if (!element) return;
    const observer = new ResizeObserver(() => setWidth(element.clientWidth));
    observer.observe(element);
    setWidth(element.clientWidth);
    return () => observer.disconnect();
  }, [!!scene, big]);
  const stalls: any[] = [...(data.neighbors || [])];
  const mine = stalls.find((n) => n.shop_key === data.shop_key);
  if (data.stall && !mine)
    stalls.push({ ...data.stall, shop_key: data.shop_key, title: data.title, owner_name: data.owner_name });
  else if (mine && !mine.look && data.stall?.look) mine.look = data.stall.look;
  const here = stalls.find((n) => n.shop_key === data.shop_key);
  // Open at full size centred on the shop on show (else the room's middle).
  useLayoutEffect(() => {
    if (!big || !box.current || !scene) return;
    const element = box.current;
    const x = here ? here.x - scene.x : scene.w / 2;
    const y = here ? here.y - scene.y - 40 : scene.h / 2;
    element.scrollLeft = x - element.clientWidth / 2;
    element.scrollTop = y - element.clientHeight / 2;
  }, [big, data.shop_key, data.room, data.channel]);
  if (!scene?.url || !scene.w || !scene.h)
    return (
      <div className="sv-map sv-nomap">
        {data.room ? words("这一洞还没有地图", "No picture of this room yet") : words("位置未记录", "Place not recorded")}
      </div>
    );
  const inside = (n: any) => n.x >= scene.x && n.x <= scene.x + scene.w && n.y >= scene.y && n.y <= scene.y + scene.h;
  // Drawn in the game's order: lower on screen in front.
  const shown = stalls.filter(inside).sort((a, b) => a.y - b.y || a.x - b.x);
  const scale = big ? 1 : width ? width / scene.w : 0;
  const lookOf = (n: any) => SKINS[n.permit] || SKINS[5140000];
  const spot = here && {
    x: here.x - scene.x,
    y: here.y - scene.y - (lookOf(here).h + lookOf(here).lift) / 2,
    r: Math.max(lookOf(here).w, lookOf(here).h + lookOf(here).lift) * 0.75,
  };
  return (
    <div className="sv-mapwrap">
    <div
      ref={box}
      className={"sv-map" + (big ? " big" : "")}
      style={big ? { height: `min(62vh, ${scene.h + 4}px)` } : { aspectRatio: `${scene.w} / ${scene.h}` }}
    >
      <div
        className="sv-world"
        style={{ width: scene.w, height: scene.h, transform: `scale(${scale})`, visibility: scale ? undefined : "hidden" }}
      >
        <img
          className="sv-scene"
          src={big ? scene.url : String(scene.url).replace(/\/scenes\/(\d+\.webp)$/, "/scenes/small/$1")}
          alt={words(`${data.room}洞地图`, `Map of FM${data.room}`)}
          onClick={() => setBig(!big)}
        />
        {spot && (
          <i
            className="sv-spot"
            aria-hidden="true"
            style={{
              background: `radial-gradient(circle at ${spot.x}px ${spot.y}px, transparent ${spot.r}px, rgba(10,14,24,.6) ${spot.r * 1.8}px)`,
            }}
          >
            <b style={{ left: spot.x, top: spot.y, width: spot.r * 2, height: spot.r * 2 }} />
          </i>
        )}
        {shown.map((n) => {
          const current = n.shop_key === data.shop_key;
          const label = [n.title, n.owner_name].filter(Boolean).join(" · ");
          const look = lookOf(n);
          const sign = SIGN[look.skin ? 1 : 0];
          return (
            <button
              key={n.shop_key}
              type="button"
              className={"sv-stall" + (current ? " here" : "")}
              style={{ left: n.x - scene.x, top: n.y - scene.y }}
              title={label}
              aria-label={current ? words(`当前摊位 ${label}`, `This shop: ${label}`) : words(`看摊位 ${label}`, `Open shop ${label}`)}
              aria-current={current || undefined}
              onClick={() => !current && onPick(n)}
            >
              {/* The owner stands inside the stall: the stall is drawn over them, as in the game. */}
              {n.look && <Owner look={n.look} />}
              <span className="sv-booth" style={{ left: -look.w / 2, top: -look.lift - look.h, width: look.w, height: look.h }}>
                <img src={`/web/images/stalls/skin-${look.skin}.png`} alt="" />
                {n.title && (
                  <span className="sv-sign" style={{ left: sign.x, top: sign.y, width: sign.w, height: sign.h }}>
                    {n.title}
                  </span>
                )}
              </span>
              {n.owner_name && <OwnerName name={n.owner_name} look={n.look} />}
            </button>
          );
        })}
      </div>
    </div>
      <button
        type="button"
        className="sv-zoom"
        onClick={() => setBig(!big)}
        aria-label={big ? words("缩小地图", "Fit map") : words("放大地图", "Full-size map")}
        title={big ? words("缩小地图", "Fit map") : words("放大地图", "Full-size map")}
      >
        {big ? <Minimize2 aria-hidden="true" /> : <Maximize2 aria-hidden="true" />}
      </button>
    </div>
  );
}

/** Price, bundle, stock and time of a good, under its tooltip. */
function OfferLine({ row }: { row: any }) {
  const words = useWords();
  return (
    <div className="eq-offer">
      <div className="eq-offer-meta">
        <span>
          <b><Price value={row.price} /></b>
          {words(" 金币", " mesos")}
          {row.bundle > 1 && words(`/组（${row.bundle}个）`, `/set of ${row.bundle}`)}
        </span>
        {Number.isFinite(row.stock) && <span>{words("库存 ", "Stock ")}{row.stock}</span>}
        {row.time != null && <span><RelativeTime at={row.time} /></span>}
      </div>
    </div>
  );
}

/** The game tooltip of a use, etc, set-up or cash item: name, tags, icon
 *  and its description, as in the game; then this offer. */
function ItemTip({ row, item, tip }: { row: any; item: any; tip: any }) {
  const words = useWords();
  const { desc, flags } = useTip(tip);
  return (
    <div className="eq-card tip-card" data-item-tip={item.id}>
      <h2 className="eq-title">{words(item.name_zh || item.name_en, item.name_en || item.name_zh)}</h2>
      {flags.length > 0 && (
        <TipFlags flags={flags} />
      )}
      <div className="eq-top">
        <Slot empty url={item.icon_url || row.icon_url} size={40} />
        {desc ? <Desc text={desc} /> : <p className="tip-desc dim">{row.subcategory}</p>}
      </div>
      <OfferLine row={row} />
    </div>
  );
}

/** The selected good inside the shop view, as the game's tooltip:
 *  equipment the quick preview's card (requirements, jobs, stats against the
 *  catalogue, this offer), other goods their description and item data. */
function Info({ row, itemId, hold }: { row: any; itemId: number; hold: MutableRefObject<number> }) {
  const words = useWords();
  const equipment = isEquipment(row);
  const piece = equipment ? pieceOf(row) : null;
  // The same catalogue entry the quick preview reads (and caches).
  const url = `/item/${Number(row.item_id)}?hours=${readPeriod()}`;
  const catalog = useQuery<any>({
    queryKey: ["item-preview", url],
    queryFn: ({ signal }) => loadCatalog(url, signal, true),
    meta: { market: true },
    staleTime: 30000,
  });
  const page = catalog.data?.page;
  // Until its tooltip loads, the box keeps the last one's height, so the
  // view does not jump while stepping through goods and shops.
  const box = useRef<HTMLDivElement>(null);
  const ready = !!catalog.data || catalog.isError;
  useLayoutEffect(() => {
    if (ready && box.current) hold.current = box.current.offsetHeight;
  });
  const style = ready || !hold.current ? undefined : { minHeight: hold.current };
  const item = page?.item || { id: Number(row.item_id), name_zh: row.name_zh, name_en: row.name_en, icon_url: row.icon_url };
  const other = Number(row.item_id) !== itemId && (
    <div className="sv-info-foot">
      <SiteLink className="sv-open" href={"/item/" + Number(row.item_id)} data-no-preview="">
        {words("查看物品详情 →", "Open item details →")}
      </SiteLink>
    </div>
  );
  if (equipment) {
    const data = piece
      ? pieceData(piece, {
          inShop: true,
          price: row.price,
          set: row.bundle > 1,
          stock: Number.isFinite(row.stock) ? row.stock : null,
          at: row.time ?? null,
        })
      : undefined;
    return (
      <div ref={box} style={style} className="sv-info sv-info-card" aria-live="polite">
        <EquipmentCard
          item={item}
          equipment={page?.equipment}
          base={page?.market?.base_stats || []}
          piece={data ? JSON.parse(data) : undefined}
        />
        {!piece && (
          <div className="sv-pad">
            <p className="sv-dim">{words("没有采集到这件的属性", "Stats not captured")}</p>
            <OfferLine row={row} />
          </div>
        )}
        {other}
      </div>
    );
  }
  return (
    <div ref={box} style={style} className="sv-info sv-info-card" aria-live="polite">
      <ItemTip row={row} item={item} tip={page?.tip} />
      {other}
    </div>
  );
}

export function ShopCard({
  stop,
  itemId,
  stepping,
  browse,
  onPick,
}: {
  stop: ShopStop;
  itemId: number;
  /** More than one shop sells this item: the left/right steps do something. */
  stepping: boolean;
  /** In the room browser: swipes go through this room's stalls, then the next room. */
  browse: boolean;
  onPick: (stall: any) => void;
}) {
  const words = useWords();
  const query = useMarketQuery<any>("/api/v1/shop?key=" + encodeURIComponent(stop.key), true, true, true);
  const row = stop.row;
  const known = {
    shop_key: stop.key,
    title: row.shop,
    owner_name: row.owner_name,
    channel: row.channel ?? row.location?.channel,
    room: row.room ?? row.location?.room,
  };
  // Until the shop answers, the last shop stays in place (dimmed) under what
  // the row already knows, so nothing jumps; in the same room the map
  // already marks the new stall.
  const prev = query.isPlaceholderData ? query.data : null;
  const sameRoom =
    !!prev && (known.channel ?? prev.channel) === prev.channel && (known.room ?? prev.room) === prev.room;
  const data = prev
    ? {
        ...prev,
        ...known,
        channel: known.channel ?? prev.channel,
        room: known.room ?? prev.room,
        stall: (prev.neighbors || []).find((n: any) => n.shop_key === stop.key) || null,
      }
    : query.data || { ...known, items: [] };
  const waiting = !!prev;
  const hold = useRef(0);
  const items: any[] = data.items || [];
  // The good they came from: the same slot, else the same item.
  const start = Math.max(
    0,
    items.findIndex((r) => Number(r.item_id) === itemId && r.slot === row.slot),
    items.findIndex((r) => Number(r.item_id) === itemId),
  );
  // The good picked in this shop (a new shop starts on the one they came for).
  const [chosen, choose] = useState<{ key: string; at: number } | null>(null);
  const at = chosen?.key === stop.key && chosen.at < items.length ? chosen.at : start;
  const newest = waiting
    ? row.time ?? row.observed
    : Math.max(0, ...items.map((r: any) => r.time || 0)) || data.last_seen || row.observed;
  return (
    <div className={"sv-card" + (waiting ? " sv-wait" : "") + (waiting && !sameRoom ? " sv-wait-map" : "")} aria-busy={waiting || !query.data}>
      <div className="sv-top">
        <StallMap data={data} onPick={onPick} />
        <div className="sv-who">
          <h2 id="sv-title">
            <Store aria-hidden="true" />
            <span>{data.title || words("未命名商店", "Untitled shop")}</span>
          </h2>
          {data.owner_name && (
            <span className="sv-owner">
              <UserRound aria-hidden="true" />
              <b>{data.owner_name}</b>
            </span>
          )}
          <span className="loc sv-loc">
            <b>{data.channel == null ? words("频道 —", "CH —") : words(`${data.channel}频道`, "CH " + data.channel)}</b>
            <span>{data.room == null ? words("洞 —", "FM —") : words(`${data.room}洞`, "FM" + data.room)}</span>
          </span>
          <span className="sv-time">
            <RelativeTime at={newest} />
            {query.data && !waiting && !data.stall && <> · {words("摊位位置未采集", "Stall not captured")}</>}
          </span>
        </div>
      </div>
      {query.isError ? (
        <p className="sv-none">{words("读不到这家店的货。", "Could not load this shop.")}</p>
      ) : !query.data ? (
        <div className="sv-window sv-skeleton" aria-label={words("读取中…", "Loading…")}>
          <div className="sv-window-bar">
            <span>{words("商店物品", "Store items")}</span>
          </div>
          <ul className="sv-goods">
            {Array.from({ length: 10 }, (_, i) => (
              <li key={i}>
                <span className="sv-good" />
              </li>
            ))}
          </ul>
        </div>
      ) : !items.length ? (
        <p className="sv-none">{words("这家店现在没有在售的货。", "Nothing is on sale in this shop now.")}</p>
      ) : (
        <>
          <div className="sv-window">
            <div className="sv-window-bar">
              <span>{words("商店物品", "Store items")}</span>
              <span>{items.length}</span>
            </div>
            <ul className="sv-goods">
              {items.map((r, i) => (
                <li key={r.slot + ":" + r.item_id}>
                  <button
                    type="button"
                    className={"sv-good" + (i === at ? " on" : "") + (Number(r.item_id) === itemId ? " this" : "")}
                    aria-pressed={i === at}
                    aria-label={(r.name_zh || r.name_en || "") + " " + r.price}
                    title={r.name_zh || r.name_en}
                    onClick={() => choose({ key: stop.key, at: i })}
                  >
                    <span className="sv-slot">
                      <Slot url={r.icon_url} size={28} />
                      {r.bundle > 1 && <i>{r.bundle}</i>}
                    </span>
                    <small>
                      <Price value={r.price} />
                    </small>
                  </button>
                </li>
              ))}
            </ul>
          </div>
          <Info key={stop.key + ":" + at} row={items[at]} itemId={itemId} hold={hold} />
        </>
      )}
      {(stepping || (data.neighbors || []).length > 1) && (
        <ul className="sv-hints">
          {stepping &&
            (browse ? (
              <li>
                {words(
                  "左右滑动，或滑到顶/底再上下滑：换一家店；这一洞看完自动到下一洞",
                  "Swipe sideways, or up/down at the top/bottom: next shop; after the room's last, the next room",
                )}
              </li>
            ) : (
              <li>{words("← → 或左右滑动：看卖同一件商品的其他店", "← → or swipe: other shops selling this item")}</li>
            ))}
          {(data.neighbors || []).length > 1 && <li>{words("点地图上的摊位：看那家店的货", "Tap a stall on the map: see what it sells")}</li>}
        </ul>
      )}
    </div>
  );
}

/** The shop view: one shop at a time, with steps through the shops that sell this item. */
export default function ShopView({
  stops,
  at,
  itemId,
  onClose,
}: {
  stops: ShopStop[];
  at: number;
  itemId: number;
  onClose: () => void;
}) {
  const words = useWords();
  const dialog = useRef<HTMLDialogElement>(null);
  const [index, setIndex] = useState(at);
  // A stall picked on the map that does not sell this item: shown until the next step.
  const [visit, setVisit] = useState<ShopStop | null>(null);
  const n = stops.length;
  const step = (d: number) => {
    if (n < 2) return;
    setVisit(null);
    setIndex((i) => (((i + d) % n) + n) % n);
  };
  const pick = (stall: any) => {
    const known = stops.findIndex((s) => s.key === stall.shop_key);
    if (known >= 0) {
      setVisit(null);
      setIndex(known);
    } else
      setVisit({
        key: stall.shop_key,
        row: { shop: stall.title, owner_name: stall.owner_name },
      });
  };
  useEffect(() => {
    const element = dialog.current;
    if (element && !element.open) element.show();
    element?.focus();
    const key = (event: KeyboardEvent) => {
      if (event.key === "ArrowLeft") step(-1);
      if (event.key === "ArrowRight") step(1);
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("keydown", key);
    const html = document.documentElement,
      overflow = html.style.overflow;
    html.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", key);
      html.style.overflow = overflow;
    };
  }, [n]);
  const touch = useRef<{ x: number; y: number } | null>(null);
  const stop = visit || stops[index];
  if (!stop) return null;
  return (
    <>
      <div className="sv-scrim" onClick={onClose} />
      <dialog
        ref={dialog}
        className="sv-dialog stall"
        aria-labelledby="sv-title"
        aria-modal="true"
        tabIndex={-1}
        onTouchStart={(event) => {
          const t = event.touches[0];
          touch.current = { x: t.clientX, y: t.clientY };
        }}
        onTouchEnd={(event) => {
          const start = touch.current;
          touch.current = null;
          const t = event.changedTouches[0];
          if (!start || !t) return;
          const dx = t.clientX - start.x,
            dy = t.clientY - start.y;
          if (Math.abs(dx) > 60 && Math.abs(dx) > Math.abs(dy) * 1.5) step(dx < 0 ? 1 : -1);
        }}
      >
        <div className="stall-bar sv-bar">
          <button type="button" className="sv-step" disabled={n < 2} onClick={() => step(-1)} aria-label={words("上一家", "Previous shop")}>
            <ChevronLeft aria-hidden="true" />
          </button>
          <span className="sv-count" aria-live="polite">
            {visit ? words("同洞其他摊位", "Another stall here") : words(`第 ${index + 1} / ${n} 家`, `Shop ${index + 1} of ${n}`)}
          </span>
          <button type="button" className="sv-step" disabled={n < 2} onClick={() => step(1)} aria-label={words("下一家", "Next shop")}>
            <ChevronRight aria-hidden="true" />
          </button>
          <button type="button" className="sv-close" onClick={onClose} aria-label={words("关闭", "Close")}>
            <X aria-hidden="true" />
          </button>
        </div>
        <ShopCard stop={stop} itemId={itemId} stepping={n > 1} browse={false} onPick={pick} />
      </dialog>
    </>
  );
}

import { useEffect, useLayoutEffect, useRef, useState, type MutableRefObject } from "react";
import { useQuery } from "@tanstack/react-query";
import { ChevronLeft, ChevronRight, Store, UserRound, X } from "lucide-react";
import { readPeriod } from "/web/js/lib/period.js?v=20261022-regressions-1";
import { loadCatalog } from "../lib/catalog";
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

/** The room's scene with every stall read there, each drawn with its store
 *  permit's picture; the shop on show stands out, the others open on a tap. */
function StallMap({ data, onPick }: { data: any; onPick: (stall: any) => void }) {
  const words = useWords();
  const scene = data.map?.scene;
  if (!scene?.url || !scene.w || !scene.h)
    return (
      <div className="sv-map sv-nomap">
        {data.room ? words("这一洞还没有地图", "No picture of this room yet") : words("位置未记录", "Place not recorded")}
      </div>
    );
  const stalls: any[] = [...(data.neighbors || [])];
  if (data.stall && !stalls.some((n) => n.shop_key === data.shop_key))
    stalls.push({ ...data.stall, shop_key: data.shop_key, title: data.title, owner_name: data.owner_name });
  const inside = (n: any) => n.x >= scene.x && n.x <= scene.x + scene.w && n.y >= scene.y && n.y <= scene.y + scene.h;
  // Drawn to the map's own scale, standing on the spot the owner stands on.
  const place = (n: any) => {
    const look = SKINS[n.permit] || SKINS[5140000];
    return {
      look,
      style: {
        left: ((n.x - scene.x) / scene.w) * 100 + "%",
        top: ((n.y - look.lift - scene.y) / scene.h) * 100 + "%",
        width: (look.w / scene.w) * 100 + "%",
      },
    };
  };
  // The shop on show last, so it draws on top.
  const shown = stalls.filter(inside).sort((a, b) => Number(a.shop_key === data.shop_key) - Number(b.shop_key === data.shop_key));
  return (
    <div className="sv-map" style={{ aspectRatio: `${scene.w} / ${scene.h}` }}>
      <img
        className="sv-scene"
        src={String(scene.url).replace(/\/scenes\/(\d+\.webp)$/, "/scenes/small/$1")}
        alt={words(`${data.room}洞地图`, `Map of FM${data.room}`)}
      />
      {shown.map((n) => {
        const here = n.shop_key === data.shop_key;
        const label = [n.title, n.owner_name].filter(Boolean).join(" · ");
        const { look, style } = place(n);
        return (
          <button
            key={n.shop_key}
            type="button"
            className={"sv-stall" + (here ? " here" : "")}
            style={style}
            title={label}
            aria-label={here ? words(`当前摊位 ${label}`, `This shop: ${label}`) : words(`看摊位 ${label}`, `Open shop ${label}`)}
            aria-current={here || undefined}
            onClick={() => !here && onPick(n)}
          >
            <img src={`/web/images/stalls/skin-${look.skin}.png`} alt="" style={{ aspectRatio: `${look.w} / ${look.h}` }} />
          </button>
        );
      })}
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
 *  with its description, then what the client's data says it does. */
function ItemTip({ row, item, tip }: { row: any; item: any; tip: any }) {
  const words = useWords();
  const { desc, flags, lines } = useTip(tip);
  const colon = words("：", ": ");
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
      {lines.length > 0 && (
        <dl className="eq-lines">
          {lines.map(([label, value, tone], i) => (
            <div key={i} className={tone || ""}>
              <dt>{label}{colon}</dt>
              <dd>{value}</dd>
            </div>
          ))}
        </dl>
      )}
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

function ShopCard({
  stop,
  itemId,
  stepping,
  onPick,
}: {
  stop: ShopStop;
  itemId: number;
  /** More than one shop sells this item: the left/right steps do something. */
  stepping: boolean;
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
          {stepping && <li>{words("← → 或左右滑动：看卖同一件商品的其他店", "← → or swipe: other shops selling this item")}</li>}
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
        <ShopCard stop={stop} itemId={itemId} stepping={n > 1} onPick={pick} />
      </dialog>
    </>
  );
}

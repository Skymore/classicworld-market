import { useEffect, useRef, useState } from "react";
import { ChevronLeft, ChevronRight, X } from "lucide-react";
import { useWords, usePreferences } from "../providers";
import { useMarketQuery } from "../lib/query";
import { Slot, Price, RelativeTime } from "./shared";
import { SiteLink } from "./shell";
import { pieceData } from "./equipment";
import { equipmentSummary } from "/web/js/lib/equipment-summary.js?v=20261029-critical-1";
import "./shop-view.css";

/** One shop the player can step to: its key and the row they came from. */
export type ShopStop = { key: string; row: any };

/** Store permits set how a stall looks in the game. */
const PERMITS: Record<number, { zh: string; en: string; color: string }> = {
  5140000: { zh: "普通摊位", en: "Regular store", color: "#b98a52" },
  5140001: { zh: "蓝色树摊", en: "Sky-blue tree store", color: "#4fa3d9" },
  5140002: { zh: "粉色树摊", en: "Pink tree store", color: "#e57aa8" },
  5140003: { zh: "橙色树摊", en: "Orange tree store", color: "#e8892c" },
  5140004: { zh: "绿色树摊", en: "Green tree store", color: "#4f9e4a" },
  5140005: { zh: "特别摊位", en: "Special store", color: "#8a62c4" },
};
const permitOf = (id?: number | null) =>
  id == null ? null : PERMITS[id] || { zh: "摊位", en: "Store", color: "#8b8b8b" };

function StallMap({ data }: { data: any }) {
  const words = useWords();
  const scene = data.map?.scene;
  const stall = data.stall;
  const permit = permitOf(stall?.permit);
  if (!scene?.url || !scene.w || !scene.h)
    return (
      <div className="sv-map sv-nomap">
        {data.room ? words("这一洞还没有地图", "No picture of this room yet") : words("位置未记录", "Place not recorded")}
      </div>
    );
  const inside =
    stall && stall.x >= scene.x && stall.x <= scene.x + scene.w && stall.y >= scene.y && stall.y <= scene.y + scene.h;
  const left = inside ? ((stall.x - scene.x) / scene.w) * 100 : 0;
  const top = inside ? ((stall.y - scene.y) / scene.h) * 100 : 0;
  return (
    <div className="sv-map" style={{ aspectRatio: `${scene.w} / ${scene.h}` }}>
      <img
        src={String(scene.url).replace(/\/scenes\/(\d+\.webp)$/, "/scenes/small/$1")}
        alt={words(`${data.room}洞地图`, `Map of FM${data.room}`)}
      />
      {inside && (
        <span
          className="sv-pin"
          style={{ left: left + "%", top: top + "%", "--stall": permit!.color } as any}
          title={words(permit!.zh, permit!.en)}
        >
          <i aria-hidden="true" />
          <b>{words("这家", "Here")}</b>
        </span>
      )}
    </div>
  );
}

function Goods({ data, itemId, sale }: { data: any; itemId: number; sale?: boolean }) {
  const words = useWords();
  const { language } = usePreferences();
  const items: any[] = data.items || [];
  if (!items.length)
    return <p className="sv-none">{words("这家店现在没有在售的货。", "Nothing is on sale in this shop now.")}</p>;
  return (
    <ul className="sv-goods">
      {items.map((row) => {
        const here = Number(row.item_id) === itemId;
        const equip = equipmentSummary(row, language === "en");
        const name = language === "en" ? row.name_en || row.name_zh : row.name_zh || row.name_en;
        const piece =
          Math.floor(Number(row.item_id) / 1000000) === 1
            ? pieceData(row.equipment, {
                channel: data.channel ?? null,
                room: data.room ?? null,
                place: null,
                shop: data.title || null,
                owner: data.owner_name || null,
                price: row.unit_price,
                set: row.unit_basis === "set",
                stock: Number.isFinite(row.stock) ? row.stock : null,
                at: row.time,
                expired: false,
                sale: !!sale,
              })
            : undefined;
        const content = (
          <>
            <span className="sv-slot">
              <Slot url={row.icon_url} size={32} />
              {row.bundle > 1 && <i>{row.bundle}</i>}
            </span>
            <span className="sv-name">
              <b>{name}</b>
              {equip && <small className="sv-equip">{equip}</small>}
            </span>
            <span className="sv-price">
              <b>
                <Price value={row.price} />
              </b>
              <small>
                {row.bundle > 1 ? words(`每组 ${row.bundle} 个`, `per ${row.bundle}`) : words("每个", "each")}
                {" · "}
                {words("库存", "stock")} {row.stock}
              </small>
            </span>
          </>
        );
        return (
          <li key={row.slot + ":" + row.item_id}>
            {here ? (
              <span className="sv-good here" data-piece-item={piece ? Number(row.item_id) : undefined} data-piece={piece} tabIndex={piece ? 0 : undefined}>
                {content}
              </span>
            ) : (
              <SiteLink className="sv-good" href={"/item/" + Number(row.item_id)} data-piece-item={piece ? Number(row.item_id) : undefined} data-piece={piece}>
                {content}
              </SiteLink>
            )}
          </li>
        );
      })}
    </ul>
  );
}

function ShopCard({ stop, itemId }: { stop: ShopStop; itemId: number }) {
  const words = useWords();
  const query = useMarketQuery<any>("/api/v1/shop?key=" + encodeURIComponent(stop.key));
  const row = stop.row;
  // Until the shop answers, show what the row already knows.
  const data = query.data || {
    title: row.shop,
    owner_name: row.owner_name,
    channel: row.channel ?? row.location?.channel,
    room: row.room ?? row.location?.room,
    items: [],
  };
  const permit = permitOf(data.stall?.permit);
  const newest = Math.max(0, ...(data.items || []).map((r: any) => r.time || 0)) || data.last_seen || row.observed;
  return (
    <div className="sv-card">
      <div className="sv-head">
        <div className="sv-who">
          <h2 id="sv-title">{data.title || words("未命名商店", "Untitled shop")}</h2>
          <span>
            {data.owner_name && <b>{data.owner_name}</b>}
            {data.owner_name && " · "}
            {query.data ? words(`${data.items.length} 件货`, `${data.items.length} items`) : words("读取中…", "Loading…")}
            {" · "}
            <RelativeTime at={newest} />
          </span>
        </div>
        <span className="loc sv-loc">
          <b>{data.channel == null ? words("频道 —", "CH —") : words(`${data.channel}频道`, "CH " + data.channel)}</b>
          <span>{data.room == null ? words("洞 —", "FM —") : words(`${data.room}洞`, "FM" + data.room)}</span>
        </span>
      </div>
      <div className="sv-body">
        <div className="sv-where">
          <StallMap data={data} />
          <p className="sv-caption">
            {permit ? (
              <>
                <i className="sv-swatch" style={{ background: permit.color }} />
                {words(permit.zh, permit.en)}
                {" · "}
                {words("位置", "seen")} <RelativeTime at={data.stall.seen} />
              </>
            ) : (
              words("摊位位置还没采集到", "Stall position not captured yet")
            )}
          </p>
        </div>
        <div className="sv-window">
          <div className="sv-window-bar">
            <span>{words("商店物品", "Store items")}</span>
            <span>{query.data ? data.items.length : "…"}</span>
          </div>
          {query.isError ? (
            <p className="sv-none">{words("读不到这家店的货。", "Could not load this shop.")}</p>
          ) : query.data ? (
            <Goods data={data} itemId={itemId} />
          ) : (
            <p className="sv-none">{words("读取中…", "Loading…")}</p>
          )}
        </div>
      </div>
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
  const n = stops.length;
  const step = (d: number) => n > 1 && setIndex((i) => (((i + d) % n) + n) % n);
  // Not modal: the equipment tooltip (`ItemPreview`, portalled to <body>)
  // must draw above it, and the top layer would hide it.
  useEffect(() => {
    const element = dialog.current;
    if (element && !element.open) element.show();
    element?.focus();
    const key = (event: KeyboardEvent) => {
      if (event.key === "ArrowLeft") step(-1);
      if (event.key === "ArrowRight") step(1);
      if (event.key === "Escape" && !document.querySelector(".item-peek:not([hidden])")) onClose();
    };
    document.addEventListener("keydown", key);
    const html = document.documentElement, overflow = html.style.overflow;
    html.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", key);
      html.style.overflow = overflow;
    };
  }, [n]);
  const touch = useRef<{ x: number; y: number } | null>(null);
  const stop = stops[index];
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
          {words(`第 ${index + 1} / ${n} 家`, `Shop ${index + 1} of ${n}`)}
        </span>
        <button type="button" className="sv-step" disabled={n < 2} onClick={() => step(1)} aria-label={words("下一家", "Next shop")}>
          <ChevronRight aria-hidden="true" />
        </button>
        <button type="button" className="sv-close" onClick={onClose} aria-label={words("关闭", "Close")}>
          <X aria-hidden="true" />
        </button>
      </div>
      <ShopCard key={stop.key} stop={stop} itemId={itemId} />
      <p className="sv-hint">{words("← → 或左右滑动换一家 · 点外面关闭", "← → or swipe for the next shop · click outside to close")}</p>
    </dialog>
    </>
  );
}

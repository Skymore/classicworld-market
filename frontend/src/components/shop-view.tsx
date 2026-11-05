import { useEffect, useRef, useState } from "react";
import { ChevronLeft, ChevronRight, X } from "lucide-react";
import { useWords, usePreferences } from "../providers";
import { useMarketQuery } from "../lib/query";
import { Slot, Price, RelativeTime } from "./shared";
import { SiteLink } from "./shell";
import { cardStats } from "./equipment";
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
const isEquipment = (row: any) => Math.floor(Number(row?.item_id) / 1000000) === 1;
/** A shop row's captured equipment, in either of the API's shapes. */
const pieceOf = (row: any) =>
  row?.equipment?.status === "candidate"
    ? row.equipment
    : row?.variant
      ? { ...row.variant, status: "candidate" }
      : null;

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
  return (
    <div className="sv-map" style={{ aspectRatio: `${scene.w} / ${scene.h}` }}>
      <img
        src={String(scene.url).replace(/\/scenes\/(\d+\.webp)$/, "/scenes/small/$1")}
        alt={words(`${data.room}洞地图`, `Map of FM${data.room}`)}
      />
      {inside && (
        <span
          className="sv-pin"
          style={
            {
              left: ((stall.x - scene.x) / scene.w) * 100 + "%",
              top: ((stall.y - scene.y) / scene.h) * 100 + "%",
              "--stall": permit!.color,
            } as any
          }
          title={words(permit!.zh, permit!.en)}
        >
          <i aria-hidden="true" />
        </span>
      )}
    </div>
  );
}

/** The selected good, laid out like the game's tooltip, inside the shop view. */
function Info({ row, itemId, base }: { row: any; itemId: number; base: any[] }) {
  const words = useWords();
  const { language } = usePreferences();
  const name = language === "en" ? row.name_en || row.name_zh : row.name_zh || row.name_en;
  const piece = isEquipment(row) ? pieceOf(row) : null;
  // Bonuses only where the catalogue base is known: the page's own item.
  const stats = piece ? cardStats(Number(row.item_id) === itemId ? base : [], piece) : [];
  const enhanced = Number(piece?.enhancements) > 0 ? Number(piece.enhancements) : 0;
  const kind = [row.subcategory, row.level ? words(`等级 ${row.level}`, `Lv ${row.level}`) : null]
    .filter(Boolean)
    .join(" · ");
  return (
    <div className="sv-info" aria-live="polite">
      <div className="sv-info-head">
        <Slot url={row.icon_url} size={32} />
        <div>
          <b>
            {name}
            {enhanced > 0 && <em> (+{enhanced})</em>}
          </b>
          {kind && <small>{kind}</small>}
        </div>
      </div>
      {piece ? (
        <div className="sv-stats">
          {stats.map((stat) => (
            <span key={stat.key}>
              {words(stat.label[0], stat.label[1])} {stat.value}
              {stat.bonus > 0 && <i> (+{stat.bonus})</i>}
            </span>
          ))}
          {Number.isInteger(piece.remaining_upgrades) && (
            <span className="dim">{words(`可升级 ${piece.remaining_upgrades} 次`, `${piece.remaining_upgrades} upgrades left`)}</span>
          )}
        </div>
      ) : isEquipment(row) ? (
        <p className="sv-dim">{words("没有采集到这件的属性", "Stats not captured")}</p>
      ) : null}
      <div className="sv-buy">
        <span className="dim">
          {row.bundle > 1 ? words(`每组 ${row.bundle} 个`, `${row.bundle} per bundle`) : words("每个", "each")}
          {" · "}
          {words("库存", "stock")} {row.stock}
        </span>
        <b>
          <Price value={row.price} />
        </b>
      </div>
      {Number(row.item_id) !== itemId && (
        <SiteLink className="sv-open" href={"/item/" + Number(row.item_id)} data-no-preview="">
          {words("看这个物品 ›", "Open this item ›")}
        </SiteLink>
      )}
    </div>
  );
}

function ShopCard({ stop, itemId, base }: { stop: ShopStop; itemId: number; base: any[] }) {
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
  const items: any[] = data.items || [];
  // The good they came from: the same slot, else the same item.
  const start = Math.max(
    0,
    items.findIndex((r) => Number(r.item_id) === itemId && r.slot === row.slot),
    items.findIndex((r) => Number(r.item_id) === itemId),
  );
  const [chosen, choose] = useState<number | null>(null);
  const at = chosen != null && chosen < items.length ? chosen : start;
  const permit = permitOf(data.stall?.permit);
  const newest = Math.max(0, ...items.map((r: any) => r.time || 0)) || data.last_seen || row.observed;
  return (
    <div className="sv-card">
      <div className="sv-top">
        <StallMap data={data} />
        <div className="sv-who">
          <h2 id="sv-title">{data.title || words("未命名商店", "Untitled shop")}</h2>
          <span>
            {data.owner_name && <b>{data.owner_name}</b>}
            {data.owner_name && " · "}
            <RelativeTime at={newest} />
          </span>
          <span className="loc sv-loc">
            <b>{data.channel == null ? words("频道 —", "CH —") : words(`${data.channel}频道`, "CH " + data.channel)}</b>
            <span>{data.room == null ? words("洞 —", "FM —") : words(`${data.room}洞`, "FM" + data.room)}</span>
          </span>
          <span className="sv-caption">
            {permit ? (
              <>
                <i className="sv-swatch" style={{ background: permit.color }} />
                {words(permit.zh, permit.en)}
              </>
            ) : (
              words("摊位位置未采集", "Stall not captured")
            )}
          </span>
        </div>
      </div>
      {query.isError ? (
        <p className="sv-none">{words("读不到这家店的货。", "Could not load this shop.")}</p>
      ) : !query.data ? (
        <p className="sv-none">{words("读取中…", "Loading…")}</p>
      ) : !items.length ? (
        <p className="sv-none">{words("这家店现在没有在售的货。", "Nothing is on sale in this shop now.")}</p>
      ) : (
        <>
          <Info row={items[at]} itemId={itemId} base={base} />
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
                    onClick={() => choose(i)}
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
        </>
      )}
    </div>
  );
}

/** The shop view: one shop at a time, with steps through the shops that sell this item. */
export default function ShopView({
  stops,
  at,
  itemId,
  base = [],
  onClose,
}: {
  stops: ShopStop[];
  at: number;
  itemId: number;
  /** The page item's catalogue base stats, for (+N) bonuses. */
  base?: any[];
  onClose: () => void;
}) {
  const words = useWords();
  const dialog = useRef<HTMLDialogElement>(null);
  const [index, setIndex] = useState(at);
  const n = stops.length;
  const step = (d: number) => n > 1 && setIndex((i) => (((i + d) % n) + n) % n);
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
        <ShopCard key={stop.key} stop={stop} itemId={itemId} base={base} />
      </dialog>
    </>
  );
}

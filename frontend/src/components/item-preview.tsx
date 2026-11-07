import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useLocation } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { readPeriod } from "/web/js/lib/period.js?v=20261022-regressions-1";
import { trapFocus } from "/web/js/lib/dialog.js";
import { watchIds, toggleWatch } from "/web/js/lib/watch-ids.js";
import { loadCatalog } from "../lib/catalog";
import { timestamp } from "../lib/item-market";
import { usePreferences, useWords } from "../providers";
import { Icon, Slot, RelativeTime } from "./shared";
import { EquipmentCard, EquipmentPeek } from "./equipment";
import { TipPeek } from "./item-tip";
import { ensureStyle } from "../lib/styles";
import { secondaryLanguage } from "/web/js/lib/i18n.js";
type Hit = {
  anchor: HTMLElement;
  id: number;
  touch?: boolean;
  pinned?: boolean;
  rect?: DOMRect;
  // One listed equipment piece (`data-piece`): show its game tooltip.
  piece?: any;
};
export function previewItem(target: Element, origin: string): Hit | null {
  // A listing row of captured equipment, with or without its own item link.
  const row = target.closest<HTMLElement>("[data-piece-item]");
  if (row && !row.closest(".item-peek") && !row.hasAttribute("data-no-preview")) {
    let piece = null;
    try {
      piece = JSON.parse(row.dataset.piece || "null");
    } catch {}
    const id = Number(row.dataset.pieceItem);
    if (piece && Number.isInteger(id) && id > 0) return { anchor: row, id, piece };
  }
  const anchor = target.closest<HTMLElement>("a[href],tr[data-open]");
  if (
    !anchor ||
    anchor.closest(".item-peek") ||
    anchor.hasAttribute("data-no-preview")
  )
    return null;
  if (anchor.matches("tr[data-open]"))
    return /^\d+$/.test(anchor.dataset.open || "")
      ? { anchor, id: Number(anchor.dataset.open) }
      : null;
  let url;
  try {
    url = new URL((anchor as HTMLAnchorElement).href, origin);
  } catch {
    return null;
  }
  const match = url.origin === origin && /^\/item\/(\d+)$/.exec(url.pathname);
  if (url.searchParams.has("variant")) return null;
  return match ? { anchor, id: Number(match[1]) } : null;
}
// Beside the anchor's first `reach` pixels (an item name); a whole listing
// row passes Infinity so its tooltip never covers the rows below it.
export function previewPosition(
  anchor: DOMRect | any,
  box: DOMRect | any,
  viewport: { width: number; height: number },
  reach = 300,
) {
  const right = Math.min(anchor.right, anchor.left + reach) + 12,
    left =
      right + box.width <= viewport.width - 12
        ? right
        : anchor.left - 12 - box.width;
  return {
    left: Math.max(12, Math.min(left, viewport.width - box.width - 12)),
    top: Math.max(12, Math.min(anchor.top, viewport.height - box.height - 12)),
  };
}
export const previewEntry = () =>
  !!(history.state as { preview?: boolean } | null)?.preview;
export default function ItemPreview() {
  const words = useWords(),
    { language, ready } = usePreferences(),
    route = useLocation();
  const [hit, setHit] = useState<Hit | null>(null),
    [position, setPosition] = useState({ left: 12, top: 12 });
  const [watched, setWatched] = useState<number[]>(watchIds);
  const watching = !!hit && watched.includes(hit.id);
  const watchFull = !watching && watched.length >= 100;
  useEffect(() => {
    const update = () => setWatched(watchIds());
    document.addEventListener("watchchange", update);
    window.addEventListener("storage", update);
    return () => {
      document.removeEventListener("watchchange", update);
      window.removeEventListener("storage", update);
    };
  }, []);
  const active = useRef(hit),
    popup = useRef<HTMLElement>(null),
    restoring = useRef(false),
    backing = useRef(false);
  active.current = hit;
  const url = hit ? `/item/${hit.id}?hours=${readPeriod()}` : "";
  const query = useQuery<any>({
    queryKey: ["item-preview", url],
    enabled: !!hit,
    queryFn: ({ signal }) => loadCatalog(url, signal, true),
    meta: { market: true },
    staleTime: 30000,
  });
  // The touch sheet has its own history entry, so the back button closes it first.
  // Dismissing it takes the entry back out; following its link replaces the entry.
  function close(restore = false, leaving = false) {
    const previous = active.current;
    if (previous?.touch && previewEntry() && !leaving && !backing.current) {
      backing.current = true;
      history.back();
    }
    if (previous) {
      previous.anchor.removeAttribute("aria-controls");
      previous.anchor.removeAttribute("aria-expanded");
      if (restore) {
        const target = previous.anchor.isConnected
          ? previous.anchor
          : document.querySelector<HTMLElement>("main");
        if (target) {
          const temporary = !target.hasAttribute("tabindex");
          if (temporary) target.setAttribute("tabindex", "-1");
          restoring.current = true;
          target.focus({ preventScroll: true });
          restoring.current = false;
          if (temporary) target.removeAttribute("tabindex");
        }
      }
    }
    setHit(null);
  }
  function place() {
    const current = active.current,
      box = popup.current;
    if (!current || current.touch || !box) return;
    if (current.anchor.isConnected)
      current.rect = current.anchor.getBoundingClientRect();
    if (current.rect)
      setPosition(
        previewPosition(
          current.rect,
          box.getBoundingClientRect(),
          { width: innerWidth, height: innerHeight },
          current.piece ? Infinity : 300,
        ),
      );
  }
  useEffect(() => {
    void ensureStyle("item-preview").then(place);
    let timer: ReturnType<typeof setTimeout>,
      leave: ReturnType<typeof setTimeout>;
    const open = (next: Hit) => {
      clearTimeout(timer);
      clearTimeout(leave);
      const current = active.current;
      // Same anchor: keep it, but a click pins a hover card and a tap turns
      // it into the touch sheet (which needs its own history entry below).
      if (current?.anchor === next.anchor && !(next.touch && !current.touch)) {
        if (next.pinned && !current.pinned) setHit({ ...current, pinned: true });
        if (next.pinned)
          requestAnimationFrame(() =>
            popup.current?.querySelector<HTMLButtonElement>("button")?.focus(),
          );
        return;
      }
      active.current?.anchor.removeAttribute("aria-controls");
      active.current?.anchor.removeAttribute("aria-expanded");
      next.anchor.setAttribute("aria-controls", "item-quick-preview");
      next.anchor.setAttribute("aria-expanded", "true");
      next.rect = next.anchor.getBoundingClientRect();
      if (next.touch && !previewEntry())
        history.pushState({ ...history.state, preview: true }, "");
      setHit(next);
      if (next.touch || next.pinned)
        requestAnimationFrame(() =>
          popup.current?.querySelector<HTMLButtonElement>("button")?.focus(),
        );
    };
    const over = (event: PointerEvent) => {
      if (event.pointerType === "touch" || innerWidth <= 640) return;
      const target = event.target as Element;
      if (popup.current?.contains(target)) {
        clearTimeout(leave);
        return;
      }
      if (target.closest("button,input,select")) return;
      const next = previewItem(target, location.origin);
      if (next) {
        clearTimeout(timer);
        clearTimeout(leave);
        timer = setTimeout(() => open(next), 180);
      }
    };
    const out = (event: PointerEvent) => {
      if (active.current?.pinned) return;
      const next = previewItem(event.target as Element, location.origin);
      if (
        next?.anchor.contains(event.relatedTarget as Node) ||
        popup.current?.contains(event.relatedTarget as Node)
      )
        return;
      clearTimeout(timer);
      clearTimeout(leave);
      if (active.current) leave = setTimeout(() => close(), 180);
    };
    const focus = (event: FocusEvent) => {
      if (restoring.current || popup.current?.contains(event.target as Node))
        return;
      const target = event.target as Element;
      if (target.closest("button,input,select")) return;
      const next = previewItem(target, location.origin);
      clearTimeout(timer);
      if (next) timer = setTimeout(() => open(next), 180);
      else if (!active.current?.pinned) close();
    };
    const click = (event: MouseEvent) => {
      if (popup.current?.contains(event.target as Node)) return;
      const target = event.target as Element;
      if (target.closest("[data-shop-row]")) {
        close();
        return;
      }
      const next =
        !target.closest("button,input,select") &&
        previewItem(target, location.origin);
      if (
        next &&
        event.detail > 0 &&
        !event.metaKey &&
        !event.ctrlKey &&
        !event.shiftKey &&
        !event.altKey &&
        (innerWidth <= 640 || matchMedia("(pointer:coarse)").matches)
      ) {
        event.preventDefault();
        event.stopPropagation();
        open({ ...next, touch: true, pinned: true });
        return;
      }
      // A listing row without its own link (the item page's): a click pins
      // its tooltip. Rows that link to the item still follow the link.
      if (next && next.piece && event.detail > 0 && !target.closest("a[href]")) {
        open({ ...next, pinned: true });
        return;
      }
      close();
    };
    const key = (event: KeyboardEvent) => {
      if (event.altKey && event.key === "ArrowDown") {
        const next = previewItem(event.target as Element, location.origin);
        if (next) {
          event.preventDefault();
          event.stopPropagation();
          open({ ...next, touch: innerWidth <= 640, pinned: true });
          return;
        }
      }
      if (!active.current) return;
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        close(popup.current?.contains(document.activeElement));
      } else if (event.key === "Tab" && active.current.touch && popup.current)
        trapFocus(popup.current, event);
    };
    const scroll = (event: Event) => {
      if (!active.current || popup.current?.contains(event.target as Node))
        return;
      if (!active.current.pinned) close();
      else place();
    };
    const pop = () => {
      backing.current = false;
      if (active.current?.touch && !previewEntry()) close();
    };
    document.addEventListener("pointerover", over);
    document.addEventListener("pointerout", out);
    document.addEventListener("focusin", focus);
    document.addEventListener("click", click, true);
    document.addEventListener("keydown", key, true);
    document.addEventListener("scroll", scroll, true);
    window.addEventListener("resize", place);
    window.addEventListener("popstate", pop);
    return () => {
      clearTimeout(timer);
      clearTimeout(leave);
      document.removeEventListener("pointerover", over);
      document.removeEventListener("pointerout", out);
      document.removeEventListener("focusin", focus);
      document.removeEventListener("click", click, true);
      document.removeEventListener("keydown", key, true);
      document.removeEventListener("scroll", scroll, true);
      window.removeEventListener("resize", place);
      window.removeEventListener("popstate", pop);
    };
  }, []);
  useEffect(() => close(), [route.pathname, route.search]);
  useLayoutEffect(place, [hit, query.data]);
  useEffect(() => {
    const element = popup.current;
    if (!element) return;
    const observer = new ResizeObserver(place);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  const page = query.data?.page,
    item = page?.item,
    stats = page?.stats,
    piece = hit?.piece,
    // On the item's own page the tooltip needs no link back to it.
    here = !!item && route.pathname === `/item/${item.id}`,
    format = (value: number | null | undefined) =>
      value == null
        ? "—"
        : Number(value).toLocaleString(undefined, {
            maximumFractionDigits: 20,
          });
  const labels: Record<string, [string, string]> = {
    critical_rate: ["暴击率", "Critical Rate"],
    critical_damage: ["暴击伤害", "Critical Damage"],
    weapon_attack: ["物理攻击", "Weapon ATT"],
    magic_attack: ["魔法攻击", "Magic ATT"],
    weapon_defense: ["物理防御", "Weapon DEF"],
    magic_defense: ["魔法防御", "Magic DEF"],
    str: ["力量", "STR"],
    dex: ["敏捷", "DEX"],
    int: ["智力", "INT"],
    luk: ["幸运", "LUK"],
    accuracy: ["命中", "Accuracy"],
    avoid: ["回避", "Avoidability"],
    speed: ["移动速度", "Speed"],
    jump: ["跳跃", "Jump"],
    hp: ["最大生命", "Max HP"],
    mp: ["最大魔法", "Max MP"],
  };
  return createPortal(
    <>
      <div
        className="peek-scrim"
        hidden={!hit?.touch}
        onClick={() => close(true)}
      />
      <aside
        id="item-quick-preview"
        className={
          "item-peek" +
          (hit?.touch ? " is-mobile" : "") +
          (piece ? " is-piece" : "") +
          (hit?.pinned ? " is-pinned" : "")
        }
        hidden={!hit}
        ref={popup}
        role="dialog"
        aria-modal={!!hit?.touch}
        aria-label={
          piece
            ? words("这件装备的属性", "This piece's stats")
            : words("物品快速预览", "Quick item preview")
        }
        aria-labelledby="item-preview-name"
        style={
          hit?.touch ? undefined : { left: position.left, top: position.top }
        }
      >
        <button
          type="button"
          className="peek-close"
          aria-label={words("关闭预览", "Close preview")}
          onClick={() => close(true)}
        >
          ×
        </button>
        {!item ? (
          <div className="peek-loading">
            <h2 id="item-preview-name">
              {query.isError
                ? words("预览暂不可用", "Preview unavailable")
                : words("正在读取物品…", "Loading item…")}
            </h2>
            {query.isError && (
              <a href={url} onClick={() => close(false, true)}>
                {words("打开完整详情 →", "Open full details →")}
              </a>
            )}
          </div>
        ) : piece ? (
          <div className="peek-content peek-piece" data-preview-item={item.id} data-preview-piece>
            <EquipmentCard
              item={item}
              equipment={page.equipment}
              base={page.market.base_stats || []}
              piece={piece}
              headingId="item-preview-name"
            />
            {!here && (
              <footer className="peek-footer">
                <a href={url} onClick={() => close(false, true)}>
                  {words("查看物品详情 →", "Open item details →")}
                </a>
              </footer>
            )}
          </div>
        ) : (
          <div className="peek-content" data-preview-item={item.id}>
            <header className="peek-head">
              <Slot empty url={item.icon_url} size={44} />
              <div>
                <h2 id="item-preview-name">
                  {words(item.name_zh || item.name_en, item.name_en)}
                </h2>
                {item.name_zh && item.name_zh !== item.name_en && (
                  <p className="peek-secondary">
                    {(secondaryLanguage() === "zh" ? item.name_zh : item.name_en)}
                  </p>
                )}
                <div className="peek-tags">
                  <span>{item.category}</span>
                  {item.req_level != null && (
                    <span>
                      {words("等级 ", "Lv. ")}
                      {item.req_level}
                    </span>
                  )}
                  {item.subcategory && language === "zh" && (
                    <span>{item.subcategory}</span>
                  )}
                </div>
              </div>
              <button
                type="button"
                className={"peek-watch" + (watching ? " on" : "")}
                data-preview-watch={item.id}
                aria-label={
                  watching
                    ? words("取消关注这件物品", "Unwatch this item")
                    : words("关注这件物品", "Watch this item")
                }
                aria-pressed={watching}
                disabled={!ready || watchFull}
                title={
                  watchFull
                    ? words("最多关注 100 件物品", "Watch up to 100 items")
                    : watching
                      ? words("取消关注", "Unwatch")
                      : words("关注", "Watch")
                }
                onClick={() => toggleWatch(item.id)}
              >
                <Icon name={watching ? "starSm" : "starO"} />
                <span className="sr">
                  {watching
                    ? words("已关注", "Watching")
                    : watchFull
                      ? words("关注已满", "Watch limit")
                      : words("关注", "Watch")}
                </span>
              </button>
            </header>
            {page.equipment ? (
              <EquipmentPeek
                equipment={page.equipment}
                base={page.market.base_stats || []}
              />
            ) : page.tip ? (
              <TipPeek tip={page.tip} />
            ) : page.market.base_stats?.length ? (
              <section className="peek-section">
                <h3>{words("图鉴基础属性", "Catalogue base stats")}</h3>
                <dl className="peek-stats">
                  {page.market.base_stats
                    .filter(([, value]: [string, number]) => value !== 0)
                    .map(([key, value]: [string, number]) => (
                      <div key={key}>
                        <dt>{words(...(labels[key] || [key, key]))}</dt>
                        <dd>{value}</dd>
                      </div>
                    ))}
                </dl>
              </section>
            ) : (
              Math.floor(item.id / 1000000) === 1 && (
                <p className="peek-note">
                  {words("暂无基础属性", "Base stats unavailable")}
                </p>
              )
            )}
            <section className="peek-section">
              <h3>
                {words("市场参考", "Market reference")} ·{" "}
                {readPeriod() === "all"
                  ? words("全部记录", "All records")
                  : words("近 72 小时", "72 h")}
              </h3>
              <div className="peek-price">
                {format(stats?.typical)}
                <small>
                  {words("金币 / 件 · 成交中位", "mesos / item · median sale")}
                </small>
              </div>
              <dl className="peek-stats">
                {[
                  ["lowest_ask", "在售最低", "Lowest ask"],
                  ["sales_24h", "成交笔数", "Sales"],
                  ["listings_count", "在售数量", "Listed stock"],
                  ["shops_count", "在售摊位", "Shops"],
                ].map(([key, zh, en]) => (
                  <div key={key}>
                    <dt>{words(zh, en)}</dt>
                    <dd>{format(stats?.[key])}</dd>
                  </div>
                ))}
              </dl>
              {stats ? (
                <>
                  <p className="peek-note">
                    {words("最近数据：", "Latest data: ")}
                    <RelativeTime
                      at={timestamp(page.market.as_of || stats.as_of)}
                    />
                  </p>
                  {Date.now() / 1000 -
                    timestamp(page.market.as_of || stats.as_of) >=
                    48 * 3600 && (
                    <p className="peek-warning">
                      {words(
                        "历史报价，请先确认是否仍在售。",
                        "Historical offers. Confirm availability in game.",
                      )}
                    </p>
                  )}
                </>
              ) : (
                <p className="peek-note">
                  {words("还没有市场记录。", "No market records yet.")}
                </p>
              )}
            </section>
            {(page.npc_sell != null || page.npc_offers.length > 0) && (
              <section className="peek-section">
                <h3>NPC</h3>
                <dl className="peek-stats">
                  <div>
                    <dt>{words("商店售价", "Shop price")}</dt>
                    <dd>
                      {format(
                        page.npc_offers.length
                          ? Math.min(
                              ...page.npc_offers.map(
                                (offer: any) => offer.price,
                              ),
                            )
                          : null,
                      )}
                    </dd>
                  </div>
                  <div>
                    <dt>{words("回收价", "Sell-back")}</dt>
                    <dd>{format(page.npc_sell)}</dd>
                  </div>
                </dl>
              </section>
            )}
            <footer className="peek-footer">
              <a href={url} onClick={() => close(false, true)}>
                {words("查看完整详情 →", "Open full details →")}
              </a>
            </footer>
          </div>
        )}
      </aside>
    </>,
    document.body,
  );
}

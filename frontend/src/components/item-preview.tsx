import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useLocation } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { readPeriod } from "/web/js/lib/period.js?v=20261022-regressions-1";
import { trapFocus } from "/web/js/lib/dialog.js";
import { loadCatalog, catalogKey } from "../lib/catalog";
import { timestamp } from "../lib/item-market";
import { usePreferences, useWords } from "../providers";
import { Slot, RelativeTime } from "./shared";
import { ensureStyle } from "../lib/styles";
type Hit = {
  anchor: HTMLElement;
  id: number;
  touch?: boolean;
  pinned?: boolean;
  rect?: DOMRect;
};
export function previewItem(target: Element, origin: string): Hit | null {
  const anchor = target.closest<HTMLElement>("a[href],tr[data-open]");
  if (!anchor || anchor.closest(".item-peek")) return null;
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
  return match ? { anchor, id: Number(match[1]) } : null;
}
export function previewPosition(
  anchor: DOMRect | any,
  box: DOMRect | any,
  viewport: { width: number; height: number },
) {
  const right = Math.min(anchor.right, anchor.left + 300) + 12,
    left =
      right + box.width <= viewport.width - 12
        ? right
        : anchor.left - 12 - box.width;
  return {
    left: Math.max(12, Math.min(left, viewport.width - box.width - 12)),
    top: Math.max(12, Math.min(anchor.top, viewport.height - box.height - 12)),
  };
}
export default function ItemPreview() {
  const words = useWords(),
    { language } = usePreferences(),
    route = useLocation();
  const [hit, setHit] = useState<Hit | null>(null),
    [position, setPosition] = useState({ left: 12, top: 12 });
  const active = useRef(hit),
    popup = useRef<HTMLElement>(null),
    restoring = useRef(false);
  active.current = hit;
  const url = hit ? `/item/${hit.id}?hours=${readPeriod()}` : "";
  const query = useQuery<any>({
    queryKey: catalogKey(url),
    enabled: !!hit,
    queryFn: ({ signal }) => loadCatalog(url, signal),
    staleTime: 30000,
  });
  function close(restore = false) {
    const previous = active.current;
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
        previewPosition(current.rect, box.getBoundingClientRect(), {
          width: innerWidth,
          height: innerHeight,
        }),
      );
  }
  useEffect(() => {
    void ensureStyle("item-preview").then(place);
    let timer: ReturnType<typeof setTimeout>,
      leave: ReturnType<typeof setTimeout>;
    const open = (next: Hit) => {
      clearTimeout(timer);
      clearTimeout(leave);
      if (active.current?.anchor === next.anchor) {
        if (next.pinned)
          popup.current?.querySelector<HTMLButtonElement>("button")?.focus();
        return;
      }
      active.current?.anchor.removeAttribute("aria-controls");
      active.current?.anchor.removeAttribute("aria-expanded");
      next.anchor.setAttribute("aria-controls", "item-quick-preview");
      next.anchor.setAttribute("aria-expanded", "true");
      next.rect = next.anchor.getBoundingClientRect();
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
    document.addEventListener("pointerover", over);
    document.addEventListener("pointerout", out);
    document.addEventListener("focusin", focus);
    document.addEventListener("click", click, true);
    document.addEventListener("keydown", key, true);
    document.addEventListener("scroll", scroll, true);
    window.addEventListener("resize", place);
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
    format = (value: number | null | undefined) =>
      value == null
        ? "—"
        : Number(value).toLocaleString(undefined, {
            maximumFractionDigits: 20,
          });
  const labels: Record<string, [string, string]> = {
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
        className={"item-peek " + (hit?.touch ? "is-mobile" : "")}
        hidden={!hit}
        ref={popup}
        role="dialog"
        aria-modal={!!hit?.touch}
        aria-label={words("物品快速预览", "Quick item preview")}
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
              <a href={url}>{words("打开完整详情 →", "Open full details →")}</a>
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
                    {words(item.name_en, item.name_zh)}
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
            </header>
            {page.market.base_stats?.length ? (
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
                <p className="peek-note">
                  {words(
                    "具体摊位装备可能有随机或强化属性。",
                    "Listed equipment may have rolled or upgraded stats.",
                  )}
                </p>
              </section>
            ) : (
              Math.floor(item.id / 1000000) === 1 && (
                <p className="peek-note">
                  {words(
                    "暂无图鉴基础属性，请在详情页核对具体装备。",
                    "Base stats unavailable. Check individual equipment on the detail page.",
                  )}
                </p>
              )
            )}
            <section className="peek-section">
              <h3>
                {words("市场参考", "Market reference")} ·{" "}
                {readPeriod() === "all"
                  ? words("全部记录", "All records")
                  : "72h"}
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
              <a href={url} onClick={() => close()}>
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

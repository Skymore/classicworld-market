import { useEffect, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Icon } from "./shared";
import { useWords } from "../providers";
import { OfferRow } from "./list-rows";
import { useMarketQuery } from "../lib/query";
import {
  pushSubscribed,
  showSystemNotification,
  usePushWorker,
} from "../lib/push";
import { api, qs } from "/web/js/lib/api.js?v=20261022-auto-watch-2";

export function OfferReminder({ row, item }: { row: any; item?: any }) {
  const catalog = useMarketQuery<any>(
    api.watchCatalog() + qs({ q: row.item_id }),
    !row.icon_url && !item?.icon_url,
    false,
  );
  const known = catalog.data?.items?.find(
    (entry: any) => entry.item_id === row.item_id,
  );
  return <OfferRow row={row} item={{ ...known, ...item }} />;
}
type Toast = { id: number; title: string; href: string; body: ReactNode };
export function announce(
  title: string,
  href: string,
  body: ReactNode,
  desktop?: { body: string; tag: string },
) {
  document.dispatchEvent(
    new CustomEvent("market-toast", {
      detail: { id: Date.now() + Math.random(), title, href, body },
    }),
  );
  // Watch alerts already arrive by push on a subscribed browser.
  if (desktop && !pushSubscribed())
    void showSystemNotification(title, { ...desktop, data: { url: href } });
}
/** Page toasts; mounted once per app, it also starts the push service worker. */
export function ToastHost() {
  usePushWorker();
  const [toasts, setToasts] = useState<Toast[]>([]);
  const words = useWords();
  useEffect(() => {
    const timers = new Set<ReturnType<typeof setTimeout>>();
    const receive = (event: Event) => {
      const toast = (event as CustomEvent<Toast>).detail;
      setToasts((old) => [toast, ...old].slice(0, 5));
      const timer = setTimeout(() => {
        setToasts((old) => old.filter((row) => row.id !== toast.id));
        timers.delete(timer);
      }, 20000);
      timers.add(timer);
    };
    document.addEventListener("market-toast", receive);
    return () => {
      document.removeEventListener("market-toast", receive);
      timers.forEach(clearTimeout);
    };
  }, []);
  return createPortal(
    <div className="toasts" role="status" aria-live="polite">
      {toasts.map((toast) => (
        <section className="toast" key={toast.id}>
          <div className="stall-bar">
            <h2>
              <Icon name="starSm" />
              {toast.title}
            </h2>
            <button
              className="bar-btn"
              data-toast-close
              aria-label={words("关闭", "Close")}
              onClick={() =>
                setToasts((old) => old.filter((row) => row.id !== toast.id))
              }
            >
              <Icon name="close" />
            </button>
          </div>
          <div className="toast-body">{toast.body}</div>
        </section>
      ))}
    </div>,
    document.body,
  );
}

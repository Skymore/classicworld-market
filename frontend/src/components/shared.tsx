import { useLocation } from "react-router-dom";
import {
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
import { I } from "/web/js/lib/icons.js";
import { ago, fullTime, meso, chg, num } from "/web/js/lib/format.js";
export { default as Search } from "./quick-search";
import {
  readPeriod,
  resolvePeriod,
  automaticPeriod,
  decoratePeriod,
  savePeriod,
} from "/web/js/lib/period.js?v=20261022-regressions-1";
import { usePreferences, useWords } from "../providers";
import { Button } from "./ui/button";
import type { Product } from "../lib/types";

export function Icon({ name, size }: { name: string; size?: number }) {
  const icon = I[name];
  return (
    <span
      className="contents"
      aria-hidden="true"
      dangerouslySetInnerHTML={{
        __html: typeof icon === "function" ? icon(size) : icon || "",
      }}
    />
  );
}
export function Stall({
  title,
  children,
  action,
  className = "",
  h1 = false,
}: {
  title: string;
  children: ReactNode;
  action?: ReactNode;
  className?: string;
  h1?: boolean;
}) {
  const Heading = h1 ? "h1" : "h2";
  return (
    <section className={"stall " + className}>
      <div className="stall-bar">
        <Heading>{title}</Heading>
        {action}
      </div>
      {children}
    </section>
  );
}
export function Loading() {
  const words = useWords();
  return (
    <p className="react-status" role="status">
      {words("加载中…", "Loading…")}
    </p>
  );
}
export function ErrorState({ retry }: { retry?: () => void }) {
  const words = useWords();
  return (
    <div className="react-status react-error" role="alert">
      <p>
        {words(
          "暂时无法加载，请稍后重试。",
          "Unable to load. Please try again.",
        )}
      </p>
      {retry && <Button onClick={retry}>{words("重试", "Retry")}</Button>}
    </div>
  );
}
export function Empty({ text }: { text?: string }) {
  const words = useWords();
  return (
    <p className="react-status">
      {text || words("没有符合条件的记录。", "No matching records.")}
    </p>
  );
}
export function Slot({
  url,
  size = 28,
  empty = false,
}: {
  url?: string;
  size?: number;
  empty?: boolean;
}) {
  return (
    <span className="slot" style={{ "--s": size + "px" } as CSSProperties}>
      {(!empty || url) && (
        <img
          src={url || "/web/img/favicon.svg"}
          width={size}
          height={size}
          loading="lazy"
          alt=""
          onError={(event) => (event.currentTarget.dataset.broken = "1")}
        />
      )}
    </span>
  );
}
export function ItemNames({ row }: { row: Product }) {
  const { language } = usePreferences();
  const primary =
    language === "en" ? row.name_en || row.name_zh : row.name_zh || row.name_en;
  const secondary = language === "en" ? row.name_zh : row.name_en;
  return (
    <span className="name-stack">
      <b className="name-primary">{primary || row.item_id}</b>
      {secondary && secondary !== primary && (
        <small className="name-secondary">{secondary}</small>
      )}
    </span>
  );
}
export function Price({ value }: { value?: number | null }) {
  return <>{meso(value)}</>;
}
export function Change({ value }: { value?: number | null }) {
  return (
    <span
      className="contents"
      dangerouslySetInnerHTML={{ __html: chg(value) }}
    />
  );
}
export function RelativeTime({ at }: { at?: number | null }) {
  const [, tick] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => tick((n) => n + 1), 30_000);
    return () => clearInterval(timer);
  }, []);
  return at == null ? (
    <>—</>
  ) : (
    <span data-relative-time={at} title={fullTime(at)}>
      {ago(at)}
    </span>
  );
}
export function SampleBadge({ row }: { row: Product }) {
  const words = useWords();
  if (row.typical == null || !row.low_data) return null;
  const n = row.sales_window || 0;
  return (
    <small
      className="sample-badge"
      title={words(
        `所选时段仅观察到 ${n} 笔成交，参考性有限。`,
        `Only ${n} observed sales in this period.`,
      )}
    >
      {words(`样本少 · ${n}`, `Few sales · ${n}`)}
    </small>
  );
}
export function usePeriod() {
  const [hours, setHours] = useState<string>(() => readPeriod());
  const [ready, setReady] = useState(false);
  useEffect(() => {
    let active = true;
    const update = () =>
      resolvePeriod().then((value: string) => {
        if (active) {
          setHours(value);
          setReady(true);
        }
      });
    void update();
    window.addEventListener("user-preferences", update);
    return () => {
      active = false;
      window.removeEventListener("user-preferences", update);
    };
  }, []);
  async function choose(value: string) {
    const saved = savePeriod(value);
    setHours(value === "auto" ? await resolvePeriod() : saved);
  }
  return { hours, ready, choose };
}
export function PeriodControl({
  hours,
  choose,
  item = false,
}: {
  hours: string;
  choose(value: string): void;
  item?: boolean;
}) {
  const ref = useRef<HTMLSelectElement>(null);
  const { language } = usePreferences();
  useEffect(() => {
    decoratePeriod(ref.current, hours);
  }, [hours, language]);
  return (
    <label className={item ? "item-period" : "period-control period-inline"}>
      <span className="sr">
        {language === "en" ? "Statistics period" : "统计范围"}
      </span>
      <select
        ref={ref}
        data-period
        data-item-period={item ? "" : undefined}
        defaultValue={automaticPeriod() ? "auto" : hours}
        aria-label={language === "en" ? "Statistics period" : "统计范围"}
        onChange={(event) => choose(event.target.value)}
      >
        <option value="auto">{language === "en" ? "Auto" : "自动"}</option>
        <option value="72">72h</option>
        <option value="all">{language === "en" ? "All" : "全部"}</option>
      </select>
    </label>
  );
}
export function usePageReady() {
  const route = useLocation();
  useEffect(() => {
    document.documentElement.dataset.ready = "1";
  }, [route.pathname]);
}
export { num };

import { useEffect, useRef, useState, type PointerEvent } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { usePreferences, useWords } from "../providers";
import { num } from "./shared";

export interface TrafficDay {
  day: string;
  pageviews: number;
  visitors: number;
}

export function trafficDate(day: string) {
  const [, month, date] = day.split("-");
  return `${Number(month)}/${Number(date)}`;
}

export function TrafficChart({
  daily,
  pageviews,
  updatedAt,
}: {
  daily: TrafficDay[];
  pageviews: number;
  updatedAt: number;
}) {
  const words = useWords();
  const { language } = usePreferences();
  const [metric, setMetric] = useState<"pageviews" | "visitors">("pageviews");
  const [selection, select] = useState<string | null>(null);
  const [hover, setHover] = useState<string | null>(null);
  const chartRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const element = chartRef.current;
    if (!element) return;
    const observer = new ResizeObserver(([entry]) =>
      setWidth(entry.contentRect.width),
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const selectedIndex = daily.findIndex((row) => row.day === selection);
  const selected = selectedIndex < 0 ? daily.length - 1 : selectedIndex;
  const hovered = daily.findIndex((row) => row.day === hover);
  const active = hovered < 0 ? selected : hovered;
  const day = daily[active];
  const height = 226;
  const left = 52;
  const right = 10;
  const top = 12;
  const bottom = height - 34;
  const band = Math.max(0, width - left - right) / Math.max(1, daily.length);
  const maximum = Math.max(1, ...daily.map((row) => row[metric]));
  const base = 10 ** Math.floor(Math.log10(maximum / 3));
  const step = Math.max(1, Math.ceil(maximum / 3 / base) * base);
  const ceiling = step * 3;
  const x = (index: number) => left + (index + 0.5) * band;
  const y = (value: number) => bottom - (value / ceiling) * (bottom - top);
  const tickCount = Math.min(daily.length, width < 480 ? 3 : 6);
  const ticks = Array.from({ length: tickCount }, (_, index) =>
    tickCount === 1
      ? 0
      : Math.round((index * (daily.length - 1)) / (tickCount - 1)),
  );
  const visitors = daily.reduce((sum, row) => sum + row.visitors, 0);
  const mean = visitors / Math.max(1, daily.length);
  // A few visitors over 30 days must not read as 0.
  const average =
    visitors > 0 && mean < 0.1
      ? "<0.1"
      : mean < 10
        ? String(Math.round(mean * 10) / 10)
        : null;
  const unit =
    metric === "pageviews" ? words("次", "views") : words("人", "visitors");
  const exact = (value: number) =>
    value.toLocaleString(language === "en" ? "en-US" : "zh-CN");
  function pointIndex(event: PointerEvent<SVGRectElement>) {
    const svg = event.currentTarget.ownerSVGElement;
    if (!svg || !band) return selected;
    const bounds = svg.getBoundingClientRect();
    return Math.max(
      0,
      Math.min(
        daily.length - 1,
        Math.floor((event.clientX - bounds.left - left) / band),
      ),
    );
  }
  function move(offset: number) {
    const next = daily[selected + offset];
    if (next) select(next.day);
    setHover(null);
  }
  return (
    <div className="traffic-trend" data-traffic-trend>
      <div
        className="traffic-trend-metrics"
        aria-label={words("选择查看指标", "Chart metric")}
      >
        <button
          type="button"
          data-traffic-metric="pageviews"
          aria-pressed={metric === "pageviews"}
          onClick={() => setMetric("pageviews")}
        >
          <span>{words("浏览次数", "Page views")}</span>
          <strong data-traffic-pv>
            {exact(pageviews)}
            <small>{words("次", "views")}</small>
          </strong>
        </button>
        <button
          type="button"
          data-traffic-metric="visitors"
          aria-pressed={metric === "visitors"}
          onClick={() => setMetric("visitors")}
        >
          <span>{words("日均访客", "Daily average visitors")}</span>
          <strong data-traffic-average-uv>
            {average ?? exact(Math.round(mean))}
            <small>{words("人", "visitors")}</small>
          </strong>
        </button>
      </div>
      <div className="traffic-chart-wrap">
        <div className="traffic-chart-heading">
          <span data-traffic-chart-unit>
            {metric === "pageviews"
              ? words("每日浏览次数 · 次", "Daily page views")
              : words("每日访客人数 · 人", "Daily visitors")}
          </span>
          <span>{words("按天", "Daily")}</span>
        </div>
        <div className="traffic-chart-plot" ref={chartRef}>
          {width > left + right && daily.length > 0 && (
            <svg
              className="traffic-chart"
              viewBox={`0 0 ${width} ${height}`}
              role="img"
              aria-label={words(
                "每天的网站访问量柱状图",
                "Website visits by day",
              )}
            >
              <title>
                {words(
                  "每天的网站访问量；使用下方日期按钮查看数值",
                  "Daily website traffic; use the date buttons below to inspect values",
                )}
              </title>
              {[0, 1, 2, 3].map((tick) => (
                <g key={tick}>
                  <line
                    x1={left}
                    x2={width - right}
                    y1={y(step * tick)}
                    y2={y(step * tick)}
                    className="traffic-chart-grid"
                  />
                  <text x={left - 8} y={y(step * tick) + 4} textAnchor="end">
                    {num(step * tick)}
                  </text>
                </g>
              ))}
              {daily.map((row, index) => (
                <rect
                  key={row.day}
                  className="traffic-chart-bar"
                  data-traffic-day={row.day}
                  data-value={row[metric]}
                  data-active={index === active ? "1" : undefined}
                  data-today={index === daily.length - 1 ? "1" : undefined}
                  x={x(index) - band * 0.34}
                  y={y(row[metric])}
                  width={band * 0.68}
                  height={bottom - y(row[metric])}
                  rx={1}
                />
              ))}
              {ticks.map((index, position) => (
                <text
                  key={index}
                  x={x(index)}
                  y={height - 11}
                  textAnchor={
                    position === 0
                      ? "start"
                      : position === ticks.length - 1
                        ? "end"
                        : "middle"
                  }
                >
                  {index === daily.length - 1
                    ? words("今日", "Today")
                    : trafficDate(daily[index].day)}
                </text>
              ))}
              {active >= 0 && (
                <rect
                  x={x(active) - band * 0.34}
                  y={bottom + 1}
                  width={band * 0.68}
                  height={3}
                  className="traffic-chart-selected"
                />
              )}
              <rect
                className="traffic-chart-hit"
                x={left}
                y={top}
                width={width - left - right}
                height={bottom - top}
                fill="transparent"
                onPointerMove={(event) => {
                  if (event.pointerType === "mouse")
                    setHover(daily[pointIndex(event)]?.day || null);
                }}
                onPointerLeave={() => setHover(null)}
                onClick={(event) => {
                  const svg = event.currentTarget.ownerSVGElement;
                  if (!svg || !band) return;
                  const index = Math.max(
                    0,
                    Math.min(
                      daily.length - 1,
                      Math.floor(
                        (event.clientX -
                          svg.getBoundingClientRect().left -
                          left) /
                          band,
                      ),
                    ),
                  );
                  select(daily[index].day);
                }}
              />
            </svg>
          )}
          {hovered >= 0 && day && (
            <div
              className="traffic-chart-tooltip"
              role="tooltip"
              style={{
                left: Math.max(0, Math.min(width - 140, x(active) - 70)),
                top: Math.max(0, y(day[metric]) - 66),
              }}
            >
              <span>
                {trafficDate(day.day)}
                {active === daily.length - 1
                  ? words(" · 今日", " · Today")
                  : ""}
              </span>
              <strong>
                {exact(day[metric])} {unit}
              </strong>
            </div>
          )}
        </div>
      </div>
      <div className="traffic-chart-footer">
        <span className="sr" role="status">
          {daily[selected]
            ? `${daily[selected].day} · ${exact(daily[selected][metric])} ${unit}`
            : words("暂无数据", "No data")}
        </span>
        <div className="traffic-chart-date">
          <button
            type="button"
            disabled={selected <= 0}
            onClick={() => move(-1)}
            aria-label={words("前一天", "Previous day")}
          >
            <ChevronLeft size={17} aria-hidden="true" />
          </button>
          <span data-traffic-selected-date>
            {day ? trafficDate(day.day) : "—"}
            {active === daily.length - 1 ? words(" · 今日", " · Today") : ""}
          </span>
          <strong data-traffic-selected-value>
            {day ? exact(day[metric]) : "—"} {unit}
          </strong>
          <button
            type="button"
            disabled={selected >= daily.length - 1}
            onClick={() => move(1)}
            aria-label={words("后一天", "Next day")}
          >
            <ChevronRight size={17} aria-hidden="true" />
          </button>
        </div>
        <span className="traffic-chart-updated">
          {updatedAt
            ? words("今日截至", "Today through")
            : words("更新中", "Updating")}{" "}
          {updatedAt > 0 &&
            new Date(updatedAt).toLocaleTimeString(
              language === "en" ? "en-GB" : "zh-CN",
              {
                timeZone: "UTC",
                hour: "2-digit",
                minute: "2-digit",
                hour12: false,
              },
            )}
        </span>
      </div>
    </div>
  );
}

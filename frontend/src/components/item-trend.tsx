import { useMemo, useState } from "react";
import { useWords, usePreferences } from "../providers";
import { meso } from "/web/js/lib/format.js";
import { trendValues } from "/web/js/lib/trend.js?v=20261021-trend-values-2";
export default function ItemTrend({ days }: { days: any[] }) {
  const words = useWords(),
    { language } = usePreferences();
  const [selected, setSelected] = useState(() =>
      Math.max(
        0,
        days.findLastIndex((day) => day.median != null),
      ),
    ),
    [tooltip, setTooltip] = useState(false);
  const index = Math.min(selected, days.length - 1),
    day = days[index];
  const values = useMemo(
    () =>
      day
        ? trendValues(
            { ...day, start: Date.parse(day.date + "T00:00:00Z") / 1000 },
            language === "en" ? "en-US" : "zh-CN",
          )
        : null,
    [day, language],
  );
  const highs = days
    .filter((day) => day.median != null)
    .map((day) => day.high ?? day.median);
  if (!highs.length || days.length < 2)
    return (
      <p className="note">
        {words(
          "近 7 天没有成交，画不出走势。",
          "No sales in the last 7 days, so no trend.",
        )}
      </p>
    );
  const top = Math.max(1, ...highs),
    step = 10 ** Math.floor(Math.log10(top)),
    hi = Math.ceil((top * 1.05) / step) * step,
    max = Math.max(1, ...days.map((day) => day.count));
  const x = (i: number) => 40 + (i / (days.length - 1)) * 292,
    y = (value: number) => 12 + (1 - value / hi) * 132;
  let pen = false;
  const path = days
    .map((day, i) => {
      if (day.median == null) {
        pen = false;
        return "";
      }
      const part =
        (pen ? "L" : "M") + x(i).toFixed(1) + "," + y(day.median).toFixed(1);
      pen = true;
      return part;
    })
    .join("");
  function choose(i: number) {
    setSelected(i);
    setTooltip(true);
  }
  return (
    <div
      className="trend"
      onPointerLeave={() => setTooltip(false)}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget))
          setTooltip(false);
      }}
    >
      <div className="trend-tooltip" hidden={!tooltip} aria-hidden="true">
        {day && values
          ? `${day.date} UTC · ${words("金币 / 件", "mesos / item")}\n${words("中位价", "Median")}  ${values.median}\n${words("最低 – 最高", "Low – high")}  ${values.low} – ${values.high}\n${words("成交笔数", "Sales")}  ${values.count}`
          : ""}
      </div>
      <svg
        viewBox="0 0 340 170"
        role="img"
        aria-label={words("7 日成交走势", "7-day sale trend")}
      >
        {[0, hi / 2, hi].map((tick) => (
          <g key={tick}>
            <text
              x="34"
              y={y(tick) + 4}
              textAnchor="end"
              fontSize="12"
              fill="var(--ink-3)"
            >
              {meso(Math.round(tick))}
            </text>
            <line
              x1="40"
              x2="332"
              y1={y(tick)}
              y2={y(tick)}
              stroke="var(--rule)"
              strokeDasharray="2 3"
            />
          </g>
        ))}
        {days.map((day, i) => (
          <g key={i}>
            <rect
              x={x(i) - 7}
              y={144 - (day.count / max) * 34}
              width="14"
              height={(day.count / max) * 34}
              fill="var(--ink-3)"
              opacity=".28"
            />
            {day.median != null && day.low != null && day.high != null && (
              <rect
                x={x(i) - 2}
                y={y(day.high)}
                width="4"
                height={y(day.low) - y(day.high)}
                fill="var(--mark)"
                opacity=".35"
              />
            )}
          </g>
        ))}
        <path d={path} fill="none" stroke="var(--mark)" strokeWidth="2" />
        {days.map((day, i) => (
          <g key={i}>
            {day.median != null && (
              <rect
                x={x(i) - 3}
                y={y(day.median) - 3}
                width="6"
                height="6"
                fill="var(--mark)"
              />
            )}
            <text
              x={x(i)}
              y="162"
              textAnchor="middle"
              fontSize="12"
              fill="var(--ink-3)"
            >
              {i === days.length - 1
                ? words("今天", "Today")
                : day.date.slice(5).replace("-", "/")}
            </text>
            <g
              data-trend-marker={i}
              className={index === i ? "selected" : ""}
              aria-hidden="true"
            >
              <line
                x1={x(i)}
                x2={x(i)}
                y1="12"
                y2="144"
                stroke="var(--bar-text)"
                strokeDasharray="3 3"
              />
            </g>
            <rect
              className="trend-hit"
              data-trend-hit={i}
              x={i ? (x(i - 1) + x(i)) / 2 : 40}
              y="12"
              width={
                (i === days.length - 1 ? 332 : (x(i) + x(i + 1)) / 2) -
                (i ? (x(i - 1) + x(i)) / 2 : 40)
              }
              height="132"
              fill="transparent"
              aria-hidden="true"
              onPointerOver={() => choose(i)}
              onClick={() => choose(i)}
            />
          </g>
        ))}
      </svg>
      <div
        className="trend-days"
        role="group"
        aria-label={words(
          "选择日期查看精确值",
          "Select a day for exact values",
        )}
      >
        {days.map((day, i) => (
          <button
            type="button"
            key={i}
            data-trend-day={i}
            data-date={day.date}
            data-start={Date.parse(day.date + "T00:00:00Z") / 1000}
            data-median={day.median ?? undefined}
            data-low={day.low ?? undefined}
            data-high={day.high ?? undefined}
            data-count={day.count}
            aria-pressed={i === index}
            onFocus={() => choose(i)}
            onPointerOver={() => choose(i)}
            onClick={() => choose(i)}
            onKeyDown={(event) => {
              if (
                !["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)
              )
                return;
              event.preventDefault();
              const next =
                event.key === "Home"
                  ? 0
                  : event.key === "End"
                    ? days.length - 1
                    : Math.max(
                        0,
                        Math.min(
                          days.length - 1,
                          i + (event.key === "ArrowLeft" ? -1 : 1),
                        ),
                      );
              (
                event.currentTarget.parentElement?.children[
                  next
                ] as HTMLButtonElement
              )?.focus();
            }}
          >
            {day.date.slice(5).replace("-", "/")}
          </button>
        ))}
      </div>
      <div
        className="trend-readout"
        role="status"
        aria-live="polite"
        aria-atomic="true"
      >
        <div className="trend-range" data-trend-range>
          {values?.range ||
            words(
              "移到图上或点日期查看精确值",
              "Hover over the chart or select a date for exact values",
            )}
        </div>
        <dl>
          {[
            ["median", "中位价", "Median"],
            ["low", "最低价", "Low"],
            ["high", "最高价", "High"],
            ["count", "成交笔数", "Sales"],
          ].map(([key, zh, en]) => (
            <div key={key}>
              <dt>{words(zh, en)}</dt>
              <dd data-trend-value={key}>{values?.[key] ?? "—"}</dd>
            </div>
          ))}
        </dl>
      </div>
      <p className="fnote">
        {words(
          "移到图上或点日期查看精确值。日期按 UTC 日汇总，明细时间段按你的时区显示。",
          "Hover or select a date for exact values. Days are grouped in UTC; the detailed time range uses your timezone.",
        )}
      </p>
      <div className="lg">
        <span>
          <i className="k-med" />
          {words("每日成交中位", "daily median")}
        </span>
        <span>
          <i className="k-span" />
          {words("最低–最高", "low–high")}
        </span>
        <span>
          <i className="k-count" />
          {words("成交笔数", "sales")}
        </span>
      </div>
    </div>
  );
}

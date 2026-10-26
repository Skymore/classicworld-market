import { useMemo, useState } from "react";
import { useWords, usePreferences } from "../providers";
import { meso } from "/web/js/lib/format.js";
import { trendValues } from "/web/js/lib/trend.js?v=20261021-trend-values-2";
export default function ItemTrend({
  days = [],
  listingDays = [],
}: {
  days: any[];
  listingDays?: any[];
}) {
  const words = useWords();
  const [mode, setMode] = useState("sales");
  const dates = [
    ...new Set([...days, ...listingDays].map((d) => d.date)),
  ].sort();
  const align = (rows: any[]) =>
    dates.map(
      (date) =>
        rows.find((d) => d.date === date) || {
          date,
          median: null,
          low: null,
          high: null,
          count: 0,
        },
    );
  return (
    <>
      <div
        className="tabs"
        role="group"
        aria-label={words("走势类型", "Trend type")}
      >
        {[
          ["sales", "成交", "Sales"],
          ["listings", "挂单", "Listings"],
          ["compare", "对比", "Compare"],
        ].map(([key, zh, en]) => (
          <button
            type="button"
            key={key}
            className={"tab " + (mode === key ? "on" : "")}
            aria-pressed={mode === key}
            onClick={() => setMode(key)}
          >
            {words(zh, en)}
          </button>
        ))}
      </div>
      <TrendChart
        days={align(mode === "listings" ? listingDays : days)}
        listing={mode === "listings"}
        comparison={mode === "compare" ? align(listingDays) : []}
      />
    </>
  );
}
function TrendChart({
  days,
  listing,
  comparison,
}: {
  days: any[];
  listing: boolean;
  comparison: any[];
}) {
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
  const highs = [...days, ...comparison]
    .filter((day) => day.median != null)
    .map((day) => day.high ?? day.median);
  if (!highs.length || days.length < 2)
    return (
      <p className="note">
        {words(
          "近 7 天暂无这类价格记录。",
          "No prices of this type in the last 7 days.",
        )}
      </p>
    );
  if (listing && values && day?.count === 0) values.count = "0";
  const color = listing ? "var(--bar)" : "var(--mark)";
  const comparisonDay = comparison[index];
  const comparisonValues = comparisonDay
    ? trendValues(
        {
          ...comparisonDay,
          start: Date.parse(comparisonDay.date + "T00:00:00Z") / 1000,
        },
        language === "en" ? "en-US" : "zh-CN",
      )
    : null;
  if (comparisonValues && comparisonDay?.count === 0)
    comparisonValues.count = "0";
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
  let comparePen = false;
  const comparePath = comparison
    .map((d, i) => {
      if (d.median == null) {
        comparePen = false;
        return "";
      }
      const part =
        (comparePen ? "L" : "M") +
        x(i).toFixed(1) +
        "," +
        y(d.median).toFixed(1);
      comparePen = true;
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
          ? `${day.date} UTC · ${words("金币 / 件", "mesos / item")}\n${words("中位价", "Median")}  ${values.median}\n${words("最低 – 最高", "Low – high")}  ${values.low} – ${values.high}\n${words(listing ? "挂单数" : "成交笔数", listing ? "Listings" : "Sales")}  ${values.count}`
          : ""}
      </div>
      <svg
        viewBox="0 0 340 170"
        role="img"
        aria-label={words(
          comparison.length
            ? "7 日成交与挂单对比"
            : listing
              ? "7 日挂单走势"
              : "7 日成交走势",
          comparison.length
            ? "7-day sale and listing comparison"
            : listing
              ? "7-day listing trend"
              : "7-day sale trend",
        )}
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
                fill={color}
                opacity=".35"
              />
            )}
          </g>
        ))}
        <path d={path} fill="none" stroke={color} strokeWidth="2" />
        {!!comparison.length && (
          <g data-listing-series>
            <path
              d={comparePath}
              fill="none"
              stroke="var(--bar)"
              strokeWidth="2"
              strokeDasharray="5 3"
            />
            {comparison.map(
              (d, i) =>
                d.median != null && (
                  <circle
                    key={i}
                    cx={x(i)}
                    cy={y(d.median)}
                    r="3"
                    fill="var(--bar)"
                  />
                ),
            )}
          </g>
        )}
        {days.map((day, i) => (
          <g key={i}>
            {day.median != null && (
              <rect
                x={x(i) - 3}
                y={y(day.median) - 3}
                width="6"
                height="6"
                fill={color}
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
        {!!comparison.length && (
          <div>{words("推定成交", "Inferred sales")}</div>
        )}
        <dl>
          {[
            ["median", "中位价", "Median"],
            ["low", "最低价", "Low"],
            ["high", "最高价", "High"],
            [
              "count",
              listing ? "挂单数" : "成交笔数",
              listing ? "Listings" : "Sales",
            ],
          ].map(([key, zh, en]) => (
            <div key={key}>
              <dt>{words(zh, en)}</dt>
              <dd data-trend-value={key}>{values?.[key] ?? "—"}</dd>
            </div>
          ))}
        </dl>
      </div>
      {!!comparison.length && (
        <div className="trend-readout" data-listing-readout>
          <div className="trend-range">{words("挂单", "Listings")}</div>
          <dl>
            {[
              ["median", "中位价", "Median"],
              ["low", "最低价", "Low"],
              ["high", "最高价", "High"],
              ["count", "挂单数", "Listings"],
            ].map(([key, zh, en]) => (
              <div key={key}>
                <dt>{words(zh, en)}</dt>
                <dd>{comparisonValues?.[key] ?? "—"}</dd>
              </div>
            ))}
          </dl>
        </div>
      )}
      <div className="lg">
        <span>
          <i className="k-med" style={{ background: color }} />
          {words(
            listing ? "挂单中位" : "推定成交中位",
            listing ? "listing median" : "inferred sale median",
          )}
        </span>
        <span>
          <i className="k-span" />
          {words("最低–最高", "low–high")}
        </span>
        <span>
          <i className="k-count" />
          {words(
            listing ? "挂单数" : "成交笔数",
            listing ? "listings" : "sales",
          )}
        </span>
        {!!comparison.length && (
          <span>
            <i className="k-med" style={{ background: "var(--bar)" }} />
            {words("挂单中位", "listing median")}
          </span>
        )}
      </div>
    </div>
  );
}

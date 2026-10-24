import {
  useMemo,
  useState,
  type CSSProperties,
  type KeyboardEvent,
} from "react";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { Monitor, RefreshCw, Smartphone, Tablet } from "lucide-react";
import { usePreferences, useWords } from "../providers";
import {
  ErrorState,
  Loading,
  Stall,
  num,
  usePageReady,
} from "../components/shared";

interface Count {
  name: string;
  count: number;
}
interface Region {
  code: string;
  count: number;
}
interface Report {
  pageviews: number;
  today: { pageviews: number; visitors: number };
  regions: Region[];
  sources: Count[];
  devices: Count[];
}
interface Country {
  code: string;
  d: string;
  x: number;
  y: number;
}
async function load<T>(url: string, signal?: AbortSignal): Promise<T> {
  const response = await fetch(url, {
    signal,
    cache: "no-store",
    credentials: "omit",
  });
  if (!response.ok) throw new Error("unavailable");
  return response.json();
}
function Breakdown({
  rows,
  total,
  devices = false,
}: {
  rows: Count[];
  total: number;
  devices?: boolean;
}) {
  const words = useWords();
  const names: Record<string, string> = {
    phone: words("手机", "Phone"),
    tablet: words("平板", "Tablet"),
    desktop: words("电脑", "Desktop"),
  };
  const icons = { phone: Smartphone, tablet: Tablet, desktop: Monitor };
  return (
    <div className="traffic-breakdown">
      {rows.length ? (
        rows.map((row) => {
          const DeviceIcon = devices
            ? icons[row.name as keyof typeof icons]
            : null;
          const label = devices
            ? names[row.name] || row.name
            : row.name || words("直接访问", "Direct");
          const percent = total ? Math.round((row.count / total) * 100) : 0;
          return (
            <div className="traffic-row" key={row.name}>
              <div className="traffic-row-label">
                {DeviceIcon && <DeviceIcon size={17} aria-hidden="true" />}
                <span title={label}>{label}</span>
              </div>
              <strong>{num(row.count)}</strong>
              <small>{percent}%</small>
              <span className="traffic-row-meter" aria-hidden="true">
                <i style={{ width: `${percent}%` }} />
              </span>
            </div>
          );
        })
      ) : (
        <p className="traffic-empty">{words("暂无数据", "No data")}</p>
      )}
    </div>
  );
}
function RegionMap({ regions }: { regions: Region[] }) {
  const words = useWords();
  const { language } = usePreferences();
  const [selection, select] = useState<string | null>(null);
  const world = useQuery({
    queryKey: ["traffic-world"],
    staleTime: Infinity,
    queryFn: ({ signal }) =>
      load<{ countries: Country[] }>("/web/data/traffic-world.json", signal),
  });
  const names = useMemo(
    () =>
      new Intl.DisplayNames([language === "en" ? "en" : "zh-CN"], {
        type: "region",
      }),
    [language],
  );
  const name = (code: string) =>
    code ? names.of(code) || code : words("未知", "Unknown");
  const counts = new Map(regions.map((row) => [row.code, row.count]));
  const known = regions.filter((row) => row.code);
  const selected =
    selection !== null && counts.has(selection) ? selection : known[0]?.code;
  const max = Math.max(1, ...known.map((row) => row.count));
  const active =
    selected !== undefined
      ? { code: selected, count: counts.get(selected) || 0 }
      : null;
  return (
    <div className="traffic-geography">
      <div className="traffic-map-wrap">
        {world.isError ? (
          <ErrorState retry={() => void world.refetch()} />
        ) : !world.data ? (
          <Loading />
        ) : (
          <>
            <svg
              className="traffic-world"
              viewBox="0 0 720 300"
              aria-label={words("流量地区分布地图", "Traffic by region")}
            >
              <g className="traffic-graticule" aria-hidden="true">
                {[70, 130, 190, 250].map((y) => (
                  <path key={y} d={`M0 ${y}H720`} />
                ))}
                {[120, 240, 360, 480, 600].map((x) => (
                  <path key={x} d={`M${x} 0V300`} />
                ))}
              </g>
              {world.data.countries.map((country) => {
                const count = counts.get(country.code) || 0;
                const label = `${name(country.code)} · ${num(count)}`;
                const attributes = {
                  className: "traffic-country",
                  "data-country": country.code,
                  "data-visited": count ? "1" : undefined,
                  "data-selected": selected === country.code ? "1" : undefined,
                  style: {
                    "--traffic-shade":
                      0.25 + (0.75 * Math.log1p(count)) / Math.log1p(max),
                  } as CSSProperties,
                  tabIndex: count ? 0 : undefined,
                  role: count ? "button" : undefined,
                  "aria-label": label,
                  onClick: () => {
                    if (count) select(country.code);
                  },
                  onKeyDown: (event: KeyboardEvent<SVGElement>) => {
                    if (count && ["Enter", " "].includes(event.key)) {
                      event.preventDefault();
                      select(country.code);
                    }
                  },
                };
                return country.d ? (
                  <path key={country.code} d={country.d} {...attributes}>
                    <title>{label}</title>
                  </path>
                ) : (
                  <circle
                    key={country.code}
                    cx={country.x}
                    cy={country.y}
                    r={count ? 4 : 1.5}
                    {...attributes}
                  >
                    <title>{label}</title>
                  </circle>
                );
              })}
            </svg>
            <div className="traffic-map-caption">
              <span>
                {active ? name(active.code) : words("地区分布", "Regions")}
              </span>
              <strong>{active ? num(active.count) : "—"}</strong>
            </div>
          </>
        )}
      </div>
      <div className="traffic-regions">
        {regions.length ? (
          regions.slice(0, 7).map((row) => (
            <button
              key={row.code}
              type="button"
              data-region={row.code || "unknown"}
              className={selected === row.code ? "on" : ""}
              onClick={() => select(row.code)}
            >
              <span>{name(row.code)}</span>
              <strong>{num(row.count)}</strong>
            </button>
          ))
        ) : (
          <p className="traffic-empty">{words("暂无数据", "No data")}</p>
        )}
      </div>
    </div>
  );
}
export default function Traffic() {
  usePageReady();
  const words = useWords();
  const [days, setDays] = useState(7);
  const query = useQuery({
    queryKey: ["traffic", days],
    staleTime: 30_000,
    refetchInterval: 60_000,
    placeholderData: keepPreviousData,
    queryFn: ({ signal }) =>
      load<Report>(`/api/v1/traffic/summary?days=${days}`, signal),
  });
  const data = query.data;
  return (
    <div className="traffic-page" data-traffic-page>
      <Stall
        title={words("网站流量", "Website traffic")}
        h1
        action={
          <div className="traffic-tools">
            <label>
              <span className="sr">{words("统计范围", "Period")}</span>
              <select
                aria-label={words("统计范围", "Period")}
                value={days}
                onChange={(event) => setDays(Number(event.target.value))}
              >
                {[7, 30, 90].map((value) => (
                  <option key={value} value={value}>
                    {words(`${value} 天`, `${value} days`)}
                  </option>
                ))}
              </select>
            </label>
            <button
              className="bar-btn"
              type="button"
              disabled={query.isFetching}
              aria-label={words("刷新", "Refresh")}
              onClick={() => void query.refetch()}
            >
              <RefreshCw size={17} aria-hidden="true" />
            </button>
          </div>
        }
      >
        {query.isError && !data ? (
          <ErrorState retry={() => void query.refetch()} />
        ) : !data ? (
          <Loading />
        ) : (
          <dl className="traffic-metrics">
            <div>
              <dt>{words("今日浏览量", "Views today")}</dt>
              <dd data-traffic-today-pv>{num(data.today.pageviews)}</dd>
            </div>
            <div>
              <dt>{words("今日访客", "Visitors today")}</dt>
              <dd data-traffic-today-uv>{num(data.today.visitors)}</dd>
            </div>
            <div>
              <dt>{words(`${days} 天浏览量`, `${days}-day views`)}</dt>
              <dd data-traffic-pv>{num(data.pageviews)}</dd>
            </div>
          </dl>
        )}
      </Stall>
      {data && (
        <>
          <Stall
            title={words("地区分布", "Regions")}
            className="traffic-map-panel"
          >
            <RegionMap regions={data.regions} />
          </Stall>
          <div className="traffic-detail-grid">
            <Stall title={words("访问来源", "Sources")}>
              <Breakdown
                rows={data.sources.slice(0, 8)}
                total={data.pageviews}
              />
            </Stall>
            <Stall title={words("设备", "Devices")}>
              <Breakdown rows={data.devices} total={data.pageviews} devices />
            </Stall>
          </div>
        </>
      )}
    </div>
  );
}

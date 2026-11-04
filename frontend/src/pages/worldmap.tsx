import { useWords } from "../providers";
import { useNames } from "./catalogue";

// The client's world map as SVG: a region picture with the client's marker
// sprites beside the map list, and a route drawn over it. Same markup as
// pages/worldmap.rs on the server.

const MARKERS: Record<number, [string, number]> = {
  0: ["/web/images/worldmap/marker-town.png", 22],
  1: ["/web/images/worldmap/marker-spot.png", 17],
  2: ["/web/images/worldmap/marker-cluster.png", 22],
  3: ["/web/images/worldmap/marker-field.png", 16],
  4: ["/web/images/worldmap/marker-facility.png", 13],
};
const marker = (kind: number) => MARKERS[kind] || MARKERS[3];

/** "Lv.8–40", or "" without monsters. */
export const levels = (lo: number | null | undefined, hi: number | null | undefined) =>
  lo == null || hi == null ? "" : lo === hi ? `Lv.${lo}` : `Lv.${lo}–${hi}`;

function useSpotTip() {
  const words = useWords(),
    name = useNames();
  return (spot: any) =>
    [
      name(spot.map.names),
      levels(spot.level_min, spot.level_max),
      spot.map_count > 1 && words(`${spot.map_count} 张地图`, `${spot.map_count} maps`),
    ]
      .filter(Boolean)
      .join(" · ");
}

/** One island beside the map list: each spot links the list narrowed to it
 * (`href`, `pick`); `on` is the chosen spot and `lit` the hovered card's. */
export function ListWorld({
  region,
  on,
  lit,
  href,
  pick,
}: {
  region: any;
  on: string;
  lit: string | null;
  href: (spot: any) => string;
  pick: (spot: any) => void;
}) {
  const words = useWords(),
    name = useNames(),
    tip = useSpotTip();
  return (
    <svg
      className="mb-wm"
      xmlns="http://www.w3.org/2000/svg"
      viewBox={`0 0 ${region.width} ${region.height}`}
      preserveAspectRatio="xMidYMin meet"
      role="img"
      aria-label={words("世界地图：", "World map: ") + name(region.names)}
    >
      <image className="wm-img" href={region.image_url} width={region.width} height={region.height} />
      {region.spots.map((spot: any) => {
        const [sprite, size] = marker(spot.kind);
        return (
          <a
            key={spot.key}
            className={"mb-spot" + (spot.key === on ? " on" : "") + (spot.key === lit ? " hl" : "")}
            href={href(spot)}
            data-spot={spot.key}
            data-kind={spot.kind}
            onClick={(event) => {
              event.preventDefault();
              pick(spot);
            }}
          >
            <title>{tip(spot)}</title>
            <circle className="mb-ring" cx={spot.x} cy={spot.y} r={Math.trunc(size / 2) + 8} />
            <circle className="mb-hit" cx={spot.x} cy={spot.y} r={11} />
            <image
              href={sprite}
              x={spot.x - Math.trunc(size / 2)}
              y={spot.y - Math.trunc(size / 2)}
              width={size}
              height={size}
            />
            {spot.kind === 0 && (
              <text className="wm-label" x={spot.x} y={spot.y + Math.trunc(size / 2) + 11}>
                {name(spot.map.names)}
              </text>
            )}
          </a>
        );
      })}
    </svg>
  );
}

function OverviewRegion({ region, first, last }: { region: any; first: boolean; last: boolean }) {
  const words = useWords(),
    name = useNames();
  const xs = region.stops.map((s: any) => s.x),
    ys = region.stops.map((s: any) => s.y);
  const [x0, x1, y0, y1] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
  const pad = 40;
  const w = Math.min(Math.max(x1 - x0 + 2 * pad, 240), region.width);
  const h = Math.min(Math.max(y1 - y0 + 2 * pad, 150), region.height);
  const clamp = (v: number, hi: number) => Math.max(0, Math.min(v, hi));
  const vx = clamp(Math.trunc((x0 + x1) / 2) - Math.trunc(w / 2), region.width - w);
  const vy = clamp(Math.trunc((y0 + y1) / 2) - Math.trunc(h / 2), region.height - h);
  const scale = Math.min(560 / w, 2);
  const n = region.stops.length;
  return (
    <figure className="wm overview">
      <figcaption>{name(region.names)}</figcaption>
      <svg
        className="wm-svg"
        xmlns="http://www.w3.org/2000/svg"
        viewBox={`${vx} ${vy} ${w} ${h}`}
        width={Math.round(w * scale)}
        height={Math.round(h * scale)}
        role="img"
        aria-label={words("世界地图上的路线：", "Route on the world map: ") + name(region.names)}
      >
        <image className="wm-img" href={region.image_url} width={region.width} height={region.height} />
        <polyline className="wm-path" points={region.stops.map((s: any) => `${s.x},${s.y}`).join(" ")} />
        {region.stops.map((stop: any, i: number) => {
          const start = first && i === 0,
            end = last && i + 1 === n;
          return (
            <g key={i}>
              <a href={"/map/" + stop.map.id}>
                <title>{`${i + 1}. ${name(stop.map.names)}`}</title>
                <circle
                  className={"wm-stop" + (start ? " start" : "") + (end ? " end" : "")}
                  cx={stop.x}
                  cy={stop.y}
                  r={start || end ? 7 : 4.5}
                />
              </a>
              {(start || end) && (
                <text className="wm-label wm-stop-label" x={stop.x} y={stop.y - 11}>
                  {name(stop.map.names)}
                </text>
              )}
            </g>
          );
        })}
      </svg>
    </figure>
  );
}

export function RouteOverview({ overview }: { overview: any }) {
  const n = overview.regions.length;
  return (
    <div className="wm-overview">
      {overview.regions.map((region: any, i: number) => (
        <OverviewRegion key={i} region={region} first={i === 0} last={i + 1 === n} />
      ))}
    </div>
  );
}

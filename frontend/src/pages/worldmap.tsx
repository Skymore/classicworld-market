import { useWords } from "../providers";
import { useNames } from "./catalogue";

// The client's world map as SVG: region pictures with the client's marker
// sprites linking to their maps, and a route drawn over them. Same markup as
// pages/worldmap.rs on the server.

const MARKERS: Record<number, [string, number]> = {
  0: ["/web/images/worldmap/marker-town.png", 22],
  1: ["/web/images/worldmap/marker-spot.png", 17],
  2: ["/web/images/worldmap/marker-cluster.png", 22],
  3: ["/web/images/worldmap/marker-field.png", 16],
  4: ["/web/images/worldmap/marker-facility.png", 13],
};
const marker = (kind: number) => MARKERS[kind] || MARKERS[3];
const WORLD_SCALE = 1.4;

function useSpotTip() {
  const words = useWords(),
    name = useNames();
  return (spot: any) =>
    [
      name(spot.map.names),
      spot.level_min != null &&
        (spot.level_min === spot.level_max
          ? `Lv.${spot.level_min}`
          : `Lv.${spot.level_min}–${spot.level_max}`),
      spot.map_count > 1 && words(`${spot.map_count} 张地图`, `${spot.map_count} maps`),
    ]
      .filter(Boolean)
      .join(" · ");
}

function Region({ region, here }: { region: any; here: string[] }) {
  const words = useWords(),
    name = useNames(),
    tip = useSpotTip();
  return (
    <figure className="wm">
      <figcaption>{name(region.names)}</figcaption>
      <div className="mapvis-scroll">
        <svg
          className="wm-svg"
          xmlns="http://www.w3.org/2000/svg"
          viewBox={`0 0 ${region.width} ${region.height}`}
          width={Math.round(region.width * WORLD_SCALE)}
          height={Math.round(region.height * WORLD_SCALE)}
          role="img"
          aria-label={words("世界地图：", "World map: ") + name(region.names)}
        >
          <image className="wm-img" href={region.image_url} width={region.width} height={region.height} />
          {region.spots.map((spot: any) => {
            const [sprite, size] = marker(spot.kind);
            const isHere = here.includes(spot.key);
            return (
              <a
                key={spot.key}
                className={"wm-spot" + (isHere ? " here" : "")}
                href={"/map/" + spot.map.id}
                data-kind={spot.kind}
              >
                <title>{tip(spot)}</title>
                {isHere && <circle className="wm-ring" cx={spot.x} cy={spot.y} r={14} />}
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
                {isHere && (
                  <image
                    className="wm-here"
                    href="/web/images/worldmap/curpos-0.png"
                    x={spot.x - 8}
                    y={spot.y - Math.trunc(size / 2) - 35}
                    width={17}
                    height={35}
                  />
                )}
              </a>
            );
          })}
        </svg>
      </div>
    </figure>
  );
}

export function WorldBody({ page }: { page: any }) {
  const words = useWords(),
    name = useNames();
  const keys: [number, string, string][] = [
    [0, "城镇", "Town"],
    [3, "野外", "Field"],
    [2, "地下城", "Dungeon"],
    [1, "地点", "Place"],
    [4, "设施", "Facility"],
  ];
  return (
    <>
      {page.here && (
        <p className="wm-note">
          {words("箭头指的是", "The arrow points at ")}
          <a href={"/map/" + page.here.id}>{name(page.here.names)}</a>
          {words("所在的位置。", ".")}
        </p>
      )}
      <div className="wm-regions">
        {page.regions.map((region: any) => (
          <Region key={region.id} region={region} here={page.here_spots || []} />
        ))}
      </div>
      <div className="wm-keys">
        {keys.map(([kind, zh, en]) => (
          <span className="wm-key" key={kind}>
            <img src={marker(kind)[0]} alt="" width={16} height={16} />
            {words(zh, en)}
          </span>
        ))}
      </div>
    </>
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

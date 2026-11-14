import { useEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import { useWords } from "../providers";
import { useNames } from "./catalogue";
import { Zoomable } from "./zoom";

// The map view: the client minimap as an SVG with each monster's head on its
// spawn points, portals that link to where they lead, and NPCs. Same markup as
// pages/mapview.rs on the server; this one adds the layer toggles and the
// legend that picks out one monster.

type Point = { x: number; y: number };

export const headUrl = (mobId: number) => `/web/images/mobs/head/${mobId}.png`;
// The picture on a spawn point: the standing sprite at game size, or the head.
const spawnUrl = (s: any) => (s.stand ? `/web/images/mobs/stand/${s.mob_id}.png` : headUrl(s.mob_id));

const fmt = (v: number) => String(Math.round(v * 10) / 10);

function respawnNote(seconds: number, words: (zh: string, en: string) => string) {
  if (seconds <= 0) return null;
  const minutes = Math.round(seconds / 60);
  return minutes === 0
    ? words(`${seconds} 秒后重生`, `respawns in ${seconds}s`)
    : words(`约 ${minutes} 分钟重生`, `respawns in ~${minutes} min`);
}

// "传送口 → 射手村", noting portals the game does not draw.
function portalTip(p: any, to: string, words: (zh: string, en: string) => string) {
  if (p.portal_type === 1)
    return (
      words("隐藏传送口 → ", "Hidden portal → ") +
      to +
      words("（游戏里看不到，站在这里按↑）", " (not drawn in game; stand here and press up)")
    );
  if (p.portal_type === 3) return words("传送口 → ", "Portal → ") + to + words("（走进去就传送）", " (walk into it)");
  return words("传送口 → ", "Portal → ") + to;
}

// A map view that opens full screen (phones: tap it).
export function ZoomMap(props: Parameters<typeof MapSvg>[0]) {
  const v = props.view;
  return (
    <Zoomable title={props.title} width={v.width} height={v.height} focus={props.exit || null}>
      {(zoomed) => <MapSvg {...props} zoomed={zoomed} key={zoomed ? "z" : "i"} />}
    </Zoomable>
  );
}

const isWide = (view: any) => view.width > (view.height * 5) / 2;

// What the page takes from the screen width on phones. Keep in step with
// PHONE_MARGIN and scene_sizes in pages/mapview.rs.
const PHONE_MARGIN = 64;
function sceneSizes(view: any) {
  const w = view.shown_width;
  const fit = `(max-width: ${w + PHONE_MARGIN}px) calc(100vw - ${PHONE_MARGIN}px), ${w}px`;
  return isWide(view) ? `(max-width: 700px) 640px, ${fit}` : fit;
}

// The scene as an <img> in a <foreignObject>, so the browser picks the phone
// copy through srcset. `full` asks for the full-size picture (the zoomed view).
function ScenePicture({ view, full = false }: { view: any; full?: boolean }) {
  const s = view.scene;
  const srcSet = !full && s.small_url ? `${s.small_url} ${s.small_px}w, ${s.url} ${s.px}w` : undefined;
  return (
    <foreignObject className="mv-scene" x={s.x} y={s.y} width={s.width} height={s.height}>
      <img sizes={srcSet && sceneSizes(view)} srcSet={srcSet} src={s.url} alt="" />
    </foreignObject>
  );
}

// True once the element comes within 200 px of the viewport; at once when
// not deferred.
function useNear(ref: RefObject<Element | null>, defer: boolean) {
  const [near, setNear] = useState(() => !defer || typeof IntersectionObserver === "undefined");
  useEffect(() => {
    if (near || !ref.current) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) setNear(true);
      },
      { rootMargin: "200px 0px" },
    );
    observer.observe(ref.current);
    return () => observer.disconnect();
  }, [near, ref]);
  return near;
}

export function MapSvg({
  view,
  title,
  mobs = [],
  npc,
  exit,
  arrival,
  links = false,
  focus = null,
  layers = { mobs: true, portals: true, npcs: true },
  exitNpc = false,
  deferScene = false,
  zoomed = false,
}: {
  view: any;
  title: string;
  mobs?: any[];
  npc?: number;
  exit?: Point | null;
  arrival?: Point | null;
  links?: boolean;
  focus?: number | null;
  layers?: { mobs: boolean; portals: boolean; npcs: boolean };
  /** `exit` is an NPC (ship, taxi), not a portal. */
  exitNpc?: boolean;
  /** Load the scene only as the view nears the screen (route steps after
   * the first); until then the view is its empty background. */
  deferScene?: boolean;
  /** The full-screen copy: the full-size scene over the copy already shown. */
  zoomed?: boolean;
}) {
  const words = useWords(),
    name = useNames();
  const box = useRef<HTMLDivElement>(null);
  const near = useNear(box, deferScene && !zoomed);
  // A map with a scene always shows it; the minimap is the picture of maps without one.
  const showScene = view.scene && near;
  const showMinimap = !view.scene && view.image_url;
  const u = view.icon;
  const mobLabel = (id: number) => {
    const row = mobs.find((m: any) => m.mob.id === id);
    if (!row) return "#" + id;
    return name(row.mob.names) + (row.mob.level != null ? ` Lv.${row.mob.level}` : "");
  };
  const link = (href: string, body: ReactNode, extra: any = {}) =>
    links ? (
      <a href={href} {...extra}>
        {body}
      </a>
    ) : (
      <g {...extra}>{body}</g>
    );
  const lift = (y: number) => fmt(y - u * 0.45);
  return (
    <div className="mapvis-scroll" ref={box}>
      <svg
        className={"mapvis-svg" + (isWide(view) ? " wide" : "")}
        xmlns="http://www.w3.org/2000/svg"
        viewBox={`0 0 ${view.width} ${view.height}`}
        width={view.shown_width}
        height={view.shown_height}
        role="img"
        aria-label={words("小地图：", "Minimap: ") + title}
      >
        <rect className="mv-bg" width={view.width} height={view.height} />
        {showMinimap && (
          <image
            className="mv-img"
            href={view.image_url}
            width={view.width}
            height={view.height}
            preserveAspectRatio="none"
          />
        )}
        {showScene && <ScenePicture view={view} />}
        {showScene && zoomed && <ScenePicture view={view} full />}
        {layers.mobs && (
          <g className={"mv-mobs" + (focus != null ? " focused" : "")}>
            {view.spawns.map((s: any, i: number) => {
              const note = respawnNote(s.mob_time, words);
              return (
                <g key={i}>
                  {link(
                    "/mob/" + s.mob_id,
                    <>
                      <title>{mobLabel(s.mob_id) + (note ? " · " + note : "")}</title>
                      <ellipse
                        className="mv-shadow"
                        cx={s.x}
                        cy={s.y}
                        rx={fmt(s.w * 0.38)}
                        ry={fmt(s.w * 0.12)}
                      />
                      {s.mob_time > 0 && (
                        <circle
                          className="mv-timed"
                          cx={s.x}
                          cy={fmt(s.y - s.h * 0.5)}
                          r={fmt(Math.max(s.w, s.h) * 0.62)}
                        />
                      )}
                      <image href={spawnUrl(s)} x={fmt(s.x - s.w / 2)} y={s.y - s.h} width={s.w} height={s.h} />
                    </>,
                    {
                      className: "mv-mob" + (focus === s.mob_id ? " on" : ""),
                      "data-mob": s.mob_id,
                    },
                  )}
                </g>
              );
            })}
          </g>
        )}
        {layers.npcs && (
          <g className="mv-npcs">
            {view.npcs.map((n: any, i: number) => {
              const big = npc === n.npc.id;
              const r = big ? u * 0.55 : u * 0.34;
              const cy = n.y - r - u * 0.1;
              const body = (
                <>
                  <title>{"NPC · " + (name(n.npc.names) || "NPC #" + n.npc.id)}</title>
                  <circle className={"mv-npc" + (big ? " here" : "")} cx={n.x} cy={fmt(cy)} r={fmt(r)} />
                  <text className="mv-npc-t" x={n.x} y={fmt(cy + r * 0.38)} fontSize={fmt(r * 1.1)}>
                    N
                  </text>
                </>
              );
              return links && !big ? (
                <a key={i} href={"/npc/" + n.npc.id}>
                  {body}
                </a>
              ) : (
                <g key={i}>{body}</g>
              );
            })}
          </g>
        )}
        {layers.portals && (
          <g className="mv-portals">
            {view.portals.map((p: any, i: number) => (
              <g key={i}>
                {link(
                  "/map/" + p.to.id,
                  <>
                    <title>{portalTip(p, name(p.to.names), words)}</title>
                    <circle
                      className={"mv-portal" + (p.portal_type === 1 ? " hidden" : "")}
                      cx={p.x}
                      cy={lift(p.y)}
                      r={fmt(u * 0.36)}
                    />
                    <circle className="mv-portal-core" cx={p.x} cy={lift(p.y)} r={fmt(u * 0.14)} />
                  </>,
                )}
              </g>
            ))}
          </g>
        )}
        {(exit || arrival) && (
          <g className="mv-route">
            {exit && arrival && (
              <line
                className="mv-path"
                x1={arrival.x}
                y1={lift(arrival.y)}
                x2={exit.x}
                y2={lift(exit.y)}
                strokeWidth={fmt(u * 0.12)}
                strokeDasharray={`${fmt(u * 0.4)} ${fmt(u * 0.25)}`}
              />
            )}
            {arrival && (
              <circle
                className="mv-arrival"
                cx={arrival.x}
                cy={lift(arrival.y)}
                r={fmt(u * 0.5)}
                strokeWidth={fmt(u * 0.14)}
              >
                <title>{words("你从这里进入", "You arrive here")}</title>
              </circle>
            )}
            {exit && (
              <circle className="mv-exit" cx={exit.x} cy={lift(exit.y)} r={fmt(u * 0.7)} strokeWidth={fmt(u * 0.16)}>
                <title>{exitNpc ? words("找这个 NPC", "Talk to this NPC") : words("走这个传送口", "Take this portal")}</title>
              </circle>
            )}
          </g>
        )}
      </svg>
    </div>
  );
}

// The map page's view: layer toggles, the minimap, and a legend whose chips
// pick out one monster's spawn points.
export function MapViewPanel({ view, title, mobs }: { view: any; title: string; mobs: any[] }) {
  const words = useWords(),
    name = useNames();
  const [focus, setFocus] = useState<number | null>(null);
  const [layers, setLayers] = useState({ mobs: true, portals: true, npcs: true });
  const toggle = (key: "mobs" | "portals" | "npcs") => setLayers((l) => ({ ...l, [key]: !l[key] }));
  const toggles: ["mobs" | "portals" | "npcs", string, string, number][] = [
    ["mobs", "怪物", "Monsters", view.spawns.length],
    ["portals", "传送口", "Portals", view.portals.length],
    ["npcs", "NPC", "NPCs", view.npcs.length],
  ];
  const shown = toggles.filter(([, , , n]) => n > 0);
  return (
    <figure className="mapvis">
      {shown.length > 1 && (
        <div className="mv-tools" role="group" aria-label={words("显示", "Show")}>
          {shown.map(([key, zh, en]) => (
            <button
              type="button"
              key={key}
              className={"mv-toggle " + key}
              aria-pressed={layers[key]}
              onClick={() => toggle(key)}
            >
              {words(zh, en)}
            </button>
          ))}
        </div>
      )}
      <ZoomMap view={view} title={title} mobs={mobs} links focus={focus} layers={layers} />
      {view.spawns.length > 0 && layers.mobs && (
        <div className="mv-legend">
          {mobs.map((m: any) => (
            <button
              type="button"
              key={m.mob.id}
              className="mv-chip"
              aria-pressed={focus === m.mob.id}
              onClick={() => setFocus(focus === m.mob.id ? null : m.mob.id)}
            >
              <img src={headUrl(m.mob.id)} alt="" width={20} height={20} loading="lazy" />
              <span>{name(m.mob.names)}</span>
              <small>{m.spawn_count}</small>
            </button>
          ))}
          {focus != null && (
            <button type="button" className="mv-chip clear" onClick={() => setFocus(null)}>
              {words("全部", "All")}
            </button>
          )}
        </div>
      )}
    </figure>
  );
}

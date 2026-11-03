import { useState, type ReactNode } from "react";
import { useWords } from "../providers";
import { useNames } from "./catalogue";

// The map view: the client minimap as an SVG with each monster's head on its
// spawn points, portals that link to where they lead, and NPCs. Same markup as
// pages/mapview.rs on the server; this one adds the layer toggles and the
// legend that picks out one monster.

type Point = { x: number; y: number };

export const headUrl = (mobId: number) => `/web/images/mobs/head/${mobId}.png`;

const fmt = (v: number) => String(Math.round(v * 10) / 10);

function respawnNote(seconds: number, words: (zh: string, en: string) => string) {
  if (seconds <= 0) return null;
  const minutes = Math.round(seconds / 60);
  return minutes === 0
    ? words(`${seconds} 秒后重生`, `respawns in ${seconds}s`)
    : words(`约 ${minutes} 分钟重生`, `respawns in ~${minutes} min`);
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
  scene = true,
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
  /** Draw the rendered scene when the map has one (else the minimap). */
  scene?: boolean;
}) {
  const words = useWords(),
    name = useNames();
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
    <div className="mapvis-scroll">
      <svg
        className={"mapvis-svg" + (view.width > (view.height * 5) / 2 ? " wide" : "")}
        xmlns="http://www.w3.org/2000/svg"
        viewBox={`0 0 ${view.width} ${view.height}`}
        width={view.shown_width}
        height={view.shown_height}
        role="img"
        aria-label={words("小地图：", "Minimap: ") + title}
      >
        <rect className="mv-bg" width={view.width} height={view.height} />
        {scene && view.scene ? (
          <image
            className="mv-scene"
            href={view.scene.url}
            x={view.scene.x}
            y={view.scene.y}
            width={view.scene.width}
            height={view.scene.height}
            preserveAspectRatio="none"
          />
        ) : (
          view.image_url && (
            <image
              className="mv-img"
              href={view.image_url}
              width={view.width}
              height={view.height}
              preserveAspectRatio="none"
            />
          )
        )}
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
                        rx={fmt(u * 0.36)}
                        ry={fmt(u * 0.12)}
                      />
                      {s.mob_time > 0 && (
                        <circle className="mv-timed" cx={s.x} cy={fmt(s.y - u * 0.5)} r={fmt(u * 0.62)} />
                      )}
                      <image
                        href={headUrl(s.mob_id)}
                        x={fmt(s.x - u / 2)}
                        y={fmt(s.y - u)}
                        width={u}
                        height={u}
                      />
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
                    <title>{words("传送口 → ", "Portal → ") + name(p.to.names)}</title>
                    <circle className="mv-portal" cx={p.x} cy={lift(p.y)} r={fmt(u * 0.36)} />
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
                <title>{words("走这个传送口", "Take this portal")}</title>
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
  const [scene, setScene] = useState(true);
  const toggle = (key: "mobs" | "portals" | "npcs") => setLayers((l) => ({ ...l, [key]: !l[key] }));
  const toggles: ["mobs" | "portals" | "npcs", string, string, number][] = [
    ["mobs", "怪物", "Monsters", view.spawns.length],
    ["portals", "传送口", "Portals", view.portals.length],
    ["npcs", "NPC", "NPCs", view.npcs.length],
  ];
  const shown = toggles.filter(([, , , n]) => n > 0);
  return (
    <figure className="mapvis">
      {(shown.length > 1 || (view.scene && view.image_url)) && (
        <div className="mv-tools" role="group" aria-label={words("显示", "Show")}>
          {view.scene && view.image_url && (
            <span className="mv-seg">
              <button type="button" aria-pressed={scene} onClick={() => setScene(true)}>
                {words("场景", "Scene")}
              </button>
              <button type="button" aria-pressed={!scene} onClick={() => setScene(false)}>
                {words("小地图", "Minimap")}
              </button>
            </span>
          )}
          {shown.length > 1 && shown.map(([key, zh, en, n]) => (
            <button
              type="button"
              key={key}
              className={"mv-toggle " + key}
              aria-pressed={layers[key]}
              onClick={() => toggle(key)}
            >
              {words(zh, en)} <small>{n}</small>
            </button>
          ))}
        </div>
      )}
      <MapSvg view={view} title={title} mobs={mobs} links focus={focus} layers={layers} scene={scene} />
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

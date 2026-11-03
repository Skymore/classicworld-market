import { use, useEffect, useState, type ReactNode } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { useQuery, keepPreviousData } from "@tanstack/react-query";
import { usePreferences, useWords } from "../providers";
import {
  Icon,
  Slot,
  Price,
  ErrorState,
  Loading,
  usePageReady,
} from "../components/shared";
import Item from "./item";
import { catalogKey, loadCatalog } from "../lib/catalog";
import { useUserValue } from "../lib/live";
import { useProvidePageContext } from "../lib/assistant";
import { normalizeOfferFilters } from "/web/js/lib/item-offer-filters.js?v=20261029-critical-1";
import { MapViewPanel, ZoomMap } from "./mapview";
import { RouteOverview, WorldBody } from "./worldmap";
export function useNames() {
  const { language } = usePreferences();
  return (names: any) =>
    typeof names === "string"
      ? names
      : names?.[language] || names?.zh || names?.en || "";
}
export function Secondary({ names }: { names: any }) {
  const { language } = usePreferences();
  const name = useNames();
  const other = names?.[language === "en" ? "zh" : "en"];
  return other && other !== name(names) ? (
    <span className="name-secondary">{other}</span>
  ) : null;
}
// Classic World client sprites in web/images/mobs (see its sources.json) for
// mobs the GMS v83 renderer lacks; keep in step with LOCAL_SPRITES in pages.rs.
const LOCAL_SPRITES = new Set([
  39, 42, 54, 55, 56, 57, 58, 59, 60, 61, 62, 63, 64, 65, 66, 67, 68, 69, 1059, 700003, 700006, 700007, 700008, 800019, 800020, 800021, 800022, 800023, 800024, 800025, 810000, 810001, 810002, 810003, 810004, 810005, 900000, 910000,
]);
export function MobPicture({ mob, big = false }: { mob: any; big?: boolean }) {
  const id = mob.image_id;
  const url = LOCAL_SPRITES.has(mob.id)
    ? `/web/images/mobs/${mob.id}.png`
    : id
      ? `https://maplestory.io/api/GMS/83/mob/${id}/render/stand`
      : null;
  return (
    <span className={"mobpic " + (big ? "big" : "")}>
      {url && (
        <img
          src={url}
          alt=""
          loading="lazy"
          onError={(event) => {
            event.currentTarget.style.visibility = "hidden";
          }}
        />
      )}
    </span>
  );
}
export function Well({
  title,
  note,
  children,
  className = "",
  id,
}: {
  title: string;
  note?: ReactNode;
  children: ReactNode;
  className?: string;
  id?: string;
}) {
  return (
    <section className={"well " + className} id={id}>
      <div className="well-h">
        <h3>{title}</h3>
        {note != null && <small>{note}</small>}
      </div>
      {children}
    </section>
  );
}
export function MapRow({
  map,
  sub,
  right,
  href,
}: {
  map: any;
  sub?: ReactNode;
  right?: ReactNode;
  href?: string;
}) {
  const name = useNames();
  return (
    <a className="drow" href={href || "/map/" + map.id}>
      <span className="glyph">
        <Icon name="map" />
      </span>
      <span className="t">
        <b>{name(map.names)}</b>
        <Secondary names={map.names} />
        {sub && <span className="s">{sub}</span>}
      </span>
      {right && <span className="r">{right}</span>}
    </a>
  );
}
export function MobRow({ mob, right }: { mob: any; right?: ReactNode }) {
  const name = useNames();
  return (
    <a className="drow" href={"/mob/" + mob.id}>
      <MobPicture mob={mob} />
      <span className="t">
        <b>{name(mob.names)}</b>
        {mob.level != null && <span className="lv">Lv.{mob.level}</span>}
        <Secondary names={mob.names} />
      </span>
      {right && <span className="r">{right}</span>}
    </a>
  );
}
/** Unit prices rounded by the server: bundle items such as arrows cost under 1 meso each. */
function UnitPrice({ value }: { value?: number | null }) {
  return value != null && value < 1 ? <>&lt;1</> : <Price value={value} />;
}
function Crumb({ text }: { text: string }) {
  const words = useWords();
  return (
    <nav className="crumb on-desktop" aria-label={words("位置", "Breadcrumb")}>
      <a href="/search">{words("图鉴", "Dex")}</a>
      <Icon name="chev" />
      <span>{text}</span>
    </nav>
  );
}
function Description({ text }: { text?: string }) {
  return text ? (
    <div className="desc">
      {text
        .split("\n")
        .filter((line) => line.trim())
        .map((line, i) => (
          <p key={i}>{line}</p>
        ))}
    </div>
  ) : null;
}
function Mob({ page }: { page: any }) {
  const words = useWords(),
    name = useNames(),
    mob = page.mob,
    title = name(mob.names);
  useProvidePageContext({ kind: "mob", id: mob.id, label: title.slice(0, 120) });
  // The server lists mesos and priced drops first; show ten before "show all".
  const [allDrops, setAllDrops] = useState(false);
  const [allSpawns, setAllSpawns] = useState(false);
  const stats = [
    ["hp", "HP", "HP"],
    ["mp", "MP", "MP"],
    ["exp", "经验", "EXP"],
    ["pad", "物理攻击", "Weapon ATT"],
    ["pdd", "物理防御", "Weapon DEF"],
    ["mad", "魔法攻击", "Magic ATT"],
    ["mdd", "魔法防御", "Magic DEF"],
    ["acc", "命中", "Accuracy"],
    ["eva", "回避", "Avoid"],
    ["speed", "移动速度", "Speed"],
  ];
  return (
    <>
      <Crumb text={title} />
      <section className="stall">
        <div className="stall-bar">
          <h2>
            {words("怪物图鉴", "Monster")} · {title}
          </h2>
        </div>
        <div className="ihead mob-head">
          <MobPicture mob={mob} big />
          <div>
            <h1>{title}</h1>
            <div className="en">
              <Secondary names={mob.names} />
            </div>
            <div className="tags">
              {mob.level != null && (
                <span className="tagx">Lv.{mob.level}</span>
              )}
              {mob.is_boss && (
                <span className="tagx hot">{words("首领", "Boss")}</span>
              )}
              {mob.is_undead && (
                <span className="tagx">{words("不死系", "Undead")}</span>
              )}
            </div>
          </div>
        </div>
        {page.spawns.length > 0 && (
          <div className="actions">
            <a className="btn primary" href={"/route?from=10001000&mob=" + mob.id}>
              {words("从射手村去最近的刷怪地图", "Nearest spawn map from Henesys")}
            </a>
          </div>
        )}
        <dl className="stats">
          {stats.map(([key, zh, en]) => (
            <div key={key}>
              <dt>{words(zh, en)}</dt>
              <dd>
                {mob[key] != null ? Number(mob[key]).toLocaleString() : "—"}
              </dd>
            </div>
          ))}
        </dl>
        <Description
          text={mob.description
            ?.split("\n")
            .filter((line: string) => !/^\s*等级[：:]\s*\d+\s*$/.test(line))
            .join("\n")}
        />
        <div className="dgrid">
          <Well
            title={words("掉落", "Drops")}
            note={words(`${page.drops.length} 种`, `${page.drops.length} kinds`)}
          >
            {page.drops.slice(0, allDrops ? undefined : 10).map((drop: any, i: number) => {
              const item = drop.what.Item,
                meso = drop.what.Meso,
                unlisted = drop.what.Unlisted;
              const target = item || unlisted;
              const body = (
                <>
                  <>
                    {item ? (
                      <Slot empty url={item.icon_url} />
                    ) : meso ? (
                      <span className="slot s28 coin">{words("金", "$")}</span>
                    ) : (
                      <Slot empty />
                    )}
                  </>
                  <span className="t">
                    <b>
                      {meso
                        ? words("金币", "Mesos")
                        : name(target?.names) ||
                          words(
                            `物品 #${target?.id ?? "?"}`,
                            `Item #${target?.id ?? "?"}`,
                          )}
                    </b>
                    {!meso && <Secondary names={target?.names} />}
                    <span className="s">
                      {meso ? (
                        `${meso.min}–${meso.max}`
                      ) : item ? (
                        <>
                          {item.typical != null ? (
                            <>
                              {words("成交价 ", "typical ")}
                              <UnitPrice value={item.typical} />
                            </>
                          ) : (
                            words("暂无成交", "no sales yet")
                          )}
                          {item.lowest_ask != null && (
                            <>
                              {" "}
                              · {words("在售最低 ", "lowest ask ")}
                              <UnitPrice value={item.lowest_ask} />
                            </>
                          )}
                        </>
                      ) : (
                        words("不在市场目录", "not in the market catalogue")
                      )}
                      {drop.quest_id &&
                        words(
                          ` · 任务 #${drop.quest_id} 期间`,
                          ` · during quest #${drop.quest_id}`,
                        )}
                    </span>
                  </span>
                </>
              );
              return item ? (
                <a className="drow" href={"/item/" + item.id} key={i}>
                  {body}
                </a>
              ) : (
                <div className="drow" key={i}>
                  {body}
                </div>
              );
            })}
            {!allDrops && page.drops.length > 10 && (
              <button
                type="button"
                className="more"
                data-more="drops"
                onClick={() => setAllDrops(true)}
              >
                {words(
                  `显示全部 ${page.drops.length} 种 `,
                  `Show all ${page.drops.length} `,
                )}
                <Icon name="chev" />
              </button>
            )}
            {!page.drops.length && (
              <p className="note">
                {words(
                  "还没有玩家确认这只怪物的掉落。",
                  "No player has confirmed a drop for this monster yet.",
                )}
              </p>
            )}
          </Well>
          <Well
            title={words("出现地图", "Found in")}
            note={words(
              `${page.spawns.length} 张`,
              `${page.spawns.length} maps`,
            )}
          >
            {page.spawns.slice(0, allSpawns ? undefined : 10).map((spawn: any, i: number) => (
              <MapRow
                key={i}
                map={spawn.map}
                sub={name(spawn.street)}
                right={words(
                  `${spawn.spawn_count} 个刷怪点`,
                  `${spawn.spawn_count} spawns`,
                )}
              />
            ))}
            {!allSpawns && page.spawns.length > 10 && (
              <button
                type="button"
                className="more"
                data-more="spawns"
                onClick={() => setAllSpawns(true)}
              >
                {words(
                  `显示全部 ${page.spawns.length} 张 `,
                  `Show all ${page.spawns.length} `,
                )}
                <Icon name="chev" />
              </button>
            )}
            {!page.spawns.length && (
              <p className="note">
                {words(
                  "图鉴里没有这只怪物的出现地图。",
                  "The dex has no maps for this monster.",
                )}
              </p>
            )}
          </Well>
          {page.quests?.length > 0 && (
            <Well
              title={words("相关任务", "Quests")}
              note={words(`${page.quests.length} 个任务`, `${page.quests.length} quests`)}
            >
              <QuestRows rows={page.quests} defeat />
            </Well>
          )}
        </div>
      </section>
    </>
  );
}
// Job and gender names, as the quest rows show them.
const JOBS: Record<string, [string, string]> = {
  Beginner: ["新手", "Beginner"],
  Warrior: ["战士", "Warrior"],
  Magician: ["魔法师", "Magician"],
  Bowman: ["弓箭手", "Bowman"],
  Thief: ["飞侠", "Thief"],
  Male: ["男", "Male"],
  Female: ["女", "Female"],
};
// Quests that give an item, ask for one, or (defeat) ask to defeat a monster.
// The same rows as the server's first paint (bestiary/pages.rs).
export function QuestRows({ rows, defeat = false }: { rows: any[]; defeat?: boolean }) {
  const words = useWords(),
    name = useNames();
  const job = (j: string) => words(...(JOBS[j] || [j, j]));
  const note = (r: any) => {
    const who = r.job ? job(r.job) : null;
    if (r.kind === "choice") return who ? words(`${who}可选其一`, `${who} pick one`) : words("可选其一", "pick one");
    if (r.kind === "random") {
      const chance = r.chance_pct != null ? ` ${Math.round(r.chance_pct * 10) / 10}%` : "";
      return words(`${who ? who + " " : ""}随机${chance}`, `${who ? who + " " : ""}random${chance}`);
    }
    return who ? words(`仅${who}`, `${who} only`) : null;
  };
  return (
    <div className="quests">
      {rows.map((r: any) => {
        const q = r.quest;
        const meta = [
          q.npc && (name(q.npc.names) || "NPC #" + q.npc.id),
          q.level_min != null && `Lv.${q.level_min}`,
          q.repeats === "daily" && words("每日", "daily"),
          q.repeats === "weekly" && words("每周", "weekly"),
          q.ends_at && words(`活动至 ${q.ends_at.slice(5, 10)}`, `event until ${q.ends_at.slice(5, 10)}`),
          !defeat && r.kind && note(r),
        ].filter(Boolean);
        return (
          <a
            className="quest"
            key={q.id}
            href={`https://meowdb.com/msclassic/quest-tracker/${q.id}`}
            target="_blank"
            rel="noopener noreferrer"
          >
            <b>{name(q.names)}</b>
            <span className="qn">{defeat ? words(`击败 ${r.quantity}`, `defeat ${r.quantity}`) : `×${r.quantity}`}</span>
            <span className="qm">{meta.join(" · ")}</span>
          </a>
        );
      })}
    </div>
  );
}
// Portal names (east00, dun00) are internal map data, so only the way of travel is shown.
function Edge({ kind }: { kind: string; portal?: string }) {
  const words = useWords();
  const labels: Record<string, [string, string]> = {
    portal: ["走传送口", "Walk through portal"],
    ship: ["坐船", "Take a ship"],
    taxi: ["坐出租车", "Take a taxi"],
    return: [
      "用回城卷轴（阵亡后也回到这里）",
      "Use a return scroll (also returns here after death)",
    ],
  };
  return <>{words(...(labels[kind] || [kind, kind]))}</>;
}
function MapPage({ page }: { page: any }) {
  const words = useWords(),
    name = useNames(),
    map = page.map,
    title = name(map.names);
  useProvidePageContext({ kind: "map", id: map.id, label: title.slice(0, 120) });
  const scrolls = page.entrances.filter((link: any) => link.kind === "return"),
    walks = page.entrances.filter((link: any) => link.kind !== "return");
  // Snapshots cached before the map view carry no quest lists.
  const given: any[] = page.quests_given || [],
    hunted: any[] = page.quests_hunted || [];
  return (
    <>
      <Crumb text={title} />
      <section className="stall">
        <div className="stall-bar">
          <h2>
            {words("地图", "Map")} · {title}
          </h2>
          <span className="bar-meta">{name(map.street)}</span>
        </div>
        <div className="ihead solo">
          <div>
            <h1>{title}</h1>
            <div className="en">
              <Secondary names={map.names} />
            </div>
            <div className="tags">
              {map.street && <span className="tagx">{name(map.street)}</span>}
              {map.is_town && (
                <span className="tagx">{words("城镇", "Town")}</span>
              )}
              {map.mob_rate != null && (
                <span className="tagx">
                  {words("刷怪倍率 ", "spawn rate ")}
                  {Number(map.mob_rate).toFixed(1)}
                </span>
              )}
            </div>
          </div>
        </div>
        <div className="actions">
          <a
            className="btn primary"
            href={
              "/route?from=10001000" +
              (map.id === 10001000 ? "" : "&to=" + map.id)
            }
          >
            {map.id === 10001000
              ? words("从这里出发去哪", "Where to from here")
              : words("从射手村怎么走", "How to get here from Henesys")}
          </a>
          {page.return_map && (
            <a className="btn" href={"/map/" + page.return_map.id}>
              <span>
                {words("回城点：", "Return town: ")}
                {name(page.return_map.names)}
                <Secondary names={page.return_map.names} />
              </span>
            </a>
          )}
          {page.on_world_map && (
            <a className="btn" href={"/world?map=" + map.id}>
              {words("在世界地图上看", "On the world map")}
            </a>
          )}
        </div>
        {page.from_henesys && (
          <a
            className="route-strip"
            href={"/route?from=10001000&to=" + map.id}
          >
            <span className="rs-h">
              {words("从射手村过来", "From Henesys")}
              <small>
                {words(
                  `${page.from_henesys.length - 1} 步`,
                  `${page.from_henesys.length - 1} steps`,
                )}
              </small>
            </span>
            <span className="rs-path">
              {page.from_henesys.map((stop: any, i: number) => (
                <span key={i}>
                  {i > 0 && <span className="rs-arrow">→</span>}
                  <span
                    className={
                      "rs-stop" +
                      (i + 1 === page.from_henesys.length ? " last" : "")
                    }
                  >
                    {name(stop.names)}
                  </span>
                </span>
              ))}
            </span>
          </a>
        )}
        {page.view ? (
          <MapViewPanel view={page.view} title={title} mobs={page.mobs} />
        ) : map.minimap_url ? (
          <img
            className="minimap"
            src={map.minimap_url}
            alt={words("小地图：", "Minimap: ") + title}
            loading="lazy"
          />
        ) : null}
        <Description text={map.description} />
        <div className="dgrid">
          <div className="dcol">
            <Well
              title={words("怪物", "Monsters")}
              note={words(
                `${page.mobs.length} 种`,
                `${page.mobs.length} kinds`,
              )}
            >
              {page.mobs.map((row: any, i: number) => (
                <MobRow
                  key={i}
                  mob={row.mob}
                  right={words(
                    `${row.spawn_count} 个刷怪点`,
                    `${row.spawn_count} spawns`,
                  )}
                />
              ))}
              {!page.mobs.length && (
                <p className="note">
                  {words("这张地图没有刷怪记录。", "No monsters spawn here.")}
                </p>
              )}
            </Well>
            <Well title="NPC" note={page.npcs.length}>
              {page.npcs.map((npc: any) => (
                <a className="drow" key={npc.id} href={"/npc/" + npc.id}>
                  <span className="glyph">N</span>
                  <span className="t">
                    <b>{name(npc.names) || "NPC #" + npc.id}</b>
                    <Secondary names={npc.names} />
                  </span>
                </a>
              ))}
              {!page.npcs.length && (
                <p className="note">
                  {words("这张地图没有 NPC 记录。", "No NPCs recorded here.")}
                </p>
              )}
            </Well>
          </div>
          <div className="dcol">
            <Well title={words("传送", "Portals")}>
              <div className="sub-h">{words("从这里去", "Leads to")}</div>
              {page.exits.map((link: any, i: number) => (
                <MapRow
                  key={i}
                  map={link.other}
                  sub={<Edge kind={link.kind} portal={link.portal_name} />}
                />
              ))}
              {!page.exits.length && (
                <p className="note">
                  {words("还没有从这里出去的连接。", "No known way out yet.")}
                </p>
              )}
              <div className="sub-h ruled">
                {words("从这些地图过来", "Comes from")}
              </div>
              {walks.map((link: any, i: number) => (
                <MapRow
                  key={i}
                  map={link.other}
                  sub={<Edge kind={link.kind} portal={link.portal_name} />}
                />
              ))}
              {!page.entrances.length && (
                <p className="note">
                  {words("还没有到这里的连接。", "No known way in yet.")}
                </p>
              )}
              {scrolls.length > 0 && (
                <>
                  <div className="sub-h ruled">
                    {words(
                      "用回城卷轴回到这里",
                      "Return scrolls lead here from",
                    )}
                    <small>
                      {words(
                        `${scrolls.length} 张地图`,
                        `${scrolls.length} maps`,
                      )}
                    </small>
                  </div>
                  <p className="townlist">
                    {scrolls.map((link: any, i: number) => (
                      <span key={i}>
                        {i > 0 ? " · " : ""}
                        <a href={"/map/" + link.other.id}>
                          {name(link.other.names)}
                          <Secondary names={link.other.names} />
                        </a>
                      </span>
                    ))}
                  </p>
                </>
              )}
            </Well>
            {(given.length > 0 || hunted.length > 0) && (
              <Well title={words("任务", "Quests")}>
                {given.length > 0 && (
                  <>
                    <div className="sub-h">
                      {words("在这里接", "Given here")}
                      <small>{questCount(words, given.length)}</small>
                    </div>
                    <QuestList quests={given} withNpc />
                  </>
                )}
                {hunted.length > 0 && (
                  <>
                    <div className={"sub-h" + (given.length ? " ruled" : "")}>
                      {words("要打这里的怪", "Hunt monsters here")}
                      <small>{questCount(words, hunted.length)}</small>
                    </div>
                    <QuestList
                      quests={hunted.map((h: any) => h.quest)}
                      amounts={hunted.map(
                        (h: any) => `${name(h.mob.names)} ×${h.quantity}`,
                      )}
                      withNpc
                    />
                  </>
                )}
              </Well>
            )}
          </div>
        </div>
      </section>
    </>
  );
}
const questCount = (words: (zh: string, en: string) => string, n: number) =>
  words(`${n} 个`, n === 1 ? "1 quest" : `${n} quests`);
function QuestList({
  quests,
  amounts,
  withNpc = false,
}: {
  quests: any[];
  amounts?: string[];
  withNpc?: boolean;
}) {
  const words = useWords(),
    name = useNames();
  return (
    <div className="quests">
      {quests.map((q: any, i: number) => {
        const meta = [
          withNpc && q.npc && (name(q.npc.names) || "NPC #" + q.npc.id),
          q.level_min != null && `Lv.${q.level_min}`,
          q.repeats === "daily" && words("每日", "daily"),
          q.repeats === "weekly" && words("每周", "weekly"),
          q.ends_at &&
            words(`活动至 ${q.ends_at.slice(5, 10)}`, `event until ${q.ends_at.slice(5, 10)}`),
        ].filter(Boolean);
        return (
          <a
            className="quest"
            key={q.id + ":" + i}
            href={`https://meowdb.com/msclassic/quest-tracker/${q.id}`}
            target="_blank"
            rel="noopener noreferrer"
          >
            <b>{name(q.names)}</b>
            <span className="qn">{amounts?.[i] ?? ""}</span>
            <span className="qm">{meta.join(" · ")}</span>
          </a>
        );
      })}
    </div>
  );
}
function NpcPage({ page }: { page: any }) {
  const words = useWords(),
    name = useNames(),
    npc = page.npc,
    title = name(npc.names) || "NPC #" + npc.id;
  // The assistant's page context covers items, monsters and maps only.
  useProvidePageContext(null);
  return (
    <>
      <Crumb text={title} />
      <section className="stall">
        <div className="stall-bar">
          <h2>NPC · {title}</h2>
        </div>
        <div className="ihead solo">
          <div>
            <h1>{title}</h1>
            <div className="en">
              <Secondary names={npc.names} />
            </div>
          </div>
        </div>
        <div className="dgrid">
          <div className="dcol">
            <Well
              title={words("在哪里", "Where")}
              note={words(`${page.places.length} 张地图`, `${page.places.length} maps`)}
            >
              {page.places.map((place: any) => (
                <div key={place.map.id}>
                  <MapRow map={place.map} />
                  {place.view && (
                    <figure className="mapvis compact">
                      <ZoomMap
                      view={place.view}
                      title={name(place.map.names)}
                      npc={npc.id}
                      links
                      exit={null}
                    />
                    </figure>
                  )}
                </div>
              ))}
              {!page.places.length && (
                <p className="note">
                  {words("图鉴里没有这个 NPC 的位置。", "The dex has no location for this NPC.")}
                </p>
              )}
            </Well>
          </div>
          <div className="dcol">
            <Well title={words("任务", "Quests")} note={questCount(words, page.quests.length)}>
              <QuestList quests={page.quests} />
              {!page.quests.length && (
                <p className="note">{words("这个 NPC 不给任务。", "This NPC gives no quests.")}</p>
              )}
            </Well>
            {page.shop.length > 0 && (
              <Well
                title={words("商店", "Shop")}
                note={words(`${page.shop.length} 种`, `${page.shop.length} items`)}
              >
                {page.shop.map((item: any) => (
                  <a className="drow" key={item.id} href={"/item/" + item.id}>
                    <Slot empty url={item.icon_url} />
                    <span className="t">
                      <b>{name(item.names)}</b>
                      <Secondary names={item.names} />
                    </span>
                    <span className="r">
                      <Price value={item.price} />
                    </span>
                  </a>
                ))}
              </Well>
            )}
          </div>
        </div>
      </section>
    </>
  );
}
function StepHint({ step }: { step: any }) {
  const words = useWords(),
    name = useNames();
  const npc = step.npc && (name(step.npc.names) || "NPC #" + step.npc.id);
  if (step.kind === "portal" && step.exit)
    return (
      <>
        {step.exit_hidden
          ? words(
              "走圈出的隐藏传送口（游戏里看不到，站在圈里按↑）",
              "take the circled hidden portal (not drawn in game; stand in the circle and press up)",
            )
          : words("走地图上圈出的传送口", "take the circled portal on the map")}
      </>
    );
  if (step.kind === "ship" && npc)
    return <>{words(`找圈出的${npc}坐船`, `take the ship with ${npc}, circled`)}</>;
  if (step.kind === "taxi" && npc)
    return <>{words(`找圈出的${npc}坐出租车`, `take the taxi with ${npc}, circled`)}</>;
  return <Edge kind={step.kind} portal={step.portal_name} />;
}
const stepShowsMap = (step: any) => step.view && (step.exit || step.kind !== "portal");
function Steps({ steps }: { steps: any[] }) {
  const words = useWords(),
    name = useNames();
  // Only the first map loads its scene with the page; the rest wait with the
  // minimap until they scroll into view (steps_list in pages/dex.rs).
  const firstMap = steps.findIndex(stepShowsMap);
  return (
    <ol className="steps">
      {steps.map((step: any, i: number) => (
        <li className={"step " + (step.kind === "return" ? "scroll" : "")} key={i}>
          <a href={"/map/" + step.to.id}>
            <span className="no">{i + 1}</span>
            <span className="t">
              <b>
                {name(step.from.names)} → {name(step.to.names)}
              </b>
              <span className="name-secondary">
                {words(step.from.names.en, step.from.names.zh)} →{" "}
                {words(step.to.names.en, step.to.names.zh)}
              </span>
              <span className="s">
                <StepHint step={step} />
              </span>
            </span>
            {step.kind === "return" && <span className="kind">{words("回城卷轴", "scroll")}</span>}
          </a>
          {stepShowsMap(step) && (
            <figure className="mapvis step-map">
              <ZoomMap
                key={step.from.id}
                view={step.view}
                title={name(step.from.names)}
                exit={step.exit}
                arrival={step.arrival}
                exitNpc={!!step.npc}
                deferScene={i !== firstMap}
              />
            </figure>
          )}
        </li>
      ))}
    </ol>
  );
}
function RoutePage({ page }: { page: any }) {
  const words = useWords(),
    name = useNames(),
    navigate = useNavigate();
  const result = page.outcome;
  const mobMode = !!page.mob_mode;
  // Show the found maps by name, not by the ids in the address; an unchanged
  // field still submits the original input so the same maps are used.
  const shown = (input: string, map: any) => (map ? name(map.names) : input);
  const found = result.Found,
    mobFound = result.MobFound,
    unresolved = result.Unresolved,
    noPath = result.NoPath;
  const fromShown = shown(page.from_input, found?.from || mobFound?.from),
    toShown = shown(page.to_input, found?.to),
    mobShown = mobFound ? name(mobFound.mob.names) : page.mob_input || "";
  const [from, setFrom] = useState(fromShown),
    [to, setTo] = useState(toShown),
    [mob, setMob] = useState(mobShown),
    [taxi, setTaxi] = useState(!!page.taxi);
  useEffect(() => setTaxi(!!page.taxi), [page.taxi]);
  useEffect(() => {
    setFrom(fromShown);
    setTo(toShown);
    setMob(mobShown);
  }, [fromShown, toShown, mobShown]);
  const withTaxi = (params: Record<string, string>, on = taxi) =>
    "/route?" + new URLSearchParams(on ? { ...params, taxi: "1" } : params);
  const route = (from: string, to: string) => withTaxi({ from, to });
  const mobRoute = (from: string, mob: string) => withTaxi({ from, mob });
  let body: ReactNode;
  if (result === "Form") body = null;
  else if (found)
    body = (
      <Well
        title={`${name(found.from.names)} → ${name(found.to.names)}`}
        note={words(`${found.steps.length} 步`, `${found.steps.length} steps`)}
      >
        {found.overview && <RouteOverview overview={found.overview} />}
        <Steps steps={found.steps} />
      </Well>
    );
  else if (mobFound)
    body = (
      <>
        <Well
          title={words(
            `${name(mobFound.from.names)} → 最近的${name(mobFound.mob.names)}：${name(mobFound.to.names)}`,
            `${name(mobFound.from.names)} → nearest ${name(mobFound.mob.names)}: ${name(mobFound.to.names)}`,
          )}
          note={words(`${mobFound.steps.length} 步`, `${mobFound.steps.length} steps`)}
        >
          {!mobFound.steps.length && (
            <p className="note">
              {words(
                `${name(mobFound.mob.names)}就在出发地图上。`,
                `${name(mobFound.mob.names)} spawns right on the start map.`,
              )}
            </p>
          )}
          {mobFound.overview && <RouteOverview overview={mobFound.overview} />}
          <Steps steps={mobFound.steps} />
        </Well>
        <Well
          title={words(`${name(mobFound.mob.names)}的刷怪地图`, `Where ${name(mobFound.mob.names)} spawns`)}
          note={words(`${mobFound.places.length} 张`, `${mobFound.places.length} maps`)}
        >
          {mobFound.places.map((place: any) => (
            <a
              key={place.map.id}
              className={"drow" + (place.map.id === mobFound.to.id ? " here" : "")}
              href={route(String(mobFound.from.id), String(place.map.id))}
            >
              <span className="glyph">
                <Icon name="map" />
              </span>
              <span className="t">
                <b>{name(place.map.names)}</b>
                <Secondary names={place.map.names} />
              </span>
              <span className="r">
                {place.steps != null
                  ? words(`${place.steps} 步`, `${place.steps} steps`)
                  : words("到不了", "unreachable")}
                {" · "}
                {words(`${place.spawn_count} 个刷怪点`, `${place.spawn_count} spawns`)}
              </span>
            </a>
          ))}
        </Well>
      </>
    );
  else if (result.MobUnresolved) {
    const u = result.MobUnresolved;
    body = (
      <Well
        title={
          u.candidates.length
            ? words(`「${u.query}」有多只怪物，选一只`, `Several monsters match “${u.query}”; pick one`)
            : words(`没有找到怪物「${u.query}」`, `No monster matches “${u.query}”`)
        }
      >
        {u.candidates.map((m: any) => (
          <a className="drow" key={m.id} href={mobRoute(page.from_input, String(m.id))}>
            <MobPicture mob={m} />
            <span className="t">
              <b>{name(m.names)}</b>
              {m.level != null && <span className="lv">Lv.{m.level}</span>}
              <Secondary names={m.names} />
            </span>
          </a>
        ))}
      </Well>
    );
  } else if (result.MobNoPath) {
    const n = result.MobNoPath;
    body = (
      <Well title={words("暂时查不到路线", "No route found yet")}>
        <p className="note">
          {words(
            `从${name(n.from.names)}到不了有${name(n.mob.names)}的开放地图。`,
            `No open map with ${name(n.mob.names)} can be reached from ${name(n.from.names)}.`,
          )}
        </p>
        <MobRow mob={n.mob} />
      </Well>
    );
  } else if (result.Same)
    body = (
      <Well title={words("出发地和目的地是同一张地图", "Start and destination are the same map")}>
        <MapRow map={result.Same} sub={"ID " + result.Same.id} />
      </Well>
    );
  else if (noPath)
    body = (
      <Well title={words("暂时查不到路线", "No route found yet")}>
        <p className="note">
          {words("已知连接里没有从出发地到目的地的路。", "The known links do not connect these maps.")}
        </p>
        <MapRow map={noPath.from} sub={words("出发", "start")} />
        <MapRow map={noPath.to} sub={words("目的地", "destination")} />
      </Well>
    );
  else if (unresolved) {
    const which = unresolved.end === "From" ? words("出发地", "start") : words("目的地", "destination");
    const title = !unresolved.query
      ? words(`请填写${which}`, `Enter a ${which}`)
      : !unresolved.candidates.length
        ? words(`没有找到${which}「${unresolved.query}」`, `No ${which} matches “${unresolved.query}”`)
        : words(
            `${which}「${unresolved.query}」有多个地图，选一个`,
            `Several maps match “${unresolved.query}”; pick one`,
          );
    body = (
      <Well title={title}>
        {unresolved.candidates.map((map: any) => (
          <MapRow
            key={map.id}
            map={map}
            sub={"ID " + map.id}
            href={
              mobMode && unresolved.end === "From"
                ? mobRoute(String(map.id), page.mob_input)
                : route(
                    unresolved.end === "From" ? String(map.id) : page.from_input,
                    unresolved.end === "To" ? String(map.id) : page.to_input,
                  )
            }
          />
        ))}
      </Well>
    );
  }
  const fromValue = from === fromShown ? page.from_input : from;
  return (
    <section className="stall">
      <div className="stall-bar">
        <h2>{words("怎么走", "Route")}</h2>
      </div>
      <nav className="route-tabs" aria-label={words("寻路方式", "Route mode")}>
        <a className={mobMode ? "" : "on"} href={route(page.from_input, page.to_input)}>
          {words("去地图", "To a map")}
        </a>
        <a className={mobMode ? "on" : ""} href={withTaxi({ mode: "mob", from: page.from_input })}>
          {words("找怪物", "Find a monster")}
        </a>
        <a href="/world">{words("世界地图", "World map")}</a>
      </nav>
      <form
        className="route-form"
        action="/route"
        method="get"
        onSubmit={(event) => {
          event.preventDefault();
          navigate(
            mobMode
              ? mobRoute(fromValue, mob === mobShown && mobFound ? String(mobFound.mob.id) : mob)
              : route(fromValue, to === toShown ? page.to_input : to),
          );
        }}
      >
        <label className="field">
          <span>{words("出发", "From")}</span>
          <input
            type="text"
            name="from"
            value={from}
            placeholder={words("地图名或 ID（默认射手村）", "map name or id (Henesys)")}
            autoComplete="off"
            onChange={(event) => setFrom(event.target.value)}
          />
        </label>
        {mobMode ? (
          <label className="field">
            <span>{words("怪物", "Monster")}</span>
            <input
              type="text"
              name="mob"
              value={mob}
              placeholder={words("怪物名或 ID", "monster name or id")}
              autoComplete="off"
              onChange={(event) => setMob(event.target.value)}
            />
          </label>
        ) : (
          <label className="field">
            <span>{words("目的地", "To")}</span>
            <input
              type="text"
              name="to"
              value={to}
              placeholder={words("地图名或 ID", "map name or id")}
              autoComplete="off"
              onChange={(event) => setTo(event.target.value)}
            />
          </label>
        )}
        <label className="check">
          <input type="checkbox" name="taxi" value="1" checked={taxi} onChange={(e) => setTaxi(e.target.checked)} />
          <span>{words("可以坐出租车", "Allow taxis")}</span>
        </label>
        <button className="btn primary" type="submit">
          {mobMode ? words("找最近的地图", "Find the nearest map") : words("查路线", "Find route")}
        </button>
      </form>
      <div className="dbody">{body}</div>
    </section>
  );
}
function WorldPage({ page }: { page: any }) {
  const words = useWords();
  useProvidePageContext(null);
  return (
    <>
      <Crumb text={words("世界地图", "World map")} />
      <section className="stall">
        <div className="stall-bar">
          <h2>{words("世界地图", "World map")}</h2>
        </div>
        <nav className="route-tabs" aria-label={words("寻路方式", "Route mode")}>
          <a href="/route">{words("去地图", "To a map")}</a>
          <a href="/route?mode=mob">{words("找怪物", "Find a monster")}</a>
          <a className="on" href="/world">
            {words("世界地图", "World map")}
          </a>
        </nav>
        <WorldBody page={page} />
      </section>
    </>
  );
}
export default function Catalogue() {
  usePageReady();
  const route = useLocation(),
    words = useWords();
  const { language } = usePreferences();
  const [rawFilters] = useUserValue(
    `item.offerFilters.${route.pathname.split("/")[2]}`,
    "{}",
  );
  const params = new URLSearchParams(route.search);
  if (
    route.pathname.startsWith("/item/") &&
    Math.floor(Number(route.pathname.split("/")[2]) / 1000000) === 1
  ) {
    let filters;
    try {
      filters = normalizeOfferFilters(JSON.parse(rawFilters));
    } catch {
      filters = normalizeOfferFilters();
    }
    if (filters.stats.length)
      params.set(
        "attributes",
        JSON.stringify(
          filters.stats.map((row: any) => [row.stat, row.min ?? 1]),
        ),
      );
    else params.delete("attributes");
    if (filters.equipment !== "all") params.set("equipment", filters.equipment);
    else params.delete("equipment");
  }
  const url = route.pathname + (params.size ? "?" + params : "");
  const query = useQuery<any>({
    queryKey: catalogKey(url),
    queryFn: ({ signal }) => loadCatalog(url, signal),
    placeholderData: keepPreviousData,
    meta: { market: route.pathname.startsWith("/item/") },
    staleTime: route.pathname.startsWith("/item/") ? 15000 : 60000,
  });
  const data = query.data;
  useEffect(() => {
    if (data) {
      const page = data.page;
      const title =
        data.kind === "item"
          ? words(page.item.name_zh || page.item.name_en, page.item.name_en)
          : data.kind === "mob"
            ? words(page.mob.names?.zh, page.mob.names?.en)
            : data.kind === "map"
              ? words(page.map.names?.zh, page.map.names?.en)
              : data.kind === "npc"
                ? words(page.npc.names?.zh, page.npc.names?.en) || "NPC #" + page.npc.id
              : data.kind === "world"
                ? words("世界地图", "World map")
              : data.kind === "route"
                ? words("怎么走", "Route")
                : words("搜索", "Search");
      if (title)
        document.title = title + " · " + words("枫叶市集", "Maple Market");
    }
  }, [data, language]);
  if (query.isError && !data)
    return (
      <section className="stall">
        <div className="stall-bar">
          <h1>{words("暂时无法显示", "Unable to display")}</h1>
        </div>
        <div className="dbody">
          {(query.error as any).status === 404 ? (
            <p className="note">
              {words(
                "没有找到这条图鉴记录。",
                "This catalogue entry was not found.",
              )}
            </p>
          ) : (
            <ErrorState retry={() => void query.refetch()} />
          )}
        </div>
      </section>
    );
  if (
    !data ||
    (route.pathname.startsWith("/item/") &&
      String(data.page?.item?.id) !== route.pathname.split("/")[2]) ||
    (params.get("variant") &&
      String(data.page?.selected_variant?.id) !== params.get("variant"))
  )
    return query.isError ? (
      <ErrorState retry={() => void query.refetch()} />
    ) : (
      <Loading />
    );
  return (
    <div
      className={"dwrap " + (data.kind === "item" ? "ipage" : "dex")}
      data-react-catalogue={data.kind}
      aria-busy={query.isFetching}
    >
      {data.kind === "item" ? (
        <Item
          key={data.page.item.id + ":" + (params.get("variant") || "")}
          page={data.page}
        />
      ) : data.kind === "mob" ? (
        <Mob page={data.page} />
      ) : data.kind === "map" ? (
        <MapPage page={data.page} />
      ) : data.kind === "npc" ? (
        <NpcPage page={data.page} />
      ) : data.kind === "world" ? (
        <WorldPage page={data.page} />
      ) : data.kind === "route" ? (
        <RoutePage page={data.page} />
      ) : (
        <SearchView page={data.page} />
      )}
    </div>
  );
}
// Search brings the filter dialog and menus (Radix); other pages never load them.
let searchModule: typeof import("./catalogue-search") | undefined;
let searchLoad: Promise<unknown> | undefined;
const loadSearch = () =>
  (searchLoad ??= import("./catalogue-search").then((module) => {
    searchModule = module;
  }));
/** Loads the view `path` renders, so a server-rendered page mounts without a fallback. */
export function preloadView(path: string) {
  return path === "/search" ? loadSearch() : Promise.resolve();
}
function SearchView({ page }: { page: any }) {
  if (!searchModule) use(loadSearch());
  const SearchPage = searchModule!.default;
  return <SearchPage page={page} />;
}

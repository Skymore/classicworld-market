import { useEffect, useState, type ReactNode } from "react";
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
import { normalizeOfferFilters } from "/web/js/lib/item-offer-filters.js?v=20261025-presence-1";
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
export function MobPicture({ mob, big = false }: { mob: any; big?: boolean }) {
  const id = mob.image_id;
  const local =
    (mob.id >= 54 && mob.id <= 63) || [1059, 700003, 800022].includes(mob.id);
  const url = local
    ? `/web/images/mobs/${mob.id === 800022 ? 700003 : mob.id}.png`
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
        <Description text={mob.description} />
        <div className="dgrid">
          <Well
            title={words("掉落", "Drops")}
            note={words(
              `${page.drops.length} 种`,
              `${page.drops.length} kinds`,
            )}
          >
            {page.drops.map((drop: any, i: number) => {
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
                              {words("成交 ", "typical ")}
                              <Price value={item.typical} />
                            </>
                          ) : (
                            words("暂无成交", "no sales yet")
                          )}
                          {item.lowest_ask != null && (
                            <>
                              {" "}
                              · {words("在售最低 ", "lowest ask ")}
                              <Price value={item.lowest_ask} />
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
                  <span className="r">
                    {Number(drop.rate_pct).toLocaleString(undefined, {
                      maximumFractionDigits: 4,
                    })}
                    %
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
            {!page.drops.length && (
              <p className="note">
                {words(
                  "图鉴里没有这只怪物的掉落记录。",
                  "The dex has no drops for this monster.",
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
            {page.spawns.map((spawn: any, i: number) => (
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
            {!page.spawns.length && (
              <p className="note">
                {words(
                  "图鉴里没有这只怪物的出现地图。",
                  "The dex has no maps for this monster.",
                )}
              </p>
            )}
          </Well>
        </div>
      </section>
    </>
  );
}
function Edge({ kind, portal }: { kind: string; portal?: string }) {
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
  return (
    <>
      {words(...(labels[kind] || [kind, kind]))}
      {portal && ` · ${portal}`}
    </>
  );
}
function MapPage({ page }: { page: any }) {
  const words = useWords(),
    name = useNames(),
    map = page.map,
    title = name(map.names);
  const scrolls = page.entrances.filter((link: any) => link.kind === "return"),
    walks = page.entrances.filter((link: any) => link.kind !== "return");
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
        </div>
        {map.minimap_url ? (
          <img
            className="minimap"
            src={map.minimap_url}
            alt={words("小地图：", "Minimap: ") + title}
            loading="lazy"
          />
        ) : (
          <p className="note map-preview-missing">
            {words(
              "暂无地图预览。下方仍可查看已收录的怪物和传送连接；暂未收录精确刷新坐标。",
              "Map preview unavailable. Recorded monsters and portal connections are listed below; exact spawn coordinates are not available.",
            )}
          </p>
        )}
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
                <div className="drow plain" key={npc.id}>
                  <span className="glyph">N</span>
                  <span className="t">
                    <b>{name(npc.names) || "NPC #" + npc.id}</b>
                    <Secondary names={npc.names} />
                  </span>
                </div>
              ))}
              {!page.npcs.length && (
                <p className="note">
                  {words("这张地图没有 NPC 记录。", "No NPCs recorded here.")}
                </p>
              )}
              {page.npcs.length > 0 &&
                page.npcs.every((npc: any) => !npc.names) && (
                  <p className="note">
                    {words(
                      "NPC 名字还没有导入，暂时只显示编号。",
                      "NPC names are not imported yet; showing ids.",
                    )}
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
          </div>
        </div>
      </section>
    </>
  );
}
function RoutePage({ page }: { page: any }) {
  const words = useWords(),
    name = useNames(),
    navigate = useNavigate();
  const [from, setFrom] = useState(page.from_input),
    [to, setTo] = useState(page.to_input);
  useEffect(() => {
    setFrom(page.from_input);
    setTo(page.to_input);
  }, [page.from_input, page.to_input]);
  const result = page.outcome;
  let body: ReactNode;
  const found = result.Found,
    unresolved = result.Unresolved,
    noPath = result.NoPath;
  const route = (from: string, to: string) =>
    "/route?" + new URLSearchParams({ from, to });
  if (result === "Form")
    body = (
      <p className="note">
        {words(
          "输入出发和目的地的地图名（中文或英文）或地图 ID。",
          "Enter the start and destination map names (Chinese or English) or map ids.",
        )}
      </p>
    );
  else if (found)
    body = (
      <Well
        title={`${name(found.from.names)} → ${name(found.to.names)}`}
        note={words(`${found.steps.length} 步`, `${found.steps.length} steps`)}
      >
        <ol className="steps">
          {found.steps.map((step: any, i: number) => (
            <li
              className={"step " + (step.kind === "return" ? "scroll" : "")}
              key={i}
            >
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
                    <Edge kind={step.kind} portal={step.portal_name} />
                  </span>
                </span>
                {step.kind === "return" && (
                  <span className="kind">{words("回城卷轴", "scroll")}</span>
                )}
              </a>
            </li>
          ))}
        </ol>
      </Well>
    );
  else if (result.Same)
    body = (
      <Well
        title={words(
          "出发地和目的地是同一张地图",
          "Start and destination are the same map",
        )}
      >
        <MapRow map={result.Same} sub={"ID " + result.Same.id} />
      </Well>
    );
  else if (noPath)
    body = (
      <Well title={words("暂时查不到路线", "No route found yet")}>
        <p className="note">
          {words(
            "已知连接里没有从出发地到目的地的路。",
            "The known links do not connect these maps.",
          )}
        </p>
        <MapRow map={noPath.from} sub={words("出发", "start")} />
        <MapRow map={noPath.to} sub={words("目的地", "destination")} />
      </Well>
    );
  else if (unresolved) {
    const which =
      unresolved.end === "From"
        ? words("出发地", "start")
        : words("目的地", "destination");
    const title = !unresolved.query
      ? words(`请填写${which}`, `Enter a ${which}`)
      : !unresolved.candidates.length
        ? words(
            `没有找到${which}「${unresolved.query}」`,
            `No ${which} matches “${unresolved.query}”`,
          )
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
            href={route(
              unresolved.end === "From" ? String(map.id) : page.from_input,
              unresolved.end === "To" ? String(map.id) : page.to_input,
            )}
          />
        ))}
      </Well>
    );
  }
  return (
    <section className="stall">
      <div className="stall-bar">
        <h2>{words("怎么走", "Route")}</h2>
      </div>
      <form
        className="route-form"
        action="/route"
        method="get"
        onSubmit={(event) => {
          event.preventDefault();
          navigate(route(from, to));
        }}
      >
        <label className="field">
          <span>{words("出发", "From")}</span>
          <input
            type="text"
            name="from"
            value={from}
            placeholder={words("地图名或 ID", "map name or id")}
            autoComplete="off"
            onChange={(event) => setFrom(event.target.value)}
          />
        </label>
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
        <button className="btn primary" type="submit">
          {words("查路线", "Find route")}
        </button>
      </form>
      <div className="dbody">{body}</div>
      <p className="note">
        {words(
          `路线只用已导入的连接（现有 ${page.known_edges} 条），按步数最少找。`,
          `Routes use the imported links only (${page.known_edges} so far), fewest steps first.`,
        )}
      </p>
    </section>
  );
}
export default function Catalogue() {
  usePageReady();
  const route = useLocation(),
    words = useWords();
  const { language } = usePreferences();
  const [rawFilters] = useUserValue("market.offerFilters", "{}");
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
      ) : data.kind === "route" ? (
        <RoutePage page={data.page} />
      ) : (
        <SearchPage page={data.page} />
      )}
    </div>
  );
}
import SearchPage from "./catalogue-search";

import { useEffect, useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { useWords } from "../providers";
import { Icon, Slot } from "../components/shared";
import { MapRow, MobRow, Secondary, useNames, Well } from "./catalogue";
// Orbis and El Nath are not open yet; their maps are imported as unreleased
// and never listed. Add them back here and in regions.rs when they open.
const regions = [
  ["maple", "彩虹岛", "Maple Island"],
  ["victoria", "金银岛", "Victoria Island"],
  ["market", "自由市场", "Free Market"],
  ["special", "活动／特殊地图", "Events / special maps"],
  ["other", "其他／待归类", "Other / unclassified"],
];
export default function Search({ page }: { page: any }) {
  const words = useWords(),
    name = useNames(),
    navigate = useNavigate(),
    route = useLocation();
  const params = new URLSearchParams(route.search);
  const [draft, setDraft] = useState(params.get("q") || ""),
    [min, setMin] = useState(params.get("min_level") || ""),
    [max, setMax] = useState(params.get("max_level") || "");
  const composing = useRef(false),
    typing = useRef(false);
  const kind = (page.kind || "").toLowerCase(),
    searching = !!page.query;
  const filters = page.filters || {};
  const [filterOpen, setFilterOpen] = useState(
    Boolean(
      filters.job || filters.min_level != null || filters.max_level != null,
    ),
  );
  function update(values: Record<string, string>, replace = true) {
    const next = new URLSearchParams(location.search);
    next.delete("page");
    for (const [key, value] of Object.entries(values)) {
      if (value) next.set(key, value);
      else next.delete(key);
    }
    navigate("/search?" + next, { replace });
  }
  useEffect(() => {
    const q = new URLSearchParams(route.search).get("q") || "";
    if (!typing.current) setDraft(q);
    setMin(new URLSearchParams(route.search).get("min_level") || "");
    setMax(new URLSearchParams(route.search).get("max_level") || "");
  }, [route.search]);
  useEffect(() => {
    if (!typing.current || composing.current) return;
    const timer = setTimeout(() => {
      typing.current = false;
      update({ q: draft.trim() });
    }, 200);
    return () => clearTimeout(timer);
  }, [draft]);
  const place = (
    <div className="place-tools">
      {!page.kind && (
        <span className="place-scope">
          {words("地图／怪物地区", "Map / monster location")}
        </span>
      )}
      <label>
        {words("地区", "Region")}
        <select
          name="region"
          form="catalog-search"
          value={params.get("region") || ""}
          onChange={(event) => update({ region: event.target.value, area: "" })}
        >
          <option value="">{words("全部地区", "All regions")}</option>
          {regions.map(([value, zh, en]) => (
            <option key={value} value={value}>
              {words(zh, en)}
            </option>
          ))}
        </select>
      </label>
      <label>
        {words("区域", "Area")}
        <select
          name="area"
          form="catalog-search"
          disabled={!params.get("region")}
          value={params.get("area") || ""}
          onChange={(event) => update({ area: event.target.value })}
        >
          <option value="">
            {params.get("region")
              ? words("全部区域", "All areas")
              : words("先选地区", "Choose a region first")}
          </option>
          {(page.areas || [])
            .filter((area: any) => area.region === params.get("region"))
            .map((area: any) => (
              <option key={area.key} value={area.key}>
                {name(area.names)}
              </option>
            ))}
        </select>
      </label>
      <button
        className="chip"
        type="button"
        data-place-reset
        onClick={() => update({ region: "", area: "" })}
      >
        {words("重置", "Reset")}
      </button>
    </div>
  );
  const catControls = (
    <div className="catalogue-tools">
      <div
        className="catalogue-cats"
        role="group"
        aria-label={words("物品分类", "Item category")}
      >
        {[
          ["", "全部", "All"],
          ["equip", "装备", "EQUIP"],
          ["use", "消耗", "USE"],
          ["setup", "装饰", "SETUP"],
          ["etc", "其他", "ETC"],
          ["cash", "商城", "CASH"],
        ].map(([value, zh, en]) => (
          <label key={value}>
            <input
              type="radio"
              name="cat"
              value={value}
              form="catalog-search"
              checked={(params.get("cat") || "") === value}
              onChange={() =>
                update({
                  cat: value,
                  ...(value === "equip"
                    ? {}
                    : { job: "", min_level: "", max_level: "" }),
                })
              }
            />
            <span>{words(zh, en)}</span>
          </label>
        ))}
      </div>
      <details
        className="catalogue-filter"
        open={filterOpen}
        onToggle={(event) => setFilterOpen(event.currentTarget.open)}
      >
        <summary>
          {words("筛选", "Filters")}
          <span data-filter-summary>
            {filters.job ||
            filters.min_level != null ||
            filters.max_level != null
              ? " ●"
              : ""}
          </span>
        </summary>
        <div className="catalogue-panel">
          <label>
            {words("适用职业", "Job")}
            <select
              name="job"
              form="catalog-search"
              value={params.get("job") || "0"}
              onChange={(event) =>
                update({
                  job: event.target.value === "0" ? "" : event.target.value,
                  cat: "equip",
                })
              }
            >
              {[
                ["0", "所有职业", "All jobs"],
                ["1", "战士", "Warrior"],
                ["2", "魔法师", "Magician"],
                ["4", "弓箭手", "Bowman"],
                ["8", "飞侠", "Thief"],
              ].map(([value, zh, en]) => (
                <option key={value} value={value}>
                  {words(zh, en)}
                </option>
              ))}
            </select>
          </label>
          <div className="catalogue-levels">
            <label>
              {words("最低等级", "Min level")}
              <input
                type="number"
                name="min_level"
                form="catalog-search"
                min="0"
                max="300"
                value={min}
                placeholder="0"
                onChange={(event) => setMin(event.target.value)}
                onBlur={() =>
                  update({ min_level: min, max_level: max, cat: "equip" })
                }
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    event.preventDefault();
                    update({ min_level: min, max_level: max, cat: "equip" });
                  }
                }}
              />
            </label>
            <span>–</span>
            <label>
              {words("最高等级", "Max level")}
              <input
                type="number"
                name="max_level"
                form="catalog-search"
                min="0"
                max="300"
                value={max}
                placeholder={words("不限", "Any")}
                onChange={(event) => setMax(event.target.value)}
                onBlur={() =>
                  update({ min_level: min, max_level: max, cat: "equip" })
                }
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    event.preventDefault();
                    update({ min_level: min, max_level: max, cat: "equip" });
                  }
                }}
              />
            </label>
          </div>
          <div className="catalogue-presets">
            {[
              [1, 20],
              [21, 30],
              [31, 50],
              [51, 70],
              [71, 120],
            ].map(([lo, hi]) => (
              <button
                className="chip"
                type="button"
                data-catalog-levels={`${lo},${hi}`}
                key={lo}
                onClick={() => {
                  setMin(String(lo));
                  setMax(String(hi));
                  update({
                    cat: "equip",
                    min_level: String(lo),
                    max_level: String(hi),
                  });
                }}
              >
                {lo}–{hi}
              </button>
            ))}
            <button
              className="chip"
              type="button"
              data-catalog-reset
              onClick={() => {
                setMin("");
                setMax("");
                update({ cat: "", job: "", min_level: "", max_level: "" });
              }}
            >
              {words("重置筛选", "Reset filters")}
            </button>
          </div>
        </div>
      </details>
    </div>
  );
  const number = page.offset / (page.kind ? 60 : 20) + 1,
    more = page.items.more || page.mobs.more || page.maps.more;
  const pagination =
    page.offset || more ? (
      <nav className="chips kinds" aria-label={words("分页", "Pagination")}>
        {number > 1 && (
          <button
            className="chip"
            onClick={() => update({ page: String(number - 1) }, false)}
          >
            {words("上一页", "Previous")}
          </button>
        )}
        <span className="chip">
          {words("第", "Page")} {number}
        </span>
        {more && (
          <button
            className="chip"
            onClick={() => update({ page: String(number + 1) }, false)}
          >
            {words("下一页", "Next")}
          </button>
        )}
      </nav>
    ) : null;
  const nothing =
    !page.items.rows.length && !page.mobs.rows.length && !page.maps.rows.length;
  return (
    <section className="stall">
      <div className="stall-bar">
        <h2>{words("搜索", "Search")}</h2>
        {page.query && <span className="bar-meta">“{page.query}”</span>}
      </div>
      <form
        className="finder in-page"
        id="catalog-search"
        action="/search"
        method="get"
        role="search"
        onSubmit={(event) => {
          event.preventDefault();
          typing.current = false;
          update({ q: draft.trim(), min_level: min, max_level: max });
        }}
      >
        <Icon name="search" />
        <input
          type="search"
          name="q"
          value={draft}
          placeholder={words(
            "搜索物品、怪物、地图",
            "Search items, monsters, maps",
          )}
          aria-label={words("搜索", "Search")}
          autoComplete="off"
          onChange={(event) => {
            typing.current = true;
            setDraft(event.target.value);
          }}
          onCompositionStart={() => {
            composing.current = true;
          }}
          onCompositionEnd={(event) => {
            composing.current = false;
            typing.current = false;
            update({ q: event.currentTarget.value.trim() });
          }}
        />
        {page.kind && <input type="hidden" name="kind" value={kind} />}
      </form>
      <div data-search-results aria-live="polite">
        <nav
          className="chips kinds"
          aria-label={words("结果类型", "Result type")}
        >
          {[
            ["item", "物品", "Items"],
            ["mob", "怪物", "Monsters"],
            ["map", "地图", "Maps"],
          ].map(([value, zh, en]) => (
            <a
              className={"chip " + (!searching && kind === value ? "on" : "")}
              key={value}
              aria-current={!searching && kind === value ? "page" : undefined}
              href={
                searching
                  ? "#search-" + value
                  : "/search?" +
                    new URLSearchParams({
                      kind: value,
                      ...(page.region ? { region: page.region } : {}),
                      ...(page.area ? { area: page.area } : {}),
                    })
              }
            >
              {words(zh, en)}
            </a>
          ))}
        </nav>
        {pagination}
        <div className="dbody">
          {!page.kind &&
            searching &&
            (page.mobs.rows.length > 0 ||
              page.maps.rows.length > 0 ||
              !!params.get("region")) &&
            place}
          {[
            ["item", "物品", "Items", "items"],
            ["mob", "怪物", "Monsters", "mobs"],
            ["map", "地图", "Maps", "maps"],
          ].map(([group, zh, en, key]) => {
            const hits = page[key];
            if (!hits.rows.length && !searching && kind !== group) return null;
            return (
              <Well
                key={key}
                id={"search-" + group}
                title={words(zh, en)}
                note={`${words("本页", "This page:")} ${hits.rows.length}${hits.more ? "+" : ""}`}
              >
                {group === "item" && catControls}
                {group !== "item" && kind === group && place}
                {hits.rows.length ? (
                  <div className="catalogue-grid">
                    {hits.rows.map((hit: any) =>
                      group === "item" ? (
                        <a
                          className="drow"
                          key={hit.id}
                          href={"/item/" + hit.id}
                        >
                          <Slot empty url={hit.icon_url} />
                          <span className="t">
                            <b>{name(hit.names)}</b>
                            {hit.level != null &&
                              Math.floor(hit.id / 1000000) === 1 && (
                                <span className="lv">
                                  {words("等级 ", "Lv. ")}
                                  {hit.level}
                                </span>
                              )}
                            <span className="s">
                              <Secondary names={hit.names} />
                              {hit.subcategory && words(hit.subcategory, "") && (
                                <span className="sub">{hit.subcategory}</span>
                              )}
                            </span>
                          </span>
                        </a>
                      ) : group === "mob" ? (
                        <MobRow mob={hit} key={hit.id} />
                      ) : (
                        <MapRow map={hit} sub={name(hit.street)} key={hit.id} />
                      ),
                    )}
                  </div>
                ) : (
                  <p className="note">
                    {words("没有匹配结果。", "No matches.")}
                  </p>
                )}
                {hits.more && (
                  <p className="note">
                    {words(
                      "还有更多结果，可翻到下一页。",
                      "More results on the next page.",
                    )}
                  </p>
                )}
              </Well>
            );
          })}
          {nothing && (
            <div className="empty">
              <img
                src="https://maplestory.io/api/GMS/83/mob/120100/render/stand"
                alt=""
                loading="lazy"
              />
              <p>
                {page.query
                  ? words(
                      `没有找到「${page.query}」。换个字试试，比如只输入名字的一部分。`,
                      `Nothing matches “${page.query}”. Try part of the name.`,
                    )
                  : page.region || page.area
                    ? words(
                        "这个地区暂无匹配的记录，请调整地区或区域。",
                        "No matching records in this location. Try another region or area.",
                      )
                    : filters.cat || filters.job
                      ? words(
                          "没有符合筛选条件的物品，请调整或重置筛选。",
                          "No items match these filters. Adjust or reset the filters.",
                        )
                      : words("暂无图鉴数据。", "No catalogue data yet.")}
              </p>
              <p className="hint">
                {words(
                  "试试：蜗牛、射手村、铁矿石",
                  "Try: snail, Henesys, iron ore",
                )}
              </p>
            </div>
          )}
        </div>
        {pagination}
      </div>
    </section>
  );
}

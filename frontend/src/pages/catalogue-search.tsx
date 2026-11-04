import { useEffect, useRef, useState, type ReactNode } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { usePreferences, useWords } from "../providers";
import { Icon, Slot, num } from "../components/shared";
import { Button } from "../components/ui/button";
import {
  Dialog,
  DialogTrigger,
  DialogContent,
  DialogTitle,
  DialogClose,
} from "../components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
} from "../components/ui/dropdown-menu";
import { levelRanges } from "../lib/price-state";
import { MapRow, MobRow, Secondary, useMapHint, useNames, Well } from "./catalogue";
import {
  jobs,
  regions,
  mobLevelRanges,
  sorts,
  searchKind,
  dexHref,
  categoryPatch,
  dexTokens,
  clearAllPatch,
  pageNumbers,
} from "/web/js/lib/dex-filters.js";

const kinds = [
  ["item", "物品", "Items", "items", "件"],
  ["mob", "怪物", "Monsters", "mobs", "只"],
  ["map", "地图", "Maps", "maps", "张"],
];
const categories = [
  ["", "全部", "All"],
  ["equip", "装备", "Equip"],
  ["use", "消耗", "Use"],
  ["setup", "装饰", "Setup"],
  ["etc", "其他", "Etc"],
  ["cash", "商城", "Cash"],
];

/** A number of results with its unit: 113 件, 12 只, 5 张. */
function useCount() {
  const words = useWords();
  return (kind: string, n: number) => {
    const row = kinds.find(([key]) => key === kind) || kinds[0];
    return words(`${num(n)} ${row[4]}`, `${num(n)} ${row[2].toLowerCase()}`);
  };
}

function ItemHit({ hit }: { hit: any }) {
  const words = useWords(),
    name = useNames();
  return (
    <a className="drow" href={"/item/" + hit.id}>
      <Slot empty url={hit.icon_url} />
      <span className="t">
        <b>{name(hit.names)}</b>
        {hit.level != null && Math.floor(hit.id / 1000000) === 1 && (
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
  );
}

function Hit({ kind, hit }: { kind: string; hit: any }) {
  const name = useNames(),
    mapHint = useMapHint();
  return kind === "item" ? (
    <ItemHit hit={hit} />
  ) : kind === "mob" ? (
    <MobRow mob={hit} />
  ) : (
    <MapRow
      map={hit}
      sub={[name(hit.street), mapHint(hit.hint)].filter(Boolean).join(" · ")}
    />
  );
}

/** One row of filter chips; `on` is the selected key, `""` for "all". */
function ChipRow({
  label,
  note,
  all,
  rows,
  on,
  data,
  pick,
  className = "chips dex-chips",
}: {
  label: string;
  note?: string;
  all?: string;
  rows: { key: string; label: string; count?: number }[];
  on: string;
  data: string;
  pick: (key: string) => void;
  className?: string;
}) {
  const chip = (key: string, text: ReactNode) => (
    <button
      type="button"
      key={key || "all"}
      className="chip"
      {...{ [data]: key || "all" }}
      aria-pressed={on === key}
      onClick={() => pick(key)}
    >
      {text}
    </button>
  );
  return (
    <div className="fsec">
      <h4>
        {label}
        {note && <small>{note}</small>}
      </h4>
      <div className={className} role="group" aria-label={label}>
        {all != null && chip("", all)}
        {rows.map((row) =>
          chip(
            row.key,
            <>
              {row.label}
              {row.count != null && <small>{num(row.count)}</small>}
            </>,
          ),
        )}
      </div>
    </div>
  );
}

export default function Search({ page }: { page: any }) {
  const words = useWords(),
    name = useNames(),
    count = useCount(),
    navigate = useNavigate(),
    route = useLocation();
  const { language } = usePreferences();
  const en = language === "en";
  const params = new URLSearchParams(route.search);
  const kind = searchKind(page);
  const groups = kinds.find(([key]) => key === kind)?.[3];
  const filters = page.filters || {},
    mobFilters = page.mob_filters || {},
    facets = page.facets || {};
  const levels = kind === "mob" ? mobFilters : filters;
  const [draft, setDraft] = useState(params.get("q") || "");
  const level = (key: string, old: string) =>
    new URLSearchParams(route.search).get(key) ??
    new URLSearchParams(route.search).get(old) ??
    "";
  const [lmin, setLmin] = useState(level("lmin", "min_level")),
    [lmax, setLmax] = useState(level("lmax", "max_level"));
  const composing = useRef(false),
    typing = useRef(false);
  // Links start from the address bar, so quick clicks build on each other.
  function go(patch: Record<string, any>, replace = true) {
    navigate(dexHref(location.search, patch), { replace });
  }
  useEffect(() => {
    const q = new URLSearchParams(route.search).get("q") || "";
    if (!typing.current) setDraft(q);
    setLmin(level("lmin", "min_level"));
    setLmax(level("lmax", "max_level"));
  }, [route.search]);
  useEffect(() => {
    if (!typing.current || composing.current) return;
    const timer = setTimeout(() => {
      typing.current = false;
      go({ q: draft.trim() });
    }, 200);
    return () => clearTimeout(timer);
  }, [draft]);
  const tokens: { key: string; label: string; value: string; patch: any }[] =
    dexTokens(page, en);
  const hits = groups ? page[groups] : null;
  const size = page.page_size || (kind ? 60 : 20);
  const total = hits ? (hits.total ?? hits.rows.length) : 0;
  const number = Math.floor((page.offset || 0) / size) + 1,
    pages = Math.max(1, Math.ceil(total / size));
  const sortRows = sorts[kind as keyof typeof sorts] || [];
  const sortKey = (kind === "mob" ? mobFilters.sort : filters.sort) || "";
  const sortRow = sortRows.find(([key]: string[]) => key === sortKey) ||
    sortRows[0];
  const turn = (n: number) => {
    go({ page: n > 1 ? String(n) : null }, false);
    window.scrollTo({ top: 0 });
  };
  const levelSection = (presets: readonly (readonly [number, number | null])[]) => (
    <div className="fsec">
      <h4>{words(kind === "mob" ? "等级" : "需求等级", kind === "mob" ? "Level" : "Required level")}</h4>
      <div className="lvrow">
        {(
          [
            ["lmin", "最低", "Min", lmin, setLmin],
            ["lmax", "最高", "Max", lmax, setLmax],
          ] as const
        ).map(([key, zh, english, value, set]) => (
          <label key={key}>
            {words(zh, english)}
            <input
              type="number"
              min={0}
              max={300}
              inputMode="numeric"
              {...{ [`data-${key}`]: "" }}
              value={value}
              onChange={(event) => {
                const next = event.target.value;
                set(next);
                go({ [key]: /^\d{1,3}$/.test(next) ? next : null });
              }}
            />
          </label>
        ))}
      </div>
      <div className="chips level-presets">
        {presets.map(([lo, hi]) => (
          <button
            type="button"
            key={lo}
            className="chip"
            data-lv={hi == null ? `${lo}+` : `${lo}-${hi}`}
            aria-pressed={(levels.lmin ?? 0) === lo && (levels.lmax ?? null) === hi}
            onClick={() => go({ lmin: lo || (hi == null ? null : "0"), lmax: hi })}
          >
            {hi == null ? `${lo}+` : `${lo}–${hi}`}
          </button>
        ))}
      </div>
    </div>
  );
  const placeSections = (
    <>
      <ChipRow
        label={words("地区", "Region")}
        all={words("所有地区", "All regions")}
        rows={regions.map(([key, zh, english]: string[]) => ({
          key,
          label: words(zh, english),
        }))}
        on={page.region || ""}
        data="data-region"
        pick={(key) => go({ region: key, area: null })}
      />
      {page.region && (
        <ChipRow
          label={words("区域", "Area")}
          all={words("所有区域", "All areas")}
          rows={(page.areas || [])
            .filter((area: any) => area.region === page.region)
            .map((area: any) => ({ key: area.key, label: name(area.names) }))}
          on={page.area || ""}
          data="data-area"
          pick={(key) => go({ area: key })}
        />
      )}
    </>
  );
  const check = (key: string, text: string, checked: boolean, flip: () => void) => (
    <label className="filter-check" key={key}>
      <input
        type="checkbox"
        {...{ [`data-${key}`]: "" }}
        checked={checked}
        onChange={flip}
      />
      {text}
    </label>
  );
  const sheet =
    kind === "item" ? (
      filters.cat === "use" ? (
        <ChipRow
          label={words("消耗类型", "Use type")}
          all={words("所有类型", "All types")}
          rows={(facets.uses || []).map((row: any) => ({
            key: row.key,
            label: name(row.names),
            count: row.count,
          }))}
          on={filters.use || ""}
          data="data-use"
          pick={(key) => go({ use: key })}
        />
      ) : (
        <>
          <div className="fsec">
            <h4>
              {words("职业", "Job")}
            </h4>
            <div className="chips dex-chips" role="group" aria-label={words("职业", "Job")}>
              {[["", "所有职业", "All jobs"], ...jobs].map(
                ([key, zh, english]: string[]) => (
                  <button
                    type="button"
                    key={key || "all"}
                    className="chip"
                    data-job={key || "all"}
                    aria-pressed={(filters.job || "") === key}
                    onClick={() => go({ job: key })}
                  >
                    {words(zh, english)}
                  </button>
                ),
              )}
            </div>
            {check(
              "shared",
              words("包含通用装备", "Include all-class gear"),
              filters.shared !== false,
              () => go({ shared: filters.shared === false ? null : "0" }),
            )}
          </div>
          <ChipRow
            label={words("装备类型", "Equipment type")}
            all={words("所有类型", "All types")}
            rows={(facets.types || []).map((row: any) => ({
              key: row.key,
              label: name(row.names),
              count: row.count,
            }))}
            on={filters.type || ""}
            data="data-equipment-type"
            pick={(key) => go({ type: key, weapon: null })}
          />
          {filters.type === "weapon" && (
            <ChipRow
              label={words("武器类型", "Weapon type")}
              all={words("所有武器", "All weapons")}
              rows={(facets.weapons || []).map((row: any) => ({
                key: String(row.key),
                label: name(row.names),
                count: row.count,
              }))}
              on={filters.weapon == null ? "" : String(filters.weapon)}
              data="data-weapon"
              pick={(key) => go({ weapon: key })}
            />
          )}
          {levelSection(levelRanges)}
        </>
      )
    ) : kind === "mob" ? (
      <>
        {levelSection(mobLevelRanges)}
        {placeSections}
        <div className="fsec">
          {check("boss", words("只看 Boss", "Bosses only"), !!mobFilters.boss, () =>
            go({ boss: !mobFilters.boss }),
          )}
        </div>
      </>
    ) : (
      <>
        {placeSections}
        <div className="fsec">
          {check("town", words("只看城镇", "Towns only"), !!page.town, () =>
            go({ town: !page.town }),
          )}
        </div>
      </>
    );
  return (
    <section className="stall dex-search">
      <div className="stall-bar">
        <h2>{words("图鉴", "Catalogue")}</h2>
        {page.query && <span className="bar-meta">“{page.query}”</span>}
      </div>
      <div className={"dex-tools " + (kind ? "dex-kind" : "")}>
        <form
          className="finder in-page"
          id="catalog-search"
          action="/search"
          method="get"
          role="search"
          onSubmit={(event) => {
            event.preventDefault();
            typing.current = false;
            go({ q: draft.trim() });
          }}
        >
          <Icon name="search" />
          <input
            type="search"
            name="q"
            value={draft}
            placeholder={words("搜索物品、怪物、地图", "Search items, monsters, maps")}
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
              go({ q: event.currentTarget.value.trim() });
            }}
          />
        </form>
        <nav className="tabs dex-kinds" aria-label={words("图鉴分类", "Catalogue")}>
          {kinds.map(([key, zh, english]) => {
            const next = new URLSearchParams({
              ...(page.query ? { q: page.query } : {}),
              kind: key,
              ...(key !== "item" && kind !== "item" && page.region
                ? { region: page.region }
                : {}),
              ...(key !== "item" && kind !== "item" && page.area
                ? { area: page.area }
                : {}),
            });
            return (
              <a
                key={key}
                className={"tab " + (kind === key ? "on" : "")}
                aria-current={kind === key ? "page" : undefined}
                data-kind={key}
                href={"/search?" + next}
              >
                {words(zh, english)}
              </a>
            );
          })}
        </nav>
        {kind === "item" && (
          <div className="cats" data-cats role="group" aria-label={words("物品分类", "Item category")}>
            {categories.map(([key, zh, english]) => {
              const facet = (facets.categories || []).find((row: any) => row.key === key);
              const on = (filters.cat || "") === key;
              return (
                <button
                  type="button"
                  key={key || "all"}
                  className={"cat " + (on ? "on" : "")}
                  aria-pressed={on}
                  data-cat={key || "all"}
                  onClick={() => go(categoryPatch(key))}
                >
                  {words(zh, english)}
                  {facet && <small>{num(facet.count)}</small>}
                </button>
              );
            })}
          </div>
        )}
        {sortRow && (
          <span className="sortwrap">
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <button
                  type="button"
                  className="sortbtn"
                  data-sort-btn
                  aria-label={words("排序：", "Sort: ") + words(sortRow[1], sortRow[2])}
                >
                  <span data-sort-label>{words(sortRow[1], sortRow[2])}</span>
                  <Icon name="caret" />
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent>
                <DropdownMenuRadioGroup value={sortKey}>
                  {sortRows.map(([key, zh, english]: string[]) => (
                    <DropdownMenuRadioItem
                      value={key}
                      key={key || "default"}
                      data-sort={key || "default"}
                      onSelect={() => go({ sort: key })}
                    >
                      {words(zh, english)}
                    </DropdownMenuRadioItem>
                  ))}
                </DropdownMenuRadioGroup>
              </DropdownMenuContent>
            </DropdownMenu>
          </span>
        )}
        {kind && (
          <Dialog>
            <DialogTrigger asChild>
              <button
                type="button"
                className={"sortbtn fbtn " + (tokens.length ? "on" : "")}
                data-filter-btn
                aria-label={words("筛选", "Filter")}
              >
                <Icon name="funnel" />
                <span>{words("筛选", "Filter")}</span>
                {tokens.length > 0 && <b className="fcount">{tokens.length}</b>}
              </button>
            </DialogTrigger>
            <DialogContent
              className="price-filter-dialog dex-filter-dialog"
              aria-describedby={undefined}
            >
              <div className="stall-bar">
                <DialogTitle>{words("筛选", "Filter")}</DialogTitle>
              </div>
              <div className="fpanel">{sheet}</div>
              <div className="ffoot">
                <Button data-filter-reset onClick={() => go(clearAllPatch(tokens))}>
                  {words("重置", "Reset")}
                </Button>
                <DialogClose asChild>
                  <Button variant="primary" data-apply>
                    {words("显示 ", "Show ")}
                    {count(kind, total)}
                  </Button>
                </DialogClose>
              </div>
            </DialogContent>
          </Dialog>
        )}
      </div>
      {kind ? (
        <>
          {tokens.length > 0 && (
            <div className="dex-tokens" data-active-filters>
              {tokens.map((token) => (
                <button
                  type="button"
                  className="tok"
                  key={token.key}
                  data-remove-filter={token.key}
                  onClick={() => go(token.patch)}
                >
                  {token.label && token.label + " "}
                  <b>{token.value}</b> ×
                </button>
              ))}
              <button
                type="button"
                className="dex-clear"
                data-clear-filters
                onClick={() => go(clearAllPatch(tokens))}
              >
                {words("清除筛选", "Clear filters")}
              </button>
            </div>
          )}
          <p className="dex-total" data-total>
            {words("共 ", "")}
            {count(kind, total)}
            {total > 0 && words(` · 第 ${number}/${pages} 页`, ` · page ${number} of ${pages}`)}
          </p>
          <div data-search-results aria-live="polite" id={"search-" + kind}>
            {hits.rows.length ? (
              <div className="catalogue-grid">
                {hits.rows.map((hit: any) => (
                  <Hit kind={kind} hit={hit} key={hit.id} />
                ))}
              </div>
            ) : (
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
                    : tokens.length || filters.cat
                      ? words("没有符合筛选条件的结果。", "Nothing matches these filters.")
                      : words("暂无图鉴数据。", "No catalogue data yet.")}
                </p>
                {(page.query || tokens.length > 0 || filters.cat) && (
                  <Button
                    data-clear-search
                    onClick={() => navigate("/search?kind=" + kind, { replace: true })}
                  >
                    {words("清空搜索和筛选", "Clear search and filters")}
                  </Button>
                )}
              </div>
            )}
          </div>
          {pages > 1 && (
            <nav className="dex-pager" data-pager aria-label={words("分页", "Pagination")}>
              {number > 1 && (
                <button type="button" className="chip" data-page="prev" onClick={() => turn(number - 1)}>
                  {words("上一页", "Previous")}
                </button>
              )}
              {pageNumbers(number, pages).map((n: number | null, i: number) =>
                n == null ? (
                  <span className="gap" key={"gap" + i}>
                    …
                  </span>
                ) : (
                  <button
                    type="button"
                    key={n}
                    className={"chip " + (n === number ? "on" : "")}
                    aria-current={n === number ? "page" : undefined}
                    data-page={n}
                    onClick={() => turn(n)}
                  >
                    {n}
                  </button>
                ),
              )}
              {number < pages && (
                <button type="button" className="chip" data-page="next" onClick={() => turn(number + 1)}>
                  {words("下一页", "Next")}
                </button>
              )}
            </nav>
          )}
        </>
      ) : (
        <div className="dbody" data-search-results aria-live="polite">
          {!page.items.rows.length && !page.mobs.rows.length && !page.maps.rows.length ? (
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
                  : words("暂无图鉴数据。", "No catalogue data yet.")}
              </p>
              <p className="hint">
                {words("试试：蜗牛、射手村、铁矿石", "Try: snail, Henesys, iron ore")}
              </p>
            </div>
          ) : (
            kinds.map(([key, zh, english, group]) => {
              const group_hits = page[group];
              const n = group_hits.total ?? group_hits.rows.length;
              return (
                <Well
                  key={key}
                  id={"search-" + key}
                  title={words(zh, english)}
                  note={words("共 ", "") + count(key, n)}
                >
                  {group_hits.rows.length ? (
                    <div className="catalogue-grid">
                      {group_hits.rows.map((hit: any) => (
                        <Hit kind={key} hit={hit} key={hit.id} />
                      ))}
                    </div>
                  ) : (
                    <p className="note">{words("没有匹配结果。", "No matches.")}</p>
                  )}
                  {group_hits.more && (
                    <a
                      className="more"
                      data-kind-all={key}
                      href={"/search?" + new URLSearchParams({ q: page.query, kind: key })}
                    >
                      {words("查看全部 ", "Show all ")}
                      {count(key, n)}
                    </a>
                  )}
                </Well>
              );
            })
          )}
        </div>
      )}
    </section>
  );
}

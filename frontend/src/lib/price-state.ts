import type { Product } from "./types";
import { equipmentTypes } from "/web/js/lib/price-filters.js?v=20261023-equipment-filters-1";
export const levelRanges: readonly (readonly [number, number | null])[] = [
  [0, 20],
  [20, 30],
  [30, 40],
  [40, 50],
  [50, 60],
  [60, 70],
  [70, null],
];
export const categories = [
  ["all", "", "全部", "All"],
  ["equip", "装备", "装备", "Equip"],
  ["use", "消耗品", "消耗", "Use"],
  ["etc", "其他", "其他", "Etc"],
  ["cash", "商城物品", "商城", "Cash"],
];
export const jobs = [
  ["all", "", "所有职业", "All jobs"],
  ["warrior", "战士", "战士", "Warrior"],
  ["magician", "魔法师", "法师", "Magician"],
  ["bowman", "弓箭手", "弓箭手", "Bowman"],
  ["thief", "飞侠", "飞侠", "Thief"],
  ["pirate", "海盗", "海盗", "Pirate"],
];
export const sortLabels = {
  sales: ["成交笔数", "Sales"],
  price: ["成交价", "Typical sale"],
  change: ["区间涨跌", "Change"],
  low: ["最低摆摊价", "Lowest ask"],
  name: ["名称", "Name"],
  recent: ["最新报价优先", "Latest offers first"],
} as const;
export type Sort = keyof typeof sortLabels;
export const defaultDirection = (sort: string) =>
  ["low", "name"].includes(sort) ? "asc" : "desc";
export function readPriceState(search: string) {
  const params = new URLSearchParams(search);
  const sort =
    params.get("sort")! in sortLabels ? (params.get("sort") as Sort) : "sales";
  const level = (key: string) =>
    /^\d{1,3}$/.test(params.get(key) || "") ? Number(params.get(key)) : null;
  return {
    tab: ["all", "changes", "sales"].includes(params.get("tab") || "")
      ? params.get("tab")!
      : "all",
    q: (params.get("q") || "").slice(0, 100),
    cat: categories.some(([key]) => key === params.get("cat"))
      ? params.get("cat")!
      : "all",
    job: jobs.some(([key]) => key === params.get("job"))
      ? params.get("job")!
      : "all",
    type: equipmentTypes.some(([key]: string[]) => key === params.get("type"))
      ? params.get("type")!
      : "all",
    sort,
    dir: ["asc", "desc"].includes(params.get("dir") || "")
      ? params.get("dir")!
      : defaultDirection(sort),
    lmin: level("lmin"),
    lmax: level("lmax"),
    few: params.get("few") !== "0",
    cash: params.get("cash") !== "0",
    sold: params.get("sold") === "1",
    drop: params.get("drop") === "1",
    watch: params.get("watch") === "1",
  };
}
export type PriceState = ReturnType<typeof readPriceState>;
export function priceUrl(state: PriceState, current: string) {
  const params = new URLSearchParams(current);
  for (const key of [
    "tab",
    "q",
    "cat",
    "job",
    "type",
    "sort",
    "dir",
    "lmin",
    "lmax",
    "few",
    "cash",
    "sold",
    "drop",
    "watch",
    "item",
  ])
    params.delete(key);
  for (const key of ["tab", "cat", "job", "type"] as const)
    if (state[key] !== "all") params.set(key, state[key]);
  if (state.q) params.set("q", state.q);
  if (state.sort !== "sales") params.set("sort", state.sort);
  if (state.dir !== defaultDirection(state.sort)) params.set("dir", state.dir);
  if (state.lmin != null) params.set("lmin", String(state.lmin));
  if (state.lmax != null) params.set("lmax", String(state.lmax));
  if (!state.few) params.set("few", "0");
  if (!state.cash) params.set("cash", "0");
  for (const key of ["sold", "drop", "watch"] as const)
    if (state[key]) params.set(key, "1");
  return "?" + params.toString();
}
export function compareProducts(
  a: Product,
  b: Product,
  sort: Sort,
  dir: string,
  en: boolean,
) {
  const value = (row: Product): number | string | null =>
    sort === "name"
      ? (en ? row.name_en || row.name_zh : row.name_zh || row.name_en) ||
        String(row.item_id)
      : sort === "recent"
        ? row.last_seen || null
        : sort === "sales"
          ? (row.sales_window ?? 0)
          : sort === "price"
            ? (row.typical ?? null)
            : sort === "change"
              ? (row.change_window ?? null)
              : (row.low ?? null);
  const x = value(a),
    y = value(b);
  if (x == null && y != null) return 1;
  if (x != null && y == null) return -1;
  const primary =
    x == null || y == null
      ? 0
      : typeof x === "string"
        ? x.localeCompare(String(y), en ? "en" : "zh-CN")
        : x - Number(y);
  return (
    primary * (dir === "asc" ? 1 : -1) ||
    (b.sales_10d || 0) - (a.sales_10d || 0) ||
    (b.listings || 0) - (a.listings || 0) ||
    a.item_id - b.item_id
  );
}

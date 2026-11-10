import { useEffect, useMemo, useState } from "react";
import { useQueries, useQuery } from "@tanstack/react-query";
import { getJson } from "/web/js/lib/api.js?v=20261022-auto-watch-2";
import { itemName } from "/web/js/lib/i18n.js";
import { equipmentSummary } from "/web/js/lib/equipment-summary.js?v=20261029-critical-1";
import { useWords } from "../providers";
import { Slot, usePageReady } from "../components/shared";
import { SiteLink } from "../components/shell";
import { isEnglish, useItemRows } from "../components/sweep-content";
import { getAccountJson, useAccountTopics } from "../lib/account-api";
import { embedded } from "../lib/embed";
import { mainStat } from "../lib/item-market";
import { useAccount } from "../lib/query";
import type { Device, EquipmentPiece, Holdings } from "../lib/sweep-labels";
import "./selling.css";

/** 客户端里经本机回环打开时直接读本机背包；公网网站（含客户端里的工具页）读账号设备。 */
const LOCAL_BAG = embedded && ["127.0.0.1", "localhost"].includes(location.hostname);

/** 成交 25% 分位、成交中位，或玩家手填。 */
type Strategy = "s25" | "s50" | "manual";
interface Line {
  strat: Strategy | null;
  manual: string;
  bundle: number;
  groups: number;
}
/** 清单的键：普通物品是物品 ID，装备是 `eq:<格子>:<物品 ID>`（同名装备每件属性不同）。 */
interface Plan {
  global: "s25" | "s50";
  order: string[];
  lines: Record<string, Line>;
}
interface Prices {
  s25: number | null;
  s50: number | null;
  count: number;
  /** 普通物品：72 小时无成交、按最近成交。 */
  recent?: boolean;
  /** 装备：same 同属性 / all 同名全部（属性不同）/ none。 */
  basis?: "same" | "all" | "none";
  main?: string | null;
  mainValue?: number;
}
const PLAN_KEY = "selling.plan.v1";
const BAGS: [number, string, string][] = [
  [1, "装备", "Equip"],
  [2, "消耗", "Use"],
  [3, "设置", "Set-up"],
  [4, "其他", "Etc"],
];
const MAIN_LABEL: Record<string, [string, string]> = {
  weapon_attack: ["物攻", "Weapon ATK"],
  magic_attack: ["魔攻", "Magic ATK"],
};
const DEVICES_KEY = ["selling-devices"] as const;
const gearKey = (piece: EquipmentPiece) => `eq:${piece.slot}:${piece.item_id}`;
const itemOf = (key: string) => Number(key.startsWith("eq:") ? key.split(":")[2] : key);

function readPlan(): Plan {
  try {
    const raw = JSON.parse(localStorage.getItem(PLAN_KEY) || "null");
    if (raw && Array.isArray(raw.order) && raw.lines && typeof raw.lines === "object")
      return {
        global: raw.global === "s25" ? "s25" : "s50",
        order: raw.order.map(String).filter((key: string) => raw.lines[key] && Number.isSafeInteger(itemOf(key))),
        lines: raw.lines,
      };
  } catch {
    /* 没有或损坏的方案从空开始 */
  }
  return { global: "s50", order: [], lines: {} };
}
const n = (value: number | null | undefined) =>
  value == null ? "—" : Math.ceil(value).toLocaleString("en-US");
const positive = (value: unknown) =>
  typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null;
/** 线性插值分位数，与服务端 market_pricing.percentile 一致。 */
function percentile(sorted: number[], fraction: number) {
  const p = (sorted.length - 1) * fraction,
    i = Math.floor(p);
  return sorted[i] + (sorted[Math.min(i + 1, sorted.length - 1)] - sorted[i]) * (p - i);
}

/** 72 小时成交价；没有成交时退到最近几笔成交。价格向上取整成整数金币。 */
export function salePrices(product: any): Prices {
  if (!product) return { s25: null, s50: null, count: 0, recent: false };
  const windowed = Number(product.sales_window) > 0;
  const low = positive(windowed ? product.typical_window_low : product.typical_low);
  const mid = positive(windowed ? product.typical_window : product.typical);
  return {
    s25: low == null ? null : Math.ceil(low),
    s50: mid == null ? null : Math.ceil(mid),
    count: windowed ? Number(product.sales_window) : 0,
    recent: !windowed && mid != null,
  };
}

/**
 * 一件装备的参考价：同名装备里主属性相同（武器比攻击）的成交；没有主属性的装备比
 * 全部属性。没有可比成交时用同名全部成交并标明属性不同。近 30 天够 3 笔就只用近 30 天。
 */
export function gearPrices(piece: EquipmentPiece, sales: any[] | undefined, now = Date.now() / 1000): Prices {
  const rows = (sales || []).filter(
    (s) => positive(s.sale_unit_price) && s.equipment?.status === "candidate" && Array.isArray(s.equipment.stats),
  );
  const value = (stats: { key: string; value: number }[], key: string) => stats.find((s) => s.key === key)?.value ?? 0;
  const main = mainStat(piece.item_id);
  const mine = (key: string) => value(piece.stats, key);
  const keys = (stats: { key: string; value: number }[]) =>
    stats.filter((s) => s.value > 0).map((s) => `${s.key}=${s.value}`).sort().join(",");
  const same = !piece.decoded
    ? []
    : main
      ? rows.filter((s) => value(s.equipment.stats, main) === mine(main))
      : rows.filter((s) => keys(s.equipment.stats) === keys(piece.stats));
  let pool = same.length ? same : rows;
  const recent = pool.filter((s) => Number(s.time) >= now - 30 * 86400);
  if (recent.length >= 3) pool = recent;
  const prices = pool.map((s) => Number(s.sale_unit_price)).sort((a, b) => a - b);
  return {
    s25: prices.length ? Math.ceil(percentile(prices, 0.25)) : null,
    s50: prices.length ? Math.ceil(percentile(prices, 0.5)) : null,
    count: prices.length,
    basis: !prices.length ? "none" : same.length ? "same" : "all",
    main: piece.decoded ? main : null,
    mainValue: main ? mine(main) : undefined,
  };
}
function defaults(quantity: number): Line {
  const bundle = quantity <= 10 ? 1 : Math.min(quantity, 100);
  return { strat: null, manual: "", bundle, groups: Math.max(1, Math.floor(quantity / bundle)) };
}

/** 背包：客户端里读本机，网页上读账号下在线设备上传的背包。 */
function useHoldings(signedIn: boolean) {
  const local = useQuery({
    queryKey: ["selling-local-inventory"],
    enabled: LOCAL_BAG,
    refetchInterval: 5_000,
    queryFn: async ({ signal }) =>
      (await getJson("/api/v1/collector/inventory", { signal })).data as {
        holdings: Holdings | null;
      },
  });
  const devices = useQuery({
    queryKey: DEVICES_KEY,
    enabled: !LOCAL_BAG && signedIn,
    queryFn: ({ signal }) =>
      getAccountJson<{ devices: Device[] }>("/api/v1/account/devices", signal),
  });
  useAccountTopics(["devices"], DEVICES_KEY, !LOCAL_BAG && signedIn);
  if (LOCAL_BAG)
    return {
      loading: local.isLoading,
      sources: local.data?.holdings
        ? [{ id: "local", name: "", holdings: local.data.holdings }]
        : [],
    };
  const sources = (devices.data?.devices || [])
    .filter((d) => d.online && d.state?.sweep?.game?.connected !== false && d.state?.sweep?.holdings)
    .map((d) => ({ id: d.id, name: d.name, holdings: d.state!.sweep!.holdings! }));
  return { loading: devices.isLoading, sources, error: devices.error };
}

/** 背包里物品的报价，每次最多 100 个物品。 */
function useProducts(ids: number[]) {
  const sorted = [...new Set(ids)].sort((a, b) => a - b);
  const chunks: number[][] = [];
  for (let i = 0; i < sorted.length; i += 100) chunks.push(sorted.slice(i, i + 100));
  const results = useQueries({
    queries: chunks.map((chunk) => ({
      queryKey: ["market", `/api/v1/market/selected?hours=72&ids=${chunk.join(",")}`],
      staleTime: 60_000,
      queryFn: async ({ signal }: { signal: AbortSignal }) =>
        (await getJson(`/api/v1/market/selected?hours=72&ids=${chunk.join(",")}`, { signal })).data,
    })),
  });
  return new Map<number, any>(
    results.flatMap((r) => ((r.data as any)?.products || []).map((p: any) => [p.item_id, p])),
  );
}

/** NPC 回收价，每次最多 100 个物品。 */
function useNpcSell(ids: number[]) {
  const sorted = [...new Set(ids)].sort((a, b) => a - b);
  const chunks: number[][] = [];
  for (let i = 0; i < sorted.length; i += 100) chunks.push(sorted.slice(i, i + 100));
  const results = useQueries({
    queries: chunks.map((chunk) => ({
      queryKey: ["npc-sell", chunk.join(",")],
      staleTime: 3_600_000,
      queryFn: async ({ signal }: { signal: AbortSignal }) =>
        (await getJson(`/api/v1/npc-sell?ids=${chunk.join(",")}`, { signal })).data,
    })),
  });
  return new Map<number, number>(
    results.flatMap((r) =>
      Object.entries(((r.data as any)?.prices || {}) as Record<string, number>).map(([id, p]) => [Number(id), p]),
    ),
  );
}

/** 清单里装备的同名成交记录（带属性），一件装备一次请求。 */
function useGearSales(ids: number[]) {
  const unique = [...new Set(ids)].sort((a, b) => a - b);
  const results = useQueries({
    queries: unique.map((id) => ({
      queryKey: ["selling-gear-sales", id],
      staleTime: 300_000,
      queryFn: async ({ signal }: { signal: AbortSignal }) => (await getJson(`/api/v1/item/${id}`, { signal })).data,
    })),
  });
  return new Map<number, any[] | undefined>(unique.map((id, i) => [id, (results[i].data as any)?.sales]));
}

export default function Selling() {
  usePageReady();
  const words = useWords();
  const account = useAccount();
  const signedIn = LOCAL_BAG || Boolean(account.data?.signed_in);
  const { loading, sources } = useHoldings(signedIn);
  const [deviceId, setDeviceId] = useState("");
  const source = sources.find((s) => s.id === deviceId) || sources[0] || null;
  const holdings = source?.holdings || null;
  const [bag, setBag] = useState(1);
  const [plan, setPlan] = useState<Plan>(readPlan);
  useEffect(() => {
    try {
      localStorage.setItem(PLAN_KEY, JSON.stringify(plan));
    } catch {
      /* 存不下时只在本页有效 */
    }
  }, [plan]);

  const held = useMemo(() => {
    const map = new Map<string, number>();
    for (const item of holdings?.items || []) map.set(String(item.item_id), item.quantity);
    return map;
  }, [holdings]);
  const gear = useMemo(
    () => new Map((holdings?.equipment || []).map((piece) => [gearKey(piece), piece])),
    [holdings],
  );
  const allIds = [
    ...new Set([...(holdings?.items || []).map((i) => i.item_id), ...[...gear.values()].map((p) => p.item_id), ...plan.order.map(itemOf)]),
  ];
  const products = useProducts(allIds);
  const npcSell = useNpcSell(allIds);
  const gearSales = useGearSales(plan.order.filter((key) => key.startsWith("eq:")).map(itemOf));
  const rowOf = useItemRows(
    allIds.filter((id) => !products.has(id)),
    products,
  );
  const name = (id: number) => {
    const row = rowOf(id);
    return row ? itemName(row) : String(id);
  };
  const icon = (id: number) => rowOf(id)?.icon_url as string | undefined;
  const summary = (piece: EquipmentPiece) =>
    piece.decoded
      ? equipmentSummary({ item_id: piece.item_id, equipment: { ...piece, status: "candidate" } }, isEnglish())
      : words("属性未解析", "Stats not decoded");

  const gearReadable = Array.isArray(holdings?.equipment);
  const bagItems: { key: string; item_id: number; quantity: number; piece?: EquipmentPiece }[] =
    bag === 1
      ? [...gear.entries()].map(([key, piece]) => ({ key, item_id: piece.item_id, quantity: 1, piece }))
      : (holdings?.items || [])
          .filter((i) => Math.floor(i.item_id / 1_000_000) === bag && i.quantity > 0)
          .sort((a, b) => a.item_id - b.item_id)
          .map((i) => ({ key: String(i.item_id), item_id: i.item_id, quantity: i.quantity }));
  const bagRead = bag === 1 ? gearReadable : (holdings?.categories.includes(bag) ?? false);

  const update = (key: string, change: Partial<Line>) =>
    setPlan((p) => ({ ...p, lines: { ...p.lines, [key]: { ...p.lines[key], ...change } } }));
  const toggle = (key: string) =>
    setPlan((p) => {
      if (p.lines[key]) {
        const lines = { ...p.lines };
        delete lines[key];
        return { ...p, lines, order: p.order.filter((x) => x !== key) };
      }
      return {
        ...p,
        lines: { ...p.lines, [key]: defaults(key.startsWith("eq:") ? 1 : held.get(key) || 1) },
        order: [...p.order, key],
      };
    });
  const setGlobal = (global: "s25" | "s50") =>
    setPlan((p) => ({
      global,
      order: p.order,
      lines: Object.fromEntries(
        Object.entries(p.lines).map(([key, line]) => [key, { ...line, strat: line.strat === "manual" ? "manual" : null }]),
      ),
    }));
  const selectPriced = () =>
    setPlan((p) => {
      const add = bagItems.filter((i) => {
        const product = products.get(i.item_id);
        return !p.lines[i.key] && (i.piece ? Number(product?.sales_10d) > 0 || positive(product?.typical) : salePrices(product).s50 != null);
      });
      return {
        ...p,
        order: [...p.order, ...add.map((i) => i.key)],
        lines: { ...p.lines, ...Object.fromEntries(add.map((i) => [i.key, defaults(i.quantity)])) },
      };
    });

  let grand = 0,
    slots = 0,
    npcTotal = 0;
  const rows = plan.order.map((key) => {
    const line = plan.lines[key];
    const id = itemOf(key);
    const piece = key.startsWith("eq:") ? gear.get(key) : undefined;
    const isGear = key.startsWith("eq:");
    const quantity = isGear ? (piece ? 1 : 0) : (held.get(key) ?? 0);
    const prices = isGear ? (piece ? gearPrices(piece, gearSales.get(id)) : { s25: null, s50: null, count: 0 }) : salePrices(products.get(id));
    const strat = line.strat || plan.global;
    const unit = strat === "manual" ? Number(line.manual) || null : prices[strat];
    const bundle = isGear ? 1 : line.bundle,
      groups = isGear ? 1 : line.groups;
    const selling = bundle * groups;
    const warn = !holdings
      ? ""
      : quantity === 0
        ? words("背包里已经没有了", "No longer in your bag")
        : selling > quantity
          ? words("超出背包数量", "More than you hold")
          : unit == null
            ? strat === "manual"
              ? words("请输入单价", "Enter a unit price")
              : words("没有成交数据，请手动定价", "No sales; set a price")
            : "";
    const total = unit != null && !warn ? unit * selling : null;
    const npc = npcSell.get(id) ?? null;
    if (total != null) {
      grand += total;
      slots += groups;
      npcTotal += (npc ?? 0) * selling;
    }
    // 摆摊价不高于 NPC 回收价时，直接卖给 NPC 更划算。
    const belowNpc = npc != null && unit != null && unit <= npc;
    return { key, id, piece, isGear, line, bundle, groups, quantity, prices, strat, unit, selling, warn, total, npc, belowNpc };
  });
  const basisText = (r: (typeof rows)[number]) => {
    const p = r.prices;
    if (!r.isGear)
      return p.count
        ? words(`成交 ${p.count} 笔`, `${p.count} sales`)
        : p.recent
          ? words("72 小时无成交，按最近成交", "No sales in 72 h; recent sales")
          : words("无成交", "No sales");
    if (p.basis === "same" && p.main)
      return words(
        `同${MAIN_LABEL[p.main]?.[0] ?? ""} ${p.mainValue} · 成交 ${p.count} 笔`,
        `Same ${MAIN_LABEL[p.main]?.[1] ?? ""} ${p.mainValue} · ${p.count} sales`,
      );
    if (p.basis === "same") return words(`同属性 · 成交 ${p.count} 笔`, `Same stats · ${p.count} sales`);
    if (p.basis === "all") return words(`同名 · 成交 ${p.count} 笔（属性不同）`, `Same item · ${p.count} sales (other stats)`);
    return words("无成交", "No sales");
  };

  const copyText = () =>
    rows
      .filter((r) => r.total != null)
      .map((r) =>
        r.isGear
          ? `${name(r.id)}  ${r.piece ? summary(r.piece) : ""}  ${n(r.unit)}`
          : `${name(r.id)}  ${n(r.unit)} × ${r.bundle} × ${r.groups}${words("组", " lots")}`,
      )
      .join("\n");

  if (!signedIn && !account.isLoading)
    return (
      <section className="stall selling-page">
        <div className="stall-bar">
          <h1>{words("摆摊", "Shop planner")}</h1>
        </div>
        <div className="selling-empty">
          <p>{words("登录后读取客户端同步的背包。", "Sign in to read the inventory your collector syncs.")}</p>
          <SiteLink className="btn" href="/account">
            {words("登录", "Sign in")}
          </SiteLink>
        </div>
      </section>
    );

  return (
    <div className="selling-page">
      <div className="selling-head">
        <h1>{words("摆摊", "Shop planner")}</h1>
        <span className="selling-src" data-selling-source>
          <i className={holdings ? "on" : ""} aria-hidden="true" />
          {holdings
            ? words("背包更新于 ", "Bag updated ") +
              new Date(holdings.observed_at * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
            : loading
              ? words("正在读取背包…", "Reading bag…")
              : words("等待游戏数据：打开游戏和采集器", "Waiting for the game and collector")}
        </span>
        {sources.length > 1 && (
          <select
            className="selling-device"
            value={source?.id}
            onChange={(e) => setDeviceId(e.target.value)}
            aria-label={words("设备", "Device")}
          >
            {sources.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
        )}
      </div>

      <div className="selling-layout">
        <section className="stall selling-bag" data-selling-bag>
          <div className="stall-bar">
            <h2>{words("我的背包", "My bag")}</h2>
            <span className="bar-meta">{words("点选要卖的", "Tap to sell")}</span>
          </div>
          <div className="selling-tabs" role="tablist">
            {BAGS.map(([id, zh, en]) => (
              <button
                key={id}
                type="button"
                role="tab"
                aria-selected={bag === id}
                className={bag === id ? "on" : ""}
                onClick={() => setBag(id)}
              >
                {words(zh, en)}
              </button>
            ))}
          </div>
          {!holdings ? (
            <p className="selling-note">{words("没有背包数据", "No bag data")}</p>
          ) : !bagRead ? (
            <p className="selling-note">
              {bag === 1
                ? words("装备栏还没读到：更新采集器后换一次频道", "Equipment not read yet: update the collector, then change channel")
                : words("这一栏还没读到", "This tab has not been read yet")}
            </p>
          ) : !bagItems.length ? (
            <p className="selling-note">{words("这一栏是空的", "This tab is empty")}</p>
          ) : (
            <div className="selling-slots">
              {bagItems.map((item) => {
                const on = Boolean(plan.lines[item.key]);
                const npc = npcSell.get(item.item_id);
                return (
                  <button
                    key={item.key}
                    type="button"
                    className={"selling-slot" + (on ? " on" : "")}
                    aria-pressed={on}
                    title={[
                      name(item.item_id),
                      item.piece ? summary(item.piece) : "",
                      npc != null ? words("NPC 回收 ", "NPC ") + n(npc) : "",
                    ]
                      .filter(Boolean)
                      .join(" · ")}
                    aria-label={name(item.item_id)}
                    data-selling-item={item.key}
                    onClick={() => toggle(item.key)}
                  >
                    <Slot url={icon(item.item_id)} size={32} />
                    {!item.piece && <span className="selling-qty">{item.quantity.toLocaleString()}</span>}
                  </button>
                );
              })}
            </div>
          )}
          <div className="selling-bagfoot">
            <span>
              {words("金币", "Mesos")} <b>{n(holdings?.mesos)}</b>
            </span>
            {bagItems.length > 0 && (
              <button type="button" className="btn" onClick={selectPriced}>
                {words("选中本栏有成交的", "Select items with sales")}
              </button>
            )}
          </div>
        </section>

        <section className="stall selling-plan" data-selling-plan>
          <div className="stall-bar">
            <h2>{words("摆摊清单", "Listing")}</h2>
            <span className="bar-meta">{rows.length ? words(`${rows.length} 种`, `${rows.length} items`) : ""}</span>
          </div>
          <div className="selling-strat">
            <span>{words("统一定价", "Price all")}</span>
            <div className="selling-seg" role="radiogroup">
              {(["s25", "s50"] as const).map((key) => (
                <button
                  key={key}
                  type="button"
                  role="radio"
                  aria-checked={plan.global === key}
                  className={plan.global === key ? "on" : ""}
                  onClick={() => setGlobal(key)}
                >
                  {key === "s25" ? words("成交 25%", "Sold 25%") : words("成交中位", "Sold median")}
                </button>
              ))}
            </div>
          </div>
          {!rows.length && <p className="selling-empty">{words("在背包里点选要卖的物品", "Pick items from your bag")}</p>}
          {rows.map((r) => (
            <div className={"selling-row" + (r.warn ? " bad" : "")} key={r.key} data-selling-row={r.key}>
              <div className="selling-who">
                <Slot url={icon(r.id)} size={32} />
                <div>
                  <b>{name(r.id)}</b>
                  {r.piece && <small className="selling-stats" data-selling-stats>{summary(r.piece)}</small>}
                  <small>
                    {r.isGear ? words("装备栏", "Equip tab") : `${words("背包", "Held")} ${r.quantity.toLocaleString()}`}
                    {" · "}
                    {basisText(r)}
                  </small>
                </div>
                <button type="button" className="selling-x" onClick={() => toggle(r.key)} aria-label={words("移出清单", "Remove")}>
                  ×
                </button>
              </div>
              <div className="selling-prices" role="radiogroup" aria-label={words("单价", "Unit price")}>
                {(["s25", "s50"] as const).map((key) => (
                  <button
                    key={key}
                    type="button"
                    role="radio"
                    aria-checked={r.strat === key}
                    disabled={r.prices[key] == null}
                    className={r.strat === key ? "on" : ""}
                    onClick={() => update(r.key, { strat: key })}
                  >
                    <small>{key === "s25" ? words("成交 25%", "Sold 25%") : words("成交中位", "Sold median")}</small>
                    <span>{r.prices[key] == null ? words("无数据", "No data") : n(r.prices[key])}</span>
                  </button>
                ))}
                <label className={r.strat === "manual" ? "on" : ""}>
                  <small>{words("手动", "Manual")}</small>
                  <input
                    inputMode="numeric"
                    placeholder={words("输入单价", "Unit price")}
                    value={r.line.manual}
                    onFocus={() => r.line.manual && update(r.key, { strat: "manual" })}
                    onChange={(e) => update(r.key, { strat: "manual", manual: e.target.value.replace(/\D/g, "").slice(0, 10) })}
                  />
                </label>
                <div className={"selling-npc" + (r.belowNpc ? " low" : "")} data-selling-npc>
                  <small>{words("NPC 回收", "NPC buys")}</small>
                  <span>{n(r.npc)}</span>
                </div>
                {r.belowNpc && <small className="selling-warn">{words("不高于 NPC 回收价，直接卖 NPC 更划算", "Not above the NPC price; sell to the NPC")}</small>}
              </div>
              {r.isGear ? (
                <div className="selling-amount">
                  <small>{words("1 件", "1 piece")}</small>
                </div>
              ) : (
                <div className="selling-amount">
                  <label>
                    {words("每组", "Per lot")}
                    <input
                      inputMode="numeric"
                      value={r.line.bundle}
                      aria-label={words("每组数量", "Per lot")}
                      onChange={(e) => update(r.key, { bundle: Math.max(1, Number(e.target.value.replace(/\D/g, "").slice(0, 5)) || 1) })}
                    />
                  </label>
                  <div className="selling-step">
                    <button type="button" onClick={() => update(r.key, { groups: Math.max(1, r.line.groups - 1) })} aria-label={words("少一组", "One lot less")}>
                      −
                    </button>
                    <b>{r.line.groups}</b>
                    <button type="button" onClick={() => update(r.key, { groups: r.line.groups + 1 })} aria-label={words("多一组", "One lot more")}>
                      +
                    </button>
                    {words("组", "lots")}
                  </div>
                  <small>
                    {words("共", "Total")} {r.selling.toLocaleString()} / {r.quantity.toLocaleString()}
                  </small>
                </div>
              )}
              <div className="selling-total">
                {!r.isGear && <small>{words("每组", "Per lot")} {r.unit == null ? "—" : n(r.unit * r.bundle)}</small>}
                <b>{n(r.total)}</b>
                {r.warn && <small className="selling-warn">{r.warn}</small>}
              </div>
            </div>
          ))}
          <div className="selling-foot">
            <div>
              <small>{words("预计收入（未扣税）", "Expected income (before tax)")}</small>
              <b data-selling-total>{grand ? n(grand) : "—"}</b>
            </div>
            <small>
              {words(`占摊位 ${slots} 格`, `${slots} shop slots`)}
              <br />
              {words("全卖 NPC ", "All to NPC ")}
              {npcTotal ? n(npcTotal) : "—"}
            </small>
            <span className="grow" />
            {rows.length > 0 && (
              <>
                <button type="button" className="btn" onClick={() => setPlan((p) => ({ ...p, order: [], lines: {} }))}>
                  {words("清空", "Clear")}
                </button>
                <button
                  type="button"
                  className="btn primary"
                  onClick={() => void navigator.clipboard?.writeText(copyText()).catch(() => {})}
                >
                  {words("复制价目表", "Copy price list")}
                </button>
              </>
            )}
          </div>
        </section>
      </div>
    </div>
  );
}

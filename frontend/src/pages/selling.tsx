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
import { embedded, embeddedHost, embeddedLocal } from "../lib/embed";
import { mainStat } from "../lib/item-market";
import { useAccount } from "../lib/query";
import type { Device, EquipmentPiece, Holdings } from "../lib/sweep-labels";
import "./selling.css";

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
/** 上次读到的背包：游戏断开后页面仍可用。 */
const BAG_KEY = "selling.bag.v1";
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
const isGearKey = (key: string) => key.startsWith("eq:");
const itemOf = (key: string) => Number(isGearKey(key) ? key.split(":")[2] : key);

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
function readBag(): Holdings | null {
  try {
    const raw = JSON.parse(localStorage.getItem(BAG_KEY) || "null");
    return raw && Array.isArray(raw.items) && Array.isArray(raw.categories) && Number(raw.observed_at) > 0 ? raw : null;
  } catch {
    return null;
  }
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
 * 清单里已不在背包的装备（没有属性）按同名全部成交。
 */
export function gearPrices(piece: EquipmentPiece | undefined, itemId: number, sales: any[] | undefined, now = Date.now() / 1000): Prices {
  const rows = (sales || []).filter(
    (s) => positive(s.sale_unit_price) && s.equipment?.status === "candidate" && Array.isArray(s.equipment.stats),
  );
  const value = (stats: { key: string; value: number }[], key: string) => stats.find((s) => s.key === key)?.value ?? 0;
  const main = mainStat(itemId);
  const known = Boolean(piece?.decoded);
  const mine = (key: string) => value(piece?.stats || [], key);
  const keys = (stats: { key: string; value: number }[]) =>
    stats.filter((s) => s.value > 0).map((s) => `${s.key}=${s.value}`).sort().join(",");
  const same = !known
    ? []
    : main
      ? rows.filter((s) => value(s.equipment.stats, main) === mine(main))
      : rows.filter((s) => keys(s.equipment.stats) === keys(piece!.stats));
  let pool = same.length ? same : rows;
  const recent = pool.filter((s) => Number(s.time) >= now - 30 * 86400);
  if (recent.length >= 3) pool = recent;
  const prices = pool.map((s) => Number(s.sale_unit_price)).sort((a, b) => a - b);
  return {
    s25: prices.length ? Math.ceil(percentile(prices, 0.25)) : null,
    s50: prices.length ? Math.ceil(percentile(prices, 0.5)) : null,
    count: prices.length,
    basis: !prices.length ? "none" : same.length ? "same" : "all",
    main: known ? main : null,
    mainValue: main ? mine(main) : undefined,
  };
}
function defaults(quantity: number): Line {
  const bundle = quantity <= 10 ? 1 : Math.min(quantity, 100);
  return { strat: null, manual: "", bundle, groups: Math.max(1, Math.floor(quantity / bundle)) };
}

/** 客户端窗口用页面消息传来的本机背包（`own=1` 的栏目）。只接受父窗口的消息，内容只用于显示。 */
function useHostBag() {
  const [bag, setBag] = useState<{ holdings: Holdings | null } | null>(null);
  useEffect(() => {
    if (!embeddedHost) return;
    const receive = (event: MessageEvent) => {
      if (event.source !== window.parent || event.data?.type !== "cwm-bag") return;
      const holdings = event.data.holdings;
      setBag({
        holdings:
          holdings && Array.isArray(holdings.items) && Array.isArray(holdings.categories) && Number(holdings.observed_at) > 0
            ? holdings
            : null,
      });
    };
    window.addEventListener("message", receive);
    window.parent.postMessage({ type: "cwm-bag-request" }, "*");
    return () => window.removeEventListener("message", receive);
  }, []);
  return bag;
}

/** 背包：客户端里由窗口传入本机背包，网页上读账号下在线设备上传的背包。 */
function useHoldings(signedIn: boolean) {
  const host = useHostBag();
  const local = useQuery({
    queryKey: ["selling-local-inventory"],
    enabled: embeddedLocal,
    refetchInterval: 5_000,
    queryFn: async ({ signal }) =>
      (await getJson("/api/v1/collector/inventory", { signal })).data as {
        holdings: Holdings | null;
      },
  });
  const devices = useQuery({
    queryKey: DEVICES_KEY,
    enabled: !embeddedLocal && !embeddedHost && signedIn,
    queryFn: ({ signal }) =>
      getAccountJson<{ devices: Device[] }>("/api/v1/account/devices", signal),
  });
  useAccountTopics(["devices"], DEVICES_KEY, !embeddedLocal && !embeddedHost && signedIn);
  if (embeddedHost)
    return {
      loading: host === null,
      sources: host?.holdings ? [{ id: "local", name: "", holdings: host.holdings }] : [],
    };
  if (embeddedLocal)
    return {
      loading: local.isLoading,
      sources: local.data?.holdings
        ? [{ id: "local", name: "", holdings: local.data.holdings }]
        : [],
    };
  const sources = (devices.data?.devices || [])
    .filter((d) => d.online && d.state?.sweep?.game?.connected !== false && d.state?.sweep?.holdings)
    .map((d) => ({ id: d.id, name: d.name, holdings: d.state!.sweep!.holdings! }));
  return { loading: devices.isLoading, sources };
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
  const signedIn = embeddedLocal || embeddedHost || Boolean(account.data?.signed_in);
  const { loading, sources } = useHoldings(signedIn);
  const [deviceId, setDeviceId] = useState("");
  const source = sources.find((s) => s.id === deviceId) || sources[0] || null;
  const live = source?.holdings || null;
  const liveJson = live ? JSON.stringify(live) : "";
  const [saved, setSaved] = useState<Holdings | null>(readBag);
  useEffect(() => {
    if (!liveJson) return;
    setSaved(JSON.parse(liveJson));
    try {
      localStorage.setItem(BAG_KEY, liveJson);
    } catch {
      /* 存不下时断线后不显示旧背包 */
    }
  }, [liveJson]);
  // 游戏断开时继续显示上次读到的背包，并标明时间。
  const holdings = live || saved;
  const stale = !live && Boolean(saved);
  const [bag, setBag] = useState(1);
  const [filter, setFilter] = useState("");
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
  const gearSales = useGearSales(plan.order.filter(isGearKey).map(itemOf));
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
      ? equipmentSummary({ item_id: piece.item_id, equipment: { ...piece, status: "candidate" } }, isEnglish()) ||
        words("无附加属性", "No bonus stats")
      : words("属性未解析", "Stats not decoded");

  type BagItem = { key: string; item_id: number; quantity: number; piece?: EquipmentPiece };
  const itemsOf = (tab: number): BagItem[] =>
    tab === 1
      ? [...gear.entries()].map(([key, piece]) => ({ key, item_id: piece.item_id, quantity: 1, piece }))
      : (holdings?.items || [])
          .filter((i) => Math.floor(i.item_id / 1_000_000) === tab && i.quantity > 0)
          .sort((a, b) => a.item_id - b.item_id)
          .map((i) => ({ key: String(i.item_id), item_id: i.item_id, quantity: i.quantity }));
  const readOf = (tab: number) =>
    tab === 1 ? Array.isArray(holdings?.equipment) : (holdings?.categories.includes(tab) ?? false);
  const bagItems = itemsOf(bag);
  const needle = filter.trim().toLowerCase();
  const shown = needle ? bagItems.filter((i) => name(i.item_id).toLowerCase().includes(needle)) : bagItems;

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
        lines: { ...p.lines, [key]: defaults(isGearKey(key) ? 1 : held.get(key) || 1) },
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
      const add = shown.filter((i) => {
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
    const isGear = isGearKey(key);
    const piece = isGear ? gear.get(key) : undefined;
    const quantity = isGear ? (piece ? 1 : 0) : (held.get(key) ?? 0);
    const prices = isGear ? gearPrices(piece, id, gearSales.get(id)) : salePrices(products.get(id));
    const chosen = line.strat || plan.global;
    // 选中的档位没有数据时，这一行改为等玩家手填。
    const strat: Strategy = chosen !== "manual" && prices[chosen] == null ? "manual" : chosen;
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
            ? words("请输入单价", "Enter a unit price")
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
  const clock = (seconds: number) => {
    const at = new Date(seconds * 1000);
    const time = at.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false });
    return at.toDateString() === new Date().toDateString() ? time : `${at.getMonth() + 1}-${at.getDate()} ${time}`;
  };

  if (!signedIn && !account.isLoading && !holdings)
    return (
      <section className="stall selling-page selling-gate">
        <div className="stall-bar">
          <h1>{words("摆摊", "Shop planner")}</h1>
        </div>
        <div className="selling-empty">
          {embedded ? (
            <p>{words("请用客户端顶部的「摆摊」栏目。", "Use the Shop tab at the top of the collector.")}</p>
          ) : (
            <>
              <p>{words("登录后读取客户端同步的背包。", "Sign in to read the inventory your collector syncs.")}</p>
              <SiteLink className="btn" href="/account">
                {words("登录", "Sign in")}
              </SiteLink>
            </>
          )}
        </div>
      </section>
    );

  return (
    <div className="selling-page">
      <div className="selling-head">
        <h1>{words("摆摊", "Shop planner")}</h1>
        <span className={"selling-src" + (live ? " on" : stale ? " stale" : "")} data-selling-source>
          <i aria-hidden="true" />
          {live
            ? words("背包更新于 ", "Bag updated ") + clock(live.observed_at)
            : stale
              ? words("游戏未连接 · 显示上次读到的背包 ", "Game not connected · showing the bag read ") + clock(saved!.observed_at)
              : loading
                ? words("正在读取背包…", "Reading bag…")
                : words("等待游戏数据：打开游戏和客户端", "Waiting for the game and collector")}
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
        <span className="selling-mesos">
          {words("金币", "Mesos")} <b>{n(holdings?.mesos)}</b>
        </span>
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
                {readOf(id) && <small>{itemsOf(id).length}</small>}
              </button>
            ))}
          </div>
          {bagItems.length > 8 && (
            <div className="selling-filter">
              <input
                type="search"
                value={filter}
                placeholder={words("筛选名称", "Filter by name")}
                aria-label={words("筛选名称", "Filter by name")}
                onChange={(e) => setFilter(e.target.value)}
              />
              <button type="button" className="btn" onClick={selectPriced}>
                {words("全选有成交的", "Select all with sales")}
              </button>
            </div>
          )}
          {!holdings ? (
            <p className="selling-note">
              {words("打开游戏和客户端，进入游戏后这里会显示背包。", "Open the game and the collector; your bag appears here once you are in game.")}
            </p>
          ) : !readOf(bag) ? (
            <p className="selling-note">
              {bag === 1
                ? words("装备栏还没读到：更新客户端后换一次频道", "Equipment not read yet: update the collector, then change channel")
                : words("这一栏还没读到", "This tab has not been read yet")}
            </p>
          ) : !shown.length ? (
            <p className="selling-note">{needle ? words("没有匹配的物品", "No matching items") : words("这一栏是空的", "This tab is empty")}</p>
          ) : (
            <ul className="selling-list">
              {shown.map((item) => {
                const on = Boolean(plan.lines[item.key]);
                const mid = item.piece ? null : salePrices(products.get(item.item_id)).s50;
                return (
                  <li key={item.key}>
                    <button
                      type="button"
                      className={on ? "on" : ""}
                      aria-pressed={on}
                      data-selling-item={item.key}
                      onClick={() => toggle(item.key)}
                    >
                      <Slot url={icon(item.item_id)} size={28} />
                      <span className="selling-item">
                        <b>{name(item.item_id)}</b>
                        <small>{item.piece ? summary(item.piece) : `× ${item.quantity.toLocaleString()}`}</small>
                      </span>
                      {mid != null && <span className="selling-ref">{n(mid)}</span>}
                      <i className="selling-tick" aria-hidden="true" />
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
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
              <Slot url={icon(r.id)} size={32} />
              <div className="selling-who">
                <b>{name(r.id)}</b>
                {r.piece && <small className="selling-stats" data-selling-stats>{summary(r.piece)}</small>}
                <small>{basisText(r)}</small>
                <small className={r.belowNpc ? "selling-warn" : ""} data-selling-npc>
                  {words("NPC 回收", "NPC buys")} {n(r.npc)}
                  {r.belowNpc && words("，直接卖 NPC 更划算", "; sell to the NPC")}
                </small>
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
              </div>
              {r.isGear ? (
                <div className="selling-amount">
                  <small>{words("1 件", "1 piece")}</small>
                </div>
              ) : (
                <div className="selling-amount">
                  <div className="selling-step">
                    <span>{words("每组", "Per lot")}</span>
                    <input
                      inputMode="numeric"
                      value={r.line.bundle}
                      aria-label={words("每组数量", "Per lot")}
                      onChange={(e) => update(r.key, { bundle: Math.max(1, Number(e.target.value.replace(/\D/g, "").slice(0, 5)) || 1) })}
                    />
                    <span>×</span>
                    <button type="button" onClick={() => update(r.key, { groups: Math.max(1, r.line.groups - 1) })} aria-label={words("少一组", "One lot less")}>
                      −
                    </button>
                    <b>{r.line.groups}</b>
                    <button type="button" onClick={() => update(r.key, { groups: r.line.groups + 1 })} aria-label={words("多一组", "One lot more")}>
                      +
                    </button>
                    <span>{words("组", "lots")}</span>
                  </div>
                  <small>
                    {words("共", "Total")} {r.selling.toLocaleString()} / {r.quantity.toLocaleString()}
                  </small>
                </div>
              )}
              <div className="selling-total">
                <b>{n(r.total)}</b>
                {!r.isGear && r.unit != null && <small>{words("每组", "Per lot")} {n(r.unit * r.bundle)}</small>}
                {r.warn && <small className="selling-warn">{r.warn}</small>}
              </div>
              <button type="button" className="selling-x" onClick={() => toggle(r.key)} aria-label={words("移出清单", "Remove")}>
                ×
              </button>
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

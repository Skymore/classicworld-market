import { useEffect, useMemo, useState } from "react";
import { ItemLink } from "../components/item-ref";
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
import { keyStats } from "../lib/item-market";
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
  /** 装备：same 同关键属性 / all 同名全部 / none。 */
  basis?: "same" | "all" | "none";
  /** 装备：72 小时内，或能拿到的全部成交。 */
  window?: "72h" | "all";
  /** 装备没有够数的同属性成交时，关键属性在同名已知属性里的排位（0 最差、1 最好）和参与比较的件数。 */
  rank?: { q: number; n: number };
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

/** 市场接口的职业名（`jobs`）换回 `req_job_mask`。 */
const JOB_BITS: Record<string, number> = { 战士: 1, 魔法师: 2, 弓箭手: 4, 飞侠: 8, 海盗: 16 };
export function jobMaskOf(jobs: unknown): number | null {
  if (!Array.isArray(jobs) || !jobs.length || !jobs.every((job) => job in JOB_BITS)) return null;
  return jobs.reduce((mask: number, job: string) => mask | JOB_BITS[job], 0);
}

/** 关键属性的综合分：物攻、魔攻按 3 倍计，主副属性和暴击按 1 倍计。 */
const RANK_WEIGHT: Record<string, number> = { weapon_attack: 3, magic_attack: 3 };
/** 至少这么多件带属性的同名装备（成交加在售）才按属性排位定价。 */
export const RANK_MIN = 5;

/**
 * 一件装备的参考价：72 小时内关键属性（可用职业的主副属性、物攻魔攻、暴击）和剩余升级次数
 * 都相同的成交够 3 笔就用它们；防御、HP 等不影响。不够时用 72 小时内同名全部成交（含没解析
 * 属性的），仍不够 3 笔就用能拿到的同名全部成交。用同名成交时，按这件装备的关键属性在同名
 * 带属性的成交和在售里排第几，取成交价的对应分位：排位 q 的中位取 q 分位、25% 取 q/2 分位，
 * 属性居中时就是普通的中位和 25%。q 限制在 5%–95%，避免取到最高最低的个别价。
 */
export function gearPrices(
  piece: EquipmentPiece | undefined,
  market: { sales?: any[]; listings?: any[] } | undefined,
  jobMask: number | null = null,
  now = Date.now() / 1000,
): Prices {
  const rows = (market?.sales || []).filter((s) => positive(s.sale_unit_price));
  const value = (stats: { key: string; value: number }[], key: string) => stats.find((s) => s.key === key)?.value ?? 0;
  const wanted = keyStats(jobMask);
  const signature = (equipment: { stats: { key: string; value: number }[]; remaining_upgrades?: number | null }) =>
    JSON.stringify([wanted.map((key) => value(equipment.stats, key)), equipment.remaining_upgrades ?? null]);
  const decoded = (e: any) => e?.status === "candidate" && Array.isArray(e.stats);
  const recent = rows.filter((s) => Number(s.time) >= now - 72 * 3600);
  const same = !piece?.decoded
    ? []
    : recent.filter((s) => decoded(s.equipment) && signature(s.equipment) === signature(piece));
  const [pool, basis, window]: [any[], Prices["basis"], Prices["window"]] =
    same.length >= 3 ? [same, "same", "72h"] : recent.length >= 3 ? [recent, "all", "72h"] : [rows, "all", "all"];
  const prices = pool.map((s) => Number(s.sale_unit_price)).sort((a, b) => a - b);
  let rank: Prices["rank"];
  if (basis === "all" && piece?.decoded && prices.length) {
    const score = (stats: { key: string; value: number }[]) =>
      wanted.reduce((sum, key) => sum + value(stats, key) * (RANK_WEIGHT[key] ?? 1), 0);
    const known = [...(market?.sales || []), ...(market?.listings || [])].map((r) => r.equipment).filter(decoded);
    const sameSlots = known.filter((e) => (e.remaining_upgrades ?? null) === (piece.remaining_upgrades ?? null));
    const peers = sameSlots.length >= RANK_MIN ? sameSlots : known;
    if (peers.length >= RANK_MIN) {
      const mine = score(piece.stats);
      const below = peers.filter((e) => score(e.stats) < mine).length;
      const equal = peers.filter((e) => score(e.stats) === mine).length;
      rank = { q: (below + equal / 2) / peers.length, n: peers.length };
    }
  }
  const q = rank ? Math.min(0.95, Math.max(0.05, rank.q)) : 0.5;
  return {
    s25: prices.length ? Math.ceil(percentile(prices, q / 2)) : null,
    s50: prices.length ? Math.ceil(percentile(prices, q)) : null,
    count: prices.length,
    basis: prices.length ? basis : "none",
    window,
    rank,
  };
}
/**
 * 摆摊还是卖 NPC，按成交中位比 NPC 回收价的倍数和这批（数量 × 差价）多赚的金币：
 * 不到 1.1 倍或多赚不到 2,000 卖 NPC；不到 1.5 倍或多赚不到 10,000 差不多；否则摆摊。NPC 不收只能摆摊。
 */
export type Verdict = "stall" | "close" | "npc" | "only" | "none";
export const NPC_GAIN_MAX = 2_000;
export const STALL_GAIN_MIN = 10_000;
export function verdict(mid: number | null, npc: number | null, quantity = 1): Verdict {
  if (mid == null) return "none";
  if (npc == null || npc <= 0) return "only";
  const gain = (mid - npc) * Math.max(1, quantity);
  if (mid <= npc * 1.1 || gain < NPC_GAIN_MAX) return "npc";
  if (mid <= npc * 1.5 || gain < STALL_GAIN_MIN) return "close";
  return "stall";
}
const signed = (value: number) => (value > 0 ? "+" : value < 0 ? "−" : "±") + Math.abs(Math.round(value)).toLocaleString("en-US");

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
  return new Map<number, { sales?: any[]; listings?: any[]; jobs?: string[] }>(
    unique.map((id, i) => {
      const data = results[i].data as any;
      return [id, { sales: data?.sales, listings: data?.listings, jobs: data?.product?.jobs }];
    }),
  );
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
  const gearSales = useGearSales([...plan.order.filter(isGearKey).map(itemOf), ...[...gear.values()].map((p) => p.item_id)]);
  const rowOf = useItemRows(
    allIds.filter((id) => !products.has(id)),
    products,
  );
  const name = (id: number) => {
    const row = rowOf(id);
    return row ? itemName(row) : String(id);
  };
  const icon = (id: number) => rowOf(id)?.icon_url as string | undefined;
  const jobMask = (id: number) => jobMaskOf(gearSales.get(id)?.jobs ?? rowOf(id)?.jobs);
  /** 只列关键属性（可用职业的主副属性、物攻魔攻、暴击）和剩余升级次数。 */
  const summary = (piece: EquipmentPiece) => {
    if (!piece.decoded) return words("属性未解析", "Stats not decoded");
    const wanted = keyStats(jobMask(piece.item_id));
    const stats = (piece.stats || []).filter((s) => wanted.includes(s.key));
    return (
      equipmentSummary({ item_id: piece.item_id, equipment: { ...piece, stats, status: "candidate" } }, isEnglish()) ||
      words("无关键属性", "No key stats")
    );
  };

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
    const prices = isGear ? gearPrices(piece, gearSales.get(id), jobMask(id)) : salePrices(products.get(id));
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
    const vd = verdict(prices.s50, npc, selling);
    // 按选中的单价，这一行摆摊比卖 NPC 多赚多少。
    const gain = total != null && npc != null ? total - npc * selling : null;
    return { key, id, piece, isGear, line, bundle, groups, quantity, prices, strat, unit, selling, warn, total, npc, vd, gain };
  });
  const VD_LABEL: Record<Verdict, [string, string]> = {
    stall: ["摆摊", "Stall"],
    close: ["差不多", "Close"],
    npc: ["卖 NPC", "NPC"],
    only: ["摆摊", "Stall"],
    none: ["", ""],
  };
  const badge = (vd: Verdict) =>
    vd === "none" ? null : (
      <i className={"selling-vd vd-" + vd} data-selling-verdict={vd}>
        {words(...VD_LABEL[vd])}
      </i>
    );
  const tally = { stall: 0, close: 0, npc: 0 };
  for (const r of rows) if (r.vd === "stall" || r.vd === "only") tally.stall++;
    else if (r.vd === "close" || r.vd === "npc") tally[r.vd]++;
  const basisText = (r: (typeof rows)[number]) => {
    const p = r.prices;
    if (!r.isGear)
      return p.count
        ? words(`72h ${p.count} 笔`, `72h ${p.count} sales`)
        : p.recent
          ? words("72h 无成交，按最近成交", "None in 72h; recent sales")
          : words("无成交", "No sales");
    const span = p.window === "72h" ? "72h " : "";
    if (p.basis === "same") return words(`同属性 · ${span}${p.count} 笔`, `Same stats · ${span}${p.count} sales`);
    if (p.basis === "all") {
      const base = words(`同名 · ${span}${p.count} 笔`, `Same item · ${span}${p.count} sales`);
      if (!p.rank) return base;
      const pct = Math.round(p.rank.q * 100);
      return pct < 50
        ? words(`${base} · 属性低于 ${100 - pct}% 同名`, `${base} · stats below ${100 - pct}%`)
        : words(`${base} · 属性高于 ${pct}% 同名`, `${base} · stats above ${pct}%`);
    }
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
                const mid = (
                  item.piece
                    ? gearPrices(item.piece, gearSales.get(item.item_id), jobMask(item.item_id))
                    : salePrices(products.get(item.item_id))
                ).s50;
                const npc = npcSell.get(item.item_id) ?? null;
                const vd = verdict(mid, npc, item.quantity);
                const gain = mid != null && npc != null ? (mid - npc) * item.quantity : null;
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
                      {mid != null && (
                        <span className="selling-ref">
                          {badge(vd)}
                          {gain == null ? n(mid) : <b className={"selling-gain vd-" + vd}>{signed(gain)}</b>}
                        </span>
                      )}
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
            <span className="grow" />
              {rows.length > 0 && (
                <span className="selling-tally" data-selling-tally>
                  {badge("stall")} {tally.stall}
                  {badge("close")} {tally.close}
                  {badge("npc")} {tally.npc}
                  {tally.npc > 0 && (
                    <button
                      type="button"
                      className="selling-drop"
                      onClick={() =>
                        setPlan((p) => {
                          const drop = new Set(rows.filter((r) => r.vd === "npc").map((r) => r.key));
                          const lines = Object.fromEntries(Object.entries(p.lines).filter(([key]) => !drop.has(key)));
                          return { ...p, lines, order: p.order.filter((key) => !drop.has(key)) };
                        })
                      }
                    >
                      {words("移出卖 NPC 的", "Remove NPC items")}
                    </button>
                  )}
                </span>
              )}
          </div>
          {!rows.length && <p className="selling-empty">{words("在背包里点选要卖的物品", "Pick items from your bag")}</p>}
          {rows.map((r) => (
            <div className={"selling-row" + (r.isGear ? " gear" : "") + (r.warn ? " bad" : "")} key={r.key} data-selling-row={r.key}>
              <ItemLink id={r.id} className="selling-icon">
                <Slot url={icon(r.id)} size={32} />
              </ItemLink>
              <div className="selling-who">
                <b>
                  <ItemLink id={r.id}>{name(r.id)}</ItemLink>
                </b>
                {r.piece && <small className="selling-stats" data-selling-stats>{summary(r.piece)}</small>}
                <small>{basisText(r)}</small>
                <small className="selling-vs" data-selling-npc>
                  {badge(r.vd)}
                  {r.npc == null
                    ? words("NPC 不收", "NPC won't buy")
                    : [
                        words("NPC ", "NPC ") + n(r.npc),
                        ...(["s50", "s25"] as const)
                          .filter((key) => r.prices[key] != null)
                          .map(
                            (key) =>
                              (key === "s50" ? words("中位 ", "Median ") : "25% ") + signed(r.prices[key]! - r.npc!),
                          ),
                      ].join(" · ")}
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
                    <span>{r.prices[key] == null ? "—" : n(r.prices[key])}</span>
                  </button>
                ))}
                <label className={r.strat === "manual" ? "on" : ""}>
                  <small>{words("手动", "Manual")}</small>
                  <input
                    inputMode="numeric"
                    placeholder={words("单价", "Price")}
                    value={r.line.manual}
                    onFocus={() => r.line.manual && update(r.key, { strat: "manual" })}
                    onChange={(e) => update(r.key, { strat: "manual", manual: e.target.value.replace(/\D/g, "").slice(0, 10) })}
                  />
                </label>
              </div>
              {!r.isGear && (
                <div className="selling-amount">
                  <div className="selling-step">
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
                {r.gain != null && (
                  <small className={"selling-gain " + (r.gain > 0 ? "up" : "down")} data-selling-gain>
                    {words("比 NPC ", "vs NPC ")}
                    {signed(r.gain)}
                  </small>
                )}
                {r.warn ? (
                  <small className="selling-warn">{r.warn}</small>
                ) : (
                  !r.isGear && r.unit != null && <small>{words("每组", "Per lot")} {n(r.unit * r.bundle)}</small>
                )}
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
            {grand > 0 && (
              <div className={"selling-gainbox " + (grand - npcTotal > 0 ? "up" : "down")}>
                <small>{words("比全卖 NPC 多赚", "More than selling all to NPC")}</small>
                <b data-selling-gain-total>{signed(grand - npcTotal)}</b>
              </div>
            )}
            <small>
              {words(`占摊位 ${slots} 格`, `${slots} shop slots`)}
              <br />
              {words("全卖 NPC ", "All to NPC ")}
              {grand ? n(npcTotal) : "—"}
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

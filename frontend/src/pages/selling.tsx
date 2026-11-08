import { useEffect, useMemo, useState } from "react";
import { useQueries, useQuery } from "@tanstack/react-query";
import { getJson } from "/web/js/lib/api.js?v=20261022-auto-watch-2";
import { itemName } from "/web/js/lib/i18n.js";
import { useWords } from "../providers";
import { Slot, usePageReady } from "../components/shared";
import { SiteLink } from "../components/shell";
import { useItemRows } from "../components/sweep-content";
import { getAccountJson, useAccountTopics } from "../lib/account-api";
import { embedded } from "../lib/embed";
import { useAccount } from "../lib/query";
import type { Device, Holdings } from "../lib/sweep-labels";
import "./selling.css";

/** 成交 25% 分位、成交中位，或玩家手填。 */
type Strategy = "s25" | "s50" | "manual";
interface Line {
  strat: Strategy | null;
  manual: string;
  bundle: number;
  groups: number;
}
interface Plan {
  global: "s25" | "s50";
  order: number[];
  lines: Record<string, Line>;
}
const PLAN_KEY = "selling.plan.v1";
const BAGS: [number, string, string][] = [
  [2, "消耗", "Use"],
  [3, "设置", "Set-up"],
  [4, "其他", "Etc"],
  [1, "装备", "Equip"],
];
const DEVICES_KEY = ["selling-devices"] as const;

function readPlan(): Plan {
  try {
    const raw = JSON.parse(localStorage.getItem(PLAN_KEY) || "null");
    if (raw && Array.isArray(raw.order) && raw.lines && typeof raw.lines === "object")
      return {
        global: raw.global === "s25" ? "s25" : "s50",
        order: raw.order.filter((id: unknown) => Number.isSafeInteger(id) && raw.lines[String(id)]),
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

/** 72 小时成交价；没有成交时退到最近几笔成交。价格向上取整成整数金币。 */
export function salePrices(product: any) {
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
function defaults(quantity: number): Line {
  const bundle = quantity <= 10 ? 1 : Math.min(quantity, 100);
  return { strat: null, manual: "", bundle, groups: Math.max(1, Math.floor(quantity / bundle)) };
}

/** 背包：客户端里读本机，网页上读账号下在线设备上传的背包。 */
function useHoldings(signedIn: boolean) {
  const local = useQuery({
    queryKey: ["selling-local-inventory"],
    enabled: embedded,
    refetchInterval: 5_000,
    queryFn: async ({ signal }) =>
      (await getJson("/api/v1/collector/inventory", { signal })).data as {
        holdings: Holdings | null;
      },
  });
  const devices = useQuery({
    queryKey: DEVICES_KEY,
    enabled: !embedded && signedIn,
    queryFn: ({ signal }) =>
      getAccountJson<{ devices: Device[] }>("/api/v1/account/devices", signal),
  });
  useAccountTopics(["devices"], DEVICES_KEY, !embedded && signedIn);
  if (embedded)
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

export default function Selling() {
  usePageReady();
  const words = useWords();
  const account = useAccount();
  const signedIn = embedded || Boolean(account.data?.signed_in);
  const { loading, sources } = useHoldings(signedIn);
  const [deviceId, setDeviceId] = useState("");
  const source = sources.find((s) => s.id === deviceId) || sources[0] || null;
  const holdings = source?.holdings || null;
  const [bag, setBag] = useState(2);
  const [plan, setPlan] = useState<Plan>(readPlan);
  useEffect(() => {
    try {
      localStorage.setItem(PLAN_KEY, JSON.stringify(plan));
    } catch {
      /* 存不下时只在本页有效 */
    }
  }, [plan]);

  const held = useMemo(() => {
    const map = new Map<number, number>();
    for (const item of holdings?.items || []) map.set(item.item_id, item.quantity);
    return map;
  }, [holdings]);
  const allIds = [...new Set([...held.keys(), ...plan.order])];
  const products = useProducts(allIds);
  const npcSell = useNpcSell(allIds);
  const rowOf = useItemRows(
    allIds.filter((id) => !products.has(id)),
    products,
  );
  const name = (id: number) => {
    const row = rowOf(id);
    return row ? itemName(row) : String(id);
  };
  const icon = (id: number) => rowOf(id)?.icon_url as string | undefined;

  const bagItems = (holdings?.items || [])
    .filter((i) => Math.floor(i.item_id / 1_000_000) === bag && i.quantity > 0)
    .sort((a, b) => a.item_id - b.item_id);
  const bagRead = holdings?.categories.includes(bag) ?? false;

  const update = (id: number, change: Partial<Line>) =>
    setPlan((p) => ({ ...p, lines: { ...p.lines, [id]: { ...p.lines[id], ...change } } }));
  const toggle = (id: number) =>
    setPlan((p) => {
      if (p.lines[id]) {
        const lines = { ...p.lines };
        delete lines[id];
        return { ...p, lines, order: p.order.filter((x) => x !== id) };
      }
      return {
        ...p,
        lines: { ...p.lines, [id]: defaults(held.get(id) || 1) },
        order: [...p.order, id],
      };
    });
  const setGlobal = (global: "s25" | "s50") =>
    setPlan((p) => ({
      global,
      order: p.order,
      lines: Object.fromEntries(
        Object.entries(p.lines).map(([id, line]) => [id, { ...line, strat: line.strat === "manual" ? "manual" : null }]),
      ),
    }));
  const selectPriced = () =>
    setPlan((p) => {
      const add = bagItems.filter((i) => !p.lines[i.item_id] && salePrices(products.get(i.item_id)).s50 != null);
      return {
        ...p,
        order: [...p.order, ...add.map((i) => i.item_id)],
        lines: { ...p.lines, ...Object.fromEntries(add.map((i) => [i.item_id, defaults(i.quantity)])) },
      };
    });

  let grand = 0,
    slots = 0,
    npcTotal = 0;
  const rows = plan.order.map((id) => {
    const line = plan.lines[id];
    const quantity = held.get(id) ?? 0;
    const prices = salePrices(products.get(id));
    const strat = line.strat || plan.global;
    const unit = strat === "manual" ? Number(line.manual) || null : prices[strat];
    const selling = line.bundle * line.groups;
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
      slots += line.groups;
      npcTotal += (npc ?? 0) * selling;
    }
    // 摆摊价不高于 NPC 回收价时，直接卖给 NPC 更划算。
    const belowNpc = npc != null && unit != null && unit <= npc;
    return { id, line, quantity, prices, strat, unit, selling, warn, total, npc, belowNpc };
  });

  const copyText = () =>
    rows
      .filter((r) => r.total != null)
      .map((r) => `${name(r.id)}  ${n(r.unit)} × ${r.line.bundle} × ${r.line.groups}${words("组", " lots")}`)
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
          {bag === 1 ? (
            <p className="selling-note">{words("装备要比对属性，暂不支持。", "Equipment needs stat comparison; not supported yet.")}</p>
          ) : !holdings ? (
            <p className="selling-note">{words("没有背包数据", "No bag data")}</p>
          ) : !bagRead ? (
            <p className="selling-note">{words("这一栏还没读到", "This tab has not been read yet")}</p>
          ) : !bagItems.length ? (
            <p className="selling-note">{words("这一栏是空的", "This tab is empty")}</p>
          ) : (
            <div className="selling-slots">
              {bagItems.map((item) => {
                const on = Boolean(plan.lines[item.item_id]);
                return (
                  <button
                    key={item.item_id}
                    type="button"
                    className={"selling-slot" + (on ? " on" : "")}
                    aria-pressed={on}
                    title={
                      name(item.item_id) +
                      (npcSell.has(item.item_id) ? words(" · NPC 回收 ", " · NPC ") + n(npcSell.get(item.item_id)) : "")
                    }
                    aria-label={name(item.item_id)}
                    data-selling-item={item.item_id}
                    onClick={() => toggle(item.item_id)}
                  >
                    <Slot url={icon(item.item_id)} size={32} />
                    <span className="selling-qty">{item.quantity.toLocaleString()}</span>
                  </button>
                );
              })}
            </div>
          )}
          <div className="selling-bagfoot">
            <span>
              {words("金币", "Mesos")} <b>{n(holdings?.mesos)}</b>
            </span>
            {bag !== 1 && bagItems.length > 0 && (
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
            <span>{words("统一定价 · 近 72 小时", "Price all · last 72 h")}</span>
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
            <div className={"selling-row" + (r.warn ? " bad" : "")} key={r.id} data-selling-row={r.id}>
              <div className="selling-who">
                <Slot url={icon(r.id)} size={32} />
                <div>
                  <b>{name(r.id)}</b>
                  <small>
                    {words("背包", "Held")} {r.quantity.toLocaleString()}
                    {" · "}
                    {r.prices.count
                      ? words(`成交 ${r.prices.count} 笔`, `${r.prices.count} sales`)
                      : r.prices.recent
                        ? words("72 小时无成交，按最近成交", "No sales in 72 h; recent sales")
                        : words("无成交", "No sales")}
                  </small>
                </div>
                <button type="button" className="selling-x" onClick={() => toggle(r.id)} aria-label={words("移出清单", "Remove")}>
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
                    onClick={() => update(r.id, { strat: key })}
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
                    onFocus={() => r.line.manual && update(r.id, { strat: "manual" })}
                    onChange={(e) => update(r.id, { strat: "manual", manual: e.target.value.replace(/\D/g, "").slice(0, 10) })}
                  />
                </label>
                <div className={"selling-npc" + (r.belowNpc ? " low" : "")} data-selling-npc>
                  <small>{words("NPC 回收", "NPC buys")}</small>
                  <span>{n(r.npc)}</span>
                </div>
                {r.belowNpc && <small className="selling-warn">{words("不高于 NPC 回收价，直接卖 NPC 更划算", "Not above the NPC price; sell to the NPC")}</small>}
              </div>
              <div className="selling-amount">
                <label>
                  {words("每组", "Per lot")}
                  <input
                    inputMode="numeric"
                    value={r.line.bundle}
                    aria-label={words("每组数量", "Per lot")}
                    onChange={(e) => update(r.id, { bundle: Math.max(1, Number(e.target.value.replace(/\D/g, "").slice(0, 5)) || 1) })}
                  />
                </label>
                <div className="selling-step">
                  <button type="button" onClick={() => update(r.id, { groups: Math.max(1, r.line.groups - 1) })} aria-label={words("少一组", "One lot less")}>
                    −
                  </button>
                  <b>{r.line.groups}</b>
                  <button type="button" onClick={() => update(r.id, { groups: r.line.groups + 1 })} aria-label={words("多一组", "One lot more")}>
                    +
                  </button>
                  {words("组", "lots")}
                </div>
                <small>
                  {words("共", "Total")} {r.selling.toLocaleString()} / {r.quantity.toLocaleString()}
                </small>
              </div>
              <div className="selling-total">
                <small>{words("每组", "Per lot")} {r.unit == null ? "—" : n(r.unit * r.line.bundle)}</small>
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

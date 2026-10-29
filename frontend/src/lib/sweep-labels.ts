// Shapes and short labels from SWEEP.md, shared by the site and the desktop shell.
// No imports: the desktop build bundles this file on its own.
export type Words = (zh: string, en: string) => string;

export interface Holdings {
  observed_at: number;
  mesos: number | null;
  categories: number[];
  items: {item_id: number; quantity: number}[];
}
export interface SweepWatch { item_id: number; limit: number; groups: any[] }
export interface DeviceState {
  client_version?: string;
  sweep?: {
    holdings?: Holdings | null;
    allow_web_start?: boolean;
    max_spend?: number;
    max_order?: number;
    reserve_mesos?: number;
    executor?: { ready?: boolean; reason?: string };
  };
}
export interface Device {
  id: string;
  name: string;
  created_at?: string;
  last_seen_at?: string | null;
  online: boolean;
  client_version?: string | null;
  state: DeviceState | null;
}
export interface RunDevice {
  id: string;
  name: string;
  state: string;
  message?: string | null;
  online: boolean;
  spent: number;
}
export interface Purchase {
  id: string;
  device?: string;
  item_id: number;
  status: string;
  quantity: number;
  units: number;
  price?: number;
  spent: number;
  reason?: string | null;
  room?: number | null;
  channel?: number | null;
  owner?: string | null;
  created_at?: string;
}
export interface Run {
  id: string;
  status: "running" | "stopped" | "finished";
  stop_reason?: string | null;
  budget: number;
  spent: number;
  reserved: number;
  unknown: number;
  remaining: number;
  started_at?: string;
  ends_at: string;
  started_by: string;
  plan_version: number;
  plan_stale: boolean;
  plan?: {watches: SweepWatch[]};
  devices: RunDevice[];
  purchases: Purchase[];
}
export interface SweepState {
  run: Run | null;
  devices: Device[];
}

/** Why a device cannot join a sweep started on the website, or null. */
export function deviceBlocker(device: Device, words: Words) {
  if (!device.online) return words("离线", "Offline");
  const sweep = device.state?.sweep;
  if (!sweep) return words("未上报状态", "No status");
  if (!sweep.executor?.ready)
    return sweep.executor?.reason || words("不能扫货", "Cannot sweep");
  if (!sweep.allow_web_start) return words("未允许网页启动", "Web start off");
  return null;
}
export function executorLabel(state: DeviceState | null, words: Words) {
  const executor = state?.sweep?.executor;
  if (!executor) return words("未上报状态", "No status");
  return executor.ready
    ? words("可以扫货", "Can sweep")
    : executor.reason || words("不能扫货", "Cannot sweep");
}

const REASONS: Record<string, [string, string]> = {
  sold_out: ["已售完", "Sold out"],
  price_changed: ["价格变了", "Price changed"],
  not_enough_mesos: ["金币不足", "Not enough mesos"],
  inventory_full: ["背包满了", "Inventory full"],
  trade_locked: ["游戏账号尚未解锁交易", "Game trading is locked"],
  shop_closed: ["商店已关", "Shop closed"],
  window_lost: ["窗口丢失", "Window lost"],
  timeout: ["超时", "Timed out"],
  error: ["出错", "Error"],
  budget: ["预算不足", "Budget"],
  item_limit: ["已到数量上限", "Quantity limit"],
  duplicate: ["已处理过", "Already handled"],
  stopped: ["已停止", "Stopped"],
  max_spend: ["本机额度用完", "Device limit"],
  max_order: ["超过单笔上限", "Over order cap"],
  reserve_mesos: ["要保留金币", "Mesos reserve"],
};
export function reasonLabel(reason: string | null | undefined, words: Words) {
  if (!reason) return "";
  const known = REASONS[reason];
  return known ? words(...known) : reason;
}
export function purchaseLabel(
  purchase: Pick<Purchase, "status" | "reason">,
  words: Words,
) {
  switch (purchase.status) {
    case "bought":
      return words("已买", "Bought");
    case "not_bought":
    case "skipped":
      return [words("未买", "Not bought"), reasonLabel(purchase.reason, words)]
        .filter(Boolean)
        .join(" · ");
    case "held":
      return words("处理中", "In progress");
    default:
      return words("结果未知，请到游戏里核对", "Unknown, check in game");
  }
}
export function stopReasonLabel(reason: string | null | undefined, words: Words) {
  if (reason === "time_up") return words("时间到", "Time up");
  if (reason === "budget_spent") return words("预算用完", "Budget spent");
  return words("已停止", "Stopped");
}
export function participantLabel(state: string | null | undefined, words: Words) {
  const labels: Record<string, [string, string]> = {
    invited: ["等待加入", "Invited"],
    active: ["扫货中", "Sweeping"],
    refused: ["已拒绝", "Refused"],
    left: ["已离开", "Left"],
  };
  return state && labels[state] ? words(...labels[state]) : state || "—";
}
/** FM room · CH channel · owner, skipping unknown parts. */
export function purchasePlace(purchase: Pick<Purchase, "room" | "channel" | "owner">) {
  return [
    purchase.room != null && `FM ${purchase.room}`,
    purchase.channel != null && `CH ${purchase.channel}`,
    purchase.owner,
  ]
    .filter(Boolean)
    .join(" · ");
}
/** Clock time; earlier or later days also show the date. Numbers are epoch seconds. */
export function clockTime(at: string | number | null | undefined, english = false) {
  if (at == null || at === "") return "—";
  const date = new Date(typeof at === "number" ? (at > 1e12 ? at : at * 1000) : at);
  if (Number.isNaN(date.getTime())) return "—";
  const locale = english ? "en-US" : "zh-CN";
  const time = date.toLocaleTimeString(locale, { hour: "2-digit", minute: "2-digit", hour12: false });
  return date.toDateString() === new Date().toDateString()
    ? time
    : `${date.getMonth() + 1}/${date.getDate()} ${time}`;
}
/** Mesos in K / M, as web/js/lib/format.js `meso` (the desktop cannot load that module). */
export function mesos(value: number | null | undefined) {
  if (value == null || !Number.isFinite(value)) return "—";
  const short = (x: number) => (Math.round(x * 10) / 10).toFixed(1).replace(/\.0$/, "");
  const size = Math.abs(value);
  if (size >= 1e6) return short(value / 1e6) + "M";
  if (size >= 1e3) return short(value / 1e3) + "K";
  return Number.isInteger(value) ? String(value) : short(value);
}

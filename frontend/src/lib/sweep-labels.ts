// Shapes and short labels from SWEEP.md, shared by the site and the desktop shell.
// No imports: the desktop build bundles this file on its own.
export type Words = (zh: string, en: string) => string;

export interface Holdings {
  observed_at: number;
  mesos: number | null;
  categories: number[];
  items: { item_id: number; quantity: number }[];
}
export interface SweepWatch {
  item_id: number;
  limit: number;
  groups: any[];
}
export interface DeviceState {
  client_version?: string;
  sweep?: {
    holdings?: Holdings | null;
    allow_web_start?: boolean;
    recent_scan?: boolean;
    shared_sweep?: boolean;
    max_spend?: number;
    max_order?: number;
    reserve_mesos?: number;
    executor?: { ready?: boolean; reason?: string };
    game?: { connected?: boolean };
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
  checked?: number | null;
  /** Recent-match mode: shops left to revisit, 0 while waiting for new hits; null otherwise. */
  pending?: number | null;
  progress_at?: string | null;
  leased?: boolean;
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
  settled_at?: string | null;
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
  stopped_at?: string | null;
  ends_at: string;
  started_by: string;
  plan_version: number;
  plan_stale: boolean;
  plan?: { watches: SweepWatch[]; scan?: { mode: "market" | "recent" | "priority"; recent_minutes?: number } };
  devices: RunDevice[];
  purchases: Purchase[];
  bought?: number;
  items?: { item_id: number; limit: number; units: number; bought?: number }[];
}
export interface SweepState {
  run: Run | null;
  devices: Device[];
}

/** First collector release that ships the purchase executor. */
export const MIN_SWEEP_VERSION = "0.6.19";
const versionParts = (version: string) => {
  const parts = version.replace(/^v/i, "").split(/[.+-]/).slice(0, 3).map(Number);
  return parts.length === 3 && parts.every(Number.isInteger) ? parts : null;
};
/** The reported version when it predates MIN_SWEEP_VERSION; unknown versions are not blocked. */
export function outdatedVersion(version: string | null | undefined) {
  const parts = version ? versionParts(version) : null;
  const minimum = versionParts(MIN_SWEEP_VERSION)!;
  if (!parts) return null;
  const order = parts.findIndex((part, i) => part !== minimum[i]);
  return order >= 0 && parts[order] < minimum[order] ? version! : null;
}
const outdatedLabel = (version: string, words: Words) =>
  words(`版本 ${version} 过旧，请更新采集端`, `Version ${version} is outdated; update the collector`);

/** Why a device cannot join a sweep started on the website, or null. */
export function deviceBlocker(device: Device, words: Words) {
  if (!device.online) return words("离线", "Offline");
  const old = outdatedVersion(device.client_version ?? device.state?.client_version);
  if (old) return outdatedLabel(old, words);
  const sweep = device.state?.sweep;
  if (!sweep) return words("未上报状态", "No status");
  if (!sweep.executor?.ready)
    return sweep.executor?.reason || words("不能扫货", "Cannot sweep");
  if (!sweep.shared_sweep) return words("请更新采集端", "Update collector");
  return null;
}
export function executorLabel(state: DeviceState | null, words: Words) {
  const old = outdatedVersion(state?.client_version);
  if (old) return outdatedLabel(old, words);
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
export function stopReasonLabel(
  reason: string | null | undefined,
  words: Words,
) {
  if (reason === "time_up") return words("时间到", "Time up");
  if (reason === "budget_spent") return words("预算用完", "Budget spent");
  return words("已停止", "Stopped");
}
export function participantLabel(
  state: string | null | undefined,
  words: Words,
) {
  const labels: Record<string, [string, string]> = {
    observing: ["未参与", "Not participating"],
    invited: ["等待加入", "Invited"],
    active: ["扫货中", "Sweeping"],
    refused: ["已拒绝", "Refused"],
    left: ["已离开", "Left"],
  };
  return state && labels[state] ? words(...labels[state]) : state || "—";
}
/** Channel and room as on the site's offer rows ("12频道 3洞", "CH 12 FM3"), then the owner. */
export function purchasePlace(
  purchase: Pick<Purchase, "room" | "channel" | "owner">,
  english = typeof document !== "undefined" &&
    document.documentElement.lang === "en",
) {
  const spot = [
    purchase.channel != null &&
      (english ? `CH ${purchase.channel}` : `${purchase.channel}频道`),
    purchase.room != null &&
      (english ? `FM${purchase.room}` : `${purchase.room}洞`),
  ]
    .filter(Boolean)
    .join(" ");
  return [spot, purchase.owner].filter(Boolean).join(" · ");
}
/** "100 件 @41", or lots and pieces when a lot holds several pieces. */
export function purchaseAmount(
  purchase: Pick<Purchase, "quantity" | "units" | "price">,
  words: Words,
) {
  const units = purchase.units || purchase.quantity || 0;
  const amount =
    purchase.units && purchase.units !== purchase.quantity
      ? words(
          `${purchase.quantity} 组 · ${purchase.units} 件`,
          `${purchase.quantity} lots · ${purchase.units} pcs`,
        )
      : words(`${units} 件`, `${units} pcs`);
  return purchase.price != null
    ? `${amount} @${purchase.price.toLocaleString("en-US")}`
    : amount;
}
/** "2 小时 14 分" from milliseconds. */
export function duration(milliseconds: number, words: Words) {
  if (!Number.isFinite(milliseconds)) return "—";
  const minutes = Math.max(0, Math.floor(milliseconds / 60000));
  const days = Math.floor(minutes / 1440),
    hours = Math.floor((minutes % 1440) / 60),
    rest = minutes % 60;
  return [
    days && words(`${days} 天`, `${days}d`),
    hours && words(`${hours} 小时`, `${hours}h`),
    ((!days && !hours) || rest > 0) && words(`${rest} 分`, `${rest}m`),
  ]
    .filter(Boolean)
    .join(" ");
}
/** What a run's device is doing. A lease is permission to buy, not evidence that the scanner moves. */
export function deviceActivity(
  device: RunDevice,
  run: Pick<Run, "status" | "stop_reason">,
  words: Words,
) {
  if (run.status !== "running") return stopReasonLabel(run.stop_reason, words);
  if (!device.online) return words("设备离线", "Device offline");
  if (device.state !== "active") return participantLabel(device.state, words);
  if (device.leased === false)
    return words("等待重新连接", "Waiting to reconnect");
  const message = device.message?.trim();
  if (!message || ["扫货中", "Sweeping", "运行中", "Running"].includes(message))
    return words("已加入任务", "Joined the sweep");
  return message;
}
/** "今天 17:12", "明天 09:30"; other days show the date. Numbers are epoch seconds. */
export function dayClock(at: string | number | null | undefined, words: Words) {
  if (at == null || at === "") return "—";
  const date = new Date(
    typeof at === "number" ? (at > 1e12 ? at : at * 1000) : at,
  );
  if (Number.isNaN(date.getTime())) return "—";
  const pad = (n: number) => String(n).padStart(2, "0");
  const time = `${pad(date.getHours())}:${pad(date.getMinutes())}`;
  const day = (d: Date) =>
    new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const offset = Math.round((day(date) - day(new Date())) / 86400000);
  if (offset === 0) return words(`今天 ${time}`, `today ${time}`);
  if (offset === 1) return words(`明天 ${time}`, `tomorrow ${time}`);
  if (offset === -1) return words(`昨天 ${time}`, `yesterday ${time}`);
  return `${date.getMonth() + 1}/${date.getDate()} ${time}`;
}
/** Clock time; earlier or later days also show the date. Numbers are epoch seconds. */
export function clockTime(
  at: string | number | null | undefined,
  english = false,
) {
  if (at == null || at === "") return "—";
  const date = new Date(
    typeof at === "number" ? (at > 1e12 ? at : at * 1000) : at,
  );
  if (Number.isNaN(date.getTime())) return "—";
  const locale = english ? "en-US" : "zh-CN";
  const time = date.toLocaleTimeString(locale, {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  return date.toDateString() === new Date().toDateString()
    ? time
    : `${date.getMonth() + 1}/${date.getDate()} ${time}`;
}
/** Mesos in K / M, as web/js/lib/format.js `meso` (the desktop cannot load that module). */
export function mesos(value: number | null | undefined) {
  if (value == null || !Number.isFinite(value)) return "—";
  const short = (x: number) =>
    (Math.round(x * 10) / 10).toFixed(1).replace(/\.0$/, "");
  const size = Math.abs(value);
  if (size >= 1e6) return short(value / 1e6) + "M";
  if (size >= 1e3) return short(value / 1e3) + "K";
  return Number.isInteger(value) ? String(value) : short(value);
}

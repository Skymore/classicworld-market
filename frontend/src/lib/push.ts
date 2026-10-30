// Web Push for watch alerts (WEB_PUSH.md): the service worker, this browser's
// subscription and system notifications. The server sends the pushes.
import { useEffect, useMemo, useSyncExternalStore } from "react";
import { useQuery } from "@tanstack/react-query";
import { embedded } from "./embed";
import { getAccountJson } from "./account-api";
import { useAccount } from "./query";
import type { Language } from "./types";

const WORKER_URL = "/sw.js";
const ICON = "/web/icons/icon-192.png";
const BADGE = "/web/icons/badge-96.png";
const RECORD_KEY = "push.subscription";
const RECORD_EVENT = "push-subscription-change";
const WORKER_TIMEOUT_MS = 10_000;

export const PUSH_LIST_KEY = ["account-push"] as const;
const PUSH_CONFIG_KEY = ["push-config"] as const;

export interface PushConfig {
  enabled: boolean;
  public_key?: string;
}
/** A subscription of the signed-in account; times are ISO strings or Unix seconds. */
export interface PushSubscriptionRow {
  id: string | number;
  label?: string;
  lang?: string;
  created_at?: string | number | null;
  last_sent_at?: string | number | null;
}
/** The server id of this browser's subscription and the endpoint it was made for. */
interface PushRecord {
  id: string | number;
  endpoint: string;
}
export class PushRequestError extends Error {
  constructor(
    readonly code: string,
    readonly status: number,
  ) {
    super(code);
  }
}

/** The collector's local gateway serves the site from this PC; it gets no push. */
export const isLocalGateway = ["127.0.0.1", "localhost", "[::1]"].includes(
  location.hostname,
);
const isIos = () =>
  /iPhone|iPad|iPod/.test(navigator.userAgent) ||
  (/Macintosh/.test(navigator.userAgent) && navigator.maxTouchPoints > 1);

/** "ok", "home-screen" (iOS Safari outside a Home Screen app) or "unsupported". */
export function pushSupport(): "ok" | "home-screen" | "unsupported" {
  if (embedded || isLocalGateway) return "unsupported";
  if (
    navigator.serviceWorker &&
    "PushManager" in window &&
    "Notification" in window
  )
    return "ok";
  const standalone = (navigator as { standalone?: boolean }).standalone;
  return isIos() && standalone !== true ? "home-screen" : "unsupported";
}

/** A short device name for the account's push list, e.g. "Android Chrome". */
export function deviceLabel(
  userAgent: string,
  touch = navigator.maxTouchPoints > 1,
) {
  if (/iPhone|iPod/.test(userAgent)) return "iPhone";
  if (/iPad/.test(userAgent) || (/Macintosh/.test(userAgent) && touch))
    return "iPad";
  const system = /Android/.test(userAgent)
    ? "Android"
    : /Windows/.test(userAgent)
      ? "Windows"
      : /CrOS/.test(userAgent)
        ? "ChromeOS"
        : /Mac OS X/.test(userAgent)
          ? "Mac"
          : /Linux/.test(userAgent)
            ? "Linux"
            : "";
  const browser = /Edg(A|iOS)?\//.test(userAgent)
    ? "Edge"
    : /SamsungBrowser\//.test(userAgent)
      ? "Samsung Internet"
      : /OPR\//.test(userAgent)
        ? "Opera"
        : /Firefox\//.test(userAgent)
          ? "Firefox"
          : /Chrome\//.test(userAgent)
            ? "Chrome"
            : /Safari\//.test(userAgent)
              ? "Safari"
              : "";
  return [system, browser].filter(Boolean).join(" ") || "Browser";
}

// Without localStorage the record lives for this page only.
let memoryRecord: string | null = null;
function rawRecord() {
  try {
    return localStorage.getItem(RECORD_KEY);
  } catch {
    return memoryRecord;
  }
}
function storeRecord(record: PushRecord | null) {
  memoryRecord = record && JSON.stringify(record);
  try {
    if (memoryRecord) localStorage.setItem(RECORD_KEY, memoryRecord);
    else localStorage.removeItem(RECORD_KEY);
  } catch {
    /* kept in memoryRecord */
  }
  window.dispatchEvent(new Event(RECORD_EVENT));
}
function parseRecord(raw: string | null): PushRecord | null {
  try {
    const record = JSON.parse(raw || "null");
    return record?.id != null && typeof record.endpoint === "string"
      ? record
      : null;
  } catch {
    return null;
  }
}
const readRecord = () => parseRecord(rawRecord());
function subscribeRecord(callback: () => void) {
  window.addEventListener(RECORD_EVENT, callback);
  window.addEventListener("storage", callback);
  return () => {
    window.removeEventListener(RECORD_EVENT, callback);
    window.removeEventListener("storage", callback);
  };
}
/** This browser's subscription record, updated across components and tabs. */
export function usePushRecord() {
  const raw = useSyncExternalStore(subscribeRecord, rawRecord, () => null);
  return useMemo(() => parseRecord(raw), [raw]);
}
/** True when pushes reach this browser, so pages skip their own system notifications. */
export const pushSubscribed = () => readRecord() !== null;
export const isThisBrowser = (id: PushSubscriptionRow["id"]) =>
  String(readRecord()?.id) === String(id);

let worker: Promise<ServiceWorkerRegistration | null> | undefined;
/** Registers `/sw.js` once per page; null where push is not offered or registration failed. */
export function registerPushWorker() {
  if (!navigator.serviceWorker || embedded || isLocalGateway)
    return Promise.resolve(null);
  return (worker ??= navigator.serviceWorker
    .register(WORKER_URL, { scope: "/" })
    .catch((error) => {
      console.warn("Service worker registration failed", error);
      return null;
    }));
}
function withTimeout<T>(promise: Promise<T>) {
  return Promise.race([
    promise,
    new Promise<never>((_, reject) =>
      setTimeout(
        () => reject(new PushRequestError("unavailable", 0)),
        WORKER_TIMEOUT_MS,
      ),
    ),
  ]);
}
async function activeWorker() {
  const registration = await registerPushWorker();
  if (!registration) return null;
  if (registration.active) return registration;
  return withTimeout(navigator.serviceWorker.ready).catch(() => null);
}
async function currentSubscription() {
  const registration = await registerPushWorker();
  return (await registration?.pushManager?.getSubscription()) ?? null;
}
/** Forgets the record when the browser no longer holds that subscription. */
async function syncRecord() {
  const record = readRecord();
  if (record && (await currentSubscription())?.endpoint !== record.endpoint)
    storeRecord(null);
}
/** Forgets a record the server no longer lists (other account, password change). */
function reconcileRecord(rows: PushSubscriptionRow[]) {
  const record = readRecord();
  if (record && !rows.some((row) => String(row.id) === String(record.id)))
    storeRecord(null);
}

/** Mounted once by the app: registers the worker after load and keeps the record honest. */
export function usePushWorker() {
  const account = useAccount();
  useEffect(() => {
    const start = () => void registerPushWorker().then(syncRecord);
    if (document.readyState === "complete") start();
    else window.addEventListener("load", start, { once: true });
    return () => window.removeEventListener("load", start);
  }, []);
  // Subscriptions belong to a session, so a signed-out browser has none left.
  const signedOut = account.data ? !account.data.signed_in : false;
  useEffect(() => {
    if (signedOut && readRecord()) storeRecord(null);
  }, [signedOut]);
}
export function usePushConfig(enabled: boolean) {
  return useQuery({
    queryKey: PUSH_CONFIG_KEY,
    enabled,
    staleTime: 300_000,
    queryFn: ({ signal }) =>
      getAccountJson<PushConfig>("/api/v1/push/config", signal),
  });
}
export function usePushSubscriptions(enabled: boolean) {
  const query = useQuery({
    queryKey: PUSH_LIST_KEY,
    enabled,
    queryFn: ({ signal }) =>
      getAccountJson<{ subscriptions?: PushSubscriptionRow[] }>(
        "/api/v1/account/push",
        signal,
      ),
  });
  useEffect(() => {
    if (query.data) reconcileRecord(query.data.subscriptions ?? []);
  }, [query.data]);
  return query;
}

async function pushRequest<T>(
  csrf: string | undefined,
  action: "subscribe" | "unsubscribe" | "test",
  body: unknown,
) {
  const response = await fetch("/api/v1/account/push/" + action, {
    method: "POST",
    credentials: "same-origin",
    headers: {
      "Content-Type": "application/json",
      ...(csrf ? { "X-CSRF-Token": csrf } : {}),
    },
    body: JSON.stringify(body),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok)
    throw new PushRequestError(data.error || "unavailable", response.status);
  return data as T;
}
function keyBytes(key: string) {
  const base64 = key.replace(/-/g, "+").replace(/_/g, "/");
  return Uint8Array.from(
    atob(base64.padEnd(Math.ceil(base64.length / 4) * 4, "=")),
    (char) => char.charCodeAt(0),
  );
}
async function subscribe(manager: PushManager, publicKey: string) {
  const options = {
    userVisibleOnly: true,
    applicationServerKey: keyBytes(publicKey),
  };
  try {
    return await manager.subscribe(options);
  } catch (error) {
    // An old subscription made with a previous server key blocks a new one.
    const old = await manager.getSubscription();
    if (!old) throw error;
    await old.unsubscribe();
    return manager.subscribe(options);
  }
}

/**
 * Asks for permission, subscribes and registers with the server. Call it
 * straight from a click: the permission prompt needs the user's gesture.
 * Resolves false when the user did not allow notifications.
 */
export async function enablePush(
  csrf: string | undefined,
  publicKey: string,
  lang: Language,
) {
  if ((await Notification.requestPermission()) !== "granted") return false;
  const registration = await activeWorker();
  if (!registration) throw new PushRequestError("unavailable", 0);
  const subscription = await subscribe(registration.pushManager, publicKey);
  const { keys } = subscription.toJSON();
  const { id } = await pushRequest<{ id: PushRecord["id"] }>(
    csrf,
    "subscribe",
    {
      endpoint: subscription.endpoint,
      keys: { p256dh: keys?.p256dh, auth: keys?.auth },
      label: deviceLabel(navigator.userAgent),
      lang,
    },
  );
  storeRecord({ id, endpoint: subscription.endpoint });
  return true;
}
const signedOutError = (error: unknown) =>
  error instanceof PushRequestError && error.code === "login_required";
async function unsubscribeEverywhere(
  csrf: string | undefined,
  tolerated: (error: unknown) => boolean,
) {
  const record = readRecord();
  const subscription = await currentSubscription();
  const target = record
    ? { id: record.id }
    : subscription && { endpoint: subscription.endpoint };
  if (target)
    await pushRequest(csrf, "unsubscribe", target).catch((error) => {
      if (!tolerated(error)) throw error;
      console.warn("Push unsubscribe failed", error);
    });
  storeRecord(null);
  await subscription?.unsubscribe();
}
/** Turns push off for this browser. An expired session already lost its subscriptions. */
export const disablePush = (csrf: string | undefined) =>
  unsubscribeEverywhere(csrf, signedOutError);
/** Before signing out: the server also drops the session's subscriptions, so failures do not block. */
export async function releasePushForSignOut(csrf: string | undefined) {
  if (!navigator.serviceWorker || isLocalGateway) return;
  await unsubscribeEverywhere(csrf, () => true).catch((error) =>
    console.warn("Push release failed", error),
  );
}
/** Removes one account subscription; for this browser also its local subscription. */
export async function removePushSubscription(
  csrf: string | undefined,
  id: PushSubscriptionRow["id"],
) {
  if (isThisBrowser(id)) return disablePush(csrf);
  await pushRequest(csrf, "unsubscribe", { id });
}
/**
 * A password change replaces this browser's session, and its subscription goes
 * with the old session. Registers the same browser subscription again.
 */
export async function keepPushAfterSessionChange(csrf: string | undefined, lang: Language) {
  if (!readRecord() || typeof Notification === "undefined" || Notification.permission !== "granted") return;
  const subscription = await currentSubscription();
  if (!subscription) return storeRecord(null);
  const { keys } = subscription.toJSON();
  try {
    const { id } = await pushRequest<{ id: PushRecord["id"] }>(csrf, "subscribe", {
      endpoint: subscription.endpoint,
      keys: { p256dh: keys?.p256dh, auth: keys?.auth },
      label: deviceLabel(navigator.userAgent),
      lang,
    });
    storeRecord({ id, endpoint: subscription.endpoint });
  } catch (error) {
    console.warn("Push re-registration failed", error);
    storeRecord(null);
  }
}
/** Forgets this browser's subscription after the server already deleted it. */
export async function dropLocalPush() {
  storeRecord(null);
  const subscription = await currentSubscription();
  await subscription
    ?.unsubscribe()
    .catch((error) => console.warn("Push unsubscribe failed", error));
}
/** Sends a test push to this browser; an expired subscription is forgotten. */
export async function sendTestPush(csrf: string | undefined) {
  const record = readRecord();
  if (!record) throw new PushRequestError("push_expired", 410);
  try {
    await pushRequest(csrf, "test", { id: record.id });
  } catch (error) {
    if (error instanceof PushRequestError && error.code === "push_expired")
      await dropLocalPush();
    throw error;
  }
}

/**
 * Shows a system notification through the service worker, which Android
 * requires, and falls back to `new Notification`. Clicking opens `data.url`.
 */
export async function showSystemNotification(
  title: string,
  options: NotificationOptions & { data?: { url: string } },
) {
  if (
    typeof Notification === "undefined" ||
    Notification.permission !== "granted"
  )
    return false;
  const details = { icon: ICON, badge: BADGE, ...options };
  const registration = await activeWorker();
  if (registration)
    try {
      await registration.showNotification(title, details);
      return true;
    } catch (error) {
      console.warn("Service worker notification failed", error);
    }
  try {
    new Notification(title, details);
    return true;
  } catch {
    return false; // Android Chrome only notifies from a service worker
  }
}

import { useCallback, useEffect, useState } from "react";
import { usePreferences, useWords } from "../providers";
import { queryClient, useAccount } from "../lib/query";
import {
  PUSH_LIST_KEY,
  PushRequestError,
  disablePush,
  enablePush,
  isLocalGateway,
  pushSupport,
  sendTestPush,
  showSystemNotification,
  usePushConfig,
  usePushRecord,
  usePushSubscriptions,
} from "../lib/push";
import { SiteLink } from "./shell";

type Words = (zh: string, en: string) => string;
type Permission = NotificationPermission | "unsupported";
const permissionNow = (): Permission =>
  typeof Notification === "undefined" || !window.isSecureContext
    ? "unsupported"
    : Notification.permission;

// Every mounted reader refreshes together (the 通知 header and its controls).
const permissionReaders = new Set<() => void>();
const refreshAll = () => permissionReaders.forEach((read) => read());

/** The notification permission, refreshed when site settings may have changed. */
function usePermission() {
  const [permission, setPermission] = useState(permissionNow);
  useEffect(() => {
    const read = () => setPermission(permissionNow());
    permissionReaders.add(read);
    return () => void permissionReaders.delete(read);
  }, []);
  const refresh = useCallback(refreshAll, []);
  useEffect(() => {
    let active = true;
    let permissions: PermissionStatus | undefined;
    const update = () => {
      if (active) refresh();
    };
    window.addEventListener("focus", update);
    document.addEventListener("visibilitychange", update);
    navigator.permissions
      ?.query({ name: "notifications" })
      .then((result) => {
        if (!active) return;
        permissions = result;
        result.addEventListener("change", update);
      })
      .catch(() => {});
    return () => {
      active = false;
      window.removeEventListener("focus", update);
      document.removeEventListener("visibilitychange", update);
      permissions?.removeEventListener("change", update);
    };
  }, [refresh]);
  return [permission, refresh] as const;
}

/** Notification controls for 我的 → 通知: Web Push, or page notifications on the local gateway. */
export function NotificationSettings() {
  return isLocalGateway ? <PageNotificationSettings /> : <PushSettings />;
}

/** A one-line pointer to 我的 → 通知, shown only while notifications cannot reach you. */
export function NotificationStatus() {
  return isLocalGateway ? <PageNotificationStatus /> : <PushStatus />;
}

type PushState =
  "home-screen" | "unsupported" | "blocked" | "signed-out" | "off" | "on";
const FAILURES: Record<string, [string, string]> = {
  push_expired: ["推送已失效，请重新开启", "Push expired. Turn it on again."],
  rate_limited: ["请稍后再试", "Try again in a minute."],
  login_required: ["登录已过期，请重新登录", "Session expired. Sign in again."],
};
function failure(words: Words, error: unknown, fallback: [string, string]) {
  const code = error instanceof PushRequestError ? error.code : "";
  return words(...(FAILURES[code] || fallback));
}
const PUSH_LABELS: Record<PushState, [string, string]> = {
  "home-screen": [
    "在 Safari 点分享 → 添加到主屏幕，从主屏幕打开后开启",
    "In Safari tap Share → Add to Home Screen, then turn on from the Home Screen app",
  ],
  unsupported: ["此浏览器不支持推送", "This browser does not support push"],
  blocked: [
    "已被阻止，请在浏览器或系统设置里允许",
    "Blocked. Allow in browser or system settings",
  ],
  "signed-out": ["登录后可开启推送", "Sign in to turn on push"],
  off: ["推送未开启", "Push is off"],
  on: ["推送已开启", "Push is on"],
};

function usePushState() {
  const account = useAccount();
  const support = pushSupport();
  const config = usePushConfig(support === "ok");
  const [permission, refreshPermission] = usePermission();
  const record = usePushRecord();
  const signedIn = Boolean(account.data?.signed_in);
  const publicKey = config.data?.enabled ? config.data.public_key : undefined;
  usePushSubscriptions(Boolean(publicKey && signedIn && record));
  const state: PushState | null =
    support !== "ok"
      ? support
      : !config.data
        ? null
        : !publicKey
          ? "unsupported"
          : permission === "denied"
            ? "blocked"
            : !account.data
              ? null
              : !signedIn
                ? "signed-out"
                : record && permission === "granted"
                  ? "on"
                  : "off";
  return { state, account, publicKey, refreshPermission };
}

function usePushSummary() {
  const words = useWords();
  const { state } = usePushState();
  return state ? words(...PUSH_LABELS[state]) : "";
}
function usePageSummary() {
  const words = useWords();
  const [permission] = usePermission();
  return words(...PAGE_LABELS[permission]);
}
/** The short state shown in the 通知 section header. */
export const useNotificationSummary: () => string = isLocalGateway
  ? usePageSummary
  : usePushSummary;

function PushStatus() {
  const words = useWords();
  const { state } = usePushState();
  if (!state || state === "on") return null;
  return (
    <p className="watch-notification-bar" data-notification-state={state}>
      <span className="watch-notification-state">
        {words(...PUSH_LABELS[state])}
      </span>
      <SiteLink href="/account#notifications" data-notification-settings>
        {words("通知设置", "Notification settings")} →
      </SiteLink>
    </p>
  );
}

function PushSettings() {
  const words = useWords();
  const { language } = usePreferences();
  const { state, account, publicKey, refreshPermission } = usePushState();
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("");
  if (!state) return null;
  const csrf = account.data?.csrf;
  async function run(
    action: () => Promise<string>,
    fallback: [string, string],
  ) {
    setBusy(true);
    setStatus("");
    try {
      setStatus(await action());
    } catch (error) {
      setStatus(failure(words, error, fallback));
      if (error instanceof PushRequestError && error.code === "login_required")
        void account.refetch();
    } finally {
      refreshPermission();
      setBusy(false);
      void queryClient.invalidateQueries({ queryKey: PUSH_LIST_KEY });
    }
  }
  return (
    // The section header already shows the state; this row holds the controls.
    <div className="watch-notification-bar" data-notification-state={state}>
      {state === "off" && (
        <button
          type="button"
          className="btn"
          data-push-enable
          disabled={busy}
          onClick={() =>
            void run(async () => {
              await enablePush(csrf, publicKey!, language);
              return "";
            }, ["未能开启，请重试", "Could not turn on. Try again."])
          }
        >
          {words("开启推送", "Turn on push")}
        </button>
      )}
      {state === "on" && (
        <>
          <button
            type="button"
            className="btn"
            data-push-test
            disabled={busy}
            onClick={() =>
              void run(async () => {
                await sendTestPush(csrf);
                return words("已发送测试推送", "Test push sent");
              }, ["发送失败，请稍后重试", "Could not send. Try again later."])
            }
          >
            {words("发送测试", "Send test")}
          </button>
          <button
            type="button"
            className="btn"
            data-push-disable
            disabled={busy}
            onClick={() =>
              void run(async () => {
                await disablePush(csrf);
                return "";
              }, ["未能关闭，请重试", "Could not turn off. Try again."])
            }
          >
            {words("关闭", "Turn off")}
          </button>
        </>
      )}
      <span className="watch-notification-hint" role="status">
        {status}
      </span>
    </div>
  );
}

const PAGE_LABELS: Record<Permission, [string, string]> = {
  granted: ["已允许", "Allowed"],
  denied: ["已被阻止", "Blocked"],
  unsupported: ["不可用", "Unavailable"],
  default: ["未开启", "Off"],
};

function PageNotificationStatus() {
  const words = useWords();
  const [permission] = usePermission();
  if (permission === "granted") return null;
  return (
    <p className="watch-notification-bar" data-notification-state={permission}>
      <span className="watch-notification-state">
        {words("通知", "Notifications")} · {words(...PAGE_LABELS[permission])}
      </span>
      <SiteLink href="/account#notifications" data-notification-settings>
        {words("通知设置", "Notification settings")} →
      </SiteLink>
    </p>
  );
}

/** The local gateway has no push: system notifications need this page open. */
function PageNotificationSettings() {
  const words = useWords();
  const [permission, refreshPermission] = usePermission();
  const [status, setStatus] = useState("");
  async function enable() {
    try {
      await Notification.requestPermission();
      refreshPermission();
      setStatus("");
    } catch {
      setStatus(
        words(
          "未能开启，请检查网站通知权限。",
          "Could not enable notifications. Check site permissions.",
        ),
      );
    }
  }
  async function test() {
    refreshPermission();
    const shown = await showSystemNotification(
      words("枫叶市集 · 测试通知", "Maple Market · Test notification"),
      {
        body: words(
          "保持本站任意页面打开，即可接收关注提醒。",
          "Keep any page of this site open to receive watch alerts.",
        ),
        tag: "watch-notification-test",
      },
    );
    setStatus(
      shown
        ? words("已发送测试通知", "Test notification sent")
        : words(
            "通知未能发送，请检查浏览器与系统通知设置。",
            "Could not send. Check browser and system notification settings.",
          ),
    );
  }
  return (
    <div
      className="watch-notification-bar"
      data-notification-state={permission}
    >
      {permission === "default" && (
        <button
          type="button"
          className="btn"
          data-allow
          onClick={() => void enable()}
        >
          {words("允许浏览器通知", "Allow browser notifications")}
        </button>
      )}
      {permission === "granted" && (
        <button
          type="button"
          className="btn"
          data-notification-test
          onClick={() => void test()}
        >
          {words("发送测试通知", "Send test notification")}
        </button>
      )}
      <span className="watch-notification-hint" role="status">
        {status ||
          (permission === "denied"
            ? words(
                "在地址栏的网站设置里开启",
                "Turn on in the address bar's site settings",
              )
            : permission === "unsupported"
              ? words("此浏览器不支持通知", "This browser has no notifications")
              : "")}
      </span>
    </div>
  );
}

import { useEffect, useState } from "react";
import { useWords } from "../providers";

type Permission = NotificationPermission | "unsupported";
const permissionNow = (): Permission =>
  typeof Notification === "undefined" || !window.isSecureContext
    ? "unsupported"
    : Notification.permission;

export function NotificationSettings() {
  const words = useWords();
  const [permission, setPermission] = useState(permissionNow);
  const [status, setStatus] = useState("");
  useEffect(() => {
    let active = true;
    let permissions: PermissionStatus | undefined;
    const update = () => {
      if (active) {
        setPermission(permissionNow());
        setStatus("");
      }
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
  }, []);
  async function enable() {
    try {
      setPermission(await Notification.requestPermission());
    } catch {
      setStatus(
        words(
          "未能开启，请检查网站通知权限。",
          "Could not enable notifications. Check site permissions.",
        ),
      );
    }
  }
  function test() {
    setPermission(permissionNow());
    if (permissionNow() !== "granted") return;
    try {
      new Notification(
        words("枫叶市集 · 测试通知", "Maple Market · Test notification"),
        {
          body: words(
            "保持本站任意页面打开，即可接收关注提醒。",
            "Keep any page of this site open to receive watch alerts.",
          ),
          tag: "watch-notification-test",
        },
      );
      setStatus(words("已发送测试通知", "Test notification sent"));
    } catch {
      setStatus(
        words(
          "通知未能发送，请检查浏览器与系统通知设置。",
          "Could not send. Check browser and system notification settings.",
        ),
      );
    }
  }
  return (
    <div
      className="watch-notification-bar"
      data-notification-state={permission}
    >
      <span className="watch-notification-state">
        {words("通知", "Notifications")} ·{" "}
        {permission === "granted"
          ? words("已允许", "Allowed")
          : permission === "denied"
            ? words("已被阻止", "Blocked")
            : permission === "unsupported"
              ? words("不可用", "Unavailable")
              : words("未开启", "Off")}
      </span>
      {permission === "default" && (
        <button type="button" className="btn" data-allow onClick={enable}>
          {words("允许浏览器通知", "Allow browser notifications")}
        </button>
      )}
      {permission === "granted" && (
        <button
          type="button"
          className="btn"
          data-notification-test
          onClick={test}
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
              ? words(
                  "此浏览器不支持通知",
                  "This browser has no notifications",
                )
              : words(
                  "本站任意页面打开即可提醒",
                  "Alerts stay active on any page of this site",
                ))}
      </span>
    </div>
  );
}

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Laptop } from "lucide-react";
import { AccountSetting, postAccount } from "./account-access";
import { getAccountJson, useAccountTopics } from "../lib/account-api";
import { queryClient } from "../lib/query";
import { executorLabel, type Device } from "../lib/sweep-labels";
import {
  PUSH_LIST_KEY,
  isThisBrowser,
  removePushSubscription,
  usePushRecord,
  usePushSubscriptions,
  type PushSubscriptionRow,
} from "../lib/push";
import { RelativeTime } from "../components/shared";
import { useWords } from "../providers";
import type { Account } from "../lib/types";

const DEVICES_KEY = ["account-devices"] as const;
const seconds = (at?: string | null) => (at ? Date.parse(at) / 1000 : null);

/** Signed-in collectors (SWEEP.md §1), each with a sign-out button. */
export function DevicesPanel({
  profile,
  message,
}: {
  profile: Account;
  message(code: string): string;
}) {
  const words = useWords();
  const devices = useQuery({
    queryKey: DEVICES_KEY,
    queryFn: ({ signal }) =>
      getAccountJson<{ devices: Device[] }>("/api/v1/account/devices", signal),
  });
  useAccountTopics(["devices"], DEVICES_KEY);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("");
  const list = devices.data?.devices || [];
  const online = list.filter((device) => device.online).length;
  async function revoke(device: Device) {
    setBusy(true);
    setStatus("");
    try {
      await postAccount(profile.csrf, "/api/v1/account/devices/revoke", {
        device: device.id,
      });
      await queryClient.invalidateQueries({ queryKey: DEVICES_KEY });
    } catch (error) {
      setStatus(message((error as Error).message));
    } finally {
      setBusy(false);
    }
  }
  return (
    <AccountSetting
      name="devices"
      icon={<Laptop size={20} />}
      title={words("我的设备", "My devices")}
      meta={
        devices.isError
          ? words("暂时无法加载", "Unavailable")
          : devices.data
            ? words(
                `${list.length} 台 · ${online} 台在线`,
                `${list.length} devices · ${online} online`,
              )
            : words("加载中…", "Loading…")
      }
    >
      {devices.isError ? (
        <p role="alert">{message("unavailable")}</p>
      ) : devices.data && !list.length ? (
        <p className="account-hint">
          {words("还没有设备登录", "No devices signed in")}
        </p>
      ) : (
        <ul className="device-list" data-devices>
          {list.map((device) => (
            <li className="device-row" key={device.id} data-device-row={device.id}>
              <span className="device-main">
                <b>{device.name}</b>
                <small>
                  <span data-device-online={device.online}>
                    {device.online ? (
                      words("在线", "Online")
                    ) : (
                      <>
                        {words("最后在线 ", "Last seen ")}
                        <RelativeTime at={seconds(device.last_seen_at)} />
                      </>
                    )}
                  </span>
                  {device.client_version && ` · v${device.client_version}`}
                  {" · "}
                  <span data-device-executor>
                    {executorLabel(device.state, words)}
                  </span>
                </small>
              </span>
              <button
                type="button"
                data-revoke={device.id}
                disabled={busy}
                onClick={() => void revoke(device)}
              >
                {words("退出这台设备", "Sign out this device")}
              </button>
            </li>
          ))}
        </ul>
      )}
      <p role="status" data-devices-status>
        {status}
      </p>
      <PushList profile={profile} message={message} />
    </AccountSetting>
  );
}

const toSeconds = (at?: string | number | null) =>
  typeof at === "number" ? at : seconds(at);

/** The account's push subscriptions; removing one stops pushes to that browser. */
function PushList({
  profile,
  message,
}: {
  profile: Account;
  message(code: string): string;
}) {
  const words = useWords();
  const subscriptions = usePushSubscriptions(true);
  usePushRecord(); // re-render when this browser subscribes or unsubscribes
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("");
  const list = subscriptions.data?.subscriptions || [];
  if (!list.length) return null;
  async function remove(id: PushSubscriptionRow["id"]) {
    setBusy(true);
    setStatus("");
    try {
      await removePushSubscription(profile.csrf, id);
    } catch (error) {
      setStatus(message((error as Error).message));
    } finally {
      await queryClient.invalidateQueries({ queryKey: PUSH_LIST_KEY });
      setBusy(false);
    }
  }
  return (
    <>
      <p>
        <b>{words("推送", "Push")}</b>
      </p>
      <ul className="device-list" data-push-list>
        {list.map((row) => (
          <li className="device-row" key={row.id} data-push-row={row.id}>
            <span className="device-main">
              <b>
                {row.label || words("浏览器", "Browser")}
                {isThisBrowser(row.id) && (
                  <span data-push-current>
                    {" · " + words("这台浏览器", "This browser")}
                  </span>
                )}
              </b>
              <small>
                {words("开启于 ", "Added ")}
                <RelativeTime at={toSeconds(row.created_at)} />
                {" · "}
                {row.last_sent_at ? (
                  <>
                    {words("最近推送 ", "Last push ")}
                    <RelativeTime at={toSeconds(row.last_sent_at)} />
                  </>
                ) : (
                  words("尚未推送", "No push yet")
                )}
              </small>
            </span>
            <button
              type="button"
              data-push-remove={row.id}
              disabled={busy}
              onClick={() => void remove(row.id)}
            >
              {words("移除", "Remove")}
            </button>
          </li>
        ))}
      </ul>
      <p role="status" data-push-status>
        {status}
      </p>
    </>
  );
}

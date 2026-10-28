import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Laptop } from "lucide-react";
import { AccountSetting, postAccount } from "./account-access";
import { getAccountJson, useAccountTopics } from "../lib/account-api";
import { queryClient } from "../lib/query";
import { executorLabel, type Device } from "../lib/sweep-labels";
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
    </AccountSetting>
  );
}

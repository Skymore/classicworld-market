import { useState } from "react";
import { useSearchParams } from "react-router-dom";
import { useAccount } from "../lib/query";
import {
  AuthForm,
  RecoveryNotice,
  accountMessage,
  postAccount,
  refreshAccount,
} from "./account-access";
import { rememberReturn } from "../lib/return-to";
import { useWords } from "../providers";
import { Stall, Loading, ErrorState, usePageReady } from "../components/shared";
import { Button } from "../components/ui/button";

// The collector's browser sign-in (SWEEP.md §1, RFC 8252 loopback redirect).
const LOOPBACK = /^http:\/\/127\.0\.0\.1:(\d{4,5})\/callback$/;
const CHALLENGE = /^[A-Za-z0-9_-]{43}$/;
const STATE = /^[A-Za-z0-9._~-]{1,128}$/;

interface DeviceRequest {
  redirect: string;
  state: string;
  challenge: string;
  name: string;
}
function readDeviceRequest(params: URLSearchParams): DeviceRequest | null {
  const redirect = params.get("redirect_uri") || "";
  const state = params.get("state") || "";
  const challenge = params.get("challenge") || "";
  const name = params.get("name") || "";
  const port = Number(LOOPBACK.exec(redirect)?.[1]);
  const nameLength = [...name].length;
  if (!(port >= 1024 && port <= 65535)) return null;
  if (!CHALLENGE.test(challenge) || !STATE.test(state)) return null;
  if (nameLength < 1 || nameLength > 40 || /\p{Cc}/u.test(name)) return null;
  return { redirect, state, challenge, name };
}
const back = (request: DeviceRequest, query: Record<string, string>) =>
  request.redirect +
  "?" +
  Object.entries({ ...query, state: request.state })
    .map(([key, value]) => key + "=" + encodeURIComponent(value))
    .join("&");

export default function DevicePage() {
  usePageReady();
  const words = useWords();
  const account = useAccount();
  const profile = account.data;
  const [params] = useSearchParams();
  const request = readDeviceRequest(params);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("");
  const [recoveryCode, setRecoveryCode] = useState<string | null>(null);
  const message = (code: string) => accountMessage(words, code);
  const post = (path: string, data: unknown) =>
    postAccount(profile?.csrf, path, data);
  async function allow() {
    if (!request) return;
    setBusy(true);
    setStatus("");
    try {
      const { code } = await post("/api/v1/device/authorize", {
        redirect_uri: request.redirect,
        challenge: request.challenge,
        name: request.name,
      });
      if (typeof code !== "string" || !code) throw Error("unavailable");
      setStatus(words("正在返回采集器…", "Returning to the collector…"));
      location.replace(back(request, { code }));
    } catch (error) {
      const code = (error as Error).message;
      if (code === "login_required") await refreshAccount().catch(() => {});
      setStatus(
        code === "invalid_request"
          ? words("登录链接无效，请回到采集器重新登录。", "Invalid link. Sign in again from the collector.")
          : message(code),
      );
      setBusy(false);
    }
  }
  function cancel() {
    if (!request) return;
    setBusy(true);
    location.replace(back(request, { error: "access_denied" }));
  }
  return (
    <Stall
      title={words("设备登录", "Device sign-in")}
      className="account-stall device-stall"
      h1
    >
      <div className="account-body" data-device-login>
        {!request ? (
          <p role="alert" data-device-invalid>
            {words(
              "登录链接无效，请回到采集器重新登录。",
              "Invalid link. Sign in again from the collector.",
            )}
          </p>
        ) : account.isError ? (
          <ErrorState retry={() => void account.refetch()} />
        ) : !profile ? (
          <Loading />
        ) : !profile.signed_in ? (
          <>
            <AuthForm
              profile={profile}
              post={post}
              refresh={refreshAccount}
              message={message}
              recover={setRecoveryCode}
            />
            {profile.google_enabled && (
              <a
                className="btn google-signin"
                href="/auth/google/start"
                onClick={() => rememberReturn()}
              >
                <span aria-hidden="true">G</span>
                {words("使用 Google 登录", "Sign in with Google")}
              </a>
            )}
          </>
        ) : (
          <>
            {recoveryCode && (
              <RecoveryNotice
                code={recoveryCode}
                username={profile.username}
                dismiss={() => setRecoveryCode(null)}
              />
            )}
            <p className="device-question" data-device-question>
              {words(
                `允许「${request.name}」登录 `,
                `Allow “${request.name}” to sign in as `,
              )}
              <b>{profile.nickname || profile.username}</b>
              {words("？", "?")}
            </p>
            <div className="account-actions device-actions">
              <Button
                variant="primary"
                data-device-allow
                disabled={busy}
                onClick={() => void allow()}
              >
                {words("允许", "Allow")}
              </Button>
              <Button data-device-cancel disabled={busy} onClick={cancel}>
                {words("取消", "Cancel")}
              </Button>
            </div>
          </>
        )}
        <p role="status" className="account-status" data-device-status>
          {status}
        </p>
      </div>
    </Stall>
  );
}

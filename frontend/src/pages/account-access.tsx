import {
  useEffect,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
} from "react";
import { ChevronDown, Cloud, ShieldCheck } from "lucide-react";
import {
  subscribeSync,
  getSyncState,
  importGuest,
  guestImportAvailable,
  retryConflicts,
  flush,
  beforeSignOut,
} from "/web/js/lib/user-data.js";
import { useWords } from "../providers";
import type { Account } from "../lib/types";
import { Button } from "../components/ui/button";

interface Result {
  recovery_code?: string;
  url?: string;
}
export interface AccessProps {
  profile?: Account;
  post(path: string, data: unknown): Promise<Result>;
  refresh(broadcast?: boolean): Promise<void>;
  message(code: string): string;
  recover(code: string | null): void;
}
export function AccountSetting({
  icon,
  title,
  meta,
  children,
  attention = false,
  name,
}: {
  icon: ReactNode;
  title: string;
  meta: ReactNode;
  children: ReactNode;
  attention?: boolean;
  name: string;
}) {
  const details = useRef<HTMLDetailsElement>(null);
  useEffect(() => {
    if (attention && details.current) details.current.open = true;
  }, [attention]);
  return (
    <details className="account-setting" ref={details} data-setting={name}>
      <summary>
        <span className="account-setting-icon" aria-hidden="true">
          {icon}
        </span>
        <span className="account-setting-title">
          {title}
          <small>{meta}</small>
        </span>
        <ChevronDown size={16} className="account-chevron" aria-hidden="true" />
      </summary>
      <div className="account-setting-content">{children}</div>
    </details>
  );
}
export function AuthForm({ post, refresh, message, recover }: AccessProps) {
  const words = useWords();
  const [mode, setMode] = useState("login");
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("");
  const register = mode === "register",
    reset = mode === "recover";
  const title = register
    ? words("注册应用账号", "Create an account")
    : reset
      ? words("恢复账号", "Recover account")
      : words("账号密码登录", "Sign in with a password");
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = Object.fromEntries(new FormData(event.currentTarget));
    setBusy(true);
    setStatus("");
    try {
      if (
        data.confirm_password !== undefined &&
        data.confirm_password !== data.password
      )
        throw Error("password_mismatch");
      delete data.confirm_password;
      const result = await post(
        "/api/v1/account/" +
          (mode === "login" ? "login" : register ? "register" : "recover"),
        data,
      );
      recover(result.recovery_code || null);
      await refresh(true);
    } catch (error) {
      setStatus(message((error as Error).message));
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <div
        className="account-tabs"
        role="group"
        aria-label={words("登录方式", "Sign-in options")}
      >
        {[
          ["login", "登录", "Sign in"],
          ["register", "注册", "Register"],
          ["recover", "找回密码", "Recover"],
        ].map(([key, zh, en]) => (
          <button
            type="button"
            key={key}
            data-auth-tab={key}
            aria-pressed={mode === key}
            onClick={() => {
              setMode(key);
              setStatus("");
            }}
          >
            {words(zh, en)}
          </button>
        ))}
      </div>
      <h2>{title}</h2>
      <form data-auth onSubmit={submit} key={mode}>
        <label>
          {words("用户名", "Username")}
          <input
            name="username"
            autoComplete="username"
            required
            minLength={3}
            maxLength={32}
            autoCapitalize="none"
            spellCheck={false}
            pattern="[A-Za-z0-9][A-Za-z0-9_.-]{2,31}"
          />
        </label>
        {reset && (
          <label>
            {words("一次性恢复码", "One-time recovery code")}
            <input
              name="recovery_code"
              required
              minLength={43}
              maxLength={43}
              autoComplete="off"
              spellCheck={false}
            />
          </label>
        )}
        <label>
          {words(
            reset ? "新密码" : "密码",
            reset ? "New password" : "Password",
          )}
          <input
            name="password"
            type="password"
            autoComplete={
              register || reset ? "new-password" : "current-password"
            }
            required
            minLength={register || reset ? 15 : 1}
            maxLength={128}
          />
        </label>
        {(register || reset) && (
          <>
            <label>
              {words("再次输入密码", "Confirm password")}
              <input
                name="confirm_password"
                type="password"
                autoComplete="new-password"
                required
                minLength={15}
                maxLength={128}
              />
            </label>
            <p className="note">
              {words(
                "密码使用 15–128 个字符。完成后请保存恢复码，用于忘记密码时找回账号。",
                "Use 15–128 characters. Save the recovery code to recover your account if you forget the password.",
              )}
            </p>
          </>
        )}
        <Button type="submit" variant="primary" disabled={busy}>
          {title}
        </Button>
        <p role="status" className="account-status">
          {status}
        </p>
      </form>
    </>
  );
}
export function RecoveryNotice({
  code,
  username,
  dismiss,
}: {
  code: string;
  username?: string;
  dismiss(): void;
}) {
  const words = useWords();
  function download() {
    const blob = new Blob(
      [
        `Maple Market recovery code\nUsername: ${username || ""}\n${code}\nKeep private. This code can reset your password.\n`,
      ],
      { type: "text/plain" },
    );
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = "maple-market-recovery.txt";
    anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  return (
    <section className="well recovery-notice" role="status">
      <h3>{words("请保存你的新恢复码", "Save your new recovery code")}</h3>
      <p>
        {words(
          "恢复码仅在这里显示一次，可用于重设密码。请存放在安全位置；不要发给他人。旧恢复码已失效。",
          "This code is shown once and can reset your password. Save it somewhere safe. Any previous recovery code is now invalid.",
        )}
      </p>
      <code className="recovery-code">{code}</code>
      <div className="account-actions">
        <button type="button" data-download-recovery onClick={download}>
          {words("下载恢复码", "Download code")}
        </button>
        <button type="button" data-dismiss-recovery onClick={dismiss}>
          {words("我已保存", "I saved it")}
        </button>
      </div>
    </section>
  );
}
export function SyncPanel({ message }: Pick<AccessProps, "message">) {
  const words = useWords();
  const [state, setState] = useState(getSyncState);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => subscribeSync(setState), []);
  const labels: Record<string, [string, string]> = {
    memory_only: [
      "浏览器无法保存本机副本，请保持联网完成同步。",
      "This browser cannot save a local copy. Stay online to sync.",
    ],
    guest: [
      "本机保存，登录后可同步",
      "Saved in this browser. Sign in to sync.",
    ],
    synced: ["已同步", "Synced"],
    pending: ["等待同步…", "Waiting to sync…"],
    offline: [
      "暂时离线，修改已保存在本机，联网后重试",
      "Offline. Changes are saved on this device and will retry.",
    ],
    conflict: [
      "其他设备更新了相同设置，已保留云端版本。本机修改仍可重新应用。",
      "Another device changed the same settings. Your local changes can still be reapplied.",
    ],
    login_required: [
      "登录已过期，未上传的修改保留在本机",
      "Sign in again. Pending changes are kept on this device.",
    ],
    watch_limit: [
      "关注最多 100 个，请调整清单后重试",
      "Up to 100 watches. Adjust the list and retry.",
    ],
  };
  async function action(kind: string) {
    setBusy(true);
    setError("");
    try {
      if (kind === "import") await importGuest();
      else if (kind === "retry") retryConflicts();
      else await flush();
    } catch (error) {
      setError(message((error as Error).message));
    } finally {
      setBusy(false);
    }
  }
  const text = labels[state.status] || labels.offline;
  return (
    <AccountSetting
      name="sync"
      icon={<Cloud size={20} />}
      title={words("云端同步", "Cloud sync")}
      meta={
        <span data-sync-status role="status" data-state={state.status}>
          {words(text[0], text[1])}
        </span>
      }
      attention={
        Boolean(error || state.conflicts || guestImportAvailable()) ||
        ["offline", "login_required", "watch_limit", "memory_only"].includes(
          state.status,
        )
      }
    >
      <p className="account-hint">
        {words(
          "关注、目标价与偏好自动同步。未上传的修改保留在本机。",
          "Watches, target prices and preferences sync automatically. Pending edits stay on this device.",
        )}
      </p>
      <div className="account-actions">
        <button
          type="button"
          data-sync-now
          disabled={busy}
          onClick={() => void action("sync")}
        >
          {words("立即同步", "Sync now")}
        </button>
        <button
          type="button"
          data-retry-conflicts
          hidden={!state.conflicts}
          disabled={busy}
          onClick={() => void action("retry")}
        >
          {words("重新应用本机修改", "Reapply local changes")}
        </button>
      </div>
      {guestImportAvailable() && (
        <>
          <p>
            {words(
              `本机游客清单有 ${state.guestWatches} 个关注商品，可合并到此账号。重复项保留云端设置。`,
              `This browser has ${state.guestWatches} guest watches. Existing cloud settings take priority.`,
            )}
          </p>
          <button
            type="button"
            data-import-guest
            disabled={busy}
            onClick={() => void action("import")}
          >
            {words("合并本机清单", "Merge guest watches")}
          </button>
        </>
      )}
      <p data-sync-error role="alert">
        {error}
      </p>
    </AccountSetting>
  );
}
export function SecurityPanel({
  profile,
  post,
  refresh,
  message,
  recover,
}: AccessProps & { profile: Account }) {
  const words = useWords();
  const current = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("");
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = Object.fromEntries(new FormData(event.currentTarget));
    setBusy(true);
    setStatus("");
    try {
      if (data.password !== data.confirm_password)
        throw Error("password_mismatch");
      delete data.confirm_password;
      const result = await post("/api/v1/account/password", {
        ...data,
        current_password: current.current?.value || "",
      });
      recover(result.recovery_code || null);
      await refresh(true);
    } catch (error) {
      setStatus(message((error as Error).message));
    } finally {
      setBusy(false);
    }
  }
  async function action(kind: string) {
    setBusy(true);
    setStatus("");
    try {
      if (kind === "logout-all") await beforeSignOut();
      const result = await post("/api/v1/account/" + kind, {
        current_password: current.current?.value || "",
      });
      if (kind === "google/link") {
        const url = new URL(result.url!);
        if (url.origin !== "https://accounts.google.com")
          throw Error("unavailable");
        location.assign(url);
      } else await refresh(true);
    } catch (error) {
      setStatus(message((error as Error).message));
    } finally {
      setBusy(false);
    }
  }
  return (
    <AccountSetting
      name="security"
      icon={<ShieldCheck size={20} />}
      title={words("登录与安全", "Sign-in & security")}
      meta={
        profile.has_password
          ? words("用户名与密码", "Username & password")
          : words("通过 Google 登录", "Signed in with Google")
      }
    >
      <p className="account-hint">
        {profile.has_password
          ? words("登录用户名：", "Username: ") + profile.username
          : words(
              "当前通过 Google 登录。你也可以设置用户名和密码。",
              "You currently sign in with Google. You can also set a username and password.",
            )}
      </p>
      {profile.has_password && (
        <label>
          {words(
            "当前密码（用于修改登录方式）",
            "Current password (to change sign-in methods)",
          )}
          <input
            id="account-current-password"
            ref={current}
            type="password"
            autoComplete="current-password"
            maxLength={128}
          />
        </label>
      )}
      <details>
        <summary>
          {words(
            profile.has_password ? "修改密码" : "设置用户名和密码",
            profile.has_password
              ? "Change password"
              : "Set username & password",
          )}
        </summary>
        <form data-password onSubmit={submit}>
          <label>
            {words("登录用户名", "Username")}
            <input
              name="username"
              autoComplete="username"
              required
              minLength={3}
              maxLength={32}
              defaultValue={profile.username || ""}
              readOnly={profile.has_password}
              pattern="[A-Za-z0-9][A-Za-z0-9_.-]{2,31}"
            />
          </label>
          <label>
            {words(
              "新密码（15–128 个字符）",
              "New password (15–128 characters)",
            )}
            <input
              name="password"
              type="password"
              autoComplete="new-password"
              required
              minLength={15}
              maxLength={128}
            />
          </label>
          <label>
            {words("再次输入新密码", "Confirm new password")}
            <input
              name="confirm_password"
              type="password"
              autoComplete="new-password"
              required
              minLength={15}
              maxLength={128}
            />
          </label>
          <Button type="submit" disabled={busy}>
            {words("保存密码", "Save password")}
          </Button>
          <p className="account-status" role="status">
            {status}
          </p>
        </form>
      </details>
      <p>
        {words(
          profile.google_linked ? "Google：已绑定" : "Google：未绑定",
          profile.google_linked ? "Google: linked" : "Google: not linked",
        )}
      </p>
      {profile.google_linked ? (
        <button
          type="button"
          data-security-action="google/unlink"
          disabled={busy}
          onClick={() => void action("google/unlink")}
        >
          {words("解绑 Google", "Unlink Google")}
        </button>
      ) : (
        profile.google_enabled && (
          <button
            type="button"
            data-security-action="google/link"
            disabled={busy}
            onClick={() => void action("google/link")}
          >
            {words("绑定 Google 登录", "Link Google sign-in")}
          </button>
        )
      )}
      {!profile.has_password && (
        <p className="note">
          {words(
            "修改登录方式前，可能需要重新使用 Google 登录。解绑 Google 前必须先设置密码。",
            "You may need to sign in with Google again. Set a password before unlinking Google.",
          )}
        </p>
      )}
      <button
        type="button"
        data-security-action="logout-all"
        disabled={busy}
        onClick={() => void action("logout-all")}
      >
        {words("退出所有设备", "Sign out all devices")}
      </button>
      <p data-security-status role="status">
        {status}
      </p>
    </AccountSetting>
  );
}

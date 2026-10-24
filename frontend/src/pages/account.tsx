import { useEffect, useState, type FormEvent } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { Monitor, Pencil, ArrowUpRight } from "lucide-react";
import { useAccount, queryClient } from "../lib/query";
import { adoptAccount, beforeSignOut } from "/web/js/lib/user-data.js";
import {
  AuthForm,
  RecoveryNotice,
  SyncPanel,
  SecurityPanel,
  AccountSetting,
} from "./account-access";
import { useWords } from "../providers";
import { SiteLink } from "../components/shell";
import {
  Stall,
  Loading,
  ErrorState,
  num,
  usePageReady,
  Icon,
} from "../components/shared";
import { Button } from "../components/ui/button";

export default function AccountPage() {
  usePageReady();
  const words = useWords();
  const account = useAccount();
  const profile = account.data;
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const link = params.get("link");
  const [nickname, setNickname] = useState("");
  const [listed, setListed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("");
  const [linkStatus, setLinkStatus] = useState("");
  const [editing, setEditing] = useState(false);
  const [recoveryCode, setRecoveryCode] = useState<string | null>(null);
  useEffect(() => {
    setNickname(profile?.nickname || "");
    setListed(Boolean(profile?.listed));
  }, [profile?.nickname, profile?.listed]);
  const local = profile?.mode === "collector";
  const access = { profile, post, refresh, message, recover: setRecoveryCode };
  function message(code: string) {
    const messages: Record<string, [string, string]> = {
      invalid_nickname: [
        "昵称需要 2–24 个字，可用中文、字母、数字、空格和 _-.。",
        "Use 2–24 letters, numbers, spaces or _-. for your nickname.",
      ],
      expired_link: [
        "绑定链接已过期，请在采集器中重新点击绑定。",
        "This link expired. Start linking again in the collector.",
      ],
      already_linked: [
        "这个采集器已经绑定了其他账号。",
        "This collector belongs to another account.",
      ],
      manage_on_website: [
        "请在官网的「我的」中修改昵称。",
        "Edit your nickname on the website under My profile.",
      ],
      login_failed: [
        "登录未完成，请重试。",
        "Sign-in did not finish. Please try again.",
      ],
      google_unavailable: [
        "Google 登录暂未开放，可使用用户名和密码登录。",
        "Google sign-in is unavailable. You can sign in with a username and password.",
      ],
      invalid_username: [
        "用户名需为 3–32 个英文字母、数字、下划线、点或短横线，并以字母或数字开头。",
        "Use 3–32 letters, numbers, underscores, dots or hyphens, starting with a letter or number.",
      ],
      invalid_password: [
        "密码需为 15–128 个字符，可使用长句作为密码。",
        "Use a password of 15–128 characters. A long passphrase works well.",
      ],
      password_mismatch: [
        "两次输入的密码不一致。",
        "The passwords do not match.",
      ],
      invalid_credentials: [
        "用户名或密码不正确。",
        "Incorrect username or password.",
      ],
      username_unavailable: [
        "这个用户名暂时不可用，请换一个。",
        "That username is unavailable. Please choose another.",
      ],
      invalid_current_password: [
        "当前密码不正确。",
        "The current password is incorrect.",
      ],
      invalid_recovery: [
        "用户名或恢复码不正确，已使用的恢复码无法再次使用。",
        "Incorrect username or recovery code. Used recovery codes cannot be reused.",
      ],
      google_already_linked: [
        "这个 Google 账号已有关联，未更改任何绑定。请登录原账号查看。",
        "This Google identity is already linked. No links were changed.",
      ],
      last_login_method: [
        "请先设置账号密码，再解绑 Google。",
        "Set an account password before unlinking Google.",
      ],
      reauth_required: [
        "请重新登录后再修改登录方式。",
        "Sign in again before changing login methods.",
      ],
      rate_limited: [
        "请求较多，请稍后重试。",
        "Too many attempts. Please try again later.",
      ],
      watch_limit: [
        "合并后超过 100 个关注商品，请先调整清单再合并。原数据已保留。",
        "The merged list would exceed 100 watches. Adjust the lists before merging.",
      ],
      login_required: [
        "登录已过期，请重新登录。",
        "Your session expired. Please sign in again.",
      ],
    };
    return words(
      ...(messages[code] || [
        "暂时没有连接成功，请稍后重试。",
        "Could not connect. Please try again.",
      ]),
    );
  }
  async function post(path: string, data: unknown) {
    const response = await fetch(path, {
      method: "POST",
      credentials: "same-origin",
      headers: {
        "Content-Type": "application/json",
        ...(profile?.csrf ? { "X-CSRF-Token": profile.csrf } : {}),
      },
      body: JSON.stringify(data),
    });
    const body = await response.json();
    if (!response.ok) throw Error(body.error || "unavailable");
    return body;
  }
  async function refresh(broadcast = false) {
    const response = await fetch("/api/v1/account", {
      credentials: "same-origin",
      cache: "no-store",
    });
    if (!response.ok) throw Error("unavailable");
    const next = await response.json();
    await adoptAccount(next, { broadcast });
    queryClient.setQueryData(["account"], next);
    window.dispatchEvent(new CustomEvent("account-changed", { detail: next }));
  }
  async function save(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setStatus("");
    try {
      await post("/api/v1/account", { nickname, listed });
      await refresh();
      setStatus(
        words(
          "已保存。历史贡献会自动计入。",
          "Saved. Your earlier contributions are included.",
        ),
      );
    } catch (error) {
      setStatus(message((error as Error).message));
    } finally {
      setBusy(false);
    }
  }
  async function action(kind: "connect" | "claim" | "logout") {
    setBusy(true);
    setLinkStatus("");
    try {
      if (kind === "connect") {
        const result = await post("/api/v1/account/link", {});
        const url = new URL(result.url);
        if (url.origin !== "https://mxd.ruit.me" || url.pathname !== "/account")
          throw Error("unavailable");
        location.assign(url);
      } else {
        if (kind === "logout") await beforeSignOut();
        await post(
          kind === "claim" ? "/api/v1/account/link" : "/api/v1/account/logout",
          kind === "claim" ? { code: link } : {},
        );
        if (kind === "claim") navigate("/account", { replace: true });
        if (kind === "logout") setRecoveryCode(null);
        await refresh(kind === "logout");
        if (kind === "claim")
          setLinkStatus(
            words(
              "绑定成功，历史贡献已合并。",
              "Linked. Your earlier contributions are now combined.",
            ),
          );
      }
    } catch (error) {
      setLinkStatus(message((error as Error).message));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Stall title={words("我的", "My profile")} className="account-stall" h1>
      <div
        className={
          "account-body" + (profile?.signed_in ? " account-dashboard" : "")
        }
        data-account
      >
        {account.isError ? (
          <ErrorState retry={() => void account.refetch()} />
        ) : !profile ? (
          <Loading />
        ) : !profile.signed_in ? (
          <>
            <p>
              {words(
                "登录后，关注商品、目标价、提醒开关和常用偏好会跟随账号同步。也可以绑定采集器，合并你的采集贡献。",
                "Sign in to sync watches, target prices, alerts and preferences. Link collectors to combine your contributions.",
              )}
            </p>
            <AuthForm {...access} />
            {profile.google_enabled ? (
              <a
                className="btn google-signin"
                href={
                  "/auth/google/start" +
                  (link ? "?link=" + encodeURIComponent(link) : "")
                }
              >
                <span aria-hidden="true">G</span>
                {words("使用 Google 登录", "Sign in with Google")}
              </a>
            ) : (
              <p className="note">{message("google_unavailable")}</p>
            )}
            <p className="note">
              <SiteLink href="/privacy">
                {words("账号隐私说明", "Account privacy")}
              </SiteLink>
            </p>
            {params.has("error") && (
              <p role="alert">{message(params.get("error")!)}</p>
            )}
            <section className="well account-help">
              <h3>{words("只想用昵称？也可以", "Prefer just a nickname?")}</h3>
              <p>
                {words(
                  "打开 Windows 采集器，点网页右上角的头像图标进入「我的」，输入昵称即可。已有采集记录会自动计入。",
                  "Open the Windows collector, select the profile icon at the top right, and enter a nickname. Your earlier contributions will count too.",
                )}
              </p>
              <a href="/web/download.html">
                {words(
                  "下载采集器与使用说明",
                  "Download collector & instructions",
                )}{" "}
                →
              </a>
            </section>
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
            <section
              className="account-profile"
              aria-label={words("采集名片", "Contributor profile")}
            >
              <div className="account-identity">
                <span className="account-avatar">
                  <Icon name="leaf" size={28} />
                </span>
                <div className="account-name">
                  <span className="account-eyebrow">
                    {words("采集者", "CONTRIBUTOR")}
                  </span>
                  <h2>
                    {profile.nickname ||
                      words("枫叶冒险家", "Maple adventurer")}
                  </h2>
                  <span className="account-membership">
                    {profile.listed
                      ? words("已加入贡献榜", "On the contributor board")
                      : words("尚未公开采集成绩", "Contributions are private")}
                  </span>
                </div>
              </div>
              <div className="contributor-stats">
                <div>
                  <strong>{num(profile.stats?.shops || 0)}</strong>
                  <span>{words("累计采集摊位", "Shops contributed")}</span>
                </div>
                <div>
                  <strong>{num(profile.stats?.quotes || 0)}</strong>
                  <span>{words("有效报价条目", "Distinct offers")}</span>
                </div>
              </div>
              <div className="account-profile-actions">
                <button
                  type="button"
                  data-edit-profile
                  disabled={busy}
                  aria-expanded={editing}
                  aria-controls="account-profile-editor"
                  onClick={() => {
                    if (editing) {
                      setNickname(profile.nickname || "");
                      setListed(Boolean(profile.listed));
                      setStatus("");
                    }
                    setEditing(!editing);
                  }}
                >
                  <Pencil size={15} aria-hidden="true" />
                  {editing
                    ? words("取消编辑", "Cancel editing")
                    : words("编辑资料", "Edit profile")}
                </button>
                <SiteLink href="/contributors">
                  {words("查看贡献榜", "Contributor board")}
                  <ArrowUpRight size={15} aria-hidden="true" />
                </SiteLink>
              </div>
              <form
                id="account-profile-editor"
                hidden={!editing}
                data-profile
                onSubmit={save}
              >
                <label htmlFor="contributor-nickname">
                  {words("昵称", "Nickname")}
                  {profile.temporary &&
                    " · " + words("临时昵称", "Temporary nickname")}
                </label>
                <input
                  id="contributor-nickname"
                  name="nickname"
                  required
                  minLength={2}
                  maxLength={24}
                  autoComplete="nickname"
                  value={nickname}
                  onChange={(event) => setNickname(event.target.value)}
                  disabled={local && profile.linked}
                  placeholder={words(
                    "大家怎么称呼你？",
                    "What should we call you?",
                  )}
                />
                {profile.temporary && (
                  <p className="note">
                    {words(
                      "随机昵称，随时可以修改。",
                      "A randomly assigned nickname. Make it your own anytime.",
                    )}
                  </p>
                )}
                <label className="account-opt">
                  <input
                    type="checkbox"
                    name="listed"
                    checked={listed}
                    onChange={(event) => setListed(event.target.checked)}
                    disabled={local && profile.linked}
                  />
                  <span>
                    {words("加入采集贡献榜", "Join the contributor board")}
                    <small>
                      {words(
                        "仅公开昵称和成绩，随时可以退出。",
                        "Only your nickname and stats are public. Leave anytime.",
                      )}
                    </small>
                  </span>
                </label>
                {local && profile.linked ? (
                  <a
                    className="btn"
                    href="https://mxd.ruit.me/account"
                    target="_blank"
                    rel="noopener"
                  >
                    {words("去官网修改", "Edit on website")} ↗
                  </a>
                ) : (
                  <Button variant="primary" type="submit" disabled={busy}>
                    {words("保存修改", "Save changes")}
                  </Button>
                )}
                <p className="account-status" role="status" aria-live="polite">
                  {status}
                </p>
              </form>
            </section>
            <div className="account-settings">
              {!local && <SyncPanel message={message} />}
              <AccountSetting
                name="collectors"
                icon={<Monitor size={20} />}
                title={words("我的采集器", "My collectors")}
                meta={
                  local
                    ? profile.linked
                      ? words("已绑定账号", "Account linked")
                      : words(
                          "绑定账号，合并多台设备的贡献",
                          "Link to combine contributions",
                        )
                    : words(
                        `已绑定 ${profile.collectors || 0} 台设备`,
                        `${profile.collectors || 0} linked devices`,
                      )
                }
                attention={Boolean(link || linkStatus)}
              >
                {local ? (
                  profile.linked ? (
                    <p>
                      {words(
                        "已绑定账号，历史贡献已合并。",
                        "Linked to your account. Earlier contributions are included.",
                      )}
                    </p>
                  ) : (
                    <>
                      <p>
                        {words(
                          "这台采集器的历史记录会归到你的昵称下。绑定账号后，可以把不同电脑的贡献合在一起。",
                          "This collector’s history counts toward your nickname. Link an account to combine contributions from multiple computers.",
                        )}
                      </p>
                      <Button
                        data-connect
                        disabled={busy}
                        onClick={() => void action("connect")}
                      >
                        {words("绑定账号", "Link account")}
                      </Button>
                    </>
                  )
                ) : (
                  <>
                    {link ? (
                      <>
                        <Button
                          variant="primary"
                          data-claim
                          disabled={busy}
                          onClick={() => void action("claim")}
                        >
                          {words(
                            "确认绑定这台采集器",
                            "Confirm linking this collector",
                          )}
                        </Button>
                        <p className="note">
                          {words(
                            "绑定后，这台采集器以往和今后的贡献都会计入你的账号。",
                            "This collector’s past and future contributions will belong to your account.",
                          )}
                        </p>
                      </>
                    ) : (
                      <p>
                        {words(
                          "在采集器打开的网页中进入「我的」，点击「绑定账号」。",
                          "In the page opened by your collector, choose My profile → Link account.",
                        )}
                      </p>
                    )}
                  </>
                )}
                <p role="status" data-link-status>
                  {linkStatus}
                </p>
              </AccountSetting>
              {!local && <SecurityPanel {...access} profile={profile} />}
            </div>
            <div className="account-footer">
              <SiteLink href="/privacy">
                {words("账号隐私说明", "Account privacy")}
              </SiteLink>
              {!local && (
                <button
                  data-logout
                  disabled={busy}
                  onClick={() => void action("logout")}
                >
                  {words("退出登录", "Sign out")}
                </button>
              )}
            </div>
          </>
        )}
      </div>
    </Stall>
  );
}

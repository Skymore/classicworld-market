import { useEffect, useState, type FormEvent } from "react";
import { useLocation, useNavigate, useSearchParams } from "react-router-dom";
import { Bell, Monitor, Pencil, ArrowUpRight } from "lucide-react";
import { useAccount } from "../lib/query";
import { beforeSignOut } from "/web/js/lib/user-data.js";
import { isLocalGateway, releasePushForSignOut } from "../lib/push";
import { embedded } from "../lib/embed";
import {
  NotificationSettings,
  useNotificationSummary,
} from "../components/notification-settings";
import {
  AuthForm,
  RecoveryNotice,
  SyncPanel,
  SecurityPanel,
  AccountSetting,
  accountMessage,
  postAccount,
  refreshAccount,
} from "./account-access";
import { DevicesPanel } from "./account-devices";
import { takeReturn } from "../lib/return-to";
import { useWords } from "../providers";
import { SiteLink } from "../components/shell";
import {
  Stall,
  Loading,
  ErrorState,
  Count,
  usePageReady,
  Icon,
} from "../components/shared";
import { Button } from "../components/ui/button";

/** 我的 → 通知: which device gets watch alerts, and how. */
function NotificationsPanel() {
  const words = useWords();
  const summary = useNotificationSummary();
  const route = useLocation();
  const wanted = route.hash === "#notifications";
  useEffect(() => {
    if (wanted)
      document.getElementById("notifications")?.scrollIntoView({ block: "start" });
  }, [wanted]);
  return (
    <AccountSetting
      name="notifications"
      id="notifications"
      icon={<Bell size={20} />}
      title={words("通知", "Notifications")}
      meta={summary}
      attention={wanted}
    >
      <p>
        {isLocalGateway
          ? words(
              "关注的物品出现符合条件的新报价时，弹出系统通知。需要保持本站任意页面打开。",
              "When a watched item gets a matching offer, a system notification pops up. Keep any page of this site open.",
            )
          : words(
              "关注的物品出现符合条件的新报价时，推送到这台设备，关掉网页也能收到。",
              "When a watched item gets a matching offer, it is pushed to this device, even with the site closed.",
            )}
      </p>
      <NotificationSettings />
      <SiteLink href="/watch">
        {words("在「关注」里选择哪些物品提醒", "Choose which items alert you in Watch")} →
      </SiteLink>
    </AccountSetting>
  );
}

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
  const message = (code: string) => accountMessage(words, code);
  const post = (path: string, data: unknown) =>
    postAccount(profile?.csrf, path, data);
  const refresh = refreshAccount;
  const access = { profile, post, refresh, message, recover: setRecoveryCode };
  // Google sign-in always lands here; go back to the page that started it.
  useEffect(() => {
    if (!profile?.signed_in || link) return;
    const back = takeReturn();
    if (back) navigate(back, { replace: true });
  }, [profile?.signed_in]);
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
        if (url.origin !== "https://mxd.ruit.me" || url.pathname !== "/device")
          throw Error("unavailable");
        location.assign(url);
      } else {
        if (kind === "logout") {
          await releasePushForSignOut(profile?.csrf);
          await beforeSignOut();
        }
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
            {isLocalGateway && !embedded && (
              <div className="account-settings">
                <NotificationsPanel />
              </div>
            )}
            <section className="well account-help">
              <h3>{words("只想用昵称？也可以", "Prefer just a nickname?")}</h3>
              <p>
                {words(
                  "在 Windows 采集器的「我的」里填昵称，已有采集记录会自动计入。",
                  "Set a nickname under Profile in the Windows collector; earlier contributions count too.",
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
                  <strong><Count n={profile.stats?.shops || 0} /></strong>
                  <span>{words("累计采集摊位", "Shops contributed")}</span>
                </div>
                <div>
                  <strong><Count n={profile.stats?.quotes || 0} /></strong>
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
              {!local && <DevicesPanel profile={profile} message={message} />}
              {!embedded && <NotificationsPanel />}
              {/* Collectors on old versions still link through ?link=. */}
              {(local || link || linkStatus) && <AccountSetting
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
              </AccountSetting>}
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

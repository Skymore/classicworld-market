import {
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type FormEvent,
} from "react";
import { createAlertsStore } from "/web/js/lib/collector-alert-store.js";
import { t, itemName } from "/web/js/lib/i18n.js";
import { ago, fullTime, meso } from "/web/js/lib/format.js";
import { api, qs } from "/web/js/lib/api.js?v=20261022-auto-watch-2";
import { useMarketQuery } from "../lib/query";
import { useWords } from "../providers";
import { Slot, Price, Empty, usePageReady } from "../components/shared";
import { Location } from "../components/list-rows";
import { announce, OfferReminder } from "../components/toasts";
import "../lib/list-copy";
const pct = (value: number) =>
  `${value >= 0 ? "+" : ""}${Number(value).toFixed(1)}%`;
function Status({ status }: { status: any }) {
  const words = useWords();
  if (!status) return null;
  const health = status.connection_health || {},
    location = status.location || health.location;
  const labels: Record<string, [string, string]> = {
    no_game: [
      "尚无游戏频道连接，请启动游戏并切换频道",
      "No game channel connection; start the game and change channel",
    ],
    no_inbound: [
      "游戏已连接但未收到入站包，请检查代理或防火墙策略",
      "Game connected but no inbound packets; check proxy or firewall policy",
    ],
    offline: [
      "采集器未运行或状态已过期",
      "Collector offline or status expired",
    ],
    waiting: ["等待游戏连接", "Waiting for game connection"],
    handshake: [
      "等待重新连接游戏",
      "Reconnect the game to capture its handshake",
    ],
    connected: [
      "游戏已连接，等待新摊位记录",
      "Game connected; waiting for a new shop",
    ],
    capturing: ["已记录新的摊位商品", "New shop items recorded"],
    parse_error: ["解析异常，需要重连游戏", "Decode error; reconnect the game"],
    observed: ["已收到你的商品观察", "Your shop observations were received"],
    no_observations: [
      "尚未收到你的商品观察",
      "No observations received from your collector",
    ],
  };
  return (
    <div className="collector-status" role="status">
      <b>
        {words(
          ...(labels[health.state] || [
            health.message || "采集状态待确认",
            health.message_en || "Collector status unconfirmed",
          ]),
        )}
      </b>
      <span>
        {location ? (
          <>
            {words("最近位置：", "Last location: ")}
            <Location value={location} />
          </>
        ) : (
          words("位置待识别", "Location unknown")
        )}
      </span>
      {status.last_shop_at && (
        <span>
          {words("最近商品：", "Last shop: ")}
          <time title={fullTime(status.last_shop_at)}>
            {ago(status.last_shop_at)}
          </time>
        </span>
      )}
      <small>
        {status.local_collector
          ? words("本机采集状态", "Capture status from this PC")
          : words(
              "根据服务端接收记录；不能据此确认本机驱动仍在运行。",
              "Based on received observations; this does not confirm the local capture process is running.",
            )}
      </small>
    </div>
  );
}
function Deal({ row, history }: { row: any; history: boolean }) {
  const words = useWords();
  const catalog = useMarketQuery<any>(
    api.watchCatalog() + qs({ q: row.item_id }),
    true,
    false,
  );
  const item = {
    item_id: row.item_id,
    name_zh: row.name,
    ...catalog.data?.items?.find((item: any) => item.item_id === row.item_id),
  };
  return (
    <article className="well dcard" data-deal={row.id}>
      <div className="wc-head">
        <Slot url={item.icon_url} size={32} />
        <a className="wc-name" href={"/item/" + Number(row.item_id)}>
          <b>{itemName(item)}</b>
          <small>
            {[
              document.documentElement.lang === "en"
                ? item.name_zh
                : item.name_en,
              row.item_id,
            ]
              .filter(Boolean)
              .join(" · ")}
          </small>
        </a>
        <span
          className="dc-margin"
          title={t("alerts.after_fee", { pct: pct(row.margin) })}
        >
          {pct(row.margin)}
        </span>
      </div>
      <div className="wc-nums">
        <span>
          <small>{t("alerts.buy")}</small>
          <b>
            <Price value={row.buy} />
          </b>
          <em>
            {row.bundle > 1 &&
              t("alerts.bundle", {
                n: row.bundle,
                cost: meso(row.bundle_cost),
              }) + " · "}
            {t("alerts.stock", { n: row.stock })}
          </em>
        </span>
        <span className="hit">
          <small>
            {row.fast_sell == null
              ? words("旧版参考售价", "Legacy reference")
              : t("alerts.fast")}
          </small>
          <b>
            <Price value={row.fast_sell ?? row.sell} />
          </b>
          <em>{t("alerts.after_fee", { pct: pct(row.margin) })}</em>
        </span>
        <span>
          <small>{t("alerts.normal")}</small>
          <b>
            <Price value={row.normal_sell} />
          </b>
          <em>{t("alerts.after_fee", { pct: pct(row.normal_margin) })}</em>
        </span>
      </div>
      <div className="dc-where">
        <span className="ss">{row.shop}</span>
        <Location value={row.location} />
        <time title={fullTime(row.observed)}>
          {t("alerts.found", { ago: ago(row.observed) })}
        </time>
      </div>
      {(history || Date.now() / 1000 - row.observed > 120) && (
        <p className="deal-history-note">
          {words(
            "历史发现，请在游戏中重新核对库存与价格。",
            "Historical find; verify stock and price in game.",
          )}
        </p>
      )}
      <p className="dc-basis">
        <b>
          {t("alerts.counts", {
            shops: row.shops,
            listings: row.listing_count,
            qty: row.listed_quantity,
            q1: meso(row.q1),
          })}
        </b>
        <span>
          {words(
            row.basis || "",
            "Compared with earlier offers from other shops (this shop excluded). The quick-sell price triggers the alert and the normal-sell price shows the higher reference; shops, listings and stock on sale are listed, and the margin is after the 3% fee.",
          )}
        </span>
      </p>
    </article>
  );
}
export default function Alerts() {
  usePageReady();
  const words = useWords();
  const [store] = useState(() =>
    createAlertsStore((row: any, settings: any) => {
      const title = t("alerts.toast_title"),
        line = t("alerts.toast_line", {
          buy: meso(row.buy),
          sell: meso(row.fast_sell),
          pct: pct(row.margin),
        });
      if (settings.page)
        announce(
          title,
          "/item/" + row.item_id,
          <OfferReminder row={{ ...row, name_zh: row.name, unit_price: row.buy }} />,
        );
      if (
        settings.desktop &&
        "Notification" in window &&
        Notification.permission === "granted"
      )
        try {
          new Notification(title, {
            body: `${row.name} · ${line} · ${row.shop}`,
            tag: row.id,
          });
        } catch {}
    }),
  );
  const state = useSyncExternalStore<any>(store.subscribe, store.getSnapshot);
  useEffect(() => () => store.dispose(), [store]);
  const [permission, setPermission] = useState(() =>
      typeof Notification === "undefined"
        ? "unsupported"
        : Notification.permission,
    ),
    [input, setInput] = useState("");
  const tokenInput = useRef<HTMLInputElement>(null);
  const settings = state.profile?.settings || {
    enabled: true,
    page: true,
    desktop: true,
  };
  const shown = state.historyView
    ? state.profile?.archive.slice(0, state.historyLimit) || []
    : state.deals;
  function connect(event: FormEvent) {
    event.preventDefault();
    const next = input.trim();
    if (next.length < 30 || next.length > 128) {
      tokenInput.current?.setCustomValidity(t("alerts.token_bad"));
      tokenInput.current?.reportValidity();
      return;
    }
    setInput("");
    void store.setToken(next);
  }
  const setup = !state.connected || state.problem === "invalid";
  return (
    <div className="lwrap alerts-page">
      <section className="stall lpage" data-panel>
        <div className="stall-bar">
          <h1>{t("alerts.title")}</h1>
          {!setup && (
            <span className="bar-meta">
              {state.historyView
                ? words(
                    `${state.profile?.archive.length || 0} 条 · 保留24小时`,
                    `${state.profile?.archive.length || 0} · kept for 24 h`,
                  )
                : t("alerts.meta", { n: state.deals.length })}
            </span>
          )}
        </div>
        {setup ? (
          <div className="asetup">
            <h2>{t("alerts.setup_title")}</h2>
            {state.problem === "invalid" && (
              <p className="awarn" role="alert">
                {t("alerts.token_invalid")}
              </p>
            )}
            <p>{t("alerts.setup_intro")}</p>
            <p>
              {words(
                "采集按你的采集器规则筛选非装备价差。想为装备或其他物品设置个人价格上限，请使用「关注」；保持关注页打开才会检查新报价并提醒。关注设置仅保存在当前浏览器。",
                "Collect evaluates non-equipment margins from your collector. For personal price caps on any item, use Watch; keep its page open for new-offer notifications. Watch settings stay in your browser.",
              )}
            </p>
            <div className="well astep">
              <h3>{t("alerts.setup_browser")}</h3>
              <p>{t("alerts.setup_browser_text")}</p>
              <a className="btn primary" href="/collect/">
                {t("alerts.setup_open")}
              </a>
            </div>
            <div className="well astep">
              <h3>{t("alerts.setup_divert")}</h3>
              <p>{t("alerts.setup_divert_text")}</p>
              <a className="btn primary" href="/web/download.html">
                {words("下载采集器与使用说明", "Download & instructions")}
              </a>
              <a className="btn" href="http://127.0.0.1:8780/alerts">
                {t("alerts.setup_local")}
              </a>
              <p className="fnote">{t("alerts.setup_local_hint")}</p>
            </div>
            <details className="well amanual">
              <summary>{t("alerts.manual")}</summary>
              <p>{t("alerts.manual_intro")}</p>
              <form className="astep atoken" data-token-form onSubmit={connect}>
                <label htmlFor="alerts-token">
                  <b>{t("alerts.token_label")}</b>
                </label>
                <div className="arow">
                  <input
                    id="alerts-token"
                    type="password"
                    autoComplete="off"
                    spellCheck={false}
                    minLength={30}
                    maxLength={128}
                    aria-describedby="alerts-token-hint"
                    required
                    data-token-input
                    ref={tokenInput}
                    value={input}
                    onChange={(event) => {
                      setInput(event.target.value);
                      event.target.setCustomValidity("");
                    }}
                  />
                  <button className="btn" type="submit">
                    {t("alerts.token_save")}
                  </button>
                </div>
                <p id="alerts-token-hint" className="fnote">
                  {t("alerts.token_hint")}
                </p>
                {state.token && (
                  <button
                    className="btn"
                    type="button"
                    data-token-clear
                    onClick={() => void store.setToken(null)}
                  >
                    {t("alerts.token_clear")}
                  </button>
                )}
              </form>
            </details>
            <p className="fnote">{t("alerts.rules")}</p>
          </div>
        ) : (
          <>
            <div className="deal-toolbar">
              <div
                className="chips"
                role="group"
                aria-label={words("采集记录", "Deal records")}
              >
                {[
                  ["live", "最新发现", "Live finds"],
                  ["history", "24小时历史", "24 h history"],
                ].map(([key, zh, en]) => (
                  <button
                    className={
                      "chip " +
                      ((key === "history") === state.historyView ? "on" : "")
                    }
                    data-alert-view={key}
                    aria-pressed={(key === "history") === state.historyView}
                    key={key}
                    onClick={() => store.view(key === "history")}
                  >
                    {words(zh, en)}{" "}
                    {(key === "history" && state.profile?.archive.length) || ""}
                  </button>
                ))}
              </div>
              <div className="deal-switches">
                {[
                  ["enabled", "启用采集提醒", "Enable deal alerts"],
                  ["page", "页面弹窗", "Page popups"],
                  ["desktop", "桌面通知", "Desktop notifications"],
                ].map(([key, zh, en]) => (
                  <label key={key}>
                    <input
                      type="checkbox"
                      data-deal-setting={key}
                      checked={!!settings[key]}
                      disabled={key !== "enabled" && !settings.enabled}
                      onChange={(event) =>
                        store.setting(key, event.target.checked)
                      }
                    />
                    {words(zh, en)}
                  </label>
                ))}
                {permission === "default" && (
                  <button
                    className="btn"
                    data-notification-allow
                    onClick={() =>
                      Notification.requestPermission().then(setPermission)
                    }
                  >
                    {words("允许桌面通知", "Allow desktop notifications")}
                  </button>
                )}
              </div>
              <p className="deal-help">
                {words(
                  "历史和开关仅保存在此浏览器，按采集身份区分。关闭提醒仍会记录历史。",
                  "History and switches stay in this browser, separated by collector identity. Muting alerts still records history.",
                )}{" "}
                {permission === "denied"
                  ? words(
                      "桌面通知被浏览器阻止，可在网站权限中开启。",
                      "Desktop notifications are blocked in site permissions.",
                    )
                  : permission === "unsupported"
                    ? words(
                        "此浏览器不支持桌面通知。",
                        "This browser does not support desktop notifications.",
                      )
                    : ""}
                {!state.storageOkay &&
                  words(
                    "浏览器无法保存，当前仅在本页临时保留。",
                    "Browser storage is unavailable; changes last only for this page.",
                  )}
              </p>
            </div>
            <Status status={state.collectorStatus} />
            <p className="sale-note">
              {words(
                "采集使用你的采集器规则筛选非装备价差；需要为任意物品设置个人价格上限，请使用「关注」。关注设置仅存当前浏览器。",
                "Collect uses your collector’s non-equipment margin rules. For any item with a personal price cap, use Watch. Watch settings are saved only in this browser.",
              )}
            </p>
            <div className="ltools atools">
              <span className="alabel">{t("alerts.window")}</span>
              <div className="chips">
                {["72", "all"].map((hours) => (
                  <button
                    className={"chip " + (state.hours === hours ? "on" : "")}
                    data-hours={hours}
                    aria-pressed={state.hours === hours}
                    key={hours}
                    onClick={() => store.setHours(hours)}
                  >
                    {t("alerts.window_" + hours)}
                  </button>
                ))}
              </div>
              <span className="sp" />
              <span className="astatus" role="status">
                {state.problem
                  ? t(
                      state.problem === "limited"
                        ? "alerts.limited"
                        : "alerts.failed",
                    )
                  : state.checkedAt
                    ? t("alerts.checked", {
                        time: new Date(
                          state.checkedAt * 1000,
                        ).toLocaleTimeString(),
                      })
                    : ""}
              </span>
            </div>
            {shown.length ? (
              <div className="wcards">
                {shown.map((row: any) => (
                  <Deal key={row.id} row={row} history={state.historyView} />
                ))}
              </div>
            ) : (
              <Empty
                text={
                  state.first
                    ? t("common.loading")
                    : state.historyView
                      ? words(
                          "还没有保存的采集提醒历史。",
                          "No saved deal history yet.",
                        )
                      : t("alerts.empty")
                }
              />
            )}
            {state.historyView &&
              state.profile.archive.length > state.historyLimit && (
                <button
                  className="more"
                  data-history-more
                  onClick={() => store.more()}
                >
                  {words("显示更多历史", "Show more history")} (
                  {state.historyLimit}/{state.profile.archive.length})
                </button>
              )}
            <p className="sale-note">{t("alerts.rules")}</p>
          </>
        )}
      </section>
    </div>
  );
}

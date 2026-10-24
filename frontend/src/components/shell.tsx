import { useEffect, useState } from "react";
import { Link, useLocation } from "react-router-dom";
import { ago, fullTime } from "/web/js/lib/format.js";
import { useAccount } from "../lib/query";
import { usePreferences, useWords } from "../providers";
import { Icon, Search } from "./shared";

const navigation = [
  ["home", "/", "首页", "Home", "home"],
  ["prices", "/prices", "价格表", "Prices", "tag"],
  ["agent", "/agent", "助手", "Assistant", "search"],
  ["dex", "/search?kind=item", "图鉴", "Catalogue", "book"],
  ["watch", "/watch", "关注", "Watch", "star"],
  ["alerts", "/alerts", "采集", "Collect", "coin"],
];
export function Freshness() {
  const [at, setAt] = useState<number | null>(
    () => Number(document.documentElement.dataset.freshness) || null,
  );
  const [, tick] = useState(0);
  const words = useWords();
  useEffect(() => {
    const update = (event: Event) => {
      const value = (event as CustomEvent).detail;
      setAt(value == null ? null : Number(value));
    };
    document.addEventListener("market-freshness", update);
    const timer = setInterval(() => tick((n) => n + 1), 30_000);
    return () => {
      document.removeEventListener("market-freshness", update);
      clearInterval(timer);
    };
  }, []);
  return (
    <span
      className="fresh"
      data-fresh
      hidden={at === null}
      data-as-of={at ?? undefined}
      title={at == null ? undefined : fullTime(at)}
    >
      <i />
      <span>
        {at == null ? "" : words(`数据 ${ago(at)}更新`, `updated ${ago(at)}`)}
      </span>
    </span>
  );
}
function Preferences() {
  const { toggleTheme, changeLanguage, language } = usePreferences();
  const words = useWords();
  const account = useAccount();
  const [live, setLive] = useState(
    document.documentElement.dataset.liveConnection || "connecting",
  );
  useEffect(() => {
    const update = (event: Event) => setLive((event as CustomEvent).detail);
    document.addEventListener("market-stream", update);
    return () => document.removeEventListener("market-stream", update);
  }, []);
  const label = account.data?.signed_in
    ? words("我的", "My account")
    : words("登录账号", "Sign in to your account");
  return (
    <span className="prefs">
      <span
        className="live-status"
        data-live-status
        data-state={live}
        title={words("实时数据连接", "Live market updates")}
        aria-label={words("实时数据连接", "Live market updates")}
      >
        ●
      </span>
      <button
        className="iconbtn"
        type="button"
        data-lang-toggle
        aria-label={
          language === "zh" ? "切换语言 / English" : "Switch language / 中文"
        }
        title={
          language === "zh" ? "切换语言 / English" : "Switch language / 中文"
        }
        onClick={changeLanguage}
      >
        <span className="pref-glyph pref-language" aria-hidden="true" />
      </button>
      <button
        className="iconbtn"
        type="button"
        data-theme-toggle
        aria-label={words("切换夜市主题", "Toggle night market theme")}
        title={words("切换夜市主题", "Toggle night market theme")}
        onClick={toggleTheme}
      >
        <span className="pref-glyph pref-theme" aria-hidden="true" />
      </button>
      <SiteLink
        href="/account"
        className="iconbtn account-link"
        data-account-link
        aria-label={label}
        title={label}
      >
        <span className="pref-glyph pref-account" aria-hidden="true" />
      </SiteLink>
    </span>
  );
}
export function SiteLink({
  href,
  children,
  ...props
}: React.ComponentProps<"a"> & { href: string }) {
  const { server, language } = usePreferences();
  const path = href.split("?")[0];
  const isCatalogue = ["/search", "/item", "/mob", "/map", "/route"].some(
    (prefix) => path === prefix || path.startsWith(prefix + "/"),
  );
  const url = new URL(href, location.href);
  if (isCatalogue && language === "en") url.searchParams.set("lang", "en");
  const target = url.pathname + url.search + url.hash;
  if (
    server ||
    url.origin !== location.origin ||
    (path.startsWith("/web/") && path !== "/web/download.html")
  )
    return (
      <a href={url.origin === location.origin ? target : href} {...props}>
        {children}
      </a>
    );
  return (
    <Link to={target} {...props}>
      {children}
    </Link>
  );
}
function Brand({ size }: { size: number }) {
  const words = useWords();
  return (
    <SiteLink className="brand" href="/">
      <Icon name="leaf" size={size} />
      <span>{words("枫叶市集", "Maple Market")}</span>
    </SiteLink>
  );
}
export function Navigation({ dock = false }: { dock?: boolean }) {
  const { language } = usePreferences();
  const path = useLocation().pathname;
  const active = path.startsWith("/agent")
    ? "agent"
    : path.startsWith("/prices") || path.startsWith("/sales")
      ? "prices"
      : path.startsWith("/watch")
        ? "watch"
        : path.startsWith("/alerts")
          ? "alerts"
          : path === "/" || path === "/v2"
            ? "home"
            : ["/search", "/item", "/mob", "/map", "/route"].some(
                  (prefix) => path === prefix || path.startsWith(prefix + "/"),
                )
              ? "dex"
              : null;
  const [hits, setHits] = useState(() => {
    try {
      return Number(localStorage.getItem("watch_hits")) || 0;
    } catch {
      return 0;
    }
  });
  useEffect(() => {
    const update = (event: Event) => {
      try {
        if (event.type === "watchchange") localStorage.removeItem("watch_hits");
        setHits(Number(localStorage.getItem("watch_hits")) || 0);
      } catch {
        setHits(0);
      }
    };
    document.addEventListener("watchchange", update);
    document.addEventListener("navigation-badge", update);
    window.addEventListener("storage", update);
    return () => {
      document.removeEventListener("watchchange", update);
      document.removeEventListener("navigation-badge", update);
      window.removeEventListener("storage", update);
    };
  }, []);
  return (
    <>
      {navigation.map(([key, href, zh, en, icon]) => (
        <SiteLink
          key={key}
          href={href}
          className={active === key ? "on" : ""}
          data-nav-key={key}
          aria-current={active === key ? "page" : undefined}
        >
          {dock && <Icon name={icon} />}
          <span>{language === "en" ? en : zh}</span>
          {dock && key === "watch" && (
            <span className="badge" data-badge="watch" hidden={!hits}>
              {hits || ""}
            </span>
          )}
        </SiteLink>
      ))}
    </>
  );
}
export function PhoneHeader() {
  return (
    <>
      <Brand size={22} />
      <Freshness />
      <Preferences />
    </>
  );
}
export function DesktopHeader() {
  const words = useWords();
  return (
    <div className="in">
      <Brand size={26} />
      <nav className="dnav" aria-label={words("主导航", "Main navigation")}>
        <Navigation />
      </nav>
      <Search />
      <Freshness />
      <Preferences />
    </div>
  );
}
export function AppShell({ children }: { children: React.ReactNode }) {
  const words = useWords();
  const route = useLocation();
  useEffect(() => {
    const keydown = (event: KeyboardEvent) => {
      if (
        event.key !== "/" ||
        event.ctrlKey ||
        event.metaKey ||
        /INPUT|TEXTAREA|SELECT/.test(document.activeElement?.tagName || "")
      )
        return;
      const input = [
        ...document.querySelectorAll<HTMLInputElement>("input[type=search]"),
      ].find((node) => node.offsetParent !== null);
      if (input) {
        event.preventDefault();
        input.focus();
      }
    };
    document.addEventListener("keydown", keydown);
    return () => document.removeEventListener("keydown", keydown);
  }, []);
  return (
    <>
      <header className="ptop">
        <PhoneHeader />
      </header>
      <header className="dhead">
        <DesktopHeader />
      </header>
      <main
        className={
          "pmain dwrap " +
          (route.pathname.startsWith("/collect")
            ? "c-page"
            : route.pathname === "/web/download.html"
              ? "download-page"
              : "")
        }
        id="main"
      >
        {children}
      </main>
      <nav className="dock" aria-label={words("主导航", "Main navigation")}>
        <Navigation dock />
      </nav>
    </>
  );
}

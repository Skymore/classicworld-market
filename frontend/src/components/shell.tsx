import { useEffect, useState } from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import { ago, fullTime } from "/web/js/lib/format.js";
import { useAccount } from "../lib/query";
import { setAssistantOpen, useAssistantOpen } from "../lib/assistant";
import { embedded } from "../lib/embed";
import { usePreferences, useWords } from "../providers";
import { AssistantDock } from "./assistant-dock";
import { AssistantIcon } from "./assistant-icon";
import { Icon, Search } from "./shared";
import { navSection, sectionHref } from "../lib/page-memory";
import { pick } from "/web/js/lib/i18n.js";

const navigation = [
  ["home", "/", "首页", "Home", "home"],
  ["agent", "/agent", "AI 助手", "Ask AI", "search"],
  ["dex", "/search?kind=item", "图鉴", "Catalogue", "book"],
  ["watch", "/watch", "关注", "Watch", "star"],
  ["tools", "/tools", "工具", "Tools", "tools"],
];
/** The live market connection: connecting, connected or reconnecting. */
function useLiveConnection() {
  const [live, setLive] = useState(
    document.documentElement.dataset.liveConnection || "connecting",
  );
  useEffect(() => {
    const update = (event: Event) => setLive((event as CustomEvent).detail);
    document.addEventListener("market-stream", update);
    return () => document.removeEventListener("market-stream", update);
  }, []);
  return live;
}
export function Freshness() {
  const live = useLiveConnection();
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
  // Pages without market data still show the connection, as words.
  const connection =
    live === "connected"
      ? words("实时更新中", "Live")
      : live === "reconnecting"
        ? words("正在重连", "Reconnecting")
        : words("正在连接", "Connecting");
  return (
    <span
      className="fresh"
      data-fresh
      hidden={at === null}
      data-as-of={at ?? undefined}
      title={at == null ? connection : fullTime(at)}
    >
      <i />
      <span>
        {at == null ? connection : words(`数据 ${ago(at)}更新`, `updated ${ago(at)}`)}
      </span>
    </span>
  );
}
function Preferences() {
  const { toggleTheme, changeLanguage, language, ready } = usePreferences();
  const words = useWords();
  const account = useAccount();
  const live = useLiveConnection();
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
        disabled={!ready}
        aria-label={
          pick("切换语言 / English", "Switch language / 中文")
        }
        title={
          pick("切换语言 / English", "Switch language / 中文")
        }
        onClick={changeLanguage}
      >
        <span className="pref-glyph pref-language" aria-hidden="true" />
      </button>
      <button
        className="iconbtn"
        type="button"
        data-theme-toggle
        disabled={!ready}
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
  const isCatalogue = ["/search", "/item", "/mob", "/map", "/npc", "/route"].some(
    (prefix) => path === prefix || path.startsWith(prefix + "/"),
  );
  const url = new URL(href, location.href);
  if (isCatalogue && language !== "zh") url.searchParams.set("lang", language);
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
const plainClick = (event: React.MouseEvent) =>
  !event.defaultPrevented &&
  event.button === 0 &&
  !event.metaKey &&
  !event.ctrlKey &&
  !event.shiftKey &&
  !event.altKey;
/** A navigation tab returns to that section's last page with its filters and
 * scroll position. On the page it already shows, it scrolls back to the top. */
function useSectionLink() {
  const navigate = useNavigate();
  const { language } = usePreferences();
  return (event: React.MouseEvent, section: string, fallback: string) => {
    if (!plainClick(event)) return;
    event.preventDefault();
    const url = new URL(sectionHref(section, fallback), location.href);
    if (section === "dex" && language !== "zh") url.searchParams.set("lang", language);
    const here = new URL(location.href);
    here.searchParams.delete("embed");
    if (url.pathname + url.search === here.pathname + here.search) {
      window.scrollTo({ top: 0, behavior: "smooth" });
      return;
    }
    navigate(url.pathname + url.search + url.hash, { state: { restore: true } });
  };
}
/** A link to a main section that remembers its last page (see useSectionLink). */
export function SectionLink({
  section,
  href,
  onClick,
  ...props
}: React.ComponentProps<"a"> & { section: string; href: string }) {
  const openSection = useSectionLink();
  return (
    <SiteLink
      {...props}
      href={sectionHref(section, href)}
      onClick={(event) => {
        onClick?.(event);
        openSection(event, section, href);
      }}
    />
  );
}
function Brand({ size }: { size: number }) {
  const words = useWords();
  const openSection = useSectionLink();
  return (
    <SiteLink className="brand" href={sectionHref("home", "/")} onClick={(event) => openSection(event, "home", "/")}>
      <Icon name="leaf" size={size} />
      <span>{words("枫叶市集", "Maple Market")}</span>
    </SiteLink>
  );
}
export function Navigation({ dock = false }: { dock?: boolean }) {
  const { language } = usePreferences();
  const path = useLocation().pathname;
  const assistantOpen = useAssistantOpen();
  // Outside /agent the assistant opens in place (a drawer, or full screen on
  // phones); a modified click still follows the link to the full page.
  const openAssistant = (event: React.MouseEvent) => {
    if (
      path.startsWith("/agent") ||
      event.button !== 0 ||
      event.metaKey ||
      event.ctrlKey ||
      event.shiftKey ||
      event.altKey
    )
      return;
    event.preventDefault();
    setAssistantOpen(!assistantOpen);
  };
  const active = navSection(path);
  const openSection = useSectionLink();
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
          href={key === "agent" ? href : sectionHref(key, href)}
          className={active === key ? "on" : ""}
          data-nav-key={key}
          aria-current={active === key ? "page" : undefined}
          onClick={key === "agent" ? openAssistant : (event) => openSection(event, key, href)}
          aria-expanded={
            key === "agent" && !path.startsWith("/agent")
              ? assistantOpen
              : undefined
          }
        >
          {dock && (
            <span className="dock-icon" aria-hidden="true">
              {key === "agent" ? <AssistantIcon /> : <Icon name={icon} />}
            </span>
          )}
          <span>{pick(zh, en)}</span>
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
function EmbeddedNavigation() {
  const words = useWords(), navigate = useNavigate();
  const route = useLocation();
  return <nav className="embed-nav" aria-label={words("页面导航", "Page navigation")}>
    <button className="btn" type="button" onClick={() => {
      if (Number(window.history.state?.idx) > 0) navigate(-1);
      else navigate("/?embed=1", {replace:true});
    }} disabled={route.pathname === "/" && !(Number(window.history.state?.idx) > 0)}>{words("返回", "Back")}</button>
    <SiteLink className="btn" href="/?embed=1">{words("价格表", "Prices")}</SiteLink>
    <Search />
  </nav>;
}
/** Pages that live under 工具, with the name their breadcrumb shows. */
const TOOL_PAGES: [string, string, string][] = [
  ["/tools/enhancement", "强化计算器", "Enhancement calculator"],
  ["/alerts", "低价提醒", "Deal alerts"],
  ["/collect", "浏览器采集", "Browser collector"],
  ["/web/download.html", "下载采集器", "Download collector"],
  ["/contributors", "采集贡献榜", "Contributors"],
  ["/traffic", "网站流量", "Website traffic"],
];
function toolCrumb(path: string): [string, string] | null {
  const page = TOOL_PAGES.find(
    ([prefix]) => path === prefix || path.startsWith(prefix + "/"),
  );
  return page ? [page[1], page[2]] : null;
}
export function AppShell({ children }: { children: React.ReactNode }) {
  const words = useWords();
  const route = useLocation();
  const navigate = useNavigate();
  useEffect(() => {
    if (!embedded) return;
    const params = new URLSearchParams(route.search);
    if (params.get("embed") === "1") return;
    params.set("embed", "1");
    // Keep the frame layout after refresh without adding a history entry.
    navigate(route.pathname + "?" + params + route.hash, {replace:true, state:route.state});
  }, [navigate, route.pathname, route.search, route.hash, route.state]);
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
      {embedded && route.pathname !== "/watch" && <EmbeddedNavigation />}
      {!embedded && (
        <>
          <header className="ptop">
            <PhoneHeader />
          </header>
          <header className="dhead">
            <DesktopHeader />
          </header>
        </>
      )}
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
        {toolCrumb(route.pathname) && (
          <nav className="tool-breadcrumb" aria-label={words("位置", "Breadcrumb")}>
            <SiteLink href="/tools">{words("工具", "Tools")}</SiteLink>
            <span aria-hidden="true">›</span>
            <span aria-current="page">{words(...toolCrumb(route.pathname)!)}</span>
          </nav>
        )}
        {children}
      </main>
      {!embedded && (
        <>
          <nav className="dock" aria-label={words("主导航", "Main navigation")}>
            <Navigation dock />
          </nav>
          <AssistantDock />
        </>
      )}
    </>
  );
}

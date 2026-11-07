import {
  Component,
  Suspense,
  lazy,
  startTransition,
  use,
  useEffect,
  useLayoutEffect,
  useRef,
  type ComponentType,
  type ReactNode,
} from "react";
import { createRoot } from "react-dom/client";
import {
  BrowserRouter,
  Routes,
  Route,
  useLocation,
  useNavigate,
  useNavigationType,
} from "react-router-dom";
import {
  rememberLocation,
  restoreScroll,
  cancelScrollRestore,
  watchScroll,
} from "./lib/page-memory";
import ItemPreview, { previewEntry } from "./components/item-preview";
import {
  Providers,
  useWords,
  usePreferences,
  initializePreferences,
} from "./providers";
import { AppShell } from "./components/shell";
import { ensureStyle, useStyles } from "./lib/styles";
import { queryClient, prefetchPriceTable } from "./lib/query";
import {
  loadCatalog,
  catalogKey,
  readCatalogSnapshot,
  sameCatalog,
} from "./lib/catalog";
import { CATALOGUE_STYLES, SITE_STYLES } from "./lib/route-styles";
import { WatchAlertsProvider } from "./components/watch-alerts";
import { ToastHost } from "./components/toasts";
import { Loading, ErrorState, Stall } from "./components/shared";
import "./styles.css";
import { trackPage } from "/web/js/lib/traffic.js";
import { t } from "/web/js/lib/i18n.js";
import { resolvePeriod } from "/web/js/lib/period.js";
import Home, { loadPriceTable } from "./pages/home";

/** The price table lives on the home page: old /prices and /sales links keep their query. */
function priceTablePath(url: URL) {
  if (/^\/sales\/?$/.test(url.pathname)) url.searchParams.set("tab", "sales");
  else if (!/^\/prices(\/|$)/.test(url.pathname)) return null;
  url.pathname = "/";
  return url.pathname + url.search + url.hash;
}
// The router restores scroll itself (lib/page-memory), after data renders.
if ("scrollRestoration" in history) history.scrollRestoration = "manual";
const legacyPricePath = priceTablePath(new URL(location.href));
if (legacyPricePath) history.replaceState(history.state, "", legacyPricePath);
if (location.pathname === "/") {
  void loadPriceTable();
  prefetchPriceTable();
}

/** A route chunk that renders once its site stylesheets apply (index.html links them). */
function page<T extends { default: ComponentType<any> }>(
  load: () => Promise<T>,
  ...styles: string[]
) {
  return lazy(async () => {
    const [module] = await Promise.all([
      load(),
      ...[...SITE_STYLES, ...styles].map(ensureStyle),
    ]);
    return module;
  });
}
const loadWatch = () => import("./pages/watch");
const loadAccount = () => import("./pages/account");
const Watch = page(loadWatch);
const Alerts = page(() => import("./pages/alerts"));
const Tools = page(() => import("./pages/tools"));
const Market = page(() => import("./pages/market"));
const Enhancement = page(() => import("./pages/enhancement"));
const Agent = page(() => import("./pages/agent"));
const Selling = page(() => import("./pages/selling"), "selling");
const Privacy = page(() => import("./pages/privacy"));
const Download = page(() => import("./pages/download"), "download");
let catalogueModule: Promise<typeof import("./pages/catalogue")> | undefined;
let catalogueLoaded: typeof import("./pages/catalogue") | undefined;
// The catalogue pages need neither home.css nor account.css.
const loadCatalogueModule = () =>
  (catalogueModule ??= Promise.all([
    import("./pages/catalogue"),
    ...CATALOGUE_STYLES.map(ensureStyle),
  ]).then(([module]) => (catalogueLoaded = module)));
// Loaded before a server-rendered page mounts, so it renders at once instead
// of replacing the page with the fallback for a frame (as lazy() would).
function Catalogue() {
  const Page = (catalogueLoaded ?? use(loadCatalogueModule())).default;
  return <Page />;
}
const Collect = page(() => import("./pages/collect"), "collect");
const Account = page(loadAccount);
const Device = page(() => import("./pages/device"));
const Contributors = page(() => import("./pages/contributors"));
const Traffic = page(() => import("./pages/traffic"), "traffic");
function HomePage() {
  useStyles(SITE_STYLES);
  return <Home />;
}
// /watch and /account show their frame while the account loads, not a blank page.
const shellFirst = (path: string) => /^\/(watch|account)(\/|$)/.test(path);
function AccountShell({ path }: { path: string }) {
  useStyles(SITE_STYLES);
  const words = useWords();
  if (path.startsWith("/account"))
    return (
      <Stall title={words("我的", "My profile")} className="account-stall" h1>
        <div className="account-body" data-account>
          <Loading />
        </div>
      </Stall>
    );
  return (
    <div className="lwrap watch-page">
      <section className="stall lpage">
        <div className="stall-bar watch-heading">
          <h1>{t("watch.title")}</h1>
          <span className="bar-meta" data-meta />
        </div>
        <Loading />
      </section>
    </div>
  );
}
const pageRoutes = [
  "/",
  "/prices",
  "/watch",
  "/alerts",
  "/tools",
  "/account",
  "/device",
  "/privacy",
  "/contributors",
  "/traffic",
  "/selling",
  "/agent",
  "/web/download.html",
  "/search",
  "/item",
  "/mob",
  "/map",
  "/npc",
  "/route",
  "/collect",
];
class PageErrorBoundary extends Component<
  { children: ReactNode },
  { failed: boolean }
> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  render() {
    return this.state.failed ? (
      <ErrorState retry={() => location.reload()} />
    ) : (
      this.props.children
    );
  }
}
function PriceTableRedirect() {
  const navigate = useNavigate();
  const route = useLocation();
  useEffect(() => {
    const url = new URL(route.pathname + route.search + route.hash, location.origin);
    navigate(priceTablePath(url) || "/", { replace: true });
  }, [navigate, route.pathname, route.search, route.hash]);
  return <Loading />;
}
function LegacyRedirect() {
  const navigate = useNavigate();
  const route = useLocation();
  useEffect(() => {
    void navigate((route.pathname.replace(/^\/v2/, "") || "/") + route.search, {
      replace: true,
    });
  }, [navigate, route.pathname, route.search]);
  return <Loading />;
}
function Application() {
  const route = useLocation();
  const { ready } = usePreferences();
  useEffect(() => {
    // Redirects settle first; state updates and SSE do not add page views.
    const timer = setTimeout(() => trackPage(route.pathname), 0);
    return () => clearTimeout(timer);
  }, [route.pathname]);
  const navigate = useNavigate();
  const words = useWords();
  const page = route.pathname.split("/")[1] || "home";
  const titles: Record<string, string> = {
    home: words("首页", "Home"),
    watch: words("关注", "Watch"),
    alerts: words("低价提醒", "Deal alerts"),
    tools: route.pathname.startsWith("/tools/enhancement")
      ? words("强化计算器", "Enhancement calculator")
      : words("工具", "Tools"),
    account: words("我的", "My profile"),
    device: words("设备登录", "Device sign-in"),
    privacy: words("账号隐私说明", "Account privacy"),
    contributors: words("采集贡献榜", "Contributors"),
    traffic: words("网站流量", "Website traffic"),
    agent: words("AI 助手", "AI assistant"),
    collect: words("浏览器采集", "Browser collector"),
    web: words("下载采集器", "Download collector"),
    search: words("图鉴", "Catalogue"),
    item: words("物品详情", "Item"),
    mob: words("怪物图鉴", "Monster"),
    map: words("地图", "Map"),
    route: words("怎么走", "Route"),
    selling: words("背包与摆摊", "Bag & shop"),
  };
  const navigationType = useNavigationType();
  const lastPath = useRef<string | null>(null);
  useEffect(watchScroll, []);
  useLayoutEffect(() => {
    rememberLocation(route);
    // Refresh, back/forward and the navigation tabs return to the saved
    // position; a new page starts at the top; filter changes keep it.
    if (navigationType === "POP" || route.state?.restore) restoreScroll();
    else if (lastPath.current !== route.pathname) {
      cancelScrollRestore();
      window.scrollTo(0, 0);
    }
    if (lastPath.current === route.pathname) return;
    lastPath.current = route.pathname;
    document.documentElement.dataset.reactApp = "1";
    document.documentElement.dataset.page = page;
    delete document.documentElement.dataset.ready;
  }, [route.key, route.pathname, route.search, page]);
  useEffect(() => {
    if (["search", "item", "mob", "map", "route"].includes(page)) return;
    document.title = `${titles[page] || titles.home} · ${words("枫叶市集", "Maple Market")}`;
  });
  useEffect(() => {
    const syncDevice = () => {
      const width = innerWidth;
      document.documentElement.dataset.device =
        width <= 640 ? "phone" : width >= 1101 ? "desktop" : "tablet";
    };
    syncDevice();
    window.addEventListener("resize", syncDevice);
    const click = (event: MouseEvent) => {
      const anchor = (event.target as Element).closest?.(
        "a[href]",
      ) as HTMLAnchorElement | null;
      if (
        event.defaultPrevented ||
        event.button ||
        !anchor ||
        anchor.target ||
        anchor.hasAttribute("download") ||
        event.ctrlKey ||
        event.metaKey ||
        event.shiftKey ||
        event.altKey
      )
        return;
      const url = new URL(anchor.href, location.href);
      if (
        url.origin !== location.origin ||
        !pageRoutes.some(
          (path) =>
            url.pathname === path ||
            (path !== "/" && url.pathname.startsWith(path + "/")),
        )
      )
        return;
      if (
        url.pathname === location.pathname &&
        url.search === location.search &&
        url.hash
      )
        return;
      if (
        ["/search", "/route"].includes(url.pathname) ||
        /^\/(item|mob|map|npc)\//.test(url.pathname)
      ) {
        if (
          ["en", "ko"].includes(document.documentElement.dataset.lang || "") &&
          !url.searchParams.has("lang")
        )
          url.searchParams.set("lang", document.documentElement.dataset.lang!);
      }
      event.preventDefault();
      // A link in the phone item preview replaces the preview's history entry.
      navigate(url.pathname + url.search + url.hash, {
        replace: previewEntry(),
      });
    };
    document.addEventListener("click", click);
    return () => {
      window.removeEventListener("resize", syncDevice);
      document.removeEventListener("click", click);
    };
  }, [navigate]);
  return (
    <AppShell>
      <ToastHost />
      <ItemPreview />
      <span id="site-react-shell" hidden />
      <PageErrorBoundary key={route.pathname}>
        <Suspense fallback={<Loading />}>
          {!ready && route.pathname !== "/" ? (
            shellFirst(route.pathname) ? (
              <AccountShell path={route.pathname} />
            ) : (
              <Loading />
            )
          ) : (
            <Routes>
              <Route path="/" element={<HomePage />} />
              <Route path="/prices/*" element={<PriceTableRedirect />} />
              <Route path="/account" element={<Account />} />
              <Route path="/device" element={<Device />} />
              <Route path="/contributors" element={<Contributors />} />
              <Route path="/traffic" element={<Traffic />} />
              <Route path="/watch/*" element={<Watch />} />
              <Route path="/alerts/*" element={<Alerts />} />
              <Route path="/market" element={<Market />} />
              <Route path="/tools" element={<Tools />} />
              <Route path="/tools/enhancement" element={<Enhancement />} />
              <Route path="/agent/*" element={<Agent />} />
              <Route path="/selling/*" element={<Selling />} />
              <Route path="/privacy" element={<Privacy />} />
              <Route path="/web/download.html" element={<Download />} />
              {["search", "item", "mob", "map", "npc", "route"].map((path) => (
                <Route
                  key={path}
                  path={"/" + path + "/*"}
                  element={<Catalogue />}
                />
              ))}
              <Route path="/collect/*" element={<Collect />} />
              <Route path="/sales" element={<PriceTableRedirect />} />
              <Route path="/v2/*" element={<LegacyRedirect />} />
              <Route path="*" element={<HomePage />} />
            </Routes>
          )}
        </Suspense>
      </PageErrorBoundary>
    </AppShell>
  );
}

const catalogueLocation =
  ["/search", "/route"].includes(location.pathname) ||
  /^\/(item|mob|map|npc)\//.test(location.pathname);
// Load the route module alongside account preferences/data, not after them.
const catalogueReady = catalogueLocation
  ? loadCatalogueModule().then((module) => module.preloadView(location.pathname))
  : undefined;
if (/^\/watch(\/|$)/.test(location.pathname)) void loadWatch();
if (/^\/account(\/|$)/.test(location.pathname)) void loadAccount();
const snapshot = readCatalogSnapshot();
if (snapshot)
  queryClient.setQueryData(catalogKey(snapshot.url), snapshot.data, {
    updatedAt: snapshot.updatedAt,
  });
const preferencesReady = initializePreferences();
/** The page's catalogue JSON, requested without waiting for the account. An
 * item page also gets the statistics period it switches to after mounting
 * (saved or server default; React switches again if the account differs). */
async function prefetchCatalogue() {
  const prefetch = (search: string) => {
    const url = location.pathname + search;
    if (snapshot && sameCatalog(snapshot.url, url)) return;
    return queryClient.prefetchQuery({
      queryKey: catalogKey(url),
      queryFn: ({ signal }) => loadCatalog(url, signal),
    });
  };
  const period = async () => {
    const params = new URLSearchParams(location.search);
    const hours = await resolvePeriod();
    if ((params.get("hours") || "72") === hours) return;
    params.set("hours", hours);
    await prefetch("?" + params);
  };
  // Mounting needs only this URL's data; the period's arrives alongside.
  if (location.pathname.startsWith("/item/")) void period().catch(() => undefined);
  await prefetch(location.search);
}
if (catalogueLocation) {
  document.documentElement.dataset.reactShell = "1";
  await Promise.all([
    catalogueReady,
    preferencesReady,
    prefetchCatalogue().catch(() => undefined),
  ]);
}
// Public home/search previews can paint while account data synchronizes.
// Other routes retain their account-scoped initialization before rendering.
else if (location.pathname !== "/" && !shellFirst(location.pathname))
  await preferencesReady;
const root = createRoot(document.getElementById("app")!);
// A server-rendered page stays visible while React renders; rendering in a
// transition lets the browser handle input between chunks of that work.
const render = () =>
  root.render(
    <BrowserRouter>
      <Providers>
        <WatchAlertsProvider>
          <Application />
        </WatchAlertsProvider>
      </Providers>
    </BrowserRouter>,
  );
if (catalogueLocation) startTransition(render);
else render();

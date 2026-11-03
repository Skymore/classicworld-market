import {
  Component,
  Suspense,
  lazy,
  useEffect,
  useLayoutEffect,
  type ReactNode,
} from "react";
import { createRoot } from "react-dom/client";
import {
  BrowserRouter,
  Routes,
  Route,
  useLocation,
  useNavigate,
} from "react-router-dom";
import ItemPreview, { previewEntry } from "./components/item-preview";
import {
  Providers,
  useWords,
  usePreferences,
  initializePreferences,
} from "./providers";
import { AppShell } from "./components/shell";
import { ensureStyle } from "./lib/styles";
import { queryClient } from "./lib/query";
import { loadCatalog, catalogKey, readCatalogSnapshot } from "./lib/catalog";
import { WatchAlertsProvider } from "./components/watch-alerts";
import { ToastHost } from "./components/toasts";
import { Loading, ErrorState } from "./components/shared";
import "./styles.css";
import { trackPage } from "/web/js/lib/traffic.js";
import Home from "./pages/home";

const Watch = lazy(() => import("./pages/watch"));
const Alerts = lazy(() => import("./pages/alerts"));
const Tools = lazy(() => import("./pages/tools"));
const Enhancement = lazy(() => import("./pages/enhancement"));
const Agent = lazy(() => import("./pages/agent"));
const Selling = lazy(async () => {
  await ensureStyle("selling");
  return import("./pages/selling");
});
const Privacy = lazy(() => import("./pages/privacy"));
const Download = lazy(async () => {
  await ensureStyle("download");
  return import("./pages/download");
});
let catalogueModule: Promise<typeof import("./pages/catalogue")> | undefined;
const loadCatalogueModule = () =>
  (catalogueModule ??= Promise.all([
    import("./pages/catalogue"),
    ensureStyle("dex"),
    ensureStyle("item"),
  ]).then(([module]) => module));
const Catalogue = lazy(loadCatalogueModule);
const Collect = lazy(async () => {
  await ensureStyle("collect");
  return import("./pages/collect");
});
const Prices = lazy(() => import("./pages/prices"));
const Account = lazy(() => import("./pages/account"));
const Device = lazy(() => import("./pages/device"));
const Contributors = lazy(() => import("./pages/contributors"));
const Traffic = lazy(async () => {
  await ensureStyle("traffic");
  return import("./pages/traffic");
});
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
  "/world",
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
function SalesRedirect() {
  const navigate = useNavigate();
  useEffect(() => {
    const url = new URL(location.href);
    url.pathname = "/prices";
    url.searchParams.set("tab", "sales");
    navigate(url.pathname + url.search, { replace: true });
  }, [navigate]);
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
    prices: words("价格表", "Prices"),
    watch: words("关注", "Watch"),
    alerts: words("采集", "Collect"),
    tools: route.pathname.startsWith("/tools/enhancement")
      ? words("强化计算器", "Enhancement calculator")
      : words("工具", "Tools"),
    account: words("我的", "My profile"),
    device: words("设备登录", "Device sign-in"),
    privacy: words("账号隐私说明", "Account privacy"),
    contributors: words("采集贡献榜", "Contributors"),
    traffic: words("网站流量", "Website traffic"),
    agent: words("AI 助手", "AI assistant"),
    collect: words("屏幕采集", "Screen collector"),
    web: words("下载采集器与使用说明", "Download collector"),
    search: words("搜索", "Search"),
    item: words("物品详情", "Item"),
    mob: words("怪物图鉴", "Monster"),
    map: words("地图", "Map"),
    route: words("怎么走", "Route"),
    selling: words("背包与摆摊", "Bag & shop"),
  };
  useLayoutEffect(() => {
    document.documentElement.dataset.reactApp = "1";
    document.documentElement.dataset.page = page;
    delete document.documentElement.dataset.ready;
    window.scrollTo(0, 0);
  }, [route.pathname, page]);
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
        ["/search", "/route", "/world"].includes(url.pathname) ||
        /^\/(item|mob|map|npc)\//.test(url.pathname)
      ) {
        if (
          document.documentElement.dataset.lang === "en" &&
          !url.searchParams.has("lang")
        )
          url.searchParams.set("lang", "en");
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
            <Loading />
          ) : (
            <Routes>
              <Route path="/" element={<Home />} />
              <Route path="/prices/*" element={<Prices />} />
              <Route path="/account" element={<Account />} />
              <Route path="/device" element={<Device />} />
              <Route path="/contributors" element={<Contributors />} />
              <Route path="/traffic" element={<Traffic />} />
              <Route path="/watch/*" element={<Watch />} />
              <Route path="/alerts/*" element={<Alerts />} />
              <Route path="/tools" element={<Tools />} />
              <Route path="/tools/enhancement" element={<Enhancement />} />
              <Route path="/agent/*" element={<Agent />} />
              <Route path="/selling/*" element={<Selling />} />
              <Route path="/privacy" element={<Privacy />} />
              <Route path="/web/download.html" element={<Download />} />
              {["search", "item", "mob", "map", "npc", "route", "world"].map((path) => (
                <Route
                  key={path}
                  path={"/" + path + "/*"}
                  element={<Catalogue />}
                />
              ))}
              <Route path="/collect/*" element={<Collect />} />
              <Route path="/sales" element={<SalesRedirect />} />
              <Route path="/v2/*" element={<LegacyRedirect />} />
              <Route path="*" element={<Home />} />
            </Routes>
          )}
        </Suspense>
      </PageErrorBoundary>
    </AppShell>
  );
}

const catalogueLocation =
  ["/search", "/route", "/world"].includes(location.pathname) ||
  /^\/(item|mob|map|npc)\//.test(location.pathname);
// Load the route module alongside account preferences/data, not after them.
const catalogueReady = catalogueLocation ? loadCatalogueModule() : undefined;
const snapshot = readCatalogSnapshot();
if (snapshot)
  queryClient.setQueryData(catalogKey(snapshot.url), snapshot.data, {
    updatedAt: snapshot.updatedAt,
  });
const preferencesReady = initializePreferences();
// Public home/search previews can paint while account data synchronizes.
// Other routes retain their account-scoped initialization before rendering.
if (location.pathname !== "/") await preferencesReady;
if (catalogueLocation) {
  document.documentElement.dataset.reactShell = "1";
  await Promise.all([
    catalogueReady,
    !snapshot &&
      queryClient.prefetchQuery({
        queryKey: catalogKey(location.pathname + location.search),
        queryFn: ({ signal }) =>
          loadCatalog(location.pathname + location.search, signal),
      }),
  ]);
}
await Promise.all(["home", "prices", "account", "lists"].map(ensureStyle));
createRoot(document.getElementById("app")!).render(
  <BrowserRouter>
    <Providers>
      <WatchAlertsProvider>
        <Application />
      </WatchAlertsProvider>
    </Providers>
  </BrowserRouter>,
);

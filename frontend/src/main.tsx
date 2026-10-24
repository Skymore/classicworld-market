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
import "/web/js/lib/item-preview.js?v=20261023-header-icons-2";
import { Providers, useWords, initializePreferences } from "./providers";
import { AppShell } from "./components/shell";
import { LegacyPage } from "./components/legacy-page";
import { Loading, ErrorState } from "./components/shared";
import "./styles.css";

const Home = lazy(() => import("./pages/home"));
const Prices = lazy(() => import("./pages/prices"));
const Account = lazy(() => import("./pages/account"));
const Contributors = lazy(() => import("./pages/contributors"));
const pageRoutes = [
  "/",
  "/prices",
  "/watch",
  "/alerts",
  "/account",
  "/privacy",
  "/contributors",
  "/selling",
  "/agent",
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
  const navigate = useNavigate();
  const words = useWords();
  const page = route.pathname.split("/")[1] || "home";
  const titles: Record<string, string> = {
    home: words("首页", "Home"),
    prices: words("价格表", "Prices"),
    watch: words("关注", "Watch"),
    alerts: words("采集", "Collect"),
    account: words("我的", "My profile"),
    privacy: words("账号隐私说明", "Account privacy"),
    contributors: words("采集贡献榜", "Contributors"),
    agent: words("市场助手", "Market assistant"),
    selling: words("背包与摆摊", "Bag & shop"),
  };
  useLayoutEffect(() => {
    document.documentElement.dataset.reactApp = "1";
    document.documentElement.dataset.page = page;
    delete document.documentElement.dataset.ready;
    window.scrollTo(0, 0);
  }, [route.pathname, page]);
  useEffect(() => {
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
      event.preventDefault();
      navigate(url.pathname + url.search + url.hash);
    };
    document.addEventListener("click", click);
    return () => {
      window.removeEventListener("resize", syncDevice);
      document.removeEventListener("click", click);
    };
  }, [navigate]);
  return (
    <AppShell>
      <PageErrorBoundary key={route.pathname}>
        <Suspense fallback={<Loading />}>
          <Routes>
            <Route path="/" element={<Home />} />
            <Route path="/prices/*" element={<Prices />} />
            <Route path="/account" element={<Account />} />
            <Route path="/contributors" element={<Contributors />} />
            {["watch", "alerts", "agent", "selling", "privacy"].map((name) => (
              <Route
                key={name}
                path={`/${name}/*`}
                element={<LegacyPage name={name} />}
              />
            ))}
            <Route path="/sales" element={<SalesRedirect />} />
            <Route path="/v2/*" element={<LegacyRedirect />} />
            <Route path="*" element={<Home />} />
          </Routes>
        </Suspense>
      </PageErrorBoundary>
    </AppShell>
  );
}

await initializePreferences();
createRoot(document.getElementById("app")!).render(
  <BrowserRouter>
    <Providers>
      <Application />
    </Providers>
  </BrowserRouter>,
);

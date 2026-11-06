import {
  QueryClient,
  QueryClientProvider,
  keepPreviousData,
  useQuery,
  type Query,
} from "@tanstack/react-query";
import { useEffect, type ReactNode } from "react";
import { getJson } from "/web/js/lib/api.js?v=20261022-auto-watch-2";
import {
  subscribeMarket,
  mergeMarketChanges,
} from "/web/js/lib/realtime.js?v=20261022-regressions-1";
import {
  automaticPeriod,
  readPeriod,
  resolvePeriod,
} from "/web/js/lib/period.js?v=20261022-regressions-1";
import type { Account, Market, Product } from "./types";
import { adoptAccount, ready as userDataReady } from "/web/js/lib/user-data.js";

let initialAccountRead = true;
let initialAccountAt = 0;
const initialAccount = userDataReady.then((account: Account | null) => {
  initialAccountAt = Date.now();
  return account;
});

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 15_000,
      gcTime: 300_000,
      retry: 1,
      refetchOnWindowFocus: true,
    },
  },
});

/** The price table's market list for a statistics period. */
export const marketListUrl = (hours: string) =>
  `/api/v1/market?view=list&hours=${hours}`;
const isMarketList = (query: Query) =>
  /^\/api\/v1\/market\?view=list&hours=[\w-]+$/.test(String(query.queryKey[1]));
const marketOptions = (url: string, reactive = true) => ({
  queryKey: ["market", url],
  staleTime: reactive ? 15_000 : 60_000,
  meta: { market: reactive },
  queryFn: async ({ signal }: { signal: AbortSignal }): Promise<unknown> =>
    (await getJson(url, { signal })).data,
});

// A manual choice, else the server's last suggestion (even an expired one), else 72 h.
function likelyPeriod(): string {
  if (!automaticPeriod()) return readPeriod();
  try {
    const hint = JSON.parse(localStorage.getItem("market.period-hint.v1") || "null");
    if (hint?.default_hours === "72" || hint?.default_hours === "all")
      return hint.default_hours;
  } catch {
    /* no stored suggestion */
  }
  return readPeriod();
}
/** Home: ask for the period and the likely period's list at boot, before the table's code arrives. */
export function prefetchPriceTable() {
  const guess = likelyPeriod();
  const load = (hours: string) =>
    void queryClient.prefetchQuery(marketOptions(marketListUrl(hours)));
  load(guess);
  void queryClient.prefetchQuery(marketOptions("/web/data/crafting.json", false));
  void resolvePeriod().then((hours: string) => {
    if (hours === guess) return;
    // A wrong guess stops downloading, so the right list gets the bandwidth.
    void queryClient.cancelQueries({ queryKey: ["market", marketListUrl(guess)] });
    load(hours);
  });
}

type MarketChange = { ids?: number[] };
// Cleared once the server answers an `ids` request without supporting it.
let listRowsSupported = true;
/** Replace or drop just the changed rows of one cached list; false falls back to a full refresh. */
async function patchList(query: Query, ids: number[]) {
  if (query.state.fetchStatus !== "idle" || !query.state.data) return false;
  if (!ids.length) return true;
  const url = String(query.queryKey[1]);
  try {
    const response = await fetch(`${url}&ids=${ids.join(",")}`, {
      credentials: "same-origin",
      cache: "no-store",
      headers: { Accept: "application/json" },
    });
    if (!response.ok) {
      if (response.status === 400) listRowsSupported = false;
      return false;
    }
    const body = (await response.json()) as {
      as_of?: number;
      products?: Product[];
      removed?: number[];
    };
    if (!Array.isArray(body?.products) || !Array.isArray(body?.removed)) {
      listRowsSupported = false;
      return false;
    }
    if (query.state.fetchStatus !== "idle") return false;
    const fresh = new Map(body.products.map((row) => [row.item_id, row]));
    const removed = new Set(body.removed);
    queryClient.setQueryData<Market>(query.queryKey, (old) => {
      if (!old) return old;
      const products: Product[] = [];
      for (const row of old.products) {
        if (removed.has(row.item_id)) continue;
        products.push(fresh.get(row.item_id) ?? row);
        fresh.delete(row.item_id);
      }
      products.push(...fresh.values());
      return { ...old, as_of: body.as_of ?? old.as_of, products };
    });
    return true;
  } catch {
    return false;
  }
}
async function refreshMarket(change: MarketChange) {
  const patched = new Set<Query>();
  if (change.ids && listRowsSupported) {
    const lists = queryClient
      .getQueryCache()
      .findAll({ queryKey: ["market"], predicate: isMarketList })
      .filter((query) => query.getObserversCount() > 0);
    await Promise.all(
      lists.map(async (query) => {
        if (await patchList(query, change.ids!)) patched.add(query);
      }),
    );
  }
  // Everything else revalidates with its ETag: unchanged data costs a 304.
  await queryClient.invalidateQueries(
    { predicate: (query) => query.meta?.market === true && !patched.has(query) },
    { cancelRefetch: false },
  );
}

export function DataProvider({ children }: { children: ReactNode }) {
  useEffect(() => {
    let busy = false,
      disposed = false,
      pending: MarketChange | null = null;
    // realtime.js already merges events (one delivery per 3 s, none while hidden).
    const refresh = (change: MarketChange = {}) => {
      if (disposed) return;
      if (busy) {
        pending = mergeMarketChanges(pending, change);
        return;
      }
      busy = true;
      void refreshMarket(change).finally(() => {
        busy = false;
        if (pending && !disposed) {
          const next = pending;
          pending = null;
          refresh(next);
        }
      });
    };
    const stop = subscribeMarket(refresh);
    const account = (event: Event) =>
      queryClient.setQueryData(
        ["account"],
        (event as CustomEvent<Account>).detail,
      );
    window.addEventListener("account-changed", account);
    return () => {
      disposed = true;
      stop();
      window.removeEventListener("account-changed", account);
    };
  }, []);
  return (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
}
export function useMarketQuery<T>(
  url: string,
  enabled = true,
  reactive = true,
  /** Keep showing the previous URL's data (`isPlaceholderData`) while a new one loads. */
  keep = false,
) {
  const options = marketOptions(url, reactive);
  const query = useQuery<T>({
    ...options,
    queryFn: async (context) => (await options.queryFn(context)) as T,
    enabled,
    placeholderData: keep ? keepPreviousData : undefined,
  });
  useEffect(() => {
    const data = query.data as
      { as_of?: number; generated_at?: number } | undefined;
    const at = data?.as_of ?? data?.generated_at;
    if (at != null)
      document.dispatchEvent(
        new CustomEvent("market-freshness", { detail: at }),
      );
  }, [query.data]);
  return query;
}
export function useAccount() {
  return useQuery<Account>({
    queryKey: ["account"],
    staleTime: 30_000,
    queryFn: async ({ signal }) => {
      if (initialAccountRead) {
        initialAccountRead = false;
        const initial = await initialAccount;
        if (initial && Date.now() - initialAccountAt < 30_000) return initial;
      }
      const response = await fetch("/api/v1/account", {
        credentials: "same-origin",
        cache: "no-store",
        signal,
      });
      if (!response.ok) throw Error("unavailable");
      const account = (await response.json()) as Account;
      await adoptAccount(account);
      return account;
    },
  });
}

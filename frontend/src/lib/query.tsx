import {
  QueryClient,
  QueryClientProvider,
  useQuery,
} from "@tanstack/react-query";
import { useEffect, type ReactNode } from "react";
import { getJson } from "/web/js/lib/api.js?v=20261022-auto-watch-2";
import { subscribeMarket } from "/web/js/lib/realtime.js?v=20261022-regressions-1";
import type { Account } from "./types";
import { adoptAccount } from "/web/js/lib/user-data.js";

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
export function DataProvider({ children }: { children: ReactNode }) {
  useEffect(() => {
    let busy = false, pending = false, disposed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const refresh = () => {
      if (disposed) return;
      if (busy) { pending = true; return; }
      clearTimeout(timer);
      busy = true;
      void queryClient.invalidateQueries({
        predicate: (query) => query.meta?.market === true,
      }, { cancelRefetch: false }).finally(() => {
        busy = false;
        if (pending && !disposed) {
          pending = false;
          timer = setTimeout(refresh, 250);
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
      clearTimeout(timer);
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
) {
  const query = useQuery<T>({
    queryKey: ["market", url],
    enabled,
    staleTime: reactive ? 15_000 : 60_000,
    meta: { market: reactive },
    queryFn: async ({ signal }) => (await getJson(url, { signal })).data as T,
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

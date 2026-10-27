import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { api, qs } from "/web/js/lib/api.js?v=20261022-auto-watch-2";
import Core, {
  LIST_KEY,
  SETTINGS_KEY,
} from "/web/js/lib/watchlist-core.js?v=20261027-watch-groups-1";
import { mergeShopOffers } from "/web/js/lib/quote-groups.js?v=20261026-reminders-2";
import {
  normalizeReminder,
  notificationEligibility,
  reminderSelection,
} from "/web/js/lib/watch-reminders.js?v=20261027-watch-groups-1";
import { t, itemName } from "/web/js/lib/i18n.js";
import { useLiveData, useUserValue } from "../lib/live";
import { useWords } from "../providers";
import { announce, OfferReminder } from "./toasts";
import "../lib/list-copy";

// Owned by the application, so navigation neither stops feeds nor resets deduplication.
function useWatchState() {
  const words = useWords();
  const [list, writeList] = useUserValue(LIST_KEY, "[]");
  const [setting, writeSettings] = useUserValue(SETTINGS_KEY, "{}");
  const [token] = useUserValue("cwm.collector.token");
  const ids = useMemo<number[]>(
    () => Core.readList({ getItem: () => list }),
    [list],
  );
  const settings = useMemo<any>(
    () => Core.readSettings({ getItem: () => setting }, ids),
    [setting, ids],
  );
  const hasWatches = ids.length > 0;
  const [account] = useUserValue("cwm.preferences.account.v1", "guest");
  // Reset only alert history on account changes; keep page state (e.g. recovery codes).
  const session = useMemo(
    () => ({
      started: Date.now() / 1000,
      notifications: {
        shared: new Map(),
        personal: new Map(),
        delivered: new Map(),
      },
      addedAt: {} as Record<number, number>,
      ids,
    }),
    [account],
  );
  const { started, notifications, addedAt } = session;
  useEffect(() => {
    for (const id of ids)
      if (!session.ids.includes(id)) addedAt[id] = Date.now() / 1000;
    session.ids = ids;
  }, [ids, session]);
  const [personal, setPersonal] = useState<any>(null);
  const [captureState, setCaptureState] = useState("");
  const [attempt, setAttempt] = useState(0);
  const personalRef = useRef(personal);
  personalRef.current = personal;
  const lastPersonalTry = useRef(0);
  const shared = useLiveData<any>(
    ids.length
      ? api.watchListings({ ids: [...ids].sort((a, b) => a - b).join(",") })
      : null,
  );
  const own = useLiveData<any>(
    personal && ids.length
      ? personal.base +
          "/api/v1/collector/watch-listings" +
          qs({ ids: ids.join(",") })
      : null,
    personal?.token ? { Authorization: `Bearer ${personal.token}` } : undefined,
  );
  const grouped = useMemo<any[]>(
    () =>
      shared.data?.grouped_listings ??
      mergeShopOffers(shared.data?.listings || []),
    [shared.data],
  );
  const reference = useMemo(
    () => ({
      rows: grouped,
      percentiles: shared.data?.percentile_caps,
      baseStats: shared.data?.base_stats,
    }),
    [grouped, shared.data],
  );
  useEffect(() => {
    let active = true;
    const abort = new AbortController();
    setPersonal(null);
    if (!hasWatches) return;
    lastPersonalTry.current = Date.now();
    const gateway =
      ["localhost", "127.0.0.1"].includes(location.hostname) &&
      !["8766", "8765"].includes(location.port);
    const official = [
      "https://mxd.ruit.me",
      "http://127.0.0.1:8766",
      "http://localhost:8766",
    ].includes(location.origin);
    const targets = [
      ...(token || gateway ? [{ base: "", token }] : []),
      ...(official ? [{ base: "http://127.0.0.1:8780", token: null }] : []),
    ];
    (async () => {
      for (const target of targets) {
        if (!active) return;
        setCaptureState("connecting");
        try {
          const response = await fetch(
            target.base + "/api/v1/collector/status",
            {
              headers: target.token
                ? { Authorization: `Bearer ${target.token}` }
                : {},
              credentials: "same-origin",
              cache: "no-store",
              signal: AbortSignal.any([
                abort.signal,
                AbortSignal.timeout(15000),
              ]),
            },
          );
          if (!active) return;
          setCaptureState("http-" + response.status);
          if (response.ok) {
            const data = await response.json();
            if (target.token || data.local_collector === true) {
              setPersonal({ ...target, id: data.collector_id });
              setCaptureState("connected");
              return;
            }
          }
        } catch (error) {
          if (active) setCaptureState((error as Error).name);
        }
      }
    })();
    const reconnect = () => {
      if (!personalRef.current && Date.now() - lastPersonalTry.current >= 30000)
        setAttempt((old) => old + 1);
    };
    window.addEventListener("focus", reconnect);
    return () => {
      active = false;
      abort.abort();
      window.removeEventListener("focus", reconnect);
    };
  }, [token, attempt, hasWatches]);
  useEffect(() => {
    if (
      shared.data &&
      !personalRef.current &&
      Date.now() - lastPersonalTry.current >= 30000
    )
      setAttempt((old) => old + 1);
  }, [shared.data]);
  useEffect(() => {
    const signal =
      own.data && own.data.personal && own.data.collector_id === personal?.id
        ? own.data
        : null;
    const packets: [[any, string, string?], [any, string, string?]] = [
      [shared.data, "shared"],
      [signal, "personal", personal?.id],
    ];
    for (const [packet, source, identity] of packets) {
      if (!packet) continue;
      if (source === "personal" && !shared.data) continue;
      const eligible = notificationEligibility(
        packet,
        ids,
        settings,
        reference,
      );
      const candidates = (packet.listings || []).filter(
        (row: any) =>
          source !== "personal" ||
          normalizeReminder(settings[row.item_id]?.reminder).percentile ===
            "all" ||
          reminderSelection(
            grouped,
            row.item_id,
            settings[row.item_id],
            reference,
          ).ready,
      );
      const fresh = Core.combinedNotifications(
        candidates,
        Core.watches(ids, settings, addedAt).map((watch: any) => ({
          ...watch,
          max_price: null,
        })),
        notifications,
        started,
        Date.now() / 1000,
        source,
        identity,
        eligible,
      );
      const delivered = new Map<string, any>();
      for (const raw of fresh) {
        const row = eligible.get(raw.id);
        if (row) delivered.set(row.id, row);
      }
      for (const row of [...delivered.values()].slice(0, 5)) {
        const item = row;
        const title = t("watch.toast_title"),
          line = t("watch.toast_line", {
            price: row.unit_price,
            stock: row.stock ?? words("未知", "unknown"),
          });
        announce(
          title,
          `/item/${row.item_id}`,
          <OfferReminder row={row} item={item} />,
          { body: `${itemName(item)} · ${line} · ${row.shop}`, tag: row.id },
        );
      }
    }
  }, [shared.data, own.data, list, setting, personal?.id, session]);
  function saveIds(next: number[]) {
    for (const id of next)
      if (!ids.includes(id)) addedAt[id] = Date.now() / 1000;
    writeList(JSON.stringify(next));
    writeSettings(
      JSON.stringify(
        Object.fromEntries(
          next.map((id) => [id, settings[id] || { cap: null, notify: true }]),
        ),
      ),
    );
  }
  return {
    list,
    writeList,
    setting,
    writeSettings,
    ids,
    settings,
    shared,
    grouped,
    reference,
    personal,
    captureState,
    saveIds,
  };
}

const WatchContext = createContext<ReturnType<typeof useWatchState> | null>(
  null,
);
export function WatchAlertsProvider({ children }: { children: ReactNode }) {
  const value = useWatchState();
  return (
    <WatchContext.Provider value={value}>{children}</WatchContext.Provider>
  );
}
export function useWatchAlerts() {
  const value = useContext(WatchContext);
  if (!value) throw new Error("Watch alerts require the application provider");
  return value;
}

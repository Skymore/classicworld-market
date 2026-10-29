import { useQueries } from "@tanstack/react-query";
import { getJson, qs, api } from "/web/js/lib/api.js?v=20261022-auto-watch-2";
import { reminderTokens } from "/web/js/lib/watch-reminders.js?v=20261027-watch-groups-1";
import { itemName } from "/web/js/lib/i18n.js";
import { meso } from "/web/js/lib/format.js";
import { useWords } from "../providers";
import {
  purchaseLabel,
  purchasePlace,
  type Device,
  type SweepWatch,
  type Purchase,
} from "../lib/sweep-labels";

export function PurchaseRow({ row, name }: { row: Purchase; name: string }) {
  const words = useWords();
  const amount =
    row.units && row.units !== row.quantity
      ? words(
          `${row.quantity} 组 · ${row.units} 件`,
          `${row.quantity} lots · ${row.units} pcs`,
        )
      : words(
          `${row.units || row.quantity || 0} 件`,
          `${row.units || row.quantity || 0} pcs`,
        );
  return (
    <div
      className="sweep-row"
      data-purchase={row.id}
      data-purchase-status={row.status}
    >
      <span className="sweep-row-main">
        <b>{name}</b>
        <small>
          {[
            amount,
            row.price != null && `@${meso(row.price)}`,
            purchasePlace(row),
          ]
            .filter(Boolean)
            .join(" · ")}
        </small>
      </span>
      <span className="sweep-row-side">
        <b>{row.status === "bought" ? meso(row.spent) : "—"}</b>
        <small className={"sweep-status " + row.status} data-purchase-label>
          {purchaseLabel(row, words)}
        </small>
      </span>
    </div>
  );
}

export const isEnglish = () => document.documentElement.lang === "en";

/** Names from the watch page's catalogue rows, looking up the rest. */
export function useItemNames(ids: number[], items: Map<number, any>) {
  const missing = [...new Set(ids)].filter((id) => !items.has(id));
  const resolved = useQueries({
    queries: missing.map((id) => ({
      queryKey: ["watch-item", id],
      staleTime: 60_000,
      queryFn: async ({ signal }: { signal: AbortSignal }) =>
        (await getJson(api.watchCatalog() + qs({ q: id }), { signal })).data,
    })),
  });
  const found = new Map<number, any>(
    resolved.flatMap((result) =>
      ((result.data as any)?.items || []).map((row: any) => [row.item_id, row]),
    ),
  );
  return (id: number) => {
    const row = items.get(id) || found.get(id);
    return row ? itemName(row) : String(id);
  };
}

export function SweepRules({
  watches,
  items,
}: {
  watches: SweepWatch[];
  items: Map<number, any>;
}) {
  const words = useWords(),
    name = useItemNames(
      watches.map((w) => w.item_id),
      items,
    );
  return (
    <section className="sweep-list" data-sweep-rules>
      <h3 className="sweep-head">{words("扫货条件", "Sweep rules")}</h3>
      {watches.map((watch) => (
        <div className="sweep-row" key={watch.item_id}>
          <div className="sweep-row-main">
            <b>{name(watch.item_id)}</b>
            {watch.groups.map((group, i) => (
              <small key={group.id || i}>
                {i > 0 && words("或 · ", "or · ")}
                {[
                  group.name,
                  `≤ ${Number(group.cap).toLocaleString()}`,
                  ...reminderTokens(group.reminder, isEnglish()).map(
                    (t: any) => t.label,
                  ),
                ]
                  .filter(Boolean)
                  .join(" · ")}
              </small>
            ))}
          </div>
          <span className="sweep-row-side">
            {watch.limit === 0
              ? words("数量不限", "Unlimited")
              : words(`最多 ${watch.limit} 件`, `Up to ${watch.limit}`)}
          </span>
        </div>
      ))}
      {!watches.length && (
        <p className="sweep-empty">
          {words("没有可扫货的条件", "No sweep rules")}
        </p>
      )}
    </section>
  );
}

export function HoldingsRows({
  devices,
  watches,
  items,
}: {
  devices: Device[];
  watches: SweepWatch[];
  items: Map<number, any>;
}) {
  const words = useWords(),
    name = useItemNames(
      watches.map((w) => w.item_id),
      items,
    );
  return (
    <div className="sweep-list" data-sweep-holdings>
      {devices.map((device) => {
        const holdings = device.online ? device.state?.sweep?.holdings : null;
        return (
          <div className="sweep-row" key={device.id}>
            <span className="sweep-row-main">
              <b>
                {words("背包", "Inventory")}
                {devices.length > 1 ? ` · ${device.name}` : ""}
              </b>
              {watches.map((w) => (
                <small key={w.item_id}>
                  {name(w.item_id)} ·{" "}
                  {holdings?.categories.includes(
                    Math.floor(w.item_id / 1000000),
                  )
                    ? (
                        holdings.items.find((i) => i.item_id === w.item_id)
                          ?.quantity || 0
                      ).toLocaleString()
                    : "—"}
                </small>
              ))}
              {!holdings && (
                <small>{words("等待游戏数据", "Waiting for game data")}</small>
              )}
            </span>
            <span className="sweep-row-side">
              <small>{words("金币余额", "Mesos balance")}</small>
              <b>
                {holdings?.mesos != null
                  ? holdings.mesos.toLocaleString()
                  : "—"}
              </b>
            </span>
          </div>
        );
      })}
    </div>
  );
}

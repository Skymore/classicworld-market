import { useEffect, useRef } from "react";
import { useQueries } from "@tanstack/react-query";
import { getJson, qs, api } from "/web/js/lib/api.js?v=20261022-auto-watch-2";
import { reminderTokens } from "/web/js/lib/watch-reminders.js?v=20261027-watch-groups-1";
import { itemName } from "/web/js/lib/i18n.js";
import { meso } from "/web/js/lib/format.js";
import { useWords } from "../providers";
import { Slot } from "./shared";
import {
  clockTime,
  purchaseAmount,
  purchaseLabel,
  purchasePlace,
  type Device,
  type Run,
  type SweepWatch,
  type Purchase,
} from "../lib/sweep-labels";

export const isEnglish = () => document.documentElement.lang === "en";
const number = (value: number | null | undefined) =>
  value == null ? "—" : value.toLocaleString();

/** One condition group as text: "高物攻 · ≤ 9,000 · 物攻 ≥ 59". */
export function groupText(group: any) {
  const percentile = group.price_percentile || (group.reminder?.percentile !== 'all' && group.reminder?.percentile);
  return [
    group.name,
    percentile ? `${isEnglish() ? 'Lowest' : '最低'} ${percentile}%` : null,
    (!percentile || group.price_percentile) && group.cap != null ? `≤ ${Number(group.cap).toLocaleString()}` : null,
    ...reminderTokens(group.reminder, isEnglish()).map((t: any) => t.label),
  ]
    .filter(Boolean)
    .join(" · ");
}

export function PurchaseRow({ row, name }: { row: Purchase; name: string }) {
  const words = useWords();
  return (
    <div
      className="sweep-row"
      data-purchase={row.id}
      data-purchase-status={row.status}
    >
      <span className="sweep-row-main">
        <b>{name}</b>
        <small>
          {[purchaseAmount(row, words), purchasePlace(row)]
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

/** Catalogue rows for names and icons from the watch page, looking up the rest. */
export function useItemRows(ids: number[], items: Map<number, any>) {
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
  return (id: number): any => items.get(id) || found.get(id) || null;
}
export function useItemNames(ids: number[], items: Map<number, any>) {
  const row = useItemRows(ids, items);
  return (id: number) => {
    const found = row(id);
    return found ? itemName(found) : String(id);
  };
}

/** The run's frozen rules, read-only (details dialog). */
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
                {groupText(group)}
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

/** Units of `itemId` across online devices, or null when no device has read its tab. */
function heldUnits(devices: Device[], itemId: number) {
  const read = devices
    .map((d) => (d.online ? d.state?.sweep?.holdings : null))
    .filter((h) => h?.categories.includes(Math.floor(itemId / 1000000)));
  return read.length
    ? read.reduce(
        (sum, h) =>
          sum + (h!.items.find((i) => i.item_id === itemId)?.quantity || 0),
        0,
      )
    : null;
}

function LimitCell({
  name,
  limit,
  onChange,
}: {
  name: string;
  limit: number;
  onChange(limit: number): void;
}) {
  const words = useWords();
  // Unticking "unlimited" restores the last finite limit.
  const finite = useRef(limit > 0 ? limit : 1);
  useEffect(() => {
    if (limit > 0) finite.current = limit;
  }, [limit]);
  return (
    <span className="sweep-limit">
      {limit !== 0 && (
        <input
          type="number"
          inputMode="numeric"
          min={1}
          max={9999}
          step={1}
          aria-label={words(`${name}本轮购买上限`, `${name} session quantity limit`)}
          value={limit}
          onChange={(event) => {
            const n = Number(event.target.value);
            if (Number.isInteger(n) && n >= 1 && n <= 9999) onChange(n);
          }}
        />
      )}
      <label>
        <input
          type="checkbox"
          aria-label={words(`${name}数量不限`, `${name} unlimited quantity`)}
          checked={limit === 0}
          onChange={(event) =>
            onChange(event.target.checked ? 0 : finite.current)
          }
        />
        {words("不限", "No limit")}
      </label>
    </span>
  );
}

/**
 * Sweep rules as a table. Without `run` the per-item limits are editable and the
 * last column shows what the devices hold; with `run` it shows bought / limit.
 */
export function RulesTable({
  watches,
  items,
  run,
  devices,
  onLimit,
  onEdit,
}: {
  watches: SweepWatch[];
  items: Map<number, any>;
  run?: Run | null;
  devices?: Device[];
  onLimit?(itemId: number, limit: number): void;
  onEdit?(): void;
}) {
  const words = useWords();
  const row = useItemRows(
    watches.map((w) => w.item_id),
    items,
  );
  const name = (id: number) => (row(id) ? itemName(row(id)) : String(id));
  const bag = !run && devices !== undefined;
  const conditions = (watch: SweepWatch) =>
    watch.groups.map((group, i) => (
      <span key={group.id || i}>
        {i > 0 && <i>{words("或 ", "or ")}</i>}
        {groupText(group)}
      </span>
    ));
  return (
    <section className="sweep-rules" data-sweep-rules-table>
      <div className="sweep-title">
        <h3>{run ? words("本轮条件", "This run") : words("扫货条件", "Sweep rules")}</h3>
        {!run && onEdit && (
          <button type="button" className="sweep-link" data-sweep-edit-rules onClick={onEdit}>
            {words("去关注里修改", "Edit in watchlist")}
          </button>
        )}
      </div>
      {watches.length ? (
        <div className={"sweep-table " + (run ? "run" : bag ? "edit" : "edit no-bag")}>
          <div className="sweep-tr th">
            <span>{words("物品", "Item")}</span>
            <span className="cond">{words("条件", "Conditions")}</span>
            {run ? (
              <>
                <span className="r">{words("已买", "Bought")}</span>
                <span className="r">{words("上限", "Limit")}</span>
              </>
            ) : (
              <>
                <span>{words("本轮最多买", "Per run")}</span>
                {bag && <span className="r">{words("背包", "Held")}</span>}
              </>
            )}
          </div>
          {watches.map((watch) => {
            const bought = run?.items?.find((i) => i.item_id === watch.item_id)?.bought;
            const full = Boolean(run) && watch.limit > 0 && (bought ?? 0) >= watch.limit;
            const held = bag ? heldUnits(devices!, watch.item_id) : null;
            return (
              <div
                className={"sweep-tr" + (full ? " full" : "")}
                key={watch.item_id}
                data-sweep-rule={watch.item_id}
              >
                <span className="item">
                  <Slot url={row(watch.item_id)?.icon_url} size={24} />
                  <span className="item-text">
                    <b>{name(watch.item_id)}</b>
                    <small className="cond-inline">{conditions(watch)}</small>
                  </span>
                </span>
                <span className="cond">{conditions(watch)}</span>
                {run ? (
                  <>
                    <span className="r" data-rule-bought>
                      {full && <span className="sweep-tag">{words("已满", "Full")}</span>}
                      {number(bought)}
                    </span>
                    <span className="r">
                      {watch.limit === 0 ? words("不限", "No limit") : number(watch.limit)}
                    </span>
                  </>
                ) : (
                  <>
                    <span>
                      <LimitCell
                        name={name(watch.item_id)}
                        limit={watch.limit}
                        onChange={(limit) => onLimit?.(watch.item_id, limit)}
                      />
                    </span>
                    {bag && <span className="r" data-rule-held>{number(held)}</span>}
                  </>
                )}
              </div>
            );
          })}
        </div>
      ) : (
        <p className="sweep-empty">
          {words("没有可扫货的条件，在物品里勾选“扫货”", "No sweep rules. Tick Sweep on an item.")}
        </p>
      )}
    </section>
  );
}

/** The run's latest five purchases. */
export function RecentPurchases({
  run,
  items,
  onAll,
}: {
  run: Run;
  items: Map<number, any>;
  onAll(): void;
}) {
  const words = useWords();
  const latest = run.purchases.slice(0, 5);
  const row = useItemRows(
    latest.map((p) => p.item_id),
    items,
  );
  if (!latest.length) return null;
  return (
    <section className="sweep-buys" data-sweep-recent-purchases>
      <div className="sweep-title">
        <h3>{words("最近购买", "Recent purchases")}</h3>
        <button type="button" className="sweep-link" data-sweep-all-records onClick={onAll}>
          {words(`全部 ${run.purchases.length} 条`, `All ${run.purchases.length}`)}
        </button>
      </div>
      <div className="sweep-buy-list">
        {latest.map((purchase) => {
          const bought = purchase.status === "bought";
          return (
            <div
              className="sweep-tr"
              key={purchase.id}
              data-purchase={purchase.id}
              data-purchase-status={purchase.status}
            >
              <span className="t">
                {clockTime(purchase.settled_at || purchase.created_at, isEnglish())}
              </span>
              <span className="item">
                <Slot url={row(purchase.item_id)?.icon_url} size={24} />
                <span className="item-text">
                  <b>{row(purchase.item_id) ? itemName(row(purchase.item_id)) : purchase.item_id}</b>
                  <small className={"sweep-status " + purchase.status} data-purchase-label>
                    {[
                      bought ? purchaseAmount(purchase, words) : purchaseLabel(purchase, words),
                      purchasePlace(purchase),
                    ]
                      .filter(Boolean)
                      .join(" · ")}
                  </small>
                </span>
              </span>
              <span className="r">
                <b>{bought ? number(purchase.spent) : "—"}</b>
              </span>
            </div>
          );
        })}
      </div>
    </section>
  );
}

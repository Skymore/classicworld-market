import { useEffect, useRef, useState } from "react";
import { useWords } from "../providers";
import {
  OFFER_HOURS,
  OFFER_PERCENTILES,
  normalizeOfferFilters,
  filterOffers,
} from "/web/js/lib/item-offer-filters.js?v=20261023-advanced-offers-1";
import "./offer-filters.css";
export default function OfferFilterDialog({
  open,
  onClose,
  onApply,
  filters,
  rows,
  equipment = true,
  filterRows,
}: {
  open: boolean;
  onClose(): void;
  onApply(value: any): void;
  filters: any;
  rows: any[];
  equipment?: boolean;
  filterRows?: (rows: any[], filters: any) => any;
}) {
  const words = useWords(),
    dialog = useRef<HTMLDialogElement>(null);
  const [draft, setDraft] = useState<any>(filters);
  const preview = filterRows
    ? filterRows(rows, draft)
    : filterOffers(rows, "price", draft);
  useEffect(() => {
    if (open) {
      setDraft({ ...filters });
      dialog.current?.showModal();
    } else if (dialog.current?.open) dialog.current.close();
  }, [open]);
  const field = (
    key: string,
    title: string,
    options?: [string, string][],
    min = 0,
  ) => (
    <label className="offer-field">
      <span>{title}</span>
      {options ? (
        <select
          data-offer-hours={key === "hours" ? "" : undefined}
          data-offer-percentile={key === "percentile" ? "" : undefined}
          name={key}
          value={draft[key] ?? "all"}
          onChange={(event) =>
            setDraft((old: any) => ({ ...old, [key]: event.target.value }))
          }
        >
          {options.map(([value, label]) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </select>
      ) : (
        <input
          type="number"
          name={key}
          min={min}
          step={key === "minStock" ? "1" : "any"}
          inputMode="decimal"
          value={draft[key] ?? ""}
          placeholder={words("不限", "Any")}
          onChange={(event) =>
            setDraft((old: any) => ({ ...old, [key]: event.target.value }))
          }
        />
      )}
    </label>
  );
  return (
    <dialog
      id="offer-filter-dialog"
      className="offer-filter-dialog"
      ref={dialog}
      aria-labelledby="offer-filter-title"
      onClose={() => {
        onClose();
      }}
      onClick={(event) => {
        if (event.target === event.currentTarget) {
          const rect = event.currentTarget.getBoundingClientRect();
          if (
            event.clientX < rect.left ||
            event.clientX > rect.right ||
            event.clientY < rect.top ||
            event.clientY > rect.bottom
          )
            onClose();
        }
      }}
    >
      <form
        className="offer-filter-form"
        onSubmit={(event) => {
          event.preventDefault();
          onApply(normalizeOfferFilters(draft));
          onClose();
        }}
      >
        <header className="offer-filter-head">
          <div>
            <h3 id="offer-filter-title">
              {words("筛选报价", "Filter offers")}
            </h3>
            <p>
              {words(
                "组合条件，找到合适的报价",
                "Combine conditions to find the right offer",
              )}
            </p>
          </div>
          <button
            type="button"
            data-offer-close
            autoFocus
            aria-label={words("关闭筛选", "Close filters")}
            onClick={() => onClose()}
          >
            ×
          </button>
        </header>
        <div className="offer-filter-body">
          <fieldset>
            <legend>{words("时间与价格", "Time and price")}</legend>
            <div className="offer-field-grid">
              {field(
                "hours",
                words("报价时间", "Last observed"),
                OFFER_HOURS.map((value: string) => [
                  value,
                  value === "all"
                    ? words("全部时间", "Any time")
                    : value === "168"
                      ? words("最近 7 天", "Last 7 days")
                      : words(
                          `最近 ${value} 小时`,
                          `Last ${value} ${value === "1" ? "hour" : "hours"}`,
                        ),
                ]),
              )}
              {field(
                "percentile",
                words("价格百分位", "Price percentile"),
                OFFER_PERCENTILES.map((value: string) => [
                  value,
                  value === "all"
                    ? words("全部价格", "Any price")
                    : words(`最低 ${value}%`, `Lowest ${value}%`),
                ]),
              )}
              {field(
                "minPrice",
                words("最低单价（金币）", "Min unit price (mesos)"),
              )}
              {field(
                "maxPrice",
                words("最高单价（金币）", "Max unit price (mesos)"),
              )}
            </div>
            <p className="offer-field-hint">
              {words(
                filterRows
                  ? "百分位按每种物品符合关注条件的报价分别计算，临界同价一起保留。"
                  : "百分位按本物品全部挂单的单价计算，临界同价挂单一起保留。",
                filterRows
                  ? "Percentiles are calculated separately for each watched item’s matching offers, including ties."
                  : "Percentiles use all offers for this item; ties at the cutoff are included.",
              )}
            </p>
          </fieldset>
          <fieldset>
            <legend>{words("库存与属性", "Stock and stats")}</legend>
            <div className="offer-field-grid">
              {field("stock", words("库存信息", "Stock information"), [
                ["all", words("全部库存", "Any stock")],
                ["known", words("仅库存已知", "Known stock only")],
                ["unknown", words("仅库存未知", "Unknown stock only")],
              ])}
              {field(
                "minStock",
                words("最低库存数量", "Minimum stock"),
                undefined,
                1,
              )}
              {equipment &&
                field(
                  "equipment",
                  words("装备实际属性", "Captured equipment stats"),
                  [
                    ["all", words("全部属性", "Any stats")],
                    ["captured", words("已采集实际属性", "Stats captured")],
                    ["missing", words("未采集实际属性", "Stats not captured")],
                    ["bonus", words("只看有加成属性", "Bonus stats only")],
                  ],
                )}
            </div>
          </fieldset>
        </div>
        <footer className="offer-filter-foot">
          <p data-offer-preview role="status" aria-live="polite">
            {preview.cap == null
              ? words(
                  "所有条件同时生效，排序方式不影响筛选。",
                  "All conditions apply together, regardless of sort order.",
                )
              : words(
                  `价格百分位上限：单价 ${preview.cap.toLocaleString("zh-CN")}，含同价挂单。`,
                  `Percentile cutoff: unit price ${preview.cap.toLocaleString("en-US")}, including ties.`,
                )}
          </p>
          <div>
            <button
              type="button"
              className="btn"
              data-offer-reset
              onClick={() => setDraft(normalizeOfferFilters())}
            >
              {words("重置条件", "Reset filters")}
            </button>
            <button type="submit" className="btn primary" data-offer-apply>
              {words(
                `显示 ${preview.rows.length} 条报价`,
                `Show ${preview.rows.length} offers`,
              )}
            </button>
          </div>
        </footer>
      </form>
    </dialog>
  );
}

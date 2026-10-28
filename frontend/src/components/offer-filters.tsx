import { useEffect, useRef, useState } from "react";
import { useWords } from "../providers";
import {
  OFFER_HOURS,
  OFFER_PERCENTILES,
  EQUIPMENT_STATS,
  normalizeOfferFilters,
  filterOffers,
} from "/web/js/lib/item-offer-filters.js?v=20261027-watch-groups-1";
import "./offer-filters.css";
export default function OfferFilterDialog({
  open,
  onClose,
  onApply,
  filters,
  rows,
  equipment = true,
  filterRows,
  reminder = false,
  title,
}: {
  open: boolean;
  onClose(): void;
  onApply(value: any): void;
  filters: any;
  rows: any[];
  equipment?: boolean;
  filterRows?: (rows: any[], filters: any) => any;
  reminder?: boolean;
  title?: string;
}) {
  const words = useWords(),
    dialog = useRef<HTMLDialogElement>(null);
  const [draft, setDraft] = useState<any>(filters);
  const preview = filterRows
    ? filterRows(rows, draft)
    : filterOffers(rows, "price", draft);
  useEffect(() => {
    if (open) {
      setDraft(normalizeOfferFilters(filters));
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
          step={key === "minStock" || key === "minStat" || key.endsWith("Upgrades") ? "1" : "any"}
          max={
            key.endsWith("Upgrades") ? 15 : key === "minStat"
              ? 65535
              : reminder && key === "minPrice"
                ? 1e15
                : undefined
          }
          inputMode="decimal"
          value={draft[key] ?? ""}
          placeholder={key === "minStat" ? "1" : words("不限", "Any")}
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
              {title || words("筛选报价", "Filter offers")}
            </h3>
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
            <legend>
              {reminder
                ? words("价格", "Price")
                : words("时间与价格", "Time and price")}
            </legend>
            <div className="offer-field-grid">
              {!reminder &&
                field(
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
              {!reminder &&
                field(
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
              {!reminder &&
                field(
                  "maxPrice",
                  words("最高单价（金币）", "Max unit price (mesos)"),
                )}
            </div>
          </fieldset>
          <fieldset>
            <legend>
              {equipment ? words("库存与属性", "Stock and stats") : words("库存", "Stock")}
            </legend>
            <div className="offer-field-grid">
              {field("stock", words("库存信息", "Stock information"), [
                ["all", words("全部库存", "Any stock")],
                ["known", words("仅库存已知", "Known stock only")],
                ["unknown", words("仅库存未知", "Unknown stock only")],
              ])}
              {/* Equipment is listed one piece per slot: a stock minimum only fits stackable items. */}
              {!equipment &&
                field(
                  "minStock",
                  words("最低库存数量", "Minimum stock"),
                  undefined,
                  1,
                )}
              {equipment && (
                <>
                  {field("minUpgrades", words("可升级次数至少", "Min upgrades left"))}
                  {field("maxUpgrades", words("可升级次数至多", "Max upgrades left"))}
                  {field(
                    "equipment",
                    words("装备实际属性", "Captured equipment stats"),
                    [
                      ["all", words("全部属性", "Any stats")],
                      ["captured", words("已采集实际属性", "Stats captured")],
                      [
                        "missing",
                        words("未采集实际属性", "Stats not captured"),
                      ],
                      ["bonus", words("只看有加成属性", "Bonus stats only")],
                    ],
                  )}
                </>
              )}
            </div>
            {equipment && (
              <div className="offer-stat-conditions">
                {(draft.stats || []).map((condition: any, index: number) => (
                  <div className="offer-stat-row" data-stat-row key={index}>
                    <label className="offer-field">
                      <span>{words("属性", "Stat")}</span>
                      <select
                        aria-label={words(
                          `属性 ${index + 1}`,
                          `Stat ${index + 1}`,
                        )}
                        data-stat-key
                        value={condition.stat}
                        onChange={(event) =>
                          setDraft((old: any) => ({
                            ...old,
                            stats: old.stats.map((row: any, i: number) =>
                              i === index
                                ? { ...row, stat: event.target.value }
                                : row,
                            ),
                          }))
                        }
                      >
                        {EQUIPMENT_STATS.filter(
                          ([key]: string[]) =>
                            key === condition.stat ||
                            !draft.stats.some((row: any) => row.stat === key),
                        ).map(([key, zh, en]: string[]) => (
                          <option key={key} value={key}>
                            {words(zh, en)}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label className="offer-field">
                      <span>{words("最低属性值", "Minimum value")}</span>
                      <input
                        aria-label={words(
                          `最低属性值 ${index + 1}`,
                          `Minimum value ${index + 1}`,
                        )}
                        data-stat-min
                        type="number"
                        min="0"
                        max="65535"
                        step="1"
                        inputMode="numeric"
                        placeholder="1"
                        value={condition.min ?? ""}
                        onChange={(event) =>
                          setDraft((old: any) => ({
                            ...old,
                            stats: old.stats.map((row: any, i: number) =>
                              i === index
                                ? { ...row, min: event.target.value }
                                : row,
                            ),
                          }))
                        }
                      />
                    </label>
                    <button
                      type="button"
                      data-stat-remove
                      aria-label={words(
                        "移除属性条件",
                        "Remove stat condition",
                      )}
                      onClick={() =>
                        setDraft((old: any) => ({
                          ...old,
                          stats: old.stats.filter(
                            (_: any, i: number) => i !== index,
                          ),
                        }))
                      }
                    >
                      ×
                    </button>
                  </div>
                ))}
                <button
                  type="button"
                  className="btn"
                  data-stat-add
                  disabled={
                    (draft.stats || []).length >= EQUIPMENT_STATS.length
                  }
                  onClick={() =>
                    setDraft((old: any) => ({
                      ...old,
                      stats: [
                        ...(old.stats || []),
                        {
                          stat: EQUIPMENT_STATS.find(
                            ([key]: string[]) =>
                              !(old.stats || []).some(
                                (row: any) => row.stat === key,
                              ),
                          )[0],
                          min: null,
                        },
                      ],
                    }))
                  }
                >
                  {words("＋ 添加属性", "+ Add stat")}
                </button>
              </div>
            )}
          </fieldset>
        </div>
        <footer className="offer-filter-foot">
          <p
            data-offer-preview
            role="status"
            aria-live="polite"
            hidden={reminder || preview.cap == null}
          >
            {preview.cap != null &&
              words(
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
                reminder
                  ? `保存 · ${preview.rows.length} 条`
                  : `显示 ${preview.rows.length} 条报价`,
                reminder
                  ? `Save · ${preview.rows.length} offers`
                  : `Show ${preview.rows.length} offers`,
              )}
            </button>
          </div>
        </footer>
      </form>
    </dialog>
  );
}

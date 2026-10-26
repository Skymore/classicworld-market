import { useEffect, useRef, useState } from "react";
import { useWords } from "../providers";
import { Icon } from "./shared";
import OfferFilterDialog from "./offer-filters";
import {
  normalizeReminder,
  reminderSelection,
  reminderTokens,
} from "/web/js/lib/watch-reminders.js?v=20261026-reminders-1";
import "./watch-reminder.css";

const exactPrice = (value: number) =>
  value.toLocaleString(
    document.documentElement.lang === "en" ? "en-US" : "zh-CN",
    { maximumFractionDigits: 20 },
  );

export default function WatchReminder({
  id,
  name,
  setting,
  rows,
  reference,
  onChange,
}: {
  id: number;
  name: string;
  setting: any;
  rows: any[];
  reference: any;
  onChange(patch: any): void;
}) {
  const words = useWords(),
    root = useRef<HTMLDivElement>(null),
    trigger = useRef<HTMLButtonElement>(null);
  const [menu, setMenu] = useState(false),
    [manual, setManual] = useState(false),
    [advanced, setAdvanced] = useState(false);
  const [draft, setDraft] = useState(String(setting.cap ?? "")),
    [error, setError] = useState(false);
  const reminder = normalizeReminder(setting.reminder);
  const tokens = reminderTokens(
    reminder,
    document.documentElement.lang === "en",
  );
  const selected = reminderSelection(rows, id, setting, reference);
  useEffect(() => {
    if (!menu) return;
    const outside = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) {
        setMenu(false);
        setManual(false);
      }
    };
    document.addEventListener("pointerdown", outside);
    return () => document.removeEventListener("pointerdown", outside);
  }, [menu]);
  const close = () => {
    setMenu(false);
    setManual(false);
    trigger.current?.focus({ preventScroll: true });
  };
  const choose = (percentile: string) => {
    onChange({ reminder: { ...reminder, percentile } });
    close();
  };
  const saveManual = () => {
    const cap = draft.trim() === "" ? null : Number(draft);
    if (cap !== null && (!Number.isFinite(cap) || cap < 0 || cap > 1e15)) {
      setError(true);
      return;
    }
    onChange({ cap, reminder: { ...reminder, percentile: "all" } });
    setError(false);
    close();
  };
  return (
    <div
      className="watch-reminder"
      ref={root}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.stopPropagation();
          close();
        }
      }}
    >
      <button
        type="button"
        className="watch-reminder-trigger"
        ref={trigger}
        data-watch-reminder={id}
        aria-expanded={menu}
        aria-controls={`watch-reminder-menu-${id}`}
        onClick={() => {
          setMenu(!menu);
          setManual(false);
          setError(false);
          setDraft(String(setting.cap ?? ""));
        }}
      >
        <span>
          <small>{words("提醒价格", "Alert price")}</small>
          {reminder.percentile === "all"
            ? words("手动输入", "Manual")
            : words(
                `最低 ${reminder.percentile}%`,
                `Lowest ${reminder.percentile}%`,
              )}
        </span>
        <span className="watch-reminder-value">
          {reminder.percentile !== "all" && selected.cap === null ? (
            words("暂无挂价", "No offers")
          ) : selected.cap === null ? (
            words("不限", "Any price")
          ) : (
            <>≤ {exactPrice(selected.cap)}</>
          )}{" "}
          <Icon name="caret" />
        </span>
      </button>
      {menu && (
        <div className="watch-reminder-menu" id={`watch-reminder-menu-${id}`}>
          {["10", "25", "50"].map((percentile) => {
            const cap = reminderSelection(
              rows,
              id,
              { ...setting, reminder: { ...reminder, percentile } },
              reference,
            ).cap;
            return (
              <button
                type="button"
                key={percentile}
                data-reminder-preset={percentile}
                aria-pressed={reminder.percentile === percentile}
                onClick={() => choose(percentile)}
              >
                <span>
                  {reminder.percentile === percentile ? "✓ " : ""}
                  {words(`最低 ${percentile}%`, `Lowest ${percentile}%`)}
                </span>
                <span>
                  {cap === null ? (
                    words("暂无挂价", "No offers")
                  ) : (
                    <>≤ {exactPrice(cap)}</>
                  )}
                </span>
              </button>
            );
          })}
          <button
            type="button"
            data-reminder-manual
            aria-pressed={reminder.percentile === "all"}
            onClick={() => {
              setManual(true);
              setDraft(String(setting.cap ?? ""));
            }}
          >
            <span>
              {reminder.percentile === "all" ? "✓ " : ""}
              {words("手动输入", "Manual")}
            </span>
            <small>{words("固定限价", "Fixed cap")}</small>
          </button>
          {manual && (
            <div className="watch-reminder-manual">
              <label htmlFor={`watch-cap-${id}`}>
                {words("最高单价（金币）", "Max unit price (mesos)")}
              </label>
              <div>
                <input
                  id={`watch-cap-${id}`}
                  data-cap={id}
                  autoFocus
                  type="number"
                  min="0"
                  max="1000000000000000"
                  step="any"
                  inputMode="decimal"
                  value={draft}
                  placeholder={words("不限", "Any price")}
                  onChange={(event) => {
                    setDraft(event.target.value);
                    setError(false);
                  }}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") {
                      event.preventDefault();
                      saveManual();
                    }
                  }}
                />
                <button
                  type="button"
                  className="btn primary"
                  data-save-cap
                  onClick={saveManual}
                >
                  {words("保存", "Save")}
                </button>
              </div>
              {error && (
                <p role="alert">
                  {words("请输入有效的最高单价", "Enter a valid price cap")}
                </p>
              )}
            </div>
          )}
          <button
            type="button"
            className="watch-reminder-advanced"
            data-reminder-advanced
            onClick={() => {
              close();
              setAdvanced(true);
            }}
          >
            <span>
              <Icon name="funnel" /> {words("高级选项", "Advanced")}
            </span>
            <small>
              {tokens.length
                ? words(
                    `${tokens.length} 项条件`,
                    `${tokens.length} conditions`,
                  )
                : words("价格 · 库存", "Price · stock")}
            </small>
          </button>
        </div>
      )}
      {tokens.length > 0 && (
        <div className="watch-reminder-summary">
          {tokens.map((token: any) => (
            <span key={token.key}>{token.label}</span>
          ))}
          <button
            type="button"
            data-reminder-edit
            onClick={() => setAdvanced(true)}
          >
            {words("编辑", "Edit")}
          </button>
        </div>
      )}
      <OfferFilterDialog
        open={advanced}
        reminder
        title={words(`高级提醒 · ${name}`, `Advanced alerts · ${name}`)}
        equipment={Math.floor(id / 1000000) === 1}
        filters={{ ...reminder, percentile: "all" }}
        rows={rows.filter((row) => row.item_id === id)}
        filterRows={(candidates, filters) =>
          reminderSelection(
            candidates,
            id,
            {
              ...setting,
              reminder: {
                ...normalizeReminder(filters),
                percentile: reminder.percentile,
              },
            },
            reference,
          )
        }
        onApply={(filters) =>
          onChange({
            reminder: {
              ...normalizeReminder(filters),
              percentile: reminder.percentile,
            },
          })
        }
        onClose={() => {
          setAdvanced(false);
          trigger.current?.focus({ preventScroll: true });
        }}
      />
    </div>
  );
}

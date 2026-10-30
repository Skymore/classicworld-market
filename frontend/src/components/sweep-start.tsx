import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import { meso } from "/web/js/lib/format.js";
import { flush, getSyncState } from "/web/js/lib/user-data.js";
import { accountMessage } from "../pages/account-access";
import { rememberReturn } from "../lib/return-to";
import { useUserValue } from "../lib/live";
import { useWords } from "../providers";
import {
  dayClock,
  deviceBlocker,
  type Device,
  type Words,
} from "../lib/sweep-labels";
import type { Account } from "../lib/types";
import { Dialog, DialogContent, DialogTitle } from "./ui/dialog";

const MAX_BUDGET = 1e12;
// SWEEP.md: 5–10080 minutes, 10080 when not chosen.
const DEFAULT_MINUTES = 10080;
const DURATIONS: [number, string, string][] = [
  [60, "1 小时", "1 hour"],
  [360, "6 小时", "6 hours"],
  [1440, "24 小时", "24 hours"],
  [4320, "3 天", "3 days"],
  [10080, "7 天", "7 days"],
];
const QUICK_BUDGETS: [number, string][] = [
  [1e5, "100K"],
  [1e6, "1M"],
  [3e6, "3M"],
  [1e7, "10M"],
];

export function sweepMessage(words: Words, code: string) {
  const messages: Record<string, [string, string]> = {
    device_unavailable: ["所选设备不可用", "A selected device is unavailable"],
    sweep_running: ["已有一轮扫货在进行", "A sweep is already running"],
    no_sweep_groups: ["没有可扫货的条件组", "No sweep groups"],
    sweep_stopped: ["本轮已结束", "This sweep has ended"],
    reauth_required: ["请重新登录后再继续", "Sign in again to continue"],
    invalid_request: ["预算或时长不正确", "Check the budget and duration"],
    restart_required: ["请停止后重新开始扫货", "Stop and restart the sweep"],
    sync_pending: ["关注还在同步，请稍后再试", "Watches are still syncing"],
    collector_update_required: ["请更新采集端后再买命中的", "Update the collector to buy recent matches"],
  };
  return messages[code]
    ? words(...messages[code])
    : accountMessage(words, code);
}

/** "A、B、C" for up to three names, then "等 N 件". */
export function nameList(names: string[], words: Words) {
  const shown = names.slice(0, 3).join(words("、", ", "));
  return names.length > 3
    ? words(`${shown} 等 ${names.length} 件`, `${shown} and ${names.length - 3} more`)
    : shown;
}

/** Start body shared by both dialogs; local watch edits must reach the account first. */
async function start(post: (path: string, data: unknown) => Promise<any>, body: object) {
  await flush();
  const sync = getSyncState();
  if (sync.signed_in && (sync.pending || sync.status !== "synced"))
    throw Error("sync_pending");
  return post("/api/v1/account/sweep/start", body);
}

function useDeviceChoice(devices: Device[], blocker: (device: Device) => string | null) {
  const available = devices.filter((device) => !blocker(device));
  const [chosen, setChosen] = useState<string[]>(() => available.map((d) => d.id));
  // A device that goes offline while the dialog is open is unticked.
  useEffect(() => {
    setChosen((old) => old.filter((id) => available.some((d) => d.id === id)));
  }, [available.map((d) => d.id).join()]);
  return [chosen, setChosen] as const;
}

function DevicePicker({
  devices,
  chosen,
  setChosen,
  blocker,
}: {
  devices: Device[];
  chosen: string[];
  setChosen(update: (old: string[]) => string[]): void;
  blocker(device: Device): string | null;
}) {
  const words = useWords();
  return (
    <fieldset className="fsec sweep-device-list" data-sweep-device-list>
      <h4>{words("设备", "Devices")}</h4>
      {devices.length ? (
        devices.map((device) => {
          const why = blocker(device);
          const sweep = device.state?.sweep;
          const mesos = sweep?.holdings?.mesos;
          const facts = [
            mesos != null && words(`金币 ${mesos.toLocaleString()}`, `Mesos ${mesos.toLocaleString()}`),
            sweep?.max_spend ? words(`每轮最多花 ${meso(sweep.max_spend)}`, `Up to ${meso(sweep.max_spend)} per run`) : "",
          ].filter(Boolean).join(" · ");
          return (
            <label className="filter-check sweep-device" key={device.id} data-sweep-choice={device.id}>
              <input
                type="checkbox"
                disabled={Boolean(why)}
                checked={chosen.includes(device.id)}
                onChange={(event) =>
                  setChosen((old) =>
                    event.target.checked ? [...old, device.id] : old.filter((id) => id !== device.id),
                  )
                }
              />
              <span>{device.name}</span>
              {why ? <small data-sweep-blocker>{why}</small> : <small>{facts}</small>}
            </label>
          );
        })
      ) : (
        <p className="sweep-empty">{words("还没有设备登录", "No devices signed in")}</p>
      )}
    </fieldset>
  );
}

function BudgetField({
  budget,
  setBudget,
  hint,
  quick = false,
}: {
  budget: string;
  setBudget(value: string): void;
  hint: string;
  quick?: boolean;
}) {
  const words = useWords();
  return (
    <div className="fsec sweep-budget-field">
      <label className="offer-field">
        <span>{words("预算", "Budget")}</span>
        <span className="sweep-field">
          <input
            name="budget"
            type="number"
            inputMode="numeric"
            min={1}
            max={MAX_BUDGET}
            step={1}
            required
            value={budget}
            onChange={(event) => setBudget(event.target.value)}
          />
          <small>{hint}</small>
        </span>
      </label>
      {quick && (
        <div className="sweep-quick">
          {QUICK_BUDGETS.map(([value, label]) => (
            <button type="button" key={label} data-sweep-quick={value} onClick={() => setBudget(String(value))}>
              {label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
const validBudget = (value: number) =>
  Number.isSafeInteger(value) && value >= 1 && value <= MAX_BUDGET;

/** Full-market sweep: devices, budget, duration, password and a one-line summary. */
export function StartDialog({
  profile,
  devices,
  names,
  initialBudget,
  post,
  onDone,
  onClose,
  beforeStart,
}: {
  profile: Account;
  devices: Device[];
  names: string[];
  initialBudget?: number;
  post(path: string, data: unknown): Promise<any>;
  onDone(result: any): Promise<void>;
  onClose(): void;
  /** Runs right before the start request, e.g. stopping the current run. */
  beforeStart?(): Promise<void>;
}) {
  const words = useWords();
  const [saved, save] = useUserValue("sweep.lastStart", "{}");
  const last = (() => {
    try {
      return JSON.parse(saved) || {};
    } catch {
      return {};
    }
  })();
  const blocker = (device: Device) => deviceBlocker(device, words);
  const [chosen, setChosen] = useDeviceChoice(devices, blocker);
  const [budget, setBudget] = useState(
    initialBudget ? String(initialBudget) : last.budget ? String(last.budget) : "",
  );
  const [minutes, setMinutes] = useState<number>(
    last.durationVersion === 1 && DURATIONS.some(([m]) => m === last.minutes) ? last.minutes : DEFAULT_MINUTES,
  );
  const budgetValue = Number(budget);
  const valid = chosen.length >= 1 && chosen.length <= 8 && validBudget(budgetValue) && names.length > 0;
  return (
    <SweepDialog
      title={words("开始扫货", "Start sweep")}
      submit={words("开始", "Start")}
      profile={profile}
      disabled={!valid}
      onClose={onClose}
      summary={
        <div className="sweep-summary" data-sweep-start-summary>
          {[
            nameList(names, words),
            validBudget(budgetValue) && words(`预算 ${meso(budgetValue)}`, `budget ${meso(budgetValue)}`),
            words(
              `${dayClock(Date.now() + minutes * 60000, words)} 结束`,
              `ends ${dayClock(Date.now() + minutes * 60000, words)}`,
            ),
          ]
            .filter(Boolean)
            .join(" · ")}
        </div>
      }
      onSubmit={async (current_password) => {
        await beforeStart?.();
        const result = await start(post, {
          devices: chosen,
          budget: budgetValue,
          minutes,
          scan: { mode: "market" },
          current_password,
        });
        save(JSON.stringify({ budget: budgetValue, minutes, durationVersion: 1 }));
        await onDone(result);
      }}
    >
      <DevicePicker devices={devices} chosen={chosen} setChosen={setChosen} blocker={blocker} />
      <BudgetField
        budget={budget}
        setBudget={setBudget}
        hint={validBudget(budgetValue) ? meso(budgetValue) : ""}
        quick
      />
      <div className="fsec">
        <h4>{words("时长", "Duration")}</h4>
        <div className="sweep-choice" role="radiogroup" aria-label={words("时长", "Duration")}>
          {DURATIONS.map(([value, zh, en]) => (
            <button
              type="button"
              key={value}
              role="radio"
              aria-checked={minutes === value}
              data-sweep-duration={value}
              onClick={() => setMinutes(value)}
            >
              {words(zh, en)}
            </button>
          ))}
        </div>
      </div>
    </SweepDialog>
  );
}

export interface RecentHits {
  minutes: number;
  count: number;
  total: number;
  names: string[];
}
export const RECENT_RANGES: [number, string, string][] = [
  [10, "过去 10 分钟", "Last 10 minutes"],
  [30, "过去 30 分钟", "Last 30 minutes"],
  [60, "过去 1 小时", "Last hour"],
  [360, "过去 6 小时", "Last 6 hours"],
  [1440, "过去 24 小时", "Last 24 hours"],
];

/** Buy the recent matches first, then wait for new ones (scan mode "recent"). */
export function RecentDialog({
  profile,
  devices,
  hits,
  post,
  onDone,
  onClose,
}: {
  profile: Account;
  devices: Device[];
  hits: RecentHits;
  post(path: string, data: unknown): Promise<any>;
  onDone(result: any): Promise<void>;
  onClose(): void;
}) {
  const words = useWords();
  const blocker = (device: Device) =>
    deviceBlocker(device, words) ||
    (!device.state?.sweep?.recent_scan ? words("请更新采集端", "Update the collector") : null);
  const [chosen, setChosen] = useDeviceChoice(devices, blocker);
  const [budget, setBudget] = useState(String(Math.ceil(hits.total)));
  const budgetValue = Number(budget);
  const range = RECENT_RANGES.find(([m]) => m === hits.minutes)!;
  return (
    <SweepDialog
      title={words("先买命中的", "Buy matches first")}
      submit={words("去买", "Buy")}
      profile={profile}
      disabled={!(chosen.length >= 1 && chosen.length <= 8 && validBudget(budgetValue))}
      onClose={onClose}
      lead={
        <div className="sweep-summary lead" data-sweep-recent-summary>
          {words(
            `${range[1]}命中 ${hits.count} 条，涉及${nameList(hits.names, words)} · 买完后等新命中`,
            `${hits.count} matches in the ${range[2].toLowerCase()} (${nameList(hits.names, words)}) · then waits for new ones`,
          )}
        </div>
      }
      onSubmit={async (current_password) => {
        const result = await start(post, {
          devices: chosen,
          budget: budgetValue,
          // No duration to pick: the server defaults to 7 days.
          scan: { mode: "recent", recent_minutes: hits.minutes },
          current_password,
        });
        await onDone(result);
      }}
    >
      <DevicePicker devices={devices} chosen={chosen} setChosen={setChosen} blocker={blocker} />
      <BudgetField
        budget={budget}
        setBudget={setBudget}
        hint={words(`这 ${hits.count} 条合计 ${meso(hits.total)}`, `${hits.count} matches total ${meso(hits.total)}`)}
      />
    </SweepDialog>
  );
}

/** The site's dialog window: blue title bar, sections, password, footer buttons. */
function SweepDialog({
  title,
  submit,
  profile,
  disabled = false,
  lead,
  summary,
  onSubmit,
  onClose,
  children,
}: {
  title: string;
  submit: string;
  profile: Account;
  disabled?: boolean;
  lead?: ReactNode;
  summary?: ReactNode;
  onSubmit(currentPassword: string): Promise<void>;
  onClose(): void;
  children?: ReactNode;
}) {
  const words = useWords();
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function send(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      await onSubmit(password);
    } catch (failure) {
      setError((failure as Error).message);
      setBusy(false);
    }
  }
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent
        className="sweep-dialog sweep-start-dialog"
        closeLabel={words("关闭", "Close")}
        aria-describedby={undefined}
      >
        <div className="stall-bar">
          <DialogTitle>{title}</DialogTitle>
        </div>
        <form onSubmit={send} data-sweep-dialog>
          {lead}
          {children}
          {profile.has_password && (
            <div className="fsec">
              <label className="offer-field">
                <span>{words("当前密码", "Current password")}</span>
                <input
                  name="current_password"
                  type="password"
                  autoComplete="current-password"
                  required
                  maxLength={128}
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                />
              </label>
            </div>
          )}
          {summary}
          {error && (
            <div className="fsec sweep-dialog-error" role="alert" data-sweep-error>
              <span>{sweepMessage(words, error)}</span>
              {error === "reauth_required" && profile.google_enabled && (
                <a className="btn" href="/auth/google/start" onClick={() => rememberReturn("/watch")}>
                  {words("重新登录", "Sign in again")}
                </a>
              )}
            </div>
          )}
          <div className="ffoot">
            <button type="button" className="btn" onClick={onClose}>
              {words("取消", "Cancel")}
            </button>
            <button type="submit" className="btn primary" data-sweep-submit disabled={busy || disabled}>
              {submit}
            </button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

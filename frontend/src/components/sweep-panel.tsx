import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { watchGroups } from "/web/js/lib/watch-reminders.js?v=20261027-watch-groups-1";
import { meso } from "/web/js/lib/format.js";
import { flush, getSyncState } from "/web/js/lib/user-data.js";
import { accountMessage, postAccount } from "../pages/account-access";
import { getAccountJson, useAccountTopics } from "../lib/account-api";
import { queryClient } from "../lib/query";
import { rememberReturn } from "../lib/return-to";
import { useUserValue } from "../lib/live";
import { useWords } from "../providers";
import {
  deviceBlocker,
  stopReasonLabel,
  type Device,
  type SweepWatch,
  type SweepState,
  type Words,
} from "../lib/sweep-labels";
import type { Account } from "../lib/types";
import { Dialog, DialogContent, DialogTitle } from "./ui/dialog";
import { SweepRules, HoldingsRows } from "./sweep-content";
import { SweepDetails, RuleChangeNotice } from "./sweep-details";
import "./sweep-panel.css";

const SWEEP_KEY = ["account-sweep"] as const;
const MAX_BUDGET = 1e12;
const DEFAULT_MINUTES = 10080;

function sweepMessage(words: Words, code: string) {
  const messages: Record<string, [string, string]> = {
    device_unavailable: ["所选设备不可用", "A selected device is unavailable"],
    sweep_running: ["已有一轮扫货在进行", "A sweep is already running"],
    no_sweep_groups: ["没有可扫货的条件组", "No sweep groups"],
    sweep_stopped: ["本轮已结束", "This sweep has ended"],
    reauth_required: ["请重新登录后再继续", "Sign in again to continue"],
    invalid_request: ["预算或时长不正确", "Check the budget and duration"],
    restart_required: ["请停止后重新开始扫货", "Stop and restart the sweep"],
    sync_pending: ["关注还在同步，请稍后再试", "Watches are still syncing"],
    collector_update_required: ["请更新采集器后使用近期扫货", "Update the collector to scan recent matches"],
  };
  return messages[code]
    ? words(...messages[code])
    : accountMessage(words, code);
}

/** Watch-page control for sweeps run by the account's devices (SWEEP.md §3). */
export default function SweepPanel({
  profile,
  watches,
  items,
}: {
  profile: Account;
  watches: SweepWatch[];
  items: Map<number, any>;
}) {
  const words = useWords();
  const groups = watches.reduce((n, w) => n + w.groups.length, 0);
  const sweep = useQuery({
    queryKey: SWEEP_KEY,
    queryFn: ({ signal }) =>
      getAccountJson<SweepState>("/api/v1/account/sweep", signal),
    // Events drive updates; the minute tick only catches the end time.
    refetchInterval: (query) =>
      query.state.data?.run?.status === "running" ? 60_000 : false,
  });
  useAccountTopics(["sweep", "devices", "data"], SWEEP_KEY);
  const [dialog, setDialog] = useState<"start" | "details" | null>(null);
  const [mode, setMode] = useState<"market" | "recent">("market");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const run = sweep.data?.run || null;
  const running = run?.status === "running";
  const signature = (list: SweepWatch[]) =>
    JSON.stringify(
      [...list]
        .sort((a, b) => a.item_id - b.item_id)
        .map((w) => ({
          item_id: w.item_id,
          limit: w.limit,
          groups: watchGroups({ groups: w.groups }),
        })),
    );
  const changed = Boolean(
    run?.plan_stale ||
    (run?.plan && signature(run.plan.watches) !== signature(watches)),
  );
  const post = (path: string, data: unknown) =>
    postAccount(profile.csrf, path, data);
  async function adopt(result: any) {
    if (result && "run" in result) queryClient.setQueryData(SWEEP_KEY, result);
    else await queryClient.invalidateQueries({ queryKey: SWEEP_KEY });
  }
  async function stop() {
    if (!run) return;
    setBusy(true);
    setError("");
    try {
      await adopt(await post("/api/v1/account/sweep/stop", { run: run.id }));
    } catch (failure) {
      setError(sweepMessage(words, (failure as Error).message));
    } finally {
      setBusy(false);
    }
  }
  return (
    <section
      className="sweep-panel"
      data-sweep-panel
      data-sweep-state={!run ? "idle" : run.status}
      aria-label={words("扫货", "Sweep")}
    >
      <div className="sweep-bar">
        <b>{words("扫货", "Sweep")}</b>
        <span className="sweep-state" data-sweep-summary>
          {sweep.isError
            ? words("暂时无法加载", "Unavailable")
            : !sweep.data
              ? words("加载中…", "Loading…")
              : running
                ? `${words("运行中", "Running")} · ${words("预算", "Budget")} ${meso(run!.budget)}`
                : run
                  ? `${words("已结束", "Ended")} · ${stopReasonLabel(run.stop_reason, words)}`
                  : words(`${groups} 组已选`, `${groups} groups selected`)}
        </span>
        <div className="sweep-actions">
          {run && (
            <button
              type="button"
              className="btn primary"
              data-sweep-details
              onClick={() => setDialog("details")}
            >
              {words("查看详情", "View details")}
            </button>
          )}
          {!running && (
            <>
            <button
              type="button"
              className={"btn" + (run ? "" : " primary")}
              data-sweep-start
              disabled={!sweep.data || busy}
              onClick={() => { setMode("market"); setDialog("start"); }}
            >
              {words("全市场扫货", "Full market sweep")}
            </button>
            <button type="button" className="btn" data-sweep-recent
              disabled={!sweep.data || busy}
              onClick={() => { setMode("recent"); setDialog("start"); }}>
              {words("近期命中扫货", "Sweep recent matches")}
            </button>
            </>
          )}
        </div>
      </div>
      {error && (
        <p className="sweep-error" role="alert">
          {error}
        </p>
      )}
      {run && (
        <div className="sweep-compact-stats">
          {run.bought != null && (
            <span>
              {words("本轮已购", "Bought")} {run.bought.toLocaleString()}
            </span>
          )}
          <span>
            {words("已花", "Spent")} {meso(run.spent)}
          </span>
          <span>
            {words("预算剩余", "Budget left")} {meso(run.remaining)}
          </span>
        </div>
      )}
      {running && changed && <RuleChangeNotice />}
      {dialog === "details" && run && (
        <SweepDetails
          key={run.id}
          run={run}
          changed={changed}
          items={items}
          devices={sweep.data?.devices || []}
          busy={busy}
          error={error}
          onStop={stop}
          onClose={() => setDialog(null)}
        />
      )}

      {dialog === "start" && sweep.data && (
        <StartDialog
          mode={mode}
          profile={profile}
          devices={sweep.data.devices}
          watches={watches}
          items={items}
          post={post}
          onDone={async (result) => {
            await adopt(result);
            setDialog(null);
          }}
          onClose={() => setDialog(null)}
        />
      )}
    </section>
  );
}

function StartDialog({
  mode,
  profile,
  devices,
  watches,
  items,
  post,
  onDone,
  onClose,
}: {
  mode: "market" | "recent";
  profile: Account;
  devices: Device[];
  watches: SweepWatch[];
  items: Map<number, any>;
  post(path: string, data: unknown): Promise<any>;
  onDone(result: any): Promise<void>;
  onClose(): void;
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
  const blockerFor = (device: Device) => deviceBlocker(device, words) ||
    (mode === "recent" && !device.state?.sweep?.recent_scan ? words("请更新采集器", "Update collector") : null);
  const available = devices.filter((device) => !blockerFor(device));
  const [chosen, setChosen] = useState<string[]>(() =>
    available.map((device) => device.id),
  );
  const [budget, setBudget] = useState(last.budget ? String(last.budget) : "");
  const [minutes, setMinutes] = useState(
    String((last.durationVersion === 1 && last.minutes) || DEFAULT_MINUTES),
  );
  const [recentMinutes, setRecentMinutes] = useState("60");
  // A device that goes offline while the dialog is open is unticked.
  useEffect(() => {
    setChosen((old) =>
      old.filter((id) => available.some((device) => device.id === id)),
    );
  }, [available.map((device) => device.id).join()]);
  const budgetValue = Number(budget),
    minutesValue = Number(minutes);
  const valid =
    chosen.length >= 1 &&
    chosen.length <= 8 &&
    Number.isSafeInteger(budgetValue) &&
    budgetValue >= 1 &&
    budgetValue <= MAX_BUDGET &&
    Number.isInteger(minutesValue) &&
    minutesValue >= 5 &&
    minutesValue <= 10080;
  return (
    <SweepDialog
      title={mode === "recent" ? words("近期命中扫货", "Sweep recent matches") : words("全市场扫货", "Full market sweep")}
      submit={words("开始", "Start")}
      profile={profile}
      disabled={!valid || watches.length === 0}
      onClose={onClose}
      onSubmit={async (current_password) => {
        await flush();
        const sync = getSyncState();
        if (sync.signed_in && (sync.pending || sync.status !== "synced"))
          throw Error("sync_pending");
        const result = await post("/api/v1/account/sweep/start", {
          devices: chosen,
          budget: budgetValue,
          minutes: minutesValue,
          scan: mode === "recent" ? { mode, recent_minutes: Number(recentMinutes) } : { mode },
          current_password,
        });
        save(
          JSON.stringify({
            budget: budgetValue,
            minutes: minutesValue,
            durationVersion: 1,
          }),
        );
        await onDone(result);
      }}
    >
      {mode === "recent" && <div className="fsec">
        <label className="offer-field"><span>{words("命中时间范围", "Matched within")}</span>
          <select value={recentMinutes} onChange={(event) => setRecentMinutes(event.target.value)}>
            {[[10,"过去 10 分钟","Last 10 minutes"],[30,"过去 30 分钟","Last 30 minutes"],[60,"过去 1 小时","Last hour"],[360,"过去 6 小时","Last 6 hours"],[1440,"过去 24 小时","Last 24 hours"]].map(([value,zh,en]) =>
              <option key={value} value={value}>{words(String(zh),String(en))}</option>)}
          </select>
        </label>
        <small>{words("回访符合条件的店铺，到店后核价购买。", "Revisit matching shops and verify prices before buying.")}</small>
      </div>}
      <SweepRules watches={watches} items={items} />
      <HoldingsRows
        devices={devices.filter((d) => chosen.includes(d.id))}
        watches={watches}
        items={items}
      />
      <fieldset className="fsec sweep-device-list" data-sweep-device-list>
        <h4>
          {words("设备", "Devices")}
          <small>
            {words(`已选 ${chosen.length} 台`, `${chosen.length} selected`)}
          </small>
        </h4>
        {devices.length ? (
          devices.map((device) => {
            const blocker = blockerFor(device);
            return (
              <label
                className="filter-check sweep-device"
                key={device.id}
                data-sweep-choice={device.id}
              >
                <input
                  type="checkbox"
                  disabled={Boolean(blocker)}
                  checked={chosen.includes(device.id)}
                  onChange={(event) =>
                    setChosen((old) =>
                      event.target.checked
                        ? [...old, device.id]
                        : old.filter((id) => id !== device.id),
                    )
                  }
                />
                <span>{device.name}</span>
                {blocker && <small data-sweep-blocker>{blocker}</small>}
              </label>
            );
          })
        ) : (
          <p className="sweep-empty">
            {words("还没有设备登录", "No devices signed in")}
          </p>
        )}
      </fieldset>
      <div className="fsec offer-field-grid">
        <label className="offer-field">
          <span>
            {words("预算", "Budget")}
            {budgetValue > 0 && <small> · {meso(budgetValue)}</small>}
          </span>
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
        </label>
        <label className="offer-field">
          <span>
            {words("时长（分钟，最长 7 天）", "Duration (min, up to 7 days)")}
          </span>
          <input
            name="minutes"
            type="number"
            inputMode="numeric"
            min={5}
            max={10080}
            step={1}
            required
            value={minutes}
            onChange={(event) => setMinutes(event.target.value)}
          />
        </label>
      </div>
    </SweepDialog>
  );
}

/** The site's dialog window: blue title bar, sections, footer buttons. */
function SweepDialog({
  title,
  submit,
  profile,
  disabled = false,
  onSubmit,
  onClose,
  children,
}: {
  title: string;
  submit: string;
  profile: Account;
  disabled?: boolean;
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
        className="sweep-dialog"
        closeLabel={words("关闭", "Close")}
        aria-describedby={undefined}
      >
        <div className="stall-bar">
          <DialogTitle>{title}</DialogTitle>
        </div>
        <form onSubmit={send} data-sweep-dialog>
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
          {error && (
            <div
              className="fsec sweep-dialog-error"
              role="alert"
              data-sweep-error
            >
              <span>{sweepMessage(words, error)}</span>
              {error === "reauth_required" && profile.google_enabled && (
                <a
                  className="btn"
                  href="/auth/google/start"
                  onClick={() => rememberReturn("/watch")}
                >
                  {words("重新登录", "Sign in again")}
                </a>
              )}
            </div>
          )}
          <div className="ffoot">
            <button type="button" className="btn" onClick={onClose}>
              {words("取消", "Cancel")}
            </button>
            <button
              type="submit"
              className="btn primary"
              data-sweep-submit
              disabled={busy || disabled}
            >
              {submit}
            </button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

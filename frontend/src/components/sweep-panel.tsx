import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import { useQueries, useQuery } from "@tanstack/react-query";
import { getJson, qs, api } from "/web/js/lib/api.js?v=20261022-auto-watch-2";
import { itemName } from "/web/js/lib/i18n.js";
import { meso } from "/web/js/lib/format.js";
import { flush, getSyncState } from "/web/js/lib/user-data.js";
import { accountMessage, postAccount } from "../pages/account-access";
import { getAccountJson, useAccountTopics } from "../lib/account-api";
import { queryClient } from "../lib/query";
import { rememberReturn } from "../lib/return-to";
import { useUserValue } from "../lib/live";
import { useWords } from "../providers";
import {
  clockTime,
  deviceBlocker,
  participantLabel,
  purchaseLabel,
  purchasePlace,
  stopReasonLabel,
  type Device,
  type Purchase,
  type Run,
  type SweepState,
  type Words,
} from "../lib/sweep-labels";
import type { Account } from "../lib/types";
import { Dialog, DialogContent, DialogTitle } from "./ui/dialog";
import "./sweep-panel.css";

const SWEEP_KEY = ["account-sweep"] as const;
const PURCHASES_SHOWN = 20;
const PURCHASES_FOLDED = 5;
const MAX_BUDGET = 1e12;
const DEFAULT_MINUTES = 120;

function sweepMessage(words: Words, code: string) {
  const messages: Record<string, [string, string]> = {
    device_unavailable: ["所选设备不可用", "A selected device is unavailable"],
    sweep_running: ["已有一轮扫货在进行", "A sweep is already running"],
    no_sweep_groups: ["没有可扫货的条件组", "No sweep groups"],
    sweep_stopped: ["本轮已结束", "This sweep has ended"],
    reauth_required: ["请重新登录后再继续", "Sign in again to continue"],
    invalid_request: ["预算或时长不正确", "Check the budget and duration"],
    sync_pending: ["关注还在同步，请稍后再试", "Watches are still syncing"],
  };
  return messages[code] ? words(...messages[code]) : accountMessage(words, code);
}

/** Watch-page control for sweeps run by the account's devices (SWEEP.md §3). */
export default function SweepPanel({
  profile,
  groups,
  items,
}: {
  profile: Account;
  groups: number;
  items: Map<number, any>;
}) {
  const words = useWords();
  const sweep = useQuery({
    queryKey: SWEEP_KEY,
    queryFn: ({ signal }) =>
      getAccountJson<SweepState>("/api/v1/account/sweep", signal),
    // Events drive updates; the minute tick only catches the end time.
    refetchInterval: (query) =>
      query.state.data?.run?.status === "running" ? 60_000 : false,
  });
  useAccountTopics(["sweep", "devices"], SWEEP_KEY);
  const [dialog, setDialog] = useState<"start" | "apply" | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const run = sweep.data?.run || null;
  const running = run?.status === "running";
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
        {running ? (
          <button
            type="button"
            className="btn"
            data-sweep-stop
            disabled={busy}
            onClick={() => void stop()}
          >
            {words("停止", "Stop")}
          </button>
        ) : (
          <button
            type="button"
            className="btn primary"
            data-sweep-start
            disabled={!sweep.data || busy}
            onClick={() => setDialog("start")}
          >
            {words("开始扫货", "Start sweep")}
          </button>
        )}
      </div>
      {error && (
        <p className="sweep-error" role="alert">
          {error}
        </p>
      )}
      {run && (
        <RunDetails run={run} items={items} onApply={() => setDialog("apply")} />
      )}
      {dialog === "start" && sweep.data && (
        <StartDialog
          profile={profile}
          devices={sweep.data.devices}
          groups={groups}
          post={post}
          onDone={async (result) => {
            await adopt(result);
            setDialog(null);
          }}
          onClose={() => setDialog(null)}
        />
      )}
      {dialog === "apply" && run && (
        <SweepDialog
          title={words("应用到本轮", "Apply to this sweep")}
          submit={words("应用", "Apply")}
          profile={profile}
          onClose={() => setDialog(null)}
          onSubmit={async (current_password) => {
            await adopt(
              await post("/api/v1/account/sweep/apply", {
                run: run.id,
                current_password,
              }),
            );
            setDialog(null);
          }}
        />
      )}
    </section>
  );
}

function RunDetails({
  run,
  items,
  onApply,
}: {
  run: Run;
  items: Map<number, any>;
  onApply(): void;
}) {
  const words = useWords();
  const running = run.status === "running";
  const [allPurchases, setAllPurchases] = useState(false);
  const purchases = run.purchases.slice(0, PURCHASES_SHOWN);
  const name = useItemNames(purchases.map((row) => row.item_id), items);
  const stats: [string, ReactNode, string][] = running
    ? [
        [words("已花", "Spent"), meso(run.spent), "spent"],
        [words("预留", "Held"), meso(run.reserved), "reserved"],
        [words("未知", "Unknown"), meso(run.unknown), "unknown"],
        [words("剩余", "Left"), meso(run.remaining), "remaining"],
        [words("结束", "Ends"), clockTime(run.ends_at, isEnglish()), "ends"],
      ]
    : [
        [words("已花", "Spent"), meso(run.spent), "spent"],
        [words("未知", "Unknown"), meso(run.unknown), "unknown"],
        [words("预算", "Budget"), meso(run.budget), "budget"],
      ];
  return (
    <>
      <div className={"sweep-stats" + (running ? "" : " ended")}>
        {stats.map(([label, value, key]) => (
          <div key={key} data-sweep-stat={key}>
            <small>{label}</small>
            <b>{value}</b>
          </div>
        ))}
      </div>
      {running && run.plan_stale && (
        <div className="sweep-stale" data-sweep-stale>
          <span>{words("规则已修改", "Rules changed")}</span>
          <button type="button" className="btn" data-sweep-apply onClick={onApply}>
            {words("应用到本轮", "Apply to this sweep")}
          </button>
        </div>
      )}
      {run.devices.length > 0 && (
        <div className="sweep-list" data-sweep-devices>
          {run.devices.map((device) => (
            <div className="sweep-row" key={device.id} data-sweep-device={device.id}>
              <span className="sweep-row-main">
                <b>{device.name}</b>
                <small>
                  {[participantLabel(device.state, words), device.message]
                    .filter(Boolean)
                    .join(" · ")}
                </small>
              </span>
              <span className="sweep-row-side">
                <b>{meso(device.spent)}</b>
                <small className={device.online ? "sweep-online" : ""}>
                  {device.online ? words("在线", "Online") : words("离线", "Offline")}
                </small>
              </span>
            </div>
          ))}
        </div>
      )}
      {purchases.length > 0 && (
        <div className="sweep-list" data-sweep-purchases>
          <h3 className="sweep-head">
            {words("购买记录", "Purchases")} <small>{purchases.length}</small>
          </h3>
          {purchases
            .slice(0, allPurchases ? undefined : PURCHASES_FOLDED)
            .map((row) => (
              <PurchaseRow key={row.id} row={row} name={name(row.item_id)} />
            ))}
          {!allPurchases && purchases.length > PURCHASES_FOLDED && (
            <button
              type="button"
              className="more"
              data-sweep-more
              onClick={() => setAllPurchases(true)}
            >
              {words(
                `再显示 ${purchases.length - PURCHASES_FOLDED} 条`,
                `Show ${purchases.length - PURCHASES_FOLDED} more`,
              )}
            </button>
          )}
        </div>
      )}
    </>
  );
}

function PurchaseRow({ row, name }: { row: Purchase; name: string }) {
  const words = useWords();
  const amount =
    row.units && row.units !== row.quantity
      ? words(`${row.quantity} 组 · ${row.units} 件`, `${row.quantity} lots · ${row.units} pcs`)
      : words(`${row.units || row.quantity || 0} 件`, `${row.units || row.quantity || 0} pcs`);
  return (
    <div className="sweep-row" data-purchase={row.id} data-purchase-status={row.status}>
      <span className="sweep-row-main">
        <b>{name}</b>
        <small>
          {[amount, row.price != null && `@${meso(row.price)}`, purchasePlace(row)]
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

const isEnglish = () => document.documentElement.lang === "en";

/** Names from the watch page's catalogue rows, looking up the rest. */
function useItemNames(ids: number[], items: Map<number, any>) {
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

function StartDialog({
  profile,
  devices,
  groups,
  post,
  onDone,
  onClose,
}: {
  profile: Account;
  devices: Device[];
  groups: number;
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
  const available = devices.filter((device) => !deviceBlocker(device, words));
  const [chosen, setChosen] = useState<string[]>(() =>
    available.map((device) => device.id),
  );
  const [budget, setBudget] = useState(last.budget ? String(last.budget) : "");
  const [minutes, setMinutes] = useState(String(last.minutes || DEFAULT_MINUTES));
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
    minutesValue <= 720;
  return (
    <SweepDialog
      title={words("开始扫货", "Start sweep")}
      submit={words("开始", "Start")}
      profile={profile}
      disabled={!valid || groups === 0}
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
          current_password,
        });
        save(JSON.stringify({ budget: budgetValue, minutes: minutesValue }));
        await onDone(result);
      }}
    >
      <fieldset className="fsec sweep-device-list" data-sweep-device-list>
        <h4>
          {words("设备", "Devices")}
          <small>{words(`已选 ${chosen.length} 台`, `${chosen.length} selected`)}</small>
        </h4>
        {devices.length ? (
          devices.map((device) => {
            const blocker = deviceBlocker(device, words);
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
          <p className="sweep-empty">{words("还没有设备登录", "No devices signed in")}</p>
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
          <span>{words("时长（分钟）", "Duration (min)")}</span>
          <input
            name="minutes"
            type="number"
            inputMode="numeric"
            min={5}
            max={720}
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
            <div className="fsec sweep-dialog-error" role="alert" data-sweep-error>
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

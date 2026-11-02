import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { watchGroups, watchSelection } from "/web/js/lib/watch-reminders.js?v=20261027-watch-groups-1";
import { meso } from "/web/js/lib/format.js";
import { itemName } from "/web/js/lib/i18n.js";
import { postAccount } from "../pages/account-access";
import { getAccountJson, useAccountTopics } from "../lib/account-api";
import { queryClient } from "../lib/query";
import { useWords } from "../providers";
import {
  dayClock,
  deviceActivity,
  duration,
  runWatches,
  type Device,
  type Run,
  type RunDevice,
  type SweepWatch,
  type SweepState,
} from "../lib/sweep-labels";
import type { Account } from "../lib/types";
import { RulesTable, RecentPurchases } from "./sweep-content";
import { SweepDetails, RuleChangeNotice } from "./sweep-details";
import {
  RecentDialog,
  StartDialog,
  RECENT_RANGES,
  sweepMessage,
  type RecentHits,
} from "./sweep-start";
import "./sweep-panel.css";

const SWEEP_KEY = ["account-sweep"] as const;
// Collectors before the structured `pending` field only said so in their progress message.
const RECENT_IDLE = "等待新的命中";
const number = (value: number | null | undefined) =>
  value == null ? "—" : value.toLocaleString();
const at = (value?: string | null) => (value ? Date.parse(value) : NaN);

/** The account's current or last sweep (SWEEP.md §3), refreshed by account events. */
export function useSweep(enabled: boolean) {
  const sweep = useQuery({
    queryKey: SWEEP_KEY,
    enabled,
    queryFn: ({ signal }) =>
      getAccountJson<SweepState>("/api/v1/account/sweep", signal),
    // Events drive updates; the minute tick only catches the end time.
    refetchInterval: (query) =>
      query.state.data?.run?.status === "running" ? 60_000 : false,
  });
  useAccountTopics(["sweep", "devices", "data"], SWEEP_KEY, enabled);
  return sweep;
}
export const isRecentRun = (run: Run | null | undefined) =>
  run?.plan?.scan?.mode === "recent";

/**
 * Matching offers inside the last `minutes` that the sweep rules would buy,
 * cheapest first and cut at each item's quantity limit.
 */
function recentHits(
  rows: any[],
  watches: SweepWatch[],
  reference: any,
  minutes: number,
  now: number,
  name: (id: number) => string,
): RecentHits {
  const since = now - minutes * 60;
  let count = 0,
    total = 0;
  const names: string[] = [];
  for (const watch of watches) {
    const offers = watchSelection(rows, watch.item_id, { groups: watch.groups }, reference)
      .rows.filter((row: any) => Number(row.observed) >= since)
      .sort((a: any, b: any) => a.unit_price - b.unit_price);
    let left = watch.limit > 0 ? watch.limit : Infinity;
    let used = false;
    for (const row of offers) {
      // Throwing stars and bullets are priced and bought per set; other lots hold `bundle` pieces.
      const perLot = row.unit_basis === "set" ? 1 : Math.max(1, row.bundle || 1);
      const lots = Number.isSafeInteger(row.stock) && row.stock > 0 ? row.stock : 1;
      const take = Math.min(lots, Math.floor(left / perLot));
      if (take < 1) continue;
      left -= take * perLot;
      total += take * perLot * row.unit_price;
      count++;
      used = true;
    }
    if (used) names.push(name(watch.item_id));
  }
  return { minutes, count, total, names };
}

function signature(list: SweepWatch[]) {
  return JSON.stringify(
    [...list]
      .sort((a, b) => a.item_id - b.item_id)
      .map((w) => ({ item_id: w.item_id, limit: w.limit, groups: watchGroups({ groups: w.groups }) })),
  );
}

type Dialog =
  | { kind: "start"; budget?: number; replace?: string }
  | { kind: "recent"; hits: RecentHits }
  | { kind: "details"; tab: "progress" | "records" };

/** The watch page's sweep tab: status and actions, the rules table and the latest purchases. */
export default function SweepPanel({
  profile,
  sweep,
  watches,
  items,
  rows,
  reference,
  rulesOnly = false,
  onLimit,
  onEditRules,
  onEditGroup,
}: {
  profile: Account;
  sweep: ReturnType<typeof useSweep>;
  watches: SweepWatch[];
  items: Map<number, any>;
  rows: any[];
  reference: any;
  /** The collector's embedded page: only the editable rules table. */
  rulesOnly?: boolean;
  onLimit(itemId: number, limit: number): void;
  onEditRules(): void;
  onEditGroup?(itemId:number,groupId:string):void;
}) {
  const words = useWords();
  const [dialog, setDialog] = useState<Dialog | null>(null);
  const [confirmStop, setConfirmStop] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [range, setRange] = useState(60);
  // Re-render every 30 s for elapsed time and the hit window; times use the render's clock.
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const timer = window.setInterval(() => setTick((n) => n + 1), 30_000);
    return () => clearInterval(timer);
  }, []);
  const now = Date.now();
  const run = sweep.data?.run || null;
  const devices = sweep.data?.devices || [];
  const running = run?.status === "running";
  useEffect(() => {
    if (!running) setConfirmStop(false);
  }, [running]);
  const changed = Boolean(
    run?.plan_stale || (run?.plan && signature(run.plan.source_watches || run.plan.watches) !== signature(watches)),
  );
  const name = (id: number) => {
    const row = items.get(id);
    return row ? itemName(row) : String(id);
  };
  const hits = useMemo(
    () => recentHits(rows, watches, reference, range, Date.now() / 1000, name),
    [rows, watches, reference, range, tick, items],
  );
  if (rulesOnly)
    return (
      <section className="sweep-panel" data-sweep-panel data-sweep-state="rules" aria-label={words("扫货", "Sweep")}>
        <RulesTable watches={watches} items={items} onLimit={onLimit} onEdit={onEditRules} onEditGroup={onEditGroup} />
      </section>
    );

  const post = (path: string, data: unknown) => postAccount(profile.csrf, path, data);
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
      setConfirmStop(false);
    }
  }
  const finish = async (result: any) => {
    await adopt(result);
    setDialog(null);
  };
  const state = !run ? "idle" : run.status;
  return (
    <section className="sweep-panel" data-sweep-panel data-sweep-state={state} aria-label={words("扫货", "Sweep")}>
      <div className="sweep-console">
        {sweep.isError ? (
          <div className="sweep-line"><b>{words("暂时无法加载", "Unavailable")}</b></div>
        ) : !sweep.data ? (
          <div className="sweep-line"><b>{words("加载中…", "Loading…")}</b></div>
        ) : running ? (
          <RunningConsole
            run={run!}
            now={now}
            confirmStop={confirmStop}
            busy={busy}
            onDetails={() => setDialog({ kind: "details", tab: "progress" })}
            onStop={() => setConfirmStop(true)}
            onConfirmStop={stop}
            onCancelStop={() => setConfirmStop(false)}
          />
        ) : (
          <IdleConsole
            run={run}
            devices={devices}
            items={watches.length}
            onStart={() => setDialog({ kind: "start" })}
            onRecords={() => setDialog({ kind: "details", tab: "records" })}
          />
        )}
        {error && <p className="sweep-error" role="alert">{error}</p>}
      </div>
      {running && isRecentRun(run) && drained(run!) && (
        <div className="sweep-wait" data-sweep-wait>
          <span>{words("有新命中会自动去买。想扫整个市场，就", "New matches are bought automatically. To sweep the whole market,")}</span>
          <button
            type="button"
            className="btn"
            data-sweep-convert
            disabled={busy}
            onClick={() => setDialog({ kind: "start", budget: run!.remaining, replace: run!.id })}
          >
            {words("转为全市场扫货", "Switch to full market")}
          </button>
        </div>
      )}
      {running && changed && <RuleChangeNotice />}
      {running ? (
        <RulesTable watches={run!.plan ? runWatches(run!.plan) : watches} items={items} run={run} onEditGroup={onEditGroup} />
      ) : (
        <RulesTable
          watches={watches}
          items={items}
          devices={sweep.data ? devices : undefined}
          onLimit={onLimit}
          onEdit={onEditRules}
          onEditGroup={onEditGroup}
        />
      )}
      {running && (
        <RecentPurchases run={run!} items={items} onAll={() => setDialog({ kind: "details", tab: "records" })} />
      )}
      {dialog?.kind === "details" && run && (
        <SweepDetails
          key={run.id}
          run={run}
          changed={changed}
          items={items}
          devices={devices}
          busy={busy}
          error={error}
          initialTab={dialog.tab}
          onStop={stop}
          onClose={() => setDialog(null)}
          onEditGroup={onEditGroup}
        />
      )}
      {dialog?.kind === "start" && sweep.data && (
        <StartDialog
          profile={profile}
          devices={devices}
          names={watches.map((w) => name(w.item_id))}
          initialBudget={dialog.budget}
          post={post}
          beforeStart={dialog.replace ? stopOnce(dialog.replace, post, adopt) : undefined}
          onDone={finish}
          onClose={() => setDialog(null)}
        />
      )}
      {dialog?.kind === "recent" && sweep.data && (
        <RecentDialog
          profile={profile}
          devices={devices}
          hits={dialog.hits}
          post={post}
          onDone={finish}
          onClose={() => setDialog(null)}
        />
      )}
    </section>
  );
}

/** Switching to a full-market sweep stops the recent run once, even if the start is retried. */
function stopOnce(
  runId: string,
  post: (path: string, data: unknown) => Promise<any>,
  adopt: (result: any) => Promise<void>,
) {
  let stopped = false;
  return async () => {
    if (stopped) return;
    await adopt(await post("/api/v1/account/sweep/stop", { run: runId }));
    stopped = true;
  };
}

/** Shops a device still has to revisit: the heartbeat's `pending`, or the message of an older collector. */
function revisits(device: RunDevice) {
  if (device.pending != null) return device.pending;
  if (device.message?.startsWith(RECENT_IDLE)) return 0;
  const said = device.message?.match(/待访\s*(\d+)\s*处/)?.[1];
  return said ? Number(said) : null;
}
/** Every device that is buying recent matches reports an empty queue. */
function drained(run: Run) {
  const active = run.devices.filter((d) => d.online && d.state === "active");
  return active.length > 0 && active.every((d) => revisits(d) === 0);
}
/** Shops left to revisit, summed over the devices that report it. */
function pendingPlaces(run: Run) {
  const counts = run.devices.map(revisits).filter((n): n is number => n != null);
  return counts.length ? counts.reduce((a, b) => a + b, 0) : null;
}
const checkedShops = (run: Run) =>
  run.devices.length && run.devices.every((d) => d.checked != null)
    ? run.devices.reduce((sum, d) => sum + d.checked!, 0)
    : null;

function IdleConsole({
  run,
  devices,
  items,
  onStart,
  onRecords,
}: {
  run: Run | null;
  devices: Device[];
  items: number;
  onStart(): void;
  onRecords(): void;
}) {
  const words = useWords();
  const online = devices.filter((d) => d.online).map((d) => d.name);
  return (
    <>
      <div className="sweep-line">
        <b data-sweep-summary>{words("未开始", "Not running")}</b>
        <span className="sweep-sub">
          {[
            words(`${items} 件物品`, `${items} items`),
            online.length
              ? words(`${online.join("、")}在线`, `${online.join(", ")} online`)
              : words("没有设备在线", "No device online"),
          ].join(" · ")}
        </span>
        <button
          type="button"
          className="btn primary sweep-push"
          data-sweep-start
          disabled={!items}
          onClick={onStart}
        >
          {words("开始扫货", "Start sweep")}
        </button>
      </div>
      {run && (
        <div className="sweep-last" data-sweep-last>
          {[
            words(
              `上一轮 ${dayClock(run.stopped_at || run.ends_at, words)} 结束`,
              `Last run ended ${dayClock(run.stopped_at || run.ends_at, words)}`,
            ),
            words(`花 ${number(run.spent)}`, `spent ${number(run.spent)}`),
            run.bought != null && words(`买到 ${number(run.bought)} 件`, `bought ${number(run.bought)}`),
          ]
            .filter(Boolean)
            .join(" · ")}
          {" · "}
          <button type="button" className="sweep-link" data-sweep-details onClick={onRecords}>
            {words("记录", "Records")}
          </button>
        </div>
      )}
    </>
  );
}

function RunningConsole({
  run,
  now,
  confirmStop,
  busy,
  onDetails,
  onStop,
  onConfirmStop,
  onCancelStop,
}: {
  run: Run;
  now: number;
  confirmStop: boolean;
  busy: boolean;
  onDetails(): void;
  onStop(): void;
  onConfirmStop(): void;
  onCancelStop(): void;
}) {
  const words = useWords();
  const recent = isRecentRun(run);
  const empty = recent && drained(run);
  const elapsed = words(
    `已运行 ${duration(Math.min(now, at(run.ends_at)) - at(run.started_at), words)}`,
    `running ${duration(Math.min(now, at(run.ends_at)) - at(run.started_at), words)}`,
  );
  const bought = run.bought != null ? number(run.bought) : null;
  const pending = pendingPlaces(run);
  const checked = checkedShops(run);
  const detail = !recent
    ? [elapsed, words(`${dayClock(run.ends_at, words)} 结束`, `ends ${dayClock(run.ends_at, words)}`)]
    : empty
      ? [
          checked != null && words(`已查 ${number(checked)} 店次`, `${number(checked)} shop checks`),
          bought != null && words(`买到 ${bought} 件`, `bought ${bought}`),
          words("等新命中", "waiting for new matches"),
        ]
      : [
          pending != null && words(`剩 ${pending} 处待回访`, `${pending} places to revisit`),
          bought != null && words(`已买 ${bought} 件`, `bought ${bought}`),
          elapsed,
        ];
  const percent = run.budget > 0 ? Math.min(100, (run.spent / run.budget) * 100) : 0;
  return (
    <>
      <div className="sweep-line">
        <i className="sweep-dot" aria-hidden="true" />
        <b data-sweep-summary>
          {!recent
            ? words("运行中", "Running")
            : empty
              ? words("命中的都看过了", "All matches checked")
              : words("正在买命中的", "Buying matches")}
        </b>
        <span className="sweep-push sweep-buttons">
          <button type="button" className="btn" data-sweep-details onClick={onDetails}>
            {words("详情", "Details")}
          </button>
          {confirmStop ? (
            <>
              <button type="button" className="btn sweep-stop-button" data-sweep-confirm-stop disabled={busy} onClick={onConfirmStop}>
                {words("确定停止", "Confirm stop")}
              </button>
              <button type="button" className="btn" data-sweep-cancel-stop disabled={busy} onClick={onCancelStop}>
                {words("取消", "Cancel")}
              </button>
            </>
          ) : (
            <button type="button" className="btn sweep-stop-button" data-sweep-stop onClick={onStop}>
              {words("停止", "Stop")}
            </button>
          )}
        </span>
      </div>
      <div className="sweep-sub" data-sweep-progress-line>{detail.filter(Boolean).join(" · ")}</div>
      <div
        className="sweep-progress"
        role="progressbar"
        aria-label={words("已花预算", "Budget spent")}
        aria-valuemin={0}
        aria-valuemax={run.budget}
        aria-valuenow={run.spent}
      >
        <div style={{ width: `${percent}%` }} />
      </div>
      <div className="sweep-money">
        <span data-sweep-spent>
          {words("已花", "Spent")} <b>{number(run.spent)}</b> / {number(run.budget)}
        </span>
        <span data-sweep-remaining>
          {words("剩余", "Left")} <b>{number(run.remaining)}</b>
        </span>
      </div>
      {!empty &&
        run.devices.map((device) => (
          <div className="sweep-device-line" key={device.id} data-sweep-run-device={device.id}>
            <b>{device.name}</b>
            {" · "}
            <span data-device-activity>{deviceActivity(device, run, words)}</span>
            {device.checked != null && ` · ${words(`已查 ${number(device.checked)} 店次`, `${number(device.checked)} shop checks`)}`}
          </div>
        ))}
    </>
  );
}

import { useEffect, useState } from "react";
import {
  Activity,
  Backpack,
  SlidersHorizontal,
  ReceiptText,
} from "lucide-react";
import { meso } from "/web/js/lib/format.js";
import { useWords } from "../providers";
import {
  clockTime,
  deviceActivity,
  duration,
  stopReasonLabel,
  type Device,
  type Run,
  type SweepWatch,
} from "../lib/sweep-labels";
import { Dialog, DialogContent, DialogTitle } from "./ui/dialog";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "./ui/tabs";
import {
  isEnglish,
  PurchaseRow,
  SweepRules,
  useItemNames,
} from "./sweep-content";

const number = (value: number | null | undefined) =>
  value == null ? "—" : value.toLocaleString();
const timestamp = (value?: string | null) => (value ? Date.parse(value) : NaN);

export function RuleChangeNotice() {
  const words = useWords();
  return (
    <div className="sweep-stale" data-sweep-stale role="status">
      {words(
        "关注里的扫货条件已修改，下一轮生效",
        "Watchlist sweep rules changed; they apply to the next run.",
      )}
    </div>
  );
}

export function SweepDetails({
  run,
  changed,
  items,
  devices,
  busy,
  error,
  initialTab = "progress",
  onStop,
  onClose,
}: {
  run: Run;
  changed: boolean;
  items: Map<number, any>;
  devices: Device[];
  busy: boolean;
  error: string;
  initialTab?: "progress" | "records";
  onStop(): Promise<void>;
  onClose(): void;
}) {
  const words = useWords();
  const running = run.status === "running";
  const [tab, setTab] = useState<string>(initialTab);
  const [confirm, setConfirm] = useState(false);
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (!running) {
      setConfirm(false);
      return;
    }
    const timer = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, [running]);
  const selected = devices.filter((d) =>
    run.devices.some((r) => r.id === d.id),
  );
  const watches = run.plan?.watches || [];
  const name = useItemNames(
    watches.map((w) => w.item_id),
    items,
  );
  const elapsed =
    Math.min(
      running ? now : timestamp(run.stopped_at) || timestamp(run.ends_at),
      timestamp(run.ends_at),
    ) - timestamp(run.started_at);
  const checked =
    run.devices.length && run.devices.every((d) => d.checked != null)
      ? run.devices.reduce((total, d) => total + d.checked!, 0)
      : null;
  const used = Math.max(0, run.budget - run.remaining);
  const percent = run.budget > 0 ? Math.min(100, (used / run.budget) * 100) : 0;
  return (
    <Dialog open onOpenChange={(open) => !open && !busy && onClose()}>
      <DialogContent
        className="sweep-dialog sweep-details-dialog"
        closeLabel={words("关闭", "Close")}
        aria-describedby={undefined}
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          document
            .querySelector<HTMLButtonElement>("[data-sweep-details]")
            ?.focus();
        }}
      >
        <div className="stall-bar">
          <DialogTitle>{words("扫货详情", "Sweep details")}</DialogTitle>
        </div>
        <div className="sweep-runline">
          <b>
            {running
              ? words("运行中", "Running")
              : stopReasonLabel(run.stop_reason, words)}
          </b>
          <span>
            {words("结束", "Ends")} {clockTime(run.ends_at, isEnglish())}
          </span>
        </div>
        <Tabs value={tab} onValueChange={setTab} className="sweep-detail-tabs">
          <TabsList aria-label={words("扫货详情分类", "Sweep detail tabs")}>
            <TabsTrigger value="progress">
              <Activity size={15} />
              {words("进度", "Progress")}
            </TabsTrigger>
            <TabsTrigger value="bag">
              <Backpack size={15} />
              {words("背包", "Inventory")}
            </TabsTrigger>
            <TabsTrigger value="settings">
              <SlidersHorizontal size={15} />
              {words("设置", "Settings")}
            </TabsTrigger>
            <TabsTrigger value="records">
              <ReceiptText size={15} />
              {words("记录", "Records")}
            </TabsTrigger>
          </TabsList>
          <div className="sweep-detail-body">
            <TabsContent value="progress" data-sweep-progress>
              <div className="sweep-metrics">
                <div>
                  <small>{words("已检查店次", "Shop checks")}</small>
                  <b data-sweep-checked>{number(checked)}</b>
                </div>
                <div>
                  <small>{words("本轮已购", "Bought this run")}</small>
                  <b data-sweep-bought>{number(run.bought)}</b>
                </div>
                <div>
                  <small>{words("已运行", "Elapsed")}</small>
                  <b>{duration(elapsed, words)}</b>
                </div>
              </div>
              <section className="sweep-budget">
                <div className="sweep-between">
                  <b>{words("预算使用", "Budget used")}</b>
                  <span>
                    {number(used)} / {number(run.budget)}
                  </span>
                </div>
                <div
                  className="sweep-meter"
                  role="progressbar"
                  aria-label={words("已占用预算", "Budget committed")}
                  aria-valuemin={0}
                  aria-valuemax={run.budget}
                  aria-valuenow={used}
                >
                  <div style={{ width: `${percent}%` }} />
                </div>
                <div className="sweep-between">
                  <small>{percent.toFixed(1)}%</small>
                  <span data-sweep-stat="remaining">
                    {words("预算剩余", "Budget left")}{" "}
                    <b>{number(run.remaining)}</b>
                  </span>
                </div>
                <dl className="sweep-definition">
                  {(
                    [
                      ["spent", words("已花", "Spent"), run.spent],
                      ["reserved", words("处理中预留", "Held"), run.reserved],
                      [
                        "unknown",
                        words("结果未知预留", "Unknown"),
                        run.unknown,
                      ],
                    ] as const
                  ).map(([key, label, value]) => (
                    <div key={key} data-sweep-stat={key}>
                      <dt>{label}</dt>
                      <dd>
                        <b>{number(value)}</b>
                      </dd>
                    </div>
                  ))}
                </dl>
              </section>
              <section className="sweep-list">
                <h3 className="sweep-head">
                  {words("本轮购买", "Bought this run")}
                </h3>
                <table className="sweep-detail-table">
                  <thead>
                    <tr>
                      <th>{words("物品", "Item")}</th>
                      <th>{words("已购", "Bought")}</th>
                      <th>{words("数量上限", "Limit")}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {watches.map((w) => (
                      <tr key={w.item_id}>
                        <td>{name(w.item_id)}</td>
                        <td>
                          {number(
                            run.items?.find((i) => i.item_id === w.item_id)
                              ?.bought,
                          )}
                        </td>
                        <td>
                          {w.limit === 0
                            ? words("不限", "Unlimited")
                            : number(w.limit)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </section>
              <section className="sweep-list" data-sweep-devices>
                <h3 className="sweep-head">
                  {words("设备动态", "Device activity")}
                </h3>
                {run.devices.map((device) => (
                  <div
                    className="sweep-row"
                    data-sweep-device={device.id}
                    key={device.id}
                  >
                    <span className="sweep-row-main">
                      <b>{device.name}</b>
                      <small data-device-activity>
                        {deviceActivity(device, run, words)}
                      </small>
                      <small>
                        {words("进度更新", "Progress updated")}{" "}
                        {clockTime(device.progress_at, isEnglish())}
                        {device.checked != null &&
                          ` · ${words("已检查店次", "Shop checks")} ${number(device.checked)}`}
                      </small>
                    </span>
                    <span className="sweep-row-side">
                      <b>{meso(device.spent)}</b>
                      <small>
                        {device.online
                          ? words("在线", "Online")
                          : words("离线", "Offline")}
                      </small>
                    </span>
                  </div>
                ))}
              </section>
            </TabsContent>
            <TabsContent value="bag">
              <InventoryDetails
                devices={selected}
                watches={watches}
                items={items}
              />
            </TabsContent>
            <TabsContent value="settings">
              <div className="sweep-section-title">
                <b>{words("本轮生效条件", "Active rules for this run")}</b>
                <small>{words("启动时保存", "Saved at start")}</small>
              </div>
              {run.plan ? (
                <SweepRules watches={watches} items={items} />
              ) : (
                <p className="sweep-empty">
                  {words("暂无规则快照", "Rule snapshot unavailable")}
                </p>
              )}
              {running && changed && <RuleChangeNotice />}
              <dl
                className="sweep-definition sweep-settings"
                data-sweep-settings
              >
                <div>
                  <dt>{words("本轮预算", "Run budget")}</dt>
                  <dd>{number(run.budget)}</dd>
                </div>
                <p className="sweep-route-mode">{run.plan?.scan?.mode === "recent"
                  ? words(`近期命中扫货 · 过去 ${run.plan.scan.recent_minutes! >= 60 ? `${run.plan.scan.recent_minutes! / 60} 小时` : `${run.plan.scan.recent_minutes} 分钟`}`,
                    `Recent matches · last ${run.plan.scan.recent_minutes} minutes`)
                  : words("全市场扫货", "Full market sweep")}</p>
                <div>
                  <dt>{words("扫货时长", "Duration")}</dt>
                  <dd>
                    {duration(
                      timestamp(run.ends_at) - timestamp(run.started_at),
                      words,
                    )}
                  </dd>
                </div>
                <div>
                  <dt>{words("开始时间", "Started")}</dt>
                  <dd>{clockTime(run.started_at, isEnglish())}</dd>
                </div>
                <div data-sweep-stat="ends">
                  <dt>{words("结束时间", "Ends")}</dt>
                  <dd>
                    <b>{clockTime(run.ends_at, isEnglish())}</b>
                  </dd>
                </div>
                <div>
                  <dt>{words("执行设备", "Devices")}</dt>
                  <dd>{run.devices.map((d) => d.name).join("、") || "—"}</dd>
                </div>
              </dl>
              {selected.map((device) => (
                <details className="sweep-local-settings" key={device.id}>
                  <summary>
                    {device.name} ·{" "}
                    {words("本机当前设置", "Current device settings")}
                  </summary>
                  <dl className="sweep-definition">
                    <div>
                      <dt>{words("每轮最多花", "Run spending cap")}</dt>
                      <dd>{number(device.state?.sweep?.max_spend)}</dd>
                    </div>
                    <div>
                      <dt>{words("单笔金额上限", "Order cap")}</dt>
                      <dd>
                        {device.state?.sweep?.max_order === 0
                          ? words("不限", "Unlimited")
                          : number(device.state?.sweep?.max_order)}
                      </dd>
                    </div>
                    <div>
                      <dt>{words("保留金币", "Mesos reserve")}</dt>
                      <dd>{number(device.state?.sweep?.reserve_mesos)}</dd>
                    </div>
                  </dl>
                </details>
              ))}
            </TabsContent>
            <TabsContent value="records">
              <PurchaseRecords run={run} items={items} />
            </TabsContent>
          </div>
        </Tabs>
        {error && (
          <div className="sweep-dialog-error sweep-detail-error" role="alert">
            {error}
          </div>
        )}
        {running && confirm && (
          <div className="sweep-stop-confirm" data-sweep-stop-confirm>
            <b>{words("停止本轮扫货？", "Stop this sweep?")}</b>
            <small>
              {words(
                "购买记录会保留，重新开始时使用最新关注条件。",
                "Records stay available. Restart to use the latest rules.",
              )}
            </small>
            <div>
              <button
                className="btn"
                disabled={busy}
                onClick={() => setConfirm(false)}
              >
                {words("继续本轮", "Keep running")}
              </button>
              <button
                className="btn sweep-stop-button"
                data-sweep-confirm-stop
                disabled={busy}
                onClick={() => void onStop()}
              >
                {words("确认停止", "Confirm stop")}
              </button>
            </div>
          </div>
        )}
        <div className="ffoot sweep-detail-footer">
          <button className="btn" disabled={busy} onClick={onClose}>
            {words("关闭", "Close")}
          </button>
          {running && (
            <button
              className="btn sweep-stop-button"
              data-sweep-stop
              disabled={busy || confirm}
              onClick={() => setConfirm(true)}
            >
              {words("停止本轮", "Stop sweep")}
            </button>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

function InventoryDetails({
  devices,
  watches,
  items,
}: {
  devices: Device[];
  watches: SweepWatch[];
  items: Map<number, any>;
}) {
  const words = useWords();
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  // Resolve extra names only when their drawer is open; a packet may contain 1,000 stacks.
  const ids = [
    ...watches.map((w) => w.item_id),
    ...devices.flatMap((d) =>
      expanded[d.id]
        ? (d.state?.sweep?.holdings?.items || []).map((i) => i.item_id)
        : [],
    ),
  ];
  const name = useItemNames(ids, items);
  const targets = new Set(watches.map((w) => w.item_id));
  return (
    <div data-sweep-inventory>
      {!devices.length && (
        <p className="sweep-empty">
          {words("等待设备数据", "Waiting for device data")}
        </p>
      )}
      {devices.map((device) => {
        const snapshot = device.state?.sweep?.holdings;
        const holdings =
          device.online && device.state?.sweep?.game?.connected !== false
            ? snapshot
            : null;
        const other =
          holdings?.items.filter((i) => !targets.has(i.item_id)) || [];
        return (
          <section key={device.id} data-inventory-device={device.id}>
            <div className="sweep-inventory-balance">
              <div>
                <small>
                  {words("当前金币", "Current mesos")}
                  {devices.length > 1 ? ` · ${device.name}` : ""}
                </small>
                <b data-inventory-balance>{number(holdings?.mesos)}</b>
              </div>
              <small>
                {holdings
                  ? words("背包更新", "Inventory updated")
                  : words("等待游戏数据", "Waiting for game data")}
                <br />
                {clockTime(snapshot?.observed_at, isEnglish())}
              </small>
            </div>
            <div className="sweep-section-title">
              <b>{words("正在扫货的物品", "Sweep items")}</b>
              <small>{words("当前持有", "Currently held")}</small>
            </div>
            <table className="sweep-detail-table" data-inventory-targets>
              <tbody>
                {watches.map((w) => (
                  <tr key={w.item_id}>
                    <td>{name(w.item_id)}</td>
                    <td>
                      {holdings?.categories.includes(
                        Math.floor(w.item_id / 1000000),
                      )
                        ? number(
                            holdings.items.find((i) => i.item_id === w.item_id)
                              ?.quantity || 0,
                          )
                        : "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {holdings && (
              <details
                className="sweep-local-settings"
                open={Boolean(expanded[device.id])}
                onToggle={(event) => {
                  const open = event.currentTarget.open;
                  setExpanded((old) =>
                    old[device.id] === open
                      ? old
                      : { ...old, [device.id]: open },
                  );
                }}
              >
                <summary>
                  {words("其他已读物品", "Other known items")} · {other.length}
                </summary>
                <table className="sweep-detail-table">
                  <tbody>
                    {other.map((item) => (
                      <tr key={item.item_id}>
                        <td>{name(item.item_id)}</td>
                        <td>{number(item.quantity)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </details>
            )}
            {holdings &&
              [1, 2, 3, 4, 5].some((c) => !holdings.categories.includes(c)) && (
                <p className="sweep-inventory-note">
                  {words("尚未读取：", "Not yet read: ")}
                  {[1, 2, 3, 4, 5]
                    .filter((c) => !holdings.categories.includes(c))
                    .map((c) =>
                      words(
                        ["", "装备", "消耗", "设置", "其他", "现金"][c],
                        ["", "Equip", "Use", "Setup", "Etc", "Cash"][c],
                      ),
                    )
                    .join("、")}
                </p>
              )}
          </section>
        );
      })}
    </div>
  );
}

function PurchaseRecords({
  run,
  items,
}: {
  run: Run;
  items: Map<number, any>;
}) {
  const words = useWords(),
    [all, setAll] = useState(false);
  const purchases = run.purchases.slice(0, 50);
  const name = useItemNames(
    purchases.map((p) => p.item_id),
    items,
  );
  return (
    <section className="sweep-list" data-sweep-purchases>
      <h3 className="sweep-head">
        {words("最近购买记录", "Recent purchase records")} · {purchases.length}
      </h3>
      {!purchases.length && (
        <p className="sweep-empty">
          {words("本轮暂无购买记录", "No purchase records yet")}
        </p>
      )}
      {purchases.slice(0, all ? undefined : 5).map((row) => (
        <div key={row.id}>
          <PurchaseRow row={row} name={name(row.item_id)} />
          <div className="sweep-purchase-time">
            {clockTime(row.settled_at || row.created_at, isEnglish())}
          </div>
        </div>
      ))}
      {!all && purchases.length > 5 && (
        <button className="more" data-sweep-more onClick={() => setAll(true)}>
          {words(
            `再显示 ${purchases.length - 5} 条`,
            `Show ${purchases.length - 5} more`,
          )}
        </button>
      )}
    </section>
  );
}

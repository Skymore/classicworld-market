import { useMemo, useState } from "react";
import { useQueries } from "@tanstack/react-query";
import {
  calculateMixedEnhancement,
  compatibleScroll,
  enhancementMetadata,
  enhancementQuote,
  enhancementBaseOptions,
} from "/web/js/lib/enhancement.js";
import { getJson } from "/web/js/lib/api.js?v=20261022-auto-watch-2";
import { useMarketQuery } from "../lib/query";
import { usePreferences, useWords } from "../providers";
import { Slot, usePageReady } from "../components/shared";
import Picker from "./enhancement-picker";
import { locale } from "/web/js/lib/i18n.js";
import "./tools.css";

interface Choice {
  item_id: number;
  name_zh?: string;
  name_en?: string;
  icon_url?: string;
}
interface Effect {
  key: string;
  zh: string;
  en: string;
  value: number;
}
export default function Enhancement() {
  usePageReady();
  const words = useWords(),
    { language } = usePreferences();
  const [equipment, setEquipment] = useState<Choice>({
    item_id: 1082000,
    name_zh: "工地手套",
    name_en: "Work Gloves",
  });
  const [percentile, setPercentile] = useState(0.5);
  const [baseFilters, setBaseFilters] = useState<Record<string, string>>({});
  const [target, setTarget] = useState("6"),
    [stat, setStat] = useState("incPAD");
  const equipmentRecord = useMarketQuery<any>(
    "/api/v1/items/" + equipment.item_id,
    true,
    false,
  );
  const catalog = useMarketQuery<{ scrolls: any[] }>(
    "/api/v1/enhancement/scrolls/" + equipment.item_id,
    true,
    false,
  );
  const equipmentMarket = useMarketQuery<any>(
    "/api/v1/item/" + equipment.item_id,
  );
  const equipmentInfo = useMemo(
    () => enhancementMetadata(equipmentRecord.data),
    [equipmentRecord.data],
  );
  const available = useMemo(
    () =>
      (catalog.data?.scrolls || []).flatMap((record) => {
        const info = enhancementMetadata(record);
        return compatibleScroll(equipment.item_id, record.item_id) &&
          !info.destructive &&
          [0.1, 0.6].includes(info.successRate) &&
          info.effects.length
          ? [{ ...record, ...info }]
          : [];
      }),
    [catalog.data, equipment.item_id],
  );
  const effects = useMemo<Effect[]>(
    () => [
      ...new Map(
        available
          .flatMap((row) => row.effects)
          .map((row: Effect) => [row.key, row] as const),
      ).values(),
    ],
    [available],
  );
  const effect = effects.find((row) => row.key === stat) || effects[0];
  const candidates = useMemo(
    () =>
      available.filter((row) =>
        row.effects.some((value: Effect) => value.key === effect?.key),
      ),
    [available, effect?.key],
  );
  const quotes = useQueries({
    queries: candidates.map((row) => ({
      queryKey: ["market", "/api/v1/item/" + row.item_id],
      meta: { market: true },
      queryFn: async ({ signal }: { signal: AbortSignal }) =>
        (await getJson("/api/v1/item/" + row.item_id, { signal })).data as any,
      staleTime: 15000,
    })),
  });
  const slots = equipmentInfo.slots;
  const baseOptions = useMemo(
    () => (slots ? enhancementBaseOptions(equipmentMarket.data, slots) : []),
    [equipmentMarket.data, slots],
  );
  const equipmentAsk = slots
    ? enhancementQuote(equipmentMarket.data, slots, percentile, baseFilters)
    : null;
  const scrolls = candidates.map((row, index) => ({
    ...row,
    id: row.item_id,
    price: enhancementQuote(quotes[index]?.data, null, percentile),
    gain: row.effects.find((value: Effect) => value.key === effect.key).value,
  }));
  const priced = scrolls.filter(
    (row) => Number.isFinite(row.price) && row.price > 0,
  );
  const pending =
    equipmentRecord.isPending ||
    catalog.isPending ||
    equipmentMarket.isPending ||
    quotes.some((query) => query.isPending);
  const failed = equipmentRecord.isError || catalog.isError;
  const validEquipment =
    equipmentAsk !== null && Number.isFinite(equipmentAsk) && equipmentAsk >= 0;
  const targetValue = Number(target),
    validTarget =
      target.trim() !== "" && Number.isInteger(targetValue) && targetValue > 0;
  const plan =
    !pending && slots && validEquipment && validTarget && priced.length
      ? calculateMixedEnhancement({
          equipmentPrice: equipmentAsk,
          slots,
          target: targetValue,
          scrolls: priced,
        })
      : null;
  const name = (row: Choice) =>
    words(row.name_zh || row.name_en || "", row.name_en || row.name_zh || "");
  const effectName = effect ? words(effect.zh, effect.en) : "";
  const number = (value: number, digits = 2) =>
    value.toLocaleString(locale(), {
      maximumFractionDigits: digits,
    });
  const scrollLabel = (id: number) => {
    const scroll = scrolls.find((row) => row.id === id);
    return scroll
      ? `${number(scroll.successRate * 100)}% ${words("卷轴", "scroll")} (+${scroll.gain})`
      : "";
  };
  const problem = failed
    ? words("物品数据加载失败", "Could not load item data")
    : pending
      ? words("正在读取市场报价…", "Loading market prices…")
      : !slots
        ? words(
            "该装备没有可用的强化次数",
            "This equipment has no upgrade slots",
          )
        : !effect
          ? words(
              "暂无适用的 10% 或 60% 属性卷轴",
              "No matching 10% or 60% stat scrolls",
            )
          : !validEquipment
            ? words(
                "暂无匹配底材报价",
                "No matching unenhanced equipment quotes",
              )
            : !priced.length
              ? words("暂无可用卷轴报价", "No scroll prices available")
              : !validTarget
                ? words(
                    "请输入正整数目标提升",
                    "Enter a positive whole-number target gain",
                  )
                : !plan
                  ? words(
                      "当前可用卷轴无法达到该目标",
                      "The available scrolls cannot reach this target",
                    )
                  : "";
  return (
    <div className="lwrap tools-page enhancement-page">
      <section className="stall">
        <div className="stall-bar">
          <h1>{words("强化计算器", "Enhancement calculator")}</h1>
        </div>
        <div className="enhance-body">
          <div className="enhance-grid">
            <Picker
              kind="equipment"
              value={{ ...equipment, ...equipmentRecord.data }}
              choose={(row) => {
                setEquipment(row);
                setBaseFilters({});
                setStat("incPAD");
              }}
            />
            <div className="enhance-goal">
              <label className="enhance-field" htmlFor="enhance-stat">
                {words("卷轴属性", "Scroll stat")}
                <select
                  id="enhance-stat"
                  value={effect?.key || ""}
                  disabled={!effect}
                  onChange={(event) => setStat(event.target.value)}
                >
                  {effects.map((row) => (
                    <option key={row.key} value={row.key}>
                      {words(row.zh, row.en)}
                    </option>
                  ))}
                </select>
              </label>
              <label className="enhance-field" htmlFor="enhance-target">
                {words("目标提升", "Target gain")}
                <div className="enhance-target-input">
                  <span aria-hidden="true">+</span>
                  <input
                    id="enhance-target"
                    type="number"
                    inputMode="numeric"
                    min="1"
                    step="1"
                    value={target}
                    onChange={(event) => setTarget(event.target.value)}
                  />
                  <span>{effectName}</span>
                </div>
              </label>
            </div>
          </div>
          <div className="enhance-pricing">
            <span>{words("市场价格", "Market prices")}</span>
            <div
              className="chips"
              role="group"
              aria-label={words("价格档位", "Price percentile")}
            >
              {[0.25, 0.5, 0.7].map((value) => (
                <button
                  className={"chip " + (percentile === value ? "on" : "")}
                  type="button"
                  key={value}
                  data-enhance-percentile={value * 100}
                  aria-pressed={percentile === value}
                  onClick={() => setPercentile(value)}
                >
                  {value * 100}%
                  {value === 0.5 ? words("（中位）", " (median)") : ""}
                </button>
              ))}
            </div>
          </div>
          <details className="enhance-base">
            <summary>
              {words("底材属性", "Base equipment stats")}
              {Object.values(baseFilters).some((value) => value !== "") && (
                <span> · {words("已筛选", "Filtered")}</span>
              )}
            </summary>
            <div className="enhance-base-body">
              <div className="enhance-base-toolbar">
                <select
                  aria-label={words("添加底材属性", "Add base stat")}
                  value=""
                  onChange={(event) => {
                    const key = event.target.value;
                    if (key)
                      setBaseFilters((current) => ({ ...current, [key]: "" }));
                  }}
                >
                  <option value="">{words("添加属性…", "Add a stat…")}</option>
                  {baseOptions
                    .filter((row: any) => !(row.key in baseFilters))
                    .map((row: any) => (
                      <option key={row.key} value={row.key}>
                        {words(row.zh, row.en)}
                      </option>
                    ))}
                </select>
                {Object.keys(baseFilters).length > 0 && (
                  <button
                    className="btn"
                    type="button"
                    onClick={() => setBaseFilters({})}
                  >
                    {words("清除", "Clear")}
                  </button>
                )}
              </div>
              {Object.entries(baseFilters).map(([key, value]) => {
                const row = baseOptions.find(
                  (option: any) => option.key === key,
                );
                const values = [
                  ...new Set([
                    ...(row?.values || []),
                    ...(value !== "" ? [Number(value)] : []),
                  ]),
                ].sort((a: any, b: any) => a - b);
                return (
                  <label className="enhance-base-row" key={key}>
                    <span>
                      {words("原始", "Base ")}
                      {row ? words(row.zh, row.en) : key}
                    </span>
                    <select
                      aria-label={
                        words("原始", "Base ") +
                        (row ? words(row.zh, row.en) : key)
                      }
                      value={value}
                      onChange={(event) =>
                        setBaseFilters((current) => ({
                          ...current,
                          [key]: event.target.value,
                        }))
                      }
                    >
                      <option value="">{words("不限", "Any")}</option>
                      {values.map((stat: any) => (
                        <option key={stat} value={stat}>
                          {stat >= 0 ? "+" : ""}
                          {stat}
                        </option>
                      ))}
                    </select>
                    <button
                      className="btn"
                      type="button"
                      aria-label={words("移除属性", "Remove stat")}
                      onClick={() =>
                        setBaseFilters((current) => {
                          const next = { ...current };
                          delete next[key];
                          return next;
                        })
                      }
                    >
                      ×
                    </button>
                  </label>
                );
              })}
            </div>
          </details>
          <div className="enhance-field">
            <span>{words("装备单价", "Equipment price")}</span>
            <output
              id="enhance-equipment-price"
              data-price={equipmentAsk ?? ""}
            >
              {equipmentAsk == null ? "—" : number(equipmentAsk, 0)}
            </output>
            <span className="enhance-quote">
              {equipmentAsk == null
                ? words("暂无匹配底材报价", "No matching base equipment quotes")
                : words("满次数白装", "Unenhanced, full slots")}
              {slots && (
                <span>
                  · {words(`${slots} 次强化机会`, `${slots} upgrade slots`)}
                </span>
              )}
            </span>
          </div>
          {scrolls.length > 0 && (
            <div className="enhance-scroll-list">
              {scrolls.map((row) => (
                <div
                  className="enhance-field enhance-scroll-price"
                  key={row.id}
                >
                  <span className="enhance-selected">
                    <Slot size={24} url={row.icon_url} />
                    <a href={"/item/" + row.id}>{name(row)}</a>
                    <b>
                      {number(row.successRate * 100)}% · +{row.gain}
                    </b>
                  </span>
                  <output
                    id={"enhance-scroll-" + row.id}
                    data-price={row.price ?? ""}
                  >
                    {row.price == null ? "—" : number(row.price, 0)}
                  </output>
                  {row.price == null && (
                    <span className="enhance-quote">
                      {words("暂无在售报价", "No current quotes")}
                    </span>
                  )}
                </div>
              ))}
            </div>
          )}
          {problem && (
            <div className="enhance-problem" role="status">
              {problem}
              {failed && (
                <button
                  className="btn"
                  type="button"
                  onClick={() => {
                    void equipmentRecord.refetch();
                    void catalog.refetch();
                  }}
                >
                  {words("重试", "Retry")}
                </button>
              )}
            </div>
          )}
          {plan && (
            <div className="enhance-result" aria-live="polite">
              {scrolls.length > priced.length && (
                <small className="enhance-assumption">
                  {words(
                    "暂无报价的卷轴不参与计算",
                    "Scrolls without market quotes are excluded",
                  )}
                </small>
              )}
              <div className="enhance-total">
                <span>
                  {words("最低期望总成本", "Minimum expected total cost")}
                </span>
                <strong data-enhance-total={plan.expectedCost}>
                  {number(plan.expectedCost, 0)}{" "}
                  <small>{words("金币", "mesos")}</small>
                </strong>
              </div>
              <div className="enhance-counts">
                <span>
                  {words("平均装备", "Average equipment")}
                  <b data-enhance-equipment>
                    {number(plan.equipmentCount, 1)} {words("件", "items")}
                  </b>
                </span>
                {plan.scrolls.map((row: any) => (
                  <span key={row.id}>
                    {scrollLabel(row.id)}
                    <b data-enhance-scrolls={row.id}>
                      {number(row.count, 1)} {words("张", "scrolls")}
                    </b>
                  </span>
                ))}
              </div>
              <div className="enhance-strategy" data-enhance-strategy>
                <h2>{words("最佳策略", "Best strategy")}</h2>
                <p className="enhance-first">
                  {words("第一张使用 ", "Start with ")}
                  {scrollLabel(plan.states[0].scrollId)}
                </p>
                {plan.stops.length > 0 && (
                  <ul>
                    {plan.stops.map((state: any) => (
                      <li key={state.used + "-" + state.gain}>
                        {state.used === 1 && state.gain === 0
                          ? words(
                              "第一张失败就换一件装备",
                              "Replace the equipment if the first scroll fails",
                            )
                          : words(
                              `已用 ${state.used} 张、提升 +${state.gain} 时换一件装备`,
                              `Replace after ${state.used} scrolls with a +${state.gain} gain`,
                            )}
                      </li>
                    ))}
                  </ul>
                )}
                <p>
                  {words(
                    "达到目标即停手；剩余次数不足以达标时换装备。",
                    "Stop at the target; replace when too few slots remain.",
                  )}
                </p>
                <details className="enhance-steps">
                  <summary>
                    {words("查看逐步策略", "View step-by-step strategy")}
                  </summary>
                  <table>
                    <thead>
                      <tr>
                        <th>{words("已用卷轴", "Scrolls used")}</th>
                        <th>{words("已提升", "Gain so far")}</th>
                        <th>{words("下一步", "Next step")}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {plan.states.map((state: any) => (
                        <tr key={state.used + "-" + state.gain}>
                          <td>{state.used}</td>
                          <td>+{state.gain}</td>
                          <td>
                            {state.scrollId == null
                              ? words("换装备", "Replace equipment")
                              : scrollLabel(state.scrollId)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </details>
              </div>
            </div>
          )}
        </div>
      </section>
    </div>
  );
}

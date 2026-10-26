import { useMemo, useState } from "react";
import { useQueries } from "@tanstack/react-query";
import {
  calculateMixedEnhancement,
  compatibleScroll,
  enhancementMetadata,
  enhancementQuote,
} from "/web/js/lib/enhancement.js";
import { getJson } from "/web/js/lib/api.js?v=20261022-auto-watch-2";
import { useMarketQuery } from "../lib/query";
import { usePreferences, useWords } from "../providers";
import { Slot, usePageReady } from "../components/shared";
import Picker from "./enhancement-picker";
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
  const [equipmentPrice, setEquipmentPrice] = useState<string | null>(null),
    [scrollPrices, setScrollPrices] = useState<Record<number, string>>({});
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
  const equipmentAsk = slots
    ? enhancementQuote(equipmentMarket.data, slots)
    : null;
  const x =
    equipmentPrice ?? (equipmentAsk == null ? "" : String(equipmentAsk));
  const scrolls = candidates.map((row, index) => {
    const ask = enhancementQuote(quotes[index]?.data);
    const draft = scrollPrices[row.item_id] ?? (ask == null ? "" : String(ask));
    return {
      ...row,
      id: row.item_id,
      ask,
      draft,
      price: draft.trim() === "" ? null : Number(draft),
      gain: row.effects.find((value: Effect) => value.key === effect.key).value,
    };
  });
  const priced = scrolls.filter(
    (row) => Number.isFinite(row.price) && row.price > 0,
  );
  const pending =
    equipmentRecord.isPending ||
    catalog.isPending ||
    quotes.some(
      (query, index) =>
        query.isPending &&
        scrollPrices[candidates[index].item_id] === undefined,
    );
  const failed = equipmentRecord.isError || catalog.isError;
  const validEquipment =
    x.trim() !== "" && Number.isFinite(Number(x)) && Number(x) >= 0;
  const targetValue = Number(target),
    validTarget =
      target.trim() !== "" && Number.isInteger(targetValue) && targetValue > 0;
  const plan =
    !pending && slots && validEquipment && validTarget && priced.length
      ? calculateMixedEnhancement({
          equipmentPrice: Number(x),
          slots,
          target: targetValue,
          scrolls: priced,
        })
      : null;
  const name = (row: Choice) =>
    language === "en" ? row.name_en || row.name_zh : row.name_zh || row.name_en;
  const effectName = effect ? (language === "en" ? effect.en : effect.zh) : "";
  const number = (value: number, digits = 2) =>
    value.toLocaleString(language === "en" ? "en-US" : "zh-CN", {
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
                "暂无白装报价，请填写装备单价",
                "No unenhanced equipment quote; enter its price",
              )
            : !priced.length
              ? words(
                  "暂无卷轴报价，请填写卷轴单价",
                  "No scroll quotes; enter a scroll price",
                )
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
                setEquipmentPrice(null);
                setScrollPrices({});
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
                      {language === "en" ? row.en : row.zh}
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
          <label className="enhance-field" htmlFor="enhance-equipment-price">
            {words("装备单价", "Equipment price")}
            <input
              id="enhance-equipment-price"
              type="number"
              inputMode="decimal"
              min="0"
              step="any"
              value={x}
              placeholder={words("手动输入", "Enter price")}
              onChange={(event) => setEquipmentPrice(event.target.value)}
            />
            <span className="enhance-quote">
              {equipmentAsk == null
                ? words("暂无满次数白装报价", "No unenhanced full-slot quote")
                : words("在售最低 ", "Lowest ask ") + number(equipmentAsk)}
              {equipmentAsk != null && equipmentPrice !== null && (
                <button
                  className="link"
                  type="button"
                  onClick={() => setEquipmentPrice(null)}
                >
                  {words("采用", "Use")}
                </button>
              )}
              {slots && (
                <span>
                  · {words(`${slots} 次强化机会`, `${slots} upgrade slots`)}
                </span>
              )}
            </span>
          </label>
          {scrolls.length > 0 && (
            <div className="enhance-scroll-list">
              {scrolls.map((row) => (
                <label
                  className="enhance-field enhance-scroll-price"
                  htmlFor={"enhance-scroll-" + row.id}
                  key={row.id}
                >
                  <span className="enhance-selected">
                    <Slot size={24} url={row.icon_url} />
                    <a href={"/item/" + row.id}>{name(row)}</a>
                    <b>
                      {number(row.successRate * 100)}% · +{row.gain}
                    </b>
                  </span>
                  <input
                    id={"enhance-scroll-" + row.id}
                    type="number"
                    inputMode="decimal"
                    min="0"
                    step="any"
                    value={row.draft}
                    placeholder={words(
                      "暂无报价，可手动输入",
                      "No quote; enter a price",
                    )}
                    onChange={(event) =>
                      setScrollPrices((current) => ({
                        ...current,
                        [row.id]: event.target.value,
                      }))
                    }
                  />
                  <span className="enhance-quote">
                    {row.ask == null
                      ? words("暂无在售报价", "No current quote")
                      : words("在售最低 ", "Lowest ask ") + number(row.ask)}
                    {row.ask != null && scrollPrices[row.id] !== undefined && (
                      <button
                        className="link"
                        type="button"
                        onClick={() =>
                          setScrollPrices((current) => {
                            const next = { ...current };
                            delete next[row.id];
                            return next;
                          })
                        }
                      >
                        {words("采用", "Use")}
                      </button>
                    )}
                  </span>
                </label>
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
                    "未填写有效价格的卷轴不参与计算",
                    "Scrolls without a valid price are excluded",
                  )}
                </small>
              )}
              <div className="enhance-total">
                <span>
                  {words("最低期望总成本", "Minimum expected total cost")}
                </span>
                <strong data-enhance-total={plan.expectedCost}>
                  {number(plan.expectedCost)}{" "}
                  <small>{words("金币", "mesos")}</small>
                </strong>
              </div>
              <div className="enhance-counts">
                <span>
                  {words("平均装备", "Average equipment")}
                  <b data-enhance-equipment>
                    {number(plan.equipmentCount, 4)} {words("件", "items")}
                  </b>
                </span>
                {plan.scrolls.map((row: any) => (
                  <span key={row.id}>
                    {scrollLabel(row.id)}
                    <b data-enhance-scrolls={row.id}>
                      {number(row.count, 4)} {words("张", "scrolls")}
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
              <small className="enhance-assumption">
                {words(
                  "目标按至少提升计算；失败消耗次数，淘汰装备无回收价。",
                  "Target is a minimum gain; failures use a slot, with no resale value for discarded equipment.",
                )}
              </small>
            </div>
          )}
        </div>
      </section>
    </div>
  );
}

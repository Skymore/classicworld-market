import { useMemo, useState } from "react";
import { recipesFor, estimateCraft, disciplines } from "/web/js/lib/crafting.js";
import { useMarketQuery } from "../lib/query";
import { usePreferences, useWords } from "../providers";
import type { CraftCatalog, CraftPrice, CraftRecipe } from "../lib/types";

export default function Crafting({ itemId }: { itemId: number }) {
  const words = useWords(), { language } = usePreferences();
  const catalog = useMarketQuery<CraftCatalog>("/web/data/crafting.json", true, false);
  const quotes = useMarketQuery<{ prices: CraftPrice[] }>("/api/v1/crafting/prices", Boolean(catalog.data));
  const [recipeId, setRecipeId] = useState("");
  const [count, setCount] = useState("1");
  const [mode, setMode] = useState("direct");
  const [catalyst, setCatalyst] = useState(false);
  const [entered, setEntered] = useState<Record<string, string>>({});
  const prices = useMemo(() => new Map((quotes.data?.prices || []).map(row => [row.item_id, row])), [quotes.data]);
  const recipes: CraftRecipe[] = catalog.data ? recipesFor(catalog.data, itemId) : [];
  const recipe = recipes.find(row => row.id === recipeId) || recipes[0];
  if (!recipe || !catalog.data) return null;
  const number = (value: number | null | undefined) => value == null ? "—" : value.toLocaleString(language === "en" ? "en-US" : "zh-CN", { maximumFractionDigits: 2 });
  const name = (id: number) => {
    const row = prices.get(id) as any;
    return (language === "zh" ? row?.name_zh : row?.name_en) || catalog.data!.items[String(id)]?.name_en || row?.name_en || `#${id}`;
  };
  const link = (id: number) => <a href={`/item/${id}${language === "en" ? "?lang=en" : ""}`}>{name(id)}</a>;
  const discipline = (row: CraftRecipe) => language === "en" ? row.discipline : disciplines[row.discipline] || row.discipline;
  const labels: Record<string, string> = {
    manual: words("手动价", "Your price"), npc: words("NPC 参考购买价", "NPC shop reference"),
    market: words("近期成交参考", "Recent sale reference"), ask: words("最低挂牌参考", "Lowest ask reference"), unknown: words("暂无价格", "No price"),
  };
  let plan: any;
  try {
    const overrides = Object.fromEntries(Object.entries(entered).filter(([, value]) => value !== "").map(([id, value]) => [id, Number(value)]));
    plan = estimateCraft(recipe, catalog.data, prices, { batches: Number(count), mode, catalyst, overrides });
  } catch { /* Invalid partial number input keeps its control available. */ }
  return (
    <section className="well craft-well" id="crafting" data-crafting={itemId}>
      <div className="well-h"><h3>{words("制作配方与成本", "Crafting & cost")}</h3></div>
      <div className="craft-controls">
        <label>{words("配方", "Recipe")}
          <select data-craft-recipe value={recipe.id} onChange={event => { setRecipeId(event.target.value); setCatalyst(false); }}>
            {recipes.map(row => <option key={row.id} value={row.id}>{discipline(row)} Lv.{row.level} · {words("产出", "Makes")} ×{row.output_quantity}</option>)}
          </select>
        </label>
        <label>{words("制作次数", "Crafts")}<input data-craft-batches type="number" min="1" max="9999" step="1" value={count} onChange={event => setCount(event.target.value)} /></label>
        <label>{words("材料方案", "Materials")}<select data-craft-mode value={mode} onChange={event => setMode(event.target.value)}>
          <option value="direct">{words("购买配方材料", "Buy recipe ingredients")}</option>
          <option value="raw">{words("从原料开始制作", "Craft from raw materials")}</option>
        </select></label>
        {recipe.catalyst && <label data-catalyst-control><input type="checkbox" data-craft-catalyst checked={catalyst} onChange={event => setCatalyst(event.target.checked)} />{words("加入可选催化剂", "Include optional catalyst")}</label>}
      </div>
      <p className="note" data-craft-status role="status">
        {!plan ? words("请输入 1—9999 之间的整数制作次数。", "Enter 1–9999 whole crafts.") : quotes.isError ? words("行情暂时无法加载；可填写单价继续估算。", "Prices unavailable; enter unit prices to estimate.") : ""}
      </p>
      {plan && <div data-craft-result>
        {recipe.level > 8 && <p className="note">{words("此配方高于制作 8 级，版本与开放状态待核实。", "This recipe is above crafting level 8; availability needs verification.")}</p>}
        <p className="craft-meta">{discipline(recipe)} Lv.{recipe.level} · {words("产出", "Produces")} ×{plan.produced} · {words("成品制作经验", "Final craft EXP")} +{recipe.exp * Number(count)}</p>
        <div className="craft-table-wrap"><table className="craft-table"><thead><tr>
          <th>{words("材料", "Ingredient")}</th><th>{words("数量", "Qty")}</th><th>{words("单价（金币）", "Unit price (mesos)")}</th><th>{words("小计", "Subtotal")}</th>
        </tr></thead><tbody>{plan.materials.map((input: any) => <tr key={input.item_id}>
          <td>{link(input.item_id)}<small title={input.source || ""}>{labels[input.basis]}{input.low_data ? words(" · 样本少", " · Few samples") : ""}</small></td>
          <td>×{input.quantity}</td>
          <td><input type="number" data-craft-price={input.item_id} min="0" max="1000000000000" step="any" aria-label={`${name(input.item_id)} ${words("单价", "unit price")}`} placeholder={input.unit_price == null ? words("未知", "Unknown") : number(input.unit_price)} value={entered[input.item_id] ?? ""} onChange={event => { const value = event.target.value; setEntered(previous => ({ ...previous, [input.item_id]: value })); }} /></td>
          <td title={input.subtotal == null ? "" : String(input.subtotal)}>{input.subtotal == null ? words("缺价", "Unknown") : number(input.subtotal)}</td>
        </tr>)}</tbody></table></div>
        <div className="craft-totals">
          <span>{words("制作手续费", "Crafting fees")}<b>{number(plan.fee)}</b></span>
          <span>{words("总成本", "Total cost")}<strong data-craft-total title={plan.total == null ? "" : String(plan.total)}>{number(plan.total)}</strong></span>
          <span>{words("每件成本", "Cost per output")}<b>{number(plan.per_output)}</b></span>
        </div>
        {plan.missing > 0 && <p className="note">{words(`还有 ${plan.missing} 种材料缺价；已知费用 ${number(plan.known_subtotal)} 金币，总成本待补齐。`, `Missing prices for ${plan.missing} ingredients; known costs ${number(plan.known_subtotal)} mesos. Total is incomplete.`)}</p>}
        {plan.savings != null && <p className="craft-comparison">{plan.savings > 0 ? words("制作预计节省", "Estimated saving by crafting") : plan.savings < 0 ? words("直接购买预计节省", "Estimated saving by buying") : words("制作与购买成本相同", "Crafting and buying cost the same")} <b>{number(Math.abs(plan.savings))}</b> · {words("同数量购买参考", "Buy the same quantity")} {number(plan.buy_total)}</p>}
        {mode === "raw" && <><details className="craft-order"><summary>{words("制作顺序", "Craft order")} ({plan.steps.length})</summary><ol>{plan.steps.map((step: any) => <li key={step.recipe.id}>{link(step.recipe.item_id)} ×{step.quantity} · {discipline(step.recipe)} Lv.{step.recipe.level} · {step.batches} {words("次", "crafts")} · {number(step.recipe.fee * step.batches)} {words("手续费", "fee")}{step.quantity > step.needed && ` · ${words("剩余", "Surplus")} ${step.quantity - step.needed}`}</li>)}</ol></details><p className="note">{words("原料方案默认选最低制作等级、再选最低手续费的配方；按整批向上取整，含中间加工手续费。", "Raw route selects the lowest-level recipe, then the lowest fee; includes intermediate fees and rounds to whole batches.")}</p></>}
        <p className="note">{words("单价留空使用行情；填 0 表示自备材料，仅计算额外支出。估算不含技能升级费用或出售税费。", "Leave unit prices blank for market estimates; enter 0 for owned materials to estimate additional spending. Excludes skill leveling and selling fees.")}</p>
      </div>}
      <p className="note craft-source">{words("配方参考", "Recipe reference")}: <a href={catalog.data.source} target="_blank" rel="noopener noreferrer">NiaDB</a> · {catalog.data.checked_on}. {words("数据收录不代表当前版本已开放；材料价格使用本站行情。", "Catalogue presence does not confirm current availability; ingredient prices use this site’s market.")}</p>
    </section>
  );
}

import { useMemo } from "react";
import {
  recipesFor,
  estimateCraft,
  disciplines,
} from "/web/js/lib/crafting.js";
import { useMarketQuery } from "../lib/query";
import { usePreferences, useWords } from "../providers";
import { Icon, ItemNames, Slot } from "./shared";
import type { CraftCatalog, CraftPrice, CraftRecipe } from "../lib/types";

export default function Crafting({ itemId }: { itemId: number }) {
  const words = useWords(),
    { language } = usePreferences();
  const catalog = useMarketQuery<CraftCatalog>(
    "/web/data/crafting.json",
    true,
    false,
  );
  const quotes = useMarketQuery<{ prices: CraftPrice[] }>(
    "/api/v1/crafting/prices",
    Boolean(catalog.data),
  );
  const prices = useMemo(
    () => new Map((quotes.data?.prices || []).map((row) => [row.item_id, row])),
    [quotes.data],
  );
  const recipes: CraftRecipe[] = catalog.data
    ? recipesFor(catalog.data, itemId)
    : [];
  if (!recipes.length || !catalog.data) return null;
  const number = (value: number | null) =>
    value == null
      ? words("价格待补", "Price unavailable")
      : value.toLocaleString(language === "en" ? "en-US" : "zh-CN", {
          maximumFractionDigits: 2,
        });
  const plans = recipes.map((recipe) => ({
    recipe,
    plan: estimateCraft(recipe, catalog.data, prices),
  }));
  const best = plans.reduce((selected, current) =>
    current.plan.per_output != null &&
    (selected.plan.per_output == null ||
      current.plan.per_output < selected.plan.per_output)
      ? current
      : selected,
  );
  const discipline = (recipe: CraftRecipe) =>
    language === "en"
      ? recipe.discipline
      : disciplines[recipe.discipline] || recipe.discipline;
  return (
    <details className="craft-source" id="crafting" data-crafting={itemId}>
      <summary className="craft-summary">
        <span className="craft-heading">
          <b>{words("制作", "Crafting")}</b>
          <small>
            {discipline(best.recipe)} Lv.{best.recipe.level}
          </small>
        </span>
        <span className="craft-summary-cost">
          <small>{words("制作成本", "Craft cost")}</small>
          <strong
            data-craft-total
            title={
              best.plan.per_output == null ? "" : String(best.plan.per_output)
            }
          >
            {number(best.plan.per_output)}
          </strong>
        </span>
        <Icon name="chev" />
      </summary>
      <div className="craft-body" data-craft-result>
        {plans.map(({ recipe, plan }) => (
          <section className="craft-recipe" key={recipe.id}>
            <div className="craft-recipe-meta">
              <span>
                {discipline(recipe)} Lv.{recipe.level} ·{" "}
                {words("产出", "Produces")} ×{plan.produced}
              </span>
              {plans.length > 1 && <b>{number(plan.per_output)}</b>}
            </div>
            <div className="craft-materials">
              {plan.materials.map(
                (material: {
                  item_id: number;
                  quantity: number;
                  subtotal: number | null;
                  unit_price: number | null;
                }) => {
                  const quote = prices.get(material.item_id);
                  const row = {
                    item_id: material.item_id,
                    name_zh: quote?.name_zh || undefined,
                    name_en:
                      quote?.name_en ||
                      catalog.data!.items[String(material.item_id)]?.name_en ||
                      undefined,
                  };
                  return (
                    <a
                      className="craft-material"
                      data-craft-material={material.item_id}
                      href={`/item/${material.item_id}${language === "en" ? "?lang=en" : ""}`}
                      key={material.item_id}
                    >
                      <span className="craft-material-picture">
                        <Slot
                          size={32}
                          url={
                            quote?.icon_url ||
                            `https://mxdgcw.dvg.cn/dbsource/icon/item/${material.item_id}.png`
                          }
                        />
                        <span className="craft-quantity">
                          ×{material.quantity}
                        </span>
                      </span>
                      <ItemNames row={row} />
                      <span
                        className="craft-material-price"
                        title={
                          material.unit_price == null
                            ? ""
                            : words(
                                `单价 ${number(material.unit_price)}`,
                                `Unit price ${number(material.unit_price)}`,
                              )
                        }
                      >
                        {number(material.subtotal)}
                      </span>
                    </a>
                  );
                },
              )}
            </div>
            <div className="craft-costs">
              <span>
                {words("手续费", "Crafting fee")}
                <b>{number(plan.fee)}</b>
              </span>
              <span>
                {words("合计", "Total")}
                <b>{number(plan.total)}</b>
              </span>
            </div>
            {plan.missing > 0 && (
              <p className="craft-missing" role="status">
                {quotes.isError
                  ? words("价格暂时无法加载", "Prices unavailable")
                  : words(
                      `${plan.missing} 种材料缺价`,
                      `${plan.missing} ingredient prices unavailable`,
                    )}
              </p>
            )}
            {plan.savings != null && (
              <p className="craft-comparison">
                {plan.savings > 0
                  ? words("比直接购买省 ", "Crafting saves ")
                  : plan.savings < 0
                    ? words("直接购买便宜 ", "Buying saves ")
                    : words("与直接购买同价", "Same cost as buying")}
                {plan.savings !== 0 && <b>{number(Math.abs(plan.savings))}</b>}
              </p>
            )}
          </section>
        ))}
        <a
          className="craft-credit"
          href={catalog.data.source}
          target="_blank"
          rel="noopener noreferrer"
        >
          NiaDB
        </a>
      </div>
    </details>
  );
}

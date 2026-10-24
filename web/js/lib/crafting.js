// Pure recipe planning and pricing. Missing quotes are never zero-cost inputs.
export const CRAFT_CATALOG_URL = '/web/data/crafting.json';
let catalogPromise;
export function loadCraftingCatalog() {
  return catalogPromise ||= fetch(CRAFT_CATALOG_URL).then(response => {
    if (!response.ok) throw Error('Crafting catalogue unavailable');
    return response.json();
  }).catch(error => { catalogPromise = null; throw error; });
}

export const recipesFor = (catalog, id) => catalog.recipes.filter(recipe => recipe.item_id === Number(id));
export const craftableIds = catalog => new Set(catalog.recipes.filter(recipe => recipe.level <= 8).map(recipe => recipe.item_id));

const priceValue = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
export function ingredientPrice(id, prices, overrides = {}) {
  if (Object.hasOwn(overrides, id)) return { unit_price: priceValue(overrides[id]), basis: 'manual' };
  const quote = prices.get(Number(id));
  if (!quote) return { unit_price: null, basis: 'unknown' };
  const market = priceValue(quote.market_price), ask = priceValue(quote.ask_price), npc = priceValue(quote.npc_price);
  const trade = market ?? ask;
  if (npc != null && (trade == null || npc <= trade)) return { unit_price: npc, basis: 'npc', source: quote.npc_source };
  return { unit_price: trade, basis: market != null ? 'market' : ask != null ? 'ask' : 'unknown', low_data: quote.low_data };
}

// From-scratch uses the lowest-level recipe, then the lowest fee. It is an
// explicit route, not a claim to find the cheapest possible crafting strategy.
function rawPlan(root, catalog, batches, catalyst) {
  const choices = new Map();
  for (const recipe of catalog.recipes.filter(row => row.level <= 8).slice().sort((a,b) => a.level-b.level || a.fee-b.fee || a.id.localeCompare(b.id))) {
    if (!choices.has(recipe.item_id)) choices.set(recipe.item_id, recipe);
  }
  choices.set(root.item_id, root);
  const visited = new Set(), visiting = new Set(), order = [];
  const inputs = recipe => [...recipe.ingredients, ...(recipe.id === root.id && catalyst && recipe.catalyst ? [recipe.catalyst] : [])];
  function visit(id) {
    if (visiting.has(id)) throw Error('Cyclic crafting recipe');
    if (visited.has(id)) return;
    visiting.add(id);
    const recipe = choices.get(id);
    if (recipe) for (const input of inputs(recipe)) visit(input.item_id);
    visiting.delete(id); visited.add(id); order.push(id);
  }
  visit(root.item_id);
  const needed = new Map([[root.item_id, batches * root.output_quantity]]), steps = [];
  let fee = 0;
  // Parents first: merge shared intermediate demand BEFORE rounding batches.
  for (const id of order.slice().reverse()) {
    const recipe = choices.get(id), quantity = needed.get(id) || 0;
    if (!recipe || !quantity) continue;
    const count = Math.ceil(quantity / recipe.output_quantity);
    fee += recipe.fee * count;
    steps.push({ recipe, batches: count, quantity: count * recipe.output_quantity, needed: quantity });
    needed.delete(id);
    for (const input of inputs(recipe)) needed.set(input.item_id, (needed.get(input.item_id) || 0) + input.quantity * count);
  }
  return { fee, steps: steps.reverse(), materials: [...needed].map(([item_id, quantity]) => ({ item_id, quantity })) };
}

export function estimateCraft(recipe, catalog, prices, { batches = 1, mode = 'direct', catalyst = false, overrides = {} } = {}) {
  if (!Number.isSafeInteger(batches) || batches < 1 || batches > 9999) throw Error('Invalid craft quantity');
  const plan = mode === 'raw' ? rawPlan(recipe, catalog, batches, catalyst) : {
    fee: recipe.fee * batches,
    steps: [{ recipe, batches, quantity: recipe.output_quantity * batches }],
    materials: [...recipe.ingredients, ...(catalyst && recipe.catalyst ? [recipe.catalyst] : [])].map(input => ({ ...input, quantity: input.quantity * batches })),
  };
  let known = plan.fee;
  const materials = plan.materials.map(input => {
    const price = ingredientPrice(input.item_id, prices, overrides);
    const subtotal = price.unit_price == null ? null : input.quantity * price.unit_price;
    if (subtotal != null) known += subtotal;
    return { ...input, ...price, subtotal };
  });
  const missing = materials.filter(input => input.subtotal == null).length;
  const total = missing ? null : known, produced = recipe.output_quantity * batches;
  const buy = ingredientPrice(recipe.item_id, prices).unit_price;
  return { ...plan, materials, missing, known_subtotal: known, total, produced,
    per_output: total == null ? null : total / produced,
    buy_total: buy == null ? null : buy * produced,
    savings: total == null || buy == null ? null : buy * produced - total };
}

export const disciplines = {
  Smithing: '锻造', Weaponcrafting: '武器制作', Tailoring: '裁缝',
  Woodcrafting: '木工', Leatherworking: '皮革制作', Arcforge: '奥术锻造',
};

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { recipesFor, ingredientPrice, estimateCraft, craftableIds } from '../js/lib/crafting.js';

const catalog = JSON.parse(await readFile(new URL('../data/crafting.json', import.meta.url)));
const bow = recipesFor(catalog, 1452003)[0];
const quotes = entries => new Map(entries.map(([id, market_price]) => [id, {market_price}]));

test('snapshot resolves all recipe and catalyst IDs and contains the four reference items', () => {
  assert.equal(catalog.recipes.length, 366);
  assert.equal(new Set(catalog.recipes.map(r=>r.id)).size,366);
  for(const recipe of catalog.recipes) {
    assert(catalog.items[recipe.item_id]);
    for(const input of [...recipe.ingredients,...(recipe.catalyst?[recipe.catalyst]:[])]) assert(catalog.items[input.item_id]);
  }
  for(const id of [1452003,1072062,1072063,1072064]) assert(craftableIds(catalog).has(id));
  assert.equal(bow.fee,5500);
  assert.deepEqual(bow.ingredients.map(i=>i.quantity),[7,2,2,15]);
  assert(catalog.recipes.some(r=>r.level>8&&!craftableIds(catalog).has(r.item_id)));
});

test('direct ingredient cost adds the fee once, scales batches and compares equal output quantities', () => {
  const prices=quotes([...bow.ingredients.map((r,i)=>[r.item_id,[300,2300,600,250][i]]),[bow.item_id,8000]]);
  const one=estimateCraft(bow,catalog,prices);
  assert.equal(one.total,17150);assert.equal(one.savings,-9150);
  const two=estimateCraft(bow,catalog,prices,{batches:2});
  assert.equal(two.total,34300);assert.equal(two.produced,2);assert.equal(two.buy_total,16000);
});

test('missing material or catalyst prices cannot produce a full total or a savings claim', () => {
  const prices=quotes(bow.ingredients.map(r=>[r.item_id,100]));
  const base=estimateCraft(bow,catalog,prices);
  assert.equal(base.missing,0);
  const optional=estimateCraft(bow,catalog,prices,{catalyst:true});
  assert.equal(optional.missing,1);assert.equal(optional.total,null);assert.equal(optional.savings,null);
  assert.equal(optional.known_subtotal,base.total);
  prices.delete(bow.ingredients[0].item_id);
  assert.equal(estimateCraft(bow,catalog,prices).total,null);
});

test('manual zero is an explicit owned material; invalid and absent prices stay unknown', () => {
  assert.equal(ingredientPrice(1,new Map(),{1:0}).unit_price,0);
  for(const bad of [null,NaN,Infinity,-1,'25']) assert.equal(ingredientPrice(1,new Map(),{1:bad}).unit_price,null);
  assert.equal(ingredientPrice(1,new Map()).unit_price,null);
  const prices=new Map([[1,{market_price:200,npc_price:100,sell_price:1}],[2,{market_price:null,ask_price:50}]]);
  assert.deepEqual(ingredientPrice(1,prices),{unit_price:100,basis:'npc',source:undefined});
  assert.equal(ingredientPrice(2,prices).basis,'ask');
});

const synthetic=(item_id,ingredients,output_quantity=1,fee=0)=>({id:String(item_id),item_id,level:1,discipline:'Smithing',output_quantity,ingredients,fee});
test('raw planning merges shared intermediate demand before rounding whole batches', () => {
  const root=synthetic(1,[{item_id:2,quantity:1},{item_id:3,quantity:1}],1,50);
  const recipes=[root,synthetic(2,[{item_id:4,quantity:4}],1,10),synthetic(3,[{item_id:4,quantity:4}],1,10),synthetic(4,[{item_id:5,quantity:2}],10,20)];
  const plan=estimateCraft(root,{recipes},quotes([[5,100]]),{mode:'raw'});
  assert.equal(plan.fee,90);assert.equal(plan.total,290);
  assert.equal(plan.steps.find(s=>s.recipe.item_id===4).batches,1);
  assert.equal(plan.steps.find(s=>s.recipe.item_id===4).quantity,10);
  assert.equal(plan.steps.at(-1).recipe.item_id,1);
});

test('raw Battle Bow route includes precrafting fees and ingredients only once', () => {
  const plan=estimateCraft(bow,catalog,new Map(),{mode:'raw'});
  assert.equal(plan.fee,7600);
  assert(plan.missing>0);assert.equal(plan.total,null);
  assert.equal(plan.materials.length,new Set(plan.materials.map(i=>i.item_id)).size);
  const complete=estimateCraft(bow,catalog,quotes(plan.materials.map(i=>[i.item_id,1])),{mode:'raw'});
  assert.equal(complete.total,7600+plan.materials.reduce((s,i)=>s+i.quantity,0));
});

test('multiple outputs use cost per produced item; invalid batch counts and cycles reject', () => {
  const root=synthetic(1,[{item_id:2,quantity:1}],10,50);
  const plan=estimateCraft(root,{recipes:[root]},quotes([[2,100],[1,25]]),{batches:2});
  assert.equal(plan.total,300);assert.equal(plan.produced,20);assert.equal(plan.per_output,15);assert.equal(plan.savings,200);
  for(const batches of [0,-1,1.5,10000,NaN])assert.throws(()=>estimateCraft(root,{recipes:[root]},new Map(),{batches}));
  const cycle=synthetic(2,[{item_id:1,quantity:1}]);
  assert.throws(()=>estimateCraft(root,{recipes:[root,cycle]},new Map(),{mode:'raw'}),/Cyclic/);
});

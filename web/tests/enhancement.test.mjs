import assert from 'node:assert/strict';
import test from 'node:test';
import {readFile} from 'node:fs/promises';
const source=await readFile(new URL('../js/lib/enhancement.js',import.meta.url),'utf8');
const {calculateEnhancement:calculate,calculateMixedEnhancement:mixed,enhancementMetadata,compatibleScroll,enhancementQuote,enhancementBaseOptions}=await import('data:text/javascript;base64,'+Buffer.from(source).toString('base64'));
const near=(actual,expected)=>assert(Math.abs(actual-expected)<1e-8*Math.max(1,expected),`${actual} ≠ ${expected}`);
const solve=(slots,successes,x=1,p=.6)=>calculate({equipmentPrice:x,scrollPrice:1,slots,successes,successRate:p});
test('known optimal renewal costs and price-dependent abandon thresholds',()=>{
  for(const [n,k,x,cost] of [[5,3,0,8615/1539],[5,3,1,22/3],[5,3,3,3125/2133*3+4235/711],[5,4,1,12385/891],[5,4,2,18230/1053],[7,5,1,373030/24543],[7,5,1.4,(78125*1.4+381715)/29889],[7,5,2,570605/31833],[7,5,10,244885/6561]]) near(solve(n,k,x).expectedCost,cost);
  for(const [n,k,boundary] of [[5,3,148/375],[5,4,228/125],[7,5,45598/34375]]){
    assert(solve(n,k,boundary-.00001).stops.some(s=>s.used===1&&s.successes===0));
    assert(!solve(n,k,boundary+.00001).stops.some(s=>s.used===1&&s.successes===0));
  }
  assert.deepEqual(solve(7,5,.1).stops.map(s=>[s.used,s.successes]),[[1,0],[3,1]]);
});
test('matches exhaustive enumeration of every discard policy for small slot counts',()=>{
  for(let n=1;n<=4;n++)for(let k=1;k<=n;k++)for(const p of [.1,.6,1])for(const x of [0,.2,2,20]){
    const states=[];for(let remaining=1;remaining<n;remaining++)for(let needed=1;needed<=Math.min(k,remaining);needed++)if(k-needed<=n-remaining)states.push([remaining,needed]);
    let best=Infinity;
    for(let mask=0;mask<2**states.length;mask++){
      const abandon=new Set(states.filter((_,i)=>mask&(1<<i)).map(s=>s.join(',')));
      function visit(remaining,needed){
        if(!needed)return[1,0];if(remaining<needed||abandon.has([remaining,needed].join(',')))return[0,0];
        const[a,b]=visit(remaining-1,needed-1),[c,d]=visit(remaining-1,needed);
        return[p*a+(1-p)*c,1+p*b+(1-p)*d];
      }
      const[probability,scrolls]=visit(n,k);best=Math.min(best,(x+scrolls)/probability);
    }
    near(solve(n,k,x,p).expectedCost,best);
  }
});
test('costs scale with currency and equal expected equipment plus scroll spend',()=>{
  for(const [n,k] of [[5,3],[5,4],[7,3],[7,4],[7,5]]){
    const a=solve(n,k,2),b=calculate({equipmentPrice:2000000,scrollPrice:1000000,slots:n,successes:k,successRate:.6});
    near(b.expectedCost,a.expectedCost*1000000);near(b.expectedCost,b.equipmentCount*2000000+b.scrollCount*1000000);
  }
  near(solve(7,5,2,1).expectedCost,7);
  assert.equal(calculate({equipmentPrice:1,scrollPrice:0,slots:5,successes:3,successRate:.6}),null);
  assert.equal(solve(5,6),null);
});
test('metadata favours structured CW values over conflicting descriptions',()=>{
  const data=enhancementMetadata({description_zh:'成功率：60%，魔法攻击力+2',base_stats:[{key:'incMAD',value:4}],mapledex_reference:{data:{success:60,d:{en:'Success rate: 60%, Magic Attack +4'}}}});
  assert.equal(data.successRate,.6);assert.equal(data.effects[0].value,4);
  const equipment=enhancementMetadata({mapledex_reference:{data:{tuc:7}}});assert.equal(equipment.slots,7);
  assert.equal(enhancementMetadata({}).slots,null);assert.equal(enhancementMetadata({}).successRate,null);
  assert(compatibleScroll(1082000,2040801));assert(!compatibleScroll(1452003,2040801));assert(compatibleScroll(1452003,2044501));
});
test('equipment quotes exclude enhanced, spent-slot and unparsed items',()=>{
  const row=(price,equipment)=>({unit_price:price,stock:1,equipment});
  const data={listings:[row(1,{enhancements:1,remaining_upgrades:5}),row(2,{enhancements:0,remaining_upgrades:4}),row(3,null),row(100,{enhancements:0,remaining_upgrades:5}),{...row(4,{enhancements:0,remaining_upgrades:5}),stock:0}]};
  assert.equal(enhancementQuote(data,5),100);assert.equal(enhancementQuote({listings:[]},5),null);
});
test('default prices use the median of eligible unit asks and ignore extreme listings',()=>{
  const rows=prices=>prices.map(unit_price=>({unit_price,stock:1,equipment:{enhancements:0,remaining_upgrades:5}}));
  const data={listings:rows([1000000,90,1,100,110])};
  assert.equal(enhancementQuote(data),100);assert.equal(enhancementQuote(data,5),100);
  assert.equal(enhancementQuote({listings:rows([200,100,20,120])}),110);
  assert.equal(enhancementQuote({listings:rows([10,20,NaN,Infinity,-10,0])}),15);
  assert.equal(enhancementQuote({listings:[...rows([100]),{unit_price:1,stock:0},{unit_price:2,stock:1,invalidated_at:1}]}),100);
  assert.deepEqual(data.listings.map(row=>row.unit_price),[1000000,90,1,100,110],'does not reorder shared market data');
});
test('25/50/70 percentile prices interpolate eligible unit prices only',()=>{
  const snapshot={listings:[10,100,200,300,10000].map(unit_price=>({unit_price,stock:1,equipment:{enhancements:0,remaining_upgrades:5}}))};
  assert.equal(enhancementQuote(snapshot,5,.25),100);assert.equal(enhancementQuote(snapshot,5,.5),200);assert.equal(enhancementQuote(snapshot,5,.7),280);
  assert.equal(enhancementQuote(snapshot,null,0),10);assert.equal(enhancementQuote(snapshot,null,1),10000);
  assert.equal(enhancementQuote(snapshot,5,1.1),null);assert.equal(enhancementQuote(snapshot,5,NaN),null);
});
test('base stats use captured original values, combine with AND and never include upgraded equipment',()=>{
  const row=(price,attack,dex,upgrades=5,enhancements=0)=>({unit_price:price,stock:1,equipment:{enhancements,remaining_upgrades:upgrades,stats:[{key:'weapon_attack',value:attack},{key:'dex',value:dex}]}});
  const snapshot={listings:[row(100,20,3),row(200,20,5),row(300,30,3),row(1,20,3,5,1),row(2,20,3,4),{unit_price:3,stock:1,equipment:{enhancements:0,remaining_upgrades:5}}]};
  assert.equal(enhancementQuote(snapshot,5,.5,{weapon_attack:20}),150);
  assert.equal(enhancementQuote(snapshot,5,.5,{weapon_attack:20,dex:3}),100);
  assert.equal(enhancementQuote(snapshot,5,.5,{weapon_attack:30,dex:5}),null);
  assert.equal(enhancementQuote(snapshot,5,.25,{weapon_attack:20}),125);
  assert.equal(enhancementQuote(snapshot,5,.5,{str:0,dex:3}),200,'known absent numeric stats are zero, while unparsed stats are excluded');
  assert.equal(enhancementQuote(snapshot,5,.5,{weapon_attack:'',dex:3}),200);
  assert.equal(enhancementQuote(snapshot,5,.5,{weapon_attack:'not a number'}),null);
  const options=enhancementBaseOptions(snapshot,5);assert.deepEqual(options.find(stat=>stat.key==='weapon_attack').values,[20,30]);assert.deepEqual(options.find(stat=>stat.key==='dex').values,[3,5]);
});
test('mixed 10% and 60% actions match exhaustive discard-and-scroll policies',()=>{
  for(const [n,target,x,tenPrice] of [[2,3,0,.1],[2,4,.2,.1],[3,4,.1,.2],[3,6,1,.1],[3,8,2,1]]){
    const options=[{id:60,price:1,gain:2,successRate:.6},{id:10,price:tenPrice,gain:3,successRate:.1}];
    const states=[];for(let remaining=1;remaining<=n;remaining++)for(let g=1;g<=Math.min(target,remaining*3);g++)if(remaining<n||g===target)states.push([remaining,g]);
    let best=Infinity;
    for(let mask=0;mask<3**states.length;mask++){
      const actions=new Map();let code=mask;for(const state of states){actions.set(state.join(','),code%3-1);code=Math.floor(code/3);}
      function visit(remaining,g){
        if(g<=0)return[1,0];if(remaining<=0||g>remaining*3)return[0,0];
        const action=actions.get([remaining,g].join(','));if(action===-1)return[0,0];
        const scroll=options[action],[a,b]=visit(remaining-1,g-scroll.gain),[c,d]=visit(remaining-1,g);
        return[scroll.successRate*a+(1-scroll.successRate)*c,scroll.price+scroll.successRate*b+(1-scroll.successRate)*d];
      }
      const[p,cost]=visit(n,target);if(p)best=Math.min(best,(x+cost)/p);
    }
    const plan=mixed({equipmentPrice:x,slots:n,target,scrolls:options});near(plan.expectedCost,best);
    near(plan.expectedCost,plan.equipmentCount*x+plan.scrolls.reduce((sum,s)=>sum+s.count*s.price,0));
  }
});
test('mixed plans permit overshooting a user-entered target and exclude invalid prices',()=>{
  const options=[{id:60,price:1,gain:2,successRate:.6},{id:10,price:.1,gain:3,successRate:.1}];
  assert(mixed({equipmentPrice:1,slots:5,target:7,scrolls:options}));
  assert.equal(mixed({equipmentPrice:1,slots:5,target:16,scrolls:options}),null);
  assert.equal(mixed({equipmentPrice:1,slots:5,target:0,scrolls:options}),null);
  assert.equal(mixed({equipmentPrice:1,slots:5,target:7.5,scrolls:options}),null);
  assert.equal(mixed({equipmentPrice:1,slots:5,target:7,scrolls:[{...options[0],price:0}]}),null);
});

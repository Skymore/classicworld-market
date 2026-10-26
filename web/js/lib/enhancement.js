// Minimise (equipment price + scroll spend per attempt) / attempt success probability.
// A failed attempt can end at any state; replacement always buys a fresh item.
export function calculateEnhancement({ equipmentPrice, scrollPrice, slots, successes, successRate }) {
  const plan = calculateMixedEnhancement({equipmentPrice,slots,target:successes,scrolls:[{id:0,price:scrollPrice,gain:1,successRate}]});
  return plan && {...plan,scrollCount:plan.scrolls[0].count,stops:plan.stops.map(state=>({...state,successes:state.gain}))};
}

export function calculateMixedEnhancement({equipmentPrice,slots,target,scrolls}) {
  if (!Number.isFinite(equipmentPrice) || equipmentPrice<0 || !Number.isInteger(slots) || slots<1 || slots>15 || !Number.isInteger(target) || target<1 || !Array.isArray(scrolls) || !scrolls.length || scrolls.some(s=>!Number.isFinite(s.price)||s.price<=0||!Number.isInteger(s.gain)||s.gain<1||!Number.isFinite(s.successRate)||s.successRate<=0||s.successRate>1)) return null;
  const maxGain=Math.max(...scrolls.map(s=>s.gain));
  if(target>slots*maxGain || target>1500)return null;
  const scale=Math.min(...scrolls.map(s=>s.price)),ratio=equipmentPrice/scale;
  const options=scrolls.map(s=>({...s,cost:s.price/scale})).sort((a,b)=>b.successRate-a.successRate);
  function attempt(decisions, fallback=0) {
    const memo=new Map();
    function visit(n,g) {
      if(g<=0)return {probability:1,counts:options.map(()=>0)};
      const action=decisions ? decisions.get(`${n},${g}`) : fallback;
      if(n*maxGain<g||n<=0||action===-1)return {probability:0,counts:options.map(()=>0)};
      const key=`${n},${g}`;
      if(!memo.has(key)){
        const scroll=options[action],p=scroll.successRate;
        const win=visit(n-1,g-scroll.gain),lose=visit(n-1,g);
        memo.set(key,{probability:p*win.probability+(1-p)*lose.probability,counts:options.map((_,i)=>(i===action?1:0)+p*win.counts[i]+(1-p)*lose.counts[i])});
      }
      return memo.get(key);
    }
    const {probability,counts}=visit(slots,target);
    return {cost:(ratio+counts.reduce((sum,count,i)=>sum+count*options[i].cost,0))/probability,probability,equipment:1/probability,counts:counts.map(count=>count/probability)};
  }
  let plan=options.map((_,index)=>attempt(null,index)).reduce((a,b)=>a.cost<b.cost?a:b),decisions;
  if(!Number.isFinite(plan.cost))return null;
  for(let iteration=0;iteration<100;iteration++){
    const restart=plan.cost,memo=new Map();decisions=new Map();
    function value(n,g){
      if(g<=0)return 0;
      if(n*maxGain<g||n<=0)return restart;
      const key=`${n},${g}`;
      if(!memo.has(key)){
        const costs=options.map(scroll=>scroll.cost+scroll.successRate*value(n-1,g-scroll.gain)+(1-scroll.successRate)*value(n-1,g));
        let action=0;for(let i=1;i<costs.length;i++)if(costs[i]<costs[action]-1e-12*Math.max(1,restart))action=i;
        const keep=n===slots&&g===target||costs[action]<=restart+1e-12*Math.max(1,restart);
        decisions.set(key,keep?action:-1);memo.set(key,keep?costs[action]:restart);
      }
      return memo.get(key);
    }
    value(slots,target);
    const next=attempt(decisions),settled=Math.abs(next.cost-plan.cost)<=1e-11*Math.max(1,next.cost);
    plan=next;if(settled)break;
  }
  const states=[],stops=[],seen=new Set();
  function reachable(n,g){
    if(g<=0||n*maxGain<g||n<=0)return;
    const key=`${n},${g}`;if(seen.has(key))return;seen.add(key);
    const action=decisions.get(key),state={used:slots-n,gain:target-g,remaining:n,scrollId:action===-1?null:options[action].id};
    states.push(state);
    if(action===-1){stops.push(state);return;}
    reachable(n-1,g-options[action].gain);
    if(options[action].successRate<1)reachable(n-1,g);
  }
  reachable(slots,target);
  return {expectedCost:plan.equipment*equipmentPrice+plan.counts.reduce((sum,count,i)=>sum+count*options[i].price,0),equipmentCount:plan.equipment,attemptSuccessRate:plan.probability,scrolls:options.map((scroll,i)=>({...scroll,count:plan.counts[i]})),states:states.sort((a,b)=>a.used-b.used||b.gain-a.gain),stops:stops.sort((a,b)=>a.used-b.used||a.gain-b.gain)};
}

export const enhancementStats = [
  ['incPAD','攻击力','Weapon attack'], ['incMAD','魔法攻击力','Magic attack'],
  ['incSTR','力量','STR'], ['incDEX','敏捷','DEX'], ['incINT','智力','INT'], ['incLUK','运气','LUK'],
  ['incACC','命中','Accuracy'], ['incEVA','回避','Avoidability'],
  ['incSpeed','移动速度','Speed'], ['incJump','跳跃力','Jump'],
  ['incMHP','生命','HP'], ['incMMP','魔法','MP'],
  ['incPDD','物理防御','Weapon defense'], ['incMDD','魔法防御','Magic defense'],
];
const englishStats = {
  incPAD: /Weapon Attack\s*\+\s*(\d+)/i, incMAD: /Magic Attack\s*\+\s*(\d+)/i,
  incSTR: /STR\s*\+\s*(\d+)/i, incDEX: /DEX\s*\+\s*(\d+)/i,
  incINT: /INT\s*\+\s*(\d+)/i, incLUK: /LUK\s*\+\s*(\d+)/i,
  incACC: /Accuracy\s*\+\s*(\d+)/i, incEVA: /Avoidability\s*\+\s*(\d+)/i,
  incSpeed: /Speed\s*\+\s*(\d+)/i, incJump: /Jump\s*\+\s*(\d+)/i,
  incMHP: /(?:Max\.?\s*)?HP\s*\+\s*(\d+)/i, incMMP: /(?:Max\.?\s*)?MP\s*\+\s*(\d+)/i,
  incPDD: /Weapon Defen[sc]e\s*\+\s*(\d+)/i, incMDD: /Magic Defen[sc]e\s*\+\s*(\d+)/i,
};
export function enhancementMetadata(record) {
  const data = record?.mapledex_reference?.data || {};
  const description = data.d?.en || '';
  const rate = Number(data.success ?? /Success rate\s*:\s*(\d+)\s*%/i.exec(description)?.[1]);
  const effects = enhancementStats.flatMap(([key,zh,en]) => {
    const value = Number(data[key] ?? record?.base_stats?.find(stat => stat.key === key)?.value ?? englishStats[key]?.exec(description)?.[1]);
    return Number.isFinite(value) && value > 0 ? [{ key, zh, en, value }] : [];
  });
  return {
    slots: Number.isInteger(data.tuc) && data.tuc > 0 && data.tuc <= 15 ? data.tuc : null,
    successRate: rate > 0 && rate <= 100 ? rate/100 : null,
    effects,
    destructive: Boolean(data.cursed || data.destroy || data.curse) || /destroy|destruct|破坏|消失/.test(description.toLowerCase()),
  };
}
export function compatibleScroll(equipmentId,scrollId) {
  const family = Math.floor(equipmentId/10000);
  return Math.floor(scrollId/100) === 20400+family-100;
}
export const enhancementBaseStats = [
  ['weapon_attack','incPAD','攻击力','Weapon attack'],['magic_attack','incMAD','魔法攻击力','Magic attack'],
  ['str','incSTR','力量','STR'],['dex','incDEX','敏捷','DEX'],['int','incINT','智力','INT'],['luk','incLUK','运气','LUK'],
  ['accuracy','incACC','命中','Accuracy'],['avoid','incEVA','回避','Avoidability'],
  ['speed','incSpeed','移动速度','Speed'],['jump','incJump','跳跃力','Jump'],
  ['hp','incMHP','生命','HP'],['mp','incMMP','魔法','MP'],
  ['weapon_defense','incPDD','物理防御','Weapon defense'],['magic_defense','incMDD','魔法防御','Magic defense'],
];
export function enhancementBaseValue(equipment,key) {
  if (!Array.isArray(equipment?.stats)) return null;
  const definition = enhancementBaseStats.find(row => row[0] === key);
  if (!definition) return null;
  const stat = equipment.stats.find(row => row.key === key || row.key === definition[1] || key === 'avoid' && row.key === 'avoidability');
  return stat ? Number.isFinite(stat.value) ? stat.value : null : 0;
}
function enhancementListings(snapshot,slots=null,stats={}) {
  const rows = (snapshot?.listings || []).filter(row => {
    if (row.stock != null && row.stock <= 0 || row.invalidated_at || !Number.isFinite(row.unit_price) || row.unit_price <= 0) return false;
    if (slots === null) return true;
    if (row.equipment?.enhancements !== 0 || row.equipment?.remaining_upgrades !== slots) return false;
    return Object.entries(stats).every(([key,value]) => value === '' || Number.isFinite(Number(value)) && enhancementBaseValue(row.equipment,key) === Number(value));
  });
  return rows;
}
export function enhancementBaseOptions(snapshot,slots) {
  const rows = enhancementListings(snapshot,slots);
  return enhancementBaseStats.map(([key,reference,zh,en]) => ({key,reference,zh,en,values:[...new Set(rows.map(row => enhancementBaseValue(row.equipment,key)).filter(value => value !== null))].sort((a,b) => a-b)})).filter(row => row.values.length);
}
export function enhancementQuote(snapshot,slots=null,percentile=.5,stats={}) {
  if (!Number.isFinite(percentile) || percentile < 0 || percentile > 1) return null;
  const rows = enhancementListings(snapshot,slots,stats);
  if (!rows.length) return null;
  const prices = rows.map(row => row.unit_price).sort((a,b) => a-b);
  const position = (prices.length-1)*percentile, lower = Math.floor(position), weight = position-lower;
  return prices[lower]*(1-weight)+prices[Math.ceil(position)]*weight;
}

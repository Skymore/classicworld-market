// The state stays in the URL. These tokens expose conditions otherwise hidden
// inside the filter panel, without repeating the visible search/categories.
export function priceFilterTokens(s, en=false, dropOk=true) {
  const tokens=[];
  const jobs=en?{warrior:'Warrior',magician:'Magician',bowman:'Bowman',thief:'Thief',pirate:'Pirate'}:{warrior:'战士',magician:'魔法师',bowman:'弓箭手',thief:'飞侠',pirate:'海盗'};
  if(s.job!=='all' && jobs[s.job])tokens.push({key:'job',label:jobs[s.job]});
  if((s.lmin!=null && s.lmin>0)||s.lmax!=null)tokens.push({key:'level',label:`${en?'Lv.':'等级 '}${s.lmin??0}–${s.lmax??(en?'any':'不限')}`});
  if(!s.few)tokens.push({key:'few',label:en?'5+ sales':'至少 5 笔'});
  if(!s.cash)tokens.push({key:'cash',label:en?'Hide cash items':'隐藏商城物品'});
  if(s.sold)tokens.push({key:'sold',label:en?'With sales':'有成交记录'});
  if(s.drop && dropOk)tokens.push({key:'drop',label:en?'Monster drops':'怪物掉落'});
  if(s.watch)tokens.push({key:'watch',label:en?'Watched only':'只看关注'});
  return tokens;
}
export function clearPriceFilter(state,key) {
  const defaults={job:'all',lmin:null,lmax:null,few:true,cash:true,sold:false,drop:false,watch:false};
  if(key==='all')return {...state,...defaults};
  if(key==='everything')return {...state,...defaults,q:'',cat:'all'};
  if(key==='level')return {...state,lmin:null,lmax:null};
  return Object.hasOwn(defaults,key)?{...state,[key]:defaults[key]}:{...state};
}

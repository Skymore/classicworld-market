// The state stays in the URL. These tokens expose conditions otherwise hidden
// inside the filter panel, without repeating the visible search/categories.
export const equipmentTypes = [
  ['all', '所有类型', 'All types'],
  ['weapon', '武器', 'Weapon'],
  ['hat', '帽子', 'Hat'],
  ['overall', '套服', 'Overall'],
  ['top', '上衣', 'Top'],
  ['bottom', '裤裙', 'Bottom'],
  ['gloves', '手套', 'Gloves'],
  ['shoes', '鞋子', 'Shoes'],
  ['shield', '盾牌', 'Shield'],
  ['cape', '披风', 'Cape'],
  ['face', '脸饰', 'Face accessory'],
  ['eye', '眼饰', 'Eye accessory'],
  ['earrings', '耳环', 'Earrings'],
  ['ring', '戒指', 'Ring'],
  ['pendant', '项链', 'Pendant'],
  ['belt', '腰带', 'Belt'],
  ['medal', '勋章', 'Medal'],
  ['pet', '宠物装备', 'Pet equipment'],
];
export function matchesEquipmentType(row, type = 'all') {
  const selected = equipmentTypes.find(([key]) => key === type);
  return !selected || type === 'all' || (row.category === '装备' && row.subcategory === selected[1]);
}
export function priceFilterTokens(s, en=false, dropOk=true) {
  const tokens=[];
  const jobs=en?{warrior:'Warrior',magician:'Magician',bowman:'Bowman',thief:'Thief'}:{warrior:'战士',magician:'魔法师',bowman:'弓箭手',thief:'飞侠'};
  if(s.job!=='all' && jobs[s.job])tokens.push({key:'job',label:jobs[s.job]});
  const type=equipmentTypes.find(([key])=>key===s.type && key!=='all');
  if(type)tokens.push({key:'type',label:type[en?2:1]});
  if((s.lmin!=null && s.lmin>0)||s.lmax!=null)tokens.push({key:'level',label:`${en?'Lv.':'等级 '}${s.lmin??0}${s.lmax==null?'+':`–${s.lmax}`}`});
  if(!s.few)tokens.push({key:'few',label:en?'5+ sales':'至少 5 笔'});
  if(!s.cash)tokens.push({key:'cash',label:en?'Hide cash items':'隐藏商城物品'});
  if(s.sold)tokens.push({key:'sold',label:en?'With sales':'有成交记录'});
  if(s.drop && dropOk)tokens.push({key:'drop',label:en?'Monster drops':'怪物掉落'});
  if(s.watch)tokens.push({key:'watch',label:en?'Watched only':'只看关注'});
  if(s.craft)tokens.push({key:'craft',label:en?'Craftable':'可制作'});
  return tokens;
}
export function clearPriceFilter(state,key) {
  const defaults={job:'all',type:'all',lmin:null,lmax:null,few:true,cash:true,sold:false,drop:false,watch:false,craft:false};
  if(key==='all')return {...state,...defaults};
  if(key==='everything')return {...state,...defaults,q:'',cat:'all'};
  if(key==='level')return {...state,lmin:null,lmax:null};
  return Object.hasOwn(defaults,key)?{...state,[key]:defaults[key]}:{...state};
}

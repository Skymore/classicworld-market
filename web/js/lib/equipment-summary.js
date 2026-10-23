// Only the specific offer's captured values; never catalogue defaults.
const fields={weapon_attack:['物理攻击','Weapon ATK'],magic_attack:['魔法攻击','Magic ATK'],str:['力量','STR'],dex:['敏捷','DEX'],int:['智力','INT'],luk:['运气','LUK'],weapon_defense:['物理防御','Weapon DEF'],magic_defense:['魔法防御','Magic DEF'],hp:['最大HP','Max HP'],mp:['最大MP','Max MP'],accuracy:['命中','Accuracy'],avoid:['回避','Avoidability'],speed:['移动速度','Speed'],jump:['跳跃力','Jump']};
export function equipmentSummary(row,en=false){
 if(Math.floor(Number(row.item_id)/1000000)!==1)return '';
 const eq=row.equipment;
 if(!eq||eq.status!=='candidate')return en?'Equipment attributes not captured':'未采集到装备具体属性';
 const values=new Map();
 for(const stat of Array.isArray(eq.stats)?eq.stats:[]){
  if(fields[stat?.key]&&Number.isInteger(stat.value)&&stat.value>=0&&stat.value<=65535)values.set(stat.key,stat.value);
 }
 const parts=Object.entries(fields).filter(([key])=>values.get(key)>0).map(([key,label])=>`${label[en?1:0]} +${values.get(key)}`);
 if(!parts.length&&values.size)parts.push(en?'Captured attributes are all 0':'已采集属性均为0');
 if(Number.isInteger(eq.enhancements)&&eq.enhancements>0&&eq.enhancements<=15)parts.push(`${en?'Enhancements':'强化成功'} +${eq.enhancements}`);
 if(Number.isInteger(eq.remaining_upgrades)&&eq.remaining_upgrades>=0&&eq.remaining_upgrades<=15)parts.push(`${en?'Upgrades left':'可升级'} ${eq.remaining_upgrades}`);
 return parts.join(' · ')||(en?'Equipment attributes not captured':'未采集到装备具体属性');
}

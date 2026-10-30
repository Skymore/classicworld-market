// Only the specific offer's captured values; never catalogue defaults.
const fields={weapon_attack:['物攻','Weapon ATK'],magic_attack:['魔攻','Magic ATK'],critical_rate:['暴击率','Critical Rate'],critical_damage:['暴击伤害','Critical Damage'],str:['力','STR'],dex:['敏','DEX'],int:['智','INT'],luk:['运','LUK'],weapon_defense:['物防','Weapon DEF'],magic_defense:['魔防','Magic DEF'],hp:['HP','Max HP'],mp:['MP','Max MP'],accuracy:['命中','Accuracy'],avoid:['回避','Avoidability'],speed:['移速','Speed'],jump:['跳跃','Jump']};
export function equipmentSummary(row,en=false){
 if(Math.floor(Number(row.item_id)/1000000)!==1)return '';
 const eq=row.equipment;
 if(!eq||eq.status!=='candidate')return '';
 const values=new Map();
 for(const stat of Array.isArray(eq.stats)?eq.stats:[]){
  if(fields[stat?.key]&&Number.isInteger(stat.value)&&stat.value>=0&&stat.value<=65535)values.set(stat.key,stat.value);
 }
 const parts=Object.entries(fields).filter(([key])=>values.get(key)>0).map(([key,label])=>`${label[en?1:0]} +${values.get(key)}`);
 if(Number.isInteger(eq.enhancements)&&eq.enhancements>0&&eq.enhancements<=15)parts.push(`${en?'Enhancements':'强化'} +${eq.enhancements}`);
 if(Number.isInteger(eq.remaining_upgrades)&&eq.remaining_upgrades>=0&&eq.remaining_upgrades<=15&&(parts.length||eq.remaining_upgrades>0))parts.push(`${en?'Upgrades left':'可升'} ${eq.remaining_upgrades}`);
 return parts.join(' · ');
}

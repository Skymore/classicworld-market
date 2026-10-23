export function mergeBag(existing, imported) {
  const rows=Array.isArray(imported)?imported:imported?.items;
  if(!Array.isArray(rows)||rows.length>10000) throw new Error('Invalid inventory file');
  const keys=new Set(existing.map(r=>`${r.world}:${r.item_id}`));
  const result=[...existing]; let skipped=0;
  for(const r of rows) {
    if(!r || !Number.isSafeInteger(r.item_id)||r.item_id<=0||typeof r.world!=='string'||!r.world||r.world.length>120
      ||!['quantity','reserve','bundle','groups'].every(k=>Number.isSafeInteger(r[k])&&r[k]>=(['bundle','groups'].includes(k)?1:0))
      || !Number.isFinite(r.minimum_unit_price)||r.minimum_unit_price<0||!['fast','normal','median'].includes(r.strategy)) throw new Error('Invalid inventory row');
    const key=`${r.world}:${r.item_id}`;
    if(keys.has(key)){skipped++;continue;}
    result.push({item_id:r.item_id,world:r.world,quantity:r.quantity,reserve:r.reserve,bundle:r.bundle,groups:r.groups,strategy:r.strategy,minimum_unit_price:r.minimum_unit_price,selected:!!r.selected});keys.add(key);
  }
  return {items:result,skipped};
}

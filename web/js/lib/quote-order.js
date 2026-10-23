export function quoteTime(value){return typeof value==='number'&&Number.isFinite(value)&&value>0?value:null;}
export function compareQuotes(a,b,latest=false){
 const at=quoteTime(a.observed),bt=quoteTime(b.observed);
 if(latest){if(at===null&&bt!==null)return 1;if(bt===null&&at!==null)return -1;if(at!==bt)return (bt||0)-(at||0);}
 const price=a.price-b.price;
 return price||((bt||0)-(at||0))||String(a.key||'').localeCompare(String(b.key||''));
}
export function sortWatchQuotes(rows,mode='price'){
 return [...rows].sort((a,b)=>compareQuotes(
  {observed:a.observed,price:a.unit_price,key:a.id},
  {observed:b.observed,price:b.unit_price,key:b.id},mode==='recent'));
}

let bound=false;
export function bindImageStates() {
  if(bound)return;bound=true;
  const update=img=>{
    const box=img.parentElement;
    if(!box?.matches('.slot,.mobpic'))return;
    const ok=img.complete&&img.naturalWidth>0;
    box.classList.toggle('image-pending',!img.complete);
    box.classList.toggle('image-missing',img.complete&&!ok);
    box.title=ok?'':document.documentElement.dataset.lang==='en'?(img.complete?'Image unavailable':'Loading image…'):(img.complete?'图片暂不可用':'图片加载中…');
  };
  for(const img of document.images)update(img);
  document.addEventListener('load',e=>{if(e.target.tagName==='IMG')update(e.target);},true);
  document.addEventListener('error',e=>{if(e.target.tagName==='IMG')update(e.target);},true);
  new MutationObserver(records=>{for(const r of records)for(const n of r.addedNodes){if(n.nodeType!==1)continue;if(n.tagName==='IMG')update(n);for(const img of n.querySelectorAll('img'))update(img);}}).observe(document.body,{childList:true,subtree:true});
}

import {readPeriod} from './period.js?v=20261022-regressions-1';
import {refreshTimes} from './time.js';
import {trapFocus} from './dialog.js';

export function previewPosition(anchor, box, viewport) {
  const gap=12, margin=12;
  // Wide table/list rows span the page: place the card beside the item-name
  // area rather than treating the far-right edge as its hover anchor.
  const right=Math.min(anchor.right,anchor.left+300)+gap;
  const left=right+box.width<=viewport.width-margin ? right : anchor.left-gap-box.width;
  return {left:Math.max(margin,Math.min(left,viewport.width-box.width-margin)),top:Math.max(margin,Math.min(anchor.top,viewport.height-box.height-margin))};
}

export function previewItem(target, origin) {
  const anchor=target.closest('a[href],tr[data-open]');
  if(!anchor || anchor.closest('.item-peek') || anchor.hasAttribute('data-no-preview'))return null;
  if(anchor.matches('tr[data-open]'))return /^\d+$/.test(anchor.dataset.open)?{anchor,id:Number(anchor.dataset.open)}:null;
  let url;try {url=new URL(anchor.href,origin);}catch{return null;}
  const match=url.origin===origin && /^\/item\/(\d+)$/.exec(url.pathname);
  if(url.searchParams.has('variant'))return null;
  return match?{anchor,id:Number(match[1])}:null;
}

function bindItemPreviews() {
  if(document.documentElement.dataset.itemPreviews)return;
  document.documentElement.dataset.itemPreviews='1';
  const css=Object.assign(document.createElement('link'),{rel:'stylesheet',href:'/web/css/item-preview.css?v=20261021-item-preview-3'});
  document.head.append(css);
  const popup=document.createElement('aside');
  popup.id='item-quick-preview';popup.className='item-peek';popup.hidden=true;
  popup.setAttribute('role','dialog');
  const en=()=>document.documentElement.lang.startsWith('en');
  const words=(zh,english)=>en()?english:zh;
  const scrim=Object.assign(document.createElement('div'),{className:'peek-scrim',hidden:true});
  document.body.append(scrim,popup);
  let active=null, controller=null, revision=0, timer=null, leaveTimer=null, mobile=false, pinned=false, restoring=false;
  const cache=new Map();
  function position() {
    if(mobile || !active)return;
    if(active.anchor.isConnected)active.rect=active.anchor.getBoundingClientRect();
    const pos=previewPosition(active.rect,popup.getBoundingClientRect(),{width:innerWidth,height:innerHeight});
    // CSSOM positioning is permitted by the site's CSP; no HTML style strings.
    popup.style.left=`${pos.left}px`;popup.style.top=`${pos.top}px`;
  }
  function close(restore=false) {
    clearTimeout(timer);clearTimeout(leaveTimer);controller?.abort();revision++;
    popup.hidden=true;scrim.hidden=true;
    if(active) {
      active.anchor.removeAttribute('aria-controls');active.anchor.removeAttribute('aria-expanded');
      if(restore){
        const target=active.anchor.isConnected?active.anchor:active.scope;
        if(target.isConnected){
          const temporaryTabIndex=!target.hasAttribute('tabindex') && target===active.scope;
          if(temporaryTabIndex)target.setAttribute('tabindex','-1');
          restoring=true;target.focus({preventScroll:true});restoring=false;
          if(temporaryTabIndex)target.removeAttribute('tabindex');
        }
      }
    }
    active=null;
  }
  function content(node) {
    const button=document.createElement('button');button.type='button';button.className='peek-close';
    button.setAttribute('aria-label',words('关闭预览','Close preview'));button.textContent='×';
    button.addEventListener('click',()=>close(true));
    popup.replaceChildren(button,node);
    popup.querySelector('h2')?.setAttribute('id','item-preview-name');
    popup.setAttribute('aria-labelledby','item-preview-name');
    refreshTimes(popup);position();
  }
  async function open(hit,touch=false,focus=false) {
    clearTimeout(timer);clearTimeout(leaveTimer);
    if(active?.anchor===hit.anchor && !popup.hidden){if(focus)popup.querySelector('button')?.focus();return;}
    close();active={...hit,scope:hit.anchor.closest('main') || document.body,rect:hit.anchor.getBoundingClientRect()};mobile=touch;pinned=touch||focus;
    const mine=++revision;
    popup.classList.toggle('is-mobile',mobile);
    popup.style.removeProperty('left');popup.style.removeProperty('top');
    popup.setAttribute('aria-modal',String(mobile));
    popup.setAttribute('aria-label',words('物品快速预览','Quick item preview'));
    hit.anchor.setAttribute('aria-controls',popup.id);hit.anchor.setAttribute('aria-expanded','true');
    const loading=document.createElement('div');loading.className='peek-loading';
    const heading=document.createElement('h2');heading.textContent=words('正在读取物品…','Loading item…');loading.append(heading);
    popup.hidden=false;scrim.hidden=!mobile;content(loading);
    if(touch||focus)popup.querySelector('button')?.focus();
    const url=new URL(`/item/${hit.id}`,location.origin);
    url.searchParams.set('part','preview');url.searchParams.set('hours',readPeriod());
    if(en())url.searchParams.set('lang','en');
    controller=new AbortController();
    const key=url.pathname+url.search;
    try {
      let html;
      const cached=cache.get(key);
      if(cached && Date.now()-cached.time<30000)html=cached.html;
      else {
        const response=await fetch(key,{signal:controller.signal,credentials:'same-origin'});
        if(!response.ok)throw new Error('Preview unavailable');
        html=await response.text();
      }
      if(mine!==revision)return;
      const node=new DOMParser().parseFromString(html,'text/html').querySelector(`.peek-content[data-preview-item="${hit.id}"]`);
      if(!node)throw new Error('Invalid preview');
      const time=cached && Date.now()-cached.time<30000 ? cached.time : Date.now();
      cache.delete(key);cache.set(key,{html,time});
      while(cache.size>32)cache.delete(cache.keys().next().value);
      const hadFocus=popup.contains(document.activeElement);
      content(document.importNode(node,true));
      if(hadFocus)popup.querySelector('button')?.focus();
    } catch(error) {
      if(mine!==revision || error.name==='AbortError')return;
      const box=document.createElement('div');box.className='peek-loading';
      const heading=document.createElement('h2');heading.textContent=words('预览暂不可用','Preview unavailable');
      const link=document.createElement('a');url.searchParams.delete('part');link.href=url.pathname+url.search;
      link.textContent=words('打开完整详情 →','Open full details →');box.append(heading,link);content(box);
      if(touch||focus)popup.querySelector('button')?.focus();
    }
  }
  document.addEventListener('pointerover',e=>{
    if(e.pointerType==='touch' || innerWidth<=640)return;
    if(popup.contains(e.target)){clearTimeout(leaveTimer);return;}
    if(e.target.closest('button,input,select'))return;
    const hit=previewItem(e.target,location.origin);
    if(!hit)return;
    clearTimeout(timer);clearTimeout(leaveTimer);
    timer=setTimeout(()=>open(hit),180);
  });
  document.addEventListener('pointerout',e=>{
    if(pinned)return;
    const hit=previewItem(e.target,location.origin);
    if(hit?.anchor.contains(e.relatedTarget) || popup.contains(e.relatedTarget))return;
    clearTimeout(timer);clearTimeout(leaveTimer);
    if(active)leaveTimer=setTimeout(()=>close(),180);
  });
  document.addEventListener('focusin',e=>{
    if(restoring)return;
    if(popup.contains(e.target)){clearTimeout(leaveTimer);return;}
    if(e.target.closest('button,input,select'))return;
    const hit=previewItem(e.target,location.origin);
    if(hit){clearTimeout(timer);timer=setTimeout(()=>open(hit),180);}else if(!pinned)close();
  });
  document.addEventListener('click',e=>{
    if(popup.contains(e.target))return;
    const hit=!e.target.closest('button,input,select') && previewItem(e.target,location.origin);
    if(hit && e.detail>0 && !e.metaKey && !e.ctrlKey && !e.shiftKey && !e.altKey && (innerWidth<=640 || matchMedia('(pointer:coarse)').matches)) {
      e.preventDefault();e.stopPropagation();open(hit,true);return;
    }
    close();
  },true);
  document.addEventListener('keydown',e=>{
    if(e.altKey && e.key==='ArrowDown') {
      const hit=previewItem(e.target,location.origin);
      if(hit){e.preventDefault();e.stopPropagation();open(hit,innerWidth<=640,true);return;}
    }
    if(popup.hidden)return;
    if(e.key==='Escape'){e.preventDefault();e.stopPropagation();close(popup.contains(document.activeElement));}
    else if(e.key==='Tab' && mobile)trapFocus(popup,e);
  },true);
  document.addEventListener('scroll',e=>{if(!popup.hidden && !popup.contains(e.target)){if(!pinned)close();else position();}},true);
  // Mobile browser chrome changes the viewport height while reading. CSS keeps
  // the sheet within that viewport; a resize is not a request to dismiss it.
  addEventListener('resize',()=>position());addEventListener('popstate',()=>close());
  new MutationObserver(()=>{
    if(!active)return;
    // Navigation replaces <main>. A live list render only replaces its rows.
    if(!active.scope.isConnected){close();return;}
    if(active.anchor.isConnected)return;
    const replacement=[...active.scope.querySelectorAll('a[href],tr[data-open]')]
      .find(el=>previewItem(el,location.origin)?.id===active.id);
    if(replacement){
      active.anchor.removeAttribute('aria-controls');active.anchor.removeAttribute('aria-expanded');
      active.anchor=replacement;
      replacement.setAttribute('aria-controls',popup.id);replacement.setAttribute('aria-expanded','true');
    }else if(!pinned){close();}
    // A tapped/keyboard-opened preview belongs to the selected item, even if it
    // drops out of recent sales. Keep its content, request, focus and scroll.
  }).observe(document.body,{childList:true,subtree:true});
}
if(typeof document!=='undefined')bindItemPreviews();

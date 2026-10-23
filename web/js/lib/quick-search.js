// Instant cross-catalogue search shared by every header and the home page.
let serial = 0;
import { bindImageStates } from './image-state.js';
export function bindQuickSearch(root = document) {
  bindImageStates();
  const cleanups = [];
  for (const form of root.querySelectorAll('form.finder[action]')) {
    if (form.classList.contains('in-page') || form.dataset.quickSearch) continue;
    const input = form.querySelector('input[name=q]');
    if (!input || new URL(form.action, location.href).pathname !== '/search') continue;
    form.dataset.quickSearch = '1';
    const en = document.documentElement.dataset.lang === 'en';
    const words = en ? { loading:'Searching…', empty:'No matching results', failed:'Search unavailable. Try again or open all results.', all:'Browse all results', item:'Item', mob:'Monster', map:'Map' }
      : { loading:'正在搜索…', empty:'没有匹配结果', failed:'搜索暂不可用，可重试或打开全部结果。', all:'查看全部结果', item:'物品', mob:'怪物', map:'地图' };
    const box = document.createElement('div');
    box.className = 'quick-search'; box.id = `quick-search-${++serial}`; box.hidden = true;
    box.setAttribute('role','region'); box.setAttribute('aria-label',en ? 'Search results' : '搜索结果');
    form.append(box); form.classList.add('has-quick-search');
    input.autocomplete = 'off'; input.setAttribute('aria-controls',box.id); input.setAttribute('aria-expanded','false');
    let timer, controller, revision=0, composing=false, stopped=false;
    const urlFor = () => { const url=new URL(form.action,location.href); url.searchParams.set('q',input.value.trim()); if(en) url.searchParams.set('lang','en'); return url; };
    const close = () => { clearTimeout(timer); revision++; controller?.abort(); box.hidden=true; input.setAttribute('aria-expanded','false'); };
    const show = () => { box.hidden=false; input.setAttribute('aria-expanded','true'); };
    const note = (text) => { const p=document.createElement('p'); p.className='quick-note'; p.setAttribute('role','status'); p.textContent=text; box.replaceChildren(p); };
    const more = (url) => { const a=document.createElement('a'); a.className='quick-more'; a.href=url.href; a.textContent=words.all+' →'; box.append(a); };
    async function update() {
      const mine=++revision; controller?.abort(); controller=new AbortController();
      const url=urlFor(); show(); note(words.loading); box.setAttribute('aria-busy','true');
      try {
        // The private bag planner proxies this read through its own origin.
        const endpoint=url.origin===location.origin ? url : new URL('/api/v1/search-preview'+url.search,location.origin);
        const res=await fetch(endpoint,{signal:controller.signal,cache:'no-store',credentials:'same-origin'});
        if(!res.ok) throw new Error('search unavailable');
        const page=new DOMParser().parseFromString(await res.text(),'text/html');
        if(stopped || mine!==revision) return;
        const rows=[...page.querySelectorAll('[data-search-results] a.drow')];
        box.replaceChildren();
        const selected=['item','mob','map'].flatMap(kind=>rows.filter(row=>new URL(row.getAttribute('href'),url).pathname.split('/')[1]===kind).slice(0,2));
        for(const row of selected) {
          const href=new URL(row.getAttribute('href'),url);
          const kind=href.pathname.split('/')[1];
          if(!['item','mob','map'].includes(kind)) continue;
          const a=document.createElement('a'); a.href=href.href; a.className='quick-row';
          const pic=row.querySelector('img');
          if(pic) { const img=document.createElement('img'); img.src=pic.getAttribute('src'); img.alt=''; img.width=28; img.height=28; img.loading='lazy'; a.append(img); }
          else { const glyph=document.createElement('span'); glyph.className='quick-glyph'; glyph.textContent='◇'; a.append(glyph); }
          const names=document.createElement('span'); names.className='quick-names';
          const b=document.createElement('b'); b.textContent=row.querySelector('.t b')?.textContent || row.textContent.trim(); names.append(b);
          const secondary=row.querySelector('.name-secondary, .t .s');
          if(secondary) { const small=document.createElement('small'); small.textContent=secondary.textContent; names.append(small); }
          a.append(names); const tag=document.createElement('small'); tag.className='quick-kind'; tag.textContent=words[kind]; a.append(tag); box.append(a);
        }
        if(!box.childElementCount) note(words.empty);
        more(url);
      } catch(error) { if(error.name!=='AbortError' && mine===revision && !stopped) { note(words.failed); more(url); } }
      finally { if(mine===revision) box.removeAttribute('aria-busy'); }
    }
    const schedule=() => { clearTimeout(timer); revision++; controller?.abort(); if(!composing) { show(); note(words.loading); timer=setTimeout(update,200); } };
    const startComposition=() => { composing=true; clearTimeout(timer); revision++; controller?.abort(); };
    const endComposition=() => { composing=false; schedule(); };
    const onKey=(event) => { if(event.isComposing) return; if(event.key==='Escape') { event.preventDefault(); close(); } if(event.key==='ArrowDown' && !box.hidden) { event.preventDefault(); box.querySelector('a')?.focus(); } };
    const outside=(event) => { if(!form.contains(event.target)) close(); };
    const outFocus=() => { setTimeout(() => { if(!form.contains(document.activeElement)) close(); },0); };
    input.addEventListener('input',schedule); input.addEventListener('focus',schedule);
    input.addEventListener('compositionstart',startComposition); input.addEventListener('compositionend',endComposition);
    form.addEventListener('keydown',onKey); form.addEventListener('focusout',outFocus); document.addEventListener('pointerdown',outside); document.addEventListener('click',outside);
    cleanups.push(() => { stopped=true; close(); input.removeEventListener('input',schedule); input.removeEventListener('focus',schedule); input.removeEventListener('compositionstart',startComposition); input.removeEventListener('compositionend',endComposition); form.removeEventListener('keydown',onKey); form.removeEventListener('focusout',outFocus); document.removeEventListener('pointerdown',outside); document.removeEventListener('click',outside); box.remove(); delete form.dataset.quickSearch; });
  }
  return () => cleanups.forEach(fn=>fn());
}

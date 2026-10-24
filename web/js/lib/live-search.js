// Keep the input and IME composition intact while replacing only search results.
export function bindLiveSearch() {
  const form = document.querySelector('form.finder.in-page');
  const input = form?.querySelector('input[name=q]');
  const results = document.querySelector('[data-search-results]');
  if (!input || !results) return;
  let browseKind = form.querySelector('[name=kind]')?.value || new URLSearchParams(location.search).get('kind') || 'item';
  let timer, controller, revision = 0, composing = false;
  let keyboardInteraction = false;
  results.addEventListener('keydown', () => { keyboardInteraction = true; });
  results.addEventListener('pointerdown', () => { keyboardInteraction = false; }, { passive: true });
  const pages=new Map(), warming=new Map();
  const cacheKey=url=>{
    const key=new URL(url,location.href);
    for(const [name,value] of [...key.searchParams]) if(value===''||(name==='page'&&value==='1')||(name==='job'&&value==='0')) key.searchParams.delete(name);
    key.searchParams.sort();return key.href;
  };
  function remember(url,html) {
    const key=cacheKey(url);pages.delete(key);pages.set(key,{html,time:Date.now()});
    while(pages.size>8) pages.delete(pages.keys().next().value);
  }
  function cached(url) {const hit=pages.get(cacheKey(url));return hit&&Date.now()-hit.time<30000?hit.html:null;}
  remember(location.href,document.documentElement.outerHTML);
  async function readPage(url,signal) {
    const hit=cached(url);if(hit)return hit;
    const pending=warming.get(cacheKey(url));if(pending)return pending;
    const response=await fetch(url,{signal,cache:'no-store'});
    if(!response.ok) throw new Error(`HTTP ${response.status}`);
    const html=await response.text();remember(url,html);return html;
  }
  function navigationUrl(event) {
    const link=event.target.closest('nav.kinds a[href]');if(!link||!results.contains(link))return null;
    const url=new URL(link.href,location.href);
    return url.origin===location.origin&&url.pathname==='/search'&&!url.hash?url:null;
  }
  function warm(event) {
    const url=navigationUrl(event);if(!url||cached(url)||warming.has(cacheKey(url))||warming.size>=2)return;
    const key=cacheKey(url);
    const pending=readPage(url).finally(()=>warming.delete(key));warming.set(key,pending);
    pending.catch(()=>{});
  }
  results.addEventListener('pointerover',warm,{passive:true});
  results.addEventListener('pointerdown',warm,{passive:true});
  results.addEventListener('focusin',warm);
  function summarize() {
    const tools=document.querySelector('.catalogue-tools');
    const summary=tools?.querySelector('[data-filter-summary]');
    if(!summary) return;
    const job=tools.querySelector('[name=job]');
    const lo=tools.querySelector('[name=min_level]').value;
    const hi=tools.querySelector('[name=max_level]').value;
    const labels=[];
    if(job.value!=='0') labels.push(job.selectedOptions[0].textContent);
    if(lo||hi) labels.push(`Lv.${lo||0}–${hi||'∞'}`);
    summary.textContent=labels.length ? ` (${labels.length})` : '';
    summary.parentElement.title=labels.join(' · ');
  }
  summarize();
  async function update(destination=null,{navigation=false,historyMode='replace'}={}) {
    const mine = ++revision;
    controller?.abort();
    controller = new AbortController();
    const url = new URL(destination||form.action, location.href);
    if(!destination) {
    const fields=new URLSearchParams(new FormData(form));
    for(const key of ['min_level','max_level']) {
      if(!fields.get(key)) fields.delete(key);
      else fields.set(key,String(Math.max(0,Math.min(300,Math.trunc(Number(fields.get(key)))||0))));
    }
    if(fields.has('min_level')&&fields.has('max_level')&&Number(fields.get('min_level'))>Number(fields.get('max_level'))) {
      const lo=fields.get('max_level');fields.set('max_level',fields.get('min_level'));fields.set('min_level',lo);
    }
    for(const key of ['min_level','max_level']) {const el=document.querySelector(`[form=catalog-search][name=${key}]`);if(el) el.value=fields.get(key)||'';}

    url.search = fields.toString();
    if (input.value.trim()) url.searchParams.delete('kind');
    else url.searchParams.set('kind', browseKind);
    }
    results.setAttribute('aria-busy', 'true');
    results.querySelector('[data-search-error]')?.remove();
    try {
      const page = new DOMParser().parseFromString(await readPage(url,controller.signal), 'text/html');
      const next = page.querySelector('[data-search-results]');
      if (mine !== revision || !next) return;
      const placeFocus=document.activeElement?.closest('.place-tools')?document.activeElement.name:null;
      const currentControls=document.querySelector('.catalogue-tools');
      const nextControls=next.querySelector('.catalogue-tools');
      const focused=currentControls?.contains(document.activeElement)?document.activeElement:null;
      if(!navigation&&currentControls&&nextControls) nextControls.replaceWith(currentControls);
      results.replaceChildren(...next.childNodes);
      if(navigation) {
        input.value=url.searchParams.get('q')||'';
        const kind=url.searchParams.get('kind');
        if(['item','mob','map'].includes(kind)) {
          browseKind=kind;
          let hidden=form.querySelector('[name=kind]');
          if(!hidden){hidden=document.createElement('input');hidden.type='hidden';hidden.name='kind';form.append(hidden);}
          hidden.value=kind;
        }
      }
      summarize();
      // Focusing a native select after its results refresh can reopen the
      // picker on iOS. Restore selects only for keyboard navigation; text
      // fields still retain their caret while typing or composing.
      if(focused?.isConnected && (focused.tagName !== 'SELECT' || keyboardInteraction)) focused.focus({preventScroll:true});
      if(placeFocus && keyboardInteraction) results.querySelector(`.place-tools [name=${placeFocus}]`)?.focus({preventScroll:true});
      if(historyMode==='push') history.pushState(null,'',url);
      else if(historyMode!=='none') history.replaceState(null, '', url);
      document.title = page.title;
      for (const link of document.querySelectorAll('a[data-lang-toggle]')) {
        const translated = new URL(url);
        translated.searchParams.set('lang', link.dataset.langToggle);
        link.href = translated;
      }
      if(navigation&&historyMode==='push') window.scrollTo(0,0);
    } catch (error) {
      if (error.name !== 'AbortError' && mine === revision) {
        const notice = document.createElement('p');
        notice.className = 'note'; notice.setAttribute('role', 'alert');
        notice.dataset.searchError='1';
        notice.textContent = document.documentElement.dataset.lang === 'en'
          ? 'Search failed. Press Enter to retry.' : '搜索暂不可用，按回车重试。';
        results.prepend(notice);
      }
    } finally { if (mine === revision) results.removeAttribute('aria-busy'); }
  }
  const schedule = () => {
    summarize();
    clearTimeout(timer);
    // Invalidate in-flight answers immediately, including while composing.
    revision++; controller?.abort();
    if (!composing) timer = setTimeout(update, 200);
  };
  input.addEventListener('compositionstart', () => { composing = true; schedule(); });
  input.addEventListener('compositionend', () => { composing = false; schedule(); });
  input.addEventListener('input', schedule);
  const controls=()=>document.querySelector('.catalogue-tools');
  const fields=()=>Object.fromEntries([...(controls()?.querySelectorAll('select,input[type=number]')||[])].map(el=>[el.name,el]));
  const equip=()=>{const radio=controls()?.querySelector('[name=cat][value=equip]');if(radio) radio.checked=true;};
  const clearEquipment=()=>{for(const el of Object.values(fields())) el.value=el.name==='job'?'0':'';};
  results.addEventListener('change',event=>{
    if(event.target.closest('.place-tools')) {
      if(event.target.name==='region') {
        const area=results.querySelector('.place-tools [name=area]');area.value='';area.disabled=true;
      }
      schedule();return;
    }
    if(!event.target.closest('.catalogue-tools')) return;
    if(event.target.name==='cat') {if(event.target.value!=='equip') clearEquipment();}
    else if(event.target.name==='job'||/level/.test(event.target.name)) equip();
    schedule();
  });
  results.addEventListener('input',event=>{if(event.target.closest('.catalogue-tools')&&event.target.type==='number'){equip();schedule();}});
  results.addEventListener('click',event=>{
    const target=navigationUrl(event);
    if(target && event.button===0 && !event.defaultPrevented && !event.ctrlKey&&!event.metaKey&&!event.shiftKey&&!event.altKey) {
      event.preventDefault();clearTimeout(timer);
      if(target.href!==location.href) update(target,{navigation:true,historyMode:'push'});
      return;
    }
    if(event.target.closest('[data-place-reset]')) {
      for(const el of results.querySelectorAll('.place-tools select')) el.value='';
      schedule();return;
    }
    const preset=event.target.closest('[data-catalog-levels]');
    if(preset){const [lo,hi]=preset.dataset.catalogLevels.split(',');const f=fields();f.min_level.value=lo;f.max_level.value=hi;equip();schedule();}
    if(event.target.closest('[data-catalog-reset]')){clearEquipment();controls().querySelector('[name=cat][value=""]').checked=true;schedule();}
  });

  form.addEventListener('submit', (event) => { event.preventDefault(); clearTimeout(timer); update(); });
  addEventListener('popstate',()=>{if(location.pathname==='/search'){clearTimeout(timer);update(location.href,{navigation:true,historyMode:'none'});}});
}

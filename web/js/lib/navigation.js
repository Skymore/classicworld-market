import { lang } from './i18n.js';
import { I } from './icons.js';
export const NAVIGATION = [
  ['home','/','首页','Home',I.home],
  ['prices','/prices','价格表','Prices',I.tag],
  ['dex','/search?kind=item','图鉴','Catalogue',I.book],
  ['watch','/watch','关注','Watch',I.star],
  ['alerts','/alerts','捡漏','Deals',I.coin],
];
let accountState,accountRequest;
function accountLabels(){
  for(const link of document.querySelectorAll('[data-account-link]')){
    const label=accountState?.signed_in?(lang==='en'?'My account':'我的'):(lang==='en'?'Sign in to your account':'登录账号');
    link.innerHTML='<span class="pref-glyph pref-account" aria-hidden="true"></span>';
    link.setAttribute('aria-label',label);
    link.title=label;
  }
}
window.addEventListener('account-changed',e=>{accountState=e.detail;accountLabels();});
export function renderSiteNavigation(root, active) {
  for(const prefs of root.querySelectorAll('.prefs')) {
    if(prefs.querySelector('[data-account-link]'))continue;
    const link=document.createElement('a');link.href='/account';link.className='iconbtn account-link';link.dataset.accountLink='';
    prefs.append(link);
  }
  accountLabels();
  if(!accountRequest)accountRequest=fetch('/api/v1/account',{cache:'no-store'}).then(r=>r.ok?r.json():null).then(data=>{if(data)accountState=data;accountLabels();}).catch(()=>{});
  const path=location.pathname;
  active=active || (path.startsWith('/selling')?'selling':path.startsWith('/prices')||path.startsWith('/sales')?'prices':path.startsWith('/watch')?'watch':path.startsWith('/alerts')?'alerts':path==='/'?'home':'dex');
  for(const nav of root.querySelectorAll('.dnav,.dock')) {
    const dock=nav.classList.contains('dock');
    nav.innerHTML=NAVIGATION.map(([key,href,zh,en,icon])=>{
      const url=new URL(href,location.href);
      if(key==='dex'&&lang==='en') url.searchParams.set('lang','en');
      return `<a href="${url.pathname+url.search}" data-nav-key="${key}" class="${key===active?'on':''}" ${key===active?'aria-current="page"':''}>${dock?icon:''}<span>${lang==='en'?en:zh}</span>${dock?`<span class="badge" data-badge="${key}" hidden></span>`:''}</a>`;
    }).join('');
  }
}

import { lang } from '../lib/i18n.js';
import { esc,num } from '../lib/format.js';
import { live } from '../lib/api.js?v=20261022-auto-watch-2';
const say=(zh,en)=>lang==='en'?en:zh;
export function mount(main){
  let stop=null,period='week';
  main.innerHTML=`<section class="stall contributors"><div class="stall-bar"><h1>${say('采集贡献榜','Contributors')}</h1><a class="bar-more" href="/account">${say('我的贡献','My profile')} →</a></div>
    <div class="account-body"><h2>${say('谢谢每一位逛市场的人','Thanks to everyone exploring the market')}</h2><p>${say('你打开的每一个摊位，都在帮大家找到更好的价格。','Every shop you visit helps others find better prices.')}</p>
    <div class="contributor-tools"><div class="tabs" role="tablist" aria-label="${say('排行范围','Ranking period')}">${[['week','近 7 天','7 days'],['month','近 30 天','30 days'],['all','累计','All time']].map(([k,zh,en])=>`<button role="tab" data-board="${k}" aria-selected="${k==='week'}" class="tab ${k==='week'?'on':''}">${say(zh,en)}</button>`).join('')}</div><a class="btn" href="/account">${say('设置昵称 · 加入榜单','Choose a nickname · Join')} →</a></div>
    <div data-board-results role="tabpanel" aria-live="polite"></div>
    <p class="note">${say('按不同摊位数排名，同一人重复打开同一摊位不重复加分。报价条目按商品、价格和库存去重；未设置昵称的采集者使用随机临时昵称，可在「我的」修改或退出榜单。','Ranked by distinct shops. Reopening the same shop does not increase your rank. Identical item, price and stock entries are counted once. Collectors without a chosen name get a random temporary nickname. Change it or leave the board under My profile.')}</p></div></section>`;
  const results=main.querySelector('[data-board-results]');
  function load(){stop?.();results.textContent=say('正在加载…','Loading…');
    stop=live('/api/v1/contributors?period='+period,data=>{
      if(!data.contributors.length){results.innerHTML=`<div class="contributor-empty"><h3>${say('这张榜单，等你上榜','Be the first on the board')}</h3><p>${say('设置昵称并公开贡献后，已有的有效采集记录也会计入。','Choose a nickname and opt in. Your earlier valid contributions count too.')}</p></div>`;return;}
      results.innerHTML=`<div class="board-head"><span>#</span><span>${say('采集者','Contributor')}</span><span>${say('摊位','Shops')}</span><span>${say('报价条目','Offers')}</span></div><ol class="board-list">${data.contributors.map((r,i)=>`<li class="board-row"><span class="board-rank ${i<3?'podium':''}">${i+1}</span><span class="board-person"><b>${esc(r.nickname)}</b><small>${say(`活跃 ${r.days} 天`,`${r.days} active days`)}</small></span><strong>${num(r.shops)}</strong><span>${num(r.quotes)}</span></li>`).join('')}</ol>`;
    },{onError:()=>{results.innerHTML=`<p role="alert">${say('暂时无法加载，正在重新连接。','Could not load the board. Reconnecting.')}</p>`;}});
  }
  main.addEventListener('click',e=>{const b=e.target.closest('[data-board]');if(!b||b.dataset.board===period)return;period=b.dataset.board;for(const t of main.querySelectorAll('[data-board]')){const on=t===b;t.classList.toggle('on',on);t.setAttribute('aria-selected',String(on));}load();});
  load();return()=>stop?.();
}

import { lang } from '../lib/i18n.js';
import { esc,num } from '../lib/format.js';
const say=(zh,en)=>lang==='en'?en:zh;
const errors={invalid_nickname:['昵称需要 2–24 个字，可用中文、字母、数字、空格和 _-.。','Use 2–24 letters, numbers, spaces or _-. for your nickname.'],
  expired_link:['绑定链接已过期，请在采集器中重新点击绑定。','This link expired. Start linking again in the collector.'],
  already_linked:['这个采集器已经绑定了其他账号。','This collector belongs to another account.'],
  manage_on_website:['请在官网的「我的」中修改昵称。','Edit your nickname on the website under My profile.'],
  login_failed:['登录未完成，请重试。','Sign-in did not finish. Please try again.'],
  google_unavailable:['Google 登录暂未开放。你仍可在采集器中设置昵称。','Google sign-in is not available yet. You can still set a nickname in the collector.']};
function message(code){return say(...(errors[code]||['暂时没有连接成功，请稍后重试。','Could not connect. Please try again.']));}
export async function mount(main){
  let stopped=false,profile,controller=new AbortController();
  const params=new URLSearchParams(location.search);let link=params.get('link');
  main.innerHTML=`<section class="stall account-stall"><div class="stall-bar"><h1>${say('我的','My profile')}</h1><a class="bar-more" href="/contributors">${say('采集贡献榜','Contributors')} →</a></div><div class="account-body" data-account><p role="status">${say('正在加载…','Loading…')}</p></div></section>`;
  const box=main.querySelector('[data-account]');
  async function load(){
    try{
      const res=await fetch('/api/v1/account',{cache:'no-store',signal:controller.signal});
      if(!res.ok)throw new Error('unavailable');profile=await res.json();if(stopped)return;window.dispatchEvent(new CustomEvent('account-changed',{detail:profile}));render();
    }catch(e){if(!stopped){box.innerHTML=`<p role="alert">${esc(message(e.message))}</p><button data-retry>${say('重试','Retry')}</button>`;}}
  }
  function render(){
    const local=profile.mode==='collector';
    const google='/auth/google/start'+(link?'?link='+encodeURIComponent(link):'');
    if(!profile.signed_in){
      box.innerHTML=`<h2>${say('让每一次逛摊都有你的名字','Put your name behind every market visit')}</h2><p>${say('设置昵称、绑定采集器，看看你为大家发现了多少摊位和报价。','Choose a nickname, link your collector and see how many shops and offers you have contributed.')}</p>
        ${profile.google_enabled?`<a class="btn google-signin" href="${google}"><span aria-hidden="true">G</span>${say('使用 Google 登录','Sign in with Google')}</a>`:`<p class="note">${esc(message('google_unavailable'))}</p>`}
        <p class="note"><a href="/privacy">${say('账号隐私说明','Account privacy')}</a></p>
        ${params.has('error')?`<p role="alert">${esc(message(params.get('error')))}</p>`:''}
        <section class="well account-help"><h3>${say('只想用昵称？也可以','Prefer just a nickname?')}</h3><p>${say('打开 Windows 采集器，点网页右上角的头像图标进入「我的」，输入昵称即可。已有采集记录会自动计入。','Open the Windows collector, select the profile icon at the top right, and enter a nickname. Your earlier contributions will count too.')}</p><a href="/web/download.html">${say('下载采集器与使用说明','Download collector & instructions')} →</a></section>`;return;
    }
    box.innerHTML=`<h2>${say('你的采集名片','Your contributor profile')}</h2><p>${say('用昵称加入贡献榜，感谢你帮大家发现价格。','Join the contributor board with a nickname. Thanks for helping everyone discover prices.')}</p>
      <div class="contributor-stats"><div><strong>${num(profile.stats?.shops||0)}</strong><span>${say('累计采集摊位','Shops contributed')}</span></div><div><strong>${num(profile.stats?.quotes||0)}</strong><span>${say('有效报价条目','Distinct offers')}</span></div></div>
      <form data-profile><label for="contributor-nickname">${say('昵称','Nickname')}${profile.temporary?' · '+say('临时昵称','Temporary nickname'):''}</label><input id="contributor-nickname" name="nickname" required minlength="2" maxlength="24" autocomplete="nickname" value="${esc(profile.nickname||'')}" placeholder="${say('大家怎么称呼你？','What should we call you?')}" ${local&&profile.linked?'disabled':''}>
      ${profile.temporary?`<p class="note">${say('这是随机分配给你的固定昵称，可以改成自己喜欢的名字。','This randomly assigned nickname stays the same until you choose your own.')}</p>`:''}
      <label class="account-opt"><input type="checkbox" name="listed" ${profile.listed?'checked':''} ${local&&profile.linked?'disabled':''}>${say('在贡献榜公开我的昵称和采集成绩','Show my nickname and contributions on the leaderboard')}</label>
      ${local&&profile.linked?`<a class="btn" href="https://mxd.ruit.me/account" target="_blank" rel="noopener">${say('去官网修改','Edit on website')} ↗</a>`:`<button class="btn primary" type="submit">${say('保存昵称','Save nickname')}</button>`}
      <p class="account-status" role="status" aria-live="polite"></p></form>
      <section class="well account-help"><h3>${say('我的采集器','My collectors')}</h3>
      ${local?(profile.linked?`<p>${say('已绑定 Google 账号，历史贡献已合并。','Linked to your Google account. Earlier contributions are included.')}</p>`:
        `<p>${say('这台采集器的历史记录会归到你的昵称下。绑定 Google 后，可以把不同电脑的贡献合在一起。','This collector’s history counts toward your nickname. Link Google to combine contributions from multiple computers.')}</p>${profile.google_enabled?`<button class="btn" data-connect>${say('绑定 Google 账号','Link Google account')}</button>`:''}`):
        `<p>${say(`已绑定 ${profile.collectors||0} 个采集器。`,`You have ${profile.collectors||0} linked collectors.`)}</p>${link?`<button class="btn primary" data-claim>${say('确认绑定这台采集器','Confirm linking this collector')}</button><p class="note">${say('绑定后，这台采集器以往和今后的贡献都会计入你的账号。','This collector’s past and future contributions will belong to your account.')}</p>`:`<p>${say('在采集器打开的网页中进入「我的」，点击「绑定 Google 账号」。','In the page opened by your collector, choose My profile → Link Google account.')}</p>`}`}
      <p role="status" data-link-status></p></section>
      <p class="note">${say('贡献榜只公开你选择的昵称与统计数字，不展示 Google 账号信息。随时取消勾选即可退出榜单。','Only your chosen nickname and statistics appear publicly. Google account details are never shown. Uncheck the option above to leave the board.')}</p>
      <div class="account-actions"><a class="btn" href="/contributors">${say('查看采集贡献榜','View contributors')} →</a>${!local?`<button data-logout>${say('退出登录','Sign out')}</button>`:''}</div>`;
  }
  async function post(path,data){const res=await fetch(path,{method:'POST',headers:{'Content-Type':'application/json','X-CSRF-Token':profile.csrf},body:JSON.stringify(data),signal:controller.signal});const body=await res.json();if(!res.ok)throw new Error(body.error);return body;}
  main.addEventListener('submit',async e=>{
    if(!e.target.matches('[data-profile]'))return;e.preventDefault();
    const form=e.target,button=form.querySelector('button'),status=form.querySelector('[role=status]');if(!button)return;button.disabled=true;
    try{await post('/api/v1/account',{nickname:form.elements.nickname.value,listed:form.elements.listed.checked});await load();const saved=box.querySelector('.account-status');if(saved)saved.textContent=say('已保存。历史贡献会自动计入。','Saved. Your earlier contributions are included.');}
    catch(err){status.textContent=message(err.message);}finally{button.disabled=false;}
  });
  main.addEventListener('click',async e=>{
    const button=e.target.closest('button');if(!button)return;
    if(button.hasAttribute('data-retry')){load();return;}
    if(!button.matches('[data-connect],[data-claim],[data-logout]'))return;button.disabled=true;
    const status=box.querySelector('[data-link-status]');
    try{
      if(button.hasAttribute('data-connect')){const result=await post('/api/v1/account/link',{});const url=new URL(result.url);if(url.origin!=='https://mxd.ruit.me'||url.pathname!=='/account')throw new Error('unavailable');location.assign(url);}
      else if(button.hasAttribute('data-claim')){await post('/api/v1/account/link',{code:link});link=null;params.delete('link');history.replaceState(null,'','/account');await load();box.querySelector('[data-link-status]').textContent=say('绑定成功，历史贡献已合并。','Linked. Your earlier contributions are now combined.');}
      else{await post('/api/v1/account/logout',{});await load();}
    }catch(err){if(status)status.textContent=message(err.message);}finally{button.disabled=false;}
  });
  load();return()=>{stopped=true;controller.abort();};
}

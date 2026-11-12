import { lang } from '../lib/i18n.js';
import { esc,num } from '../lib/format.js';
import {adoptAccount,subscribeSync,getSyncState,importGuest,guestImportAvailable,retryConflicts,beforeSignOut,flush} from '../lib/user-data.js';
const say=(zh,en)=>lang==='en'?en:zh;
const errors={invalid_nickname:['昵称需要 2–24 个字，可用中文、字母、数字、空格和 _-.。','Use 2–24 letters, numbers, spaces or _-. for your nickname.'],
  expired_link:['绑定链接已过期，请在客户端中重新点击绑定。','This link expired. Start linking again in the collector.'],
  already_linked:['这个客户端已经绑定了其他账号。','This collector belongs to another account.'],
  manage_on_website:['请在官网的「我的」中修改昵称。','Edit your nickname on the website under My profile.'],
  login_failed:['登录未完成，请重试。','Sign-in did not finish. Please try again.'],
  invalid_username:['用户名需为 3–32 个英文字母、数字、下划线、点或短横线，并以字母或数字开头。','Use 3–32 letters, numbers, underscores, dots or hyphens, starting with a letter or number.'],
  invalid_password:['密码需为 15–128 个字符，可使用长句作为密码。','Use a password of 15–128 characters. A long passphrase works well.'],
  password_mismatch:['两次输入的密码不一致。','The passwords do not match.'],
  invalid_credentials:['用户名或密码不正确。','Incorrect username or password.'],
  username_unavailable:['这个用户名暂时不可用，请换一个。','That username is unavailable. Please choose another.'],
  invalid_current_password:['当前密码不正确。','The current password is incorrect.'],
  invalid_recovery:['用户名或恢复码不正确，已使用的恢复码无法再次使用。','Incorrect username or recovery code. Used recovery codes cannot be reused.'],
  google_already_linked:['这个 Google 账号已有关联，未更改任何绑定。请登录原账号查看。','This Google identity is already linked. No links were changed. Sign in to the original account to continue.'],
  last_login_method:['请先设置账号密码，再解绑 Google。','Set an account password before unlinking Google.'],
  reauth_required:['请重新登录后再修改登录方式。','Sign in again before changing login methods.'],
  rate_limited:['请求较多，请稍后重试。','Too many attempts. Please try again later.'],
  watch_limit:['合并后超过 100 个关注商品，请先调整清单再合并。原数据已保留。','The merged list would exceed 100 watches. Adjust the lists before merging. Existing data is preserved.'],
  login_required:['登录已过期，请重新登录。','Your session expired. Please sign in again.'],
  google_unavailable:['Google 登录暂未开放，可使用用户名和密码登录。','Google sign-in is unavailable. You can sign in with a username and password.']};
function message(code){return say(...(errors[code]||['暂时没有连接成功，请稍后重试。','Could not connect. Please try again.']));}
export async function mount(main){
  let stopped=false,profile,controller=new AbortController(),authMode='login',recoveryCode=null;
  const syncLabels={memory_only:['浏览器无法保存本机副本，请保持联网完成同步；关闭页面可能丢失未同步的修改。','This browser cannot save a local copy. Stay online to sync; closing this page may lose pending edits.'],guest:['本机保存，登录后可同步','Saved in this browser. Sign in to sync.'],synced:['已同步','Synced'],pending:['等待同步…','Waiting to sync…'],offline:['暂时离线，修改已保存在本机，联网后重试','Offline. Changes are saved on this device and will retry.'],conflict:['其他设备更新了相同设置，已保留云端版本。本机修改仍可重新应用。','Another device changed the same settings. Cloud values are shown; your local changes can still be reapplied.'],login_required:['登录已过期，未上传的修改保留在本机','Sign in again. Pending changes are kept on this device.'],watch_limit:['关注最多 100 个，请调整清单后重试','Up to 100 watches. Adjust the list and retry.']};
  const params=new URLSearchParams(location.search);let link=params.get('link');
  main.innerHTML=`<section class="stall account-stall"><div class="stall-bar"><h1>${say('我的','My profile')}</h1><a class="bar-more" href="/contributors">${say('采集贡献榜','Contributors')} →</a></div><div class="account-body" data-account><p role="status">${say('正在加载…','Loading…')}</p></div></section>`;
  const box=main.querySelector('[data-account]');
  async function load(broadcast=false){
    try{
      const res=await fetch('/api/v1/account',{cache:'no-store',signal:controller.signal});
      if(!res.ok)throw new Error('unavailable');profile=await res.json();if(stopped)return;await adoptAccount(profile,{broadcast});if(stopped)return;window.dispatchEvent(new CustomEvent('account-changed',{detail:profile}));render();
    }catch(e){if(!stopped){box.innerHTML=`<p role="alert">${esc(message(e.message))}</p><button data-retry>${say('重试','Retry')}</button>`;}}
  }
  function authForm(){
    const register=authMode==='register',recover=authMode==='recover';
    const title=register?say('注册应用账号','Create an account'):recover?say('恢复账号','Recover account'):say('账号密码登录','Sign in with a password');
    return `<div class="account-tabs" role="group" aria-label="${say('登录方式','Sign-in options')}">${[['login',say('登录','Sign in')],['register',say('注册','Register')],['recover',say('找回密码','Recover')]].map(([mode,label])=>`<button type="button" data-auth-tab="${mode}" aria-pressed="${authMode===mode}">${label}</button>`).join('')}</div>
      <h2>${title}</h2><form data-auth><label>${say('用户名','Username')}<input name="username" autocomplete="username" required minlength="3" maxlength="32" autocapitalize="none" spellcheck="false" pattern="[A-Za-z0-9][A-Za-z0-9_.-]{2,31}"></label>
      ${recover?`<label>${say('一次性恢复码','One-time recovery code')}<input name="recovery_code" required minlength="43" maxlength="43" autocomplete="off" spellcheck="false"></label>`:''}
      <label>${recover?say('新密码','New password'):say('密码','Password')}<input name="password" type="password" autocomplete="${register||recover?'new-password':'current-password'}" required minlength="${register||recover?15:1}" maxlength="128"></label>
      ${register||recover?`<label>${say('再次输入密码','Confirm password')}<input name="confirm_password" type="password" autocomplete="new-password" required minlength="15" maxlength="128"></label><p class="note">${say('密码使用 15–128 个字符。完成后请保存恢复码，用于忘记密码时找回账号。','Use 15–128 characters. Save the recovery code shown afterwards to recover your account if you forget the password.')}</p>`:''}
      <button class="btn primary" type="submit">${title}</button><p role="status" class="account-status"></p></form>`;
  }
  function recoveryNotice(){return recoveryCode?`<section class="well recovery-notice" role="status"><h3>${say('请保存你的新恢复码','Save your new recovery code')}</h3><p>${say('恢复码仅在这里显示一次，可用于重设密码。请存放在安全位置；不要发给他人。旧恢复码已失效。','This code is shown once and can reset your password. Save it somewhere safe and do not share it. Any previous recovery code is now invalid.')}</p><code class="recovery-code">${esc(recoveryCode)}</code><div class="account-actions"><button data-download-recovery>${say('下载恢复码','Download code')}</button><button data-dismiss-recovery>${say('我已保存','I saved it')}</button></div></section>`:'';}
  function syncSection(){return `<section class="well account-help"><h3>${say('云端同步','Cloud sync')}</h3><p data-sync-status role="status"></p><p>${say('关注商品、目标价、提醒开关和常用偏好跟随账号保存。未同步的修改留在本机，下次登录此账号后继续。','Watches, target prices, alert switches and preferences follow your account. Pending edits stay on this device and resume when you sign in to this account again.')}</p><div class="account-actions"><button data-sync-now>${say('立即同步','Sync now')}</button><button data-retry-conflicts hidden>${say('重新应用本机修改','Reapply local changes')}</button></div>${guestImportAvailable()?`<p>${say(`本机游客清单有 ${getSyncState().guestWatches} 个关注商品，可合并到此账号。重复项保留云端设置。`,`This browser has ${getSyncState().guestWatches} guest watches. Merge them into this account; existing cloud settings take priority.`)}</p><button data-import-guest>${say('合并本机清单','Merge guest watches')}</button>`:''}<p data-sync-error role="alert"></p></section>`;}
  function securitySection(){return `<section class="well account-help"><h3>${say('登录与安全','Sign-in & security')}</h3><p>${profile.has_password?say('登录用户名：','Username: ')+esc(profile.username):say('当前通过 Google 登录。你也可以设置用户名和密码。','You currently sign in with Google. You can also set a username and password.')}</p>
    ${profile.has_password?`<label>${say('当前密码（用于修改登录方式）','Current password (to change sign-in methods)')}<input id="account-current-password" type="password" autocomplete="current-password" maxlength="128"></label>`:''}
    <details><summary>${profile.has_password?say('修改密码','Change password'):say('设置用户名和密码','Set username & password')}</summary><form data-password><label>${say('登录用户名','Username')}<input name="username" autocomplete="username" required minlength="3" maxlength="32" value="${esc(profile.username||'')}" ${profile.has_password?'readonly':''} pattern="[A-Za-z0-9][A-Za-z0-9_.-]{2,31}"></label><label>${say('新密码（15–128 个字符）','New password (15–128 characters)')}<input name="password" type="password" autocomplete="new-password" required minlength="15" maxlength="128"></label><label>${say('再次输入新密码','Confirm new password')}<input name="confirm_password" type="password" autocomplete="new-password" required minlength="15" maxlength="128"></label><button class="btn" type="submit">${say('保存密码','Save password')}</button><p role="status" class="account-status"></p></form></details>
    <p>${profile.google_linked?say('Google：已绑定','Google: linked'):say('Google：未绑定','Google: not linked')}</p>
    ${profile.google_linked?`<button data-security-action="google/unlink">${say('解绑 Google','Unlink Google')}</button>`:profile.google_enabled?`<button data-security-action="google/link">${say('绑定 Google 登录','Link Google sign-in')}</button>`:''}
    ${!profile.has_password?`<p class="note">${say('修改登录方式前，可能需要重新使用 Google 登录。解绑 Google 前必须先设置密码。','You may need to sign in with Google again before changing sign-in methods. Set a password before unlinking Google.')}</p>`:''}
    <button data-security-action="logout-all">${say('退出所有设备','Sign out all devices')}</button><p data-security-status role="status"></p></section>`;}
  function updateSync(){const el=box.querySelector('[data-sync-status]');if(el)el.textContent=say(...(syncLabels[getSyncState().status]||syncLabels.offline));const retry=box.querySelector('[data-retry-conflicts]');if(retry)retry.hidden=!getSyncState().conflicts;}
  function render(){
    const local=profile.mode==='collector';
    const google='/auth/google/start'+(link?'?link='+encodeURIComponent(link):'');
    if(!profile.signed_in){
      box.innerHTML=`<p>${say('登录后，在不同设备同步关注商品、目标价和偏好。无需安装客户端。','Sign in to sync watches, target prices and preferences across devices. No collector required.')}</p>${authForm()}
        ${profile.google_enabled?`<a class="btn google-signin" href="${google}"><span aria-hidden="true">G</span>${say('使用 Google 登录','Sign in with Google')}</a>`:`<p class="note">${esc(message('google_unavailable'))}</p>`}
        <p class="note"><a href="/privacy">${say('账号隐私说明','Account privacy')}</a></p>
        ${params.has('error')?`<p role="alert">${esc(message(params.get('error')))}</p>`:''}
        <section class="well account-help"><h3>${say('只想用昵称？也可以','Prefer just a nickname?')}</h3><p>${say('打开 Windows 客户端，点网页右上角的头像图标进入「我的」，输入昵称即可。已有采集记录会自动计入。','Open the Windows collector, select the profile icon at the top right, and enter a nickname. Your earlier contributions will count too.')}</p><a href="/web/download.html">${say('下载客户端与使用说明','Download collector & instructions')} →</a></section>`;return;
    }
    box.innerHTML=`${recoveryNotice()}${!local?syncSection():''}<h2>${say('你的采集名片','Your contributor profile')}</h2><p>${say('用昵称加入贡献榜，感谢你帮大家发现价格。','Join the contributor board with a nickname. Thanks for helping everyone discover prices.')}</p>
      <div class="contributor-stats"><div><strong>${num(profile.stats?.shops||0)}</strong><span>${say('累计采集摊位','Shops contributed')}</span></div><div><strong>${num(profile.stats?.quotes||0)}</strong><span>${say('有效报价条目','Distinct offers')}</span></div></div>
      <form data-profile><label for="contributor-nickname">${say('昵称','Nickname')}${profile.temporary?' · '+say('临时昵称','Temporary nickname'):''}</label><input id="contributor-nickname" name="nickname" required minlength="2" maxlength="24" autocomplete="nickname" value="${esc(profile.nickname||'')}" placeholder="${say('大家怎么称呼你？','What should we call you?')}" ${local&&profile.linked?'disabled':''}>
      ${profile.temporary?`<p class="note">${say('这是随机分配给你的固定昵称，可以改成自己喜欢的名字。','This randomly assigned nickname stays the same until you choose your own.')}</p>`:''}
      <label class="account-opt"><input type="checkbox" name="listed" ${profile.listed?'checked':''} ${local&&profile.linked?'disabled':''}>${say('在贡献榜公开我的昵称和采集成绩','Show my nickname and contributions on the leaderboard')}</label>
      ${local&&profile.linked?`<a class="btn" href="https://mxd.ruit.me/account" target="_blank" rel="noopener">${say('去官网修改','Edit on website')} ↗</a>`:`<button class="btn primary" type="submit">${say('保存昵称','Save nickname')}</button>`}
      <p class="account-status" role="status" aria-live="polite"></p></form>
      <section class="well account-help"><h3>${say('我的客户端','My collectors')}</h3>
      ${local?(profile.linked?`<p>${say('已绑定应用账号，历史贡献已合并。','Linked to your account. Earlier contributions are included.')}</p>`:
        `<p>${say('这台客户端的历史记录会归到你的昵称下。绑定账号后，可以把不同电脑的贡献合在一起。','This collector’s history counts toward your nickname. Link your account to combine contributions from multiple computers.')}</p><button class="btn" data-connect>${say('绑定应用账号','Link account')}</button>`):
        `<p>${say(`已绑定 ${profile.collectors||0} 个客户端。`,`You have ${profile.collectors||0} linked collectors.`)}</p>${link?`<button class="btn primary" data-claim>${say('确认绑定这台客户端','Confirm linking this collector')}</button><p class="note">${say('绑定后，这台客户端以往和今后的贡献都会计入你的账号。','This collector’s past and future contributions will belong to your account.')}</p>`:`<p>${say('在客户端打开的网页中进入「我的」，点击「绑定应用账号」。','In the page opened by your collector, choose My profile → Link account.')}</p>`}`}
      <p role="status" data-link-status></p></section>
      <p class="note">${say('贡献榜只公开你选择的昵称与统计数字，不展示 Google 账号信息。随时取消勾选即可退出榜单。','Only your chosen nickname and statistics appear publicly. Google account details are never shown. Uncheck the option above to leave the board.')}</p>
      ${!local?securitySection():''}<div class="account-actions"><a class="btn" href="/contributors">${say('查看采集贡献榜','View contributors')} →</a>${!local?`<button data-logout>${say('退出登录','Sign out')}</button>`:''}</div>`;
    updateSync();
  }
  async function post(path,data){const res=await fetch(path,{method:'POST',headers:{'Content-Type':'application/json',...(profile?.csrf?{'X-CSRF-Token':profile.csrf}:{})},body:JSON.stringify(data),signal:controller.signal});const body=await res.json();if(!res.ok)throw new Error(body.error);return body;}
  main.addEventListener('submit',async e=>{
    if(e.target.matches('[data-auth],[data-password]')){
      e.preventDefault();const form=e.target,button=form.querySelector('button'),status=form.querySelector('[role=status]');button.disabled=true;
      try{
        const data=Object.fromEntries(new FormData(form));
        if(data.confirm_password!==undefined&&data.confirm_password!==data.password)throw new Error('password_mismatch');
        delete data.confirm_password;
        const path=form.matches('[data-password]')?'password':authMode==='login'?'login':authMode==='register'?'register':'recover';
        if(path==='password')data.current_password=box.querySelector('#account-current-password')?.value||'';
        const result=await post('/api/v1/account/'+path,data);recoveryCode=result.recovery_code||null;await load(true);
      }catch(err){status.textContent=message(err.message);}finally{button.disabled=false;}return;
    }
    if(!e.target.matches('[data-profile]'))return;e.preventDefault();
    const form=e.target,button=form.querySelector('button'),status=form.querySelector('[role=status]');if(!button)return;button.disabled=true;
    try{await post('/api/v1/account',{nickname:form.elements.nickname.value,listed:form.elements.listed.checked});await load();const saved=box.querySelector('.account-status');if(saved)saved.textContent=say('已保存。历史贡献会自动计入。','Saved. Your earlier contributions are included.');}
    catch(err){status.textContent=message(err.message);}finally{button.disabled=false;}
  });
  main.addEventListener('click',async e=>{
    const button=e.target.closest('button');if(!button)return;
    if(button.hasAttribute('data-auth-tab')){authMode=button.dataset.authTab;render();return;}
    if(button.hasAttribute('data-dismiss-recovery')){recoveryCode=null;render();return;}
    if(button.hasAttribute('data-download-recovery')){const blob=new Blob([`Maple Market recovery code\nUsername: ${profile.username}\n${recoveryCode}\nKeep private. This code can reset your password.\n`],{type:'text/plain'}),url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download='maple-market-recovery.txt';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);return;}
    if(button.matches('[data-import-guest],[data-retry-conflicts],[data-sync-now]')){
      button.disabled=true;try{if(button.hasAttribute('data-import-guest')){await importGuest();render();}else if(button.hasAttribute('data-retry-conflicts'))retryConflicts();else await flush();}catch(err){box.querySelector('[data-sync-error]').textContent=message(err.message);}finally{button.disabled=false;}return;
    }
    if(button.hasAttribute('data-security-action')){
      button.disabled=true;const status=box.querySelector('[data-security-status]');try{
        const action=button.dataset.securityAction,result=await post('/api/v1/account/'+action,{current_password:box.querySelector('#account-current-password')?.value||''});
        if(action==='google/link'){const url=new URL(result.url);if(url.origin!=='https://accounts.google.com')throw new Error('unavailable');location.assign(url);}
        else await load(true);
      }catch(err){status.textContent=message(err.message);}finally{button.disabled=false;}return;
    }
    if(button.hasAttribute('data-retry')){load();return;}
    if(!button.matches('[data-connect],[data-claim],[data-logout]'))return;button.disabled=true;
    const status=box.querySelector('[data-link-status]');
    try{
      if(button.hasAttribute('data-connect')){const result=await post('/api/v1/account/link',{});const url=new URL(result.url);if(url.origin!=='https://mxd.ruit.me'||url.pathname!=='/account')throw new Error('unavailable');location.assign(url);}
      else if(button.hasAttribute('data-claim')){await post('/api/v1/account/link',{code:link});link=null;params.delete('link');history.replaceState(null,'','/account');await load();box.querySelector('[data-link-status]').textContent=say('绑定成功，历史贡献已合并。','Linked. Your earlier contributions are now combined.');}
      else{await beforeSignOut();await post('/api/v1/account/logout',{});recoveryCode=null;await load(true);}
    }catch(err){if(status)status.textContent=message(err.message);}finally{button.disabled=false;}
  });
  const stopSync=subscribeSync(updateSync);
  load();return()=>{stopped=true;controller.abort();stopSync();recoveryCode=null;};
}

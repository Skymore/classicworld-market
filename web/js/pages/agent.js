import { lang } from '../lib/i18n.js';
import { esc } from '../lib/format.js';

function messages(en) { return en ? {
  title:'Market assistant', intro:'Tell me what you want to buy or sell. I’ll look up our market data for you.',
  placeholder:'I want to sell 100 ores. What price should I ask?', label:'Your market question', send:'Ask', stop:'Stop', clear:'New conversation',
  hint:'Queries cover observed offers and sales. Availability and equipment attributes need checking in game.',
  welcome:'What are you looking for?', subtitle:'Compare offers, plan a sale, or check the market.',
  examples:['Where can I buy Red Potions cheaply?','I want to sell Steel Ores. How much should I ask?','What items have sold most recently?'],
  pending:'Looking up market data…', you:'You', assistant:'Market assistant', tools:'Data queries', sources:'View item data',
  api:'Agent data API', apiHint:'These read-only tools also work with your own agent. A provider key is only needed for this chat.',
  config:'The assistant is waiting for the server’s OPENROUTER_API_KEY. The data tools are available independently.',
  unavailable:'Could not load assistant status. You can retry sending a question.',
  failed:'The request failed. Please try again.', timeout:'The model took too long. Please try again.',
  quota:'The assistant is busy or its quota has been reached. Please try again later.',
} : {
  title:'市场助手', intro:'告诉我你想买什么、卖什么，我帮你查市集数据。',
  placeholder:'例如：我要卖 100 个钢铁，挂多少合适？', label:'你的市场问题', send:'问一问', stop:'停止', clear:'新对话',
  hint:'依据已采集的报价和成交价。是否仍在售、装备属性，请在游戏里核对。',
  welcome:'今天想买点什么？', subtitle:'找低价、看卖价，也可以问问最近行情。',
  examples:['我要买红色药水，去哪买便宜？','我要卖钢铁，挂多少比较合适？','最近哪些物品卖得多？'],
  pending:'正在查询市场数据…', you:'你', assistant:'市场助手', tools:'本次数据查询', sources:'查看物品数据',
  api:'Agent 数据接口', apiHint:'这组只读工具也可以供你自己的 agent 调用。调用数据接口不需要模型密钥。',
  config:'助手尚未配置服务端 OPENROUTER_API_KEY。数据工具接口已可独立调用。',
  unavailable:'暂时无法读取助手状态，可以尝试发送问题。',
  failed:'请求失败，请稍后重试。', timeout:'模型响应超时，请重试。',
  quota:'助手繁忙或额度已用完，请稍后再试。',
}; }

function failure(code, copy, en) {
  if (code==='agent_not_configured') return copy.config;
  if (code==='agent_timeout') return copy.timeout;
  if (['agent_busy','agent_rate_limited','agent_free_quota_exceeded'].includes(code)) return copy.quota;
  if (code==='agent_provider_configuration') return en?'Check the server’s OpenRouter key and account settings.':'请检查服务端 OpenRouter 密钥与账号配置。';
  return copy.failed;
}

// Only same-site evidence links are clickable. Model text is always escaped.
export function answerHtml(text) {
  return esc(text).replace(/\[([^\]\n]{1,160})\]\(\s*(\/(?:item\/\d+|map\/\d+|prices))\s*\)/g,
    '<a href="$2">$1</a>').replace(/\*\*([^*\n]+)\*\*/g,'<strong>$1</strong>');
}

export function mount(main) {
  const en=lang==='en', copy=messages(en);
  let history=[], busy=false, alive=true, configured=true, controller=null;
  main.innerHTML=`<section class="stall agent-panel">
    <div class="stall-bar"><h1>${copy.title}</h1><button type="button" class="bar-more" data-clear>${copy.clear}</button></div>
    <div class="agent-intro"><p>${copy.intro}</p><span class="agent-provider">OpenRouter</span></div>
    <p class="agent-status" role="status" data-status></p>
    <div class="agent-thread" role="log" aria-live="polite" aria-relevant="additions" aria-label="${copy.title}" data-thread>
      <div class="agent-welcome" data-welcome><h2>${copy.welcome}</h2><p>${copy.subtitle}</p>
        <div class="agent-examples">${copy.examples.map((q,i)=>`<button type="button" data-example="${i}">${esc(q)}</button>`).join('')}</div>
      </div>
    </div>
    <form class="agent-composer"><label for="agent-message" class="sr">${copy.label}</label>
      <textarea id="agent-message" name="message" rows="2" maxlength="2000" required placeholder="${copy.placeholder}"></textarea>
      <button class="agent-send" type="submit">${copy.send}</button><button type="button" data-stop hidden>${copy.stop}</button>
    </form><p class="agent-hint">${copy.hint}</p>
  </section>
  <details class="stall agent-api"><summary>${copy.api}</summary><p>${copy.apiHint}</p>
    <code>GET /api/v1/agent/tools</code><code>POST /api/v1/agent/tools/{name}</code>
    <code>POST /api/v1/agent/tools/search_items<br>{"query":"钢铁"}</code>
    <div data-tool-list></div>
  </details>`;
  const thread=main.querySelector('[data-thread]'), input=main.querySelector('textarea'), form=main.querySelector('form');
  const send=form.querySelector('[type=submit]'), stop=main.querySelector('[data-stop]'), status=main.querySelector('[data-status]');
  const statusController=new AbortController();
  fetch('/api/v1/agent/tools',{signal:statusController.signal,credentials:'same-origin'}).then(async res=>{
    if(!res.ok)throw new Error();
    const data=await res.json(); if(!alive)return;
    const modelNames={'openrouter/free':'OpenRouter · Free','openai/gpt-6-luna':'GPT-6 Luna','openai/gpt-6.1-sol':'GPT-6.1 Sol'};
    main.querySelector('.agent-provider').textContent=modelNames[data.model]||data.model||'OpenRouter';
    configured=data.enabled!==false;
    if(!configured)status.textContent=copy.config;
    main.querySelector('[data-tool-list]').textContent=(data.tools||[]).map(t=>t.function.name).join(' · ');
  }).catch(err=>{if(alive&&err.name!=='AbortError')status.textContent=copy.unavailable;});

  function setBusy(value) {
    busy=value; send.disabled=value; stop.hidden=!value; input.readOnly=value;
    main.querySelector('[data-clear]').disabled=value;
    thread.setAttribute('aria-busy',String(value));
  }
  function bubble(role,text) {
    const article=document.createElement('article');article.className=`agent-message agent-${role}`;
    const label=document.createElement('h3');label.textContent=role==='user'?copy.you:copy.assistant;
    const body=document.createElement('div');body.className='agent-answer';
    if(role==='assistant')body.innerHTML=answerHtml(text);else body.textContent=text;
    article.append(label,body);thread.append(article);return article;
  }
  function boundedHistory() {
    const recent=[];let bytes=0;
    for(const turn of [...history].reverse()) {
      const entry={...turn,content:turn.content.slice(0,4000)};
      bytes+=new TextEncoder().encode(JSON.stringify(entry)).length;
      if(bytes>22000||recent.length===12)break;
      recent.unshift(entry);
    }
    // Keep complete user/assistant pairs.
    if(recent[0]?.role==='assistant')recent.shift();
    return recent;
  }
  async function submit(event) {
    event?.preventDefault();if(busy)return;
    const message=input.value.trim();if(!message||[...message].length>2000)return;
    if(!configured){status.textContent=copy.config;return;}
    main.querySelector('[data-welcome]')?.remove();status.textContent='';
    const user=bubble('user',message);const pending=bubble('assistant',copy.pending);
    setBusy(true);controller=new AbortController();
    const timeout=setTimeout(()=>controller?.abort('timeout'),155000);
    try {
      const res=await fetch('/api/v1/agent/chat',{method:'POST',headers:{'Content-Type':'application/json'},credentials:'same-origin',
        signal:controller.signal,body:JSON.stringify({message,history:boundedHistory(),language:lang})});
      const data=await res.json().catch(()=>({}));
      if(!res.ok)throw new Error(failure(data.error,copy,en));
      if(typeof data.answer!=='string'||!data.answer.trim())throw new Error(copy.failed);
      if(!alive)return;
      pending.querySelector('.agent-answer').innerHTML=answerHtml(data.answer);
      if(data.sources?.length){
        const links=document.createElement('div');links.className='agent-sources';
        for(const href of [...new Set(data.sources)].filter(s=>/^\/(?:item\/\d+|prices)$/.test(s))) {
          const a=document.createElement('a');a.href=href;a.textContent=href.startsWith('/item/')?`${copy.sources} #${href.split('/').pop()}`:(en?'Prices':'价格表');links.append(a);
        }
        pending.append(links);
      }
      if(data.tool_calls?.length){
        const details=document.createElement('details');details.className='agent-trace';
        const summary=document.createElement('summary');summary.textContent=`${copy.tools} · ${data.tool_calls.length}`;
        const pre=document.createElement('pre');pre.textContent=data.tool_calls.map(t=>`${t.ok?'✓':'!'} ${t.name} ${JSON.stringify(t.arguments)}`).join('\n');
        details.append(summary,pre);pending.append(details);
      }
      history.push({role:'user',content:message},{role:'assistant',content:data.answer});history=history.slice(-12);input.value='';
    } catch(err) {
      if(!alive)return;
      user.remove();pending.remove();
      status.textContent=controller.signal.aborted?(controller.signal.reason==='timeout'?copy.timeout:(en?'Stopped. Your question is ready to retry.':'已停止，可以重新发送。')):err.message;
    } finally {
      clearTimeout(timeout);if(alive){setBusy(false);input.focus();}controller=null;
    }
  }
  form.addEventListener('submit',submit);
  input.addEventListener('keydown',e=>{if(e.key==='Enter'&&!e.shiftKey&&!e.isComposing){e.preventDefault();form.requestSubmit();}});
  stop.addEventListener('click',()=>controller?.abort());
  main.querySelectorAll('[data-example]').forEach(b=>b.addEventListener('click',()=>{if(!busy){input.value=copy.examples[Number(b.dataset.example)];input.focus();}}));
  main.querySelector('[data-clear]').addEventListener('click',()=>{if(!busy){history=[];thread.replaceChildren();status.textContent=configured?'':copy.config;input.value='';input.focus();}});
  return ()=>{alive=false;statusController.abort();controller?.abort();};
}

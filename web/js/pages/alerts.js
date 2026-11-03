import {loadProfile,saveProfile,mergeHistory,tokenNamespace} from '../lib/deal-history.js?v=20261022-regressions-1';
import { subscribeMarket, subscribeCollector } from '../lib/realtime.js?v=20261022-regressions-1';
// /alerts: the visitor's own deal alerts (plan v1 §5.6) from
// GET /api/v1/collector/alerts with the collector token. The browser
// collector (/collect) keeps that token in localStorage; a token pasted here
// (e.g. from the WinDivert collector's member.json) goes to the same key.
// The token is only ever sent as the Authorization header of that request.
import { api, getJson, qs } from '../lib/api.js?v=20261022-auto-watch-2';
import { t, addMessages, itemName, lang } from '../lib/i18n.js';
import { esc, meso, ago, loc, fullTime } from '../lib/format.js';
import { ensureListsCss, icon, emptyState, hideBroken, toast, notify } from './watch.js?v=20261023-watch-cap-1';

// web/collect/collect.js TOKEN_KEY.
const TOKEN_KEY = 'cwm.collector.token';

// shared_store.authenticate accepts 30..128 characters.
const TOKEN_LENGTH = [30, 128];
const HOURS = ['72', 'all'];
// The API's basis sentence is Chinese; this is the same sentence in English.
const BASIS_EN = 'Compared with earlier offers from other shops (this shop excluded). The quick-sell price triggers the alert and the normal-sell price shows the higher reference; shops, listings and stock on sale are listed, and the margin is after the 3% fee.';

addMessages({
  zh: {
    'alerts.title': '低价提醒', 'alerts.meta': '{n} 条 · 实时推送', 'alerts.window': '参考报价', 'alerts.window_72': '近 72 小时', 'alerts.window_all': '全部记录',
    'alerts.rules': '只看你自己的采集器最近 2 分钟逛到的摊位。非装备；至少 8 个其他摊位有报价；买价低于这些摊位中位价的下四分位；按快卖参考价扣 3% 手续费后至少赚 15%。别人的报价参与比较，别人的低价发现不会提醒你。',
    'alerts.buy': '买价 / 件', 'alerts.bundle': '{n} 件一组 {cost}', 'alerts.stock': '库存 {n}', 'alerts.fast': '快卖参考', 'alerts.normal': '正常卖参考',
    'alerts.after_fee': '扣 3% 后 {pct}', 'alerts.found': '发现于 {ago}', 'alerts.counts': '比较 {shops} 个摊位 · {listings} 条挂单 · 共 {qty} 件在售 · 下四分位 {q1}',
    'alerts.empty': '暂时没有低价提醒。继续逛摊，发现低价时这里会提醒。', 'alerts.checked': '{time} 检查过',
    'alerts.toast_title': '采集提醒', 'alerts.toast_line': '{buy} / 件 · 快卖 {sell} · 扣费后 {pct}',
    'alerts.setup_title': '开始采集，查看自己的低价提醒',
    'alerts.setup_intro': '选择一种采集方式即可，无需手动填写连接信息。提醒只针对你逛到的摊位；其他玩家的报价仅用于比价。',
    'alerts.setup_browser': '浏览器采集', 'alerts.setup_browser_text': '打开采集页，共享游戏窗口，然后照常逛摊。这个浏览器会记住采集身份，回到本页就能看到提醒。', 'alerts.setup_open': '打开采集页',
    'alerts.setup_divert': 'Windows 采集器',
    'alerts.setup_divert_text': '启动 Windows 采集器后，使用它自动打开的个人提醒页面，连接信息会自动带好。如果已经启动，也可以从下面打开本机默认入口。',
    'alerts.setup_local': '打开本机个人提醒',
    'alerts.setup_local_hint': '仅在这台电脑已启动 Windows 采集器时可用；打不开时，请先启动采集器。',
    'alerts.manual': '手动连接已有采集器（高级）',
    'alerts.manual_intro': '通常不需要使用此选项。只有想在当前浏览器查看另一台采集器的个人提醒时，才需要从自己的采集器配置中复制连接凭据（令牌）。',
    'alerts.token_label': '私人连接凭据', 'alerts.token_hint': '这相当于查看个人提醒的密码，请勿分享。保存后只在当前浏览器记住，并用于连接本站的个人提醒服务。',
    'alerts.token_save': '连接采集器', 'alerts.token_bad': '连接凭据应为 30–128 个字符，请从自己的采集器配置中完整复制。', 'alerts.token_invalid': '个人提醒连接已失效。Windows 用户请使用采集器打开的个人提醒页面；浏览器采集用户可展开高级选项，清除旧连接后重新开始采集。',
    'alerts.token_clear': '清除当前连接', 'alerts.limited': '请求太频繁，稍后自动重试。', 'alerts.failed': '提醒暂时无法更新，稍后自动重试。',
  },
  en: {
    'alerts.title': 'Deal alerts', 'alerts.meta': '{n} · live updates', 'alerts.window': 'Reference offers', 'alerts.window_72': 'Last 72 h', 'alerts.window_all': 'All records',
    'alerts.rules': 'Only shops your own collector visited in the last 2 minutes. Not equipment; at least 8 other shops with offers; a buy price under the first quartile of their median prices; at least 15% profit at the quick-sell price after the 3% fee. Other players\' offers are compared, but their finds never alert you.',
    'alerts.buy': 'Buy each', 'alerts.bundle': '{n} per bundle at {cost}', 'alerts.stock': 'stock {n}', 'alerts.fast': 'Quick sell', 'alerts.normal': 'Normal sell',
    'alerts.after_fee': '{pct} after 3% fee', 'alerts.found': 'found {ago}', 'alerts.counts': '{shops} shops · {listings} listings · {qty} on sale · first quartile {q1}',
    'alerts.empty': 'No deals right now. Keep visiting shops; cheap finds show up here.', 'alerts.checked': 'checked {time}',
    'alerts.toast_title': 'Deal found', 'alerts.toast_line': '{buy} each · quick sell {sell} · {pct} after fee',
    'alerts.setup_title': 'Start collecting to see your own deal alerts',
    'alerts.setup_intro': 'Choose a collection method; there is no connection information to fill in. Alerts are for shops you visit. Other players’ offers are only used for price comparison.',
    'alerts.setup_browser': 'Browser collector', 'alerts.setup_browser_text': 'Open the collector page, share the game window and visit shops as usual. This browser keeps the collector identity; come back here to see your alerts.', 'alerts.setup_open': 'Open the collector',
    'alerts.setup_divert': 'Windows collector',
    'alerts.setup_divert_text': 'Start the Windows collector and use the personal alerts page it opens automatically. Connection details are handled for you. If it is already running, you can also open its default local address below.',
    'alerts.setup_local': 'Open local personal alerts',
    'alerts.setup_local_hint': 'Requires the Windows collector to be running on this computer. If the page does not open, start the collector first.',
    'alerts.manual': 'Connect an existing collector manually (advanced)',
    'alerts.manual_intro': 'Usually unnecessary. Use this only to view another collector’s personal alerts in this browser. Copy the connection credential (token) from your own collector configuration.',
    'alerts.token_label': 'Private connection credential', 'alerts.token_hint': 'Treat this like a password for your personal alerts. Do not share it. It is remembered only in this browser and used to connect to this site’s personal alerts service.',
    'alerts.token_save': 'Connect collector', 'alerts.token_bad': 'The connection credential must contain 30–128 characters. Copy it in full from your own collector configuration.', 'alerts.token_invalid': 'Your personal alerts connection has expired. Windows users should use the alerts page opened by the collector. Browser collector users can clear the old connection under advanced options and start collecting again.',
    'alerts.token_clear': 'Clear current connection', 'alerts.limited': 'Too many requests; retrying shortly.', 'alerts.failed': 'Alerts could not be updated; retrying shortly.',
  },
});

const readToken = () => { try { return localStorage.getItem(TOKEN_KEY); } catch { return null; } };
const validToken = (s) => typeof s === 'string' && s.length >= TOKEN_LENGTH[0] && s.length <= TOKEN_LENGTH[1];
const pct = (v) => `${v >= 0 ? '+' : ''}${Number(v).toFixed(1)}%`;

// Session-wide so a remount neither re-pops alerts nor re-asks the catalogue.

const ITEMS = new Map(); // item_id -> catalogue entry (icon, both names)

export async function mount(main) {
  await ensureListsCss();
  let token = readToken();
  let localCollector=false, collectorStatus=null, namespace=null, profile=null, historyView=false, revision=0;
  let storageOkay=true,storage=null,historyExpiry=null,historyLimit=24;try{storage=localStorage;}catch{}const seen=new Set();
  const connected=()=>Boolean(token||localCollector);
  const text=(zh,en)=>lang==='en'?en:zh;
  const now=()=>Date.now()/1000;
  const persist=()=>{if(namespace&&profile){storageOkay=saveProfile(storage,namespace,profile,now());clearTimeout(historyExpiry);if(profile.archive.length)historyExpiry=setTimeout(()=>{if(!stopped){profile.archive=mergeHistory(profile.archive,[],now());persist();render();}},Math.max(1000,(profile.archive.at(-1).observed+86401-now())*1000));}};
  async function openProfile(legacyNamespace=null){
    const epoch=revision;const key=token?await tokenNamespace(token):localCollector?'local-'+collectorStatus.collector_id:null;
    if(epoch!==revision||!key)return;namespace=key;profile=loadProfile(storage,key,now(),legacyNamespace);
    seen.clear();for(const row of profile.archive)seen.add(row.id);
  }
  let hours = new URLSearchParams(location.search).get('hours') === 'all' ? 'all' : '72';
  let deals = [];
  let first = true;
  let problem = null; // 'invalid' | 'limited' | 'failed'
  let checkedAt = null;
  let pending = false, retryTimer=null, failures=0;
  let busy = false;
  let stopped = false;
  let controller = null;

  main.innerHTML = '<div class="lwrap alerts-page"><section class="stall lpage" data-panel></section></div>';
  const panel = main.querySelector('[data-panel]');
  hideBroken(main);

  function setupView(message) {
    return `<div class="stall-bar"><h1>${esc(t('alerts.title'))}</h1></div>
      <div class="asetup">
        <h2>${esc(t('alerts.setup_title'))}</h2>
        ${message ? `<p class="awarn" role="alert">${esc(message)}</p>` : ''}
        <p>${esc(t('alerts.setup_intro'))}</p><p>${lang === 'en' ? 'Collect evaluates non-equipment margins from your collector. For personal price caps on any item, use Watch; keep its page open for new-offer notifications. Watch settings stay in your browser.' : '采集按你的采集器规则筛选非装备价差。想为装备或其他物品设置个人价格上限，请使用「关注」；保持关注页打开才会检查新报价并提醒。关注设置仅保存在当前浏览器。'}</p>
        <div class="well astep"><h3>${esc(t('alerts.setup_browser'))}</h3><p>${esc(t('alerts.setup_browser_text'))}</p><a class="btn primary" href="/collect/">${esc(t('alerts.setup_open'))}</a></div>
        <div class="well astep"><h3>${esc(t('alerts.setup_divert'))}</h3><p>${esc(t('alerts.setup_divert_text'))}</p>
          <a class="btn primary" href="/web/download.html">${lang === 'en' ? 'Download & instructions' : '下载采集器与使用说明'}</a>
          <a class="btn" href="http://127.0.0.1:8780/alerts">${esc(t('alerts.setup_local'))}</a>
          <p class="fnote">${esc(t('alerts.setup_local_hint'))}</p></div>
        <details class="well amanual"><summary>${esc(t('alerts.manual'))}</summary>
        <p>${esc(t('alerts.manual_intro'))}</p>
        <form class="astep atoken" data-token-form>
          <label for="alerts-token"><b>${esc(t('alerts.token_label'))}</b></label>
          <div class="arow"><input id="alerts-token" type="password" autocomplete="off" spellcheck="false" minlength="${TOKEN_LENGTH[0]}" maxlength="${TOKEN_LENGTH[1]}" aria-describedby="alerts-token-hint" required data-token-input>
            <button type="submit" class="btn">${esc(t('alerts.token_save'))}</button></div>
          <p id="alerts-token-hint" class="fnote">${esc(t('alerts.token_hint'))}</p>
          ${token ? `<button type="button" class="btn" data-token-clear>${esc(t('alerts.token_clear'))}</button>` : ''}
        </form>
        </details>
        <p class="fnote">${esc(t('alerts.rules'))}</p>
      </div>`;
  }

  function dealCard(d) {
    const it = { item_id: d.item_id, name_zh: d.name, ...ITEMS.get(d.item_id) };
    const name = itemName(it);
    const other = lang === 'en' ? it.name_zh : it.name_en;
    const sub = [other, d.item_id].filter((x, i, all) => x && String(x) !== name && all.indexOf(x) === i).join(' · ');
    const where = d.location ? loc(d.location.channel, d.location.room) : loc(null);
    const counts = t('alerts.counts', { shops: d.shops, listings: d.listing_count, qty: d.listed_quantity, q1: meso(d.q1) });
    const basis = lang === 'en' ? BASIS_EN : d.basis;
    const bundle = d.bundle > 1 ? t('alerts.bundle', { n: d.bundle, cost: meso(d.bundle_cost) }) + ' · ' : '';
    return `<article class="well dcard" data-deal="${esc(d.id)}">
      <div class="wc-head">${icon(it.icon_url, 32)}<a class="wc-name" href="/item/${Number(d.item_id)}"><b>${esc(name)}</b><small>${esc(sub)}</small></a>
        <span class="dc-margin" title="${esc(t('alerts.after_fee', { pct: pct(d.margin) }))}">${esc(pct(d.margin))}</span></div>
      <div class="wc-nums">
        <span><small>${esc(t('alerts.buy'))}</small><b>${meso(d.buy)}</b><em>${esc(bundle + t('alerts.stock', { n: d.stock }))}</em></span>
        <span class="hit"><small>${esc(d.fast_sell==null?text('旧版参考售价','Legacy reference'):t('alerts.fast'))}</small><b>${meso(d.fast_sell??d.sell)}</b><em>${esc(t('alerts.after_fee', { pct: pct(d.margin) }))}</em></span>
        <span><small>${esc(t('alerts.normal'))}</small><b>${meso(d.normal_sell)}</b><em>${esc(t('alerts.after_fee', { pct: pct(d.normal_margin) }))}</em></span>
      </div>
      <div class="dc-where"><span class="ss">${esc(d.shop)}</span>${where}<time title="${esc(fullTime(d.observed))}">${esc(t('alerts.found', { ago: ago(d.observed) }))}</time></div>
      ${historyView||now()-d.observed>120?`<p class="deal-history-note">${text('历史发现，请在游戏中重新核对库存与价格。','Historical find; verify stock and price in game.')}</p>`:''}<p class="dc-basis"><b>${esc(counts)}</b><span>${esc(basis)}</span></p></article>`;
  }

  function listView() {
    const chips = HOURS.map((h) => `<button type="button" class="chip ${h === hours ? 'on' : ''}" aria-pressed="${h === hours}" data-hours="${h}">${esc(t('alerts.window_' + h))}</button>`).join('');
    const notice = problem === 'limited' ? t('alerts.limited') : problem === 'failed' ? t('alerts.failed') : '';
    const checked = checkedAt ? t('alerts.checked', { time: new Date(checkedAt * 1000).toLocaleTimeString() }) : '';
    const shown=historyView?mergeHistory(profile?.archive,[],now()).slice(0,historyLimit):deals;
    const body = shown.length ? `<div class="wcards">${shown.map(dealCard).join('')}</div>` : emptyState(first ? t('common.loading') : historyView?text('还没有保存的采集提醒历史。','No saved deal history yet.'):t('alerts.empty'), 3, !first);
    return `<div class="stall-bar"><h1>${esc(t('alerts.title'))}</h1><span class="bar-meta">${esc(historyView?text(`${profile?.archive.length||0} 条 · 保留24小时`,`${profile?.archive.length||0} · kept for 24 h`):t('alerts.meta', { n: deals.length }))}</span></div>
      ${controls()}${statusView()}
      <p class="sale-note">${lang==='en' ? 'Collect uses your collector’s non-equipment margin rules. For any item with a personal price cap, use Watch. Watch settings are saved only in this browser.' : '采集使用你的采集器规则筛选非装备价差；需要为任意物品设置个人价格上限，请使用「关注」。关注设置仅存当前浏览器。'}</p>
      <div class="ltools atools"><span class="alabel">${esc(t('alerts.window'))}</span><div class="chips">${chips}</div><span class="sp"></span><span class="astatus" role="status">${esc(notice || checked)}</span></div>
      ${body}${historyView&&profile.archive.length>historyLimit?`<button class="more" data-history-more>${text('显示更多历史','Show more history')} (${historyLimit}/${profile.archive.length})</button>`:''}
      <p class="sale-note">${esc(t('alerts.rules'))}</p>`;
  }

  function render() {
    // Re-rendering the setup form would wipe a half-typed token.
    if (panel.contains(document.activeElement) && document.activeElement.matches('[data-token-input]')) return;
    const active=document.activeElement;const focusField=panel.contains(active)?['data-deal-setting','data-alert-view','data-hours','data-notification-allow'].find(key=>active.hasAttribute(key)):null;const focusValue=focusField?active.getAttribute(focusField):null;
    panel.innerHTML = !connected() || problem === 'invalid' ? setupView(problem === 'invalid' ? t('alerts.token_invalid') : '') : listView();
    if(focusField)panel.querySelector(`[${focusField}="${CSS.escape(focusValue)}"]`)?.focus({preventScroll:true});
  }

  async function lookupItems(list) {
    const missing = [...new Set(list.map((d) => d.item_id))].filter((id) => !ITEMS.has(id)).slice(0,30);
    for (const id of missing) {
      try {
        const { data } = await getJson(api.watchCatalog() + qs({ q: id }));
        const hit = (data.items || []).find((x) => x.item_id === id);
        ITEMS.set(id, hit || {});
      } catch { ITEMS.set(id, {}); }
    }
    if (missing.length && !stopped) render();
  }

  function controls(){
    const settings=profile?.settings||{enabled:true,page:true,desktop:true};
    const permission=typeof Notification==='undefined'?'unsupported':Notification.permission;
    return `<div class="deal-toolbar"><div class="chips" role="group" aria-label="${text('采集记录','Deal records')}"><button class="chip ${historyView?'':'on'}" data-alert-view="live" aria-pressed="${!historyView}">${text('最新发现','Live finds')}</button><button class="chip ${historyView?'on':''}" data-alert-view="history" aria-pressed="${historyView}">${text('24小时历史','24 h history')} ${profile?.archive.length||0}</button></div><div class="deal-switches"><label><input type="checkbox" data-deal-setting="enabled" ${settings.enabled?'checked':''}>${text('启用采集提醒','Enable deal alerts')}</label><label><input type="checkbox" data-deal-setting="page" ${settings.page?'checked':''} ${settings.enabled?'':'disabled'}>${text('页面弹窗','Page popups')}</label><label><input type="checkbox" data-deal-setting="desktop" ${settings.desktop?'checked':''} ${settings.enabled?'':'disabled'}>${text('桌面通知','Desktop notifications')}</label>${permission==='default'?`<button class="btn" data-notification-allow>${text('允许桌面通知','Allow desktop notifications')}</button>`:''}</div><p class="deal-help">${text('历史和开关仅保存在此浏览器，按采集身份区分。关闭提醒仍会记录历史。','History and switches stay in this browser, separated by collector identity. Muting alerts still records history.')} ${permission==='denied'?text('桌面通知被浏览器阻止，可在网站权限中开启。','Desktop notifications are blocked in site permissions.'):permission==='unsupported'?text('此浏览器不支持桌面通知。','This browser does not support desktop notifications.'):''}${storageOkay?'':text('浏览器无法保存，当前仅在本页临时保留。','Browser storage is unavailable; changes last only for this page.')}</p></div>`;
  }
  function statusView(){
    const status=collectorStatus;if(!status)return '';
    const health=status.connection_health||{};const location=status.location||health.location;
    const labels={no_game:['尚无游戏频道连接，请启动游戏并切换频道','No game channel connection; start the game and change channel'],no_inbound:['游戏已连接但未收到入站包，请检查代理或防火墙策略','Game connected but no inbound packets; check proxy or firewall policy'],offline:['采集器未运行或状态已过期','Collector offline or status expired'],waiting:['等待游戏连接','Waiting for game connection'],handshake:['等待重新连接游戏','Reconnect the game to capture its handshake'],connected:['游戏已连接，等待新摊位记录','Game connected; waiting for a new shop'],capturing:['已记录新的摊位商品','New shop items recorded'],parse_error:['解析异常，需要重连游戏','Decode error; reconnect the game'],observed:['已收到你的商品观察','Your shop observations were received'],no_observations:['尚未收到你的商品观察','No observations received from your collector']};
    const label=labels[health.state]||[health.message||'采集状态待确认',health.message_en||'Collector status unconfirmed'];
    return `<div class="collector-status" role="status"><b>${text(...label)}</b><span>${location?esc(text('最近位置：','Last location: '))+loc(location.channel,location.room):text('位置待识别','Location unknown')}</span>${status.last_shop_at?`<span>${text('最近商品：','Last shop: ')}<time data-relative-time="${Number(status.last_shop_at)}" title="${esc(fullTime(status.last_shop_at))}">${esc(ago(status.last_shop_at))}</time></span>`:''}<small>${status.local_collector?text('本机采集状态','Capture status from this PC'):text('根据服务端接收记录；不能据此确认本机驱动仍在运行。','Based on received observations; this does not confirm the local capture process is running.')}</small></div>`;
  }
  function announce(list) {
    const fresh=list.filter(d=>!seen.has(d.id)&&now()-d.observed<=120&&d.observed<=now());
    for(const deal of list)seen.add(deal.id);
    profile.archive=mergeHistory(profile.archive,list,now());persist();
    if(first||!profile.settings.enabled)return;
    for(const d of fresh.slice(0,5)){
      const name=itemName({item_id:d.item_id,name_zh:d.name,...ITEMS.get(d.item_id)});
      const line=t('alerts.toast_line',{buy:meso(d.buy),sell:meso(d.fast_sell),pct:pct(d.margin)});
      const where=d.location?loc(d.location.channel,d.location.room):loc(null);
      if(profile.settings.page)toast({title:t('alerts.toast_title'),href:`/item/${Number(d.item_id)}`,html:`<b>${esc(name)}</b><span>${esc(line)}</span><span class="tmeta"><span class="ss">${esc(d.shop)}</span>${where}</span>`});
      if(profile.settings.desktop)notify(t('alerts.toast_title'),`${name} · ${line} · ${d.shop}`,d.id);
    }
  }

  async function check() {
    if (stopped || !connected() || !profile) return;
    if(busy){pending=true;return;}
    clearTimeout(retryTimer);
    busy = true;const epoch=revision;
    controller = new AbortController();
    const deadline = setTimeout(() => controller.abort(), 10000);
    try {
      const res = await fetch(`/api/v1/collector/alerts${qs({ hours })}`, {
        headers: { Accept: 'application/json', ...(token?{Authorization:`Bearer ${token}`}:{}) },
        credentials: 'same-origin', cache: 'no-store', signal: controller.signal,
      });
      if (res.status === 401) { problem = 'invalid'; return; }
      if (res.status === 429) { problem = 'limited'; return; }
      if (!res.ok) { problem = 'failed'; return; }
      const data = await res.json();
      if(stopped||epoch!==revision) return;
      deals = Array.isArray(data.opportunities) ? data.opportunities : [];
      checkedAt = data.generated_at ?? Date.now() / 1000;
      problem = null;failures=0;
      if(data.collector_id&&!profile.archive.length){const legacy=loadProfile(storage,namespace,now(),data.collector_id);profile.archive=legacy.archive;if(!profile.remembered)profile.settings=legacy.settings;for(const row of profile.archive)seen.add(row.id);}
      announce(deals);
      lookupItems(deals);
      first = false;
      refreshStatus();
    } catch (e) {
      if(epoch===revision && !stopped)problem='failed';
    } finally {
      clearTimeout(deadline);
      busy = false;
      if (!stopped) render();
      if(pending&&!stopped){pending=false;check();}
      else if(!stopped && (problem==='failed'||problem==='limited'))retryTimer=setTimeout(check,Math.min(15000,500*2**Math.min(failures++,5)));
    }
  }

  // Each committed market change triggers an authenticated personal refresh.
  const unsubscribe = subscribeMarket(() => check());
  let statusExpiry=null;
  const stopStatus=subscribeCollector(status=>{if(localCollector&&status.collector_id===collectorStatus?.collector_id){const changed=JSON.stringify([collectorStatus.connection_health,collectorStatus.location,collectorStatus.last_shop_at])!==JSON.stringify([status.connection_health,status.location,status.last_shop_at]);collectorStatus=status;clearTimeout(statusExpiry);statusExpiry=setTimeout(()=>{if(!stopped&&collectorStatus?.connection_health){collectorStatus.connection_health={state:'offline'};render();}},12000);if(changed)render();}});
  const onVisible = () => {
    if (document.visibilityState === 'visible' && connected()) check();
  };
  document.addEventListener('visibilitychange', onVisible);

  async function refreshStatus(){
    if(!connected())return;
    const epoch=revision;
    try{const response=await fetch('/api/v1/collector/status',{headers:{...(token?{Authorization:`Bearer ${token}`}:{})},cache:'no-store',signal:AbortSignal.timeout(5000)});if(response.ok){const status=await response.json();if(!stopped&&epoch===revision){collectorStatus=status;render();}}}catch{}
  }
  async function setToken(next){
    revision++;controller?.abort();clearTimeout(retryTimer);clearTimeout(historyExpiry);token=next;localCollector=false;collectorStatus=null;namespace=null;profile=null;
    try{if(next)localStorage.setItem(TOKEN_KEY,next);else localStorage.removeItem(TOKEN_KEY);}catch{}
    problem=null;first=true;deals=[];historyView=false;seen.clear();
    if(next)await openProfile();render();if(connected())check();
  }

  panel.addEventListener('submit', (e) => {
    if (!e.target.closest('[data-token-form]')) return;
    e.preventDefault();
    const input = panel.querySelector('[data-token-input]');
    const value = input.value.trim();
    input.value = '';
    if (!validToken(value)) {
      input.setCustomValidity(t('alerts.token_bad'));
      input.reportValidity();
      input.addEventListener('input', () => input.setCustomValidity(''), { once: true });
      return;
    }
    input.blur();
    setToken(value);
  });
  panel.addEventListener('click', (e) => {
    const view=e.target.closest('[data-alert-view]');if(view){historyView=view.dataset.alertView==='history';historyLimit=24;profile.archive=mergeHistory(profile.archive,[],now());persist();render();lookupItems(historyView?profile.archive.slice(0,historyLimit):deals);return;}
    if(e.target.closest('[data-history-more]')){historyLimit+=24;render();lookupItems(profile.archive.slice(0,historyLimit));return;}
    if(e.target.closest('[data-notification-allow]')){Notification.requestPermission().then(()=>{if(!stopped)render();});return;}
    if (e.target.closest('[data-token-clear]')) return setToken(null);
    const chip = e.target.closest('[data-hours]');
    if (chip && chip.dataset.hours !== hours) {
      hours = chip.dataset.hours;
      const url = new URL(location.href);
      if (hours === 'all') url.searchParams.set('hours', 'all'); else url.searchParams.delete('hours');
      history.replaceState(history.state, '', url);
      first = true;
      render();
      controller?.abort();
      revision++;
      check();
    }
    return undefined;
  });
  // The collector page in another tab may issue or drop the token.
  const onStorage = (e) => { if (e.key === TOKEN_KEY && e.newValue !== token) setToken(e.newValue); };
  addEventListener('storage', onStorage);

  panel.addEventListener('change',event=>{const field=event.target.dataset.dealSetting;if(profile&&['enabled','page','desktop'].includes(field)){profile.settings[field]=event.target.checked;persist();render();}});
  if(token)await openProfile();
  else if(['localhost','127.0.0.1'].includes(location.hostname)&&!['8766','8765'].includes(location.port)){
    try{const response=await fetch('/api/v1/collector/status',{cache:'no-store',signal:AbortSignal.timeout(3000)});if(response.ok){collectorStatus=await response.json();localCollector=collectorStatus.local_collector===true;if(localCollector)await openProfile(collectorStatus.collector_id);}}catch{}
  }
  render();
  if(connected())check();

  return () => {
    stopped = true;
    clearTimeout(retryTimer);clearTimeout(historyExpiry);
    unsubscribe();stopStatus();clearTimeout(statusExpiry);
    controller?.abort();
    document.removeEventListener('visibilitychange', onVisible);
    removeEventListener('storage', onStorage);
  };
}

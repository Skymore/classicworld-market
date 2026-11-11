import config from './config.js';
import {allowedURL, readMarketJSON} from './protocol.js';

let running = false;
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

async function local(path, body) {
  const response = await fetch(config.endpoint + path, {
    method: body ? 'POST' : 'GET',
    headers: {Authorization: `Bearer ${config.token}`, ...(body ? {'Content-Type': 'application/json'} : {})},
    ...(body ? {body: JSON.stringify(body)} : {}),
    signal: AbortSignal.timeout(20000),
  });
  if (!response.ok) throw new Error('local_bridge_unavailable');
  return response.json();
}

async function syncTab() {
  const {tabId} = await chrome.storage.session.get('tabId');
  let tab;
  if (Number.isInteger(tabId)) {
    try { tab = await chrome.tabs.get(tabId); } catch { /* user closed it */ }
  }
  if (!tab || !tab.url?.startsWith('https://meso.watch/')) {
    tab = await chrome.tabs.create({url: 'https://meso.watch/', active: false});
    await chrome.storage.session.set({tabId: tab.id});
  }
  for (let n = 0; n < 45; n++) {
    tab = await chrome.tabs.get(tab.id);
    if (tab.status === 'complete') return tab;
    await pause(1000);
  }
  throw new Error('market_page_not_ready');
}

async function status(text, badge) {
  await chrome.action.setBadgeText({text: badge});
  await chrome.action.setTitle({title: `MesoWatch 同步：${text}`});
  await chrome.storage.local.set({status: text, updatedAt: Date.now()});
}

async function pump() {
  if (running) return;
  running = true;
  const deadline = Date.now() + 24000;
  try {
    do {
      const job = await local('/next');
      if (!job.id) { await status('已连接，等待本机任务', ''); break; }
      if (!allowedURL(job.url)) throw new Error('unexpected_job');
      let result;
      try {
        const tab = await syncTab();
        const responses = await chrome.scripting.executeScript({
          target: {tabId: tab.id}, world: 'ISOLATED', func: readMarketJSON, args: [job.url],
        });
        result = responses[0]?.result || {error: 'no_result'};
      } catch { result = {error: 'browser_read_failed'}; }
      await local('/result', {...result, id: job.id});
      if (result.error || result.status !== 200) {
        await status('浏览器需要处理，请打开同步页', '!');
        break;
      }
      await status('正在同步', '↻');
    } while (Date.now() < deadline);
  } catch {
    await status('等待本机同步服务', '');
  } finally { running = false; }
}

async function start() {
  if (!await chrome.alarms.get('mesowatch')) {
    await chrome.alarms.create('mesowatch', {periodInMinutes: 0.5});
  }
  await pump();
}
chrome.runtime.onInstalled.addListener(start);
chrome.runtime.onStartup.addListener(start);
chrome.alarms.onAlarm.addListener(alarm => { if (alarm.name === 'mesowatch') pump(); });
chrome.action.onClicked.addListener(async () => {
  const tab = await syncTab();
  await chrome.tabs.update(tab.id, {active: true});
  await pump();
});

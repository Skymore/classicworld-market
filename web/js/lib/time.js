import { t } from './i18n.js';
import { ago, fullTime } from './format.js';
let timer;
export function refreshTimes(root = document) {
  for(const el of root.querySelectorAll('[data-fresh][data-as-of]')) {
    const timestamp=Number(el.dataset.asOf), relative=ago(timestamp);
    const label=relative===t('time.just_now')?t('fresh.just_now'):t('fresh.updated',{ago:' '+relative});
    const text=el.querySelector('span'); if(text && text.textContent!==label) text.textContent=label;
    el.title=fullTime(timestamp);
  }
  for (const el of root.querySelectorAll('[data-relative-time]')) {
    const ts=Number(el.dataset.relativeTime);
    const label=ago(ts);
    if(el.textContent!==label) el.textContent=label;
    el.title=fullTime(ts);
  }
  for (const el of root.querySelectorAll('[data-local-time]')) {
    const label=fullTime(Number(el.dataset.localTime));
    if(el.textContent!==label) el.textContent=label;
  }
}
export function bindClock() {
  refreshTimes();
  if(!timer) timer=setInterval(()=>refreshTimes(),30000);
}

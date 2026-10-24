import { userStorage as localStorage } from './user-data.js';
import { bindClock } from './time.js';
import { bindQuickSearch } from './quick-search.js?v=20261024-search-tap-1';
// Shared chrome and components ported from design/mockups-v2/mock.html.
// Both the phone top bar + dock and the desktop header are rendered; base.css
// shows one of them per html[data-device]. Pages render into <main>.
import { I } from './icons.js';
import { t, lang, setLang } from './i18n.js';
import { ago, esc } from './format.js';
import { bindLocalNavigation } from './local-nav.js?v=20261023-header-icons-2';

let stopQuickSearch = () => {};
export function renderChrome(root, active) {
  if(root.dataset.chromeLang===lang && root.querySelector('main')) {
    root.querySelector('main').replaceWith(Object.assign(document.createElement('main'),{className:'pmain dwrap',id:'main'}));
    bindLocalNavigation(root,active);
    setBadge('watch',watchHits());
    return;
  }
  stopQuickSearch();
  root.dataset.chromeLang=lang;
  const brand = (size) => `<a class="brand" href="/">${I.leaf(size)}<span>${t('brand')}</span></a>`;
  root.innerHTML = `
    <header class="ptop">${brand(22)}<span class="fresh" data-fresh hidden><i></i><span></span></span>${prefsButtons()}</header>
    <header class="dhead"><div class="in">${brand(26)}<nav class="dnav" aria-label="${t('nav.main')}"></nav>
      <form class="finder" action="/search" method="get" role="search">${I.search}<input type="search" name="q" placeholder="${t('search.placeholder')}" aria-label="${t('search.label')}"><kbd>/</kbd></form>
      <span class="fresh" data-fresh hidden><i></i><span></span></span>${prefsButtons()}</div></header>
    <main class="pmain dwrap" id="main"></main>
    <nav class="dock" aria-label="${t('nav.main')}"></nav>`;
  bindLocalNavigation(root, active);
  stopQuickSearch = bindQuickSearch(root);
  bindClock();
  root.querySelectorAll('[data-theme-toggle]').forEach((b) => b.addEventListener('click', toggleTheme));
  root.querySelectorAll('[data-lang-toggle]').forEach((b) => b.addEventListener('click', () => setLang(lang === 'zh' ? 'en' : 'zh')));
  // "/" focuses the first visible search box (the header one; the hero one on
  // the home page, where the header box is hidden), as the <kbd>/</kbd> promises.
  document.onkeydown = (e) => {
    if (e.key === '/' && !/INPUT|TEXTAREA|SELECT/.test(document.activeElement?.tagName)) {
      const box = [...root.querySelectorAll('input[type=search]')].find((el) => el.offsetParent !== null);
      if (!box) return;
      e.preventDefault();
      box.focus();
    }
  };
  setBadge('watch', watchHits());
  listenWatchlist();
}

// The dock badge is the number of watched items that have a listing under
// their cap (the mockup's `under_cap > 0`). Only the watch page can compute
// it, so it stores the count (`setWatchHits`); any watchlist change clears
// it until the next visit to /watch rather than showing a stale number.
const HITS_KEY = 'watch_hits';
export function watchHits() {
  try { return Number(localStorage.getItem(HITS_KEY)) || 0; } catch { return 0; }
}
export function setWatchHits(n) {
  try { localStorage.setItem(HITS_KEY, String(n)); } catch { /* private mode */ }
  setBadge('watch', n);
}
let listening = false;
function listenWatchlist() {
  if (listening) return;
  listening = true;
  document.addEventListener('watchchange', () => {
    try { localStorage.removeItem(HITS_KEY); } catch { /* private mode */ }
    setBadge('watch', 0);
  });
  addEventListener('storage', (e) => { if (e.key === HITS_KEY || e.key === 'watchlist') setBadge('watch', watchHits()); });
}

function prefsButtons() {
  const language = lang === 'zh' ? '切换语言 / English' : 'Switch language / 中文';
  return `<span class="prefs"><button type="button" class="iconbtn" data-lang-toggle aria-label="${language}" title="${language}"><span class="pref-glyph pref-language" aria-hidden="true"></span></button><button type="button" class="iconbtn" data-theme-toggle aria-label="${t('theme.toggle')}" title="${t('theme.toggle')}"><span class="pref-glyph pref-theme" aria-hidden="true"></span></button></span>`;
}

function toggleTheme() {
  const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
  try { localStorage.setItem('theme', next); } catch { /* private mode */ }
  document.documentElement.dataset.theme = next;
}

// Pages call this with the dataset's `as_of` (unix seconds) after each load.
export function setFreshness(asOf) {
  if (asOf == null) delete document.documentElement.dataset.freshness;
  else document.documentElement.dataset.freshness = String(asOf);
  document.dispatchEvent(new CustomEvent('market-freshness', { detail: asOf }));
  for (const el of document.querySelectorAll('[data-fresh]')) {
    el.hidden = asOf == null;
    if(asOf != null) el.dataset.asOf=String(asOf); else delete el.dataset.asOf;
    if (asOf == null) continue;
    const rel = ago(asOf);
    el.querySelector('span').textContent = rel === t('time.just_now') ? t('fresh.just_now') : t('fresh.updated', { ago: ' ' + rel });
    el.title = new Date(asOf * 1000).toLocaleString();
  }
}

export function setBadge(key, n) {
  document.dispatchEvent(new CustomEvent('navigation-badge', { detail: { key, count: n } }));
  for (const el of document.querySelectorAll(`[data-badge="${key}"]`)) {
    el.hidden = !n;
    el.textContent = n || '';
  }
}

// A game-window panel: title bar + body. `opts.more = [label, href]`.
export function stall(title, body, opts = {}) {
  const tag = opts.h1 ? 'h1' : 'h2';
  const meta = opts.meta ? `<span class="bar-meta">${opts.meta}</span>` : '';
  const more = opts.more ? `<a class="bar-more" href="${esc(opts.more[1])}">${esc(opts.more[0])} ${I.chev}</a>` : '';
  return `<section class="stall ${opts.cls || ''}"><div class="stall-bar"><${tag}>${title}</${tag}>${meta}${more}${opts.barExtra || ''}</div><div class="stall-body">${body}</div></section>`;
}

// Tabs markup: `keys` -> `titles[key]`, `panes[key]()` renders lazily on first
// show. Call `bindTabs(container)` after inserting the markup.
export function tabsBlock(keys, titles, panes, active, paneCls = '') {
  return `<div class="tabs" role="tablist">${keys.map((k) => `<button type="button" class="tab ${k === active ? 'on' : ''}" role="tab" aria-selected="${k === active}" tabindex="${k === active ? 0 : -1}" data-tab="${k}">${titles[k]}</button>`).join('')}</div>
    ${keys.map((k) => `<div class="pane ${paneCls}" role="tabpanel" data-pane="${k}" ${k === active ? '' : 'hidden'}>${k === active ? panes[k]() : ''}</div>`).join('')}`;
}

// Left / right arrows move between tabs (WAI-ARIA tabs pattern); only the
// selected tab is in the Tab order.
export function bindTabs(container, panes, onChange) {
  container.addEventListener('keydown', (e) => {
    const btn = e.target.closest('[data-tab]');
    if (!btn || (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight')) return;
    const all = [...btn.closest('.tabs').querySelectorAll('[data-tab]')];
    const next = all[(all.indexOf(btn) + (e.key === 'ArrowRight' ? 1 : all.length - 1)) % all.length];
    e.preventDefault();
    next.focus();
    next.click();
  });
  container.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-tab]');
    if (!btn || !container.contains(btn)) return;
    const key = btn.dataset.tab;
    const list = btn.closest('.tabs');
    for (const b of list.querySelectorAll('[data-tab]')) {
      const on = b === btn;
      b.classList.toggle('on', on);
      b.setAttribute('aria-selected', String(on));
      b.tabIndex = on ? 0 : -1;
    }
    for (const pane of list.parentElement.querySelectorAll(':scope > [data-pane]')) {
      const on = pane.dataset.pane === key;
      pane.hidden = !on;
      if (on && !pane.innerHTML.trim() && panes?.[key]) pane.innerHTML = panes[key]();
    }
    onChange?.(key);
  });
}

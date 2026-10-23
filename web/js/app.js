// Entry of the redesigned UI. The server returns web/index.html for every
// page route below; this file picks the page module by path and mounts it.
// Page modules live in ./pages/<name>.js and export `mount(root, ctx)`
// returning an optional cleanup function. Shared chrome (top bar, dock) is
// rendered by ./lib/chrome.js so pages only render their own content.
import { renderChrome } from './lib/chrome.js?v=20261023-header-icons-2';
import { lang } from './lib/i18n.js';
import './lib/item-preview.js?v=20261023-header-icons-2';

// path prefix -> page module. Order matters: first match wins.
const PAGES = [
  ['/privacy', 'privacy'],
  ['/account', 'account'],
  ['/contributors', 'contributors'],
  ['/selling', 'selling'],
  ['/prices', 'prices'],
  ['/sales', 'sales'],
  ['/watch', 'watch'],
  ['/alerts', 'alerts'],
  ['/v2/prices', 'prices'],
  ['/v2/sales', 'sales'],
  ['/v2/watch', 'watch'],
  ['/v2/alerts', 'alerts'],
  ['/v2', 'home'],
  ['/', 'home'],
];

function pageFor(pathname) {
  const path = pathname.replace(/\/+$/, '') || '/';
  for (const [prefix, name] of PAGES) {
    if (path === prefix || (prefix !== '/' && path.startsWith(prefix + '/'))) return name;
  }
  return 'home';
}

// Page stylesheet next to base.css. Loaded in parallel with the page module
// and awaited before mount, so the first paint is already styled.
const PAGE_CSS = { privacy:'account', account:'account', contributors:'account', home: 'home', prices: 'prices', sales: 'lists', watch: 'lists', alerts: 'lists', selling: 'selling' };
function pageCss(name) {
  const file = PAGE_CSS[name];
  if (!file) return Promise.resolve();
  const href = `/web/css/${file}.css?v=20261023-watch-cap-1`;
  const existing = document.querySelector(`link[rel=stylesheet][href="${href}"]`);
  if (existing) return existing.sheet || existing.dataset.loaded ? Promise.resolve() : new Promise((done) => {existing.addEventListener('load', done, { once: true });existing.addEventListener('error',done,{once:true});});
  const link = document.createElement('link');
  link.rel = 'stylesheet';
  link.href = href;
  return new Promise((done) => {
    // A missing stylesheet must not block the page.
    link.addEventListener('load', () => { link.dataset.loaded = '1'; done(); }, { once: true });
    link.addEventListener('error', done, { once: true });
    document.head.append(link);
  });
}

// Layout is media queries in base.css (≤640 phone, ≥1101 desktop). The
// attribute stays for page CSS and SSR pages that still key on it.
function syncDevice() {
  const w = innerWidth;
  document.documentElement.dataset.device = w <= 640 ? 'phone' : w >= 1101 ? 'desktop' : 'tablet';
}

// `?theme=dark|light` (shared links, screenshot runs) is saved like the toggle.
function syncTheme() {
  const fromUrl = new URLSearchParams(location.search).get('theme');
  let theme = fromUrl === 'dark' || fromUrl === 'light' ? fromUrl : null;
  try {
    if (theme) localStorage.setItem('theme', theme);
    else theme = localStorage.getItem('theme');
  } catch { /* private mode */ }
  if (theme !== 'dark' && theme !== 'light') theme = matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  document.documentElement.dataset.theme = theme;
}

let cleanup = null;
let generation = 0;
const prepared=new Map();
function preparePage(name) {
  if(!prepared.has(name)) prepared.set(name,Promise.all([
    import(`./pages/${name}.js?v=20261023-header-icons-2`),pageCss(name),
  ]).catch(error=>{prepared.delete(name);throw error;}));
  return prepared.get(name);
}
async function mount() {
  if(['/sales','/v2/sales'].includes(location.pathname.replace(/\/+$/, ''))) {
    const url=new URL(location.href);url.pathname='/prices';url.searchParams.set('tab','sales');
    history.replaceState(history.state,'',url);
  }
  const name = pageFor(location.pathname);
  const titles=lang==='en'?{privacy:'Account privacy',account:'My profile',contributors:'Contributors',home:'Home',prices:'Prices',watch:'Watch',alerts:'Deals',selling:'Bag & shop'}:{privacy:'账号隐私说明',account:'我的',contributors:'采集贡献榜',home:'首页',prices:'价格表',watch:'关注',alerts:'捡漏',selling:'背包与摆摊'};
  document.title=`${titles[name]||titles.home} · ${lang==='en'?'Maple Market':'枫叶市集'}`;

  const root = document.getElementById('app');
  const mine = ++generation;
  cleanup?.();
  cleanup = null;
  delete document.documentElement.dataset.ready;
  document.documentElement.dataset.page = name;
  renderChrome(root, name);
  const main = root.querySelector('main');
  main.setAttribute('aria-busy','true');
  main.innerHTML=`<section class="stall"><div class="stall-bar"><h1>${titles[name]||titles.home}</h1></div><p class="note" role="status">${lang==='en'?'Loading…':'加载中…'}</p></section>`;
  let done = null;
  try {
    const [mod] = await preparePage(name);
    if(mine!==generation) return;
    done = (await mod.mount(main, { page: name, lang })) || null;
  } catch (e) {
    if(mine!==generation) return;
    console.error(e);
    main.textContent = 'Failed to load page.';
  }
  // Another navigation started while this page loaded: stop this one's timers.
  if (mine !== generation) { done?.(); return; }
  cleanup = done;
  main.removeAttribute('aria-busy');
  document.documentElement.dataset.ready = '1';
}

syncDevice();
syncTheme();
addEventListener('resize', syncDevice);
addEventListener('popstate', mount);
document.addEventListener('langchange', mount);
document.addEventListener('themechange', syncTheme);
// Same-origin page links navigate without a reload. Links into the SSR pages
// (/item, /mob, /map, /route, /search) are full navigations; in English they
// carry ?lang=en so the server renders the right language on first paint.
const SSR = ['/item', '/mob', '/map', '/route', '/search'];

function warmNavigation(e) {
  const a=e.target.closest('.dnav a[href],.dock a[href]');
  if(!a)return;
  const url=new URL(a.href,location.href);
  if(url.origin!==location.origin || SSR.some(p=>url.pathname===p||url.pathname.startsWith(p+'/')))return;
  if(!PAGES.some(([p])=>url.pathname===p||(p!=='/'&&url.pathname.startsWith(p+'/'))))return;
  preparePage(pageFor(url.pathname)).catch(()=>{});
}
document.addEventListener('pointerover',warmNavigation,{passive:true});
document.addEventListener('pointerdown',warmNavigation,{passive:true});
document.addEventListener('focusin',warmNavigation);
document.addEventListener('click', (e) => {
  const a = e.target.closest('a[href]');
  if (e.defaultPrevented || e.button!==0 || !a || a.target || a.hasAttribute('download') || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
  const url = new URL(a.href, location.href);
  if (url.origin !== location.origin) return;
  if(url.pathname===location.pathname && url.search===location.search) {
    if(!url.hash) e.preventDefault();
    return;
  }
  if (SSR.some((p) => url.pathname === p || url.pathname.startsWith(p + '/'))) {
    if (lang === 'en' && !url.searchParams.has('lang')) {
      url.searchParams.set('lang', 'en');
      e.preventDefault();
      location.assign(url);
    }
    return;
  }
  if (!PAGES.some(([p]) => url.pathname === p || url.pathname.startsWith(p + '/'))) return;
  e.preventDefault();
  history.pushState(null, '', url);
  mount();
});
mount();

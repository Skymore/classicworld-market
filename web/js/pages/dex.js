import { ready as userDataReady, userStorage as localStorage } from '../lib/user-data.js';
import { bindClock } from '../lib/time.js';
import '../lib/item-preview.js?v=20261023-header-icons-2';
import { bindQuickSearch } from '../lib/quick-search.js?v=20261024-search-tap-1';
// Shell of the server-rendered pages (/item, /mob, /map, /route, /search):
// what app.js does for the SPA. The server set data-device from the
// Sec-CH-UA-Mobile hint and rendered the page in ?lang= (Chinese by
// default); this corrects the layout from the viewport, applies the theme,
// and keeps the language the same as on the SPA pages.
import { lang as chosenLang, setLang } from '../lib/i18n.js';
import { bindLiveSearch } from '../lib/live-search.js?v=20261024-select-focus-1';
import { bindLocalNavigation } from '../lib/local-nav.js?v=20261023-header-icons-2';

const html = document.documentElement;
const params = new URLSearchParams(location.search);

// ≤640 phone, ≥1101 desktop (plan v1 §7), as app.js does. Android tablets
// send Sec-CH-UA-Mobile ?0, so the server may paint the desktop layout; a
// mobile browser then widens the layout viewport to fit it, and innerWidth
// grows past the screen. screen.width is the real width there.
function syncDevice() {
  const w = Math.min(innerWidth, screen.width || innerWidth);
  html.dataset.device = w <= 640 ? 'phone' : w >= 1101 ? 'desktop' : 'tablet';
}

// ?theme= (shared links, screenshots) wins over the saved choice.
function syncTheme() {
  const asked = params.get('theme');
  let theme = asked === 'dark' || asked === 'light' ? asked : null;
  if (!theme) {
    try { theme = localStorage.getItem('theme'); } catch { /* private mode */ }
  } else {
    try { localStorage.setItem('theme', theme); } catch { /* private mode */ }
  }
  if (theme !== 'dark' && theme !== 'light') theme = matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  html.dataset.theme = theme;
}

function toggleTheme() {
  const next = html.dataset.theme === 'dark' ? 'light' : 'dark';
  try { localStorage.setItem('theme', next); } catch { /* private mode */ }
  html.dataset.theme = next;
}

// An explicit ?lang= is the visitor's choice for the whole site; without it,
// a visitor who reads the SPA in English is sent to the English page.
// Returns true when the page is being replaced.
function syncLang() {
  const page = html.dataset.lang;
  if (params.has('lang')) {
    if (chosenLang !== page) setLang(page);
    return false;
  }
  if (chosenLang === page) return false;
  const url = new URL(location.href);
  if (chosenLang === 'en') url.searchParams.set('lang', 'en');
  location.replace(url);
  return true;
}

function bindChrome() {
  for (const b of document.querySelectorAll('[data-theme-toggle]')) b.addEventListener('click', toggleTheme);
  // The link already points at the other language; remember the choice too.
  for (const a of document.querySelectorAll('[data-lang-toggle]')) {
    a.addEventListener('click', () => setLang(a.dataset.langToggle));
  }
  // "/" focuses the visible search box, as the mockup's <kbd>/</kbd> promises.
  document.addEventListener('keydown', (e) => {
    if (e.key !== '/' || e.ctrlKey || e.metaKey || /INPUT|TEXTAREA|SELECT/.test(document.activeElement?.tagName)) return;
    const box = [...document.querySelectorAll('input[type=search]')].find((i) => i.offsetParent !== null);
    if (!box) return;
    e.preventDefault();
    box.focus();
  });
}

await userDataReady;
if(['zh','en'].includes(params.get('lang')))localStorage.setItem('lang',params.get('lang'));
const accountLang=localStorage.getItem('lang');
if(!params.has('lang')&&['en','zh'].includes(accountLang)&&accountLang!==chosenLang)setLang(accountLang);
syncDevice();
if (!html.dataset.reactShell) syncTheme();
if (!syncLang()) {
  addEventListener('resize', syncDevice);
  if (!html.dataset.reactShell) {
    bindChrome();
    bindLocalNavigation();
  }
  bindLiveSearch();
  // Keep search available above the item card when the desktop header is hidden.
  const itemPage = document.querySelector('.ipage, .dwrap');
  const headerSearch = document.querySelector('.dhead form.finder');
  if (itemPage && !itemPage.querySelector('#catalog-search') && headerSearch && !itemPage.querySelector('.mobile-item-search')) {
    const search = headerSearch.cloneNode(true);
    search.classList.add('mobile-item-search');
    search.querySelector('kbd')?.remove();
    search.querySelector('input').value = '';
    itemPage.prepend(search);
  }
  bindQuickSearch();
  bindClock();
  html.dataset.ready = '1';
}

window.addEventListener('user-preferences',syncTheme);

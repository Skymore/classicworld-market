import { bindLocalNavigation } from '/web/js/lib/local-nav.js?v=20261023-header-icons-2';
bindLocalNavigation();
import { bindQuickSearch } from '/web/js/lib/quick-search.js?v=20261024-search-tap-1';
bindQuickSearch();
// Header of the static collector page: the theme toggle and the "/" search
// shortcut, as web/js/pages/dex.js does for the server-rendered pages.
// boot.js has already applied the theme before the first paint.
const html = document.documentElement;

function toggleTheme() {
  const next = html.dataset.theme === 'dark' ? 'light' : 'dark';
  try { localStorage.setItem('theme', next); } catch { /* private mode */ }
  html.dataset.theme = next;
}

for (const b of document.querySelectorAll('[data-theme-toggle]')) b.addEventListener('click', toggleTheme);

document.addEventListener('keydown', (e) => {
  if (e.key !== '/' || e.ctrlKey || e.metaKey || /INPUT|TEXTAREA|SELECT/.test(document.activeElement?.tagName)) return;
  const box = [...document.querySelectorAll('input[type=search]')].find((i) => i.offsetParent !== null);
  if (!box) return;
  e.preventDefault();
  box.focus();
});

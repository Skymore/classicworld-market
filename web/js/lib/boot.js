// Classic (blocking) script in <head>: sets theme, device and language on
// <html> before the first paint, so a dark-theme visitor never sees a light
// flash. CSP forbids inline scripts, hence a file. app.js repeats the same
// logic for later changes; every page shell includes this file.
(function () {
  var html = document.documentElement;
  var query = new URLSearchParams(location.search);
  var read = function (key) { try { return localStorage.getItem(key); } catch (e) { return null; } };
  var asked = query.get('theme');
  var theme = asked === 'dark' || asked === 'light' ? asked : read('theme');
  // Remember shared-link choices before navigating to a page without ?theme=.
  if (asked === 'dark' || asked === 'light') {
    try { localStorage.setItem('theme', asked); } catch (e) { /* private mode */ }
  }
  if (theme !== 'dark' && theme !== 'light') theme = matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  html.dataset.theme = theme;
  var w = innerWidth;
  html.dataset.device = w <= 640 ? 'phone' : w >= 1101 ? 'desktop' : 'tablet';
  // A page that states its own language (<html data-lang>, as the SSR pages and /collect do) keeps it.
  var lang = query.get('lang') || read('lang');
  if (!html.dataset.lang && (lang === 'en' || lang === 'zh')) html.lang = lang === 'zh' ? 'zh-CN' : 'en';
}());

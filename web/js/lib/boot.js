// Classic (blocking) script in <head>: sets theme, device and language on
// <html> before the first paint, so a dark-theme visitor never sees a light
// flash. CSP forbids inline scripts, hence a file. app.js repeats the same
// logic for later changes; every page shell includes this file.
(function () {
  var html = document.documentElement;
  // The owner requests a fixed page scale. Some iOS browsers ignore the
  // viewport limit, so also cancel their native multi-touch zoom gestures.
  var viewport = document.querySelector('meta[name="viewport"]');
  if (viewport) viewport.setAttribute('content', 'width=device-width, initial-scale=1, minimum-scale=1, maximum-scale=1, user-scalable=no, viewport-fit=cover');
  if (html.dataset.pageZoom !== 'locked') {
    html.dataset.pageZoom = 'locked';
    var stopGestureZoom = function (event) { event.preventDefault(); };
    var stopMultiTouchZoom = function (event) {
      if (event.touches.length > 1) event.preventDefault();
    };
    var options = { capture: true, passive: false };
    document.addEventListener('gesturestart', stopGestureZoom, options);
    document.addEventListener('gesturechange', stopGestureZoom, options);
    document.addEventListener('touchstart', stopMultiTouchZoom, options);
    document.addEventListener('touchmove', stopMultiTouchZoom, options);
  }
  var query = new URLSearchParams(location.search);
  var read = function (key) { try { return localStorage.getItem(key); } catch (e) { return null; } };
  var active = read('cwm.preferences.account.v1');
  var preferences = null;
  if (active && /^[A-Za-z0-9_-]{1,128}$/.test(active)) {
    try { preferences = JSON.parse(read('cwm.user-data.v1.' + active) || '{}').values || {}; } catch (e) { preferences = {}; }
  }
  var preference = function (key) { return preferences ? preferences[key] || null : read(key); };
  var asked = query.get('theme');
  var theme = asked === 'dark' || asked === 'light' ? asked : preference('theme');
  // Remember shared-link choices before navigating to a page without ?theme=.
  if (asked === 'dark' || asked === 'light') {
    try { localStorage.setItem('theme', asked); } catch (e) { /* private mode */ }
  }
  if (theme !== 'dark' && theme !== 'light') theme = matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  html.dataset.theme = theme;
  var w = innerWidth;
  html.dataset.device = w <= 640 ? 'phone' : w >= 1101 ? 'desktop' : 'tablet';
  // A page that states its own language (<html data-lang>, as the SSR pages and /collect do) keeps it.
  var lang = query.get('lang') || preference('lang');
  if (!html.dataset.lang && (lang === 'en' || lang === 'zh')) html.lang = lang === 'zh' ? 'zh-CN' : 'en';
}());

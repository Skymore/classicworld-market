// Classic (blocking) script in <head>: sets theme, device and language on
// <html> before the first paint, so a dark-theme visitor never sees a light
// flash. CSP forbids inline scripts, hence a file. app.js repeats the same
// logic for later changes; every page shell includes this file.
(function () {
  var html = document.documentElement;
  // The owner requests a fixed page scale. The viewport limit and CSS
  // `touch-action: pan-x pan-y` on <html> (base.css) stop pinch and double-tap
  // zoom without touch listeners, so scrolling never waits for this page's
  // scripts. iOS Safari may still zoom: cancel its gesture events and the
  // second tap of a double tap. Touch tracking listeners stay passive.
  var viewport = document.querySelector('meta[name="viewport"]');
  if (viewport) viewport.setAttribute('content', 'width=device-width, initial-scale=1, minimum-scale=1, maximum-scale=1, user-scalable=no, viewport-fit=cover');
  if (html.dataset.pageZoom !== 'locked') {
    html.dataset.pageZoom = 'locked';
    var stopGestureZoom = function (event) { event.preventDefault(); };
    var options = { capture: true, passive: false };
    var watch = { capture: true, passive: true };
    document.addEventListener('gesturestart', stopGestureZoom, options);
    document.addEventListener('gesturechange', stopGestureZoom, options);
    // Leave rapid button/link taps and native text editing to their controls.
    var tapStart = null;
    var lastTap = null;
    var action = 'a,button,input,textarea,select,label,[role="button"],[role="tab"],[contenteditable]';
    var editable = 'input,textarea,select,[contenteditable]';
    var inside = function (target, selector) { return target && target.closest && target.closest(selector); };
    document.addEventListener('touchstart', function (event) {
      if (event.touches.length !== 1) { tapStart = lastTap = null; return; }
      var point = event.touches[0];
      tapStart = { x: point.clientX, y: point.clientY, at: event.timeStamp };
    }, watch);
    document.addEventListener('touchmove', function (event) {
      if (!tapStart || event.touches.length !== 1 ||
          Math.abs(event.touches[0].clientX - tapStart.x) > 12 ||
          Math.abs(event.touches[0].clientY - tapStart.y) > 12) {
        tapStart = lastTap = null;
      }
    }, watch);
    document.addEventListener('touchcancel', function () { tapStart = lastTap = null; }, watch);
    document.addEventListener('touchend', function (event) {
      var start = tapStart;
      tapStart = null;
      if (!start || event.touches.length || event.changedTouches.length !== 1 ||
          event.timeStamp - start.at > 350 || inside(event.target, action)) {
        lastTap = null;
        return;
      }
      var point = event.changedTouches[0];
      if (lastTap && event.timeStamp - lastTap.at <= 350 &&
          Math.abs(point.clientX - lastTap.x) <= 24 && Math.abs(point.clientY - lastTap.y) <= 24) {
        if (event.cancelable) event.preventDefault();
        lastTap = null;
      } else lastTap = { x: point.clientX, y: point.clientY, at: event.timeStamp };
    }, options);
    document.addEventListener('dblclick', function (event) {
      if (!inside(event.target, editable) &&
          (matchMedia('(pointer:coarse)').matches || event.sourceCapabilities && event.sourceCapabilities.firesTouchEvents)) {
        if (event.cancelable) event.preventDefault();
      }
    }, options);
  }
  var query = new URLSearchParams(location.search);
  var read = function (key) { try { return localStorage.getItem(key); } catch (e) { return null; } };
  var active = read('cwm.preferences.account.v1');
  var preferences = null;
  if (active && /^[A-Za-z0-9_-]{1,128}$/.test(active)) {
    try { preferences = JSON.parse(read('cwm.user-data.v1.' + active) || '{}').values || {}; } catch (e) { preferences = {}; }
  }
  var preference = function (key) { return preferences ? preferences[key] || null : read(key); };
  // `?theme=` / `?lang=` hold for this tab (sessionStorage), so links inside
  // the collector window's embedded page keep the window's theme and language.
  var view = function (key, value) {
    try {
      if (value) sessionStorage.setItem('cwm.view.' + key, value);
      return sessionStorage.getItem('cwm.view.' + key);
    } catch (e) { return value || null; }
  };
  // Theme and language follow the browser / system. `?theme=` / `?lang=` apply
  // to this tab only (shared links, the collector window); an explicit choice
  // from the page's switches (`uiTheme` / `uiLang`) is kept only while it
  // differs from the system. Older saved `theme` / `lang` values are ignored.
  var asked = query.get('theme');
  asked = view('theme', asked === 'dark' || asked === 'light' ? asked : null);
  var dark = matchMedia('(prefers-color-scheme: dark)').matches;
  var light = matchMedia('(prefers-color-scheme: light)').matches;
  var hour = new Date().getHours();
  // A system that states no preference: dark from 19:00 to 07:00 local time.
  var system = dark ? 'dark' : light ? 'light' : (hour >= 19 || hour < 7 ? 'dark' : 'light');
  var theme = asked === 'dark' || asked === 'light' ? asked : preference('uiTheme');
  if (theme !== 'dark' && theme !== 'light') theme = system;
  html.dataset.theme = theme;
  var w = innerWidth;
  html.dataset.device = w <= 640 ? 'phone' : w >= 1101 ? 'desktop' : 'tablet';
  var known = function (l) { return l === 'zh' || l === 'en' || l === 'ko'; };
  var browser = null;
  var nav = typeof navigator === 'undefined' ? {} : navigator;
  var tags = nav.languages && nav.languages.length ? nav.languages : (nav.language ? [nav.language] : []);
  for (var i = 0; i < tags.length && !browser; i++) {
    var code = String(tags[i]).toLowerCase();
    browser = code.indexOf('zh') === 0 ? 'zh' : code.indexOf('ko') === 0 ? 'ko' : code.indexOf('en') === 0 ? 'en' : null;
  }
  if (!browser && tags.length) browser = 'en';
  var lang = view('lang', known(query.get('lang')) ? query.get('lang') : null);
  if (!known(lang)) lang = preference('uiLang');
  // No browser language: the server-rendered page's own language until the IP guess arrives.
  if (!known(lang)) lang = browser || html.dataset.lang || 'zh';
  html.dataset.langResolved = lang;
  html.lang = lang === 'zh' ? 'zh-CN' : lang;
  html.dataset.lang = lang;
}());

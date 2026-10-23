// A clock for the capture loop. A page's own timers slow to once a second
// while the page is hidden (the game is in front); a worker's do not.
let timer = null;
onmessage = (ev) => {
  clearInterval(timer);
  const ms = Number(ev.data && ev.data.every) || 0;
  timer = ms > 0 ? setInterval(() => postMessage(0), ms) : null;
};

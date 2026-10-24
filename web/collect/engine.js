// Screen collector page. The frames never leave this PC: the main thread
// finds the shop window 8 times a second (WASM find_window), the worker
// reads the rows (WASM Reader), and only the structured shop rows are posted
// to /api/v1/upload once a shop's content has been stable for 2 s.
import init, { find_window as findWindow, version } from './pkg/market_reader_wasm.js?v=20261023-channels-v2';

const TICK_MS = 125;          // window finding, 8 frames a second
const IDLE_SEND_MS = 1000;    // with no shop open, one frame a second still goes to the worker (channel menu, map)
const RING = 6;               // frames kept for a problem report, one a second
const RING_EVERY_MS = 1000;
const MAX_W = 3840;           // a larger frame is the browser's own enlargement: drawn smaller by a whole number
const TOKEN_KEY = 'cwm.collector.token';
const RETRY_MS = [5000, 15000, 60000, 300000];

export function createCollector() {
let disposed=false;const lifetime=new AbortController();const listeners=new Set();let state={ver:"读取器加载中…",phase:"未开始",canStart:false,active:false,canSnap:false,error:"",fps:"–",find:"–",read:"–",scale:"–",channel:"未读到",map:"未读到",sent:"0 家店",shopId:"未打开商店",shop:null,rows:[],rejected:[],meter:0,done:false,waiting:"",logs:[],frames:[]};
const update=patch=>{if(disposed)return;state={...state,...patch};for(const fn of listeners)fn();};
// ---------------------------------------------------------------- small helpers
const fmt = (n) => Number(n).toLocaleString('en-US');
const hex = (n) => (n >>> 0).toString(16).padStart(8, '0');
const clock = () => performance.now();
function el(tag, attrs = {}, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') e.className = v; else if (k === 'text') e.textContent = v; else e.setAttribute(k, v);
  }
  e.append(...kids);
  return e;
}
function say(text,kind=''){update({logs:[{time:new Date().toTimeString().slice(0,8),text,kind},...state.logs].slice(0,60)});}
function showError(text){update({error:text||''});}
class Rate {
  constructor(span = 5000) { this.span = span; this.t = []; }
  add(ms) { const now = clock(); this.t.push([now, ms]); while (this.t.length && now - this.t[0][0] > this.span) this.t.shift(); }
  fps() { return this.t.length > 1 ? (this.t.length - 1) / ((this.t[this.t.length - 1][0] - this.t[0][0]) / 1000) : 0; }
  ms() { return this.t.length ? this.t.reduce((a, x) => a + x[1], 0) / this.t.length : 0; }
}

// ---------------------------------------------------------------- the game's picture in the frame
// A shared screen of another shape shows the 16:9 game between black bars. From a small thumbnail:
// the box inside bars (each at least 2% of the frame, nearly all black); a box narrower than 1.65:1
// is drawn 16:9 at its width, wider than 1.85:1 16:9 at its height, so game pixels stay square
// (capture.js gameView, simplified).
function gameView(thumb, w, h) {
  const tw = thumb.width, th = thumb.height, d = thumb.data;
  const dark = (x, y) => { const i = (y * tw + x) * 4; return 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2] < 14; };
  const rowBlack = (y) => { let n = 0; for (let x = 0; x < tw; x++) if (dark(x, y)) n++; return n >= 0.98 * tw; };
  const colBlack = (x, y0, y1) => { let n = 0; for (let y = y0; y < y1; y++) if (dark(x, y)) n++; return n >= 0.98 * (y1 - y0); };
  let y0 = 0, y1 = th, x0 = 0, x1 = tw;
  while (y0 < th && rowBlack(y0)) y0++;
  while (y1 > y0 && rowBlack(y1 - 1)) y1--;
  while (x0 < tw && colBlack(x0, y0, y1)) x0++;
  while (x1 > x0 && colBlack(x1 - 1, y0, y1)) x1--;
  if (y0 < 0.02 * th) y0 = 0; if (th - y1 < 0.02 * th) y1 = th;
  if (x0 < 0.02 * tw) x0 = 0; if (tw - x1 < 0.02 * tw) x1 = tw;
  if (x1 - x0 < tw / 3 || y1 - y0 < th / 3) { x0 = 0; x1 = tw; y0 = 0; y1 = th; }   // mostly black: the whole frame
  const sx = Math.round(x0 * w / tw), sy = Math.round(y0 * h / th);
  const sw = Math.round(x1 * w / tw) - sx, sh = Math.round(y1 * h / th) - sy;
  let ow = sw, oh = sh;
  const a = sw / sh;
  if (a < 1.65) oh = Math.round(sw * 9 / 16); else if (a > 1.85) ow = Math.round(sh * 16 / 9);
  if (ow > MAX_W) { const n = Math.floor(ow / 2560); ow = Math.round(ow / n); oh = Math.round(oh / n); }
  return { sx, sy, sw, sh, w: ow, h: oh };
}

// ---------------------------------------------------------------- frame source
// Chrome: MediaStreamTrackProcessor gives frames also while the page is hidden. Elsewhere a <video>.
function frameSource(stream) {
  const track = stream.getVideoTracks()[0];
  let latest = null, stopped = false, video = null;
  if (typeof MediaStreamTrackProcessor === 'function') {
    const reader = new MediaStreamTrackProcessor({ track }).readable.getReader();
    (async () => {
      while (!stopped) {
        const { value, done } = await reader.read().catch(() => ({ done: true }));
        if (done) break;
        if (latest) latest.close();
        latest = value;
      }
    })();
    return {
      frame: () => latest && { image: latest, w: latest.displayWidth, h: latest.displayHeight },
      stop() { stopped = true; reader.cancel().catch(() => {}); if (latest) latest.close(); latest = null; },
    };
  }
  video = el('video', { playsinline: '', muted: '' });
  video.muted = true;
  video.srcObject = stream;
  video.style.cssText = 'position:fixed;width:1px;height:1px;opacity:0;pointer-events:none;left:-10px;top:-10px';
  document.body.append(video);
  video.play().catch((e) => say('视频播放失败：' + e.message, 'err'));
  return {
    frame: () => video.videoWidth ? { image: video, w: video.videoWidth, h: video.videoHeight } : null,
    stop() { video.pause(); video.srcObject = null; video.remove(); },
  };
}

// ---------------------------------------------------------------- uploads
const uploads = { queue: [], busy: false, sent: 0, timer: null };
async function token() {
  const have = localStorage.getItem(TOKEN_KEY);
  if (have) return have;
  // The collector identity: a token the server issues once and this page keeps (like member.json).
  const r = await fetch('/api/v1/register', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',signal:lifetime.signal });
  if (!r.ok) throw Object.assign(new Error('注册采集身份失败（HTTP ' + r.status + '）'), { status: r.status });
  const j = await r.json();
  if (typeof j.token !== 'string' || j.token.length < 30) throw new Error('服务器没有返回采集令牌');
  localStorage.setItem(TOKEN_KEY, j.token);
  return j.token;
}
function enqueue(snapshot) {
  uploads.queue.push({ body: snapshot.upload, tries: 0, label: shopLabel(snapshot) });
  pump();
}
async function pump() {
  if(disposed)return;
  if (uploads.busy || !uploads.queue.length) return;
  uploads.busy = true;
  const item = uploads.queue[0];
  try {
    const auth = await token();
    const r = await fetch('/api/v1/upload', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + auth },
      body: JSON.stringify(item.body),
      signal:lifetime.signal,
    });
    if (r.status === 401) localStorage.removeItem(TOKEN_KEY);   // issued again on the next try
    if (r.ok) {
      uploads.queue.shift();
      uploads.sent++;
      update({sent:uploads.sent+' 家店'});
      say('已上传 ' + item.label + '（' + item.body.items.length + ' 行）', 'ok');
    } else if (r.status === 401 || r.status === 429 || r.status >= 500) {
      throw Object.assign(new Error('HTTP ' + r.status), { status: r.status });
    } else {
      uploads.queue.shift();   // the server refused this body: sending it again would be refused too
      say('上传被拒绝（HTTP ' + r.status + '）：' + item.label, 'err');
    }
  } catch (e) {
    if(disposed){uploads.busy=false;return;}
    const wait = RETRY_MS[Math.min(item.tries++, RETRY_MS.length - 1)];
    say('上传失败：' + e.message + '，' + Math.round(wait / 1000) + ' 秒后重试', 'err');
    clearTimeout(uploads.timer);
    uploads.timer = setTimeout(pump, wait);
    uploads.busy = false;
    return;
  }
  uploads.busy = false;
  if (uploads.queue.length) pump();
}
function shopLabel(s) {
  const place = s.channel ? '频道 ' + s.channel + (s.room ? ' · ' + s.room + ' 洞' : '') : '位置未知';
  return (s.seller || '摊位 ' + hex(s.shop_id)) + '（' + place + '）';
}

// ---------------------------------------------------------------- live preview
function renderStep(step,ms){const st=step.status,fr=step.frame;const shop=st.shop_id==null?null:{seller:fr.seller||'未读到',count:st.list.length,end:st.end_seen};update({read:Math.round(ms)+' ms',channel:st.channel?String(st.channel):'未读到',map:st.map||'未读到',scale:st.ui_scale?st.ui_scale.toFixed(2)+(fr.window?' · 游戏像素 '+fr.window.game_scale.toFixed(2)+'x':''):state.scale,shopId:shop?'摊位 '+hex(st.shop_id):'未打开商店',shop,waiting:shop?(st.waiting?'等待：'+waitText(st.waiting):'内容已稳定'):'',meter:shop?Math.min(1,st.stable_ms/2000):0,done:shop?!st.waiting:false,rows:fr.rows||[],rejected:(fr.rejected||[]).map(row=>({...row,why:whyText(row.why)}))});}
const WAIT = {
  'a row is covered or not read': '有一行被遮住或没读出',
  'the list fills the window: its end is not seen': '列表填满了窗口，请滚动到底',
  'waiting for the rows to stay the same for 2 s': '内容稳定 2 秒',
  'more than 200 rows': '超过 200 行',
};
const waitText = (w) => WAIT[w] || w;
const WHY = [
  [/covered/, '被鼠标或提示框遮住'], [/not in the catalog/, '物品库里没有这个名字'], [/name not read/, '名字没读出'],
  [/price cut off/, '价格被截断'], [/mesos/, '没找到价格行'], [/digit/, '数字不确定'], [/quantity/, '数量没读出'],
];
const whyText = (w) => { for (const [re, t] of WHY) if (re.test(w)) return t; return w; };

// ---------------------------------------------------------------- the report ring (local only)
const ring = [];
let ringPending = false;
async function keepFrame(canvas, ts) {
  if (ringPending || (ring.length && ts - ring[ring.length - 1].ts < RING_EVERY_MS)) return;
  ringPending = true;
  try {
    const image = await createImageBitmap(canvas);
    ring.push({ ts, wall: Date.now(), image });
    while (ring.length > RING) ring.shift().image.close();
  } finally {
    ringPending = false;
  }
}
async function showRing(){const frames=await Promise.all(ring.map(async frame=>({...frame,image:await createImageBitmap(frame.image)})));if(disposed){frames.forEach(frame=>frame.image.close());return;}state.frames.forEach(frame=>frame.image.close());update({frames});say('已保存最近 '+frames.length+' 帧（只在本机）');}
async function downloadRing(){for(const [i,frame] of state.frames.entries()){const canvas=new OffscreenCanvas(frame.image.width,frame.image.height);canvas.getContext('2d').drawImage(frame.image,0,0);const blob=await canvas.convertToBlob({type:'image/png'});const url=URL.createObjectURL(blob);const anchor=document.createElement('a');anchor.href=url;anchor.download='collect-frame-'+(i+1)+'.png';anchor.click();setTimeout(()=>URL.revokeObjectURL(url),1000);}}
// ---------------------------------------------------------------- the capture loop
let session = null;
function startWorker() {
  return new Promise((resolve, reject) => {
    // Relative to this module, not the page: the page is served at both /collect and /collect/.
    const w = new Worker(new URL('reader-worker.js?v=20261023-channels-v2', import.meta.url), { type: 'module' });
    w.onerror = (e) => {w.terminate();reject(new Error('读取 Worker 启动失败：' + (e.message || '')));};
    w.onmessage = (ev) => {
      const m = ev.data;
      if (m.type === 'ready') { w.onmessage = null; resolve(w); }
      else if (m.type === 'error') {w.terminate();reject(new Error(m.message));}
    };
  });
}

async function start() {
  if(session||!state.canStart||disposed)return;update({canStart:false});
  showError('');
  let stream;
  try {
    stream = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: { ideal: 10, max: 15 } }, audio: false });
  } catch (e) {
    update({canStart:true});showError('没有开始共享：' + e.message);
    return;
  }
  if(disposed){stream.getTracks().forEach(track=>track.stop());return;}
  let worker;
  try { worker = await startWorker(); } catch (e) { stream.getTracks().forEach((t) => t.stop()); update({canStart:true});showError(e.message); return; }
  if(disposed){worker.terminate();stream.getTracks().forEach(track=>track.stop());return;}
  const s = {
    stream, worker, source: frameSource(stream), ticker: new Worker(new URL('ticker-worker.js', import.meta.url)),
    canvas: null, ctx: null, view: null, viewAt: -Infinity, thumb: null,
    busy: false, sentAt: -Infinity, lock: undefined, ticks: new Rate(), finds: new Rate(), wasSeen: true,
  };
  session = s;
  worker.onmessage = (ev) => {
    const m = ev.data;
    s.busy = false;
    if (m.type === 'error') { say(m.message, 'err'); return; }
    if (m.type !== 'step' || !m.step) return;
    renderStep(m.step, m.ms);
    for (const snap of m.step.snapshots) {
      say('商店内容稳定，准备上传：' + shopLabel(snap) + '，' + snap.rows.length + ' 行');
      enqueue(snap);
    }
  };
  stream.getVideoTracks()[0].addEventListener('ended', stop);
  s.ticker.onmessage = () => tick(s);
  s.ticker.postMessage({ every: TICK_MS });
  update({active:true,canSnap:true,canStart:false});
  update({phase:'读取中'});
  say('开始读取：画面只在本机处理');
}

function stop() {
  const s = session;
  if (!s) return;
  session = null;
  s.ticker.terminate();
  s.worker.terminate();
  s.source.stop();
  s.stream.getTracks().forEach((t) => t.stop());
  update({active:false,canStart:true});
  update({phase:'已停止'});
  say('已停止读取');
}

function grab(s) {
  const f = s.source.frame();
  if (!f) return null;
  const now = clock();
  // The picture's box is looked at again every 2 s (black bars appear, the window is resized).
  if (!s.view || now - s.viewAt > 2000 || s.view.src !== f.w + 'x' + f.h) {
    const tw = 192, th = Math.max(8, Math.round(192 * f.h / f.w));
    s.thumb ??= new OffscreenCanvas(tw, th);
    if (s.thumb.width !== tw || s.thumb.height !== th) { s.thumb.width = tw; s.thumb.height = th; }
    const tctx = s.thumb.getContext('2d', { willReadFrequently: true });
    tctx.drawImage(f.image, 0, 0, tw, th);
    s.view = { ...gameView(tctx.getImageData(0, 0, tw, th), f.w, f.h), src: f.w + 'x' + f.h };
    s.viewAt = now;
  }
  const v = s.view;
  if (!s.canvas || s.canvas.width !== v.w || s.canvas.height !== v.h) {
    s.canvas = new OffscreenCanvas(v.w, v.h);
    s.ctx = s.canvas.getContext('2d', { willReadFrequently: true });
  }
  s.ctx.drawImage(f.image, v.sx, v.sy, v.sw, v.sh, 0, 0, v.w, v.h);
  return s.ctx.getImageData(0, 0, v.w, v.h);
}

function tick(s) {
  if (session !== s) return;
  const t0 = clock();
  const img = grab(s);
  if (!img) return;
  let found;
  try { found = findWindow(img.data, img.width, img.height, s.lock); } catch (e) { say('找窗口出错：' + e.message, 'err'); return; }
  const findMs = clock() - t0;
  s.ticks.add(findMs); s.finds.add(findMs);
  const w = found.window;
  if (w && w.rows.length >= 3) s.lock = w.ui_scale;
  update({fps:s.ticks.fps().toFixed(1)});
  update({find:s.finds.ms().toFixed(1)+' ms'});
  update({phase:!found.cues.game_seen?'黑屏':w?'商店已打开':'读取中'});
  const now = clock();
  keepFrame(s.canvas, now).catch(() => {});
  // To the worker: a frame with a shop window (as fast as it reads), the first black frame (a channel
  // change), else one frame a second (the channel menu, the minimap).
  const seen = found.cues.game_seen, edge = seen !== s.wasSeen;
  s.wasSeen = seen;
  if (s.busy || !(w || edge || now - s.sentAt >= IDLE_SEND_MS)) return;
  s.busy = true; s.sentAt = now;
  s.worker.postMessage({ type: 'frame', buffer: img.data.buffer, width: img.width, height: img.height, ts: Date.now() }, [img.data.buffer]);
}

async function uploadVideo(data){try{const response=await fetch('/api/v1/upload/video',{method:'POST',body:data,signal:lifetime.signal});say(response.ok?'录像已上传':'录像上传失败（HTTP '+response.status+'）：服务端还没有这个接口',response.ok?'ok':'err');}catch(error){say('录像上传失败：'+error.message,'err');}}
async function initialize(){try{await init({module_or_path:new URL('./pkg/market_reader_wasm_bg.wasm?v=20261023-channels-v2',import.meta.url)});if(disposed)return;update({ver:'读取器 '+version()});if(!navigator.mediaDevices?.getDisplayMedia)showError('这个浏览器不能共享屏幕。请用电脑上的 Chrome、Edge 或 Firefox。');else update({canStart:true});}catch(error){update({ver:'读取器加载失败'});showError('WASM 读取器加载失败：'+error.message+'。请先运行 server/tools/build_reader_wasm.sh。');}}
void initialize();
return {subscribe(fn){listeners.add(fn);return()=>listeners.delete(fn);},getSnapshot:()=>state,start,stop,showRing,downloadRing,uploadVideo,dispose(){stop();disposed=true;lifetime.abort();clearTimeout(uploads.timer);ring.forEach(frame=>frame.image.close());state.frames.forEach(frame=>frame.image.close());listeners.clear();}};
}

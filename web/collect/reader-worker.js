// The reader's Web Worker: loads the WASM build and runs one reading session.
// In:  {type: "frame", buffer, width, height, ts} (the buffer is transferred and handed back)
//      {type: "reset"}
// Out: {type: "ready", version} | {type: "step", step, ms, buffer} | {type: "error", message}
import init, { Reader, version } from './pkg/market_reader_wasm.js?v=20261023-channels-v2';

let reader = null;

init({ module_or_path: new URL('./pkg/market_reader_wasm_bg.wasm?v=20261023-channels-v2', import.meta.url) })
  .then(() => {
    reader = new Reader();
    postMessage({ type: 'ready', version: version() });
  })
  .catch((e) => postMessage({ type: 'error', message: 'WASM 读取器加载失败：' + String((e && e.message) || e) }));

onmessage = (ev) => {
  const m = ev.data || {};
  if (m.type === 'reset') {
    if (reader) { reader.free(); reader = new Reader(); }
    return;
  }
  if (m.type !== 'frame') return;
  if (!reader) {
    postMessage({ type: 'step', step: null, ms: 0, buffer: m.buffer }, [m.buffer]);
    return;
  }
  const t0 = performance.now();
  try {
    const step = reader.push(new Uint8Array(m.buffer), m.width, m.height, m.ts);
    postMessage({ type: 'step', step, ms: performance.now() - t0, buffer: m.buffer }, [m.buffer]);
  } catch (e) {
    postMessage({ type: 'error', message: '读取出错：' + String((e && e.message) || e), buffer: m.buffer }, [m.buffer]);
  }
};

import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { createCollector } from "/web/collect/engine.js";
import { usePageReady } from "../components/shared";
function Frame({ frame }: { frame: any }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const element = canvas.current;
    if (element) {
      element.width = frame.image.width;
      element.height = frame.image.height;
      element.getContext("2d")?.drawImage(frame.image, 0, 0);
    }
  }, [frame]);
  return (
    <figure>
      <canvas ref={canvas} />
      <figcaption>{new Date(frame.wall).toTimeString().slice(0, 8)}</figcaption>
    </figure>
  );
}
export default function Collect() {
  usePageReady();
  const [collector] = useState(() => createCollector());
  const state = useSyncExternalStore<any>(
    collector.subscribe,
    collector.getSnapshot,
  );
  useEffect(() => () => collector.dispose(), [collector]);
  const rows = [
    ...state.rows.map((row: any) => ({ ...row, rejected: false })),
    ...state.rejected.map((row: any) => ({ ...row, rejected: true })),
  ].sort((a, b) => a.slot - b.slot);
  return (
    <>
      <section className="stall c-hero" aria-labelledby="h-page">
        <div className="c-hero-text">
          <h1 id="h-page">屏幕采集</h1>
          <p>在电脑上共享游戏窗口，逛摊时读到的商店会自动上传到市集。</p>
          <p>
            <a className="btn" href="/web/download.html">
              下载 Windows 采集器与使用说明
            </a>
          </p>
          <p className="c-ver">
            <i />
            <span id="ver">{state.ver}</span>
          </p>
        </div>
        {!navigator.mediaDevices?.getDisplayMedia && (
          <div className="verdict c-device">
            <b>电脑专用</b>
            <strong>这个浏览器不能共享屏幕</strong>
            <small>请在电脑上用 Chrome、Edge 或 Firefox 打开这个页面。</small>
          </div>
        )}
      </section>
      <div className="c-grid">
        <section className="stall c-share" aria-labelledby="h-share">
          <div className="stall-bar">
            <h2 id="h-share">共享游戏窗口</h2>
            <span className="bar-meta" id="state">
              {state.phase}
            </span>
          </div>
          <div className="stall-body c-body">
            <p className="c-note">
              画面只在本机读取，<b>不会上传视频或截图</b>。读到的商店在内容稳定
              2 秒后上传：物品、价格、每组数量、频道和洞号。
            </p>
            <div className="c-actions">
              <button
                className="btn primary"
                id="start"
                type="button"
                disabled={!state.canStart}
                hidden={state.active}
                onClick={() => void collector.start()}
              >
                共享游戏窗口
              </button>
              <button
                className="btn"
                id="stop"
                type="button"
                hidden={!state.active}
                onClick={() => collector.stop()}
              >
                停止
              </button>
            </div>
            <dl className="c-stats" aria-live="polite">
              {[
                ["fps", "帧率"],
                ["find", "找窗口"],
                ["read", "读一帧"],
                ["scale", "缩放"],
                ["channel", "频道"],
                ["map", "地图"],
                ["sent", "已上传"],
              ].map(([key, label]) => (
                <div
                  className={
                    "c-stat " +
                    ((key === "channel" || key === "map") &&
                    state[key] === "未读到"
                      ? "warn"
                      : "")
                  }
                  key={key}
                >
                  <dt>{label}</dt>
                  <dd id={"c-" + key}>{state[key]}</dd>
                </div>
              ))}
            </dl>
            <p className="c-note" id="hint">
              打开游戏里的“切换频道”菜单一次以读取频道；小地图展开或收起成一行都可以读地图。
            </p>
            <div
              className="c-error"
              id="error"
              role="alert"
              hidden={!state.error}
            >
              {state.error}
            </div>
          </div>
        </section>
        <section className="stall c-shop" aria-labelledby="h-shop">
          <div className="stall-bar">
            <h2 id="h-shop">当前商店</h2>
            <span className="bar-meta" id="shop-id">
              {state.shopId}
            </span>
          </div>
          <div className="stall-body">
            <div className="c-body">
              <div className="c-shophead" id="shop-head">
                {state.shop && (
                  <>
                    <span>
                      摊主 <strong>{state.shop.seller}</strong>
                    </span>
                    <span>
                      已读 <strong>{state.shop.count} 行</strong>
                    </span>
                    <span>
                      列表末尾{" "}
                      <strong>{state.shop.end ? "已看到" : "未看到"}</strong>
                    </span>
                  </>
                )}
              </div>
              <div
                className={"c-meter " + (state.done ? "done" : "")}
                id="meter"
                title="内容稳定 2 秒后上传"
              >
                <i style={{ width: Math.round(state.meter * 100) + "%" }} />
              </div>
              <p className="c-note" id="waiting">
                {state.waiting}
              </p>
            </div>
            <div className="c-tablewrap">
              <table className="c-table" aria-label="读到的行">
                <thead>
                  <tr>
                    <th>格</th>
                    <th>物品</th>
                    <th className="num">价格</th>
                    <th className="num">每组</th>
                    <th>状态</th>
                    <th className="num">置信度</th>
                  </tr>
                </thead>
                <tbody id="rows">
                  {rows.length ? (
                    rows.map((row: any, i: number) => (
                      <tr className={row.rejected ? "rej" : ""} key={i}>
                        <td>{row.slot}</td>
                        {row.rejected ? (
                          <>
                            <td colSpan={4}>
                              {(row.name_read ? row.name_read + "：" : "") +
                                row.why}
                            </td>
                            <td className="num">–</td>
                          </>
                        ) : (
                          <>
                            <td>{row.name}</td>
                            <td className="num">
                              {Number(row.price).toLocaleString("en-US")}
                            </td>
                            <td className="num">
                              {Number(row.bundle).toLocaleString("en-US")}
                            </td>
                            <td className="tags">
                              <span
                                className={
                                  "tag " + (row.sold ? "sold" : "exact")
                                }
                              >
                                {row.sold ? "已售" : "在售"}
                              </span>{" "}
                              <span className="tag">
                                {row.exact ? "精确" : "模板"}
                              </span>
                            </td>
                            <td className="num">
                              {Number(row.confidence).toFixed(2)}
                            </td>
                          </>
                        )}
                      </tr>
                    ))
                  ) : (
                    <tr>
                      <td colSpan={6} className="empty">
                        {state.shop
                          ? "这一帧没有读到行"
                          : "打开一家商店，读到的行会显示在这里"}
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </section>
        <section className="stall c-logs" aria-labelledby="h-log">
          <div className="stall-bar">
            <h2 id="h-log">记录</h2>
          </div>
          <div className="stall-body">
            <ul className="c-log" id="log" aria-live="polite">
              {state.logs.map((row: any, i: number) => (
                <li key={i}>
                  <time>{row.time}</time>
                  <span className={row.kind}>{row.text}</span>
                </li>
              ))}
            </ul>
          </div>
        </section>
        <section className="stall c-report" aria-labelledby="h-report">
          <div className="stall-bar">
            <h2 id="h-report">报告问题</h2>
            <span className="bar-meta">最近 6 帧，只存在本机</span>
          </div>
          <div className="stall-body c-body">
            <p className="c-note">
              读错或读不出时，点“保存最近 6
              帧”。截图只保存在这个页面里，可以下载后自己发给站长；不会自动上传。
            </p>
            <div className="c-actions">
              <button
                className="btn"
                id="snap"
                type="button"
                disabled={!state.canSnap}
                onClick={() => void collector.showRing()}
              >
                保存最近 6 帧
              </button>
              <button
                className="btn"
                id="download"
                type="button"
                hidden={!state.frames.length}
                onClick={() => void collector.downloadRing()}
              >
                下载为 PNG
              </button>
            </div>
            <div className="c-frames" id="frames">
              {state.frames.map((frame: any, i: number) => (
                <Frame key={i} frame={frame} />
              ))}
            </div>
          </div>
        </section>
      </div>
    </>
  );
}
